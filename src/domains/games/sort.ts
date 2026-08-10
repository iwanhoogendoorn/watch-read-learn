/**
 * Games sorting — two levels, empties always last.
 *
 * Identical discipline to `ui/components/engine.ts`: picking a new key adopts
 * that key's natural direction, re-picking flips it, and a `null` value sorts to
 * the bottom under **both** directions, so an unrated game never leads the list
 * just because you asked for ascending ratings.
 *
 * The keys are games' own — `SortKey` in the frozen contract is the watchlist's
 * (`nextAirDate`, `timeLeft`, …) and means nothing here.
 */
import type { Game, NamedColor, SortDirection } from "../../types";
import { dayNumberOf } from "../../ui/components/facets";
import { achievementPercent, gameProgress, gameYear } from "./stats";

export type GameSortKey =
  | "title"
  | "dateAdded"
  | "dateModified"
  | "rating"
  | "progress"
  | "playtime"
  | "lastPlayed"
  | "achievements"
  | "releaseDate"
  | "year"
  | "status"
  | "priority";

export interface GameSortSpec {
  key: GameSortKey;
  direction: SortDirection;
}

export const GAME_SORT_KEYS: readonly GameSortKey[] = [
  "title",
  "dateAdded",
  "dateModified",
  "rating",
  "progress",
  "playtime",
  "lastPlayed",
  "achievements",
  "releaseDate",
  "year",
  "status",
  "priority",
];

export const GAME_SORT_LABELS: Record<GameSortKey, string> = {
  title: "Title",
  dateAdded: "Date added",
  dateModified: "Last updated",
  rating: "My rating",
  progress: "Progress",
  playtime: "Time played",
  lastPlayed: "Last played",
  achievements: "Achievements",
  releaseDate: "Release date",
  year: "Year",
  status: "Status",
  priority: "Priority",
};

export const GAME_SORT_DEFAULT_DIR: Record<GameSortKey, SortDirection> = {
  title: "asc",
  dateAdded: "desc",
  dateModified: "desc",
  rating: "desc",
  progress: "desc",
  playtime: "desc",
  lastPlayed: "desc",
  achievements: "desc",
  releaseDate: "desc",
  year: "desc",
  status: "asc",
  priority: "asc",
};

export function createGameSortSpec(): GameSortSpec {
  return { key: "dateAdded", direction: "desc" };
}

/** Same key → flip; new key → its natural direction. */
export function nextGameSortSpec(current: GameSortSpec, key: GameSortKey): GameSortSpec {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: GAME_SORT_DEFAULT_DIR[key] };
}

/** Repair a persisted spec written by a hand edit or an older build. */
export function normalizeGameSortSpec(
  raw: unknown,
  fallback: GameSortSpec = createGameSortSpec(),
): GameSortSpec {
  if (typeof raw !== "object" || raw === null) return fallback;
  const rec = raw as Record<string, unknown>;
  const key = typeof rec.key === "string" && (GAME_SORT_KEYS as readonly string[]).includes(rec.key)
    ? (rec.key as GameSortKey)
    : fallback.key;
  const direction = rec.direction === "asc" || rec.direction === "desc" ? rec.direction : fallback.direction;
  return { key, direction };
}

function listIndex(list: readonly NamedColor[], name: string): number | null {
  const index = list.findIndex((entry) => entry.name === name);
  return index < 0 ? null : index;
}

function timestamp(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface GameSortContext {
  statuses: readonly NamedColor[];
  priorities: readonly NamedColor[];
}

/** The comparable value for one key, or `null` for "empty". */
export function gameSortValue(
  game: Game,
  key: GameSortKey,
  context: GameSortContext,
): number | string | null {
  switch (key) {
    case "title":
      return game.title.trim().toLowerCase() || null;
    case "dateAdded":
      return timestamp(game.dateAdded);
    case "dateModified":
      return timestamp(game.dateModified);
    case "rating":
      // 0 means unrated, not "worst" — that is what makes it sort last.
      return game.rating > 0 ? game.rating : null;
    case "progress":
      return gameProgress(game);
    case "playtime":
      return game.playtimeMinutes > 0 ? game.playtimeMinutes : null;
    case "lastPlayed":
      return game.lastPlayed ? dayNumberOf(game.lastPlayed) : null;
    case "achievements":
      return achievementPercent(game);
    case "releaseDate":
      return game.releaseDate ? dayNumberOf(game.releaseDate) : null;
    case "year":
      return gameYear(game);
    case "status":
      return listIndex(context.statuses, game.status);
    case "priority":
      return game.priority === "" ? null : listIndex(context.priorities, game.priority);
  }
}

function compareValues(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b));
  return a - b;
}

/**
 * Two-level sort. Direction never moves empties off the bottom, and ties break
 * on the secondary spec and then on title, so the order is deterministic.
 */
export function sortGames(
  games: readonly Game[],
  sort: GameSortSpec,
  secondary: GameSortSpec | null,
  context: GameSortContext,
): Game[] {
  const flip = sort.direction === "desc" ? -1 : 1;
  const flip2 = secondary?.direction === "desc" ? -1 : 1;

  return [...games].sort((a, b) => {
    const av = gameSortValue(a, sort.key, context);
    const bv = gameSortValue(b, sort.key, context);
    if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
    const primary = compareValues(av, bv) * flip;
    if (primary !== 0) return primary;

    if (secondary) {
      const a2 = gameSortValue(a, secondary.key, context);
      const b2 = gameSortValue(b, secondary.key, context);
      if ((a2 === null) !== (b2 === null)) return a2 === null ? 1 : -1;
      const rest = compareValues(a2, b2) * flip2;
      if (rest !== 0) return rest;
    }

    return a.title.localeCompare(b.title);
  });
}
