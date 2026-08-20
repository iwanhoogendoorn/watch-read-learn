/**
 * Episode and time maths — the single source of truth for progress, "next up"
 * and every time statistic in the plugin.
 *
 * Pure functions, no obsidian imports. `data/store.ts` re-exports them so callers
 * can reach them from one place; tests import this module directly.
 *
 * Three v3 bugs are fixed here (`docs/research/report-watchlog.md` §5):
 *
 *   1. `getNextUnwatchedEpisode` never consulted `isEpisodeSkipped`, so widgets
 *      offered "Next up: Ep 5" for an episode the user had explicitly skipped —
 *      while the denominator had already excluded it.
 *   2. Nothing stopped `watchedEpisodes` from containing skipped episodes, so
 *      `watched / effectiveTotal` could exceed 1 and was merely clamped at 100%.
 *      `sanitizeWatchedEpisodes` makes that state unrepresentable.
 *   3. `calcTimeRemaining` and `calcTimeRemainingForModal` disagreed about
 *      Dropped titles. There is now exactly one formula, used everywhere.
 */
import { NO_TIME_REMAINING_STATUSES, STATUS_COMPLETED, STATUS_TO_BE_RELEASED } from "../constants";
import type { Season, TitleV4 } from "../types";

/** Episode counts are absolute; a season contributes `offset+1 .. offset+episodes`. */
export function seasonRange(season: Season): { first: number; last: number } {
  return { first: season.offset + 1, last: season.offset + season.episodes };
}

/**
 * Every skipped episode as an **absolute** number.
 *
 * `Season.skippedEpisodes` is season-relative (`1..episodes`); out-of-range
 * entries are ignored rather than trusted, because v3's free-text season editor
 * could produce them.
 */
export function skippedAbsolute(title: TitleV4): Set<number> {
  const out = new Set<number>();
  for (const season of title.seasons) {
    for (const rel of season.skippedEpisodes) {
      if (!Number.isFinite(rel)) continue;
      if (rel < 1 || rel > season.episodes) continue;
      out.add(season.offset + rel);
    }
  }
  return out;
}

export function isEpisodeSkipped(title: TitleV4, absoluteEpisode: number): boolean {
  return skippedAbsolute(title).has(absoluteEpisode);
}

export function getTotalSkippedCount(title: TitleV4): number {
  return skippedAbsolute(title).size;
}

/** Episodes that actually count towards completion. */
export function getEffectiveTotal(title: TitleV4): number {
  return Math.max(0, title.totalEpisodes - getTotalSkippedCount(title));
}

// ---------------------------------------------------------------------------
// Season geometry — keeping absolute numbers meaning the same episode
// ---------------------------------------------------------------------------

/**
 * The season shape a title's `watchedEpisodes` numbers are expressed in.
 *
 * `watchedEpisodes` stores **absolute** numbers, so "11" only means S02E01 for
 * as long as Season 1 has ten episodes. Resize or remove an earlier season and
 * every stored number silently starts referring to a different episode — the
 * v3 bug that made a season edit quietly rewrite watch history.
 */
export interface SeasonGeometry {
  seasonNumber: number;
  offset: number;
  episodes: number;
}

export function seasonGeometry(seasons: readonly Season[]): SeasonGeometry[] {
  return seasons.map((season, index) => ({
    seasonNumber: season.seasonNumber ?? index + 1,
    offset: season.offset,
    episodes: season.episodes,
  }));
}

function sameGeometry(a: readonly SeasonGeometry[], b: readonly SeasonGeometry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      other.seasonNumber === entry.seasonNumber &&
      other.offset === entry.offset &&
      other.episodes === entry.episodes
    );
  });
}

/**
 * The geometry each live title's watched numbers were last written against.
 *
 * A `WeakMap` rather than a stored field: `data.json` always holds seasons and
 * `watchedEpisodes` written in the same pass, so the on-disk pair is coherent by
 * construction and only *in-session* geometry edits need a "before" to rebase
 * from. Nothing to migrate, nothing to round-trip, nothing that can go stale
 * across a reload.
 */
const geometryByTitle = new WeakMap<TitleV4, SeasonGeometry[]>();

/**
 * Record the current seasons as the basis for this title's watched numbers.
 *
 * Called after creating a title and after every write that puts `seasons` and
 * `watchedEpisodes` back in agreement.
 */
export function rememberSeasonGeometry(title: TitleV4): void {
  geometryByTitle.set(title, seasonGeometry(title.seasons));
}

/**
 * Translate stored absolute numbers through a season-geometry change.
 *
 * Each number is resolved to a stable `{seasonNumber, relativeEpisode}` identity
 * using the *old* geometry, then re-expressed under the current seasons. An
 * identity whose season disappeared, or whose episode is past the season's new
 * end, is the only thing dropped — everything else keeps meaning the episode the
 * user actually watched.
 */
export function rebaseWatchedEpisodes(title: TitleV4): number[] {
  const before = geometryByTitle.get(title);
  const after = seasonGeometry(title.seasons);
  if (!before || before.length === 0 || after.length === 0) return title.watchedEpisodes;
  if (sameGeometry(before, after)) return title.watchedEpisodes;

  const bySeasonNumber = new Map<number, SeasonGeometry>();
  for (const season of after) {
    if (!bySeasonNumber.has(season.seasonNumber)) bySeasonNumber.set(season.seasonNumber, season);
  }

  const out: number[] = [];
  for (const absolute of title.watchedEpisodes) {
    const old = before.find((s) => absolute > s.offset && absolute <= s.offset + s.episodes);
    if (!old) {
      // Outside every known season, so there is no identity to preserve; leave
      // it alone and let the sanitiser decide whether it still fits.
      out.push(absolute);
      continue;
    }
    const relative = absolute - old.offset;
    const current = bySeasonNumber.get(old.seasonNumber);
    if (!current) continue; // that season was removed
    if (relative > current.episodes) continue; // that episode was removed
    out.push(current.offset + relative);
  }
  return out;
}

/**
 * Normalised watched list: rebased through any season-geometry change, then
 * sorted ascending, deduped, clamped to `1..totalEpisodes`, and with every
 * skipped episode removed (bug fix 2).
 *
 * Migration and every mutation run through this, so `title.watchedEpisodes` is
 * always already normalised — but it is cheap and idempotent, so read paths call
 * it too rather than assuming. It never mutates the title: the rebase is a view
 * until a writer stores the result and calls `rememberSeasonGeometry`.
 */
export function sanitizeWatchedEpisodes(title: TitleV4): number[] {
  const skipped = skippedAbsolute(title);
  const seen = new Set<number>();
  for (const raw of rebaseWatchedEpisodes(title)) {
    const ep = Math.trunc(Number(raw));
    if (!Number.isFinite(ep)) continue;
    if (ep < 1 || ep > title.totalEpisodes) continue;
    if (skipped.has(ep)) continue;
    seen.add(ep);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Watched episodes that count — skipped ones never do. */
export function getWatchedCount(title: TitleV4): number {
  return sanitizeWatchedEpisodes(title).length;
}

/** 0–100, integer. `0` when there is nothing to watch. */
export function getProgress(title: TitleV4): number {
  const total = getEffectiveTotal(title);
  if (total <= 0) return 0;
  return Math.min(100, Math.round((getWatchedCount(title) / total) * 100));
}

export function isFullyWatched(title: TitleV4): boolean {
  const total = getEffectiveTotal(title);
  return total > 0 && getWatchedCount(title) >= total;
}

/**
 * The lowest absolute episode that is neither watched nor skipped, or `null`
 * when nothing is left (bug fix 1).
 */
export function getNextUnwatchedEpisode(title: TitleV4): number | null {
  const watched = new Set(sanitizeWatchedEpisodes(title));
  const skipped = skippedAbsolute(title);
  for (let ep = 1; ep <= title.totalEpisodes; ep += 1) {
    if (skipped.has(ep)) continue;
    if (watched.has(ep)) continue;
    return ep;
  }
  return null;
}

/** Absolute episode number → `{season, episode}` season-relative pair. */
export function toSeasonEpisode(
  title: TitleV4,
  absoluteEpisode: number,
): { seasonIndex: number; season: Season; episode: number } | null {
  for (let i = 0; i < title.seasons.length; i += 1) {
    const season = title.seasons[i];
    if (!season) continue;
    const { first, last } = seasonRange(season);
    if (absoluteEpisode >= first && absoluteEpisode <= last) {
      return { seasonIndex: i, season, episode: absoluteEpisode - season.offset };
    }
  }
  return null;
}

/** Non-skipped absolute episode numbers belonging to one season. */
export function seasonEpisodes(title: TitleV4, seasonIndex: number): number[] {
  const season = title.seasons[seasonIndex];
  if (!season) return [];
  const skipped = skippedAbsolute(title);
  const out: number[] = [];
  const { first, last } = seasonRange(season);
  for (let ep = first; ep <= Math.min(last, title.totalEpisodes); ep += 1) {
    if (!skipped.has(ep)) out.push(ep);
  }
  return out;
}

/**
 * Recompute every season's `offset` from the season order. Call after any edit
 * to a season's episode count — v3 let offsets drift, silently reassigning which
 * episodes the stored absolute numbers referred to.
 */
export function recomputeOffsets(seasons: Season[]): void {
  let offset = 0;
  for (const season of seasons) {
    season.offset = offset;
    offset += Math.max(0, season.episodes);
  }
}

/** Sum of season episode counts, the authority for `totalEpisodes` when seasons exist. */
export function totalFromSeasons(seasons: Season[]): number {
  return seasons.reduce((sum, s) => sum + Math.max(0, s.episodes), 0);
}

/**
 * The seasons a title would have with one more season in it (SPEC §4.4).
 *
 * Inserted in season-number order and with offsets recomputed, which is exactly
 * the geometry change `sanitizeWatchedEpisodes` rebases through — so adding
 * "Season 4" to a show whose Season 3 you are halfway through cannot renumber
 * what you have already watched. Returns the existing seasons unchanged when
 * that season number is already there.
 */
export function withAddedSeason(
  seasons: readonly Season[],
  seasonNumber: number,
  episodes: number,
  airDate?: string | null,
): Season[] {
  const next = seasons.map((season) => ({ ...season }));
  if (next.some((season, index) => (season.seasonNumber ?? index + 1) === seasonNumber)) {
    return next;
  }
  const added: Season = {
    name: `Season ${seasonNumber}`,
    episodes: Math.max(0, Math.trunc(episodes)),
    offset: 0,
    skippedEpisodes: [],
    seasonNumber,
    airDate: airDate ?? null,
  };
  const at = next.findIndex((season, index) => (season.seasonNumber ?? index + 1) > seasonNumber);
  if (at < 0) next.push(added);
  else next.splice(at, 0, added);
  recomputeOffsets(next);
  return next;
}

/**
 * How many episodes are believed to **exist**, for availability maths.
 *
 * Deliberately not `getEffectiveTotal`: a skipped episode is a statement about
 * what the user intends to watch, not about what the season contains. Letting
 * skips shrink this number is what made an incomplete Plex library report
 * itself complete — the denominator has to be the real world, not the plan.
 *
 * Upstream's count wins when we have one, because a show can be fully
 * downloaded while the tracker is still a season behind.
 */
export function expectedEpisodes(title: TitleV4): number {
  const upstream = title.airing?.episodeCount ?? 0;
  if (upstream > 0) return upstream;
  const fromSeasons = totalFromSeasons(title.seasons);
  if (fromSeasons > 0) return fromSeasons;
  return Math.max(0, title.totalEpisodes);
}

// ---------------------------------------------------------------------------
// Time maths — one formula each, used everywhere
// ---------------------------------------------------------------------------

/**
 * Minutes watched.
 *
 * A `Watched` title counts its full effective total, so marking something
 * complete without ticking every box still contributes its runtime. Titles that
 * have not been released, and titles with no known duration, contribute zero.
 */
export function calcTimeWatched(title: TitleV4): number {
  if (title.episodeDuration <= 0) return 0;
  if (title.status === STATUS_TO_BE_RELEASED) return 0;
  const count =
    title.status === STATUS_COMPLETED ? getEffectiveTotal(title) : getWatchedCount(title);
  return count * title.episodeDuration;
}

/**
 * Minutes left to watch. **The only time-remaining formula in the plugin.**
 *
 * Zero for every status in `NO_TIME_REMAINING_STATUSES` (Watched, Dropped,
 * To be released) — the detail modal uses this same function, unlike v3.
 */
export function calcTimeRemaining(title: TitleV4): number {
  if (title.episodeDuration <= 0) return 0;
  if (NO_TIME_REMAINING_STATUSES.includes(title.status)) return 0;
  const left = getEffectiveTotal(title) - getWatchedCount(title);
  return Math.max(0, left) * title.episodeDuration;
}

/** Episodes left to watch, skipped ones excluded. */
export function episodesRemaining(title: TitleV4): number {
  return Math.max(0, getEffectiveTotal(title) - getWatchedCount(title));
}

/** `1h 45m` / `45m` / `3d 4h` for large totals. `0m` when zero. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "0m";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 && days === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}
