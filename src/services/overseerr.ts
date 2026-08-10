/**
 * Overseerr / Jellyseerr client — the primary gateway (SPEC D4).
 *
 * One authenticated host gives us TMDB search, TMDB metadata, Plex availability,
 * per-season status, request creation and request state. That is why the user
 * needs no TMDB key at all; `services/tmdb.ts` is optional enrichment.
 *
 * Everything non-obvious here comes from `docs/research/report-overseerr-tmdb.md`
 * §1, and the three traps it documents are handled explicitly:
 *
 *   1. **Two status enums, overlapping integers.** `status: 5` is COMPLETED on a
 *      request and AVAILABLE on media. They get two formatters, deliberately not
 *      shared — see `describeRequestStatus` / `describeMediaStatus`.
 *   2. **202 is a failure wearing a 2xx.** `POST /request` answers 202 with
 *      `{message}` when every requested season is already available or pending.
 *      Nothing was created. It is branched on explicitly.
 *   3. **Absent `mediaInfo` ≠ `UNKNOWN`.** Absent means Overseerr has never
 *      tracked the title; `normalizeMediaInfo` keeps it absent.
 *
 * And `status4k`: on a server without a 4K instance it sits at `UNKNOWN`
 * forever. `has4kSignal` is the only thing allowed to decide it is worth showing.
 */
import { RATE_LIMIT_MS } from "../constants";
import {
  MediaRequestStatus,
  MediaStatus,
  type MediaType,
  type OverseerrClient,
  type OverseerrConnectionInfo,
  type OverseerrDetails,
  type OverseerrMediaInfo,
  type OverseerrRequest,
  type OverseerrSearchResult,
  type RequestOutcome,
} from "../types";
import { ApiError, defaultHttp, isApiError, joinUrl, queryString, type HttpFn } from "./http";
import {
  backdropUrl,
  bool,
  castNames,
  directorNames,
  displayTitle,
  episodeRuntime,
  genreNames,
  isRaw,
  normalizeEpisodeStub,
  normalizeMediaInfo,
  normalizeSearchResult,
  normalizeSeasons,
  num,
  optNum,
  posterUrl,
  primaryDate,
  rawArray,
  str,
  studioNames,
  trailerFromRelatedVideos,
  type Raw,
} from "./normalize";
import { createRateLimiter, type RateLimiter } from "./ratelimit";

export interface OverseerrConfig {
  /** Server base URL, no `/api/v1` suffix. */
  url: string;
  apiKey: string;
}

export interface OverseerrDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
}

// ---------------------------------------------------------------------------
// The two enums — two formatters, never one
// ---------------------------------------------------------------------------

/** `MediaRequest.status`. Do not pass a `MediaStatus` to this. */
export function describeRequestStatus(status: MediaRequestStatus | number): string {
  switch (status) {
    case MediaRequestStatus.PENDING:
      return "Pending approval";
    case MediaRequestStatus.APPROVED:
      return "Approved";
    case MediaRequestStatus.DECLINED:
      return "Declined";
    case MediaRequestStatus.FAILED:
      return "Failed";
    case MediaRequestStatus.COMPLETED:
      return "Completed";
    default:
      return "Requested";
  }
}

/** `MediaInfo.status`. Do not pass a `MediaRequestStatus` to this. */
export function describeMediaStatus(status: MediaStatus | number): string {
  switch (status) {
    case MediaStatus.UNKNOWN:
      return "Not tracked";
    case MediaStatus.PENDING:
      return "Requested";
    case MediaStatus.PROCESSING:
      return "Processing";
    case MediaStatus.PARTIALLY_AVAILABLE:
      return "Partially available";
    case MediaStatus.AVAILABLE:
      return "Available";
    case MediaStatus.DELETED:
      return "Removed";
    default:
      return "Unknown";
  }
}

export function isMediaAvailable(status: MediaStatus | number | undefined): boolean {
  return status === MediaStatus.AVAILABLE;
}

export function isMediaPartiallyAvailable(status: MediaStatus | number | undefined): boolean {
  return status === MediaStatus.PARTIALLY_AVAILABLE;
}

/** True when a request is still moving. Drives the poll-while-open loop. */
export function isRequestInFlight(status: MediaRequestStatus | number | undefined): boolean {
  return status === MediaRequestStatus.PENDING || status === MediaRequestStatus.APPROVED;
}

/**
 * Whether the 4K column means anything on this server.
 *
 * Without a 4K Radarr/Sonarr instance every title reports `status4k: UNKNOWN`.
 * Rendering that as "4K missing" would be noise on every card, forever.
 */
export function has4kSignal(info: OverseerrMediaInfo | undefined): boolean {
  return info !== undefined && typeof info.status4k === "number" && info.status4k > MediaStatus.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Normalisers specific to Overseerr
// ---------------------------------------------------------------------------

export function normalizeRequest(raw: Raw): OverseerrRequest {
  const request: OverseerrRequest = {
    id: num(raw, "id"),
    status: num(raw, "status"),
    createdAt: str(raw, "createdAt"),
    updatedAt: str(raw, "updatedAt"),
    is4k: bool(raw, "is4k"),
    // What the server actually accepted after de-duplicating against seasons
    // that are already available or requested — never an echo of our input.
    seasons: rawArray(raw["seasons"])
      .map((s) => num(s, "seasonNumber", "season_number"))
      .filter((n) => n > 0)
      .sort((a, b) => a - b),
  };
  const media = normalizeMediaInfo(raw["media"]);
  if (media) request.media = media;
  return request;
}

function normalizeDetails(raw: Raw, tmdbId: number, mediaType: MediaType): OverseerrDetails {
  const credits = isRaw(raw["credits"]) ? raw["credits"] : undefined;
  const externalIds = isRaw(raw["externalIds"]) ? raw["externalIds"] : undefined;

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
    voteAverage: num(raw, "voteAverage", "vote_average"),
    voteCount: num(raw, "voteCount", "vote_count"),
    trailerUrl: trailerFromRelatedVideos(raw["relatedVideos"]),
    director: directorNames(credits),
    cast: castNames(credits),
    studio: studioNames(raw),
  };

  const imdbId = str(raw, "imdbId") || (externalIds ? str(externalIds, "imdbId", "imdb_id") : "");
  if (imdbId) details.imdbId = imdbId;

  const mediaInfo = normalizeMediaInfo(raw["mediaInfo"]);
  if (mediaInfo) details.mediaInfo = mediaInfo;

  if (mediaType === "tv") {
    details.showStatus = str(raw, "status");
    details.inProduction = bool(raw, "inProduction", "in_production");
    details.seasons = normalizeSeasons(raw["seasons"]);
    // Overseerr's own field is `numberOfSeasons`; some builds and the OpenAPI
    // spec spell it `numberOfSeason`. Read every spelling, then fall back to the
    // (specials-free) season list we just normalised.
    details.numberOfSeasons =
      optNum(raw, "numberOfSeasons", "numberOfSeason", "number_of_seasons") ??
      details.seasons.length;
    details.numberOfEpisodes = optNum(raw, "numberOfEpisodes", "number_of_episodes") ?? 0;
    // `null` is meaningful: nothing is scheduled. It is a more reliable
    // "is it returning" signal than `status` (report §3.5).
    details.nextEpisodeToAir = normalizeEpisodeStub(raw["nextEpisodeToAir"] ?? raw["next_episode_to_air"]);
    details.lastEpisodeToAir = normalizeEpisodeStub(raw["lastEpisodeToAir"] ?? raw["last_episode_to_air"]);
  }

  return details;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createOverseerrClient(
  getConfig: () => OverseerrConfig,
  deps: OverseerrDeps = {},
): OverseerrClient {
  const http = deps.http ?? defaultHttp;
  const limiter = deps.limiter ?? createRateLimiter(RATE_LIMIT_MS.overseerr);

  function configured(): boolean {
    const { url, apiKey } = getConfig();
    return url.trim() !== "" && apiKey.trim() !== "";
  }

  function apiUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
    return joinUrl(getConfig().url.trim(), `/api/v1${path}`) + queryString(params);
  }

  function requireConfigured(): void {
    if (!configured()) {
      throw new ApiError({
        source: "overseerr",
        reason: "no-key",
        detail: "overseerrUrl or overseerrApiKey is empty",
      });
    }
  }

  function headers(): Record<string, string> {
    return { "X-Api-Key": getConfig().apiKey.trim() };
  }

  async function get<T = unknown>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    allowStatuses: number[] = [],
  ): Promise<{ status: number; json: T | undefined }> {
    requireConfigured();
    const url = apiUrl(path, params);
    return limiter.run(() =>
      http<T>({ url, source: "overseerr", headers: headers(), allowStatuses }),
    );
  }

  function expectObject(json: unknown, url: string): Raw {
    if (!isRaw(json)) {
      throw new ApiError({
        source: "overseerr",
        reason: "parse",
        url,
        detail: "expected a JSON object",
      });
    }
    return json;
  }

  /**
   * The pre-existing request behind a 409, when it can be resolved.
   *
   * `mediaInfo.requests[]` is dropped by `normalizeMediaInfo` (the frozen
   * `OverseerrMediaInfo` has no room for it), so this reads the raw payload.
   * Best-effort by design — a 409 is still a 409 if this comes back empty.
   */
  async function findExistingRequest(
    tmdbId: number,
    mediaType: MediaType,
  ): Promise<OverseerrRequest | undefined> {
    try {
      const { json } = await get(`/${mediaType}/${tmdbId}`);
      if (!isRaw(json)) return undefined;
      const info = json["mediaInfo"];
      if (!isRaw(info)) return undefined;
      const requests = rawArray(info["requests"]).filter((r) => !bool(r, "is4k"));
      const latest = requests[requests.length - 1];
      return latest ? normalizeRequest(latest) : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    configured,

    async testConnection(): Promise<OverseerrConnectionInfo> {
      if (!configured()) {
        return { ok: false, message: "Add the Overseerr URL and API key first." };
      }

      let version: string | undefined;
      try {
        const { json } = await get("/status");
        if (isRaw(json)) {
          const v = str(json, "version");
          if (v) version = v;
        }
      } catch (err) {
        return {
          ok: false,
          message: isApiError(err)
            ? `Could not reach Overseerr: ${err.message}`
            : "Could not reach Overseerr.",
        };
      }

      // `/status` is public on most builds, so it proves reachability, not the
      // key. `/auth/me` is the cheapest endpoint that actually needs auth.
      try {
        const { json } = await get("/auth/me");
        const user = isRaw(json) ? str(json, "displayName", "username", "email") : "";
        const info: OverseerrConnectionInfo = {
          ok: true,
          message: user
            ? `Connected as ${user}${version ? ` · Overseerr ${version}` : ""}`
            : `Connected${version ? ` · Overseerr ${version}` : ""}`,
        };
        if (version !== undefined) info.version = version;
        if (user) info.user = user;
        return info;
      } catch (err) {
        if (isApiError(err) && err.reason === "auth") {
          return {
            ok: false,
            ...(version !== undefined ? { version } : {}),
            message: "Overseerr rejected the API key. Copy it again from Settings → General.",
          };
        }
        // A fork without `/auth/me`: reachable, key unproven but probably fine.
        return {
          ok: true,
          ...(version !== undefined ? { version } : {}),
          message: `Connected${version ? ` · Overseerr ${version}` : ""} · could not verify the key`,
        };
      }
    },

    async search(query: string, page = 1): Promise<OverseerrSearchResult[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const { json } = await get("/search", { query: trimmed, page, language: "en" });
      if (!isRaw(json)) return [];
      return rawArray(json["results"])
        // `person` hits share the envelope but carry no tmdb media id we can use.
        .filter((r) => str(r, "mediaType", "media_type") !== "person")
        .map((r) => normalizeSearchResult(r, "movie"))
        .filter((r): r is OverseerrSearchResult => r !== undefined);
    },

    async details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails> {
      const path = `/${mediaType}/${tmdbId}`;
      const { json } = await get(path);
      return normalizeDetails(expectObject(json, apiUrl(path)), tmdbId, mediaType);
    },

    async request(
      tmdbId: number,
      mediaType: MediaType,
      seasons?: number[] | "all",
    ): Promise<RequestOutcome> {
      requireConfigured();
      const url = apiUrl("/request");

      const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
      if (mediaType === "tv" && seasons !== undefined) {
        // `"all"` expands server-side with season 0 filtered out (report §1.5).
        body["seasons"] = seasons === "all" ? "all" : [...seasons].filter((s) => s > 0).sort((a, b) => a - b);
      }

      const response = await limiter.run(() =>
        http({
          url,
          method: "POST",
          source: "overseerr",
          headers: headers(),
          json: body,
          // 202/403/409 are answers, not transport failures.
          allowStatuses: [202, 403, 409],
        }),
      );

      const payload = isRaw(response.json) ? response.json : undefined;
      const message = payload ? str(payload, "message", "error") : "";

      if (response.status === 202) {
        return {
          kind: "nothing-to-request",
          message: message || "Nothing left to request — every season is already available or pending.",
        };
      }

      if (response.status === 409) {
        const existing = await findExistingRequest(tmdbId, mediaType);
        return {
          kind: "duplicate",
          ...(existing ? { request: existing } : {}),
          message: message || "This is already requested on Overseerr.",
        };
      }

      if (response.status === 403) {
        return {
          kind: "denied",
          message:
            message ||
            "Overseerr refused the request — the account lacks permission, or a quota is used up.",
        };
      }

      if (!payload || optNum(payload, "id") === undefined) {
        throw new ApiError({
          source: "overseerr",
          reason: "parse",
          status: response.status,
          url,
          detail: "request created but the response carried no MediaRequest",
        });
      }

      return { kind: "created", request: normalizeRequest(payload) };
    },

    async getRequest(requestId: number): Promise<OverseerrRequest | undefined> {
      const { status, json } = await get(`/request/${requestId}`, {}, [404]);
      if (status === 404 || !isRaw(json)) return undefined;
      return normalizeRequest(json);
    },

    async requestCounts() {
      const { json } = await get("/request/count");
      const raw = isRaw(json) ? json : {};
      return {
        pending: num(raw, "pending"),
        approved: num(raw, "approved"),
        processing: num(raw, "processing"),
        available: num(raw, "available"),
        total: num(raw, "total"),
      };
    },
  };
}
