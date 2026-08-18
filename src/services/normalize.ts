/**
 * Shared response normalisation for the TMDB-shaped providers.
 *
 * Overseerr proxies TMDB and camelCases the payload on the way through
 * (`posterPath`, `firstAirDate`, `voteAverage`), while a direct TMDB v3 call
 * answers in snake_case (`poster_path`, `first_air_date`, `vote_average`). The
 * *meaning* is identical, so every reader here accepts both spellings and the
 * two clients share one set of normalisers. Jellyseerr's extra fields fall out
 * of the picture for free.
 *
 * Nothing in this file throws on a missing field. A metadata provider dropping a
 * key is normal; the sentinel policy (SPEC §3.1) says the result is `""` / `[]`
 * / `null`, never the string "none".
 */
import { TMDB_BACKDROP_SIZE, TMDB_IMAGE_BASE, TMDB_POSTER_SIZE } from "../constants";
import {
  type DateString,
  type MediaType,
  type OverseerrEpisodeStub,
  type OverseerrMediaInfo,
  type OverseerrSearchResult,
  type OverseerrSeasonStatus,
  type OverseerrSeasonSummary,
  type TmdbVideo,
} from "../types";

/** An untyped JSON object. Everything from the wire starts life as one. */
export type Raw = Record<string, unknown>;

export function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects out of an unknown array value; anything else is dropped. */
export function rawArray(value: unknown): Raw[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRaw);
}

/** First key that holds anything at all. Lets one reader serve both spellings. */
function firstDefined(obj: Raw, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function str(obj: Raw, ...keys: string[]): string {
  const value = firstDefined(obj, keys);
  return typeof value === "string" ? value : "";
}

export function optNum(obj: Raw, ...keys: string[]): number | undefined {
  const value = firstDefined(obj, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Plex sends numbers as strings in places (`score`), and so does Jellyseerr.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function num(obj: Raw, ...keys: string[]): number {
  return optNum(obj, ...keys) ?? 0;
}

export function bool(obj: Raw, ...keys: string[]): boolean {
  const value = firstDefined(obj, keys);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value === "true" || value === "1";
  return false;
}

/**
 * `YYYY-MM-DD`, or `null`.
 *
 * TMDB is inconsistent on purpose: `air_date` is a bare date, but
 * `release_dates[].release_date` is a full ISO timestamp whose time component is
 * always `00:00:00.000Z` and meaningless (report §3.6). Both collapse to a date.
 * Empty strings — TMDB's way of saying "unknown" — become `null`.
 */
export function dateOnly(value: unknown): DateString | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  return match?.[1] ?? null;
}

export function dateField(obj: Raw, ...keys: string[]): DateString | null {
  return dateOnly(firstDefined(obj, keys));
}

export function yearOf(date: DateString | null): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

/** Full CDN URL for a `*_path`, or `""`. The CDN needs no key. */
export function imageUrl(path: unknown, size: string): string {
  if (typeof path !== "string" || path.trim() === "") return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${TMDB_IMAGE_BASE}/${size}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function posterUrl(obj: Raw): string {
  return imageUrl(firstDefined(obj, ["posterPath", "poster_path"]), TMDB_POSTER_SIZE);
}

export function backdropUrl(obj: Raw): string {
  return imageUrl(firstDefined(obj, ["backdropPath", "backdrop_path"]), TMDB_BACKDROP_SIZE);
}

/** `movie` unless the payload says otherwise; `person` never reaches here. */
export function mediaTypeOf(obj: Raw, fallback: MediaType): MediaType {
  const value = str(obj, "mediaType", "media_type");
  return value === "tv" || value === "movie" ? value : fallback;
}

/**
 * Movies carry `title`/`releaseDate`, TV carries `name`/`firstAirDate`
 * (report §1.2). Read both rather than branching at every call site.
 */
export function displayTitle(obj: Raw): string {
  return str(obj, "title", "name", "originalTitle", "original_title", "originalName", "original_name");
}

export function primaryDate(obj: Raw): DateString | null {
  return dateField(obj, "releaseDate", "release_date", "firstAirDate", "first_air_date");
}

// ---------------------------------------------------------------------------
// Media info (Overseerr only — TMDB has no concept of it)
// ---------------------------------------------------------------------------

function normalizeSeasonStatus(raw: Raw): OverseerrSeasonStatus {
  return {
    id: num(raw, "id"),
    seasonNumber: num(raw, "seasonNumber", "season_number"),
    status: num(raw, "status"),
    status4k: num(raw, "status4k"),
  };
}

/**
 * `mediaInfo` normalisation.
 *
 * **Absent stays absent.** Overseerr omits the object entirely for a title it
 * has never tracked, and that is a different state from `UNKNOWN` — it means
 * "not requested, not in Plex" rather than "tracked, status unclear". Defaulting
 * one to the other is the mistake the research doc calls out (§1.2).
 */
export function normalizeMediaInfo(value: unknown): OverseerrMediaInfo | undefined {
  if (!isRaw(value)) return undefined;
  const info: OverseerrMediaInfo = {
    id: num(value, "id"),
    mediaType: mediaTypeOf(value, "movie"),
    tmdbId: num(value, "tmdbId", "tmdb_id"),
    status: num(value, "status"),
    status4k: num(value, "status4k"),
  };

  const tvdbId = optNum(value, "tvdbId", "tvdb_id");
  if (tvdbId !== undefined) info.tvdbId = tvdbId;
  const imdbId = str(value, "imdbId", "imdb_id");
  if (imdbId) info.imdbId = imdbId;

  // `ratingKey` is the free Plex identifier (report §1.3) — null until Plex sync
  // has run, so only take it when it is a real string.
  const ratingKey = str(value, "ratingKey", "rating_key");
  if (ratingKey) info.ratingKey = ratingKey;
  const plexUrl = str(value, "plexUrl");
  if (plexUrl) info.plexUrl = plexUrl;
  const iosPlexUrl = str(value, "iOSPlexUrl");
  if (iosPlexUrl) info.iOSPlexUrl = iosPlexUrl;

  const seasons = rawArray(value["seasons"]);
  if (seasons.length > 0) info.seasons = seasons.map(normalizeSeasonStatus);

  const mediaAddedAt = str(value, "mediaAddedAt");
  if (mediaAddedAt) info.mediaAddedAt = mediaAddedAt;
  const updatedAt = str(value, "updatedAt");
  if (updatedAt) info.updatedAt = updatedAt;

  const downloads = rawArray(value["downloadStatus"]);
  if (downloads.length > 0) {
    info.downloadStatus = downloads.map((d) => {
      const entry: NonNullable<OverseerrMediaInfo["downloadStatus"]>[number] = {};
      const size = optNum(d, "size");
      if (size !== undefined) entry.size = size;
      const sizeLeft = optNum(d, "sizeLeft", "sizeleft");
      if (sizeLeft !== undefined) entry.sizeLeft = sizeLeft;
      const eta = str(d, "estimatedCompletionTime");
      if (eta) entry.estimatedCompletionTime = eta;
      const status = str(d, "status");
      if (status) entry.status = status;
      const dtitle = str(d, "title");
      if (dtitle) entry.title = dtitle;
      return entry;
    });
  }

  return info;
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

/**
 * One `/search` or `/search/{movie,tv}` hit.
 *
 * `id` is the TMDB id — the join key across the whole plugin (report §1.2).
 */
export function normalizeSearchResult(
  raw: Raw,
  fallbackType: MediaType,
): OverseerrSearchResult | undefined {
  const tmdbId = optNum(raw, "id", "tmdbId");
  if (tmdbId === undefined || tmdbId <= 0) return undefined;

  const releaseDate = primaryDate(raw);
  const result: OverseerrSearchResult = {
    tmdbId,
    mediaType: mediaTypeOf(raw, fallbackType),
    title: displayTitle(raw),
    year: yearOf(releaseDate),
    releaseDate,
    overview: str(raw, "overview"),
    posterUrl: posterUrl(raw),
    voteAverage: num(raw, "voteAverage", "vote_average"),
    voteCount: num(raw, "voteCount", "vote_count"),
    genreIds: genreIdsOf(raw),
  };

  const mediaInfo = normalizeMediaInfo(raw["mediaInfo"]);
  if (mediaInfo) result.mediaInfo = mediaInfo;
  return result;
}

function genreIdsOf(raw: Raw): number[] {
  const direct = firstDefined(raw, ["genreIds", "genre_ids"]);
  if (Array.isArray(direct)) {
    return direct.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  }
  // Details payloads carry objects instead of bare ids.
  return rawArray(raw["genres"])
    .map((g) => optNum(g, "id"))
    .filter((v): v is number => v !== undefined);
}

// ---------------------------------------------------------------------------
// Details fragments
// ---------------------------------------------------------------------------

export function genreNames(raw: Raw): string[] {
  return dedupe(
    rawArray(raw["genres"])
      .map((g) => str(g, "name"))
      .filter((n) => n !== ""),
  );
}

/** Crew members credited as Director, in credit order, deduped. */
export function directorNames(credits: Raw | undefined): string[] {
  if (!credits) return [];
  return dedupe(
    rawArray(credits["crew"])
      .filter((c) => str(c, "job") === "Director")
      .map((c) => str(c, "name"))
      .filter((n) => n !== ""),
  );
}

/** Billed cast, capped — `data.json` should not carry 90 names per title. */
export function castNames(credits: Raw | undefined, limit = 20): string[] {
  if (!credits) return [];
  return dedupe(
    rawArray(credits["cast"])
      .map((c) => str(c, "name"))
      .filter((n) => n !== ""),
  ).slice(0, limit);
}

/**
 * Studios for a film, networks for a show.
 *
 * TMDB sends *both* `production_companies` and `networks` on a TV payload, so a
 * single first-present lookup across the two never reached `networks`: every
 * show reported its production company and no show ever reported the network
 * it airs on. The two are not spellings of one field — on a show the network is
 * the answer to "where does this air", which is what this field is asked for —
 * so the key order depends on the media type rather than on which key TMDB
 * happens to send first. The other list stays as a fallback, because a payload
 * missing the preferred key should still say something rather than nothing.
 */
export function studioNames(raw: Raw, mediaType?: MediaType): string[] {
  const companies = firstDefined(
    raw,
    mediaType === "tv"
      ? ["networks", "productionCompanies", "production_companies"]
      : ["productionCompanies", "production_companies", "networks"],
  );
  return dedupe(
    rawArray(companies)
      .map((c) => str(c, "name"))
      .filter((n) => n !== ""),
  );
}

/**
 * Minutes per episode for TV: the **modal** value of `episodeRunTime`.
 *
 * TMDB reports a list because a show can mix formats; the most common entry is
 * the one that makes "time remaining" honest for a binge-watcher.
 */
export function episodeRuntime(raw: Raw): number {
  const list = firstDefined(raw, ["episodeRunTime", "episode_run_time"]);
  const values = Array.isArray(list)
    ? list.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    : [];
  if (values.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

export function normalizeEpisodeStub(value: unknown): OverseerrEpisodeStub | null {
  if (!isRaw(value)) return null;
  const stub: OverseerrEpisodeStub = {
    seasonNumber: num(value, "seasonNumber", "season_number"),
    episodeNumber: num(value, "episodeNumber", "episode_number"),
    airDate: dateField(value, "airDate", "air_date"),
  };
  const name = str(value, "name");
  if (name) stub.name = name;
  return stub;
}

/** Season summaries with **specials (season 0) dropped**, matching Overseerr. */
export function normalizeSeasons(value: unknown): OverseerrSeasonSummary[] {
  return rawArray(value)
    .map((s) => ({
      seasonNumber: num(s, "seasonNumber", "season_number"),
      name: str(s, "name"),
      episodeCount: num(s, "episodeCount", "episode_count"),
      airDate: dateField(s, "airDate", "air_date"),
    }))
    .filter((s) => s.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

export function normalizeVideos(value: unknown): TmdbVideo[] {
  return rawArray(value)
    .map((v) => {
      const video: TmdbVideo = {
        key: str(v, "key"),
        site: str(v, "site"),
        type: str(v, "type"),
        official: bool(v, "official"),
        size: num(v, "size"),
      };
      const publishedAt = str(v, "publishedAt", "published_at");
      if (publishedAt) video.publishedAt = publishedAt;
      return video;
    })
    .filter((v) => v.key !== "");
}

/**
 * Best trailer, per report §3.7: YouTube only, official Trailers first, then
 * unofficial Trailers, then Teasers; ties broken by resolution and recency.
 *
 * Anything that is not a Trailer or a Teaser (Clip, Featurette, Bloopers) is
 * rejected outright — a "Behind the Scenes" reel is not what ▶ promises.
 */
export function selectTrailer(videos: TmdbVideo[]): TmdbVideo | undefined {
  const rank = (video: TmdbVideo): number => {
    const type = video.type.toLowerCase();
    if (type === "trailer") return video.official ? 0 : 1;
    if (type === "teaser") return video.official ? 2 : 3;
    return 99;
  };

  const candidates = videos
    .filter((v) => v.site.toLowerCase() === "youtube" && rank(v) < 99)
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (b.size !== a.size) return b.size - a.size;
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    });

  return candidates[0];
}

export function youtubeWatchUrl(key: string): string {
  return `https://www.youtube.com/watch?v=${key}`;
}

/** `""` when nothing suitable exists — never a sentinel string. */
export function trailerUrlFrom(videos: TmdbVideo[]): string {
  const best = selectTrailer(videos);
  return best ? youtubeWatchUrl(best.key) : "";
}

/**
 * Overseerr exposes trailers as `relatedVideos`, already flattened and carrying
 * a ready-made `url`. The shape is close enough to TMDB's `/videos` to reuse the
 * same selector.
 */
export function trailerFromRelatedVideos(value: unknown): string {
  const raws = rawArray(value);
  const videos = normalizeVideos(raws);
  const best = selectTrailer(videos);
  if (!best) return "";
  const match = raws.find((r) => str(r, "key") === best.key);
  const url = match ? str(match, "url") : "";
  return url || youtubeWatchUrl(best.key);
}

// ---------------------------------------------------------------------------

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
