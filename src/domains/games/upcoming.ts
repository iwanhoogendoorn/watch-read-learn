/**
 * Games in the Upcoming list (SPEC2-PARITY.md §D-GAMES: "Upcoming gains game
 * releaseDate rows").
 *
 * The rows are shaped exactly like `UpcomingEntry` from `ui/tabs/upcoming.ts`,
 * one field apart: they carry a `game` where a title row carries a `title`. That
 * tab and its `UpcomingEntry` are another lane's, and the unified list is
 * W8-integration's job — this module is the games half of it, pure and testable
 * on its own, so the merge is a concat and a re-sort rather than a rewrite.
 *
 * v3's rule is kept: a game whose release date is in the future belongs on the
 * list, and it stays there for a week after release so "it's out" is news you can
 * still see on Monday.
 */
import type { DateString, Game } from "../../types";
import { GAME_STATUS_TBA, GAME_STATUS_TO_BE_RELEASED } from "./stats";

/** How far back a released game stays on the list. Matches the watchlist's. */
export const GAME_UPCOMING_PAST_WINDOW_DAYS = 7;

export interface GameUpcomingEntry {
  kind: "release";
  game: Game;
  /** `null` only for an undated announcement (`includeUndated`). */
  date: DateString | null;
  /** Calendar days from today; negative once released. `null` when undated. */
  daysUntil: number | null;
  /** Short label for the row: `Release`. */
  label: string;
  /** The longer second line. */
  detail: string;
}

export interface GameUpcomingOptions {
  pastWindowDays?: number;
  /**
   * Include `TBA` / `To be released` games that carry no date at all.
   *
   * Off by default: an undated row cannot be counted down, cannot be sorted, and
   * mostly says "you added this once". The Games tab shows them perfectly well.
   */
  includeUndated?: boolean;
}

/** Whole days from `now` to `YYYY-MM-DD`, both at local midnight. */
export function daysUntil(now: Date, date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  if (!y || !m || !d) return null;
  const target = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

function detailFor(game: Game): string {
  const parts: string[] = [];
  if (game.type) parts.push(game.type);
  const platforms = (game.platforms ?? []).filter((platform) => platform.trim() !== "");
  if (platforms.length > 0) parts.push(platforms.slice(0, 3).join(", "));
  if (game.wishlist) parts.push("On your wishlist");
  return parts.join(" · ");
}

/**
 * The chronological list of game releases.
 *
 * Dated rows sort ascending; undated announcements (when asked for) land at the
 * end, which is the same ordering the watchlist's Upcoming uses.
 */
export function buildGameUpcomingEntries(
  games: readonly Game[],
  now: Date = new Date(),
  options: GameUpcomingOptions = {},
): GameUpcomingEntry[] {
  const pastWindow = options.pastWindowDays ?? GAME_UPCOMING_PAST_WINDOW_DAYS;
  const includeUndated = options.includeUndated ?? false;
  const out: GameUpcomingEntry[] = [];

  for (const game of games) {
    const date = game.releaseDate;
    if (date) {
      const days = daysUntil(now, date);
      if (days === null) continue;
      if (days < -pastWindow) continue;
      out.push({
        kind: "release",
        game,
        date,
        daysUntil: days,
        label: "Release",
        detail: detailFor(game),
      });
      continue;
    }
    if (!includeUndated) continue;
    if (game.status !== GAME_STATUS_TBA && game.status !== GAME_STATUS_TO_BE_RELEASED) continue;
    out.push({
      kind: "release",
      game,
      date: null,
      daysUntil: null,
      label: "No date yet",
      detail: detailFor(game),
    });
  }

  return out.sort((a, b) => {
    if (a.date === null && b.date === null) return a.game.title.localeCompare(b.game.title);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.game.title.localeCompare(b.game.title);
  });
}

/**
 * Games whose stored status disagrees with their release date.
 *
 * v3 force-set `To be released` on anything dated in the future and reverted it
 * once the date passed (`canAutoAddToUpcoming`). v4 does not silently rewrite the
 * user's status — a status the user chose is theirs — so this reports the
 * mismatch and the Games tab shows it, rather than fixing it behind their back.
 */
export function isUnreleased(game: Game, now: Date = new Date()): boolean {
  if (!game.releaseDate) return false;
  const days = daysUntil(now, game.releaseDate);
  return days !== null && days > 0;
}
