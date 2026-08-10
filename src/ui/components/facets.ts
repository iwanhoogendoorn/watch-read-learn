/**
 * Facet maths for the Library filter panel — the exclusion model, ported from
 * foodspot (`report-foodspot.md` §2a, conventions 1–4).
 *
 * Deliberately **obsidian-free and DOM-free**: `filters.ts` renders these, tests
 * exercise them directly. Every rule that decides whether a title is hidden lives
 * here and nowhere else.
 *
 * The polarity is the point. `FilterState` records what is *hidden*, so a genre
 * or tag that appears for the first time is visible by default instead of
 * invisible until the user goes and ticks it.
 */
import type {
  AiringFilterState,
  FilterState,
  PlexState,
  RequestFilterState,
  Settings,
  TitleV4,
} from "../../types";

/** The synthetic `(empty)` option every string facet carries. */
export const EMPTY_FACET_VALUE = "";
export const EMPTY_FACET_LABEL = "(empty)";

export type FacetKey =
  | "types"
  | "statuses"
  | "priorities"
  | "genres"
  | "tags"
  | "decades"
  | "plex"
  | "request"
  | "airing";

export interface FacetOption {
  value: string;
  label: string;
  /** How many titles in the unfiltered pool carry this value. */
  count: number;
}

export interface FacetSection {
  key: FacetKey;
  label: string;
  options: FacetOption[];
  /** True for genres/tags: a title hides only when *all* its values are excluded. */
  multiValue: boolean;
}

// ---------------------------------------------------------------------------
// Value derivation — one function per facet, shared by rendering and filtering
// ---------------------------------------------------------------------------

/** Release year, from `year` when set, else the first four digits of `releaseDate`. */
export function yearOf(title: TitleV4): number | null {
  if (typeof title.year === "number" && title.year > 0) return title.year;
  if (title.releaseDate) {
    const parsed = Number.parseInt(title.releaseDate.slice(0, 4), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** Decade bucket as a string (`"2020"`), or `""` when the year is unknown. */
export function decadeOf(title: TitleV4): string {
  const year = yearOf(title);
  if (year === null) return EMPTY_FACET_VALUE;
  return String(Math.floor(year / 10) * 10);
}

export function decadeLabel(value: string): string {
  return value === EMPTY_FACET_VALUE ? EMPTY_FACET_LABEL : `${value}s`;
}

export function plexStateOf(title: TitleV4): PlexState {
  return title.plex?.state ?? "unknown";
}

export function requestStateOf(title: TitleV4): RequestFilterState {
  return title.request?.id === undefined ? "not-requested" : "requested";
}

/**
 * Airing bucket, or `null` when the title carries no airing signal at all.
 *
 * `FilterState.excludedAiringStates` is typed to the three real states, so there
 * is no `(empty)` chip here; a title with no signal is simply never hidden by
 * this facet. Documented rather than papered over.
 */
export function airingStateOf(title: TitleV4, now: Date = new Date()): AiringFilterState | null {
  const status = title.airing?.showStatus ?? "";
  if (status === "Ended" || status === "Canceled" || status === "Cancelled") return "ended";

  const today = toDayNumber(now);
  const next = title.airing?.nextEpisode?.airDate;
  if (next && dayNumberOf(next) !== null && (dayNumberOf(next) as number) >= today) return "upcoming";

  const release = title.releaseDate;
  if (release && dayNumberOf(release) !== null && (dayNumberOf(release) as number) > today) {
    return "upcoming";
  }

  if (status === "Returning Series" || status === "In Production" || title.airing?.inProduction) {
    return "returning";
  }
  return null;
}

/** `YYYY-MM-DD` → a comparable day number, or `null` when unparseable. */
export function dayNumberOf(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  if (!y || !m || !d) return null;
  return Number(y) * 10000 + Number(m) * 100 + Number(d);
}

function toDayNumber(now: Date): number {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/** Multi-value fields report `[""]` when empty so the `(empty)` chip works. */
export function genresOf(title: TitleV4): string[] {
  const list = (title.genres ?? []).filter((g) => g.trim() !== "");
  return list.length > 0 ? list : [EMPTY_FACET_VALUE];
}

export function tagsOf(title: TitleV4): string[] {
  const list = title.tags.filter((t) => t.trim() !== "");
  return list.length > 0 ? list : [EMPTY_FACET_VALUE];
}

// ---------------------------------------------------------------------------
// The filter predicate
// ---------------------------------------------------------------------------

/**
 * True when the title survives the facet filters.
 *
 * Rules, all four ported verbatim from foodspot:
 *   - exclusion arrays: empty means "show everything";
 *   - a multi-value field hides a title only when **every** one of its values is
 *     excluded — excluding "Drama" must not hide a Drama/Comedy title;
 *   - `minRating` never hides an unrated title (`rating === 0`);
 *   - `(empty)` is a real, excludable value on every string facet.
 */
export function matchesFilters(
  title: TitleV4,
  state: FilterState,
  now: Date = new Date(),
): boolean {
  if (state.favoritesOnly && !title.favorite) return false;
  if (state.minRating > 0 && title.rating > 0 && title.rating < state.minRating) return false;

  if (state.excludedTypes.includes(title.type)) return false;
  if (state.excludedStatuses.includes(title.status)) return false;
  if (state.excludedPriorities.includes(title.priority)) return false;
  if (state.excludedDecades.includes(decadeOf(title))) return false;

  if (allExcluded(genresOf(title), state.excludedGenres)) return false;
  if (allExcluded(tagsOf(title), state.excludedTags)) return false;

  if (state.excludedPlexStates.includes(plexStateOf(title))) return false;
  if (state.excludedRequestStates.includes(requestStateOf(title))) return false;

  const airing = airingStateOf(title, now);
  if (airing !== null && state.excludedAiringStates.includes(airing)) return false;

  return true;
}

function allExcluded(values: string[], excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  return values.every((v) => excluded.includes(v));
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/** Any facet narrowing the list at all — drives the active dot and the × button. */
export function isFilterActive(state: FilterState): boolean {
  return (
    state.favoritesOnly ||
    state.minRating > 0 ||
    state.excludedTypes.length > 0 ||
    state.excludedStatuses.length > 0 ||
    state.excludedPriorities.length > 0 ||
    state.excludedGenres.length > 0 ||
    state.excludedTags.length > 0 ||
    state.excludedDecades.length > 0 ||
    state.excludedPlexStates.length > 0 ||
    state.excludedRequestStates.length > 0 ||
    state.excludedAiringStates.length > 0
  );
}

/** Reset in place — the settings object holds a live reference to this state. */
export function clearFilters(state: FilterState): void {
  state.excludedTypes = [];
  state.excludedStatuses = [];
  state.excludedPriorities = [];
  state.excludedGenres = [];
  state.excludedTags = [];
  state.excludedDecades = [];
  state.excludedPlexStates = [];
  state.excludedRequestStates = [];
  state.excludedAiringStates = [];
  state.minRating = 0;
  state.favoritesOnly = false;
}

/**
 * The excluded array behind a facet key.
 *
 * The enum facets are typed narrower than `string[]`, but every value written
 * into them originates from the matching `*Of()` derivation above, so the cast is
 * sound and keeps the panel code free of nine near-identical branches.
 */
export function excludedFor(state: FilterState, key: FacetKey): string[] {
  switch (key) {
    case "types":
      return state.excludedTypes;
    case "statuses":
      return state.excludedStatuses;
    case "priorities":
      return state.excludedPriorities;
    case "genres":
      return state.excludedGenres;
    case "tags":
      return state.excludedTags;
    case "decades":
      return state.excludedDecades;
    case "plex":
      return state.excludedPlexStates as unknown as string[];
    case "request":
      return state.excludedRequestStates as unknown as string[];
    case "airing":
      return state.excludedAiringStates as unknown as string[];
  }
}

export function setExcludedFor(state: FilterState, key: FacetKey, values: string[]): void {
  switch (key) {
    case "types":
      state.excludedTypes = values;
      break;
    case "statuses":
      state.excludedStatuses = values;
      break;
    case "priorities":
      state.excludedPriorities = values;
      break;
    case "genres":
      state.excludedGenres = values;
      break;
    case "tags":
      state.excludedTags = values;
      break;
    case "decades":
      state.excludedDecades = values;
      break;
    case "plex":
      state.excludedPlexStates = values as PlexState[];
      break;
    case "request":
      state.excludedRequestStates = values as RequestFilterState[];
      break;
    case "airing":
      state.excludedAiringStates = values as AiringFilterState[];
      break;
  }
}

/** Flip one value's excluded-ness. Returns the new "is shown" state. */
export function toggleFacetValue(state: FilterState, key: FacetKey, value: string): boolean {
  const excluded = excludedFor(state, key);
  const index = excluded.indexOf(value);
  if (index >= 0) {
    setExcludedFor(state, key, excluded.filter((v) => v !== value));
    return true;
  }
  setExcludedFor(state, key, [...excluded, value]);
  return false;
}

export function isFacetValueShown(state: FilterState, key: FacetKey, value: string): boolean {
  return !excludedFor(state, key).includes(value);
}

/** "Start from: Show all" — clear every exclusion array, keep rating/favourites. */
export function showAllFacets(state: FilterState, sections: FacetSection[]): void {
  for (const section of sections) setExcludedFor(state, section.key, []);
}

/**
 * "Start from: Hide all" — exclude every known value, turning the exclusion model
 * into an inclusion workflow ("hide everything, then re-add Sci-Fi").
 */
export function hideAllFacets(state: FilterState, sections: FacetSection[]): void {
  for (const section of sections) {
    setExcludedFor(
      state,
      section.key,
      section.options.map((o) => o.value),
    );
  }
}

// ---------------------------------------------------------------------------
// Section building
// ---------------------------------------------------------------------------

const PLEX_LABELS: Record<PlexState, string> = {
  available: "On Plex",
  partial: "Partly on Plex",
  none: "Not on Plex",
  unknown: "Unchecked",
};

const REQUEST_LABELS: Record<RequestFilterState, string> = {
  requested: "Requested",
  "not-requested": "Not requested",
};

const AIRING_LABELS: Record<AiringFilterState, string> = {
  returning: "Returning",
  upcoming: "Upcoming",
  ended: "Ended",
};

/**
 * Every facet section, with live counts.
 *
 * Type/status/priority options follow the **user's configured list order** (v3
 * hardcoded them), with any value found in the data but missing from settings
 * appended so nothing becomes unfilterable.
 */
export function buildFacetSections(
  titles: readonly TitleV4[],
  settings: Settings,
  now: Date = new Date(),
): FacetSection[] {
  return [
    {
      key: "types",
      label: "Type",
      multiValue: false,
      options: orderedOptions(
        settings.types.map((t) => t.name),
        countSingle(titles, (t) => t.type),
      ),
    },
    {
      key: "statuses",
      label: "Status",
      multiValue: false,
      options: orderedOptions(
        settings.statuses.map((s) => s.name),
        countSingle(titles, (t) => t.status),
      ),
    },
    {
      key: "priorities",
      label: "Priority",
      multiValue: false,
      options: orderedOptions(
        settings.priorities.map((p) => p.name),
        countSingle(titles, (t) => t.priority),
      ),
    },
    {
      key: "genres",
      label: "Genre",
      multiValue: true,
      options: sortedOptions(countMulti(titles, genresOf)),
    },
    {
      key: "tags",
      label: "Tag",
      multiValue: true,
      options: sortedOptions(countMulti(titles, tagsOf)),
    },
    {
      key: "decades",
      label: "Decade",
      multiValue: false,
      options: decadeOptions(countSingle(titles, decadeOf)),
    },
    {
      key: "plex",
      label: "On Plex",
      multiValue: false,
      options: enumOptions(countSingle(titles, plexStateOf), PLEX_LABELS),
    },
    {
      key: "request",
      label: "Request",
      multiValue: false,
      options: enumOptions(countSingle(titles, requestStateOf), REQUEST_LABELS),
    },
    {
      key: "airing",
      label: "Airing",
      multiValue: false,
      options: enumOptions(
        countSingle(titles, (t) => airingStateOf(t, now) ?? "__none__"),
        AIRING_LABELS,
      ),
    },
  ];
}

function countSingle(
  titles: readonly TitleV4[],
  pick: (title: TitleV4) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const value = pick(title);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function countMulti(
  titles: readonly TitleV4[],
  pick: (title: TitleV4) => string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const value of new Set(pick(title))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

/** Configured order first, then anything the data knows about, then `(empty)`. */
function orderedOptions(configured: string[], counts: Map<string, number>): FacetOption[] {
  const out: FacetOption[] = [];
  const seen = new Set<string>();
  for (const name of configured) {
    if (name === EMPTY_FACET_VALUE || seen.has(name)) continue;
    seen.add(name);
    out.push({ value: name, label: name, count: counts.get(name) ?? 0 });
  }
  const extras = [...counts.keys()]
    .filter((v) => v !== EMPTY_FACET_VALUE && !seen.has(v))
    .sort((a, b) => a.localeCompare(b));
  for (const value of extras) {
    out.push({ value, label: value, count: counts.get(value) ?? 0 });
  }
  appendEmpty(out, counts);
  return out;
}

function sortedOptions(counts: Map<string, number>): FacetOption[] {
  const out = [...counts.keys()]
    .filter((v) => v !== EMPTY_FACET_VALUE)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value, count: counts.get(value) ?? 0 }));
  appendEmpty(out, counts);
  return out;
}

function decadeOptions(counts: Map<string, number>): FacetOption[] {
  const out = [...counts.keys()]
    .filter((v) => v !== EMPTY_FACET_VALUE)
    .sort((a, b) => Number(b) - Number(a))
    .map((value) => ({ value, label: decadeLabel(value), count: counts.get(value) ?? 0 }));
  appendEmpty(out, counts);
  return out;
}

function enumOptions(counts: Map<string, number>, labels: Record<string, string>): FacetOption[] {
  return Object.keys(labels)
    .filter((value) => (counts.get(value) ?? 0) > 0)
    .map((value) => ({
      value,
      label: labels[value] ?? value,
      count: counts.get(value) ?? 0,
    }));
}

function appendEmpty(out: FacetOption[], counts: Map<string, number>): void {
  const count = counts.get(EMPTY_FACET_VALUE) ?? 0;
  if (count > 0) out.push({ value: EMPTY_FACET_VALUE, label: EMPTY_FACET_LABEL, count });
}
