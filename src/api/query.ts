/**
 * Query-string parsing for the read-only API routes, as pure functions.
 *
 * Every helper takes the raw `ApiRequest.query` value (always a string, or
 * absent) and either returns a normalised value or throws `ApiError(400)` with
 * a message a script author can act on. Nothing here touches the store, so the
 * rules can be pinned in isolation and shared by any route that filters lists.
 */
import { ApiError } from "./types";
import { todayString } from "../domains/reading/progress";

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

/** What the API calls an item. Anime is a show; manga is not served. */
export type ItemKind = "film" | "show" | "book" | "audiobook";
export const ITEM_KINDS: readonly ItemKind[] = ["film", "show", "book", "audiobook"];

/** The date an item list can be ranged over. `dateFinished` is the default. */
export type DateField = "dateFinished" | "dateAdded" | "dateStarted" | "dateModified";
export const DATE_FIELDS: readonly DateField[] = ["dateFinished", "dateAdded", "dateStarted", "dateModified"];
export const DEFAULT_DATE_FIELD: DateField = "dateFinished";

export interface DateRange {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to?: string;
}

/** An external id taken out of a Plex GUID. */
export type PlexGuid = { source: "tmdb" | "tvdb"; id: number } | { source: "imdb"; id: string };

/** Absent and blank are the same thing to every helper below. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * `limit`: a positive integer, default 200. Anything above 1000 is capped
 * rather than refused — asking for "everything" is a reasonable thing to do.
 */
export function parseLimit(value: string | undefined): number {
  const raw = present(value);
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `limit must be a positive integer, got "${raw}"`);
  const limit = Number(raw);
  if (limit < 1) throw new ApiError(400, "limit must be at least 1");
  return Math.min(limit, MAX_LIMIT);
}

/** `offset`: how many items of the sorted list to skip, default 0. */
export function parseOffset(value: string | undefined): number {
  const raw = present(value);
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `offset must be a whole number of 0 or more, got "${raw}"`);
  return Number(raw);
}

/** The one shape every list answers with: a page of `items`, and `total` matches before paging. */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** Most recently modified first, ties broken by id: what a caller just changed is on page one. */
export function byRecentlyModified(a: Modified, b: Modified): number {
  return (b.dateModified ?? "").localeCompare(a.dateModified ?? "") || a.id.localeCompare(b.id);
}

type Modified = { id: string; dateModified?: string | null };

/** A real calendar date in `YYYY-MM-DD`, or a 400 naming the parameter. */
export function parseIsoDate(value: string | undefined, name: string): string | undefined {
  const raw = present(value);
  if (raw === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return raw;
    }
  }
  throw new ApiError(400, `${name} must be a date in YYYY-MM-DD form, got "${raw}"`);
}

/** `from` / `to`, both inclusive. A range that ends before it starts is a 400. */
export function parseDateRange(query: Record<string, string>): DateRange {
  const from = parseIsoDate(query.from, "from");
  const to = parseIsoDate(query.to, "to");
  if (from && to && from > to) throw new ApiError(400, `from (${from}) is after to (${to})`);
  return { from, to };
}

export function parseDateField(value: string | undefined): DateField {
  const raw = present(value);
  if (raw === undefined) return DEFAULT_DATE_FIELD;
  const field = DATE_FIELDS.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  if (!field) throw new ApiError(400, `dateField must be one of ${DATE_FIELDS.join(", ")}, got "${raw}"`);
  return field;
}

/** `kind=film` or `kind=film,show`; absent means every kind. */
export function parseKinds(value: string | undefined): ItemKind[] | undefined {
  const raw = present(value);
  if (raw === undefined) return undefined;
  const kinds: ItemKind[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    const kind = ITEM_KINDS.find((candidate) => candidate === name);
    if (!kind) throw new ApiError(400, `kind must be one of ${ITEM_KINDS.join(", ")}, got "${part.trim()}"`);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds.length ? kinds : undefined;
}

/**
 * `status=Watched` or `status=Watching,Plan to watch`, lower-cased for a
 * case-insensitive comparison. Each name must be one of `known` (in any case):
 * a misspelt status is a 400, not a list that is quietly empty.
 */
export function parseStatuses(value: string | undefined, known: readonly string[]): string[] | undefined {
  const raw = present(value);
  if (raw === undefined) return undefined;
  const statuses: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!known.some((candidate) => candidate.trim().toLowerCase() === name)) {
      throw new ApiError(400, `status must be one of ${known.join(", ")}, got "${part.trim()}"`);
    }
    if (!statuses.includes(name)) statuses.push(name);
  }
  return statuses.length ? statuses : undefined;
}

export function matchesStatus(status: string, statuses: string[] | undefined): boolean {
  return !statuses || statuses.includes(status.trim().toLowerCase());
}

/**
 * The calendar day a stored date falls on.
 *
 * `dateStarted` / `dateFinished` are already `YYYY-MM-DD`; `dateAdded` /
 * `dateModified` are ISO timestamps, which are read as the local day — the day
 * the user would say they added it, not the UTC one.
 */
export function calendarDay(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return todayString(date);
}

/** True when `day` lies inside the range. No range at all matches undated items too. */
export function inDateRange(day: string | undefined, range: DateRange): boolean {
  if (!range.from && !range.to) return true;
  if (!day) return false;
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}

/**
 * `tmdb://123`, `imdb://tt123` or `tvdb://456` → the id it carries.
 *
 * Plex's own `plex://movie/…` GUIDs are refused outright: WRL never stores
 * them, so accepting one could only ever answer "no match" — which reads as
 * "not in the library" when the truth is "cannot tell".
 */
export function parsePlexGuid(value: string): PlexGuid {
  const raw = value.trim();
  if (/^plex:\/\//i.test(raw)) {
    throw new ApiError(400, "plex:// GUIDs are not stored; use plexRatingKey or a tmdb/imdb/tvdb GUID");
  }
  const match = /^(tmdb|imdb|tvdb):\/\/([^?#/]+)$/i.exec(raw);
  if (match) {
    const source = (match[1] ?? "").toLowerCase();
    const id = match[2] ?? "";
    if (source === "imdb" && /^tt\d+$/i.test(id)) return { source: "imdb", id: id.toLowerCase() };
    if ((source === "tmdb" || source === "tvdb") && /^\d+$/.test(id) && Number(id) > 0) {
      return { source, id: Number(id) };
    }
  }
  throw new ApiError(400, `plexGuid must look like tmdb://123, imdb://tt123 or tvdb://456, got "${raw}"`);
}
