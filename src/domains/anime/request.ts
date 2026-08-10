/**
 * Overseerr requests for anime — **only when a TMDB id is actually known**
 * (SPEC2 D-ANIME).
 *
 * Overseerr requests by TMDB id and nothing else. AniList and MAL ids are from
 * different catalogues, and the same number means a different work in each, so
 * there is no arithmetic that turns one into the other. Guessing — searching
 * TMDB for the romaji title and taking the first hit — is how you request the
 * wrong show, and a wrong request is worse than no button: it downloads
 * something nobody asked for.
 *
 * So the rule is narrow and stated once here: an anime can be requested when a
 * TMDB id is *known*, and the action is hidden otherwise. Two things can supply
 * one, both of them evidence rather than inference:
 *
 *   1. **AniList's own external links.** Entries frequently link out to
 *      themoviedb.org, and a link the catalogue publishes about itself is a
 *      statement of identity, not a guess.
 *   2. **The existing TMDB backfill** (`services/match.ts`), which asks the user
 *      to confirm an ambiguous match and writes `tmdbId` when it is sure. An
 *      anime that has been through it is requestable like anything else.
 *
 * Plex availability is deliberately *not* gated this way. It matches on GUIDs
 * when they exist and on normalised title plus year when they do not
 * (`services/availability.ts`), so an anime in the Plex library is found with no
 * TMDB id at all — which is why the badge works today for the v3 rows that never
 * had one.
 */
import type { MediaType, TitleV4 } from "../../types";

export interface TmdbTarget {
  tmdbId: number;
  mediaType: MediaType;
}

const TMDB_URL = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

/** A TMDB id read out of a URL, or nothing. Never a guess. */
export function tmdbTargetFromUrl(url: string): TmdbTarget | undefined {
  const match = TMDB_URL.exec(url);
  if (!match) return undefined;
  const id = Number(match[2]);
  if (!Number.isFinite(id) || id <= 0) return undefined;
  return { tmdbId: id, mediaType: match[1]?.toLowerCase() === "movie" ? "movie" : "tv" };
}

/** The first TMDB link in an AniList `externalLinks` array. */
export function tmdbTargetFromLinks(
  links: readonly { site: string; url: string }[] | undefined,
): TmdbTarget | undefined {
  for (const link of links ?? []) {
    const target = tmdbTargetFromUrl(link.url);
    if (target) return target;
  }
  return undefined;
}

/**
 * What Overseerr should be asked for, or `undefined` when the answer is
 * "nothing — hide the button".
 *
 * The stored `tmdbMediaType` wins over the episode-count heuristic: an anime
 * film tracked as one episode and a one-episode OVA look identical from here,
 * and only the former is a `movie` request.
 */
export function animeRequestTarget(title: TitleV4): TmdbTarget | undefined {
  if (!title.tmdbId || title.tmdbId <= 0) return undefined;
  const mediaType: MediaType =
    title.tmdbMediaType ?? (title.totalEpisodes > 1 || title.seasons.length > 0 ? "tv" : "movie");
  return { tmdbId: title.tmdbId, mediaType };
}

export function canRequestAnime(title: TitleV4): boolean {
  return animeRequestTarget(title) !== undefined;
}

/** Why the request action is hidden, for the tooltip that replaces it. */
export function animeRequestBlockedReason(title: TitleV4): string | undefined {
  if (canRequestAnime(title)) return undefined;
  return "Overseerr requests need a TMDB id, and this anime has none yet. Match it to TMDB from the title's detail view to enable requests.";
}
