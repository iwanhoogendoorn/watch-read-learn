/**
 * AniList GraphQL client — the primary anime catalogue (SPEC2 D-ANIME).
 *
 * Why it leads over Jikan: one POST returns a whole week of **exact per-episode
 * Unix timestamps** with episode numbers attached, where Jikan can only offer a
 * weekly broadcast string ("Fridays at 23:00 (JST)") that has to be turned into
 * a date by hand. Report §1.2 has the comparison table.
 *
 * Four things this file exists to get right, all of them from live probes in
 * `docs/research/report-media-apis.md` §1.2:
 *
 *   1. **30 requests per minute, really.** The docs still advertise 90; the
 *      degraded 30 has been in force for years and was confirmed live on
 *      2026-08-03 (`x-ratelimit-limit: 30`). Every call goes through a 2 s
 *      min-gap limiter, which is 30/min by construction.
 *   2. **A 429 arrives as a GraphQL body**, `{"data": null, "errors": [{...,
 *      "status": 429}]}`, so error handling checks `errors[]` and not only the
 *      HTTP status — the same body shape can arrive on a 200.
 *   3. **`timeUntilAiring` is computed server-side** and is stale the moment it
 *      lands. Only `airingAt` is ever cached; countdowns are derived locally,
 *      exactly as the TV airing cache does with `airDate`.
 *   4. **Rate-limit raises are not being granted.** When AniList says stop, the
 *      client stops until `Retry-After` elapses instead of spending the next
 *      minute collecting more 429s.
 *
 * Reads need no key, so `configured()` asks whether the user has *chosen*
 * AniList, never whether they have credentials.
 */
import {
  type AniListAiring,
  type AniListAiringQuery,
  type AniListClient,
  type AniListMedia,
  type AniListSearchResult,
  type AniListStatus,
  type AniListTitle,
  type DateString,
  type HttpResponse,
} from "../types";
import { createTtlCache, type TtlCache } from "../domains/anime/cache";
import { AnimeApiError, type AnimeApiErrorInit } from "../domains/anime/errors";
import { defaultHttp, isApiError, type HttpFn } from "./http";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";
import { isRaw, rawArray, str, optNum, type Raw } from "./normalize";

export const ANILIST_ENDPOINT = "https://graphql.anilist.co";

/** 30 requests per minute is one every two seconds. The limiter *is* the budget. */
export const ANILIST_MIN_GAP_MS = 2000;

/** Fallback hold when a 429 arrives without a usable `Retry-After`. */
export const ANILIST_DEFAULT_BACKOFF_MS = 60_000;

/** Search results go stale fast enough to be worth re-asking, but not per keystroke. */
export const ANILIST_SEARCH_TTL_MS = 10 * 60_000;
/** Details and schedules: an hour. Airing times move rarely and by hours, not seconds. */
export const ANILIST_DETAILS_TTL_MS = 60 * 60_000;

/** AniList caps `perPage` at 50. Asking for more is a validation error, not a truncation. */
export const ANILIST_MAX_PER_PAGE = 50;

const STATUSES: ReadonlySet<string> = new Set<AniListStatus>([
  "RELEASING",
  "FINISHED",
  "NOT_YET_RELEASED",
  "CANCELLED",
  "HIATUS",
]);

// ---------------------------------------------------------------------------
// The shapes this client adds on top of the frozen contract
// ---------------------------------------------------------------------------

/**
 * `AniListMedia` plus the fields the add-flow needs and the contract does not
 * carry: minutes per episode, the trailer, and the external links a TMDB id can
 * sometimes be read out of.
 */
export interface AniListMediaFull extends AniListMedia {
  /** Minutes per episode. AniList reports it per entry, not per episode. */
  duration?: number;
  /** Already a watch URL, `""` when there is none. */
  trailerUrl: string;
  externalLinks: { site: string; url: string }[];
  season?: string;
}

export interface AniListSearchResultFull extends AniListSearchResult {
  duration?: number;
  startDate?: DateString | null;
  averageScore?: number;
  genres: string[];
}

/**
 * The contract plus batching.
 *
 * `mediaBatch` is what makes a 200-title library refreshable inside 30
 * requests/minute: `Page(media(id_in: [...]))` answers for up to 50 titles at
 * once, so the whole library costs four requests instead of two hundred.
 */
export interface AniListClientEx extends AniListClient {
  testConnection(): Promise<{ ok: boolean; message: string }>;
  searchFull(query: string, perPage?: number): Promise<AniListSearchResultFull[]>;
  detailsFull(anilistId: number): Promise<AniListMediaFull>;
  mediaBatch(anilistIds: readonly number[]): Promise<AniListMediaFull[]>;
  /** Clears the client-side cache. The "refresh, I mean it" path. */
  invalidate(): void;
}

export interface AniListConfig {
  /** `true` when anime routing is on at all — reads need no credentials. */
  enabled: boolean;
}

export interface AniListDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
  cache?: TtlCache<unknown>;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  status
  format
  episodes
  duration
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  coverImage { large extraLarge }
  bannerImage
  description(asHtml: false)
  genres
  averageScore
  studios(isMain: true) { nodes { name } }
  trailer { id site }
  externalLinks { site url }
  nextAiringEpisode { airingAt episode }
`;

const SEARCH_QUERY = `query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {${MEDIA_FIELDS}}
  }
}`;

const DETAILS_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {${MEDIA_FIELDS}}
}`;

const BATCH_QUERY = `query ($ids: [Int], $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {${MEDIA_FIELDS}}
  }
}`;

/**
 * `timeUntilAiring` is deliberately **not** requested. It is computed at request
 * time, so caching it would cache a lie; `airingAt` plus the local clock is the
 * whole countdown.
 */
const AIRING_QUERY = `query ($ids: [Int], $from: Int, $to: Int, $perPage: Int, $page: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      currentPage
      hasNextPage
    }
    airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      airingAt
      episode
      mediaId
    }
  }
}`;

/**
 * How many schedule pages one call will walk.
 *
 * A stop is needed — `hasNextPage` is the server's word and a loop that trusts
 * it unconditionally is a loop — and the budget is the real constraint: AniList
 * allows 30 requests a minute, so a sweep that spends twenty of them on one
 * window has nothing left for the media queries around it. Ten pages is 500
 * episodes, comfortably more than a 134-day window over any real library.
 */
export const ANILIST_MAX_AIRING_PAGES = 10;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function animeStatus(value: unknown): AniListStatus {
  const raw = typeof value === "string" ? value.toUpperCase() : "";
  return (STATUSES.has(raw) ? raw : "NOT_YET_RELEASED") as AniListStatus;
}

function titleOf(raw: Raw): AniListTitle {
  const node = isRaw(raw["title"]) ? raw["title"] : {};
  return {
    romaji: str(node, "romaji"),
    english: str(node, "english"),
    native: str(node, "native"),
  };
}

/** AniList's `{year, month, day}` with any part nullable → `YYYY-MM-DD` or null. */
export function fuzzyDate(value: unknown): DateString | null {
  if (!isRaw(value)) return null;
  const year = optNum(value, "year");
  if (year === undefined || year <= 0) return null;
  const month = optNum(value, "month") ?? 1;
  const day = optNum(value, "day") ?? 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** AniList's description is HTML-ish even with `asHtml: false` — it keeps `<br>`. */
export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trailerUrlOf(raw: Raw): string {
  const trailer = isRaw(raw["trailer"]) ? raw["trailer"] : undefined;
  if (!trailer) return "";
  const id = str(trailer, "id");
  const site = str(trailer, "site").toLowerCase();
  if (!id) return "";
  if (site === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (site === "dailymotion") return `https://www.dailymotion.com/video/${id}`;
  return "";
}

function coverOf(raw: Raw): string {
  const cover = isRaw(raw["coverImage"]) ? raw["coverImage"] : undefined;
  if (!cover) return "";
  return str(cover, "extraLarge") || str(cover, "large") || str(cover, "medium");
}

function studioNamesOf(raw: Raw): string[] {
  const studios = isRaw(raw["studios"]) ? raw["studios"] : undefined;
  if (!studios) return [];
  return rawArray(studios["nodes"])
    .map((node) => str(node, "name"))
    .filter((name) => name !== "");
}

export function normalizeAniListMedia(raw: Raw): AniListMediaFull {
  const media: AniListMediaFull = {
    id: optNum(raw, "id") ?? 0,
    title: titleOf(raw),
    status: animeStatus(raw["status"]),
    format: str(raw, "format"),
    coverUrl: coverOf(raw),
    description: stripHtml(str(raw, "description")),
    // `genres` is a plain string array, which `rawArray` (object-shaped) drops.
    genres: Array.isArray(raw["genres"])
      ? raw["genres"].filter((g): g is string => typeof g === "string")
      : [],
    studios: studioNamesOf(raw),
    trailerUrl: trailerUrlOf(raw),
    externalLinks: rawArray(raw["externalLinks"])
      .map((link) => ({ site: str(link, "site"), url: str(link, "url") }))
      .filter((link) => link.url !== ""),
  };

  const malId = optNum(raw, "idMal");
  if (malId !== undefined && malId > 0) media.malId = malId;

  const episodes = optNum(raw, "episodes");
  if (episodes !== undefined && episodes > 0) media.episodes = episodes;

  const duration = optNum(raw, "duration");
  if (duration !== undefined && duration > 0) media.duration = duration;

  const seasonYear = optNum(raw, "seasonYear");
  if (seasonYear !== undefined && seasonYear > 0) media.seasonYear = seasonYear;

  const season = str(raw, "season");
  if (season) media.season = season;

  const start = fuzzyDate(raw["startDate"]);
  if (start) media.startDate = start;
  const end = fuzzyDate(raw["endDate"]);
  if (end) media.endDate = end;

  const banner = str(raw, "bannerImage");
  if (banner) media.bannerUrl = banner;

  const score = optNum(raw, "averageScore");
  if (score !== undefined && score > 0) media.averageScore = score;

  const next = isRaw(raw["nextAiringEpisode"]) ? raw["nextAiringEpisode"] : undefined;
  const airingAt = next ? optNum(next, "airingAt") : undefined;
  if (next && airingAt !== undefined && airingAt > 0) {
    media.nextAiring = {
      mediaId: media.id,
      episode: optNum(next, "episode") ?? 0,
      airingAt,
    };
  }

  return media;
}

export function searchResultFrom(media: AniListMediaFull): AniListSearchResultFull {
  const out: AniListSearchResultFull = {
    id: media.id,
    title: media.title,
    format: media.format,
    status: media.status,
    coverUrl: media.coverUrl,
    description: media.description,
    genres: media.genres,
  };
  if (media.malId !== undefined) out.malId = media.malId;
  if (media.episodes !== undefined) out.episodes = media.episodes;
  if (media.seasonYear !== undefined) out.seasonYear = media.seasonYear;
  if (media.duration !== undefined) out.duration = media.duration;
  if (media.startDate !== undefined) out.startDate = media.startDate;
  if (media.averageScore !== undefined) out.averageScore = media.averageScore;
  return out;
}

function normalizeAiring(raw: Raw): AniListAiring | undefined {
  const airingAt = optNum(raw, "airingAt");
  const mediaId = optNum(raw, "mediaId");
  if (airingAt === undefined || airingAt <= 0 || mediaId === undefined) return undefined;
  return { mediaId, episode: optNum(raw, "episode") ?? 0, airingAt };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Header or GraphQL body, whichever the throttle put the wait in. */
function retryAfterMs(headers: Record<string, string>, nowSeconds: number): number {
  const retryAfter = Number(headers["retry-after"] ?? headers["Retry-After"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const reset = Number(headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"]);
  if (Number.isFinite(reset) && reset > nowSeconds) return (reset - nowSeconds) * 1000;

  return ANILIST_DEFAULT_BACKOFF_MS;
}

export function createAniListClient(
  getConfig: () => AniListConfig,
  deps: AniListDeps = {},
): AniListClientEx {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(ANILIST_MIN_GAP_MS, clock);
  const cache = deps.cache ?? createTtlCache<unknown>(ANILIST_DETAILS_TTL_MS, clock);

  /** Set when AniList told us to stop. Nothing is sent before it elapses. */
  let blockedUntil = 0;

  function configured(): boolean {
    return getConfig().enabled;
  }

  function fail(init: AnimeApiErrorInit): never {
    throw new AnimeApiError(init);
  }

  /**
   * One GraphQL round trip.
   *
   * `allowStatuses` swallows the statuses whose *body* is the interesting part —
   * a 429 carries the GraphQL error, a 404 does not exist on this API at all, and
   * a 400 is a query validation failure worth reading rather than guessing at.
   */
  async function request(query: string, variables: Raw): Promise<Raw> {
    if (!configured()) {
      fail({ provider: "anilist", reason: "not-enabled", detail: "AniList routing is off" });
    }

    const now = clock.now();
    if (blockedUntil > now) {
      fail({
        provider: "anilist",
        reason: "rate-limited",
        detail: "waiting out an AniList rate-limit timeout",
        retryAfterMs: blockedUntil - now,
      });
    }

    let response: HttpResponse<Raw>;
    try {
      response = await limiter.run(() =>
        http<Raw>({
          url: ANILIST_ENDPOINT,
          method: "POST",
          source: "tmdb", // see `domains/anime/errors.ts`: never surfaces
          json: { query, variables },
          allowStatuses: [400, 404, 429],
        }),
      );
    } catch (err) {
      if (isApiError(err)) {
        fail({
          provider: "anilist",
          reason: err.reason,
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.detail !== undefined ? { detail: err.detail } : {}),
        });
      }
      fail({
        provider: "anilist",
        reason: "network",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const body = isRaw(response.json) ? response.json : undefined;
    // Rule 2 of the header: the errors array is authoritative, whatever the
    // status line says. A 200 with `data: null` is a real AniList failure.
    const errors = body ? rawArray(body["errors"]) : [];
    const first = errors[0];
    const errorStatus = first ? (optNum(first, "status") ?? response.status) : response.status;

    if (errorStatus === 429 || response.status === 429) {
      const wait = retryAfterMs(response.headers ?? {}, Math.floor(clock.now() / 1000));
      blockedUntil = clock.now() + wait;
      fail({
        provider: "anilist",
        reason: "rate-limited",
        status: 429,
        retryAfterMs: wait,
        ...(first ? { providerMessage: str(first, "message") } : {}),
      });
    }

    if (errors.length > 0) {
      const message = first ? str(first, "message") : "";
      fail({
        provider: "anilist",
        reason: errorStatus === 404 ? "not-found" : errorStatus >= 500 ? "server" : "http",
        status: errorStatus,
        ...(message ? { providerMessage: message } : {}),
      });
    }

    if (response.status >= 400) {
      fail({
        provider: "anilist",
        reason: response.status >= 500 ? "server" : "http",
        status: response.status,
        detail: response.text.slice(0, 300),
      });
    }

    const data = body && isRaw(body["data"]) ? body["data"] : undefined;
    if (!data) {
      fail({ provider: "anilist", reason: "parse", status: response.status, detail: "no data object" });
    }
    return data;
  }

  /** Cached GraphQL, keyed on the query and its variables. */
  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    const value = await load();
    cache.set(key, value);
    return value;
  }

  function pageMedia(data: Raw): Raw[] {
    const page = isRaw(data["Page"]) ? data["Page"] : undefined;
    return page ? rawArray(page["media"]) : [];
  }

  async function searchFull(query: string, perPage = 25): Promise<AniListSearchResultFull[]> {
    const trimmed = query.trim();
    if (trimmed === "") return [];
    const size = Math.min(Math.max(1, perPage), ANILIST_MAX_PER_PAGE);
    return cached(`search:${size}:${trimmed.toLowerCase()}`, async () => {
      const data = await request(SEARCH_QUERY, { search: trimmed, perPage: size });
      return pageMedia(data)
        .map((raw) => searchResultFrom(normalizeAniListMedia(raw)))
        .filter((hit) => hit.id > 0);
    });
  }

  async function detailsFull(anilistId: number): Promise<AniListMediaFull> {
    return cached(`media:${anilistId}`, async () => {
      const data = await request(DETAILS_QUERY, { id: anilistId });
      const raw = isRaw(data["Media"]) ? data["Media"] : undefined;
      if (!raw) {
        fail({ provider: "anilist", reason: "not-found", detail: `no AniList media ${anilistId}` });
      }
      return normalizeAniListMedia(raw);
    });
  }

  return {
    configured,

    async testConnection() {
      if (!configured()) return { ok: false, message: "Anime routing is set to Jikan." };
      try {
        await request(DETAILS_QUERY, { id: 1 });
        return { ok: true, message: "AniList answered. No key needed." };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `AniList did not answer: ${message}` };
      }
    },

    searchFull,
    detailsFull,

    async search(query: string, perPage = 25): Promise<AniListSearchResult[]> {
      return searchFull(query, perPage);
    },

    async details(anilistId: number): Promise<AniListMedia> {
      return detailsFull(anilistId);
    },

    /** Up to 50 titles per request — the whole point, under a 30/min budget. */
    async mediaBatch(anilistIds: readonly number[]): Promise<AniListMediaFull[]> {
      const ids = [...new Set(anilistIds.filter((id) => id > 0))];
      if (ids.length === 0) return [];
      const out: AniListMediaFull[] = [];
      for (let i = 0; i < ids.length; i += ANILIST_MAX_PER_PAGE) {
        const chunk = ids.slice(i, i + ANILIST_MAX_PER_PAGE);
        const data = await request(BATCH_QUERY, { ids: chunk, perPage: chunk.length });
        out.push(...pageMedia(data).map(normalizeAniListMedia).filter((m) => m.id > 0));
      }
      return out;
    },

    async airingSchedules(query: AniListAiringQuery): Promise<AniListAiring[]> {
      const ids = [...new Set((query.mediaIds ?? []).filter((id) => id > 0))];
      if (query.mediaIds !== undefined && ids.length === 0) return [];

      const perPage = Math.min(Math.max(1, query.perPage ?? ANILIST_MAX_PER_PAGE), ANILIST_MAX_PER_PAGE);
      const variables: Raw = { perPage };
      if (ids.length > 0) variables["ids"] = ids;
      if (query.from !== undefined) variables["from"] = Math.trunc(query.from);
      if (query.to !== undefined) variables["to"] = Math.trunc(query.to);

      // Paginate (W8 review P1-6). `perPage` caps at 50, and four weekly shows
      // can exceed that over the window the airing sweep asks for — so page one
      // was silently the whole answer, and every later schedule was invisible.
      // Each page goes through the same limiter as everything else.
      const out: AniListAiring[] = [];
      for (let page = 1; page <= ANILIST_MAX_AIRING_PAGES; page += 1) {
        const data = await request(AIRING_QUERY, { ...variables, page });
        const pageData = isRaw(data["Page"]) ? data["Page"] : undefined;
        out.push(
          ...rawArray(pageData?.["airingSchedules"])
            .map(normalizeAiring)
            .filter((entry): entry is AniListAiring => entry !== undefined),
        );

        const info = isRaw(pageData?.["pageInfo"]) ? pageData["pageInfo"] : undefined;
        if (info?.["hasNextPage"] !== true) break;
        if (page === ANILIST_MAX_AIRING_PAGES) {
          // Say so rather than truncating in silence: the next sweep will see
          // the rest once the window has moved on.
          console.warn(
            `[wrl] AniList had more airing schedules than ${ANILIST_MAX_AIRING_PAGES} pages; the rest wait for the next refresh`,
          );
        }
      }
      return out;
    },

    invalidate() {
      cache.clear();
      blockedUntil = 0;
    },
  };
}
