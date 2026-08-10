/**
 * Jikan v4 client — the MyAnimeList side of anime routing (SPEC2 D-ANIME).
 *
 * Jikan is the fallback and the source of MAL ids. It is keyless, and it is a
 * **scraper**: it reads MyAnimeList, so it fails when MyAnimeList fails. That is
 * not a hypothetical — research §1.1 hit it live, five minutes of
 * `504 BadResponseException` on every MAL-backed endpoint.
 *
 * Four rules, all from report §1.1:
 *
 *   1. **3 requests/second and 60/minute.** The per-minute limit is the binding
 *      one (3/s sustained would be 180/min), so this client enforces both: a
 *      400 ms min-gap *and* a sliding 60-second window counter.
 *   2. **No ETag, no `If-None-Match`, ever.** A conditional request is not
 *      possible, so the client-side cache is mandatory rather than an
 *      optimisation.
 *   3. **`504 BadResponseException` is an upstream outage**, not a blip. It gets
 *      a backoff measured in minutes and stale cache is served in the meantime;
 *      retrying tightly is demonstrably useless.
 *   4. **`status` is a string in one error body and a number in another** — the
 *      429 sends `"429"`, the 504 sends `504`. Never compare it without coercing.
 *
 * The deprecated `title` / `title_english` fields are read only as a fallback:
 * the non-deprecated source is `titles[]`.
 */
import {
  type DateString,
  type HttpResponse,
  type JikanAnime,
  type JikanClient,
} from "../types";
import { createTtlCache, type TtlCache } from "../domains/anime/cache";
import { AnimeApiError, type AnimeApiErrorInit } from "../domains/anime/errors";
import { defaultHttp, isApiError, queryString, type HttpFn } from "./http";
import { isRaw, rawArray, str, optNum, dateOnly, type Raw } from "./normalize";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";

export const JIKAN_BASE = "https://api.jikan.moe/v4";

/** 400 ms — 2.5 req/s, comfortably inside the 3/s cap. The v3 gap, kept. */
export const JIKAN_MIN_GAP_MS = 400;

/** The binding limit: 60 requests in any 60-second window. */
export const JIKAN_WINDOW_MS = 60_000;
export const JIKAN_WINDOW_MAX = 60;

/**
 * How long a `504 BadResponseException` sidelines Jikan.
 *
 * Five minutes, because that is roughly how long the observed outage lasted and
 * because the alternative — retrying every few seconds against a MAL that is
 * down — spends the entire rate budget on failures.
 */
export const JIKAN_OUTAGE_BACKOFF_MS = 5 * 60_000;

/** A 429 without a `Retry-After` (Jikan sends none) waits out one window. */
export const JIKAN_RATE_LIMIT_BACKOFF_MS = 60_000;

export const JIKAN_SEARCH_TTL_MS = 10 * 60_000;
export const JIKAN_DETAILS_TTL_MS = 6 * 60 * 60_000;

/** Jikan's own server-side cache is 24 h, so nothing shorter buys freshness. */
export const JIKAN_SCHEDULE_TTL_MS = 60 * 60_000;

export interface JikanConfig {
  /** `true` when anime routing may use Jikan (as primary or as fallback). */
  enabled: boolean;
}

export interface JikanDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
  cache?: TtlCache<unknown>;
}

/**
 * `JikanAnime` plus what the add-flow needs and the frozen contract omits.
 *
 * Jikan publishes the runtime as prose (`"24 min per ep"`), not a number, so the
 * parsed value is carried alongside the text it came from rather than replacing
 * it.
 */
export interface JikanAnimeFull extends JikanAnime {
  /** Minutes per episode, parsed from `durationText`. */
  durationMinutes?: number;
  durationText: string;
  trailerUrl: string;
  /** The MyAnimeList page, for `externalLink`. */
  url: string;
}

export interface JikanClientEx extends JikanClient {
  testConnection(): Promise<{ ok: boolean; message: string }>;
  search(query: string, limit?: number): Promise<JikanAnimeFull[]>;
  full(malId: number): Promise<JikanAnimeFull>;
  schedules(day?: string): Promise<JikanAnimeFull[]>;
  /** `true` while a MyAnimeList outage is being waited out. */
  inOutage(): boolean;
  invalidate(): void;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Rule 4: `status` is `"429"` in one body and `504` in another. */
export function errorStatusOf(body: unknown): number | undefined {
  if (!isRaw(body)) return undefined;
  const value = Number(body["status"]);
  return Number.isFinite(value) ? value : undefined;
}

/** Jikan's own name for the failure — `BadResponseException` is the outage one. */
export function errorTypeOf(body: unknown): string {
  return isRaw(body) ? str(body, "type") : "";
}

export function isUpstreamOutage(status: number | undefined, type: string): boolean {
  return status === 504 || type === "BadResponseException";
}

/**
 * The display title.
 *
 * `titles[]` is the non-deprecated source; `Default` is MAL's romaji and
 * `English` is what most people search for, so English wins when it exists and
 * the deprecated flat fields are the last resort.
 */
export function preferredJikanTitle(raw: Raw): string {
  const titles = rawArray(raw["titles"]).map((t) => ({ type: str(t, "type"), title: str(t, "title") }));
  const byType = (type: string): string =>
    titles.find((t) => t.type.toLowerCase() === type && t.title !== "")?.title ?? "";
  return (
    byType("english") ||
    byType("default") ||
    titles.find((t) => t.title !== "")?.title ||
    str(raw, "title_english") ||
    str(raw, "title")
  );
}

function airedDate(aired: Raw | undefined, key: "from" | "to"): DateString | null {
  if (!aired) return null;
  return dateOnly(aired[key]);
}

/** `"24 min per ep"` / `"1 hr 41 min"` → minutes. `undefined` for "Unknown". */
export function parseJikanDuration(duration: string): number | undefined {
  const hours = /(\d+)\s*hr/.exec(duration);
  const minutes = /(\d+)\s*min/.exec(duration);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total : undefined;
}

export function normalizeJikanAnime(raw: Raw): JikanAnimeFull {
  const aired = isRaw(raw["aired"]) ? raw["aired"] : undefined;
  const images = isRaw(raw["images"]) ? raw["images"] : undefined;
  const jpg = images && isRaw(images["jpg"]) ? images["jpg"] : undefined;
  const webp = images && isRaw(images["webp"]) ? images["webp"] : undefined;
  const broadcast = isRaw(raw["broadcast"]) ? raw["broadcast"] : undefined;
  const trailer = isRaw(raw["trailer"]) ? raw["trailer"] : undefined;
  const durationText = str(raw, "duration");

  const anime: JikanAnimeFull = {
    malId: optNum(raw, "mal_id") ?? 0,
    title: preferredJikanTitle(raw),
    titles: rawArray(raw["titles"]).map((t) => ({ type: str(t, "type"), title: str(t, "title") })),
    type: str(raw, "type"),
    status: str(raw, "status"),
    airing: raw["airing"] === true,
    airedFrom: airedDate(aired, "from"),
    airedTo: airedDate(aired, "to"),
    // Rule from report §1.1: an unknown score is `0`, not null. Kept as reported
    // so callers can tell "unrated" from "rated zero" — nothing averages it.
    score: optNum(raw, "score") ?? 0,
    imageUrl:
      (jpg ? str(jpg, "large_image_url") || str(jpg, "image_url") : "") ||
      (webp ? str(webp, "large_image_url") || str(webp, "image_url") : ""),
    synopsis: str(raw, "synopsis"),
    genres: rawArray(raw["genres"])
      .map((g) => str(g, "name"))
      .filter((name) => name !== ""),
    studios: rawArray(raw["studios"])
      .map((s) => str(s, "name"))
      .filter((name) => name !== ""),
    durationText,
    trailerUrl: trailer ? str(trailer, "url") : "",
    url: str(raw, "url"),
  };

  const durationMinutes = parseJikanDuration(durationText);
  if (durationMinutes !== undefined) anime.durationMinutes = durationMinutes;

  const episodes = optNum(raw, "episodes");
  if (episodes !== undefined && episodes > 0) anime.episodes = episodes;

  if (broadcast) {
    anime.broadcast = {
      day: str(broadcast, "day") || null,
      time: str(broadcast, "time") || null,
      timezone: str(broadcast, "timezone") || null,
    };
  }

  const season = str(raw, "season");
  anime.season = season || null;
  const year = optNum(raw, "year");
  anime.year = year !== undefined && year > 0 ? year : null;

  return anime;
}

/** `"Fridays"` → `"friday"`. Jikan's own `/schedules` filter is singular. */
export function scheduleFilterFor(broadcastDay: string | null | undefined): string | undefined {
  const day = (broadcastDay ?? "").trim().toLowerCase().replace(/s$/, "");
  const valid = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return valid.includes(day) ? day : undefined;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createJikanClient(
  getConfig: () => JikanConfig,
  deps: JikanDeps = {},
): JikanClientEx {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(JIKAN_MIN_GAP_MS, clock);
  const cache = deps.cache ?? createTtlCache<unknown>(JIKAN_DETAILS_TTL_MS, clock);

  /** Start times inside the current 60 s window, oldest first. */
  const window: number[] = [];
  /** Set by a 429 or by a MyAnimeList outage. */
  let blockedUntil = 0;
  let outageUntil = 0;

  function configured(): boolean {
    return getConfig().enabled;
  }

  function fail(init: AnimeApiErrorInit): never {
    throw new AnimeApiError(init);
  }

  /** Rule 1's second half: never let 60 requests fit inside one minute. */
  async function awaitWindowSlot(): Promise<void> {
    for (;;) {
      const now = clock.now();
      while (window.length > 0 && now - (window[0] as number) >= JIKAN_WINDOW_MS) window.shift();
      if (window.length < JIKAN_WINDOW_MAX) {
        window.push(now);
        return;
      }
      await clock.sleep(JIKAN_WINDOW_MS - (now - (window[0] as number)));
    }
  }

  async function get(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Raw> {
    if (!configured()) {
      fail({ provider: "jikan", reason: "not-enabled", detail: "Jikan routing is off" });
    }

    const now = clock.now();
    if (outageUntil > now) {
      fail({
        provider: "jikan",
        reason: "server",
        status: 504,
        detail: "MyAnimeList outage backoff in effect",
        retryAfterMs: outageUntil - now,
      });
    }
    if (blockedUntil > now) {
      fail({
        provider: "jikan",
        reason: "rate-limited",
        detail: "waiting out a Jikan rate-limit window",
        retryAfterMs: blockedUntil - now,
      });
    }

    const url = `${JIKAN_BASE}${path}${queryString(params)}`;

    let response: HttpResponse<Raw>;
    try {
      response = await limiter.run(async () => {
        await awaitWindowSlot();
        return http<Raw>({
          url,
          source: "tmdb", // see `domains/anime/errors.ts`: never surfaces
          allowStatuses: [400, 404, 429, 500, 503, 504],
        });
      });
    } catch (err) {
      if (isApiError(err)) {
        fail({
          provider: "jikan",
          reason: err.reason,
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.detail !== undefined ? { detail: err.detail } : {}),
        });
      }
      fail({
        provider: "jikan",
        reason: "network",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const body = isRaw(response.json) ? response.json : undefined;
    const bodyStatus = errorStatusOf(body);
    const bodyType = errorTypeOf(body);
    const status = response.status >= 400 ? response.status : (bodyStatus ?? response.status);

    if (isUpstreamOutage(status, bodyType)) {
      // Rule 3: this is MyAnimeList being down, not Jikan rejecting us. Sideline
      // the provider for minutes and let callers fall back to stale cache or to
      // AniList, which is unaffected.
      outageUntil = clock.now() + JIKAN_OUTAGE_BACKOFF_MS;
      fail({
        provider: "jikan",
        reason: "server",
        status: 504,
        retryAfterMs: JIKAN_OUTAGE_BACKOFF_MS,
        providerMessage: body ? str(body, "message") : "",
      });
    }

    if (status === 429) {
      blockedUntil = clock.now() + JIKAN_RATE_LIMIT_BACKOFF_MS;
      fail({
        provider: "jikan",
        reason: "rate-limited",
        status: 429,
        retryAfterMs: JIKAN_RATE_LIMIT_BACKOFF_MS,
        providerMessage: body ? str(body, "message") : "",
      });
    }

    if (status >= 400) {
      fail({
        provider: "jikan",
        reason: status === 404 ? "not-found" : status >= 500 ? "server" : "http",
        status,
        ...(body ? { providerMessage: str(body, "message") } : {}),
      });
    }

    if (!body) {
      fail({ provider: "jikan", reason: "parse", status: response.status, detail: "no JSON object" });
    }
    return body;
  }

  /**
   * Cached fetch with an outage fallback.
   *
   * A stale entry beats an error when the failure is MyAnimeList's rather than
   * ours — the user asked about a show, not about Jikan's upstream.
   */
  async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key) as { value: T; at: number } | undefined;
    if (hit !== undefined && clock.now() - hit.at < ttlMs) return hit.value;
    try {
      const value = await load();
      cache.set(key, { value, at: clock.now() });
      return value;
    } catch (err) {
      const stale = cache.stale(key) as { value: T; at: number } | undefined;
      if (stale !== undefined && err instanceof AnimeApiError && err.reason === "server") {
        return stale.value;
      }
      throw err;
    }
  }

  function dataArray(body: Raw): Raw[] {
    return rawArray(body["data"]);
  }

  return {
    configured,

    async testConnection() {
      if (!configured()) return { ok: false, message: "Anime routing is set to AniList." };
      try {
        await get("/anime/1");
        return { ok: true, message: "Jikan answered. No key needed." };
      } catch (err) {
        if (err instanceof AnimeApiError && err.reason === "server") {
          return { ok: false, message: "Jikan is up but MyAnimeList is not answering it. Try again later." };
        }
        return {
          ok: false,
          message: `Jikan did not answer: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    inOutage() {
      return outageUntil > clock.now();
    },

    async search(query: string, limit = 25): Promise<JikanAnimeFull[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const size = Math.min(Math.max(1, limit), 25);
      return cached(`search:${size}:${trimmed.toLowerCase()}`, JIKAN_SEARCH_TTL_MS, async () => {
        const body = await get("/anime", { q: trimmed, limit: size, sfw: false });
        return dataArray(body)
          .map(normalizeJikanAnime)
          .filter((anime) => anime.malId > 0);
      });
    },

    async full(malId: number): Promise<JikanAnimeFull> {
      return cached(`anime:${malId}`, JIKAN_DETAILS_TTL_MS, async () => {
        const body = await get(`/anime/${malId}/full`);
        const raw = isRaw(body["data"]) ? body["data"] : undefined;
        if (!raw) {
          fail({ provider: "jikan", reason: "not-found", detail: `no MAL entry ${malId}` });
        }
        return normalizeJikanAnime(raw);
      });
    },

    /**
     * `day` must already be the singular lowercase filter. Omitting it asks for
     * the whole schedule — note that `unknown` and `other` are real buckets that
     * a Monday-to-Sunday loop silently drops (report §1.1.4).
     */
    async schedules(day?: string): Promise<JikanAnimeFull[]> {
      const filter = day ? scheduleFilterFor(day) : undefined;
      return cached(`schedules:${filter ?? "all"}`, JIKAN_SCHEDULE_TTL_MS, async () => {
        const body = await get("/schedules", {
          ...(filter ? { filter } : {}),
          // `/schedules` types these as strings while `/anime` types them as
          // booleans. Inconsistent, and it 400s if you get it wrong.
          sfw: "false",
          limit: 25,
        });
        return dataArray(body)
          .map(normalizeJikanAnime)
          .filter((anime) => anime.malId > 0);
      });
    },

    invalidate() {
      cache.clear();
      blockedUntil = 0;
      outageUntil = 0;
    },
  };
}
