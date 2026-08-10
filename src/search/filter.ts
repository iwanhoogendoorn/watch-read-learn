/**
 * Facet filtering — the exclusion model, ported from foodspot (SPEC §4.5).
 *
 * `FilterState` records what is **hidden**, never what is shown. That one
 * inversion is the whole design: a genre that appears for the first time
 * tomorrow is visible immediately, because nothing has excluded it yet. An
 * inclusion model silently hides every new value until the user notices.
 *
 * Two rules that fall out of it and are easy to get wrong:
 *
 *   - **Multi-value fields hide only when ALL values are excluded.** A title
 *     tagged `Sci-Fi, Drama` survives excluding `Drama`, because it is still a
 *     Sci-Fi title. Hiding it would make "exclude Drama" mean "hide anything
 *     that is even slightly a drama", which is not what the chip says.
 *   - **`""` is a real facet value**, the synthetic `(empty)` chip. A title with
 *     no tags is `[""]`, so it can be excluded — and, crucially, is *not*
 *     excluded by excluding every named tag.
 *
 * `minRating` has its own rule: unrated titles (rating `0`) always pass. Rating
 * is not a score of zero, it is the absence of a score, and a 4-star filter that
 * hides everything you have not rated yet is useless for deciding what to watch.
 */
import {
  type AiringFilterState,
  type FilterState,
  type PlexState,
  type RequestFilterState,
  type TitleV4,
} from "../types";
import { MediaStatus } from "../types";
import { isTerminalShowStatus } from "../services/airing";

/** The synthetic `(empty)` facet value. */
export const EMPTY_FACET = "";

/** `"2020"` for anything released in the 2020s; `""` when the year is unknown. */
export function decadeOf(title: TitleV4): string {
  const year = title.year ?? (title.releaseDate ? Number(title.releaseDate.slice(0, 4)) : NaN);
  if (!Number.isFinite(year) || year <= 0) return EMPTY_FACET;
  return String(Math.floor(year / 10) * 10);
}

/** Never-checked and unreachable both read as `unknown` — i.e. "no badge". */
export function plexStateOf(title: TitleV4): PlexState {
  return title.plex?.state ?? "unknown";
}

export function requestStateOf(title: TitleV4): RequestFilterState {
  const request = title.request;
  if (!request) return "not-requested";
  if (request.id !== undefined || request.status !== undefined) return "requested";
  // Media that Overseerr is already processing counts as requested even when
  // the request row belongs to somebody else.
  if (request.mediaStatus !== undefined && request.mediaStatus >= MediaStatus.PENDING) {
    return "requested";
  }
  return "not-requested";
}

/**
 * `undefined` means "no airing state at all", which is different from any of
 * the three states — such a title can never be hidden by that facet.
 */
export function airingStateOf(title: TitleV4, now: Date = new Date()): AiringFilterState | undefined {
  const airing = title.airing;
  const today = toDayNumber(now);

  const releaseDate = airing?.digitalReleaseDate ?? title.releaseDate;
  if (releaseDate) {
    const day = parseDayNumber(releaseDate);
    if (day !== undefined && day > today) return "upcoming";
  }

  const next = airing?.nextEpisode?.airDate;
  if (next) {
    const day = parseDayNumber(next);
    if (day !== undefined && day >= today) return "returning";
  }

  if (isTerminalShowStatus(airing?.showStatus)) return "ended";
  if (airing?.showStatus) return "returning";
  return undefined;
}

function parseDayNumber(date: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [, y, m, d] = match;
  return Number(y) * 10000 + Number(m) * 100 + Number(d);
}

function toDayNumber(date: Date): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** Multi-value facet: `[""]` when the title has none, so `(empty)` works. */
function facetValues(values: string[] | undefined): string[] {
  const cleaned = (values ?? []).filter((v) => v !== "");
  return cleaned.length > 0 ? cleaned : [EMPTY_FACET];
}

function hiddenByMultiValue(values: string[], excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  const set = new Set(excluded);
  // Every value excluded → hidden. Any surviving value → shown.
  return values.every((value) => set.has(value));
}

export interface FilterOptions {
  /** Injected for deterministic airing-state tests. */
  now?: Date;
}

export function matchesFilters(
  title: TitleV4,
  filters: FilterState,
  options: FilterOptions = {},
): boolean {
  const now = options.now ?? new Date();

  if (filters.excludedTypes.includes(title.type)) return false;
  if (filters.excludedStatuses.includes(title.status)) return false;
  if (filters.excludedPriorities.includes(title.priority)) return false;
  if (filters.excludedDecades.includes(decadeOf(title))) return false;

  if (hiddenByMultiValue(facetValues(title.genres), filters.excludedGenres)) return false;
  if (hiddenByMultiValue(facetValues(title.tags), filters.excludedTags)) return false;

  if (filters.excludedPlexStates.includes(plexStateOf(title))) return false;
  if (filters.excludedRequestStates.includes(requestStateOf(title))) return false;

  const airingState = airingStateOf(title, now);
  if (airingState !== undefined && filters.excludedAiringStates.includes(airingState)) return false;

  // Unrated always passes — see the header.
  if (filters.minRating > 0 && title.rating > 0 && title.rating < filters.minRating) return false;

  if (filters.favoritesOnly && !title.favorite) return false;

  return true;
}

export function applyFilters(
  titles: readonly TitleV4[],
  filters: FilterState,
  options: FilterOptions = {},
): TitleV4[] {
  return titles.filter((title) => matchesFilters(title, filters, options));
}

/** Number of facets doing something — drives the toolbar's active dot. */
export function countActiveFilters(filters: FilterState): number {
  let count = 0;
  count += filters.excludedTypes.length > 0 ? 1 : 0;
  count += filters.excludedStatuses.length > 0 ? 1 : 0;
  count += filters.excludedPriorities.length > 0 ? 1 : 0;
  count += filters.excludedGenres.length > 0 ? 1 : 0;
  count += filters.excludedTags.length > 0 ? 1 : 0;
  count += filters.excludedDecades.length > 0 ? 1 : 0;
  count += filters.excludedPlexStates.length > 0 ? 1 : 0;
  count += filters.excludedRequestStates.length > 0 ? 1 : 0;
  count += filters.excludedAiringStates.length > 0 ? 1 : 0;
  count += filters.minRating > 0 ? 1 : 0;
  count += filters.favoritesOnly ? 1 : 0;
  return count;
}

export function hasActiveFilters(filters: FilterState): boolean {
  return countActiveFilters(filters) > 0;
}

export interface FacetOption {
  value: string;
  /** `(empty)` for the synthetic value; the value itself otherwise. */
  label: string;
  count: number;
  excluded: boolean;
}

export type FacetField = "type" | "status" | "priority" | "genres" | "tags" | "decade";

function excludedListFor(field: FacetField, filters: FilterState): readonly string[] {
  switch (field) {
    case "type":
      return filters.excludedTypes;
    case "status":
      return filters.excludedStatuses;
    case "priority":
      return filters.excludedPriorities;
    case "genres":
      return filters.excludedGenres;
    case "tags":
      return filters.excludedTags;
    case "decade":
      return filters.excludedDecades;
  }
}

function valuesFor(title: TitleV4, field: FacetField): string[] {
  switch (field) {
    case "type":
      return [title.type];
    case "status":
      return [title.status];
    case "priority":
      return [title.priority];
    case "genres":
      return facetValues(title.genres);
    case "tags":
      return facetValues(title.tags);
    case "decade":
      return [decadeOf(title)];
  }
}

/**
 * Every value present in the data, with counts and current exclusion state.
 *
 * Built from the titles rather than from settings, so a value that only exists
 * on one old title still gets a chip — otherwise it becomes unfilterable.
 */
export function facetOptions(
  titles: readonly TitleV4[],
  field: FacetField,
  filters: FilterState,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const title of titles) {
    for (const value of valuesFor(title, field)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  const excluded = new Set(excludedListFor(field, filters));
  // Anything the user has excluded stays on the list even at count 0, or they
  // could not un-exclude it.
  for (const value of excluded) if (!counts.has(value)) counts.set(value, 0);

  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label: value === EMPTY_FACET ? "(empty)" : value,
      count,
      excluded: excluded.has(value),
    }))
    .sort((a, b) => {
      // `(empty)` sinks to the bottom; decades sort numerically, the rest
      // alphabetically.
      if (a.value === EMPTY_FACET) return 1;
      if (b.value === EMPTY_FACET) return -1;
      if (field === "decade") return Number(b.value) - Number(a.value);
      return a.label.localeCompare(b.label);
    });
}
