/**
 * Direct TMDB v3 client — **optional** enrichment (SPEC D4).
 *
 * Overseerr already proxies TMDB and merges Plex availability into the same
 * payload, so this exists for two cases only: the user runs no Overseerr, or
 * Overseerr's proxy is missing something we want (digital release dates, the
 * full `/videos` list). Everything degrades to "not configured" without it.
 *
 * Auth is the **v4 read access token** as a Bearer header (report §3.1) — a long
 * JWT starting `eyJ`. The v3 `?api_key=` form works too but puts the credential
 * in URLs and logs, so the settings field asks for the token.
 *
 * TMDB answers in snake_case; `services/normalize.ts` reads both spellings, so
 * the results land in exactly the same shapes Overseerr produces.
 */
import { RATE_LIMIT_MS } from "../constants";
import {
  type DateString,
  type MediaType,
  type OverseerrDetails,
  type OverseerrSearchResult,
  type TmdbClient,
  type TmdbVideo,
} from "../types";
import { ApiError, defaultHttp, isApiError, type HttpFn } from "./http";
import { queryString } from "./http";
import {
  backdropUrl,
  bool,
  castNames,
  dateOnly,
  directorNames,
  displayTitle,
  episodeRuntime,
  genreNames,
  isRaw,
  normalizeEpisodeStub,
  normalizeSearchResult,
  normalizeSeasons,
  normalizeVideos,
  num,
  optNum,
  posterUrl,
  primaryDate,
  rawArray,
  str,
  studioNames,
  trailerUrlFrom,
  type Raw,
} from "./normalize";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";

export const TMDB_API_BASE = "https://api.themoviedb.org/3";

/** `release_dates[].type` — 4 (Digital) is the one a home-media tracker cares about. */
export const TMDB_RELEASE_TYPE_DIGITAL = 4;

export interface TmdbConfig {
  /** v4 read access token. Empty means "not configured". */
  token: string;
}

export interface TmdbDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
}

/** TMDB has no published hard limit but asks that a 429 be respected. */
const RATE_LIMIT_RETRY_MS = 1000;

export function createTmdbClient(getConfig: () => TmdbConfig, deps: TmdbDeps = {}): TmdbClient {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(RATE_LIMIT_MS.tmdb, clock);

  function configured(): boolean {
    return getConfig().token.trim() !== "";
  }

  function requireConfigured(): void {
    if (!configured()) {
      throw new ApiError({ source: "tmdb", reason: "no-key", detail: "tmdbToken is empty" });
    }
  }

  async function get(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Raw> {
    requireConfigured();
    const url = `${TMDB_API_BASE}${path}${queryString(params)}`;
    const headers = { Authorization: `Bearer ${getConfig().token.trim()}` };

    const attempt = () => limiter.run(() => http({ url, source: "tmdb", headers }));

    let response;
    try {
      response = await attempt();
    } catch (err) {
      // One polite retry, then give up and let the caller degrade.
      if (isApiError(err) && err.reason === "rate-limited") {
        await clock.sleep(RATE_LIMIT_RETRY_MS);
        response = await attempt();
      } else {
        throw err;
      }
    }

    if (!isRaw(response.json)) {
      throw new ApiError({ source: "tmdb", reason: "parse", url, detail: "expected a JSON object" });
    }
    return response.json;
  }

  function normalizeDetails(raw: Raw, tmdbId: number, mediaType: MediaType): OverseerrDetails {
    const credits = isRaw(raw["credits"]) ? raw["credits"] : undefined;
    const externalIds = isRaw(raw["external_ids"]) ? raw["external_ids"] : undefined;
    const videos = isRaw(raw["videos"]) ? normalizeVideos(raw["videos"]["results"]) : [];

    const details: OverseerrDetails = {
      tmdbId: optNum(raw, "id") ?? tmdbId,
      mediaType,
      title: displayTitle(raw),
      overview: str(raw, "overview"),
      posterUrl: posterUrl(raw),
      backdropUrl: backdropUrl(raw),
      releaseDate: primaryDate(raw),
      genres: genreNames(raw),
      runtime: mediaType === "movie" ? num(raw, "runtime") : episodeRuntime(raw),
      voteAverage: num(raw, "vote_average"),
      voteCount: num(raw, "vote_count"),
      trailerUrl: trailerUrlFrom(videos),
      director: directorNames(credits),
      cast: castNames(credits),
      studio: studioNames(raw, mediaType),
    };

    const imdbId = str(raw, "imdb_id") || (externalIds ? str(externalIds, "imdb_id") : "");
    if (imdbId) details.imdbId = imdbId;

    if (mediaType === "tv") {
      details.showStatus = str(raw, "status");
      details.inProduction = bool(raw, "in_production");
      details.seasons = normalizeSeasons(raw["seasons"]);
      details.numberOfSeasons = optNum(raw, "number_of_seasons") ?? details.seasons.length;
      details.numberOfEpisodes = optNum(raw, "number_of_episodes") ?? 0;
      details.nextEpisodeToAir = normalizeEpisodeStub(raw["next_episode_to_air"]);
      details.lastEpisodeToAir = normalizeEpisodeStub(raw["last_episode_to_air"]);
    }

    return details;
  }

  return {
    configured,

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      if (!configured()) return { ok: false, message: "No TMDB token set (optional)." };
      try {
        await get("/authentication");
        return { ok: true, message: "TMDB token accepted." };
      } catch (err) {
        if (isApiError(err) && err.reason === "auth") {
          return { ok: false, message: "TMDB rejected the token. Use the v4 read access token." };
        }
        return {
          ok: false,
          message: isApiError(err) ? `TMDB error: ${err.message}` : "Could not reach TMDB.",
        };
      }
    },

    async search(query: string, mediaType: MediaType): Promise<OverseerrSearchResult[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const raw = await get(`/search/${mediaType}`, { query: trimmed, include_adult: false });
      return rawArray(raw["results"])
        .map((r) => normalizeSearchResult(r, mediaType))
        .filter((r): r is OverseerrSearchResult => r !== undefined);
    },

    /**
     * One round trip instead of four. `append_to_response` takes up to 20
     * sub-requests and each lands under its own key (report §3.4).
     */
    async details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails> {
      const append =
        mediaType === "movie"
          ? "videos,external_ids,credits,release_dates"
          : "videos,external_ids,credits";
      const raw = await get(`/${mediaType}/${tmdbId}`, { append_to_response: append });
      return normalizeDetails(raw, tmdbId, mediaType);
    },

    async videos(tmdbId: number, mediaType: MediaType): Promise<TmdbVideo[]> {
      // `include_video_language=en,null` widens the net: many entries carry no
      // language at all and would otherwise be filtered out server-side.
      const raw = await get(`/${mediaType}/${tmdbId}/videos`, {
        include_video_language: "en,null",
      });
      return normalizeVideos(raw["results"]);
    },

    /**
     * Earliest release of type >= 4 (Digital / Physical / TV) in `region`.
     *
     * Theatrical dates are noise for a home-media tracker — the digital date is
     * when the thing becomes gettable, typically months later.
     */
    async digitalReleaseDate(tmdbId: number, region: string): Promise<DateString | undefined> {
      const raw = await get(`/movie/${tmdbId}/release_dates`);
      const forRegion = rawArray(raw["results"]).find((r) => str(r, "iso_3166_1") === region);
      if (!forRegion) return undefined;

      const dates = rawArray(forRegion["release_dates"])
        .filter((d) => num(d, "type") >= TMDB_RELEASE_TYPE_DIGITAL)
        .map((d) => dateOnly(d["release_date"]))
        .filter((d): d is DateString => d !== null)
        .sort();

      return dates[0];
    },
  };
}
