/**
 * Tracker import — the normalised intermediate every source parses into.
 *
 * `data/csv.ts` already imports a *spreadsheet*: a header row guessed through a
 * synonym table, one cell per field. That is the right shape for a file someone
 * edited by hand, and the wrong one for a tracker export, which is neither
 * one-file nor one-row-per-thing: Trakt ships a zip of six JSON files where the
 * ratings live apart from the watch history, Ryot ships one nested JSON with no
 * title in it at all, and Simkl ships a CSV that carries a TMDB id.
 *
 * So a source parser's job is not "map columns", it is **turn a whole export
 * into `ImportRecord[]`** — one record per work, with everything the export knew
 * about it already merged and already converted. Nothing downstream of this file
 * knows which tracker the data came from, except to print its name.
 *
 * Two conversions happen here rather than later, because they are the two things
 * every source gets differently and every consumer would otherwise get wrong:
 *
 *   1. **Ratings are converted to this plugin's 0–5** (`convertRating`). IMDb and
 *      Trakt are out of 10, Letterboxd is already out of 5 in half-stars, Ryot's
 *      scale is a user setting. A record's `rating` is always 0–5, and `ratingRaw`
 *      keeps what the file said so the preview can show the sum.
 *   2. **Status is a five-value enum**, not a settings status name. Which
 *      `settings.statuses[]` entry that becomes is the *library's* decision, made
 *      in `plan.ts` against the user's configured names.
 */
import type { DateString, MediaType } from "../../types";

export type TrackerSource = "trakt" | "letterboxd" | "simkl" | "imdb" | "ryot";

export const TRACKER_SOURCES: readonly TrackerSource[] = [
  "trakt",
  "letterboxd",
  "simkl",
  "imdb",
  "ryot",
];

export const TRACKER_LABELS: Record<TrackerSource, string> = {
  trakt: "Trakt",
  letterboxd: "Letterboxd",
  simkl: "Simkl",
  imdb: "IMDb",
  ryot: "Ryot",
};

/**
 * What every tracker agrees a thing can be, reduced to its intersection.
 *
 * Deliberately *not* the user's status names: those are configurable, and a
 * parser that wrote "Plan to watch" would be guessing at a vocabulary it cannot
 * see. `plan.ts` resolves these against `settings.statuses`.
 */
export type ImportStatus = "watching" | "completed" | "planned" | "dropped" | "on-hold";

/** One watched episode as the export stated it — season and episode, both 1-based. */
export interface ImportEpisode {
  season: number;
  episode: number;
}

/** One work, with everything the whole export knew about it already merged in. */
export interface ImportRecord {
  source: TrackerSource;
  title: string;
  /** Release year. Absent when the export did not say — Letterboxd often does not. */
  year?: number;
  /** Absent when the export does not distinguish; the library then guesses from its own types. */
  mediaType?: MediaType;
  status?: ImportStatus;

  /** 0–5, already converted from whatever scale the file used. Absent = unrated. */
  rating?: number;
  /** What the file actually said, and out of what. Shown in the preview, never stored. */
  ratingRaw?: { value: number; scale: number };

  dateStarted?: DateString;
  dateFinished?: DateString;

  // --- external ids: the difference between an exact match and a guess -------
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  /** Trakt's own id. Nothing here queries it; it rides along for the note/link. */
  traktId?: number;

  /** Per-episode watch data, when the export carries any. */
  episodes?: ImportEpisode[];
  /**
   * `episodes` is a **high-water mark**, not a list.
   *
   * Simkl exports "the last episode watched" and means everything up to it;
   * Trakt exports every watch event and means exactly those. Storing which kind
   * this is here, rather than expanding at parse time, is what lets the plan
   * step expand it against the *real* season lengths — which only it can see.
   */
  progressIsHighWaterMark?: boolean;
  /**
   * Episodes the *source* says exist, when it states a count (Trakt's
   * `aired_episodes`, Simkl's last-watched hint). A floor for the denominator,
   * never a contradiction of `episodes`.
   */
  airedEpisodes?: number;

  /** Minutes per episode (or the film's length). IMDb's `Runtime (mins)`. */
  runtimeMinutes?: number;

  notes?: string;
  externalLink?: string;
}

/** What a source parser returns: the records, plus anything it could not use. */
export interface ParsedExport {
  source: TrackerSource;
  records: ImportRecord[];
  /** Human sentences about what was skipped or looked wrong. Always shown. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Rating scales
// ---------------------------------------------------------------------------

/** Out of how much each source's rating is, when it is a fixed scale. */
export const RATING_SCALES: Record<Exclude<TrackerSource, "ryot">, number> = {
  trakt: 10,
  letterboxd: 5,
  simkl: 10,
  imdb: 10,
};

/**
 * Convert a rating on to this plugin's 0–5, to the nearest half star.
 *
 * Half stars rather than whole ones because `settings.halfStarRatings` exists
 * and because Letterboxd's scale *is* half stars — rounding 3.5 to 4 on the way
 * in would silently inflate a whole library by up to half a star, and there is
 * no way to tell afterwards that it happened.
 *
 * A non-finite or non-positive input is "unrated", which is `undefined` and not
 * `0`: `TitleV4.rating` uses `0` for unrated already, but a record that says
 * "the file gave no rating" must not be confused with one that says "the user
 * rated this zero", because only the first may be filled in by a later import.
 */
export function convertRating(raw: number, scale: number): number | undefined {
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const stars = (raw / scale) * 5;
  const halves = Math.round(stars * 2) / 2;
  return Math.max(0, Math.min(5, halves));
}

/**
 * Ryot's scale is a user preference (out of 5, 10 or 100), and the export does
 * not state which. The value itself is the only evidence there is.
 */
export function inferRyotScale(raw: number): number {
  if (raw > 10) return 100;
  if (raw > 5) return 10;
  return 5;
}
