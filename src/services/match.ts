/**
 * Provider matching — giving a title the TMDB id everything else keys off
 * (SPEC §4.1 "backfill on first use"; QA2 report 1).
 *
 * v3 identified titles through OMDb, so every migrated row arrives with
 * `tmdbId: undefined`. Both engines that talk upstream need one:
 * `shouldTrackAiring` refuses a title without it and the Plex GUID index has
 * nothing to look the title up by. The result was a library that looked tracked
 * and was, silently, not: the vault's *Dexter: Resurrection* had `tmdbId: null`
 * and `airing: null` — no next episode, no announced Season 2, no row in
 * Upcoming, and no error anywhere saying so.
 *
 * So: search Overseerr for the name, and only accept an answer we are actually
 * sure about.
 *
 * **The bar is deliberately high.** Writing the wrong `tmdbId` is worse than
 * writing none — it silently re-points a title at another show, and every later
 * refresh happily confirms the wrong answer. Anything short of confident is
 * reported as `ambiguous`, which surfaces a "needs match" affordance and lets a
 * human pick. Nothing is ever skipped in silence again.
 *
 * Everything above `createMatchService` is pure and unit-tested.
 */
import { TYPE_MOVIE } from "../constants";
import { mediaTypeForTitle } from "./airing";
import { normalizeTitle } from "./availability";
import type {
  IsoTimestamp,
  MediaType,
  OverseerrClient,
  OverseerrDetails,
  OverseerrSearchResult,
  TitleV4,
  TitlePatch,
} from "../types";

/** Release years disagree by a year across providers often enough. */
export const YEAR_TOLERANCE = 1;

/** How many candidates a "needs match" state carries for the picker's shortlist. */
export const MAX_AMBIGUOUS_CANDIDATES = 5;

export type MatchOutcome =
  /** One candidate we are prepared to write. */
  | { kind: "match"; hit: OverseerrSearchResult }
  /** Several plausible ones, or one we are not sure enough about. */
  | { kind: "ambiguous"; candidates: OverseerrSearchResult[] }
  /** The provider had nothing that could be this title. */
  | { kind: "none" };

/** Does this title need an id at all? */
export function needsTmdbBackfill(title: TitleV4): boolean {
  return !title.tmdbId;
}

/** The year to compare against: the explicit one, else the release date's. */
export function yearOfTitle(title: TitleV4): number | undefined {
  if (title.year && Number.isFinite(title.year)) return title.year;
  if (title.releaseDate) {
    const year = Number.parseInt(title.releaseDate.slice(0, 4), 10);
    if (Number.isFinite(year)) return year;
  }
  return undefined;
}

/** `undefined` on either side means "cannot say", which is not a mismatch. */
export function yearsAgree(a: number | undefined, b: number | null | undefined): boolean {
  if (a === undefined || b === undefined || b === null) return true;
  return Math.abs(a - b) <= YEAR_TOLERANCE;
}

/**
 * How confident this hit is, higher is better. `-1` disqualifies it.
 *
 * Only two things count: the name has to be the same name, and the years must
 * not contradict each other. Popularity is deliberately *not* a tiebreaker —
 * "the more famous one" is how a niche show gets re-pointed at a remake.
 */
export function scoreHit(title: TitleV4, hit: OverseerrSearchResult, wanted: MediaType): number {
  if (hit.mediaType !== wanted) return -1;
  if (!yearsAgree(yearOfTitle(title), hit.year)) return -1;

  const local = normalizeTitle(title.title);
  const remote = normalizeTitle(hit.title);
  if (local === "" || remote === "") return -1;

  const sameYear = yearOfTitle(title) !== undefined && yearOfTitle(title) === hit.year;
  if (local === remote) return sameYear ? 100 : 90;
  // A tracker row is often the short form of the upstream name ("Dexter" for
  // "Dexter: Original Sin"), so containment is a candidate — never a verdict.
  if (remote.startsWith(`${local} `) || local.startsWith(`${remote} `)) return sameYear ? 60 : 50;
  if (remote.includes(local) || local.includes(remote)) return sameYear ? 40 : 30;
  return -1;
}

/**
 * Pick a match, or refuse to.
 *
 * A verdict needs a *clear* winner: the best score must be an exact-name match
 * (>= 90) and no other candidate may share that score. Two shows called the
 * same thing with no year to separate them is exactly the case a human has to
 * settle, and the picker exists for it.
 */
export function pickMatch(title: TitleV4, hits: readonly OverseerrSearchResult[]): MatchOutcome {
  const wanted = mediaTypeForTitle(title);
  const scored = hits
    .map((hit) => ({ hit, score: scoreHit(title, hit, wanted) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.hit.tmdbId - b.hit.tmdbId);

  if (scored.length === 0) return { kind: "none" };

  const best = scored[0] as { hit: OverseerrSearchResult; score: number };
  const contested = scored.filter((entry) => entry.score === best.score).length > 1;
  if (best.score >= 90 && !contested) return { kind: "match", hit: best.hit };

  return {
    kind: "ambiguous",
    candidates: scored.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((entry) => entry.hit),
  };
}

/** The `tmdbMatch` state to persist for an outcome that is not a match. */
export function matchStateFor(
  outcome: Exclude<MatchOutcome, { kind: "match" }>,
  query: string,
  at: IsoTimestamp,
): NonNullable<TitleV4["tmdbMatch"]> {
  return {
    state: outcome.kind === "ambiguous" ? "ambiguous" : "unmatched",
    checkedAt: at,
    query,
    ...(outcome.kind === "ambiguous"
      ? {
          candidates: outcome.candidates.map((hit) => ({
            tmdbId: hit.tmdbId,
            mediaType: hit.mediaType,
            title: hit.title,
            ...(hit.year !== null ? { year: hit.year } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Has this title been searched for recently enough to leave alone?
 *
 * A library of 200 migrated rows must not re-search every unmatched one on every
 * catch-up. One attempt a day is plenty — new entries do appear upstream, but
 * not hourly.
 */
export const MATCH_RETRY_HOURS = 24;

export function needsMatchAttempt(
  title: TitleV4,
  now: Date = new Date(),
  retryHours: number = MATCH_RETRY_HOURS,
): boolean {
  if (!needsTmdbBackfill(title)) return false;
  const checkedAt = title.tmdbMatch?.checkedAt;
  if (!checkedAt) return true;
  const age = now.getTime() - new Date(checkedAt).getTime();
  if (!Number.isFinite(age)) return true;
  return age >= Math.max(0, retryHours) * 3600_000;
}

// ---------------------------------------------------------------------------
// Media type vs display type (QA3 fix 4)
// ---------------------------------------------------------------------------

/**
 * The media kind a display-type name implies.
 *
 * `Movie` is the one type name v3 and v4 both treat as semantic; every other
 * configured name (Anime, TV Show, Korean TV Show, …) is episodic.
 */
export function typeFamilyOf(typeName: string): MediaType {
  return typeName === TYPE_MOVIE ? "movie" : "tv";
}

/**
 * Does this payload describe the title we think it does?
 *
 * The reason this exists: **TMDB ids are only unique within a namespace.** Id
 * 557 is Spider-Man (2002) as a movie *and* an unrelated show as TV, so a 200
 * from `/tv/557` proves nothing at all. Comparing the name (and the year, when
 * both sides have one) is what actually tells the two apart.
 */
export function identityMatches(title: TitleV4, details: OverseerrDetails): boolean {
  const local = normalizeTitle(title.title);
  const remote = normalizeTitle(details.title);
  if (local === "" || remote === "") return false;
  if (local !== remote && !remote.includes(local) && !local.includes(remote)) return false;

  const remoteYear = details.releaseDate
    ? Number.parseInt(details.releaseDate.slice(0, 4), 10)
    : undefined;
  return yearsAgree(yearOfTitle(title), Number.isFinite(remoteYear) ? remoteYear : undefined);
}

/**
 * The patch that makes a title's *display* type agree with its media type.
 *
 * The vault's pre-B2 chimera: title "Spider-Man", type "TV Show", tmdbId 557 —
 * the 2002 film's id. Nothing routes off the display type any more, but a film
 * labelled "TV Show" is still wrong on every card, sorts into the wrong facet,
 * and would send a request as a series if any future caller trusted the label.
 *
 * A film's shape is one entry with no seasons — the same shape
 * `buildTitleFromDetails` gives every film added since QA1 B2, and the shape the
 * detail modal keys its "Mark as watched" affordance off. A repaired film gets
 * that shape rather than a synthetic one-episode "Movie" season, which would
 * re-break B2 by putting a one-cell episode grid on a film.
 */
export function typeRepairFor(
  title: TitleV4,
  types: readonly { name: string }[],
): { patch: TitlePatch; from: string; to: string } | undefined {
  const media = title.tmdbMediaType;
  if (!media) return undefined;
  if (typeFamilyOf(title.type) === media) return undefined;

  const names = types.map((t) => t.name);
  if (media === "movie") {
    const to = names.includes(TYPE_MOVIE) ? TYPE_MOVIE : (names[0] ?? TYPE_MOVIE);
    if (to === title.type) return undefined;
    const patch: TitlePatch = { type: to, seasons: [], totalEpisodes: 1 };
    // One episode, so anything watched collapses to "watched".
    if (title.watchedEpisodes.length > 0) patch.watchedEpisodes = [1];
    return { patch, from: title.type, to };
  }

  const to = names.find((name) => name !== TYPE_MOVIE) ?? names[0];
  if (to === undefined || to === title.type) return undefined;
  // Seasons are left alone: the auto-sync pass fills a show's seasons in from
  // upstream, and inventing them here would fight it.
  return { patch: { type: to }, from: title.type, to };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface MatchDeps {
  overseerr: OverseerrClient;
  now?: () => Date;
  /** Hours before an unmatched title is searched for again. */
  getRetryHours?: () => number;
}

export interface MatchResult {
  titleId: string;
  outcome: MatchOutcome;
  /** Set when the search itself failed — the previous state must be kept. */
  error?: string;
}

export function createMatchService(deps: MatchDeps) {
  const now = deps.now ?? ((): Date => new Date());

  /**
   * The query: the name, plus the year when we have one.
   *
   * Overseerr passes the string to TMDB's own search, which understands a
   * trailing year and uses it to rank — so this is a hint, not a filter, and a
   * title whose stored year is wrong still surfaces.
   */
  function queryFor(title: TitleV4): string {
    const year = yearOfTitle(title);
    return year === undefined ? title.title.trim() : `${title.title.trim()} ${year}`;
  }

  async function matchTitle(title: TitleV4): Promise<MatchResult> {
    const query = queryFor(title);
    try {
      let hits = await deps.overseerr.search(query);
      // A year-qualified query that finds nothing is worth one retry without it:
      // a migrated row's year can be the *watch* year rather than the release one.
      if (hits.length === 0 && query !== title.title.trim()) {
        hits = await deps.overseerr.search(title.title.trim());
      }
      return { titleId: title.id, outcome: pickMatch(title, hits) };
    } catch (err) {
      return {
        titleId: title.id,
        outcome: { kind: "none" },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Every title that is due an attempt, one search at a time. */
  async function matchAll(
    titles: readonly TitleV4[],
    options: { force?: boolean } = {},
  ): Promise<MatchResult[]> {
    const at = now();
    const retry = deps.getRetryHours?.() ?? MATCH_RETRY_HOURS;
    const due = titles.filter((title) =>
      options.force ? needsTmdbBackfill(title) : needsMatchAttempt(title, at, retry),
    );
    const out: MatchResult[] = [];
    // Sequential on purpose: this runs behind the user's back on load, and the
    // Overseerr search endpoint proxies to TMDB. Politeness beats speed.
    for (const title of due) out.push(await matchTitle(title));
    return out;
  }

  return { matchTitle, matchAll, queryFor };
}

export type MatchService = ReturnType<typeof createMatchService>;
