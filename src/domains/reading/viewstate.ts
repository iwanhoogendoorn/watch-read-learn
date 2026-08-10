/**
 * Facets, sorting and saved views for the Reading tab.
 *
 * The Library's three ideas are kept exactly (SPEC §4.5, foodspot §2c):
 *
 *   1. **Exclusion, not inclusion.** State records what is hidden, so an author
 *      who appears for the first time tomorrow is visible immediately.
 *   2. **Empty is a real facet value.** `""` is the `(empty)` chip — a book with
 *      no author can be excluded, and is *not* excluded by excluding every named
 *      author.
 *   3. **Empty sorts last in both directions**, and unrated entries always pass
 *      a minimum-rating filter, because 0 is the absence of a score.
 *
 * ## Two frozen contracts this file bends around, on purpose
 *
 * `ReadingSettings.savedPresets` is typed `Preset[]`, and `Preset` carries a
 * `FilterState` and a `SortSpec` — both watchlist-shaped, both frozen for Wave 8.
 * Rather than widen a contract four lanes are building against, the reading view
 * state **projects** onto them:
 *
 *   - `excludedStatuses` → `excludedStatuses` (same meaning)
 *   - `excludedAuthors`  → `excludedTypes`   (the reading table's second axis)
 *   - `excludedDecades`  → `excludedDecades` (same meaning)
 *   - custom columns     → `excludedTags`, encoded `columnId=value`
 *   - `minRating` / `favoritesOnly` → themselves
 *
 * and the sort menu maps its author axis onto the unused `priority` `SortKey` —
 * reading entries have no priority, the mapping never leaves this file, and what
 * lands in `data.json` is a structurally valid `Preset` either way. If a later
 * wave widens the contract, `toPreset`/`fromPreset` is the only thing to change.
 *
 * Pure: no obsidian, no DOM.
 */
import {
  type CustomColumn,
  type FilterState,
  type Preset,
  type ReadingStatus,
  type SortDirection,
  type SortKey,
  type SortSpec,
} from "../../types";
import { derivedStatus, isBook, readingProgress, type ReadingEntry } from "./progress";

/** The synthetic `(empty)` facet value, same convention as the Library's. */
export const EMPTY_FACET = "";

export interface ReadingFilterState {
  excludedStatuses: string[];
  excludedAuthors: string[];
  /** Google-style categories ("Computers", "Fiction"); multi-value per entry. */
  excludedCategories: string[];
  /** Decade buckets as strings: `"1990"`, `""` when the release year is unknown. */
  excludedDecades: string[];
  /** `columnId` → excluded values. Only `select` columns get chips. */
  excludedColumns: Record<string, string[]>;
  /** 0 = any. Unrated entries always pass. */
  minRating: number;
  favoritesOnly: boolean;
}

export function createReadingFilterState(): ReadingFilterState {
  return {
    excludedStatuses: [],
    excludedAuthors: [],
    excludedCategories: [],
    excludedDecades: [],
    excludedColumns: {},
    minRating: 0,
    favoritesOnly: false,
  };
}

/** Reset in place — the state object is held by reference by the toolbar. */
export function clearReadingFilters(state: ReadingFilterState): void {
  state.excludedStatuses = [];
  state.excludedAuthors = [];
  state.excludedCategories = [];
  state.excludedDecades = [];
  state.excludedColumns = {};
  state.minRating = 0;
  state.favoritesOnly = false;
}

export function countActiveReadingFilters(state: ReadingFilterState): number {
  let count = 0;
  count += state.excludedStatuses.length > 0 ? 1 : 0;
  count += state.excludedAuthors.length > 0 ? 1 : 0;
  count += (state.excludedCategories ?? []).length > 0 ? 1 : 0;
  count += state.excludedDecades.length > 0 ? 1 : 0;
  count += Object.values(state.excludedColumns).some((values) => values.length > 0) ? 1 : 0;
  count += state.minRating > 0 ? 1 : 0;
  count += state.favoritesOnly ? 1 : 0;
  return count;
}

export function isReadingFilterActive(state: ReadingFilterState): boolean {
  return countActiveReadingFilters(state) > 0;
}

// ---------------------------------------------------------------------------
// Facet values
// ---------------------------------------------------------------------------

export function authorOf(entry: ReadingEntry): string {
  return (entry.author ?? "").trim();
}

/** Facet values for the multi-value category axis; no categories → `(empty)`. */
export function categoriesOf(entry: ReadingEntry): string[] {
  const raw = (entry.categories ?? []).map((c) => c.trim()).filter((c) => c !== "");
  return raw.length > 0 ? raw : [EMPTY_FACET];
}

export function yearOf(entry: ReadingEntry): number | null {
  const year = Number.parseInt((entry.releaseDate ?? "").slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

export function decadeOf(entry: ReadingEntry): string {
  const year = yearOf(entry);
  if (year === null) return EMPTY_FACET;
  return String(Math.floor(year / 10) * 10);
}

/** The value a row holds in one custom column, as a facet string. */
export function columnValueOf(entry: ReadingEntry, column: CustomColumn): string {
  const raw = entry.customFields?.[column.id];
  if (raw === undefined || raw === null) return EMPTY_FACET;
  const text = String(raw).trim();
  return text === "" ? EMPTY_FACET : text;
}

export function matchesReadingFilters(
  entry: ReadingEntry,
  state: ReadingFilterState,
  columns: readonly CustomColumn[] = [],
  now: Date = new Date(),
): boolean {
  if (state.excludedStatuses.includes(derivedStatus(entry, now))) return false;
  if (state.excludedAuthors.includes(authorOf(entry))) return false;
  // Multi-value: excluding "Horror" hides everything that is horror at all,
  // even when it is also something else. That is what "hide this" means.
  const excludedCategories = state.excludedCategories ?? [];
  if (excludedCategories.length > 0 && categoriesOf(entry).some((c) => excludedCategories.includes(c)))
    return false;
  if (state.excludedDecades.includes(decadeOf(entry))) return false;

  for (const column of columns) {
    const excluded = state.excludedColumns[column.id];
    if (!excluded || excluded.length === 0) continue;
    if (excluded.includes(columnValueOf(entry, column))) return false;
  }

  // Unrated always passes — a 4-star filter that hides everything you have not
  // rated yet is useless for deciding what to read next.
  if (state.minRating > 0 && entry.rating > 0 && entry.rating < state.minRating) return false;
  if (state.favoritesOnly && !entry.favorite) return false;

  return true;
}

export function applyReadingFilters(
  entries: readonly ReadingEntry[],
  state: ReadingFilterState,
  columns: readonly CustomColumn[] = [],
  now: Date = new Date(),
): ReadingEntry[] {
  return entries.filter((entry) => matchesReadingFilters(entry, state, columns, now));
}

export interface ReadingFacetOption {
  value: string;
  label: string;
  count: number;
  excluded: boolean;
}

export type ReadingFacetField =
  | "status"
  | "author"
  | "category"
  | "decade"
  | { column: CustomColumn };

/** Every facet value an entry holds for a field — one for most, N for categories. */
function valuesOf(entry: ReadingEntry, field: ReadingFacetField, now: Date): string[] {
  if (field === "status") return [derivedStatus(entry, now)];
  if (field === "author") return [authorOf(entry)];
  if (field === "category") return categoriesOf(entry);
  if (field === "decade") return [decadeOf(entry)];
  return [columnValueOf(entry, field.column)];
}

function excludedFor(field: ReadingFacetField, state: ReadingFilterState): readonly string[] {
  if (field === "status") return state.excludedStatuses;
  if (field === "author") return state.excludedAuthors;
  if (field === "category") return state.excludedCategories ?? [];
  if (field === "decade") return state.excludedDecades;
  return state.excludedColumns[field.column.id] ?? [];
}

/**
 * Every value present in the data, with counts and exclusion state.
 *
 * Built from the entries rather than from settings, so a status or author that
 * only exists on one old row still gets a chip — otherwise it is unfilterable.
 */
export function readingFacetOptions(
  entries: readonly ReadingEntry[],
  field: ReadingFacetField,
  state: ReadingFilterState,
  now: Date = new Date(),
): ReadingFacetOption[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const value of valuesOf(entry, field, now)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const excluded = new Set(excludedFor(field, state));
  // Keep an excluded value on the list even at count 0, or it cannot be undone.
  for (const value of excluded) if (!counts.has(value)) counts.set(value, 0);

  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: value === EMPTY_FACET ? "(empty)" : value,
      count,
      excluded: excluded.has(value),
    }))
    .sort((a, b) => {
      if (a.value === EMPTY_FACET) return 1;
      if (b.value === EMPTY_FACET) return -1;
      if (field === "decade") return Number(b.value) - Number(a.value);
      return a.label.localeCompare(b.label);
    });
}

/** Toggle one facet value in place, returning whether it is now excluded. */
export function toggleReadingFacet(
  state: ReadingFilterState,
  field: ReadingFacetField,
  value: string,
): boolean {
  const current = [...excludedFor(field, state)];
  const index = current.indexOf(value);
  if (index >= 0) current.splice(index, 1);
  else current.push(value);

  if (field === "status") state.excludedStatuses = current;
  else if (field === "author") state.excludedAuthors = current;
  else if (field === "category") state.excludedCategories = current;
  else if (field === "decade") state.excludedDecades = current;
  else state.excludedColumns = { ...state.excludedColumns, [field.column.id]: current };

  return index < 0;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * The reading sort axes, expressed in the frozen `SortKey` union.
 *
 * `priority` is the author axis — see the header. The other eight mean what
 * they say; the watchlist-only keys (`nextAirDate`, `timeLeft`) are simply not
 * offered, because a book has no next episode.
 */
export const READING_SORT_KEYS: SortKey[] = [
  "title",
  "priority",
  "status",
  "rating",
  "communityRating",
  "progress",
  "dateAdded",
  "dateModified",
  "releaseDate",
  "year",
];

export const READING_SORT_LABELS: Partial<Record<SortKey, string>> = {
  title: "Title",
  priority: "Author",
  status: "Status",
  rating: "My rating",
  communityRating: "Public rating",
  progress: "Progress",
  dateAdded: "Date added",
  dateModified: "Last updated",
  releaseDate: "Release date",
  year: "Year",
};

export const READING_SORT_DEFAULT_DIR: Partial<Record<SortKey, SortDirection>> = {
  title: "asc",
  priority: "asc",
  status: "asc",
  rating: "desc",
  communityRating: "desc",
  progress: "desc",
  dateAdded: "desc",
  dateModified: "desc",
  releaseDate: "desc",
  year: "desc",
};

export function readingSortLabel(key: SortKey): string {
  return READING_SORT_LABELS[key] ?? key;
}

/** Same key → flip; new key → its natural direction (foodspot convention 8). */
export function nextReadingSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: READING_SORT_DEFAULT_DIR[key] ?? "asc" };
}

export function defaultReadingSort(): SortSpec {
  return { key: "title", direction: "asc" };
}

function textKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function timestamp(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `null` is "empty", which sorts last whichever way the arrow points. */
export function readingSortValue(
  entry: ReadingEntry,
  key: SortKey,
  now: Date = new Date(),
): number | string | null {
  switch (key) {
    case "title":
      return textKey(entry.title ?? "") || null;
    case "priority":
      return textKey(authorOf(entry)) || null;
    case "status":
      // The fixed five, in the order the domain declares them.
      return READING_STATUS_ORDER.indexOf(derivedStatus(entry, now));
    case "rating":
      return entry.rating > 0 ? entry.rating : null;
    case "communityRating":
      // Unrated-by-the-public sorts as empty, exactly like an unrated own row.
      return (entry.communityRating ?? 0) > 0 ? (entry.communityRating ?? 0) : null;
    case "progress":
      // 0 % is a real position; "nothing to measure" is not.
      return readingProgress(entry) > 0 || hasTotal(entry) ? readingProgress(entry) : null;
    case "dateAdded":
      return timestamp(entry.dateAdded);
    case "dateModified":
      return timestamp(entry.dateModified);
    case "releaseDate":
      return entry.releaseDate ?? null;
    case "year":
      return yearOf(entry);
    default:
      return null;
  }
}

const READING_STATUS_ORDER: ReadingStatus[] = [
  "Reading",
  "Plan to Read",
  "To be released",
  "Completed",
  "Dropped",
];

function hasTotal(entry: ReadingEntry): boolean {
  if (isBook(entry)) return entry.totalPages > 0 || entry.totalWords > 0;
  return entry.totalChapters > 0 || entry.totalVolumes > 0;
}

function compareValues(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b));
  return a - b;
}

/** Two-level sort, empties last, with a stable id tiebreak. */
export function sortReading(
  entries: readonly ReadingEntry[],
  sort: SortSpec,
  secondary: SortSpec | null = null,
  now: Date = new Date(),
): ReadingEntry[] {
  const flip = sort.direction === "desc" ? -1 : 1;
  const flip2 = secondary?.direction === "desc" ? -1 : 1;

  return [...entries].sort((a, b) => {
    const av = readingSortValue(a, sort.key, now);
    const bv = readingSortValue(b, sort.key, now);
    if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
    const primary = compareValues(av, bv) * flip;
    if (primary !== 0) return primary;

    if (secondary && secondary.key !== sort.key) {
      const a2 = readingSortValue(a, secondary.key, now);
      const b2 = readingSortValue(b, secondary.key, now);
      if ((a2 === null) !== (b2 === null)) return a2 === null ? 1 : -1;
      const rest = compareValues(a2, b2) * flip2;
      if (rest !== 0) return rest;
    }

    const byTitle = textKey(a.title ?? "").localeCompare(textKey(b.title ?? ""));
    if (byTitle !== 0) return byTitle;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Presets — the projection onto the frozen `Preset` shape
// ---------------------------------------------------------------------------

/** `columnId=value`, the encoding the tag slot carries. */
const COLUMN_SEPARATOR = "=";

function emptyFilterState(): FilterState {
  return {
    excludedTypes: [],
    excludedStatuses: [],
    excludedPriorities: [],
    excludedGenres: [],
    excludedTags: [],
    excludedDecades: [],
    excludedPlexStates: [],
    excludedRequestStates: [],
    excludedAiringStates: [],
    minRating: 0,
    favoritesOnly: false,
  };
}

export function toFilterState(state: ReadingFilterState): FilterState {
  const tags: string[] = [];
  for (const [columnId, values] of Object.entries(state.excludedColumns)) {
    for (const value of values) tags.push(`${columnId}${COLUMN_SEPARATOR}${value}`);
  }
  return {
    ...emptyFilterState(),
    excludedStatuses: [...state.excludedStatuses],
    excludedTypes: [...state.excludedAuthors],
    // Categories ride the genre slot — same idea, watchlist vocabulary.
    excludedGenres: [...(state.excludedCategories ?? [])],
    excludedDecades: [...state.excludedDecades],
    excludedTags: tags,
    minRating: state.minRating,
    favoritesOnly: state.favoritesOnly,
  };
}

export function fromFilterState(filters: FilterState): ReadingFilterState {
  const excludedColumns: Record<string, string[]> = {};
  for (const encoded of filters.excludedTags ?? []) {
    const at = encoded.indexOf(COLUMN_SEPARATOR);
    if (at <= 0) continue;
    const columnId = encoded.slice(0, at);
    const value = encoded.slice(at + 1);
    excludedColumns[columnId] = [...(excludedColumns[columnId] ?? []), value];
  }
  return {
    excludedStatuses: [...(filters.excludedStatuses ?? [])],
    excludedAuthors: [...(filters.excludedTypes ?? [])],
    excludedCategories: [...(filters.excludedGenres ?? [])],
    excludedDecades: [...(filters.excludedDecades ?? [])],
    excludedColumns,
    minRating: filters.minRating ?? 0,
    favoritesOnly: filters.favoritesOnly ?? false,
  };
}

export interface ReadingView {
  query: string;
  filters: ReadingFilterState;
  sort: SortSpec;
  secondarySort: SortSpec | null;
}

export function toPreset(name: string, view: ReadingView, id: string): Preset {
  return {
    id,
    name,
    query: view.query,
    filters: toFilterState(view.filters),
    sort: { ...view.sort },
    secondarySort: view.secondarySort ? { ...view.secondarySort } : null,
  };
}

export function fromPreset(preset: Preset): ReadingView {
  return {
    query: preset.query ?? "",
    filters: fromFilterState(preset.filters ?? emptyFilterState()),
    sort: preset.sort ? { ...preset.sort } : defaultReadingSort(),
    secondarySort: preset.secondarySort ? { ...preset.secondarySort } : null,
  };
}

/** Copy the mutable half of a view, so applying a preset cannot alias it. */
export function cloneReadingFilters(state: ReadingFilterState): ReadingFilterState {
  const excludedColumns: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(state.excludedColumns)) {
    excludedColumns[key] = [...values];
  }
  return {
    excludedStatuses: [...state.excludedStatuses],
    excludedAuthors: [...state.excludedAuthors],
    excludedCategories: [...(state.excludedCategories ?? [])],
    excludedDecades: [...state.excludedDecades],
    excludedColumns,
    minRating: state.minRating,
    favoritesOnly: state.favoritesOnly,
  };
}

/** Overwrite `target` in place from `source` — the toolbar holds the reference. */
export function assignReadingFilters(target: ReadingFilterState, source: ReadingFilterState): void {
  const copy = cloneReadingFilters(source);
  target.excludedStatuses = copy.excludedStatuses;
  target.excludedAuthors = copy.excludedAuthors;
  target.excludedCategories = copy.excludedCategories;
  target.excludedDecades = copy.excludedDecades;
  target.excludedColumns = copy.excludedColumns;
  target.minRating = copy.minRating;
  target.favoritesOnly = copy.favoritesOnly;
}
