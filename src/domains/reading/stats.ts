/**
 * Reading statistics — the numbers other surfaces are allowed to ask for.
 *
 * The Dashboard grows Books and Manga cards, the widget DSL grows `pages-read`
 * and `reading-completed`, and the Upcoming list wants reading releases. All
 * three are other lanes' files, so this module is the contract between them and
 * the reading domain: pure functions over `ReadingData`, no DOM, no store, no
 * settings — hand it the library, get numbers back.
 *
 * Two conventions match the watchlist's dashboard so the cards can sit next to
 * each other and mean the same thing (`report-watchlog.md` §2.2):
 *
 *   - **`Dropped` and `To be released` are excluded from completion ratios.**
 *     A shelf of pre-orders must not read as 0 % done.
 *   - **Words fold into pages at 250.** Every page number here is comparable
 *     whether the book was tracked in pages or words.
 */
import { WORDS_PER_PAGE, type Book, type Manga, type ReadingData, type ReadingStatus } from "../../types";
import { READING_STATUSES } from "../../types";
import {
  derivedStatus,
  isFutureRelease,
  pagesEquivalent,
  primaryCounter,
  readingProgress,
  volumeCounter,
  type ReadingEntry,
} from "./progress";

/** Statuses that do not belong in a "how far through the shelf am I" ratio. */
const NON_COUNTING: ReadingStatus[] = ["Dropped", "To be released"];

export interface ReadingKindStats {
  total: number;
  /** Entries whose status counts toward the ratio (see `NON_COUNTING`). */
  counting: number;
  completed: number;
  /** `completed / counting`, rounded, 0 when nothing counts. */
  percent: number;
  reading: number;
  planned: number;
  dropped: number;
  upcoming: number;
  favorites: number;
  /** Ratings above zero only — an unrated entry is not a zero. */
  averageRating: number;
  byStatus: Record<ReadingStatus, number>;
}

export interface BookStats extends ReadingKindStats {
  /** Pages read across every book, words folded in at `WORDS_PER_PAGE`. */
  pagesRead: number;
  pagesTotal: number;
}

export interface MangaStats extends ReadingKindStats {
  chaptersRead: number;
  chaptersTotal: number;
  volumesRead: number;
  volumesTotal: number;
}

export interface ReadingStats {
  books: BookStats;
  manga: MangaStats;
  /** Both shelves together — what a single "Reading" dashboard card shows. */
  totalEntries: number;
  totalCompleted: number;
  /** Combined completion across both, same exclusions. */
  percent: number;
  pagesRead: number;
}

function emptyByStatus(): Record<ReadingStatus, number> {
  const out = {} as Record<ReadingStatus, number>;
  for (const status of READING_STATUSES) out[status] = 0;
  return out;
}

function baseStats(entries: readonly ReadingEntry[], now: Date): ReadingKindStats {
  const byStatus = emptyByStatus();
  let counting = 0;
  let completed = 0;
  let ratingSum = 0;
  let rated = 0;
  let favorites = 0;

  for (const entry of entries) {
    const status = derivedStatus(entry, now);
    byStatus[status] += 1;
    if (!NON_COUNTING.includes(status)) {
      counting += 1;
      // Fully-read counts as done even when the status was never touched — the
      // same rule the watchlist dashboard applies to a fully-ticked series.
      if (status === "Completed" || readingProgress(entry) >= 100) completed += 1;
    }
    if (entry.rating > 0) {
      ratingSum += entry.rating;
      rated += 1;
    }
    if (entry.favorite) favorites += 1;
  }

  return {
    total: entries.length,
    counting,
    completed,
    percent: counting === 0 ? 0 : Math.round((completed / counting) * 100),
    reading: byStatus["Reading"],
    planned: byStatus["Plan to Read"],
    dropped: byStatus["Dropped"],
    upcoming: byStatus["To be released"],
    favorites,
    averageRating: rated === 0 ? 0 : Math.round((ratingSum / rated) * 10) / 10,
    byStatus,
  };
}

export function bookStats(books: readonly Book[], now: Date = new Date()): BookStats {
  let pagesRead = 0;
  let pagesTotal = 0;
  for (const book of books) {
    const pages = pagesEquivalent(book);
    pagesRead += pages.read;
    pagesTotal += pages.total;
  }
  return { ...baseStats(books, now), pagesRead, pagesTotal };
}

export function mangaStats(manga: readonly Manga[], now: Date = new Date()): MangaStats {
  let chaptersRead = 0;
  let chaptersTotal = 0;
  let volumesRead = 0;
  let volumesTotal = 0;
  for (const entry of manga) {
    const chapters = primaryCounter(entry);
    chaptersRead += chapters.read;
    chaptersTotal += chapters.total;
    const volumes = volumeCounter(entry);
    volumesRead += volumes.read;
    volumesTotal += volumes.total;
  }
  return { ...baseStats(manga, now), chaptersRead, chaptersTotal, volumesRead, volumesTotal };
}

/** The whole reading library, in the shape the Dashboard lane consumes. */
export function computeReadingStats(reading: ReadingData, now: Date = new Date()): ReadingStats {
  const books = bookStats(reading.books, now);
  const manga = mangaStats(reading.manga, now);
  const counting = books.counting + manga.counting;
  const completed = books.completed + manga.completed;
  return {
    books,
    manga,
    totalEntries: books.total + manga.total,
    totalCompleted: completed,
    percent: counting === 0 ? 0 : Math.round((completed / counting) * 100),
    pagesRead: books.pagesRead,
  };
}

// ---------------------------------------------------------------------------
// The widget DSL's reading stats (`stat: pages-read`, `stat: reading-completed`)
// ---------------------------------------------------------------------------

/**
 * `stat: pages-read` — books only, words folded in.
 *
 * Manga are deliberately not counted: a chapter is not a page, and inventing a
 * conversion would make the number look precise while meaning nothing.
 */
export function pagesRead(reading: ReadingData): number {
  return bookStats(reading.books).pagesRead;
}

/** `stat: reading-completed` — finished entries across both shelves. */
export function readingCompleted(reading: ReadingData, now: Date = new Date()): number {
  return computeReadingStats(reading, now).totalCompleted;
}

/** Entries whose release is still ahead — the Upcoming lane's reading rows. */
export function upcomingReleases(
  reading: ReadingData,
  now: Date = new Date(),
): { entry: ReadingEntry; kind: "book" | "manga" }[] {
  const out: { entry: ReadingEntry; kind: "book" | "manga" }[] = [];
  for (const book of reading.books) {
    if (isFutureRelease(book.releaseDate, now)) out.push({ entry: book, kind: "book" });
  }
  for (const manga of reading.manga) {
    if (isFutureRelease(manga.releaseDate, now)) out.push({ entry: manga, kind: "manga" });
  }
  return out.sort((a, b) => (a.entry.releaseDate ?? "").localeCompare(b.entry.releaseDate ?? ""));
}

/** Re-exported so a consumer never has to guess the fold rate. */
export { WORDS_PER_PAGE };
