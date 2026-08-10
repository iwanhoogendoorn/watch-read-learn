/**
 * Facets, the time window, sorting and saved views for the Upcoming tab.
 *
 * Upcoming was the last tab without a toolbar: Library, Reading and Games all
 * have search, facets, sort and presets, and this is the same model over rows
 * that are *events* rather than entities. Everything the Library's `facets.ts`
 * is disciplined about is kept, because the reasons are the same:
 *
 *   1. **Exclusion, not inclusion** (foodspot §2a). State records what is
 *      hidden, so a type — or a whole library — that appears for the first time
 *      tomorrow is visible immediately instead of invisible until ticked.
 *   2. **`(empty)` is a real facet value.** A title with no type recorded is
 *      filterable, and is *not* hidden by excluding every named type.
 *   3. **Nothing is hidden by default.** The time window starts at `All`,
 *      because a filter the user did not set must never cost them a row.
 *
 * The one Upcoming-specific axis is the **time window**, and it is a single
 * choice rather than an exclusion list: the windows overlap ("next 7 days" is
 * inside "next 30 days"), so excluding a subset of them means nothing.
 *
 * Note what `All` does *not* mean: the tab is a list of what is still to come,
 * so rows that have already arrived are not mixed into it — `hasArrived` splits
 * them out into the "Recently released" section underneath. `All` shows both
 * sections; the `Recently released` window shows only the second one.
 *
 * Pure module: no obsidian, no DOM. `tab`-side rendering lives in
 * `ui/tabs/upcoming.ts`.
 */
import {
  isFullyWatched,
  sanitizeWatchedEpisodes,
  seasonEpisodes,
} from "../../data/episodes";
import { derivedStatus, STATUS_COMPLETED } from "../reading/progress";
import { GAME_STATUS_FINISHED } from "../games/stats";
import { plexStateOf } from "../../ui/components/facets";
import { MediaStatus, readExtra, writeExtra } from "../../types";
import type { Settings, SortDirection, TitleV4 } from "../../types";
import {
  upcomingStateOf,
  UPCOMING_KIND_LABELS,
  UPCOMING_STATE_LABELS,
  type UnifiedRow,
  type UpcomingRowKind,
  type UpcomingSource,
  type UpcomingState,
} from "./unified";

/** The synthetic `(empty)` facet value, same convention as every other tab. */
export const EMPTY_FACET = "";
export const EMPTY_FACET_LABEL = "(empty)";

// ---------------------------------------------------------------------------
// The time window
// ---------------------------------------------------------------------------

export type UpcomingWindow = "all" | "7d" | "30d" | "3m" | "year" | "past";

export const UPCOMING_WINDOW_LABELS: Record<UpcomingWindow, string> = {
  all: "All",
  "7d": "Next 7 days",
  "30d": "Next 30 days",
  "3m": "Next 3 months",
  year: "This year",
  past: "Recently released",
};

/** Menu order. `All` first because it is the default and the widest. */
export const UPCOMING_WINDOWS: readonly UpcomingWindow[] = [
  "all",
  "7d",
  "30d",
  "3m",
  "year",
  "past",
];

const WINDOW_DAYS: Partial<Record<UpcomingWindow, number>> = {
  "7d": 7,
  "30d": 30,
  "3m": 92,
};

/**
 * Is this row inside the chosen window?
 *
 * Two rules worth stating, because both are surprising the other way round:
 *
 *   - a **forward** window (7 days / 30 days / 3 months / this year) excludes
 *     rows that have already arrived. "The next 7 days" is a question about the
 *     future, and last Tuesday's episode is not an answer to it;
 *   - an **undated** announcement is in `All` and in nothing else. It cannot be
 *     placed on a calendar, so no bounded window can honestly claim it.
 */
export function withinWindow(
  row: Pick<UnifiedRow, "daysUntil" | "date">,
  window: UpcomingWindow,
  now: Date = new Date(),
): boolean {
  if (window === "all") return true;
  const days = row.daysUntil;
  if (days === null) return false;
  if (window === "past") return days < 0;
  if (days < 0) return false;
  const span = WINDOW_DAYS[window];
  if (span !== undefined) return days <= span;
  // "This year" is the calendar year, not the next 365 days: in November it is
  // a much smaller question than "the next twelve months", which is the point.
  const year = Number(row.date?.slice(0, 4));
  return Number.isFinite(year) && year === now.getFullYear();
}

// ---------------------------------------------------------------------------
// Row derivations — one function per facet, shared by chips and the predicate
// ---------------------------------------------------------------------------

export type UpcomingAvailability = "plex" | "queued" | "not-plex";

export const UPCOMING_AVAILABILITY_LABELS: Record<UpcomingAvailability, string> = {
  plex: "On Plex",
  queued: "Queued for download",
  "not-plex": "Not on Plex",
};

export const UPCOMING_SOURCE_LABELS: Record<UpcomingSource, string> = {
  watchlist: "Watchlist",
  reading: "Reading",
  games: "Games",
};

/** The watchlist title behind a row, when there is one. */
export function titleOf(row: UnifiedRow): TitleV4 | null {
  return row.entry.source === "watchlist" ? row.entry.value.title : null;
}

/**
 * Is something actually coming for this title?
 *
 * Two independent signals, in this order:
 *
 *   1. **`mediaStatus`** — Overseerr's view of the *media*, which is also the
 *      answer to "is Radarr/Sonarr already on it?". Overseerr's service scans
 *      import whatever those instances hold, so a show added straight to Sonarr
 *      reports `PROCESSING` here with **no request row anywhere**. That is the
 *      case this function exists for, and it needs no Radarr/Sonarr API key of
 *      its own: `PENDING` (awaiting approval), `PROCESSING` (grabbing it) and
 *      `PARTIALLY_AVAILABLE` (some of it landed, the rest is coming) all mean
 *      "wait, do not request".
 *   2. **the request row** — only consulted when the media says nothing useful.
 *      `AVAILABLE` and `DELETED` are not "coming"; a **declined** or **failed**
 *      request is not either, and those rows get the Request button back,
 *      because asking again is the one thing that can change the answer.
 */
export function isQueuedForDownload(title: TitleV4): boolean {
  const request = title.request;
  if (!request) return false;

  const media = request.mediaStatus;
  if (media !== undefined) {
    // Compared as a range rather than matched by name on purpose: the integers
    // above AVAILABLE have moved between Overseerr versions (this vault's server
    // reports `7` for a title Overseerr has dropped, our enum calls 6 DELETED),
    // and every one of them means the same thing here — nothing is coming.
    if (media >= MediaStatus.PENDING && media <= MediaStatus.PARTIALLY_AVAILABLE) return true;
    if (media >= MediaStatus.AVAILABLE) return false;
  }

  // Declined (3) and failed (4) — `MediaRequestStatus`, not `MediaStatus`.
  if (request.status === 3 || request.status === 4) return false;
  return request.id !== undefined || request.requestedAt !== undefined;
}

/**
 * Availability, in the three states a person can act on.
 *
 * On Plex (watch it) · Queued for download (wait) · Not on Plex (request it).
 *
 * **`unknown` counts as "Not on Plex".** The cache distinguishes "we scanned and
 * it is absent" (`none`) from "the scan could not answer" (`unknown` — Plex
 * unreachable, unconfigured, or no match), and that distinction is right for the
 * *cache*: a timeout is not evidence of absence, which is why a blip never
 * rewrites `none`. But as a filter there are only two useful answers, "it is
 * there" and "it is not there yet", and a row nobody can confirm belongs with
 * the second. The cost is worth stating: while Plex is unreachable everything
 * reads Not on Plex and offers a Request button.
 *
 * Books and games are never on Plex, so they are `not-plex` too. Nothing offers
 * to request them — that affordance only exists on watchlist rows.
 */
export function availabilityOfTitle(title: TitleV4): UpcomingAvailability {
  const plex = plexStateOf(title);
  if (plex === "available" || plex === "partial") return "plex";
  if (isQueuedForDownload(title)) return "queued";
  return "not-plex";
}

export function availabilityOf(row: UnifiedRow): UpcomingAvailability {
  const title = titleOf(row);
  return title ? availabilityOfTitle(title) : "not-plex";
}

/**
 * The media type, in each library's own vocabulary.
 *
 * A show's configured type (`TV Show`, `Anime`, …) for the watchlist, and the
 * noun for the other two — a book is a Book, not whatever genre it carries.
 */
export function typeOf(row: UnifiedRow): string {
  switch (row.entry.source) {
    case "watchlist":
      return row.entry.value.title.type.trim();
    case "reading":
      return row.entry.kind === "manga" ? "Manga" : "Book";
    default:
      return "Game";
  }
}

export function favoriteOf(row: UnifiedRow): boolean {
  switch (row.entry.source) {
    case "watchlist":
      return row.entry.value.title.favorite === true;
    case "reading":
      return row.entry.value.favorite === true;
    default:
      return row.entry.value.game.favorite === true;
  }
}

export function stateOf(row: UnifiedRow): UpcomingState {
  return upcomingStateOf(row.daysUntil);
}

/**
 * Has this row already arrived?
 *
 * The split the tab renders on: the list is what is **still to come**, and what
 * has landed in the past week lives in its own "Recently released" section
 * below it. An undated announcement is not in the past — it is future news with
 * no date yet — so it stays with the list.
 */
export function hasArrived(row: Pick<UnifiedRow, "daysUntil">): boolean {
  return row.daysUntil !== null && row.daysUntil < 0;
}

// ---------------------------------------------------------------------------
// Watched / not watched
// ---------------------------------------------------------------------------

export type UpcomingWatchState = "watched" | "unwatched";

/**
 * The chips say Watched / Not watched, and mean the same thing in each library:
 * **finished**. The episode ticked off, the book completed, the game finished.
 */
export const UPCOMING_WATCH_LABELS: Record<UpcomingWatchState, string> = {
  watched: "Watched",
  unwatched: "Not watched",
};

/** `season`/`episode` as upstream numbers them → the tracker's absolute number. */
export function absoluteEpisodeOf(
  title: TitleV4,
  seasonNumber: number | undefined,
  episodeNumber: number,
): number | null {
  if (episodeNumber <= 0) return null;
  for (let index = 0; index < title.seasons.length; index += 1) {
    const season = title.seasons[index];
    if (!season) continue;
    if ((season.seasonNumber ?? index + 1) !== (seasonNumber ?? index + 1)) continue;
    if (episodeNumber > season.episodes) return null;
    return season.offset + episodeNumber;
  }
  return null;
}

/**
 * Watched-ness **of the thing the row is about**, not of the whole entry.
 *
 * That distinction is the point on this tab: an episode that aired on Friday is
 * unwatched even when the other forty are ticked, which is exactly the row you
 * want "Not watched" to leave on screen. A season nobody has episodes for yet,
 * and anything still in the future, is simply not watched.
 */
export function watchStateOf(row: UnifiedRow): UpcomingWatchState {
  switch (row.entry.source) {
    case "watchlist": {
      const entry = row.entry.value;
      const title = entry.title;
      const watched = new Set(sanitizeWatchedEpisodes(title));
      if (entry.kind === "episode" && entry.episodeNumber !== undefined) {
        const absolute = absoluteEpisodeOf(title, entry.seasonNumber, entry.episodeNumber);
        // A season the tracker does not hold yet cannot have been watched.
        return absolute !== null && watched.has(absolute) ? "watched" : "unwatched";
      }
      if (entry.kind === "season") {
        const index = title.seasons.findIndex(
          (season, i) => (season.seasonNumber ?? i + 1) === entry.seasonNumber,
        );
        if (index < 0) return "unwatched";
        const episodes = seasonEpisodes(title, index);
        return episodes.length > 0 && episodes.every((ep) => watched.has(ep))
          ? "watched"
          : "unwatched";
      }
      // A release row is about the whole thing — a film, or a first airing.
      return isFullyWatched(title) ? "watched" : "unwatched";
    }
    case "reading":
      return derivedStatus(row.entry.value) === STATUS_COMPLETED ? "watched" : "unwatched";
    default:
      return row.entry.value.game.status === GAME_STATUS_FINISHED ? "watched" : "unwatched";
  }
}

/**
 * When this row's news last arrived, as an epoch ms — the "recently announced"
 * sort axis.
 *
 * None of the three libraries records "announced at": the closest honest signal
 * is when the schedule was last confirmed upstream (`airing.checkedAt`, which a
 * background refresh writes and a user edit does not), falling back to when the
 * entry itself was last touched. `null` when neither exists, which sorts last.
 */
export function announcedAtOf(row: UnifiedRow): number | null {
  const stamps: (string | undefined)[] = [];
  switch (row.entry.source) {
    case "watchlist":
      stamps.push(row.entry.value.title.airing?.checkedAt, row.entry.value.title.dateModified);
      break;
    case "reading":
      stamps.push(row.entry.value.dateModified, row.entry.value.dateAdded);
      break;
    default:
      stamps.push(row.entry.value.game.dateModified, row.entry.value.game.dateAdded);
  }
  for (const stamp of stamps) {
    if (!stamp) continue;
    const parsed = Date.parse(stamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

export interface UpcomingFilterState {
  excludedDomains: UpcomingSource[];
  excludedKinds: UpcomingRowKind[];
  excludedStates: UpcomingState[];
  excludedAvailability: UpcomingAvailability[];
  excludedWatchStates: UpcomingWatchState[];
  /** Media types as strings; `""` is the `(empty)` chip. */
  excludedTypes: string[];
  favoritesOnly: boolean;
  /** Never anything but `all` by default — a default must not hide data. */
  window: UpcomingWindow;
}

export function createUpcomingFilterState(): UpcomingFilterState {
  return {
    excludedDomains: [],
    excludedKinds: [],
    excludedStates: [],
    excludedAvailability: [],
    excludedWatchStates: [],
    excludedTypes: [],
    favoritesOnly: false,
    window: "all",
  };
}

/** Reset in place — the toolbar holds this exact object by reference. */
export function clearUpcomingFilters(state: UpcomingFilterState): void {
  state.excludedDomains = [];
  state.excludedKinds = [];
  state.excludedStates = [];
  state.excludedAvailability = [];
  state.excludedWatchStates = [];
  state.excludedTypes = [];
  state.favoritesOnly = false;
  state.window = "all";
}

/** Anything narrowing the list at all — the active dot and the × button. */
export function isUpcomingFilterActive(state: UpcomingFilterState): boolean {
  return (
    state.excludedDomains.length > 0 ||
    state.excludedKinds.length > 0 ||
    state.excludedStates.length > 0 ||
    state.excludedAvailability.length > 0 ||
    state.excludedWatchStates.length > 0 ||
    state.excludedTypes.length > 0 ||
    state.favoritesOnly ||
    state.window !== "all"
  );
}

export function cloneUpcomingFilters(state: UpcomingFilterState): UpcomingFilterState {
  return {
    excludedDomains: [...state.excludedDomains],
    excludedKinds: [...state.excludedKinds],
    excludedStates: [...state.excludedStates],
    excludedAvailability: [...state.excludedAvailability],
    excludedWatchStates: [...state.excludedWatchStates],
    excludedTypes: [...state.excludedTypes],
    favoritesOnly: state.favoritesOnly,
    window: state.window,
  };
}

/** Overwrite in place, so applying a preset cannot alias the toolbar's state. */
export function assignUpcomingFilters(
  target: UpcomingFilterState,
  source: UpcomingFilterState,
): void {
  const copy = cloneUpcomingFilters(source);
  target.excludedDomains = copy.excludedDomains;
  target.excludedKinds = copy.excludedKinds;
  target.excludedStates = copy.excludedStates;
  target.excludedAvailability = copy.excludedAvailability;
  target.excludedWatchStates = copy.excludedWatchStates;
  target.excludedTypes = copy.excludedTypes;
  target.favoritesOnly = copy.favoritesOnly;
  target.window = copy.window;
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

export function matchesUpcomingFilters(
  row: UnifiedRow,
  state: UpcomingFilterState,
  now: Date = new Date(),
): boolean {
  if (state.favoritesOnly && !favoriteOf(row)) return false;
  if (!withinWindow(row, state.window, now)) return false;
  if (state.excludedDomains.includes(row.source)) return false;
  if (state.excludedKinds.includes(row.kind)) return false;
  if (state.excludedStates.includes(stateOf(row))) return false;
  if (state.excludedAvailability.includes(availabilityOf(row))) return false;
  if (state.excludedWatchStates.includes(watchStateOf(row))) return false;
  if (state.excludedTypes.includes(typeOf(row))) return false;
  return true;
}

export function applyUpcomingFilters(
  rows: readonly UnifiedRow[],
  state: UpcomingFilterState,
  now: Date = new Date(),
): UnifiedRow[] {
  return rows.filter((row) => matchesUpcomingFilters(row, state, now));
}

// ---------------------------------------------------------------------------
// Facet sections
// ---------------------------------------------------------------------------

export type UpcomingFacetKey =
  | "domains"
  | "kinds"
  | "states"
  | "availability"
  | "watched"
  | "types";

export interface UpcomingFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface UpcomingFacetSection {
  key: UpcomingFacetKey;
  label: string;
  options: UpcomingFacetOption[];
}

/** The excluded array behind one facet key. */
export function excludedForUpcoming(
  state: UpcomingFilterState,
  key: UpcomingFacetKey,
): string[] {
  switch (key) {
    case "domains":
      return state.excludedDomains;
    case "kinds":
      return state.excludedKinds;
    case "states":
      return state.excludedStates;
    case "availability":
      return state.excludedAvailability;
    case "watched":
      return state.excludedWatchStates;
    case "types":
      return state.excludedTypes;
  }
}

export function setExcludedForUpcoming(
  state: UpcomingFilterState,
  key: UpcomingFacetKey,
  values: string[],
): void {
  switch (key) {
    case "domains":
      state.excludedDomains = values as UpcomingSource[];
      break;
    case "kinds":
      state.excludedKinds = values as UpcomingRowKind[];
      break;
    case "states":
      state.excludedStates = values as UpcomingState[];
      break;
    case "availability":
      state.excludedAvailability = values as UpcomingAvailability[];
      break;
    case "watched":
      state.excludedWatchStates = values as UpcomingWatchState[];
      break;
    case "types":
      state.excludedTypes = values;
      break;
  }
}

function count<T extends string>(
  rows: readonly UnifiedRow[],
  pick: (row: UnifiedRow) => T,
): Map<T, number> {
  const counts = new Map<T, number>();
  for (const row of rows) {
    const value = pick(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Options for one facet, in a declared order, **dropping values nothing has**.
 *
 * A chip for a library you do not use, or an event kind nothing produces, is a
 * dead control: clicking it can only ever change nothing. An excluded value is
 * kept even at count 0, because otherwise the exclusion could not be undone.
 */
function options<T extends string>(
  order: readonly T[],
  counts: Map<T, number>,
  labels: Record<T, string>,
  excluded: readonly string[],
): UpcomingFacetOption[] {
  const out: UpcomingFacetOption[] = [];
  for (const value of order) {
    const n = counts.get(value) ?? 0;
    if (n === 0 && !excluded.includes(value)) continue;
    out.push({ value, label: labels[value], count: n });
  }
  return out;
}

const SOURCE_ORDER: readonly UpcomingSource[] = ["watchlist", "reading", "games"];
const KIND_ORDER: readonly UpcomingRowKind[] = ["episode", "season", "release"];
const STATE_ORDER: readonly UpcomingState[] = ["due", "scheduled", "announced"];
const AVAILABILITY_ORDER: readonly UpcomingAvailability[] = ["plex", "queued", "not-plex"];
const WATCH_ORDER: readonly UpcomingWatchState[] = ["unwatched", "watched"];

/**
 * Every facet section, with live counts, built from the **unfiltered** pool.
 *
 * Counts describe the pool, not the current result — that is what makes a chip
 * predictable ("excluding Games removes those 4 rows") instead of a number that
 * moves as you click other facets.
 */
export function buildUpcomingFacetSections(
  rows: readonly UnifiedRow[],
  state: UpcomingFilterState = createUpcomingFilterState(),
): UpcomingFacetSection[] {
  const typeCounts = count(rows, typeOf);
  const typeValues = [...typeCounts.keys()]
    .filter((value) => value !== EMPTY_FACET)
    .sort((a, b) => a.localeCompare(b));
  for (const value of state.excludedTypes) {
    if (value !== EMPTY_FACET && !typeValues.includes(value)) typeValues.push(value);
  }
  const typeOptions: UpcomingFacetOption[] = typeValues.map((value) => ({
    value,
    label: value,
    count: typeCounts.get(value) ?? 0,
  }));
  // `(empty)` last, and only when it means something — the same rule the other
  // tabs' string facets follow.
  const emptyCount = typeCounts.get(EMPTY_FACET) ?? 0;
  if (emptyCount > 0 || state.excludedTypes.includes(EMPTY_FACET)) {
    typeOptions.push({ value: EMPTY_FACET, label: EMPTY_FACET_LABEL, count: emptyCount });
  }

  return [
    {
      key: "domains",
      label: "Library",
      options: options(
        SOURCE_ORDER,
        count(rows, (row) => row.source),
        UPCOMING_SOURCE_LABELS,
        state.excludedDomains,
      ),
    },
    {
      key: "kinds",
      label: "Event",
      options: options(
        KIND_ORDER,
        count(rows, (row) => row.kind),
        UPCOMING_KIND_LABELS,
        state.excludedKinds,
      ),
    },
    {
      key: "states",
      label: "State",
      options: options(STATE_ORDER, count(rows, stateOf), UPCOMING_STATE_LABELS, state.excludedStates),
    },
    {
      key: "availability",
      label: "Availability",
      options: options(
        AVAILABILITY_ORDER,
        count(rows, availabilityOf),
        UPCOMING_AVAILABILITY_LABELS,
        state.excludedAvailability,
      ),
    },
    {
      key: "watched",
      label: "Watched",
      options: options(
        WATCH_ORDER,
        count(rows, watchStateOf),
        UPCOMING_WATCH_LABELS,
        state.excludedWatchStates,
      ),
    },
    { key: "types", label: "Type", options: typeOptions },
  ];
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type UpcomingSortKey = "date" | "title" | "domain" | "announced";

export interface UpcomingSortSpec {
  key: UpcomingSortKey;
  direction: SortDirection;
}

export const UPCOMING_SORT_KEYS: readonly UpcomingSortKey[] = [
  "date",
  "title",
  "domain",
  "announced",
];

export const UPCOMING_SORT_LABELS: Record<UpcomingSortKey, string> = {
  date: "Air / release date",
  title: "Title",
  domain: "Library",
  announced: "Recently announced",
};

/** Soonest first is the whole point of the tab; the rest follow their nature. */
export const UPCOMING_SORT_DEFAULT_DIR: Record<UpcomingSortKey, SortDirection> = {
  date: "asc",
  title: "asc",
  domain: "asc",
  announced: "desc",
};

export function defaultUpcomingSort(): UpcomingSortSpec {
  return { key: "date", direction: "asc" };
}

export function upcomingSortLabel(key: UpcomingSortKey): string {
  return UPCOMING_SORT_LABELS[key] ?? key;
}

/** `YYYY-MM-DD` → a comparable number, or `null` when there is no date. */
function dayNumber(date: string | null): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  return Number(y) * 10000 + Number(m) * 100 + Number(d);
}

function textKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** `null` is "empty", which sorts last whichever way the arrow points. */
export function upcomingSortValue(
  row: UnifiedRow,
  key: UpcomingSortKey,
): number | string | null {
  switch (key) {
    case "date":
      return dayNumber(row.date);
    case "title":
      return textKey(row.name) || null;
    case "domain":
      return SOURCE_ORDER.indexOf(row.source);
    case "announced":
      return announcedAtOf(row);
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
 * Two-level sort, empties last, deterministic.
 *
 * The empties-last rule matters more here than anywhere else in the plugin: an
 * announced-but-undated season has no date, and under `date desc` it would
 * otherwise sit at the very top of a list whose entire job is chronology.
 */
export function sortUpcomingRows(
  rows: readonly UnifiedRow[],
  sort: UpcomingSortSpec,
  secondary: UpcomingSortSpec | null = null,
): UnifiedRow[] {
  const flip = sort.direction === "desc" ? -1 : 1;
  const flip2 = secondary?.direction === "desc" ? -1 : 1;

  return [...rows].sort((a, b) => {
    const av = upcomingSortValue(a, sort.key);
    const bv = upcomingSortValue(b, sort.key);
    if ((av === null) !== (bv === null)) return av === null ? 1 : -1;
    const primary = compareValues(av, bv) * flip;
    if (primary !== 0) return primary;

    if (secondary && secondary.key !== sort.key) {
      const a2 = upcomingSortValue(a, secondary.key);
      const b2 = upcomingSortValue(b, secondary.key);
      if ((a2 === null) !== (b2 === null)) return a2 === null ? 1 : -1;
      const rest = compareValues(a2, b2) * flip2;
      if (rest !== 0) return rest;
    }

    const byName = textKey(a.name).localeCompare(textKey(b.name));
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Saved views and persistence
// ---------------------------------------------------------------------------

/**
 * A named Upcoming view — the whole toolbar in one click.
 *
 * Its own shape rather than the watchlist `Preset`: that carries a `FilterState`
 * and a `SortSpec`, and neither can express a time window or a `domain` sort
 * axis. Reading projects onto `Preset` because `ReadingSettings.savedPresets` is
 * typed for it; nothing types this one, so it says what it means.
 */
export interface UpcomingPreset {
  id: string;
  name: string;
  query: string;
  filters: UpcomingFilterState;
  sort: UpcomingSortSpec;
  secondarySort: UpcomingSortSpec | null;
}

export interface UpcomingView {
  query: string;
  filters: UpcomingFilterState;
  sort: UpcomingSortSpec;
  secondarySort: UpcomingSortSpec | null;
}

export interface UpcomingViewState extends UpcomingView {
  presets: UpcomingPreset[];
}

/**
 * Where the view state lives.
 *
 * `Settings` is a frozen contract with nowhere to put an Upcoming filter state,
 * so it lives beside it under a key of its own — the same escape hatch the Games
 * tab uses (`GamesViewState`), and the same property being *used* rather than
 * worked around: unknown keys round-trip through load and save untouched.
 */
export const UPCOMING_VIEW_STATE_KEY = "v4UpcomingView";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList<T extends string>(value: unknown, allowed?: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (allowed && !allowed.includes(item as T)) continue;
    out.push(item as T);
  }
  return out;
}

/**
 * The four-state availability model this replaced, as it may sit in a saved
 * view on disk: `requested` became `queued`, and `unknown` folded into
 * `not-plex`. A stored filter must keep meaning what it meant.
 */
function renamedAvailability(value: unknown): unknown {
  if (value === "requested") return "queued";
  if (value === "unknown") return "not-plex";
  return value;
}

export function normalizeUpcomingFilters(raw: unknown): UpcomingFilterState {
  const state = createUpcomingFilterState();
  if (typeof raw !== "object" || raw === null) return state;
  const rec = raw as Record<string, unknown>;
  state.excludedDomains = stringList(rec.excludedDomains, SOURCE_ORDER);
  state.excludedKinds = stringList(rec.excludedKinds, KIND_ORDER);
  state.excludedStates = stringList(rec.excludedStates, STATE_ORDER);
  state.excludedAvailability = stringList(
    (Array.isArray(rec.excludedAvailability) ? rec.excludedAvailability : []).map(renamedAvailability),
    AVAILABILITY_ORDER,
  );
  state.excludedWatchStates = stringList(rec.excludedWatchStates, WATCH_ORDER);
  // Types are user data, so any string is legal — including `""`.
  state.excludedTypes = stringList(rec.excludedTypes);
  state.favoritesOnly = rec.favoritesOnly === true;
  state.window = UPCOMING_WINDOWS.includes(rec.window as UpcomingWindow)
    ? (rec.window as UpcomingWindow)
    : "all";
  return state;
}

export function normalizeUpcomingSort(raw: unknown): UpcomingSortSpec {
  if (typeof raw !== "object" || raw === null) return defaultUpcomingSort();
  const rec = raw as Record<string, unknown>;
  const key = UPCOMING_SORT_KEYS.includes(rec.key as UpcomingSortKey)
    ? (rec.key as UpcomingSortKey)
    : "date";
  const direction: SortDirection = rec.direction === "desc" ? "desc" : "asc";
  return { key, direction };
}

function normalizePreset(raw: unknown, index: number): UpcomingPreset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const name = str(rec.name).trim();
  if (name === "") return null;
  return {
    id: str(rec.id) || `upcoming-preset-${index}`,
    name,
    query: str(rec.query),
    filters: normalizeUpcomingFilters(rec.filters),
    sort: normalizeUpcomingSort(rec.sort),
    secondarySort: rec.secondarySort == null ? null : normalizeUpcomingSort(rec.secondarySort),
  };
}

export function readUpcomingViewState(settings: Settings): UpcomingViewState {
  const raw = readExtra<Record<string, unknown>>(settings, UPCOMING_VIEW_STATE_KEY);
  if (typeof raw !== "object" || raw === null) {
    return {
      query: "",
      filters: createUpcomingFilterState(),
      sort: defaultUpcomingSort(),
      secondarySort: null,
      presets: [],
    };
  }
  return {
    query: str(raw.query),
    filters: normalizeUpcomingFilters(raw.filters),
    sort: normalizeUpcomingSort(raw.sort),
    secondarySort: raw.secondarySort == null ? null : normalizeUpcomingSort(raw.secondarySort),
    presets: Array.isArray(raw.presets)
      ? raw.presets
          .map((preset, index) => normalizePreset(preset, index))
          .filter((preset): preset is UpcomingPreset => preset !== null)
      : [],
  };
}

export function writeUpcomingViewState(settings: Settings, state: UpcomingViewState): void {
  writeExtra(settings, UPCOMING_VIEW_STATE_KEY, {
    query: state.query,
    filters: cloneUpcomingFilters(state.filters),
    sort: { ...state.sort },
    secondarySort: state.secondarySort ? { ...state.secondarySort } : null,
    presets: state.presets.map((preset) => ({
      ...preset,
      filters: cloneUpcomingFilters(preset.filters),
      sort: { ...preset.sort },
      secondarySort: preset.secondarySort ? { ...preset.secondarySort } : null,
    })),
  });
}

export function makeUpcomingPresetId(): string {
  return `upcoming-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Capture the live view. Cloned on the way in, so the preset cannot alias it. */
export function toUpcomingPreset(name: string, view: UpcomingView, id: string): UpcomingPreset {
  return {
    id,
    name,
    query: view.query,
    filters: cloneUpcomingFilters(view.filters),
    sort: { ...view.sort },
    secondarySort: view.secondarySort ? { ...view.secondarySort } : null,
  };
}

/** …and cloned on the way out, for the same reason. */
export function fromUpcomingPreset(preset: UpcomingPreset): UpcomingView {
  return {
    query: preset.query,
    filters: cloneUpcomingFilters(preset.filters),
    sort: { ...preset.sort },
    secondarySort: preset.secondarySort ? { ...preset.secondarySort } : null,
  };
}
