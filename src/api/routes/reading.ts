/**
 * `/books` and `/audiobooks` — the reading shelf over HTTP.
 *
 * Both collections live in `reading.books`. An audiobook is a `Book` row whose
 * extra key `format` is `"audiobook"`; every other row is a book. The two lists
 * are disjoint, and an id fetched through the wrong collection is a 404, so a
 * client can never edit an audiobook as if it counted pages.
 *
 * Every write goes through the reading store (`addBook`, `update`, `remove`),
 * which mutates the live row, stamps `dateModified`, logs activity and fires the
 * change event — an outside caller gets exactly the bookkeeping the Reading tab
 * gets. Keys the typed `Book` does not declare (`format`, `listenedMinutes`,
 * `totalMinutes`, `openLibraryKey`, `review`) go through `writeExtra` on that
 * same live row. A write answers only after `store.flush()` has put it on disk.
 *
 * Manga is not served here.
 */
import {
  READING_STATUSES,
  readExtra,
  writeExtra,
  type Book,
  type ReadingData,
  type ReadingPatch,
  type ReadingStatus,
} from "../../types";
import { buildReadingEntry, findExistingReading, type NewEntrySeed } from "../../domains/reading/store";
import { statusPatch, todayString } from "../../domains/reading/progress";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse, type RouteHandler } from "../types";
import {
  EXTRA_FORMAT,
  EXTRA_LISTENED_MINUTES,
  EXTRA_OPEN_LIBRARY_KEY,
  EXTRA_REVIEW,
  EXTRA_TOTAL_MINUTES,
  FORMAT_AUDIOBOOK,
  isAudiobook,
  readingJson,
  type ReadingApiKind,
} from "../serialize/reading";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const COLLECTIONS: Record<string, ReadingApiKind> = {
  books: "book",
  audiobooks: "audiobook",
};

/** Progress fields per kind. A field for the other kind is a 400, not a no-op. */
const BOOK_COUNTERS = ["pagesRead", "totalPages", "wordsRead", "totalWords", "chaptersRead", "totalChapters"] as const;
const AUDIOBOOK_COUNTERS = [EXTRA_LISTENED_MINUTES, EXTRA_TOTAL_MINUTES] as const;

type Body = Record<string, unknown>;

/** What a validated body asks for: typed fields for the store, extras for `writeExtra`. */
interface Edit {
  patch: ReadingPatch;
  /** `undefined` clears the key. */
  extras: Record<string, unknown>;
  /** Whether the body named a progress counter explicitly. */
  counters: Set<string>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const has = (body: Body, key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

function asBody(value: unknown): Body {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Body must be a JSON object");
  return value as Body;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, `${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ApiError(400, `${field} must be a string`);
  return value.trim();
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isCalendarDate(value)) {
    throw new ApiError(400, `${field} must be a YYYY-MM-DD date or null`);
  }
  return value;
}

function status(value: unknown): ReadingStatus {
  if (typeof value !== "string" || !(READING_STATUSES as readonly string[]).includes(value)) {
    throw new ApiError(400, `status must be one of: ${READING_STATUSES.join(", ")}`);
  }
  return value as ReadingStatus;
}

function rating(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
    throw new ApiError(400, "rating must be a number from 0 to 5");
  }
  return value;
}

function counter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Progress fields may sit at the top level or inside `progress`, which is the
 * shape GET returns — so a client can send back what it read. `progress.unit`
 * is a book's `progressUnit`; an audiobook's unit is always minutes.
 */
function progressFields(body: Body, kind: ReadingApiKind): Body {
  const nested = has(body, "progress") ? body.progress : undefined;
  if (nested !== undefined && (nested === null || typeof nested !== "object" || Array.isArray(nested))) {
    throw new ApiError(400, "progress must be an object");
  }
  const fields: Body = {};
  for (const key of [...BOOK_COUNTERS, ...AUDIOBOOK_COUNTERS, "progressUnit"]) {
    if (has(body, key)) fields[key] = body[key];
  }
  for (const [key, value] of Object.entries((nested as Body | undefined) ?? {})) {
    if (key === "percent") continue;
    if (key === "unit") {
      if (kind === "audiobook" && value === "minutes") continue;
      fields.progressUnit = value;
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

function readProgress(body: Body, kind: ReadingApiKind, edit: Edit): void {
  const fields = progressFields(body, kind);
  const own: readonly string[] = kind === "audiobook" ? AUDIOBOOK_COUNTERS : BOOK_COUNTERS;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "progressUnit") {
      if (kind === "audiobook") throw new ApiError(400, "An audiobook's progress is always in minutes");
      if (value !== "pages" && value !== "words") throw new ApiError(400, "progress unit must be pages or words");
      edit.patch.progressUnit = value;
      continue;
    }
    if (!own.includes(key)) {
      throw new ApiError(400, `${key} is not a progress field for ${kind === "audiobook" ? "an audiobook" : "a book"}`);
    }
    const n = counter(value, key);
    edit.counters.add(key);
    if (kind === "audiobook") edit.extras[key] = n;
    else (edit.patch as Record<string, unknown>)[key] = n;
  }
}

/** Validate a create or update body. Unknown keys are ignored. */
function readEdit(body: Body, kind: ReadingApiKind): Edit {
  const edit: Edit = { patch: {}, extras: {}, counters: new Set() };
  const patch = edit.patch;

  if (has(body, "title")) patch.title = requireText(body.title, "title");
  if (has(body, "author")) patch.author = optionalText(body.author, "author");
  if (has(body, "status")) patch.status = status(body.status);
  if (has(body, "rating")) patch.rating = rating(body.rating);
  if (has(body, "favorite")) {
    if (typeof body.favorite !== "boolean") throw new ApiError(400, "favorite must be true or false");
    patch.favorite = body.favorite;
  }
  if (has(body, "categories")) {
    const value = body.categories;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new ApiError(400, "categories must be an array of strings");
    }
    patch.categories = (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
  }
  if (has(body, "coverUrl")) patch.coverUrl = optionalText(body.coverUrl, "coverUrl");
  if (has(body, "externalLink")) patch.externalLink = optionalText(body.externalLink, "externalLink");

  const dates = has(body, "dates") ? body.dates : undefined;
  if (dates !== undefined && (dates === null || typeof dates !== "object" || Array.isArray(dates))) {
    throw new ApiError(400, "dates must be an object");
  }
  for (const field of ["dateStarted", "dateFinished", "releaseDate"] as const) {
    const source = has(body, field) ? body : dates && has(dates as Body, field) ? (dates as Body) : undefined;
    if (source) patch[field] = dateOrNull(source[field], field);
  }

  if (has(body, "review")) {
    const value = body.review;
    if (value !== null && typeof value !== "string") throw new ApiError(400, "review must be a string or null");
    edit.extras[EXTRA_REVIEW] = typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  }

  const ids = has(body, "ids") ? body.ids : undefined;
  if (ids !== undefined && (ids === null || typeof ids !== "object" || Array.isArray(ids))) {
    throw new ApiError(400, "ids must be an object");
  }
  const idBody = (ids as Body | undefined) ?? {};
  const googleBooks = has(body, "googleBooksId") ? body.googleBooksId : has(idBody, "googleBooks") ? idBody.googleBooks : undefined;
  if (googleBooks !== undefined) {
    patch.googleBooksId = googleBooks === null ? "" : optionalText(googleBooks, "googleBooksId");
  }
  const openLibrary = has(body, EXTRA_OPEN_LIBRARY_KEY)
    ? body[EXTRA_OPEN_LIBRARY_KEY]
    : has(idBody, "openLibrary")
      ? idBody.openLibrary
      : undefined;
  if (openLibrary !== undefined) {
    const value = openLibrary === null ? "" : optionalText(openLibrary, EXTRA_OPEN_LIBRARY_KEY);
    edit.extras[EXTRA_OPEN_LIBRARY_KEY] = value === "" ? undefined : value;
  }

  readProgress(body, kind, edit);
  return edit;
}

/**
 * Write extra keys onto the live row. `undefined` removes a key that is there
 * (by writing `undefined`, which the JSON writer drops) and leaves an absent
 * one absent. Returns whether anything changed.
 */
function applyExtras(book: Book, extras: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(extras)) {
    const current = readExtra(book, key);
    if (current === value) continue;
    if (value === undefined && !Object.prototype.hasOwnProperty.call(book, key)) continue;
    writeExtra(book, key, value);
    changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function rowsOf(deps: ApiDeps, kind: ReadingApiKind): Book[] {
  const audio = kind === "audiobook";
  return deps.reading.allBooks().filter((book) => isAudiobook(book) === audio);
}

function noun(kind: ReadingApiKind): string {
  return kind === "audiobook" ? "audiobook" : "book";
}

function findIn(deps: ApiDeps, kind: ReadingApiKind, id: string): Book {
  const book = deps.reading.getBook(id);
  if (!book || isAudiobook(book) !== (kind === "audiobook")) throw new ApiError(404, `No ${noun(kind)} "${id}"`);
  return book;
}

/** The add flow's duplicate guard, scoped to one collection. */
function assertUnique(deps: ApiDeps, kind: ReadingApiKind, title: string, self?: string): void {
  const rows = rowsOf(deps, kind).filter((book) => book.id !== self);
  const scoped: ReadingData = { ...deps.reading.reading, books: rows };
  const existing = findExistingReading(scoped, "book", title);
  if (existing) throw new ApiError(409, `A ${noun(kind)} called "${existing.title}" already exists (id "${existing.id}")`);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function list(req: ApiRequest, deps: ApiDeps, kind: ReadingApiKind): ApiResponse {
  const now = deps.now();
  const wanted = req.query.status !== undefined && req.query.status !== "" ? status(req.query.status) : undefined;

  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined && req.query.limit !== "") {
    const parsed = Number(req.query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) throw new ApiError(400, "limit must be a positive integer");
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const items = rowsOf(deps, kind)
    .map((book) => readingJson(book, now))
    .filter((json) => wanted === undefined || json.status === wanted)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
  return { status: 200, body: items };
}

/**
 * Audiobooks have no `statusPatch` counter to fill, so finishing one fills the
 * minutes the same way — unless the body said how far it got.
 */
function completeAudiobook(book: Book, edit: Edit): void {
  if (edit.counters.has(EXTRA_LISTENED_MINUTES)) return;
  const total = edit.extras[EXTRA_TOTAL_MINUTES] ?? readExtra(book, EXTRA_TOTAL_MINUTES);
  if (typeof total === "number" && total > 0) edit.extras[EXTRA_LISTENED_MINUTES] = total;
}

/**
 * Set a status the way the Reading tab does — `statusPatch` stamps the dates and
 * fills the counter on Completed — then let anything the body named win.
 */
function withStatus(book: Book, kind: ReadingApiKind, edit: Edit, now: Date): ReadingPatch {
  const target = edit.patch.status;
  if (target === undefined) return edit.patch;
  const implied = statusPatch(book, target, { now });
  const merged: ReadingPatch = { ...implied, ...edit.patch };
  if (target !== "Completed") return merged;
  if (kind === "audiobook") {
    completeAudiobook(book, edit);
    return merged;
  }
  // `statusPatch` filled the counter from the row's *current* total; a total
  // arriving in the same body is the one that counts.
  const words = (merged.progressUnit ?? book.progressUnit) === "words";
  const [readKey, totalKey] = words ? (["wordsRead", "totalWords"] as const) : (["pagesRead", "totalPages"] as const);
  const total = merged[totalKey] ?? book[totalKey];
  if (!edit.counters.has(readKey) && total > 0) merged[readKey] = total;
  return merged;
}

/**
 * Commit a change to a live row: extras first (so the change hook sees them),
 * then the typed patch through the store. When only extras changed, the store
 * has nothing to stamp, so the save and change event are queued here instead.
 */
async function commit(deps: ApiDeps, book: Book, patch: ReadingPatch, extras: Record<string, unknown>, reason: string): Promise<void> {
  const extrasChanged = applyExtras(book, extras);
  const before = book.dateModified;
  deps.reading.update("book", book.id, patch, reason);
  if (extrasChanged && book.dateModified === before) {
    deps.store.save(reason);
    deps.store.emitChanged({ reason, titleIds: [book.id] });
  }
  await deps.store.flush();
}

async function create(req: ApiRequest, deps: ApiDeps, kind: ReadingApiKind): Promise<ApiResponse> {
  const body = asBody(req.body);
  if (!has(body, "title")) throw new ApiError(400, "title is required");
  const edit = readEdit(body, kind);
  const title = edit.patch.title as string;
  assertUnique(deps, kind, title);

  const seed: NewEntrySeed = { title };
  const id = deps.reading.nextId("book", title);
  const book = buildReadingEntry("book", id, seed, deps.reading.reading) as Book;

  // The row is not on the shelf yet, so it can be filled in place before the
  // store sees it — one `added` entry in the log rather than added-then-edited.
  const patch = withStatus(book, kind, edit, deps.now());
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (book as unknown as Record<string, unknown>)[key] = value;
  }
  if (kind === "audiobook") writeExtra(book, EXTRA_FORMAT, FORMAT_AUDIOBOOK);
  applyExtras(book, edit.extras);

  deps.reading.addBook(book);
  await deps.store.flush();
  return { status: 201, body: readingJson(book, deps.now()) };
}

async function patch(req: ApiRequest, deps: ApiDeps, kind: ReadingApiKind, id: string): Promise<ApiResponse> {
  const book = findIn(deps, kind, id);
  const edit = readEdit(asBody(req.body), kind);
  if (edit.patch.title !== undefined) assertUnique(deps, kind, edit.patch.title, book.id);
  await commit(deps, book, withStatus(book, kind, edit, deps.now()), edit.extras, "api-reading-updated");
  return { status: 200, body: readingJson(book, deps.now()) };
}

async function remove(deps: ApiDeps, kind: ReadingApiKind, id: string): Promise<ApiResponse> {
  const book = findIn(deps, kind, id);
  deps.reading.remove("book", book.id);
  await deps.store.flush();
  return { status: 200, body: { deleted: true, id: book.id } };
}

/**
 * "I read it": Completed, finished on `date`, started then too if it never
 * was, the counter filled to its total when there is one. A rating of 0 and an
 * empty review mean "not given", never "clear what is there".
 */
async function logRead(req: ApiRequest, deps: ApiDeps, kind: ReadingApiKind, id: string): Promise<ApiResponse> {
  const book = findIn(deps, kind, id);
  const body = asBody(req.body);
  const date = has(body, "date") && body.date !== null ? dateOrNull(body.date, "date") : todayString(deps.now());

  const patch: ReadingPatch = { status: "Completed", dateFinished: date };
  if (!book.dateStarted) patch.dateStarted = date;
  if (has(body, "rating")) {
    const value = rating(body.rating);
    if (value > 0) patch.rating = value;
  }

  const extras: Record<string, unknown> = {};
  if (has(body, "review")) {
    const value = body.review;
    if (value !== null && typeof value !== "string") throw new ApiError(400, "review must be a string");
    if (typeof value === "string" && value.trim() !== "") extras[EXTRA_REVIEW] = value.trim();
  }

  if (kind === "audiobook") {
    const total = readExtra(book, EXTRA_TOTAL_MINUTES);
    if (typeof total === "number" && total > 0) extras[EXTRA_LISTENED_MINUTES] = total;
  } else {
    if (book.totalPages > 0) patch.pagesRead = book.totalPages;
    if (book.totalWords > 0) patch.wordsRead = book.totalWords;
    if (book.totalChapters > 0) patch.chaptersRead = book.totalChapters;
  }

  if (has(body, "progress")) {
    const edit: Edit = { patch: {}, extras: {}, counters: new Set() };
    readProgress({ progress: body.progress }, kind, edit);
    Object.assign(patch, edit.patch);
    Object.assign(extras, edit.extras);
  }

  await commit(deps, book, patch, extras, "api-reading-read");
  return { status: 200, body: readingJson(book, deps.now()) };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new ApiError(400, "Malformed path");
      }
    });
}

function notAllowed(method: string, path: string): never {
  throw new ApiError(405, `${method} is not supported on ${path}`);
}

export const readingRoutes: RouteHandler = async (req, deps) => {
  const parts = segments(req.path);
  const kind = parts[0] !== undefined ? COLLECTIONS[parts[0]] : undefined;
  if (kind === undefined || parts.length > 3) return undefined;

  const method = req.method.toUpperCase();
  const read = method === "GET" || method === "HEAD";
  const id = parts[1];

  if (id === undefined) {
    if (read) return list(req, deps, kind);
    if (method === "POST") return create(req, deps, kind);
    return notAllowed(method, req.path);
  }

  if (parts.length === 3) {
    if (parts[2] !== "read") return undefined;
    if (method === "POST") return logRead(req, deps, kind, id);
    return notAllowed(method, req.path);
  }

  if (read) return { status: 200, body: readingJson(findIn(deps, kind, id), deps.now()) };
  if (method === "PATCH") return patch(req, deps, kind, id);
  if (method === "DELETE") return remove(deps, kind, id);
  return notAllowed(method, req.path);
};
