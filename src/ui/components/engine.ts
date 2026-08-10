/**
 * The Library's query/filter/sort engine seam.
 *
 * `search/query.ts`, `search/filter.ts` and `search/sort.ts` are owned by other
 * Wave-1 lanes and land at integration. The Library tab therefore depends on the
 * **`LibraryEngine` interface** declared here and is handed an implementation;
 * `createFallbackEngine()` is the stand-in that keeps this lane buildable,
 * demoable and testable on its own. Swapping it for the real modules is a
 * one-line change in `view.ts` — nothing in the UI reaches past this interface.
 *
 * Sorting is *not* a stand-in: the two-level, empty-last comparator below is the
 * behaviour SPEC §4.5 asks for, and the sort menu drives it directly.
 *
 * Obsidian-free and DOM-free on purpose — tests import it directly.
 */
import { calcTimeRemaining, getProgress } from "../../data/episodes";
import type {
  FilterState,
  Settings,
  SortDirection,
  SortKey,
  SortSpec,
  TitleV4,
} from "../../types";
import {
  airingStateOf,
  dayNumberOf,
  matchesFilters,
  plexStateOf,
  requestStateOf,
  yearOf,
} from "./facets";

/** What the Library needs from the search stack. */
export interface LibraryEngine {
  /** Facet + free-text filtering, in that order. */
  filter(titles: readonly TitleV4[], query: string, state: FilterState): TitleV4[];
  /** Two-level sort; empties always last. */
  sort(titles: TitleV4[], sort: SortSpec, secondary: SortSpec | null): TitleV4[];
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export const SORT_KEYS: SortKey[] = [
  "title",
  "dateAdded",
  "dateModified",
  "rating",
  "progress",
  "releaseDate",
  "nextAirDate",
  "timeLeft",
  "year",
  "status",
  "priority",
];

export const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  dateAdded: "Date added",
  dateModified: "Last updated",
  rating: "My rating",
  communityRating: "Public rating",
  progress: "Progress",
  releaseDate: "Release date",
  nextAirDate: "Next episode",
  timeLeft: "Time left",
  year: "Year",
  status: "Status",
  priority: "Priority",
};

/** Picking a *new* key adopts its natural direction; re-picking flips (foodspot §2d). */
export const SORT_DEFAULT_DIR: Record<SortKey, SortDirection> = {
  title: "asc",
  dateAdded: "desc",
  dateModified: "desc",
  rating: "desc",
  communityRating: "desc",
  progress: "desc",
  releaseDate: "desc",
  nextAirDate: "asc",
  timeLeft: "asc",
  year: "desc",
  status: "asc",
  priority: "asc",
};

/** One menu handles both key and direction: same key → flip, new key → default. */
export function nextSortSpec(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: SORT_DEFAULT_DIR[key] };
}

/**
 * The comparable value for one sort key, or `null` for "empty".
 *
 * `null` is what makes unrated titles sort last under `rating desc` *and* under
 * `rating asc`, which is the whole point of convention 6.
 */
export function sortValue(
  title: TitleV4,
  key: SortKey,
  settings: Settings,
): number | string | null {
  switch (key) {
    case "title":
      return title.title.trim().toLowerCase() || null;
    case "dateAdded":
      return timestamp(title.dateAdded);
    case "dateModified":
      return timestamp(title.dateModified);
    case "rating":
      return title.rating > 0 ? title.rating : null;
    case "communityRating":
      return title.communityRating > 0 ? title.communityRating : null;
    case "progress":
      return getProgress(title);
    case "releaseDate":
      return title.releaseDate ? dayNumberOf(title.releaseDate) : null;
    case "nextAirDate": {
      const air = title.airing?.nextEpisode?.airDate;
      return air ? dayNumberOf(air) : null;
    }
    case "timeLeft":
      return title.episodeDuration > 0 ? calcTimeRemaining(title) : null;
    case "year":
      return yearOf(title);
    case "status":
      return listIndex(settings.statuses, title.status);
    case "priority":
      return title.priority === "" ? null : listIndex(settings.priorities, title.priority);
  }
}

function listIndex(list: readonly { name: string }[], name: string): number | null {
  const index = list.findIndex((entry) => entry.name === name);
  return index < 0 ? null : index;
}

function timestamp(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareValues(a: number | string | null, b: number | string | null): number {
  // Empties last, regardless of direction — applied before the direction flip.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" || typeof b === "string") {
    return String(a).localeCompare(String(b));
  }
  return a - b;
}

/**
 * Two-level sort. Direction never moves empties off the bottom, and ties break on
 * the secondary spec and then on title, so the order is always deterministic.
 */
export function sortTitles(
  titles: TitleV4[],
  sort: SortSpec,
  secondary: SortSpec | null,
  settings: Settings,
): TitleV4[] {
  const flip = sort.direction === "desc" ? -1 : 1;
  const flip2 = secondary?.direction === "desc" ? -1 : 1;

  return [...titles].sort((a, b) => {
    const av = sortValue(a, sort.key, settings);
    const bv = sortValue(b, sort.key, settings);
    if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
    const primary = compareValues(av, bv) * flip;
    if (primary !== 0) return primary;

    if (secondary) {
      const a2 = sortValue(a, secondary.key, settings);
      const b2 = sortValue(b, secondary.key, settings);
      if ((a2 === null) !== (b2 === null)) return a2 === null ? 1 : -1;
      const rest = compareValues(a2, b2) * flip2;
      if (rest !== 0) return rest;
    }

    return a.title.localeCompare(b.title);
  });
}

// ---------------------------------------------------------------------------
// Fallback query matching (replaced by search/query.ts at integration)
// ---------------------------------------------------------------------------

const TOKEN_RE = /(-)?(?:([A-Za-z-]+):)?(?:"([^"]*)"|([^\s"]+))/g;

/** Lowercase + strip diacritics, so `dexter` matches `Déxter`. */
export function norm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TEXT_FIELDS = {
  title: (t: TitleV4) => [t.title],
  type: (t: TitleV4) => [t.type],
  status: (t: TitleV4) => [t.status],
  priority: (t: TitleV4) => [t.priority],
  genre: (t: TitleV4) => t.genres ?? [],
  tag: (t: TitleV4) => t.tags,
  cast: (t: TitleV4) => [...t.cast, ...t.manualCast],
  director: (t: TitleV4) => [...t.director, ...t.manualDirector],
  studio: (t: TitleV4) => [...t.studio, ...t.manualStudio],
  note: (t: TitleV4) => [t.notes, t.overview ?? ""],
} satisfies Record<string, (t: TitleV4) => string[]>;

type TextField = keyof typeof TEXT_FIELDS;

const NUMERIC_FIELDS = ["rating", "year", "eps-left", "runtime", "community"] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

const ENUM_FIELDS = ["plex", "requested", "airing", "favorite"] as const;
type EnumField = (typeof ENUM_FIELDS)[number];

interface Token {
  negated: boolean;
  field: string | null;
  value: string;
  quoted: boolean;
}

/** Split into `|` OR-groups of AND-tokens. A bare `|` is the separator. */
export function tokenize(raw: string): Token[][] {
  const groups: Token[][] = [[]];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(raw)) !== null) {
    const [, neg, field, quoted, bare] = match;
    const value = quoted !== undefined ? quoted : (bare ?? "");
    if (value === "" && quoted === undefined) continue;
    if (!neg && !field && quoted === undefined && value === "|") {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1]?.push({
      negated: neg === "-",
      field: field ?? null,
      value,
      quoted: quoted !== undefined,
    });
  }
  return groups.filter((group) => group.length > 0);
}

function haystack(title: TitleV4): string {
  const parts: string[] = [];
  for (const pick of Object.values(TEXT_FIELDS)) parts.push(...pick(title));
  return norm(parts.join("   "));
}

function numericValue(title: TitleV4, field: NumericField): number | null {
  switch (field) {
    case "rating":
      return title.rating > 0 ? title.rating : null;
    case "year":
      return yearOf(title);
    case "eps-left":
      return Math.max(0, title.totalEpisodes - title.watchedEpisodes.length);
    case "runtime":
      return title.episodeDuration > 0 ? title.episodeDuration : null;
    case "community":
      return title.communityRating > 0 ? title.communityRating : null;
  }
}

function enumMatches(title: TitleV4, field: EnumField, value: string, now: Date): boolean {
  const v = value.toLowerCase();
  switch (field) {
    case "plex": {
      const state = plexStateOf(title);
      if (v === "yes" || v === "true") return state === "available";
      if (v === "no" || v === "false") return state === "none" || state === "unknown";
      return state === v;
    }
    case "requested": {
      const requested = requestStateOf(title) === "requested";
      return v === "no" || v === "false" ? !requested : requested;
    }
    case "airing": {
      const state = airingStateOf(title, now);
      if (v === "soon") return state === "upcoming";
      return state === v;
    }
    case "favorite":
      return v === "no" || v === "false" ? !title.favorite : title.favorite;
  }
}

function tokenMatches(title: TitleV4, token: Token, now: Date): boolean {
  const field = token.field?.toLowerCase() ?? null;
  const needle = norm(token.value);

  if (field && field in TEXT_FIELDS) {
    const values = TEXT_FIELDS[field as TextField](title);
    return values.some((v) => norm(v).includes(needle));
  }

  if (field && (NUMERIC_FIELDS as readonly string[]).includes(field)) {
    const parsed = parseComparison(token.value);
    if (!parsed) return false;
    const actual = numericValue(title, field as NumericField);
    if (actual === null) return false;
    return compareNumeric(actual, parsed.op, parsed.value);
  }

  if (field && (ENUM_FIELDS as readonly string[]).includes(field)) {
    return enumMatches(title, field as EnumField, token.value, now);
  }

  // Unknown prefix degrades to a literal search — correct for a live search box.
  const literal = field ? norm(`${field}:${token.value}`) : needle;
  return haystack(title).includes(literal);
}

export function parseComparison(raw: string): { op: string; value: number } | null {
  const match = /^(>=|<=|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/.exec(raw.trim());
  if (!match) return null;
  const [, op, num] = match;
  if (!num) return null;
  return { op: op ?? "=", value: Number(num.replace(",", ".")) };
}

function compareNumeric(actual: number, op: string, expected: number): boolean {
  switch (op) {
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    default:
      return actual === expected;
  }
}

/** A title matches when **any** OR-group matches; within a group, all tokens must. */
export function matchesQuery(title: TitleV4, raw: string, now: Date = new Date()): boolean {
  const groups = tokenize(raw);
  if (groups.length === 0) return true;
  return groups.some((group) =>
    group.every((token) => {
      const hit = tokenMatches(title, token, now);
      return token.negated ? !hit : hit;
    }),
  );
}

/**
 * The stand-in engine. Facets first (cheap, and it shrinks the pool the text
 * search has to walk), then the query.
 */
export function createFallbackEngine(settings: Settings): LibraryEngine {
  return {
    filter(titles, query, state) {
      const now = new Date();
      const faceted = titles.filter((t) => matchesFilters(t, state, now));
      if (query.trim() === "") return [...faceted];
      return faceted.filter((t) => matchesQuery(t, query, now));
    },
    sort(titles, sort, secondary) {
      return sortTitles(titles, sort, secondary, settings);
    },
  };
}
