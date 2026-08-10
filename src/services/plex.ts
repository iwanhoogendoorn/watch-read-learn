/**
 * Plex Media Server client — the authority on what is actually on disk.
 *
 * Straight out of `docs/research/report-plex.md`, live-verified against PMS
 * 1.43.2.10687. The five findings that shape this file:
 *
 *   1. **You cannot query Plex by TMDB id.** `?guid=tmdb://…` returns 0 on
 *      modern agents — the external `Guid` children simply are not indexed for
 *      filtering. The only reliable path is a local `includeGuids=1` index
 *      (§5), built by `services/availability.ts` on top of `sectionItems`.
 *   2. **`MediaContainer.size` is not a result count.** It counts every child
 *      element — `Provider` rows, the synthetic "All episodes" `Directory`, and
 *      all 17 hubs of a one-hit search. Always `Metadata.length`.
 *   3. **`totalSize` only appears when you paginate**, so the page loop drives
 *      off both `totalSize` and a short page.
 *   4. **`allowedNetworks` makes a bare 200 meaningless.** On LAN every request
 *      succeeds with no token, with a garbage token, with any token. A "test
 *      connection" that reports success off a 200 is lying — see
 *      `testConnection`, which proves the token by finding an endpoint that
 *      rejects an *unauthenticated* call.
 *   5. **Home-video libraries are `type: "movie"` with agent
 *      `tv.plex.agents.none`** and have no GUIDs at all. Filter on the agent, or
 *      you will try to TMDB-match someone's holiday footage.
 */
import {
  type PlexClient,
  type PlexConnectionInfo,
  type PlexEpisodeRef,
  type PlexIdentity,
  type PlexIndexEntry,
  type PlexSection,
} from "../types";
import { ApiError, defaultHttp, isApiError, joinUrl, queryString, type HttpFn } from "./http";
import { isRaw, num, optNum, rawArray, str, type Raw } from "./normalize";
import { RATE_LIMIT_MS } from "../constants";
import { createRateLimiter, type RateLimiter } from "./ratelimit";

export interface PlexConfig {
  url: string;
  token: string;
  /** From `/identity`; empty until `testConnection` has run once. */
  machineId: string;
}

export interface PlexDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
}

/** Items per page when walking a library section. */
export const PLEX_PAGE_SIZE = 200;

/** Safety stop for the page loop, in case a server lies about `totalSize`. */
const PLEX_MAX_ITEMS = 100_000;

/** Numeric `type=` values, live-confirmed (report §4). */
export const PLEX_TYPE = { movie: 1, show: 2, season: 3, episode: 4 } as const;

/**
 * A `PlexIndexEntry` plus the external ids it was indexed under.
 *
 * `PlexIndexEntry` is frozen in `types.ts` and has no room for GUIDs, but the
 * index builder needs them, so the client returns this richer subtype. It is
 * assignable to `PlexIndexEntry`, so `PlexClient` is satisfied unchanged.
 */
export interface PlexIndexedItem extends PlexIndexEntry {
  /** Exactly as Plex reports them: `tmdb://1064213`, `imdb://tt28607951`. */
  guids: string[];
}

/** `PlexClient` with the GUID-carrying return types the index builder needs. */
export interface PlexClientEx extends PlexClient {
  sectionItems(section: PlexSection): Promise<PlexIndexedItem[]>;
  metadata(ratingKey: string): Promise<PlexIndexedItem | undefined>;
  search(query: string, limit?: number): Promise<PlexIndexedItem[]>;
  /** Sections worth indexing: real movie/show libraries on a modern agent. */
  indexableSections(): Promise<PlexSection[]>;
}

/**
 * Only modern-agent movie and show libraries carry `Guid` children, and
 * `.none` is the home-video agent — it never matches anything upstream.
 */
export function isIndexableSection(section: PlexSection): boolean {
  if (section.type !== "movie" && section.type !== "show") return false;
  if (!section.agent.startsWith("tv.plex.agents.")) return false;
  return section.agent !== "tv.plex.agents.none";
}

/** `tmdb://1064213` → `1064213`. Returns `undefined` for any other scheme. */
export function guidValue(guid: string, scheme: "tmdb" | "imdb" | "tvdb"): string | undefined {
  const prefix = `${scheme}://`;
  return guid.startsWith(prefix) ? guid.slice(prefix.length) : undefined;
}

function guidsOf(raw: Raw): string[] {
  return rawArray(raw["Guid"])
    .map((g) => str(g, "id"))
    .filter((id) => id !== "");
}

function toIndexedItem(raw: Raw, fallbackSection: string): PlexIndexedItem | undefined {
  const ratingKey = str(raw, "ratingKey");
  const type = str(raw, "type");
  if (ratingKey === "" || (type !== "movie" && type !== "show")) return undefined;

  const item: PlexIndexedItem = {
    ratingKey,
    librarySectionID: String(raw["librarySectionID"] ?? fallbackSection),
    type,
    title: str(raw, "title"),
    guids: guidsOf(raw),
  };
  const year = optNum(raw, "year");
  if (year !== undefined) item.year = year;
  const leafCount = optNum(raw, "leafCount");
  if (leafCount !== undefined) item.leafCount = leafCount;
  return item;
}

export function createPlexClient(getConfig: () => PlexConfig, deps: PlexDeps = {}): PlexClientEx {
  const http = deps.http ?? defaultHttp;
  const limiter = deps.limiter ?? createRateLimiter(RATE_LIMIT_MS.plex);

  function configured(): boolean {
    // The token is deliberately not required: on a LAN covered by
    // `allowedNetworks` the server answers without one, and refusing to work
    // there would be wrong. `testConnection` reports the ambiguity instead.
    return getConfig().url.trim() !== "";
  }

  function serverUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    return joinUrl(getConfig().url.trim(), path) + queryString(params);
  }

  function requireConfigured(): void {
    if (!configured()) {
      throw new ApiError({ source: "plex", reason: "no-key", detail: "plexUrl is empty" });
    }
  }

  /** Header auth — the `?X-Plex-Token=` form leaks the token into server logs. */
  function headers(withToken = true): Record<string, string> {
    const token = getConfig().token.trim();
    return withToken && token !== "" ? { "X-Plex-Token": token } : {};
  }

  /**
   * Every Plex response is wrapped in a `MediaContainer`. A 404 answers with
   * HTML instead, which `httpRequest` has already turned into a parse/not-found
   * `ApiError` before we get here.
   */
  async function container(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { withToken?: boolean; allowStatuses?: number[] } = {},
  ): Promise<{ status: number; container: Raw }> {
    requireConfigured();
    const url = serverUrl(path, params);
    const response = await limiter.run(() =>
      http({
        url,
        source: "plex",
        headers: headers(options.withToken ?? true),
        ...(options.allowStatuses ? { allowStatuses: options.allowStatuses } : {}),
      }),
    );
    if (response.status === 404 || !isRaw(response.json)) {
      return { status: response.status, container: {} };
    }
    const inner = response.json["MediaContainer"];
    return { status: response.status, container: isRaw(inner) ? inner : {} };
  }

  async function identity(): Promise<PlexIdentity> {
    // The one endpoint that needs no token on any server (report §2).
    const { container: mc } = await container("/identity", {}, { withToken: false });
    const machineIdentifier = str(mc, "machineIdentifier");
    if (machineIdentifier === "") {
      throw new ApiError({
        source: "plex",
        reason: "parse",
        url: serverUrl("/identity"),
        detail: "no machineIdentifier in /identity",
      });
    }
    return {
      machineIdentifier,
      version: str(mc, "version"),
      claimed: mc["claimed"] === true || mc["claimed"] === 1,
    };
  }

  async function sections(): Promise<PlexSection[]> {
    const { container: mc } = await container("/library/sections");
    return rawArray(mc["Directory"])
      .map((dir): PlexSection | undefined => {
        // `key` is a string even in JSON — "1", not 1.
        const key = String(dir["key"] ?? "");
        const type = str(dir, "type");
        if (key === "" || (type !== "movie" && type !== "show" && type !== "artist" && type !== "photo")) {
          return undefined;
        }
        const section: PlexSection = { key, type, title: str(dir, "title"), agent: str(dir, "agent") };
        const scannedAt = optNum(dir, "scannedAt");
        if (scannedAt !== undefined) section.scannedAt = scannedAt;
        const updatedAt = optNum(dir, "updatedAt");
        if (updatedAt !== undefined) section.updatedAt = updatedAt;
        return section;
      })
      .filter((s): s is PlexSection => s !== undefined);
  }

  return {
    configured,
    identity,
    sections,

    async indexableSections(): Promise<PlexSection[]> {
      return (await sections()).filter(isIndexableSection);
    },

    /**
     * Connection test that survives `allowedNetworks`.
     *
     * `/identity` proves the server is there. Proving the *token* needs an
     * endpoint that would reject an unauthenticated caller — so we hit `/:/prefs`
     * twice, once bare and once with the token. If the bare call already
     * succeeds the server is letting this network in without auth and the token
     * is simply unprovable from here; say so rather than claiming success.
     */
    async testConnection(): Promise<PlexConnectionInfo> {
      if (!configured()) {
        return { ok: false, tokenUnverified: true, message: "Add the Plex server URL first." };
      }

      let ident: PlexIdentity;
      try {
        ident = await identity();
      } catch (err) {
        return {
          ok: false,
          tokenUnverified: true,
          message: isApiError(err)
            ? `Could not reach Plex: ${err.message}`
            : "Could not reach Plex.",
        };
      }

      const base: { machineId: string; version: string } = {
        machineId: ident.machineIdentifier,
        version: ident.version,
      };

      let anonymousOk = false;
      try {
        const bare = await container("/:/prefs", {}, { withToken: false, allowStatuses: [401, 403] });
        anonymousOk = bare.status >= 200 && bare.status < 300;
      } catch {
        anonymousOk = false;
      }

      let prefs: Raw;
      try {
        const authed = await container("/:/prefs", {}, { allowStatuses: [401, 403] });
        if (authed.status === 401 || authed.status === 403) {
          return {
            ok: false,
            ...base,
            tokenUnverified: false,
            message: "Plex rejected the token. Copy it again from a Plex web URL (`X-Plex-Token`).",
          };
        }
        prefs = authed.container;
      } catch (err) {
        return {
          ok: false,
          ...base,
          tokenUnverified: true,
          message: isApiError(err) ? `Plex error: ${err.message}` : "Plex error.",
        };
      }

      const allowedNetworks = rawArray(prefs["Setting"]).find((s) => str(s, "id") === "allowedNetworks");
      const allowed = allowedNetworks ? str(allowedNetworks, "value") : "";

      if (anonymousOk) {
        return {
          ok: true,
          ...base,
          tokenUnverified: true,
          message: `Connected to Plex ${ident.version}. This server answers without a token${
            allowed ? ` (allowedNetworks: ${allowed})` : ""
          }, so the token could not be verified.`,
        };
      }

      return {
        ok: true,
        ...base,
        tokenUnverified: false,
        message: `Connected to Plex ${ident.version} — token verified.`,
      };
    },

    /**
     * Every movie/show in a section, with external ids.
     *
     * `includeGuids=1` is mandatory on listings (it is a no-op on
     * `/library/metadata/{rk}`, which includes them anyway), and the exact form
     * is `1` — `includeGuids=true` is not the documented spelling.
     */
    async sectionItems(section: PlexSection): Promise<PlexIndexedItem[]> {
      const items: PlexIndexedItem[] = [];
      let start = 0;

      for (;;) {
        const { container: mc } = await container(`/library/sections/${section.key}/all`, {
          includeGuids: 1,
          type: section.type === "show" ? PLEX_TYPE.show : PLEX_TYPE.movie,
          "X-Plex-Container-Start": start,
          "X-Plex-Container-Size": PLEX_PAGE_SIZE,
        });

        const page = rawArray(mc["Metadata"]);
        for (const raw of page) {
          const item = toIndexedItem(raw, section.key);
          if (item) items.push(item);
        }

        // A short page always ends the walk; `totalSize` is only present
        // *because* we paginated, so it is a check, not the primary condition.
        if (page.length < PLEX_PAGE_SIZE) break;
        start += PLEX_PAGE_SIZE;
        const totalSize = optNum(mc, "totalSize");
        if (totalSize !== undefined && start >= totalSize) break;
        if (start >= PLEX_MAX_ITEMS) break;
      }

      return items;
    },

    async metadata(ratingKey: string): Promise<PlexIndexedItem | undefined> {
      const { status, container: mc } = await container(
        `/library/metadata/${encodeURIComponent(ratingKey)}`,
        {},
        { allowStatuses: [404] },
      );
      if (status === 404) return undefined;
      const first = rawArray(mc["Metadata"])[0];
      if (!first) return undefined;
      return toIndexedItem(first, str(first, "librarySectionID"));
    },

    /**
     * Every episode of a show in one call.
     *
     * `parentIndex` is the season number **only on episodes** — on a season it
     * is the show's own index, which is always 1. That trap is why this maps
     * `{s: parentIndex, e: index}` from `allLeaves` and never from `/children`.
     */
    async allLeaves(showRatingKey: string): Promise<PlexEpisodeRef[]> {
      const { status, container: mc } = await container(
        `/library/metadata/${encodeURIComponent(showRatingKey)}/allLeaves`,
        {},
        { allowStatuses: [404] },
      );
      if (status === 404) return [];

      const out: PlexEpisodeRef[] = [];
      for (const raw of rawArray(mc["Metadata"])) {
        if (str(raw, "type") !== "episode") continue;
        const s = optNum(raw, "parentIndex");
        const e = optNum(raw, "index");
        if (s === undefined || e === undefined) continue;
        out.push({ s, e, ratingKey: str(raw, "ratingKey") });
      }
      return out;
    },

    /**
     * Fuzzy fallback. `?title=` is word-prefix only — `nora` finds nothing while
     * `/hubs/search` finds Anora.
     *
     * `limit` is **per hub**, `size` counts empty hubs, and `sectionId=` does
     * not actually restrict anything, so the filtering happens here.
     */
    async search(query: string, limit = 5): Promise<PlexIndexedItem[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const { container: mc } = await container("/hubs/search", {
        query: trimmed,
        limit,
        includeGuids: 1,
      });

      const out: PlexIndexedItem[] = [];
      for (const hub of rawArray(mc["Hub"])) {
        const type = str(hub, "type");
        if (type !== "movie" && type !== "show") continue;
        for (const raw of rawArray(hub["Metadata"])) {
          const item = toIndexedItem(raw, str(raw, "librarySectionID"));
          if (item) out.push(item);
        }
      }
      return out;
    },

    /**
     * `{plexUrl}/web/index.html#!/server/{machineId}/details?key=…`
     *
     * The `key` is percent-encoded, which is the form Plex Web's router parses
     * and the form Overseerr's own `plexUrl` uses. Empty when we have no
     * `machineIdentifier` yet — the caller hides the action rather than
     * offering a dead link.
     */
    deepLink(ratingKey: string): string {
      const { url, machineId } = getConfig();
      if (url.trim() === "" || machineId.trim() === "" || ratingKey === "") return "";
      const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
      return `${url.trim().replace(/\/+$/, "")}/web/index.html#!/server/${machineId.trim()}/details?key=${key}`;
    },
  };
}
