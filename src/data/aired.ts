/**
 * Has this episode actually happened yet?
 *
 * Until now every cell in the episode grid was clickable, which means the grid
 * would happily record that you watched next month's episode this afternoon —
 * and then count it towards progress, towards "time watched", and towards
 * auto-completing the show. That is not a cosmetic gap; it is the tracker
 * agreeing to a fact that is false.
 *
 * **This is deliberately conservative.** It answers `"unaired"` only when it can
 * point at a *future date we actually hold*, and `"unknown"` the rest of the
 * time — and `"unknown"` stays clickable, so nothing that works today stops
 * working. The failure mode of guessing the other way is far worse: a stale
 * `airing` cache would start refusing clicks on episodes that aired weeks ago,
 * with no way round it.
 *
 * The evidence available is thin, because `Season` carries no per-episode
 * records at all (`types.ts` §Season) — only `airing.nextEpisode`,
 * `airing.lastEpisode` and `season.airDate`. All three are enough for the case
 * that matters: a season that is *currently airing*, where the back half
 * genuinely has not happened. Per-episode air dates and names would make this
 * exact, and need a `types.ts` change that is not mine to make; see the report
 * accompanying this work.
 *
 * **This module lives in `data/`, not `ui/`, because the guard is not a UI
 * decision.** Dimming a grid cell only protects the grid; the card's quick
 * "mark next episode" action, the command palette, the `obsidian://watchlog`
 * URI handler, the code-block widgets and CSV import all reach `store.ts`
 * directly. The store is the one place none of them can go round, so the store
 * is where the refusal lives — and the store must never import from `ui/`.
 */
import { toSeasonEpisode } from "./episodes";
import type { TitleV4 } from "../types";

export type AirState =
  /** Upstream has aired it, or nothing suggests otherwise. */
  | "aired"
  /** Upstream names a future date for it. Not markable. */
  | "unaired"
  /** No air information at all. Treated as markable — no regression. */
  | "unknown";

/** `YYYY-MM-DD` for a Date, in local time — the form every stored date uses. */
function isoDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The `YYYY-MM-DD` head of a stored date or ISO timestamp, if it has one. */
function day(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}/.exec(value.trim())?.[0];
}

/** Is this stored `YYYY-MM-DD` strictly after today? Unparseable → no. */
function isFuture(date: string | null | undefined, now: Date): boolean {
  const parsed = day(date);
  return parsed !== undefined && parsed > isoDay(now);
}

/** `(season, episode)` ordering, so "at or after S03E04" is one comparison. */
function atOrAfter(
  season: number,
  episode: number,
  markSeason: number,
  markEpisode: number,
): boolean {
  if (season !== markSeason) return season > markSeason;
  return episode >= markEpisode;
}

/** The same ordering, strictly: "later than S03E04". */
function after(season: number, episode: number, markSeason: number, markEpisode: number): boolean {
  if (season !== markSeason) return season > markSeason;
  return episode > markEpisode;
}

/**
 * The one episode immediately following `(markSeason, markEpisode)`.
 *
 * Treating a season boundary as a successor is deliberately generous: being
 * wrong here only ever leaves an episode *markable*, which is the safe
 * direction.
 */
function isSuccessorOf(
  season: number,
  episode: number,
  markSeason: number,
  markEpisode: number,
): boolean {
  if (season === markSeason && episode === markEpisode + 1) return true;
  return season === markSeason + 1 && episode === 1;
}

/**
 * The air state of one season-relative episode.
 *
 * Three pieces of evidence, in order of how specific they are:
 *
 *   1. `airing.nextEpisode` — upstream naming the next episode *and its date*.
 *      Everything from that episode onward is unaired, provided the date is
 *      genuinely in the future. If the date has passed the cache is simply
 *      behind, and we say nothing rather than blocking a legitimate click.
 *   2. `season.airDate` — a season that has not premiered yet has no episode
 *      in it that has aired.
 *   3. `airing.lastEpisode` — upstream's newest *aired* episode, so everything
 *      after it had not aired **as of the moment the cache was written**. That
 *      caveat is the whole difficulty: unlike a future `airDate`, this claim
 *      goes stale silently, and a week-old cache would start refusing episodes
 *      that have since aired. So it counts only when `airing.checkedAt` is from
 *      today, and even then the immediately-following episode stays markable —
 *      it may have aired later today, after the check ran. What is left is the
 *      case the other two miss: a show between seasons, or one whose next date
 *      upstream has not announced yet, where S04E07 is still obviously unaired.
 */
export function episodeAirState(
  title: TitleV4,
  seasonNumber: number,
  relativeEpisode: number,
  now: Date = new Date(),
): AirState {
  const next = title.airing?.nextEpisode;
  if (next && isFuture(next.airDate, now)) {
    return atOrAfter(seasonNumber, relativeEpisode, next.season, next.episode)
      ? "unaired"
      : "aired";
  }

  const season = title.seasons.find(
    (entry, index) => (entry.seasonNumber ?? index + 1) === seasonNumber,
  );
  if (season && isFuture(season.airDate, now)) return "unaired";

  const last = title.airing?.lastEpisode;
  if (last && day(title.airing?.checkedAt) === isoDay(now)) {
    if (
      after(seasonNumber, relativeEpisode, last.season, last.episode) &&
      !isSuccessorOf(seasonNumber, relativeEpisode, last.season, last.episode)
    ) {
      return "unaired";
    }
  }

  return next || last ? "aired" : "unknown";
}

/** Convenience: everything except a confident `"unaired"` may be ticked. */
export function isEpisodeMarkable(
  title: TitleV4,
  seasonNumber: number,
  relativeEpisode: number,
  now: Date = new Date(),
): boolean {
  return episodeAirState(title, seasonNumber, relativeEpisode, now) !== "unaired";
}

// ---------------------------------------------------------------------------
// Absolute episode numbers — the form the store stores and every writer uses
// ---------------------------------------------------------------------------

/**
 * The air state of an **absolute** episode number.
 *
 * `watchedEpisodes` is absolute; the evidence above is season-relative. The
 * translation is `episodes.ts`'s, not a second copy of the geometry maths.
 * An episode that falls outside every known season has no season to ask about,
 * so it is `"unknown"` — markable, as before.
 */
export function absoluteEpisodeAirState(
  title: TitleV4,
  absoluteEpisode: number,
  now: Date = new Date(),
): AirState {
  const at = toSeasonEpisode(title, absoluteEpisode);
  if (!at) return "unknown";
  return episodeAirState(title, at.season.seasonNumber ?? at.seasonIndex + 1, at.episode, now);
}

export function isAbsoluteEpisodeMarkable(
  title: TitleV4,
  absoluteEpisode: number,
  now: Date = new Date(),
): boolean {
  return absoluteEpisodeAirState(title, absoluteEpisode, now) !== "unaired";
}

/**
 * The subset of `episodes` that may be ticked — the ceiling for any bulk mark.
 *
 * A part-aired season marked "watched" in full is a false statement the progress
 * maths then believes, so bulk writers cap themselves here rather than trusting
 * the count of episodes the season will *eventually* have.
 */
export function airedEpisodesAmong(
  title: TitleV4,
  episodes: readonly number[],
  now: Date = new Date(),
): number[] {
  return episodes.filter((episode) => isAbsoluteEpisodeMarkable(title, episode, now));
}
