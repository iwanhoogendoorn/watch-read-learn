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
import type { MediaType, OverseerrDetails, OverseerrSearchResult } from "../types";
import { ApiError } from "./http";

/** The slice of a metadata client this module needs. Both clients satisfy it. */
export interface DetailsClient {
  configured(): boolean;
  details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails>;
}

/**
 * One memory of "Overseerr is not answering", shared by search and details.
 *
 * They are used seconds apart — type a word, click a hit — and each keeping a
 * private cooldown meant each paying its own 8-second timeout: the search fell
 * back and answered, then the click hung all over again on details. One
 * breaker, fed by whichever call fails first, honoured by both.
 */
export interface ProviderHealth {
  avoid(): boolean;
  noteFailure(): void;
  noteSuccess(): void;
}

export function createProviderHealth(now: () => number = () => Date.now()): ProviderHealth {
  let failedAt = Number.NEGATIVE_INFINITY;
  return {
    avoid: () => now() - failedAt < SEARCH_FAILURE_COOLDOWN_MS,
    noteFailure: () => {
      failedAt = now();
    },
    noteSuccess: () => {
      failedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

export interface DetailsSourceDeps {
  overseerr: DetailsClient;
  tmdb: DetailsClient;
  /** Shared with the search source, so an outage is paid for once, not per call. */
  health?: ProviderHealth;
  /** The details fallback firing — distinct from the top-up failing. */
  onFallback?: (err: unknown) => void;
}

export type DetailsSource = (tmdbId: number, mediaType: MediaType) => Promise<OverseerrDetails>;

/*
 * There used to be a runtime top-up here: Overseerr strips `runtime` off the
 * episode stubs it proxies, so an Overseerr-primary lookup asked TMDB for that
 * one field afterwards. TMDB-primary made the disease impossible — the TMDB
 * document carries the runtime natively — and the only remaining
 * Overseerr-primary case is a vault with no TMDB token, which has no TMDB to
 * top up from either. The machinery is gone; this note is so the next reader
 * of an old commit knows it was removed on purpose, not lost.
 */

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
  const health = deps.health ?? createProviderHealth();
  return async function details(tmdbId, mediaType) {
    // TMDB primary, for the same reason search is: the document is the same
    // one Overseerr would have proxied, it already carries the runtime (so
    // the top-up below never fires on this branch), and the cloud does not
    // reboot with the homelab. What the TMDB document lacks — `mediaInfo`,
    // the Plex state — is not this call's job: availability comes from the
    // background refreshes, which already tolerate the server being away.
    if (deps.tmdb.configured()) {
      try {
        return await deps.tmdb.details(tmdbId, mediaType);
      } catch (err) {
        if (!(err instanceof ApiError) || !deps.overseerr.configured()) throw err;
        deps.onFallback?.(err);
        // TMDB itself failing is rare; the homelab is now the backup.
        return deps.overseerr.details(tmdbId, mediaType);
      }
    }
    if (!deps.overseerr.configured()) {
      throw new ApiError({ source: "overseerr", reason: "http", url: "", detail: "no provider configured" });
    }

    // Overseerr-only from here: there is no TMDB to top a runtime up from,
    // and nothing to fall back to. The answer, or the honest failure.
    try {
      const primary = await deps.overseerr.details(tmdbId, mediaType);
      health.noteSuccess();
      return primary;
    } catch (err) {
      health.noteFailure();
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Search, with the same spine
// ---------------------------------------------------------------------------

export interface SearchClient {
  configured(): boolean;
  search(query: string): Promise<OverseerrSearchResult[]>;
}

/** TMDB's search is per-type; the façade needs the merged, one-argument shape. */
export interface TypedSearchClient {
  configured(): boolean;
  search(query: string, mediaType: MediaType): Promise<OverseerrSearchResult[]>;
}

export interface SearchSourceDeps {
  overseerr: SearchClient;
  tmdb: TypedSearchClient;
  /** The fallback firing, for the console. The user sees results, not plumbing. */
  onFallback?: (err: unknown) => void;
  /** Injectable clock, so the cooldown is testable without waiting one out. */
  now?: () => number;
  /** Shared with the details source, so an outage is paid for once, not per call. */
  health?: ProviderHealth;
}

/**
 * How long a transport failure keeps search away from Overseerr.
 *
 * Measured before this existed: the first search of an outage waited behind a
 * background poll's 8-second timeout and then its own — sixteen seconds of
 * "Searching…" for one word. The failure is remembered for a minute, so only
 * that first search pays; everything typed after it goes straight to TMDB and
 * answers at TMDB speed. A minute, not longer, because a homelab that just
 * came back should not spend ten more being ignored — and only TRANSPORT
 * failures start it, an auth failure is not going to heal by waiting.
 */
export const SEARCH_FAILURE_COOLDOWN_MS = 60_000;

/**
 * Is this the kind of failure a second provider can do anything about?
 *
 * Transport failures only. "No results" is an ANSWER and comes back as an empty
 * array, never an error, so it can not land here — but an auth failure could,
 * and a wrong API key on Overseerr does not make TMDB's answer for the same
 * words wrong. What must NOT fall through is a plain thrown TypeError from our
 * own code: masking a bug behind a provider switch is how a bug ships twice.
 */
function providerFailed(err: unknown): boolean {
  return err instanceof ApiError;
}

/**
 * The add-box's search: TMDB first, Overseerr only when there is no token.
 *
 * This began the other way round — Overseerr first, with TMDB as a fallback
 * behind a failure breaker — until the day the homelab was unreachable made
 * the real shape of the dependency plain: Overseerr *proxies* TMDB, so putting
 * it first bought search nothing except a seat on a server that can be off.
 * What Overseerr alone knows (Plex state, request status) is not something a
 * search result needs to render; it arrives on the card later, from the
 * background refreshes that already tolerate the server being away. So the
 * interactive path now goes straight to the cloud, and a homelab that is
 * down, rebooting, or on the wrong side of a VPN cannot slow typing into the
 * add box at all. Overseerr remains the whole path for someone who configured
 * only Overseerr — for them the breaker still applies.
 *
 * TMDB has no multi-type search on this client, so it asks for films and
 * shows concurrently and interleaves the pair — alternating rather than
 * concatenating, so two mediocre film matches do not bury the show the reader
 * actually typed.
 */
export function createSearchSource(deps: SearchSourceDeps): SearchClient {
  const viaTmdb = async (query: string): Promise<OverseerrSearchResult[]> => {
    const [movies, shows] = await Promise.all([
      deps.tmdb.search(query, "movie"),
      deps.tmdb.search(query, "tv"),
    ]);
    const merged: OverseerrSearchResult[] = [];
    for (let i = 0; i < Math.max(movies.length, shows.length); i += 1) {
      const movie = movies[i];
      if (movie) merged.push(movie);
      const show = shows[i];
      if (show) merged.push(show);
    }
    return merged;
  };

  const health = deps.health ?? createProviderHealth(deps.now ?? (() => Date.now()));

  return {
    configured: () => deps.overseerr.configured() || deps.tmdb.configured(),
    async search(query: string): Promise<OverseerrSearchResult[]> {
      if (deps.tmdb.configured()) return viaTmdb(query);
      if (!deps.overseerr.configured()) return [];
      try {
        const answer = await deps.overseerr.search(query);
        health.noteSuccess();
        return answer;
      } catch (err) {
        if (!providerFailed(err)) throw err;
        health.noteFailure();
        throw err;
      }
    },
  };
}
