/**
 * Games maths — playtime, achievements, progress, completion.
 *
 * One formula each, exported, pure, obsidian-free. Every surface that shows a
 * number about games (the cards, the tab's info bar, the dashboard's Time Played
 * card, the `stat: time-played` widget) reads it from here, because the v3
 * failure this whole rebuild keeps re-learning is two implementations of one
 * number drifting apart (`report-watchlog.md` §5).
 *
 * The frozen contract's vocabulary: `WidgetStat` has `time-played` and
 * `games-completed`, and `timePlayedStat()` / `gamesCompletedStat()` below are
 * what those keys resolve to.
 */
import type { Game, NamedColor } from "../../types";

/** v3's finished status. Games have no episode model, so completion is this. */
export const GAME_STATUS_FINISHED = "Finished";
export const GAME_STATUS_PLAYING = "Playing";
export const GAME_STATUS_NOT_STARTED = "Not started";
export const GAME_STATUS_DROPPED = "Dropped";
export const GAME_STATUS_TO_BE_RELEASED = "To be released";
/** v3's "no date announced" bucket. Not the same as "to be released". */
export const GAME_STATUS_TBA = "TBA";

/**
 * Statuses excluded from completion ratios, matching what the watchlist does
 * with Dropped and To be released (`constants.ts`).
 */
export const GAME_NON_COUNTING_STATUSES: readonly string[] = [
  GAME_STATUS_DROPPED,
  GAME_STATUS_TO_BE_RELEASED,
  GAME_STATUS_TBA,
];

// ---------------------------------------------------------------------------
// Playtime
// ---------------------------------------------------------------------------

/**
 * Total minutes played across a list.
 *
 * Wishlist entries are included when they somehow carry playtime — the flag says
 * "I want this", not "I have not played it", and a game can be both wanted on
 * another platform and played on this one. Negative values (a corrupt import)
 * count as zero rather than subtracting from the total.
 */
export function totalPlaytimeMinutes(games: readonly Game[]): number {
  let total = 0;
  for (const game of games) {
    const minutes = game.playtimeMinutes;
    if (Number.isFinite(minutes) && minutes > 0) total += minutes;
  }
  return Math.round(total);
}

/**
 * `12 h`, `3 h 20 m`, `45 m`, `—`.
 *
 * Deliberately *not* `formatMinutes` from `data/episodes.ts`: that formula rolls
 * into days at 1,440 minutes, which is right for a watchlist ("3d 4h" of telly)
 * and wrong for a game, where 4,210 minutes is "70 h" to everyone who plays and
 * "2d 22h" to nobody. Same numbers, different unit conventions.
 */
export function formatPlaytime(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "—";
  if (total < 60) return `${total} m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  // Minutes matter while the number is small and are noise once it is not:
  // "1 h 30 m" is how you describe an evening, "70 h" is how you describe Hades.
  if (hours >= PLAYTIME_MINUTES_CUTOFF_HOURS || mins === 0) return `${hours} h`;
  return `${hours} h ${mins} m`;
}

/** Above this many hours, the minutes stop being information. */
export const PLAYTIME_MINUTES_CUTOFF_HOURS = 10;

/** Compact form for a card corner: `70h`, `45m`. */
export function formatPlaytimeShort(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "";
  if (total < 60) return `${total}m`;
  return `${Math.round(total / 60)}h`;
}

export interface TimePlayedStat {
  minutes: number;
  /** Ready to print: `70 h`. */
  label: string;
  /** How many games actually contributed — "across 12 games". */
  games: number;
}

/** What `stat: time-played` and the dashboard's Time Played card resolve to. */
export function timePlayedStat(games: readonly Game[]): TimePlayedStat {
  const played = games.filter((game) => game.playtimeMinutes > 0);
  const minutes = totalPlaytimeMinutes(played);
  return { minutes, label: formatPlaytime(minutes), games: played.length };
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export interface AchievementTotals {
  earned: number;
  total: number;
  /** 0–100, rounded. `0` when nothing is tracked. */
  percent: number;
  /** Games that report an achievement schema at all. */
  games: number;
}

/**
 * Achievement percentage for one game.
 *
 * `null` — not `0` — when the game has no achievements: a game with none is not
 * a game with none earned, and rendering "0%" on Tetris is a lie the card would
 * repeat forever. `earned` above `total` (Steam occasionally reports it during a
 * schema change) clamps to 100 rather than showing 105%.
 */
export function achievementPercent(game: Game): number | null {
  const total = game.achievementsTotal;
  if (!Number.isFinite(total) || total <= 0) return null;
  const earned = Math.max(0, Math.min(total, game.achievementsEarned));
  return Math.round((earned / total) * 100);
}

/** `12 / 49` — or `""` when the game tracks no achievements. */
export function achievementText(game: Game): string {
  if (!(game.achievementsTotal > 0)) return "";
  const earned = Math.max(0, Math.min(game.achievementsTotal, game.achievementsEarned));
  return `${earned} / ${game.achievementsTotal}`;
}

/** Every game with achievements, summed. */
export function achievementTotals(games: readonly Game[]): AchievementTotals {
  let earned = 0;
  let total = 0;
  let counted = 0;
  for (const game of games) {
    if (!(game.achievementsTotal > 0)) continue;
    counted += 1;
    total += game.achievementsTotal;
    earned += Math.max(0, Math.min(game.achievementsTotal, game.achievementsEarned));
  }
  return {
    earned,
    total,
    percent: total > 0 ? Math.round((earned / total) * 100) : 0,
    games: counted,
  };
}

// ---------------------------------------------------------------------------
// Progress and completion
// ---------------------------------------------------------------------------

/**
 * The 0–100 a card's bar shows.
 *
 * A finished game is 100% whatever the stored number says — the status is the
 * user's own statement and outranks a percentage they may never have touched.
 * Otherwise the stored `progress` wins, and a game that only reports
 * achievements falls back to those, so a Steam import shows movement without
 * anyone dragging a slider.
 */
export function gameProgress(game: Game): number {
  if (game.status === GAME_STATUS_FINISHED) return 100;
  const stored = game.progress;
  if (Number.isFinite(stored) && stored > 0) return Math.max(0, Math.min(100, Math.round(stored)));
  return achievementPercent(game) ?? 0;
}

export interface GamesCompletionStat {
  finished: number;
  /** Games counted towards the ratio (Dropped/TBA/unreleased excluded). */
  counted: number;
  /** 0–100. `0` when nothing counts. */
  percent: number;
}

/** What `stat: games-completed` resolves to. */
export function gamesCompletedStat(games: readonly Game[]): GamesCompletionStat {
  let finished = 0;
  let counted = 0;
  for (const game of games) {
    if (GAME_NON_COUNTING_STATUSES.includes(game.status)) continue;
    counted += 1;
    if (game.status === GAME_STATUS_FINISHED) finished += 1;
  }
  return {
    finished,
    counted,
    percent: counted > 0 ? Math.round((finished / counted) * 100) : 0,
  };
}

/** Counts per status, in the order the user configured them. */
export function countsByStatus(
  games: readonly Game[],
  statuses: readonly NamedColor[],
): { name: string; color: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const game of games) counts.set(game.status, (counts.get(game.status) ?? 0) + 1);
  const out = statuses.map((status) => ({
    name: status.name,
    color: status.color,
    count: counts.get(status.name) ?? 0,
  }));
  // A status the user deleted while games still carry it must still be visible;
  // silently dropping those games from the chart is how totals stop adding up.
  for (const [name, count] of counts) {
    if (!statuses.some((status) => status.name === name)) out.push({ name, color: "", count });
  }
  return out;
}

/** The year a game belongs to, from its release date. `null` when undated. */
export function gameYear(game: Game): number | null {
  const date = game.releaseDate;
  if (!date) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}
