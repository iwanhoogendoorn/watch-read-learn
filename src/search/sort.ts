/**
 * Two-level sorting (SPEC §4.5).
 *
 * Two rules make this different from a plain comparator:
 *
 *   1. **Empty is always last**, in both directions. A title with no rating, no
 *      release date or no scheduled episode sinks to the bottom whether the sort
 *      is ascending or descending. Flipping the direction is a request to
 *      reorder the titles that *have* a value, not to promote a wall of blanks
 *      to the top.
 *   2. **Status and priority follow the user's configured list order**, not the
 *      alphabet. `settings.statuses` is an ordered list — Watching, Plan to
 *      watch, Watched — and sorting by status must honour it. v3 hardcoded its
 *      own order and ignored the user's, which is the bug this fixes.
 *
 * `0` is treated as empty for `rating` (unrated, not "rated zero") and for
 * `timeLeft` (nothing left to watch), but **not** for `progress`, where 0 % is a
 * real, meaningful position at the start of a series.
 */
import { calcTimeRemaining, getEffectiveTotal, getProgress } from "../data/episodes";
import type { SortDirection, SortKey, SortSpec, TitleV4 } from "../types";

export interface SortContext {
  /** `settings.statuses.map(s => s.name)`, in the user's order. */
  statusOrder?: readonly string[];
  /** `settings.priorities.map(p => p.name)`, in the user's order. */
  priorityOrder?: readonly string[];
}

export const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  dateAdded: "Date added",
  dateModified: "Last updated",
  rating: "Rating",
  communityRating: "Public rating",
  progress: "Progress",
  releaseDate: "Release date",
  nextAirDate: "Next episode",
  timeLeft: "Time left",
  year: "Year",
  status: "Status",
  priority: "Priority",
};

/** Sensible starting direction per key: dates and scores newest/highest first. */
export const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
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

export function flipDirection(direction: SortDirection): SortDirection {
  return direction === "asc" ? "desc" : "asc";
}

/** Accent-insensitive, case-insensitive title key. */
function titleKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function timeValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function orderIndex(value: string, order: readonly string[] | undefined): number | null {
  if (value === "") return null;
  if (!order || order.length === 0) return null;
  const index = order.indexOf(value);
  return index >= 0 ? index : null;
}

/** `null` means "empty", which always sorts last. */
export function sortValue(title: TitleV4, key: SortKey, ctx: SortContext = {}): number | string | null {
  switch (key) {
    case "title": {
      const value = titleKey(title.title);
      return value === "" ? null : value;
    }
    case "dateAdded":
      return timeValue(title.dateAdded);
    case "dateModified":
      return timeValue(title.dateModified);
    case "rating":
      // 0 is unrated, not a score.
      return title.rating > 0 ? title.rating : null;
    case "communityRating":
      return title.communityRating > 0 ? title.communityRating : null;
    case "progress":
      // 0 % is a real value; "nothing to progress through" is not.
      return getEffectiveTotal(title) > 0 ? getProgress(title) : null;
    case "releaseDate":
      return title.releaseDate ?? null;
    case "nextAirDate":
      return title.airing?.nextEpisode?.airDate ?? null;
    case "timeLeft": {
      const left = calcTimeRemaining(title);
      return left > 0 ? left : null;
    }
    case "year": {
      const year = title.year ?? (title.releaseDate ? Number(title.releaseDate.slice(0, 4)) : NaN);
      return Number.isFinite(year) && year > 0 ? (year as number) : null;
    }
    case "status":
      return orderIndex(title.status, ctx.statusOrder);
    case "priority":
      return orderIndex(title.priority, ctx.priorityOrder);
  }
}

function compareRaw(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** One sort level. Empty-last is applied here, before the direction. */
export function compareBySpec(a: TitleV4, b: TitleV4, spec: SortSpec, ctx: SortContext = {}): number {
  const left = sortValue(a, spec.key, ctx);
  const right = sortValue(b, spec.key, ctx);

  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const raw = compareRaw(left, right);
  return spec.direction === "desc" ? -raw : raw;
}

/**
 * Primary, then secondary, then a stable tiebreak on title and id.
 *
 * The id tiebreak matters: without it two identically-named titles swap places
 * between renders, which looks like the grid twitching for no reason.
 */
export function sortTitles(
  titles: readonly TitleV4[],
  primary: SortSpec,
  secondary: SortSpec | null = null,
  ctx: SortContext = {},
): TitleV4[] {
  return [...titles].sort((a, b) => {
    const first = compareBySpec(a, b, primary, ctx);
    if (first !== 0) return first;

    if (secondary && secondary.key !== primary.key) {
      const second = compareBySpec(a, b, secondary, ctx);
      if (second !== 0) return second;
    }

    const byTitle = titleKey(a.title).localeCompare(titleKey(b.title));
    if (byTitle !== 0) return byTitle;
    return a.id.localeCompare(b.id);
  });
}

/** `settings` → `SortContext`, so callers do not rebuild it at every call. */
export function sortContextFrom(settings: {
  statuses: { name: string }[];
  priorities: { name: string }[];
}): SortContext {
  return {
    statusOrder: settings.statuses.map((s) => s.name),
    priorityOrder: settings.priorities.map((p) => p.name),
  };
}
