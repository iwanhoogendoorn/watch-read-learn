/**
 * A film or a show, as the HTTP API shows it.
 *
 * The stored `TitleV4` is a working record — poster caches, credit lists, Plex
 * and Overseerr state, season geometry — and most of that is either derived or
 * only meaningful inside the plugin. This is the stable, documented subset an
 * outside caller can rely on, so the stored shape stays free to change.
 */
import {
  getEffectiveTotal,
  getNextUnwatchedEpisode,
  sanitizeWatchedEpisodes,
  seasonEpisodes,
  toSeasonEpisode,
} from "../../data/episodes";
import { isSingleSitting } from "../../data/review";
import type { Season, TitleV4 } from "../../types";

export type TitleKind = "film" | "show";

/** One sitting is a film; everything else — anime included — is a show. */
export function kindOf(title: TitleV4): TitleKind {
  return isSingleSitting(title) ? "film" : "show";
}

/**
 * The number a person calls a season by.
 *
 * TMDB's number when the season has one, otherwise its position counted from
 * one — which is what a hand-entered "Season 2" means. The API addresses
 * seasons by this, never by array index, because that is what Plex, TMDB and a
 * human all say.
 */
export function seasonNumberOf(season: Season, index: number): number {
  return season.seasonNumber ?? index + 1;
}

export interface ShowProgressJson {
  totalEpisodes: number;
  /** Episodes that count: the total less the skipped ones. */
  effectiveTotal: number;
  watchedEpisodes: number;
  /** The first episode neither watched nor skipped, or `null` when done. */
  nextEpisode: { absolute: number; season: number | null; episode: number | null } | null;
  seasons: {
    index: number;
    name: string;
    seasonNumber: number;
    episodes: number;
    watched: number;
  }[];
}

export function progressJson(title: TitleV4): ShowProgressJson {
  const watched = new Set(sanitizeWatchedEpisodes(title));
  const next = getNextUnwatchedEpisode(title);
  const at = next === null ? null : toSeasonEpisode(title, next);
  return {
    totalEpisodes: title.totalEpisodes,
    effectiveTotal: getEffectiveTotal(title),
    watchedEpisodes: watched.size,
    nextEpisode:
      next === null
        ? null
        : {
            absolute: next,
            season: at ? seasonNumberOf(at.season, at.seasonIndex) : null,
            episode: at ? at.episode : null,
          },
    seasons: title.seasons.map((season, index) => ({
      index,
      name: season.name,
      seasonNumber: seasonNumberOf(season, index),
      episodes: season.episodes,
      watched: seasonEpisodes(title, index).filter((ep) => watched.has(ep)).length,
    })),
  };
}

export function titleJson(title: TitleV4): Record<string, unknown> {
  const kind = kindOf(title);
  return {
    id: title.id,
    kind,
    title: title.title,
    type: title.type,
    status: title.status,
    rating: title.rating,
    review: title.review,
    watchedVia: title.watchedVia,
    favorite: title.favorite,
    tags: title.tags,
    notes: title.notes,
    dates: {
      started: title.dateStarted,
      finished: title.dateFinished,
      released: title.releaseDate,
      added: title.dateAdded,
      modified: title.dateModified,
    },
    year: title.year ?? null,
    ids: {
      tmdb: title.tmdbId ?? null,
      tmdbMediaType: title.tmdbMediaType ?? null,
      imdb: title.imdbId || null,
      tvdb: title.tvdbId ?? null,
      // `0` is v3's "unused", not an id.
      mal: title.malId || null,
      anilist: title.anilistId || null,
      plexRatingKey: title.plex?.ratingKey ?? null,
    },
    ...(kind === "show" ? { progress: progressJson(title) } : {}),
  };
}
