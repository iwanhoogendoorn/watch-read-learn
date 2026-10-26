/**
 * Cross-domain reads: `/search`, `/lookup` and `/items`.
 *
 * These three answer "what do I have?" across films, shows, books and
 * audiobooks at once, so they cannot borrow the per-domain serialisers — each
 * match comes back in one small summary shape instead, enough to decide which
 * domain route to call next. Every route here is read-only: nothing calls
 * `save()`, `flush()` or a mutating store method, and the tests pin that.
 */
import { isSingleSitting } from "../../data/review";
import { derivedStatus } from "../../domains/reading/progress";
import { norm } from "../../search/query";
import { readExtra, type Book, type TitleV4 } from "../../types";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse, type RouteHandler } from "../types";
import {
  calendarDay,
  inDateRange,
  matchesStatus,
  parseDateField,
  parseDateRange,
  parseKinds,
  parseLimit,
  parsePlexGuid,
  parseStatuses,
  type DateField,
  type ItemKind,
} from "../query";

/** External ids, `null` when the item has none. Titles and books carry different sets. */
export interface ItemIds {
  tmdb?: number | null;
  imdb?: string | null;
  tvdb?: number | null;
  plexRatingKey?: string | null;
  googleBooks?: string | null;
  openLibrary?: string | null;
}

export interface ItemSummary {
  kind: ItemKind;
  id: string;
  title: string;
  year: number | null;
  status: string;
  rating: number;
  ids: ItemIds;
}

/** One title or book, classified, with what the routes below need to filter it. */
interface Candidate {
  kind: ItemKind;
  title: string;
  dates: Record<DateField, string | null | undefined>;
  summary: () => ItemSummary;
  source: { title: TitleV4 } | { book: Book };
}

/** Film = watched in one sitting; everything else, anime included, is a show. */
export function titleKind(title: TitleV4): ItemKind {
  return isSingleSitting(title) ? "film" : "show";
}

/** An audiobook is a Book whose `format` extra key says so; any other book is a book. */
export function bookKind(book: Book): ItemKind {
  return readExtra<string>(book, "format") === "audiobook" ? "audiobook" : "book";
}

function yearOf(year: number | undefined, releaseDate: string | null): number | null {
  if (typeof year === "number" && year > 0) return year;
  const match = /^(\d{4})/.exec(releaseDate ?? "");
  return match ? Number(match[1]) : null;
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function titleSummary(title: TitleV4): ItemSummary {
  return {
    kind: titleKind(title),
    id: title.id,
    title: title.title,
    year: yearOf(title.year, title.releaseDate),
    status: title.status,
    rating: title.rating,
    ids: {
      tmdb: title.tmdbId ?? null,
      imdb: nonEmpty(title.imdbId),
      tvdb: title.tvdbId ?? null,
      plexRatingKey: nonEmpty(title.plex?.ratingKey),
    },
  };
}

function bookSummary(book: Book, now: Date): ItemSummary {
  return {
    kind: bookKind(book),
    id: book.id,
    title: book.title,
    year: yearOf(undefined, book.releaseDate),
    status: derivedStatus(book, now),
    rating: book.rating,
    ids: {
      googleBooks: nonEmpty(book.googleBooksId),
      openLibrary: nonEmpty(readExtra<string>(book, "openLibraryKey")),
    },
  };
}

/** Every title and every book, in library order. Manga is not served by the API. */
function candidates(deps: ApiDeps): Candidate[] {
  const now = deps.now();
  const out: Candidate[] = [];
  for (const title of deps.store.allTitles()) {
    out.push({
      kind: titleKind(title),
      title: title.title,
      dates: {
        dateFinished: title.dateFinished,
        dateAdded: title.dateAdded,
        dateStarted: title.dateStarted,
        dateModified: title.dateModified,
      },
      summary: () => titleSummary(title),
      source: { title },
    });
  }
  for (const book of deps.reading.allBooks()) {
    out.push({
      kind: bookKind(book),
      title: book.title,
      dates: {
        dateFinished: book.dateFinished,
        dateAdded: book.dateAdded,
        dateStarted: book.dateStarted,
        dateModified: book.dateModified,
      },
      summary: () => bookSummary(book, now),
      source: { book },
    });
  }
  return out;
}

function byTitle(a: Candidate, b: Candidate): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

// ---------------------------------------------------------------------------
// GET /search?q=&kind=&limit=
// ---------------------------------------------------------------------------

function search(req: ApiRequest, deps: ApiDeps): ApiResponse {
  const q = norm((req.query.q ?? "").trim());
  if (!q) throw new ApiError(400, "q is required");
  const kinds = parseKinds(req.query.kind);
  const limit = parseLimit(req.query.limit);

  // Exact title first, then titles that start with the query, then the rest.
  const rank = (title: string): number => (title === q ? 0 : title.startsWith(q) ? 1 : 2);
  const hits = candidates(deps)
    .filter((item) => !kinds || kinds.includes(item.kind))
    .map((item) => ({ item, name: norm(item.title) }))
    .filter(({ name }) => name.includes(q))
    .sort((a, b) => rank(a.name) - rank(b.name) || byTitle(a.item, b.item));

  return {
    status: 200,
    body: { items: hits.slice(0, limit).map(({ item }) => item.summary()), total: hits.length },
  };
}

// ---------------------------------------------------------------------------
// GET /lookup?tmdb=&imdb=&tvdb=&plexGuid=&plexRatingKey=&openLibrary=&googleBooks=
// ---------------------------------------------------------------------------

const LOOKUP_KEYS = ["tmdb", "imdb", "tvdb", "plexGuid", "plexRatingKey", "openLibrary", "googleBooks"] as const;

function positiveInt(value: string, name: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new ApiError(400, `${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

function imdbId(value: string, name: string): string {
  if (!/^tt\d+$/i.test(value)) throw new ApiError(400, `${name} must look like tt0111161, got "${value}"`);
  return value.toLowerCase();
}

/** `/works/OL893414W`, `works/OL893414W` and `OL893414W` all name the same work. */
function openLibraryId(value: string): string {
  const segments = value.trim().split("/").filter(Boolean);
  return (segments[segments.length - 1] ?? "").toUpperCase();
}

/**
 * Every item matching **any** of the given ids. Several parameters widen the
 * net rather than narrow it, so a script holding a Plex item's full GUID list
 * can pass them all and take whatever comes back.
 */
function lookup(req: ApiRequest, deps: ApiDeps): ApiResponse {
  const given = Object.fromEntries(
    LOOKUP_KEYS.map((key) => [key, (req.query[key] ?? "").trim()] as const).filter(([, value]) => value !== ""),
  ) as Partial<Record<(typeof LOOKUP_KEYS)[number], string>>;
  if (Object.keys(given).length === 0) {
    throw new ApiError(400, `lookup needs at least one of ${LOOKUP_KEYS.join(", ")}`);
  }

  const tmdb = new Set<number>();
  const tvdb = new Set<number>();
  const imdb = new Set<string>();
  if (given.tmdb) tmdb.add(positiveInt(given.tmdb, "tmdb"));
  if (given.tvdb) tvdb.add(positiveInt(given.tvdb, "tvdb"));
  if (given.imdb) imdb.add(imdbId(given.imdb, "imdb"));
  if (given.plexGuid) {
    const guid = parsePlexGuid(given.plexGuid);
    if (guid.source === "imdb") imdb.add(guid.id);
    else (guid.source === "tmdb" ? tmdb : tvdb).add(guid.id);
  }
  const ratingKey = given.plexRatingKey;
  const openLibrary = given.openLibrary ? openLibraryId(given.openLibrary) : undefined;
  const googleBooks = given.googleBooks;

  const matches = candidates(deps).filter((item) => {
    if ("title" in item.source) {
      const title = item.source.title;
      return (
        (title.tmdbId !== undefined && tmdb.has(title.tmdbId)) ||
        (title.tvdbId !== undefined && tvdb.has(title.tvdbId)) ||
        (!!title.imdbId && imdb.has(title.imdbId.trim().toLowerCase())) ||
        (ratingKey !== undefined && title.plex?.ratingKey === ratingKey)
      );
    }
    const book = item.source.book;
    const key = readExtra<string>(book, "openLibraryKey");
    return (
      (openLibrary !== undefined && typeof key === "string" && openLibraryId(key) === openLibrary) ||
      (googleBooks !== undefined && book.googleBooksId === googleBooks)
    );
  });

  return { status: 200, body: { items: matches.map((item) => item.summary()), total: matches.length } };
}

// ---------------------------------------------------------------------------
// GET /items?kind=&status=&from=&to=&dateField=&limit=
// ---------------------------------------------------------------------------

function items(req: ApiRequest, deps: ApiDeps): ApiResponse {
  const kinds = parseKinds(req.query.kind);
  const statuses = parseStatuses(req.query.status);
  const range = parseDateRange(req.query);
  const dateField = parseDateField(req.query.dateField);
  const limit = parseLimit(req.query.limit);

  const rows = candidates(deps)
    .map((item) => ({ item, summary: item.summary(), day: calendarDay(item.dates[dateField]) }))
    .filter(({ item }) => !kinds || kinds.includes(item.kind))
    .filter(({ summary }) => matchesStatus(summary.status, statuses))
    .filter(({ day }) => inDateRange(day, range))
    // Newest first on the chosen date; undated last; then by title.
    .sort((a, b) => {
      if (a.day !== b.day) {
        if (!a.day) return 1;
        if (!b.day) return -1;
        return a.day < b.day ? 1 : -1;
      }
      return byTitle(a.item, b.item);
    });

  return { status: 200, body: { items: rows.slice(0, limit).map(({ summary }) => summary), total: rows.length } };
}

// ---------------------------------------------------------------------------

const ROUTES: Record<string, (req: ApiRequest, deps: ApiDeps) => ApiResponse> = {
  "/search": search,
  "/lookup": lookup,
  "/items": items,
};

export const searchRoutes: RouteHandler = (req, deps) => {
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  const route = ROUTES[path];
  if (!route) return undefined;
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new ApiError(405, `${method} is not allowed on ${path}`);
  return route(req, deps);
};
