/**
 * Books and audiobooks as the API speaks them.
 *
 * An audiobook is not a third shelf: it is a `Book` row carrying the extra key
 * `format: "audiobook"`, with its progress in minutes under two more extra keys.
 * Those keys are not on the typed `Book`, and they must stay that way — they
 * are read and written through `readExtra`/`writeExtra` on the live row, so a
 * row the UI has never heard of the format for still round-trips untouched.
 *
 * The JSON is deliberately flatter than the row: dates in one object, external
 * ids in another, and progress in whatever unit the entry is actually counted
 * in, so a client never has to know that v3 keeps both page and word counters.
 */
import { readExtra, type Book } from "../../types";
import { derivedStatus } from "../../domains/reading/progress";

/** Extra keys this API keeps on `Book` rows. Names are part of the data format. */
export const EXTRA_FORMAT = "format";
export const EXTRA_LISTENED_MINUTES = "listenedMinutes";
export const EXTRA_TOTAL_MINUTES = "totalMinutes";
export const EXTRA_OPEN_LIBRARY_KEY = "openLibraryKey";
export const EXTRA_REVIEW = "review";

/** The value of `format` that makes a book an audiobook. */
export const FORMAT_AUDIOBOOK = "audiobook";

export type ReadingApiKind = "book" | "audiobook";

export function isAudiobook(book: Book): boolean {
  return readExtra(book, EXTRA_FORMAT) === FORMAT_AUDIOBOOK;
}

export function apiKindOf(book: Book): ReadingApiKind {
  return isAudiobook(book) ? "audiobook" : "book";
}

/** A count that is safe to show: a finite non-negative number, else 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function percent(read: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.round((read / total) * 100));
}

export function bookProgressJson(book: Book): Record<string, unknown> {
  const unit = book.progressUnit === "words" ? "words" : "pages";
  const pagesRead = count(book.pagesRead);
  const totalPages = count(book.totalPages);
  const wordsRead = count(book.wordsRead);
  const totalWords = count(book.totalWords);
  return {
    unit,
    pagesRead,
    totalPages,
    wordsRead,
    totalWords,
    chaptersRead: count(book.chaptersRead),
    totalChapters: count(book.totalChapters),
    percent: unit === "words" ? percent(wordsRead, totalWords) : percent(pagesRead, totalPages),
  };
}

export function audiobookProgressJson(book: Book): Record<string, unknown> {
  const listenedMinutes = count(readExtra(book, EXTRA_LISTENED_MINUTES));
  const totalMinutes = count(readExtra(book, EXTRA_TOTAL_MINUTES));
  return {
    unit: "minutes",
    listenedMinutes,
    totalMinutes,
    percent: percent(listenedMinutes, totalMinutes),
  };
}

/**
 * One row as JSON.
 *
 * `status` is the *derived* status, the one the Reading tab shows: a future
 * release date reports `To be released` whatever is stored, exactly as the UI
 * does, so the API and the plugin never disagree about the same book.
 */
export function readingJson(book: Book, now: Date = new Date()): Record<string, unknown> {
  const audiobook = isAudiobook(book);
  return {
    id: book.id,
    kind: audiobook ? "audiobook" : "book",
    title: book.title,
    author: book.author ?? "",
    status: derivedStatus(book, now),
    rating: count(book.rating),
    review: text(readExtra(book, EXTRA_REVIEW)),
    favorite: book.favorite === true,
    categories: Array.isArray(book.categories) ? [...book.categories] : [],
    dates: {
      dateAdded: book.dateAdded ?? null,
      dateStarted: book.dateStarted ?? null,
      dateFinished: book.dateFinished ?? null,
      dateModified: book.dateModified ?? null,
      releaseDate: book.releaseDate ?? null,
    },
    ids: {
      googleBooks: text(book.googleBooksId),
      openLibrary: text(readExtra(book, EXTRA_OPEN_LIBRARY_KEY)),
    },
    progress: audiobook ? audiobookProgressJson(book) : bookProgressJson(book),
  };
}
