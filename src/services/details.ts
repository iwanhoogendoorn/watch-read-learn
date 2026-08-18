/**
 * "Details for one title", composed — and the one field that has to be repaired
 * on the way through.
 *
 * Overseerr is the preferred metadata source (SPEC D4) and stays that way. It
 * proxies TMDB *and* merges in what TMDB cannot know: `mediaInfo`, the Plex
 * `ratingKey` and `plexUrl`, per-season availability, and — measured against the
 * live server — a better cast list for a show, because Overseerr answers with
 * the series regulars where a raw `/tv/{id}?append_to_response=credits` answers
 * with whichever guests appeared in the most recent season.
 *
 * It drops exactly one thing we need. Overseerr's episode stub is TMDB's minus
 * `runtime`:
 *
 *     TMDB      last_episode_to_air: air_date, episode_number, episode_type, id,
 *                                    name, overview, production_code, runtime,
 *                                    season_number, show_id, still_path,
 *                                    vote_average, vote_count
 *     Overseerr lastEpisodeToAir:    airDate, episodeNumber, id, name, overview,
 *                                    productionCode, seasonNumber, showId,
 *                                    stillPath, voteAverage, voteCount
 *
 * The string `"runtime"` does not occur anywhere in a 106 KB Overseerr TV
 * payload. So for the many modern series that ship `episode_run_time: []`, the
 * fallback in `normalize.ts` has nothing to read and every time statistic on
 * those titles reads zero — which is what happened to Reacher, The Agency, The
 * Day of the Jackal and Last Seen in the real library.
 *
 * The repair is deliberately the smallest one that works: **one** extra request,
 * to TMDB, for **one** field, and only when the answer would otherwise be a
 * missing number. It is not a change of primary source — swapping the whole
 * metadata path to TMDB would trade a runtime for the Plex state and the cast,
 * which is a bad trade.
 */
import type { MediaType, OverseerrDetails } from "../types";

/** The slice of a metadata client this module needs. Both clients satisfy it. */
export interface DetailsClient {
  configured(): boolean;
  details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails>;
}

export interface DetailsSourceDeps {
  overseerr: DetailsClient;
  tmdb: DetailsClient;
  /**
   * A failed top-up, for logging. Never surfaced to the user: the title still
   * refreshed, it just kept the runtime it already had.
   */
  onTopUpFailed?: (err: unknown) => void;
}

export type DetailsSource = (tmdbId: number, mediaType: MediaType) => Promise<OverseerrDetails>;

/**
 * Would this answer benefit from the top-up?
 *
 * Three conditions, all of them narrowing:
 *
 *   - **TV only.** A film's `runtime` is a top-level field that Overseerr passes
 *     through untouched, so there is nothing wrong with it to fix.
 *   - **Zero only.** A number the primary provider actually had always wins. A
 *     second opinion must never overwrite good data — `episode_run_time` is a
 *     list of real episodes and beats any single-episode fallback.
 *   - Not "falsy": explicitly `<= 0`, so a `NaN` from a malformed payload is
 *     topped up rather than stored.
 */
export function needsRuntimeTopUp(details: OverseerrDetails, mediaType: MediaType): boolean {
  return mediaType === "tv" && !(details.runtime > 0);
}

/**
 * The composed lookup: Overseerr first, TMDB as the fallback, plus the top-up.
 *
 * The top-up cannot recurse and cannot loop: it fires only on the branch where
 * Overseerr answered, and it makes exactly one call to a different client. When
 * TMDB is the *primary* (no Overseerr configured) the payload already carries
 * the runtime, so there is nothing to top up and no second request is made —
 * asking TMDB twice for the same document would only get the same answer.
 *
 * Both clients own a rate limiter and go through `services/http.ts`, so the
 * extra call is paced like every other TMDB request. The `await` is the other
 * half of that: the top-up completes inside the caller's slot, so the sweep's
 * one-per-second stagger still governs the pair rather than the sweep racing
 * ahead and firing a second, unpaced request per title.
 *
 * A failed top-up is swallowed. The primary answer is complete apart from one
 * field, and losing a whole title's refresh because an optional enrichment 404'd
 * would be a much worse trade than a runtime that stays 0 for another week.
 */
export function createDetailsSource(deps: DetailsSourceDeps): DetailsSource {
  return async function details(tmdbId, mediaType) {
    if (!deps.overseerr.configured()) return deps.tmdb.details(tmdbId, mediaType);

    const primary = await deps.overseerr.details(tmdbId, mediaType);
    if (!needsRuntimeTopUp(primary, mediaType)) return primary;
    if (!deps.tmdb.configured()) return primary;

    try {
      const direct = await deps.tmdb.details(tmdbId, mediaType);
      // Spread, never rebuilt: the top-up owns one field and must not quietly
      // drop `mediaInfo`, the seasons or anything else Overseerr alone knows.
      if (direct.runtime > 0) return { ...primary, runtime: direct.runtime };
    } catch (err) {
      deps.onTopUpFailed?.(err);
    }
    return primary;
  };
}
