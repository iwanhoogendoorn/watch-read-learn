/**
 * The anime add-flow: search two catalogues, land one `TitleV4` (SPEC2 D-ANIME).
 *
 * AniList and Jikan describe the same works with different field names, a
 * different status vocabulary and a different rating scale. Rather than teach
 * the modal both, everything is normalised into one `AnimeEntry` at the
 * boundary — which is also what makes the fallback invisible: a search that
 * silently came from Jikan because MyAnimeList's scraper was the only one
 * answering produces exactly the same rows.
 *
 * The provider preference decides who is asked *first*; the other is the
 * fallback, always, in both directions (`report-watchlog.md` §3). When both
 * fail, the primary's failure is the one reported — it is the one the user's
 * setting points at.
 */
import { recomputeOffsets } from "../../data/episodes";
import { createTitle, uniqueId } from "../../data/schema";
import { STATUS_PLAN_TO_WATCH } from "../../constants";
import type { AniListClientEx, AniListMediaFull, AniListSearchResultFull } from "../../services/anilist";
import type { JikanAnimeFull, JikanClientEx } from "../../services/jikan";
import { mediaTypeForFormat, type RoutingSettings } from "../../services/typeroute";
import type {
  AniListStatus,
  AniListTitle,
  DateString,
  JikanAnime,
  MediaType,
  Season,
  TitleV4,
} from "../../types";
import { AnimeApiError, type AnimeProvider } from "./errors";
import { showStatusForAniList } from "./airing";
import { tmdbTargetFromLinks } from "./request";

/** AniList caps a page at 50; v3 showed 27 anime results. 25 is the house size. */
export const ANIME_SEARCH_LIMIT = 25;

/**
 * One anime, whichever catalogue answered.
 *
 * The AniList vocabulary is the canonical one here (it is the richer of the two
 * and the primary provider), so Jikan's three statuses are mapped onto it rather
 * than the other way round.
 */
export interface AnimeEntry {
  provider: AnimeProvider;
  anilistId?: number;
  malId?: number;
  /** The display title: English when the catalogue has one, else romaji. */
  title: string;
  titles: AniListTitle;
  /** `TV | TV_SHORT | MOVIE | OVA | ONA | SPECIAL | MUSIC`, upper-cased. */
  format: string;
  mediaType: MediaType;
  status: AniListStatus;
  /** The `AiringCache.showStatus` spelling of `status`. */
  showStatus: string;
  episodes?: number;
  /** Minutes per episode. */
  duration?: number;
  seasonYear?: number;
  /** `winter | spring | summer | fall`, when the catalogue says. */
  season?: string;
  startDate: DateString | null;
  endDate: DateString | null;
  coverUrl: string;
  description: string;
  genres: string[];
  studios: string[];
  /** 0–10, converted from whatever scale the provider uses. `0` means unrated. */
  score: number;
  trailerUrl: string;
  /** Only set when the catalogue itself linked to TMDB. */
  tmdb?: { tmdbId: number; mediaType: MediaType };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** English if there is one, romaji otherwise, native as the last resort. */
export function preferredAnimeTitle(titles: AniListTitle): string {
  return titles.english || titles.romaji || titles.native;
}

/** Jikan's enum → AniList's, so one vocabulary reaches the UI. */
export function statusFromJikan(status: string): AniListStatus {
  const normalized = status.trim().toLowerCase();
  if (normalized === "currently airing") return "RELEASING";
  if (normalized === "finished airing") return "FINISHED";
  return "NOT_YET_RELEASED";
}

function entryBase(format: string): { format: string; mediaType: MediaType } {
  const upper = format.toUpperCase();
  return { format: upper, mediaType: mediaTypeForFormat(upper) };
}

export function entryFromAniList(media: AniListMediaFull): AnimeEntry {
  const entry: AnimeEntry = {
    provider: "anilist",
    anilistId: media.id,
    title: preferredAnimeTitle(media.title),
    titles: media.title,
    ...entryBase(media.format),
    status: media.status,
    showStatus: showStatusForAniList(media.status),
    startDate: media.startDate ?? null,
    endDate: media.endDate ?? null,
    coverUrl: media.coverUrl,
    description: media.description,
    genres: media.genres,
    studios: media.studios,
    // AniList scores 0–100; `communityRating` is 0–10 everywhere in this plugin.
    score: media.averageScore !== undefined ? Math.round(media.averageScore) / 10 : 0,
    trailerUrl: media.trailerUrl,
  };
  if (media.malId !== undefined) entry.malId = media.malId;
  if (media.episodes !== undefined) entry.episodes = media.episodes;
  if (media.duration !== undefined) entry.duration = media.duration;
  if (media.seasonYear !== undefined) entry.seasonYear = media.seasonYear;
  if (media.season !== undefined) entry.season = media.season.toLowerCase();

  const tmdb = tmdbTargetFromLinks(media.externalLinks);
  if (tmdb) entry.tmdb = tmdb;
  return entry;
}

export function entryFromAniListSearch(hit: AniListSearchResultFull): AnimeEntry {
  const entry: AnimeEntry = {
    provider: "anilist",
    anilistId: hit.id,
    title: preferredAnimeTitle(hit.title),
    titles: hit.title,
    ...entryBase(hit.format),
    status: hit.status,
    showStatus: showStatusForAniList(hit.status),
    startDate: hit.startDate ?? null,
    endDate: null,
    coverUrl: hit.coverUrl,
    description: hit.description,
    genres: hit.genres,
    studios: [],
    score: hit.averageScore !== undefined ? Math.round(hit.averageScore) / 10 : 0,
    trailerUrl: "",
  };
  if (hit.malId !== undefined) entry.malId = hit.malId;
  if (hit.episodes !== undefined) entry.episodes = hit.episodes;
  if (hit.duration !== undefined) entry.duration = hit.duration;
  if (hit.seasonYear !== undefined) entry.seasonYear = hit.seasonYear;
  return entry;
}

export function entryFromJikan(anime: JikanAnimeFull): AnimeEntry {
  const status = statusFromJikan(anime.status);
  const english = anime.titles.find((t) => t.type.toLowerCase() === "english")?.title ?? "";
  const romaji = anime.titles.find((t) => t.type.toLowerCase() === "default")?.title ?? anime.title;
  const native = anime.titles.find((t) => t.type.toLowerCase() === "japanese")?.title ?? "";

  const entry: AnimeEntry = {
    provider: "jikan",
    malId: anime.malId,
    title: anime.title,
    titles: { romaji, english, native },
    ...entryBase(anime.type),
    status,
    showStatus: showStatusForAniList(status),
    startDate: anime.airedFrom,
    endDate: anime.airedTo,
    coverUrl: anime.imageUrl,
    description: anime.synopsis,
    genres: anime.genres,
    studios: anime.studios,
    // Jikan already scores 0–10, and reports "unknown" as 0 — which is what a
    // `communityRating` of 0 means here too, so it carries across unchanged.
    score: anime.score,
    trailerUrl: anime.trailerUrl,
  };
  if (anime.episodes !== undefined) entry.episodes = anime.episodes;
  if (anime.durationMinutes !== undefined) entry.duration = anime.durationMinutes;
  if (anime.year) entry.seasonYear = anime.year;
  if (anime.season) entry.season = anime.season;
  return entry;
}

// ---------------------------------------------------------------------------
// Entry → title
// ---------------------------------------------------------------------------

export interface BuildAnimeTitleOptions {
  type: string;
  status?: string;
  takenIds: Iterable<string>;
  now?: Date;
}

/**
 * `AnimeEntry` → a complete `TitleV4`.
 *
 * The shape rules are the video add-flow's, applied to a per-cour catalogue: a
 * film is one episode with no seasons; an entry with episodes is **one** season
 * (never a guess at how many cours the franchise has); an entry whose episode
 * count upstream is still unknown — normal for a show three weeks into its run —
 * gets a season with zero episodes, which the airing refresh fills in later
 * without overwriting anything the user typed.
 */
export function buildTitleFromAnime(entry: AnimeEntry, options: BuildAnimeTitleOptions): TitleV4 {
  const now = options.now ?? new Date();
  const isMovie = entry.mediaType === "movie";
  const episodes = entry.episodes ?? 0;

  const seasons: Season[] = [];
  if (!isMovie) {
    seasons.push({
      name: "Season 1",
      episodes: Math.max(0, episodes),
      offset: 0,
      skippedEpisodes: [],
      seasonNumber: 1,
      airDate: entry.startDate,
    });
    recomputeOffsets(seasons);
  }

  const airing: TitleV4["airing"] = {
    showStatus: entry.showStatus,
    inProduction: entry.status === "RELEASING" || entry.status === "HIATUS",
    checkedAt: now.toISOString(),
  };
  if (episodes > 0) airing.episodeCount = episodes;

  const year =
    entry.seasonYear ??
    (entry.startDate ? Number.parseInt(entry.startDate.slice(0, 4), 10) || undefined : undefined);

  return createTitle({
    id: uniqueId(entry.title, options.takenIds),
    title: entry.title,
    type: options.type,
    status: options.status ?? STATUS_PLAN_TO_WATCH,
    ...(entry.anilistId !== undefined ? { anilistId: entry.anilistId } : {}),
    ...(entry.malId !== undefined ? { malId: entry.malId } : {}),
    ...(entry.tmdb ? { tmdbId: entry.tmdb.tmdbId, tmdbMediaType: entry.tmdb.mediaType } : {}),
    overview: entry.description,
    genres: entry.genres,
    ...(year !== undefined ? { year } : {}),
    releaseDate: entry.startDate,
    posterUrl: entry.coverUrl,
    trailerUrl: entry.trailerUrl,
    studio: entry.studios,
    communityRating: entry.score,
    communitySource: entry.provider,
    communityRatingLastFetched: now.toISOString(),
    totalEpisodes: isMovie ? 1 : Math.max(1, episodes),
    episodeDuration: Math.max(0, Math.round(entry.duration ?? 0)),
    seasons,
    airing,
  });
}

/** Already tracked? Catalogue id first — titles differ between romaji and English. */
export function findExistingAnime(
  titles: readonly TitleV4[],
  entry: AnimeEntry,
): TitleV4 | undefined {
  const byId = titles.find(
    (title) =>
      (entry.anilistId !== undefined && title.anilistId === entry.anilistId) ||
      (entry.malId !== undefined && (title.malId ?? 0) > 0 && title.malId === entry.malId),
  );
  if (byId) return byId;

  const wanted = [entry.title, entry.titles.english, entry.titles.romaji]
    .filter((name) => name !== "")
    .map((name) => name.toLowerCase());
  return titles.find((title) => wanted.includes(title.title.toLowerCase()));
}

// ---------------------------------------------------------------------------
// The search service
// ---------------------------------------------------------------------------

export interface AnimeSearchDeps {
  anilist: AniListClientEx;
  jikan?: JikanClientEx;
  settings: () => RoutingSettings;
}

export interface AnimeSearchOutcome {
  entries: AnimeEntry[];
  /** Who actually answered. */
  provider: AnimeProvider;
  /** Set when the preferred provider failed and the other one answered. */
  fellBackFrom?: { provider: AnimeProvider; message: string };
}

export function createAnimeSearchService(deps: AnimeSearchDeps) {
  function order(): AnimeProvider[] {
    return deps.settings().animeApiSource === "jikan" ? ["jikan", "anilist"] : ["anilist", "jikan"];
  }

  function available(provider: AnimeProvider): boolean {
    return provider === "anilist"
      ? deps.anilist.configured()
      : deps.jikan?.configured() === true;
  }

  async function searchWith(provider: AnimeProvider, query: string, limit: number): Promise<AnimeEntry[]> {
    if (provider === "anilist") {
      const hits = await deps.anilist.searchFull(query, limit);
      return hits.map(entryFromAniListSearch);
    }
    const hits = await (deps.jikan as JikanClientEx).search(query, limit);
    return hits.map((hit) => entryFromJikan(hit));
  }

  /**
   * Search the preferred catalogue, fall back to the other one.
   *
   * "Failed" includes an empty result set only when the primary threw — an
   * honest zero-result search is an answer, and retrying it elsewhere would turn
   * a typo into two rate-limited requests.
   */
  async function search(query: string, limit = ANIME_SEARCH_LIMIT): Promise<AnimeSearchOutcome> {
    const trimmed = query.trim();
    if (trimmed === "") return { entries: [], provider: order()[0] as AnimeProvider };

    const providers = order().filter(available);
    if (providers.length === 0) {
      throw new AnimeApiError({
        provider: order()[0] as AnimeProvider,
        reason: "not-enabled",
        detail: "no anime provider is available",
      });
    }

    let primaryError: unknown;
    for (const [index, provider] of providers.entries()) {
      try {
        const entries = await searchWith(provider, trimmed, limit);
        if (index === 0) return { entries, provider };
        return {
          entries,
          provider,
          fellBackFrom: {
            provider: providers[0] as AnimeProvider,
            message: primaryError instanceof Error ? primaryError.message : String(primaryError),
          },
        };
      } catch (err) {
        if (index === 0) primaryError = err;
      }
    }
    throw primaryError instanceof Error
      ? primaryError
      : new AnimeApiError({ provider: providers[0] as AnimeProvider, reason: "http" });
  }

  /**
   * The full record for a chosen result.
   *
   * A search hit is deliberately thin (AniList's list query does not carry
   * studios or the trailer), so picking one costs exactly one more request. When
   * a Jikan hit carries a MAL id and AniList is the primary, this does *not*
   * cross-look-up: the id belongs to MAL's catalogue and matching it against
   * AniList's would be the id-in-the-wrong-catalogue bug the routing exists to
   * prevent.
   */
  async function details(entry: AnimeEntry): Promise<AnimeEntry> {
    if (entry.provider === "anilist" && entry.anilistId !== undefined) {
      const media = await deps.anilist.detailsFull(entry.anilistId);
      return entryFromAniList(media);
    }
    if (entry.provider === "jikan" && entry.malId !== undefined && deps.jikan?.configured()) {
      const anime = await deps.jikan.full(entry.malId);
      return entryFromJikan(anime);
    }
    return entry;
  }

  return { search, details };
}

export type AnimeSearchService = ReturnType<typeof createAnimeSearchService>;
