/**
 * IGDB v4 — the games catalogue (SPEC2-PARITY.md §D-GAMES).
 *
 * Four facts from `docs/research/report-media-apis.md` §3.1 shape every line of
 * this file, and getting any of them wrong is the difference between a client
 * that works and one that 401s forever:
 *
 *   1. **Auth is Twitch's**, not IGDB's: a client-credentials POST to
 *      `id.twitch.tv/oauth2/token` mints a token that lasts ~60 days. It is
 *      cached (and persisted, if the host gives us somewhere to put it) and
 *      re-minted on expiry or on a 401 — never once per call.
 *   2. **The query lives in the POST body**, in Apicalypse, semicolon-terminated.
 *      Not the URL. Not JSON.
 *   3. **Header capitalisation matters** — `Client-ID`, and `Bearer ` hard-coded
 *      in front of the token, exactly as the docs spell it.
 *   4. **IGDB refuses browser requests (CORS)**, which is why everything goes
 *      through Obsidian's `requestUrl` via `services/http.ts` and never `fetch`.
 *
 * Rate limits are 4 requests/second with at most 8 in flight; the shared
 * minimum-gap limiter covers both, since it serialises us to one at a time.
 *
 * RAWG is deliberately absent — chronically down, minimally maintained
 * (report §3.2). A v3 `rawgApiKey` keeps round-tripping in `data.json`; nothing
 * calls it.
 */
import { requestUrl } from "obsidian";
import { HTTP_TIMEOUT_MS } from "../constants";
import { ApiError, isApiError, type HttpFn } from "./http";
import { createRateLimiter, type RateLimiter } from "./ratelimit";
import type { ApiErrorReason, ApiSource, GameSearchResult, IgdbClient } from "../types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GameApiSource = "igdb" | "steam";

/**
 * A games-provider failure, in the same taxonomy as `ApiError`.
 *
 * Why not `ApiError` itself: `ApiSource` is part of the frozen contract in
 * `types.ts` and names the three video providers only, and `describeApiError`
 * switches over exactly those. Rather than reach into a frozen file from a
 * parity lane, the two game clients carry their own error type with their own
 * sentences — the taxonomy (`ApiErrorReason`) is still the shared one, so the
 * UI treats a rate-limited IGDB exactly as it treats a rate-limited TMDB.
 */
export class GameApiError extends Error {
  readonly source: GameApiSource;
  readonly reason: ApiErrorReason;
  readonly status?: number;
  readonly detail?: string;

  constructor(init: {
    source: GameApiSource;
    reason: ApiErrorReason;
    status?: number;
    detail?: string;
    message?: string;
  }) {
    super(init.message || init.detail || `${init.source}: ${init.reason}`);
    this.name = "GameApiError";
    this.source = init.source;
    this.reason = init.reason;
    if (init.status !== undefined) this.status = init.status;
    if (init.detail !== undefined) this.detail = init.detail;
  }
}

export function isGameApiError(err: unknown): err is GameApiError {
  return err instanceof GameApiError;
}

/** Human sentences. One place, so every games surface says the same thing. */
export function describeGameApiError(err: GameApiError): string {
  const provider = err.source === "igdb" ? "IGDB" : "Steam";
  switch (err.reason) {
    case "no-key":
      return err.source === "igdb"
        ? "IGDB is not configured yet — add the Twitch client ID and secret in Settings → Games."
        : "Steam is not configured yet — add the Web API key and your 64-bit Steam ID in Settings → Games.";
    case "auth":
      return err.source === "igdb"
        ? "Twitch rejected the IGDB credentials. Check the client ID and secret in Settings → Games."
        : "Steam rejected the key, or the profile's game details are private.";
    case "rate-limited":
      return `${provider} is rate-limiting us (4 requests a second). Try again in a moment.`;
    case "not-found":
      return `${provider} has no record of that game.`;
    case "server":
      return `${provider} returned a server error${err.status ? ` (${err.status})` : ""}.`;
    case "parse":
      return `${provider} sent a response the plugin could not read.`;
    case "timeout":
      return `${provider} did not answer in time.`;
    case "network":
      return `Could not reach ${provider}. Check that this machine is online.`;
    case "not-enabled":
      return `${provider} is reachable but this feature is not enabled.`;
    case "http":
    default:
      return `${provider} request failed${err.status ? ` (${err.status})` : ""}.`;
  }
}

/**
 * The one place a games source is squeezed into the frozen `ApiSource` union.
 *
 * The transport in `services/http.ts` is worth reusing wholesale — the timeout
 * race, `throw: false`, and the "never touch `.json` before `.status`" rule are
 * exactly the things a second copy would get subtly wrong. Its options type
 * carries an `ApiSource`, so the value is widened here and **every** error it
 * produces is re-wrapped as a `GameApiError` before it leaves this module. No
 * consumer ever receives a source it cannot describe.
 */
function asApiSource(source: GameApiSource): ApiSource {
  return source as unknown as ApiSource;
}

/** `ApiError` (or anything else) → the games error type, with the right source. */
export function toGameApiError(err: unknown, source: GameApiSource): GameApiError {
  if (isGameApiError(err)) return err;
  if (isApiError(err)) {
    return new GameApiError({
      source,
      reason: err.reason,
      ...(err.status !== undefined ? { status: err.status } : {}),
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
      ...(err.providerMessage !== undefined ? { message: err.providerMessage } : {}),
    });
  }
  return new GameApiError({
    source,
    reason: "network",
    detail: err instanceof Error ? err.message : String(err),
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IGDB_BASE = "https://api.igdb.com/v4";
export const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const IGDB_IMAGE_BASE = "https://images.igdb.com/igdb/image/upload";

/** 4 req/s, so 250 ms from the start of one request to the start of the next. */
export const IGDB_MIN_GAP_MS = 250;

/** Re-mint this long before the token actually expires. */
export const TOKEN_SAFETY_MARGIN_MS = 60_000;

/** One retry after a 429, then the caller is told. */
export const RATE_LIMIT_RETRY_MS = 1100;

/**
 * The fields every lookup asks for.
 *
 * `cover.image_id` rather than `cover.url`: the id is what composes a
 * `t_cover_big` URL, and the raw `url` comes back protocol-relative and at
 * thumbnail size.
 */
const GAME_FIELDS = [
  "id",
  "name",
  "summary",
  "first_release_date",
  "total_rating",
  "cover.image_id",
  "platforms.name",
  "genres.name",
  "involved_companies.developer",
  "involved_companies.publisher",
  "involved_companies.company.name",
].join(",");

/** A cover id → the CDN URL. `t_cover_big` is 264×374, the poster grid's size. */
export function igdbCoverUrl(imageId: string, size = "t_cover_big"): string {
  const id = imageId.trim();
  return id === "" ? "" : `${IGDB_IMAGE_BASE}/${size}/${id}.jpg`;
}

/**
 * Escape a user's search string for an Apicalypse `search "…";` clause.
 *
 * Quotes and backslashes would otherwise end the clause early — a game called
 * `"Sam & Max" Hit the Road` must not become a syntax error.
 */
export function escapeApicalypse(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Raw payloads
// ---------------------------------------------------------------------------

interface IgdbCompany {
  developer?: boolean;
  publisher?: boolean;
  company?: { name?: string };
}

interface IgdbGame {
  id: number;
  name?: string;
  summary?: string;
  first_release_date?: number;
  total_rating?: number;
  cover?: { image_id?: string };
  platforms?: { name?: string }[];
  genres?: { name?: string }[];
  involved_companies?: IgdbCompany[];
}

interface TwitchToken {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

function names(list: { name?: string }[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const name = entry?.name?.trim();
    if (name) out.push(name);
  }
  return out;
}

function companyName(companies: IgdbCompany[] | undefined, role: "developer" | "publisher"): string {
  if (!Array.isArray(companies)) return "";
  for (const entry of companies) {
    if (entry?.[role] !== true) continue;
    const name = entry.company?.name?.trim();
    if (name) return name;
  }
  return "";
}

/**
 * One IGDB row → the frozen `GameSearchResult`.
 *
 * Exported because it is the part worth testing: everything below it is
 * transport, and everything above it is UI.
 */
export function mapIgdbGame(raw: IgdbGame): GameSearchResult {
  const developer = companyName(raw.involved_companies, "developer");
  const publisher = companyName(raw.involved_companies, "publisher");
  return {
    id: String(raw.id),
    source: "igdb",
    title: raw.name?.trim() ?? "",
    summary: raw.summary?.trim() ?? "",
    ...(typeof raw.first_release_date === "number" && Number.isFinite(raw.first_release_date)
      ? { firstReleaseDate: raw.first_release_date }
      : {}),
    coverUrl: igdbCoverUrl(raw.cover?.image_id ?? ""),
    platforms: names(raw.platforms),
    genres: names(raw.genres),
    ...(developer ? { developer } : {}),
    ...(publisher ? { publisher } : {}),
    ...(typeof raw.total_rating === "number" && raw.total_rating > 0
      ? { rating: Math.round(raw.total_rating) / 10 }
      : {}),
  };
}

/** IGDB dates are Unix **seconds**, UTC. `YYYY-MM-DD` is what a `Game` stores. */
export function unixSecondsToDate(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface IgdbCredentials {
  clientId: string;
  clientSecret: string;
}

/** A minted token and when it stops being usable (epoch ms, margin applied). */
export interface IgdbTokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface IgdbClientOptions {
  /**
   * Read live rather than captured, so a key typed into Settings takes effect
   * on the next search instead of on the next reload.
   */
  credentials: () => IgdbCredentials;
  http?: HttpFn;
  limiter?: RateLimiter;
  now?: () => number;
  /**
   * Where the ~60-day token is kept between sessions. Without these the token
   * still works, it is just re-minted once per Obsidian start.
   */
  readToken?: () => IgdbTokenCache | undefined;
  writeToken?: (token: IgdbTokenCache | null) => void;
  /** Injected by tests so a 429 retry does not cost a real second. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `requestUrl`-backed transport for the two game providers.
 *
 * It exists as the default value of `options.http` only; tests hand in a fixture
 * router instead and never reach it. Shared with `services/steam.ts` — the lane
 * owns exactly these two service files, and one transport beats two.
 */
export const defaultGameHttp: HttpFn = async <T,>(options: Parameters<HttpFn>[0]) => {
  const response = await requestUrl({
    url: options.url,
    method: options.method ?? "GET",
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    throw: false,
  });
  const status = response.status;
  const text = typeof response.text === "string" ? response.text : "";
  let json: T | undefined;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = undefined;
    }
  }
  const allowed = options.allowStatuses ?? [];
  if (!((status >= 200 && status < 300) || allowed.includes(status))) {
    throw new ApiError({
      source: options.source,
      reason:
        status === 401 || status === 403
          ? "auth"
          : status === 404
            ? "not-found"
            : status === 429
              ? "rate-limited"
              : status >= 500
                ? "server"
                : "http",
      status,
      url: options.url,
      detail: text.slice(0, 300),
    });
  }
  return { status, headers: response.headers ?? {}, text, json };
};

export function createIgdbClient(options: IgdbClientOptions): IgdbClient {
  const http = options.http ?? defaultGameHttp;
  const limiter = options.limiter ?? createRateLimiter(IGDB_MIN_GAP_MS);
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  /** In-memory mirror of the persisted cache, so the common path touches no host. */
  let token: IgdbTokenCache | null = options.readToken?.() ?? null;

  function credentials(): IgdbCredentials {
    const raw = options.credentials();
    return { clientId: raw.clientId.trim(), clientSecret: raw.clientSecret.trim() };
  }

  function configured(): boolean {
    const { clientId, clientSecret } = credentials();
    return clientId !== "" && clientSecret !== "";
  }

  function storeToken(next: IgdbTokenCache | null): void {
    token = next;
    options.writeToken?.(next);
  }

  /** A cached token that is still comfortably valid, or `null`. */
  function cachedToken(): string | null {
    const cached = token ?? options.readToken?.() ?? null;
    if (!cached || !cached.accessToken) return null;
    if (!(cached.expiresAt > now())) return null;
    token = cached;
    return cached.accessToken;
  }

  /**
   * Mint a token. Twitch takes its parameters in the **query string**, not a
   * form body, and answers with `expires_in` in seconds.
   */
  async function mintToken(): Promise<string> {
    const { clientId, clientSecret } = credentials();
    if (clientId === "" || clientSecret === "") {
      throw new GameApiError({ source: "igdb", reason: "no-key" });
    }
    const url =
      `${TWITCH_TOKEN_URL}?client_id=${encodeURIComponent(clientId)}` +
      `&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;

    let payload: TwitchToken | undefined;
    try {
      const response = await limiter.run(() =>
        http<TwitchToken>({
          url,
          method: "POST",
          source: asApiSource("igdb"),
          timeoutMs: HTTP_TIMEOUT_MS,
        }),
      );
      payload = response.json;
    } catch (err) {
      throw toGameApiError(err, "igdb");
    }

    const accessToken = payload?.access_token?.trim() ?? "";
    if (accessToken === "") {
      throw new GameApiError({
        source: "igdb",
        reason: "auth",
        detail: "Twitch returned no access_token",
      });
    }
    const lifetimeMs = Math.max(0, (payload?.expires_in ?? 0) * 1000 - TOKEN_SAFETY_MARGIN_MS);
    storeToken({ accessToken, expiresAt: now() + lifetimeMs });
    return accessToken;
  }

  async function accessToken(): Promise<string> {
    return cachedToken() ?? (await mintToken());
  }

  /**
   * One Apicalypse POST, with the two retries that matter.
   *
   * A 401 means the cached token died early (revoked credentials, a clock skew,
   * a token minted by another machine) — it is dropped and minted once more. A
   * 429 means we out-ran 4 req/s despite the limiter, and one polite pause is
   * worth more to the user than an error message.
   */
  async function query<T>(endpoint: string, body: string): Promise<T[]> {
    if (!configured()) throw new GameApiError({ source: "igdb", reason: "no-key" });

    const send = async (bearer: string): Promise<T[]> => {
      const response = await limiter.run(() =>
        http<T[]>({
          url: `${IGDB_BASE}/${endpoint}`,
          method: "POST",
          source: asApiSource("igdb"),
          headers: {
            // Capitalisation is load-bearing, and "Bearer " is hard-coded in
            // front of the token — both straight from the IGDB docs.
            "Client-ID": credentials().clientId,
            Authorization: `Bearer ${bearer}`,
            Accept: "application/json",
          },
          body,
          contentType: "text/plain",
        }),
      );
      const json = response.json;
      return Array.isArray(json) ? json : [];
    };

    let attemptedRefresh = false;
    let attemptedBackoff = false;
    for (;;) {
      try {
        return await send(await accessToken());
      } catch (raw) {
        const err = toGameApiError(raw, "igdb");
        if (err.reason === "auth" && !attemptedRefresh) {
          attemptedRefresh = true;
          storeToken(null);
          continue;
        }
        if (err.reason === "rate-limited" && !attemptedBackoff) {
          attemptedBackoff = true;
          await sleep(RATE_LIMIT_RETRY_MS);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    configured,

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      if (!configured()) {
        return { ok: false, message: "Add a Twitch client ID and secret first." };
      }
      try {
        await query<IgdbGame>("games", "fields id; limit 1;");
        return { ok: true, message: "IGDB answered. Search is live." };
      } catch (err) {
        return { ok: false, message: describeGameApiError(toGameApiError(err, "igdb")) };
      }
    },

    async search(term: string, limit = 10): Promise<GameSearchResult[]> {
      const needle = escapeApicalypse(term);
      if (needle === "") return [];
      // `version_parent = null` drops the Deluxe/GOTY re-releases that otherwise
      // fill the first page with the same game five times (report §3.1).
      const body =
        `search "${needle}"; fields ${GAME_FIELDS}; ` +
        `where version_parent = null; limit ${Math.max(1, Math.min(50, Math.trunc(limit)))};`;
      const rows = await query<IgdbGame>("games", body);
      return rows.filter((row) => typeof row?.id === "number").map(mapIgdbGame);
    },

    async details(igdbId: string): Promise<GameSearchResult | undefined> {
      const id = Number.parseInt(igdbId, 10);
      if (!Number.isFinite(id) || id <= 0) return undefined;
      const rows = await query<IgdbGame>("games", `where id = ${id}; fields ${GAME_FIELDS}; limit 1;`);
      const first = rows[0];
      return first === undefined ? undefined : mapIgdbGame(first);
    },
  };
}
