/**
 * The Games tab's facet filters.
 *
 * Same model as the Library's (`ui/components/facets.ts`), applied to the v3
 * `Game` shape rather than to titles: state records what is **hidden**, never
 * what is shown, so a genre or platform that appears for the first time is
 * visible by default instead of silently filtered away. `(empty)` is a real,
 * excludable value on every string facet, and `minRating` never hides an unrated
 * game.
 *
 * Why a parallel implementation rather than a shared one: `FilterState` is part
 * of the frozen contract and is typed for titles (Plex states, request states,
 * airing states — none of which a game has). The *rules* are shared; the shape
 * cannot be.
 *
 * Pure module — no obsidian, no DOM.
 */
import { EMPTY_FACET_LABEL, EMPTY_FACET_VALUE } from "../../ui/components/facets";
import type { Game, GamesSettings } from "../../types";
import { gameYear } from "./stats";

export type GameFacetKey = "statuses" | "genres" | "platforms" | "priorities" | "decades";

export interface GameFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface GameFacetSection {
  key: GameFacetKey;
  label: string;
  options: GameFacetOption[];
  /** True for platforms: a game hides only when **all** of its values are excluded. */
  multiValue: boolean;
}

/**
 * The Games tab's view state.
 *
 * Persisted inside `data.games.settings` under a key v3 never wrote, through the
 * `readExtra`/`writeExtra` escape hatch — `GamesSettings` is frozen, and the
 * runtime preservation contract means an undeclared key round-trips happily.
 */
export interface GameFilterState {
  excludedStatuses: string[];
  excludedGenres: string[];
  excludedPlatforms: string[];
  excludedPriorities: string[];
  /** Decade buckets as strings: `"2020"`, `""` for an undated game. */
  excludedDecades: string[];
  /** 0 = any. Unrated games (rating 0) **always pass**. */
  minRating: number;
  favoritesOnly: boolean;
  /** v3's `gamesFilters.wishlistOnly`. */
  wishlistOnly: boolean;
}

export function createGameFilterState(): GameFilterState {
  return {
    excludedStatuses: [],
    excludedGenres: [],
    excludedPlatforms: [],
    excludedPriorities: [],
    excludedDecades: [],
    minRating: 0,
    favoritesOnly: false,
    wishlistOnly: false,
  };
}

/** Repair anything a hand-edited `data.json` (or an older build) left behind. */
export function normalizeGameFilterState(raw: unknown): GameFilterState {
  const base = createGameFilterState();
  if (typeof raw !== "object" || raw === null) return base;
  const rec = raw as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  base.excludedStatuses = list(rec.excludedStatuses);
  base.excludedGenres = list(rec.excludedGenres);
  base.excludedPlatforms = list(rec.excludedPlatforms);
  base.excludedPriorities = list(rec.excludedPriorities);
  base.excludedDecades = list(rec.excludedDecades);
  base.minRating = typeof rec.minRating === "number" && rec.minRating > 0 ? rec.minRating : 0;
  base.favoritesOnly = rec.favoritesOnly === true;
  base.wishlistOnly = rec.wishlistOnly === true;
  return base;
}

// ---------------------------------------------------------------------------
// Value derivation
// ---------------------------------------------------------------------------

/** The decade bucket, `""` for a game with no release date. */
export function gameDecade(game: Game): string {
  const year = gameYear(game);
  return year === null ? EMPTY_FACET_VALUE : String(Math.floor(year / 10) * 10);
}

export function decadeLabel(value: string): string {
  return value === EMPTY_FACET_VALUE ? EMPTY_FACET_LABEL : `${value}s`;
}

/** Platforms, with `[""]` standing in for "none recorded" so the chip works. */
export function platformsOf(game: Game): string[] {
  const list = (game.platforms ?? []).filter((p) => p.trim() !== "");
  return list.length > 0 ? list : [EMPTY_FACET_VALUE];
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

function excludedIn(list: readonly string[], value: string): boolean {
  return list.length > 0 && list.includes(value);
}

/** True when the game survives the facet filters. */
export function matchesGameFilters(game: Game, state: GameFilterState): boolean {
  if (state.favoritesOnly && !game.favorite) return false;
  if (state.wishlistOnly && !game.wishlist) return false;
  // An unrated game always passes — the same surprise the Library's note warns
  // about, and the same answer.
  if (state.minRating > 0 && game.rating > 0 && game.rating < state.minRating) return false;

  if (excludedIn(state.excludedStatuses, game.status)) return false;
  if (excludedIn(state.excludedGenres, game.type)) return false;
  if (excludedIn(state.excludedPriorities, game.priority)) return false;
  if (excludedIn(state.excludedDecades, gameDecade(game))) return false;

  if (state.excludedPlatforms.length > 0) {
    const platforms = platformsOf(game);
    // Multi-value: hidden only when every platform it carries is excluded.
    if (platforms.every((platform) => state.excludedPlatforms.includes(platform))) return false;
  }

  return true;
}

export function isGameFilterActive(state: GameFilterState): boolean {
  return (
    state.excludedStatuses.length > 0 ||
    state.excludedGenres.length > 0 ||
    state.excludedPlatforms.length > 0 ||
    state.excludedPriorities.length > 0 ||
    state.excludedDecades.length > 0 ||
    state.minRating > 0 ||
    state.favoritesOnly ||
    state.wishlistOnly
  );
}

export function clearGameFilters(state: GameFilterState): void {
  state.excludedStatuses = [];
  state.excludedGenres = [];
  state.excludedPlatforms = [];
  state.excludedPriorities = [];
  state.excludedDecades = [];
  state.minRating = 0;
  state.favoritesOnly = false;
  state.wishlistOnly = false;
}

// ---------------------------------------------------------------------------
// Section plumbing (the panel's data source)
// ---------------------------------------------------------------------------

export function excludedForGames(state: GameFilterState, key: GameFacetKey): string[] {
  switch (key) {
    case "statuses":
      return state.excludedStatuses;
    case "genres":
      return state.excludedGenres;
    case "platforms":
      return state.excludedPlatforms;
    case "priorities":
      return state.excludedPriorities;
    case "decades":
      return state.excludedDecades;
  }
}

export function setExcludedForGames(
  state: GameFilterState,
  key: GameFacetKey,
  values: string[],
): void {
  const unique = [...new Set(values)];
  switch (key) {
    case "statuses":
      state.excludedStatuses = unique;
      return;
    case "genres":
      state.excludedGenres = unique;
      return;
    case "platforms":
      state.excludedPlatforms = unique;
      return;
    case "priorities":
      state.excludedPriorities = unique;
      return;
    case "decades":
      state.excludedDecades = unique;
      return;
  }
}

/** Toggle one value. Returns whether it is now **shown**. */
export function toggleGameFacetValue(
  state: GameFilterState,
  key: GameFacetKey,
  value: string,
): boolean {
  const current = excludedForGames(state, key);
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  setExcludedForGames(state, key, next);
  return !next.includes(value);
}

export function isGameFacetShown(
  state: GameFilterState,
  key: GameFacetKey,
  value: string,
): boolean {
  return !excludedForGames(state, key).includes(value);
}

export function showAllGameFacets(state: GameFilterState, sections: GameFacetSection[]): void {
  for (const section of sections) setExcludedForGames(state, section.key, []);
}

export function hideAllGameFacets(state: GameFilterState, sections: GameFacetSection[]): void {
  for (const section of sections) {
    setExcludedForGames(state, section.key, section.options.map((option) => option.value));
  }
}

function countSingle(games: readonly Game[], pick: (game: Game) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const game of games) {
    const value = pick(game);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function countMulti(
  games: readonly Game[],
  pick: (game: Game) => string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const game of games) {
    for (const value of new Set(pick(game))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** The `(empty)` chip goes last, and only when something is actually empty. */
function appendEmpty(out: GameFacetOption[], counts: Map<string, number>): void {
  const count = counts.get(EMPTY_FACET_VALUE) ?? 0;
  if (count > 0) {
    out.push({ value: EMPTY_FACET_VALUE, label: EMPTY_FACET_LABEL, count });
  }
}

/**
 * Configured order first, then anything the data carries that settings does not
 * — a genre the user deleted while games still use it stays filterable.
 */
function orderedOptions(order: readonly string[], counts: Map<string, number>): GameFacetOption[] {
  const out: GameFacetOption[] = [];
  const seen = new Set<string>();
  for (const name of order) {
    if (name === EMPTY_FACET_VALUE || seen.has(name)) continue;
    seen.add(name);
    out.push({ value: name, label: name, count: counts.get(name) ?? 0 });
  }
  const extras = [...counts.keys()]
    .filter((value) => value !== EMPTY_FACET_VALUE && !seen.has(value))
    .sort((a, b) => a.localeCompare(b));
  for (const value of extras) {
    out.push({ value, label: value, count: counts.get(value) ?? 0 });
  }
  appendEmpty(out, counts);
  return out;
}

function decadeOptions(counts: Map<string, number>): GameFacetOption[] {
  return [...counts]
    .sort((a, b) => {
      if (a[0] === EMPTY_FACET_VALUE) return 1;
      if (b[0] === EMPTY_FACET_VALUE) return -1;
      return Number(b[0]) - Number(a[0]);
    })
    .map(([value, count]) => ({ value, label: decadeLabel(value), count }));
}

/** Every facet section, with live counts, for the filter panel. */
export function buildGameFacetSections(
  games: readonly Game[],
  settings: GamesSettings,
  priorities: readonly string[] = [],
): GameFacetSection[] {
  return [
    {
      key: "statuses",
      label: "Status",
      multiValue: false,
      options: orderedOptions(
        settings.statuses.map((s) => s.name),
        countSingle(games, (game) => game.status),
      ),
    },
    {
      key: "genres",
      label: "Genre",
      multiValue: false,
      options: orderedOptions(
        settings.types.map((t) => t.name),
        countSingle(games, (game) => game.type),
      ),
    },
    {
      key: "platforms",
      label: "Platform",
      multiValue: true,
      options: orderedOptions(
        settings.platforms.map((p) => p.name),
        countMulti(games, platformsOf),
      ),
    },
    {
      key: "priorities",
      label: "Priority",
      multiValue: false,
      options: orderedOptions(priorities, countSingle(games, (game) => game.priority)),
    },
    {
      key: "decades",
      label: "Released",
      multiValue: false,
      options: decadeOptions(countSingle(games, gameDecade)),
    },
  ];
}
