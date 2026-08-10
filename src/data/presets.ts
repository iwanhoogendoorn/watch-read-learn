/**
 * Named view presets (SPEC §4.5).
 *
 * v3 had one unnamed slot and foodspot had `settings.savedPreset` — a single
 * preset (`docs/research/report-foodspot.md` §2e). v4 keeps foodspot's real
 * insight, that a preset captures the **whole** view state — query text, every
 * facet and both sort levels — and drops the arbitrary limit of one.
 *
 * Everything here is pure and works on a plain `Preset[]`, so the store, the
 * settings tab and tests all share one model. Two disciplines matter:
 *
 *   - **Deep copies on both edges.** Capturing takes a snapshot the live view
 *     cannot mutate later; applying hands out a copy the preset cannot be
 *     corrupted through. Filter state is arrays; aliasing it is a data-loss bug.
 *   - **List operations mutate in place.** `settings.savedPresets` is a live
 *     array on the preserved settings object (see `types.ts` header) — never
 *     replace it, edit it.
 */
import {
  type FilterState,
  type Preset,
  type SortDirection,
  type SortKey,
  type SortSpec,
} from "../types";
import { DEFAULT_SORT, createFilterState, slugify, uniqueId } from "./schema";

/**
 * Every sort key, in menu order. Declared here because it is the validation
 * vocabulary shared by presets and the widget DSL.
 */
export const SORT_KEYS: readonly SortKey[] = [
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

export const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Name used when a preset is saved with a blank one. */
export const UNTITLED_PRESET_NAME = "Untitled";

/** The complete view state a preset captures. */
export interface PresetView {
  query: string;
  filters: FilterState;
  sort: SortSpec;
  secondarySort: SortSpec | null;
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

export function cloneFilterState(filters: FilterState): FilterState {
  return {
    excludedTypes: [...filters.excludedTypes],
    excludedStatuses: [...filters.excludedStatuses],
    excludedPriorities: [...filters.excludedPriorities],
    excludedGenres: [...filters.excludedGenres],
    excludedTags: [...filters.excludedTags],
    excludedDecades: [...filters.excludedDecades],
    excludedPlexStates: [...filters.excludedPlexStates],
    excludedRequestStates: [...filters.excludedRequestStates],
    excludedAiringStates: [...filters.excludedAiringStates],
    minRating: filters.minRating,
    favoritesOnly: filters.favoritesOnly,
  };
}

export function cloneSort(sort: SortSpec): SortSpec {
  return { key: sort.key, direction: sort.direction };
}

export function cloneView(view: PresetView): PresetView {
  return {
    query: view.query,
    filters: cloneFilterState(view.filters),
    sort: cloneSort(view.sort),
    secondarySort: view.secondarySort ? cloneSort(view.secondarySort) : null,
  };
}

/** Snapshot the live view. Alias for `cloneView`, named for the call site. */
export function captureView(view: PresetView): PresetView {
  return cloneView(view);
}

/** The view a preset restores. Always a fresh copy — apply it as often as you like. */
export function applyPreset(preset: Preset): PresetView {
  return cloneView({
    query: preset.query,
    filters: preset.filters,
    sort: preset.sort,
    secondarySort: preset.secondarySort,
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? UNTITLED_PRESET_NAME : trimmed;
}

/** `preset-` + slug, suffixed on collision — the same id shape groups use. */
export function presetId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `preset-${slugify(normalizeName(name)) || "view"}`;
  return uniqueId(base, used);
}

/** A preset capturing `view`, with an id unique among `taken`. */
export function createPreset(name: string, view: PresetView, taken: Iterable<string> = []): Preset {
  const snapshot = captureView(view);
  return {
    id: presetId(name, taken),
    name: normalizeName(name),
    query: snapshot.query,
    filters: snapshot.filters,
    sort: snapshot.sort,
    secondarySort: snapshot.secondarySort,
  };
}

// ---------------------------------------------------------------------------
// List CRUD — every operation mutates `list` in place
// ---------------------------------------------------------------------------

export function findPreset(list: readonly Preset[], id: string): Preset | undefined {
  return list.find((preset) => preset.id === id);
}

/** Case-insensitive; the settings UI uses it to offer "overwrite" over "add". */
export function findPresetByName(list: readonly Preset[], name: string): Preset | undefined {
  const needle = normalizeName(name).toLowerCase();
  return list.find((preset) => preset.name.toLowerCase() === needle);
}

/** Append a new preset capturing `view`. Returns the stored preset. */
export function addPreset(list: Preset[], name: string, view: PresetView): Preset {
  const preset = createPreset(
    name,
    view,
    list.map((existing) => existing.id),
  );
  list.push(preset);
  return preset;
}

/** Replace a preset's captured state, keeping its id and name. */
export function overwritePreset(list: Preset[], id: string, view: PresetView): Preset | undefined {
  const preset = findPreset(list, id);
  if (!preset) return undefined;
  const snapshot = captureView(view);
  preset.query = snapshot.query;
  preset.filters = snapshot.filters;
  preset.sort = snapshot.sort;
  preset.secondarySort = snapshot.secondarySort;
  return preset;
}

/** Rename in place; the id never changes, so applied presets keep working. */
export function renamePreset(list: Preset[], id: string, name: string): Preset | undefined {
  const preset = findPreset(list, id);
  if (!preset) return undefined;
  preset.name = normalizeName(name);
  return preset;
}

export function deletePreset(list: Preset[], id: string): boolean {
  const index = list.findIndex((preset) => preset.id === id);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Comparison and hardening
// ---------------------------------------------------------------------------

function sortsEqual(a: SortSpec | null, b: SortSpec | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && a.direction === b.direction;
}

function stringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function filterStatesEqual(a: FilterState, b: FilterState): boolean {
  return (
    stringListsEqual(a.excludedTypes, b.excludedTypes) &&
    stringListsEqual(a.excludedStatuses, b.excludedStatuses) &&
    stringListsEqual(a.excludedPriorities, b.excludedPriorities) &&
    stringListsEqual(a.excludedGenres, b.excludedGenres) &&
    stringListsEqual(a.excludedTags, b.excludedTags) &&
    stringListsEqual(a.excludedDecades, b.excludedDecades) &&
    stringListsEqual(a.excludedPlexStates, b.excludedPlexStates) &&
    stringListsEqual(a.excludedRequestStates, b.excludedRequestStates) &&
    stringListsEqual(a.excludedAiringStates, b.excludedAiringStates) &&
    a.minRating === b.minRating &&
    a.favoritesOnly === b.favoritesOnly
  );
}

export function viewsEqual(a: PresetView, b: PresetView): boolean {
  return (
    a.query.trim() === b.query.trim() &&
    filterStatesEqual(a.filters, b.filters) &&
    sortsEqual(a.sort, b.sort) &&
    sortsEqual(a.secondarySort, b.secondarySort)
  );
}

/** True when the live view is exactly what this preset stores — drives `.is-active`. */
export function presetMatchesView(preset: Preset, view: PresetView): boolean {
  return viewsEqual(applyPreset(preset), view);
}

// --- load-time hardening ----------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function sanitizeSort(value: unknown, fallback: SortSpec | null): SortSpec | null {
  if (!value || typeof value !== "object") return fallback;
  const raw = value as { key?: unknown; direction?: unknown };
  const key = SORT_KEYS.find((candidate) => candidate === raw.key);
  if (!key) return fallback;
  const direction = raw.direction === "asc" || raw.direction === "desc" ? raw.direction : "desc";
  return { key, direction };
}

function sanitizeFilterState(value: unknown): FilterState {
  const base = createFilterState();
  if (!value || typeof value !== "object") return base;
  const raw = value as Record<string, unknown>;
  base.excludedTypes = asStringArray(raw.excludedTypes);
  base.excludedStatuses = asStringArray(raw.excludedStatuses);
  base.excludedPriorities = asStringArray(raw.excludedPriorities);
  base.excludedGenres = asStringArray(raw.excludedGenres);
  base.excludedTags = asStringArray(raw.excludedTags);
  base.excludedDecades = asStringArray(raw.excludedDecades);
  base.excludedPlexStates = asStringArray(raw.excludedPlexStates) as FilterState["excludedPlexStates"];
  base.excludedRequestStates = asStringArray(
    raw.excludedRequestStates,
  ) as FilterState["excludedRequestStates"];
  base.excludedAiringStates = asStringArray(
    raw.excludedAiringStates,
  ) as FilterState["excludedAiringStates"];
  base.minRating =
    typeof raw.minRating === "number" && Number.isFinite(raw.minRating)
      ? Math.min(5, Math.max(0, raw.minRating))
      : 0;
  base.favoritesOnly = raw.favoritesOnly === true;
  return base;
}

/**
 * Turn whatever is on disk into a valid preset list: drops entries that are not
 * objects, backfills missing state and re-issues duplicate or missing ids.
 */
export function sanitizePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) return [];
  const out: Preset[] = [];
  const taken = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const name = normalizeName(typeof raw.name === "string" ? raw.name : "");
    let id = typeof raw.id === "string" && raw.id !== "" ? raw.id : presetId(name, taken);
    if (taken.has(id)) id = uniqueId(id, taken);
    taken.add(id);
    out.push({
      id,
      name,
      query: typeof raw.query === "string" ? raw.query : "",
      filters: sanitizeFilterState(raw.filters),
      sort: sanitizeSort(raw.sort, { ...DEFAULT_SORT }) ?? { ...DEFAULT_SORT },
      secondarySort: sanitizeSort(raw.secondarySort, null),
    });
  }
  return out;
}
