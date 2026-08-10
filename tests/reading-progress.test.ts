/**
 * Reading progress and statistics (SPEC2 §D-READING).
 *
 * Three v3 behaviours are load-bearing and each one is a silent data bug if it
 * drifts:
 *
 *   1. a book counts pages **or** words, and switching keeps both counters;
 *   2. words fold into pages at exactly 250 for every statistic;
 *   3. `To be released` is derived from `releaseDate`, never stored-and-trusted.
 *
 * The rest is the arithmetic the +1 button and the dashboard cards run on.
 */
import { describe, expect, it } from "vitest";
import { createBook, createManga } from "../src/data/schema";
import {
  bumpPatch,
  derivedStatus,
  isFutureRelease,
  isMeasurable,
  pagesEquivalent,
  primaryCounter,
  progressLabel,
  progressPatch,
  readingProgress,
  remainingLabel,
  statusPatch,
  unitPatch,
  volumeCounter,
  wordsToPages,
} from "../src/domains/reading/progress";
import {
  bookStats,
  computeReadingStats,
  mangaStats,
  pagesRead,
  readingCompleted,
  upcomingReleases,
} from "../src/domains/reading/stats";
import { createReadingData } from "../src/data/schema";
import type { Book, Manga } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

function book(overrides: Partial<Book> & { id: string }): Book {
  return createBook({ title: overrides.id, ...overrides });
}

function manga(overrides: Partial<Manga> & { id: string }): Manga {
  return createManga({ title: overrides.id, ...overrides });
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

describe("which counter an entry is measured by", () => {
  it("uses pages for a book tracked in pages", () => {
    const entry = book({ id: "dune", pagesRead: 264, totalPages: 528 });
    expect(primaryCounter(entry)).toMatchObject({ read: 264, total: 528, unit: "pages" });
    expect(readingProgress(entry)).toBe(50);
  });

  it("uses words for a book tracked in words", () => {
    const entry = book({ id: "wip", progressUnit: "words", wordsRead: 12500, totalWords: 90000 });
    expect(primaryCounter(entry)).toMatchObject({ read: 12500, total: 90000, unit: "words" });
    expect(readingProgress(entry)).toBe(14);
  });

  it("uses chapters for manga, with volumes as the second axis", () => {
    const entry = manga({ id: "berserk", chaptersRead: 300, totalChapters: 374, volumesRead: 34, totalVolumes: 42 });
    expect(primaryCounter(entry)).toMatchObject({ read: 300, total: 374, unit: "chapters" });
    expect(volumeCounter(entry)).toEqual({ read: 34, total: 42 });
    expect(readingProgress(entry)).toBe(80);
  });

  it("falls back to volumes when a manga has no chapter count", () => {
    const entry = manga({ id: "vols", volumesRead: 3, totalVolumes: 12 });
    expect(readingProgress(entry)).toBe(25);
  });

  it("reports 0 rather than a fraction when there is nothing to measure", () => {
    const entry = book({ id: "unknown", pagesRead: 40 });
    expect(readingProgress(entry)).toBe(0);
    expect(isMeasurable(entry)).toBe(false);
    // …and says so, instead of drawing a bar at zero.
    expect(progressLabel(entry)).toBe("40 pages");
  });

  it("never exceeds 100 %, however far past the end the counter is", () => {
    expect(readingProgress(book({ id: "over", pagesRead: 900, totalPages: 528 }))).toBe(100);
  });

  it("ignores a negative or non-finite counter instead of propagating it", () => {
    const entry = book({ id: "bad", pagesRead: -12, totalPages: 100 });
    expect(primaryCounter(entry).read).toBe(0);
    expect(readingProgress(entry)).toBe(0);
  });
});

describe("words fold into pages at 250", () => {
  it("converts a word-tracked book for statistics", () => {
    expect(pagesEquivalent(book({ id: "w", progressUnit: "words", wordsRead: 12500, totalWords: 90000 }))).toEqual({
      read: 50,
      total: 360,
    });
  });

  it("leaves a page-tracked book alone", () => {
    expect(pagesEquivalent(book({ id: "p", pagesRead: 264, totalPages: 528 }))).toEqual({
      read: 264,
      total: 528,
    });
  });

  it("uses one rounding rule everywhere", () => {
    expect(wordsToPages(12500)).toBe(50);
    expect(wordsToPages(1)).toBe(0);
    expect(wordsToPages(125)).toBe(1);
  });
});

describe("switching units keeps both counters", () => {
  it("changes only what is counted", () => {
    const entry = book({ id: "both", pagesRead: 100, totalPages: 300, wordsRead: 25000, totalWords: 90000 });
    const patch = unitPatch("words");
    expect(patch).toEqual({ progressUnit: "words" });
    // Nothing else is in the patch: the page counters survive the flip.
    expect(Object.keys(patch)).toEqual(["progressUnit"]);
  });
});

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

describe("To be released is derived, not chosen", () => {
  it("reports a future release date whatever the stored status says", () => {
    const entry = book({ id: "next", status: "Plan to Read", releaseDate: "2026-12-01" });
    expect(derivedStatus(entry, NOW)).toBe("To be released");
  });

  it("does not overrule a status the user deliberately set", () => {
    expect(derivedStatus(book({ id: "d", status: "Dropped", releaseDate: "2026-12-01" }), NOW)).toBe("Dropped");
    expect(derivedStatus(book({ id: "c", status: "Completed", releaseDate: "2026-12-01" }), NOW)).toBe("Completed");
  });

  it("falls back once the date has passed, so nobody is stuck in it", () => {
    const entry = book({ id: "out", status: "To be released", releaseDate: "2020-01-01" });
    expect(derivedStatus(entry, NOW)).toBe("Plan to Read");
  });

  it("treats today as released", () => {
    expect(isFutureRelease("2026-08-03", NOW)).toBe(false);
    expect(isFutureRelease("2026-08-04", NOW)).toBe(true);
    expect(isFutureRelease(null, NOW)).toBe(false);
    expect(isFutureRelease("not a date", NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Progress edits
// ---------------------------------------------------------------------------

describe("moving the counter carries what it implies", () => {
  it("starts a book: status, and the date it started", () => {
    const entry = book({ id: "start", status: "Plan to Read", totalPages: 300 });
    expect(progressPatch(entry, 12, { now: NOW })).toEqual({
      pagesRead: 12,
      status: "Reading",
      dateStarted: "2026-08-03",
    });
  });

  it("finishes a book: status, and the date it finished", () => {
    const entry = book({ id: "end", status: "Reading", pagesRead: 299, totalPages: 300, dateStarted: "2026-01-01" });
    expect(progressPatch(entry, 300, { now: NOW })).toEqual({
      pagesRead: 300,
      status: "Completed",
      dateFinished: "2026-08-03",
    });
  });

  it("un-finishes cleanly rather than leaving 'Completed, 12 of 300'", () => {
    const entry = book({
      id: "reread",
      status: "Completed",
      pagesRead: 300,
      totalPages: 300,
      dateStarted: "2026-01-01",
      dateFinished: "2026-02-01",
    });
    expect(progressPatch(entry, 12, { now: NOW })).toEqual({
      pagesRead: 12,
      status: "Reading",
      dateFinished: null,
    });
  });

  it("returns a reset entry to Plan to Read", () => {
    const entry = book({ id: "reset", status: "Reading", pagesRead: 40, totalPages: 300 });
    expect(progressPatch(entry, 0, { now: NOW })).toEqual({
      pagesRead: 0,
      status: "Plan to Read",
      dateFinished: null,
    });
  });

  it("never un-drops something the user dropped", () => {
    const entry = book({ id: "dropped", status: "Dropped", pagesRead: 40, totalPages: 300 });
    expect(progressPatch(entry, 60, { now: NOW })).toEqual({ pagesRead: 60 });
  });

  it("leaves the status alone when the caller asked for a raw correction", () => {
    const entry = book({ id: "fix", status: "Plan to Read", totalPages: 300 });
    expect(progressPatch(entry, 12, { now: NOW, autoStatus: false })).toEqual({ pagesRead: 12 });
  });

  it("clamps to the total, and never below zero", () => {
    const entry = book({ id: "clamp", status: "Reading", pagesRead: 0, totalPages: 300 });
    expect(progressPatch(entry, 5000, { now: NOW }).pagesRead).toBe(300);
    expect(progressPatch(entry, -20, { now: NOW }).pagesRead).toBe(0);
  });

  it("writes the word counter for a word-tracked book", () => {
    const entry = book({ id: "words", progressUnit: "words", totalWords: 90000, status: "Reading", dateStarted: "2026-01-01" });
    expect(progressPatch(entry, 12500, { now: NOW })).toEqual({ wordsRead: 12500 });
  });

  it("writes chapters for manga", () => {
    const entry = manga({ id: "m", totalChapters: 374, chaptersRead: 300, status: "Reading", dateStarted: "2023-05-01" });
    expect(bumpPatch(entry, 1, { now: NOW })).toEqual({ chaptersRead: 301 });
    expect(bumpPatch(entry, -1, { now: NOW })).toEqual({ chaptersRead: 299 });
  });
});

describe("picking a status by hand", () => {
  it("fills the counter in when marking something finished", () => {
    const entry = book({ id: "mark", status: "Reading", pagesRead: 12, totalPages: 528, dateStarted: "2026-01-01" });
    expect(statusPatch(entry, "Completed", { now: NOW })).toEqual({
      status: "Completed",
      pagesRead: 528,
      dateFinished: "2026-08-03",
    });
  });

  it("clears the finish date when leaving Completed", () => {
    const entry = book({
      id: "unmark",
      status: "Completed",
      pagesRead: 528,
      totalPages: 528,
      dateStarted: "2026-01-01",
      dateFinished: "2026-02-01",
    });
    expect(statusPatch(entry, "Dropped", { now: NOW })).toEqual({
      status: "Dropped",
      dateFinished: null,
    });
  });

  it("stamps a start date the first time something is being read", () => {
    const entry = book({ id: "s", status: "Plan to Read", totalPages: 300 });
    expect(statusPatch(entry, "Reading", { now: NOW })).toEqual({
      status: "Reading",
      dateStarted: "2026-08-03",
    });
  });
});

describe("labels", () => {
  it("says how far and how much is left", () => {
    const entry = book({ id: "label", pagesRead: 264, totalPages: 528 });
    expect(progressLabel(entry)).toBe("264 / 528 pages");
    expect(remainingLabel(entry)).toBe("264 pages left");
  });

  it("groups large word counts readably", () => {
    const entry = book({ id: "big", progressUnit: "words", wordsRead: 12500, totalWords: 90000 });
    expect(progressLabel(entry)).toBe("12 500 / 90 000 words");
  });

  it("says nothing rather than '0 left' for a finished entry", () => {
    expect(remainingLabel(book({ id: "done", pagesRead: 300, totalPages: 300 }))).toBe("");
  });

  it("singularises", () => {
    expect(remainingLabel(book({ id: "one", pagesRead: 299, totalPages: 300 }))).toBe("1 page left");
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe("dashboard statistics", () => {
  const books = [
    book({ id: "done", status: "Completed", pagesRead: 528, totalPages: 528, rating: 5, favorite: true }),
    book({ id: "reading", status: "Reading", pagesRead: 100, totalPages: 300, rating: 4 }),
    book({ id: "dropped", status: "Dropped", pagesRead: 20, totalPages: 300 }),
    book({ id: "soon", status: "Plan to Read", releaseDate: "2026-12-01" }),
    book({ id: "words", status: "Reading", progressUnit: "words", wordsRead: 12500, totalWords: 90000 }),
  ];

  it("excludes Dropped and To be released from the completion ratio", () => {
    const stats = bookStats(books, NOW);
    expect(stats.total).toBe(5);
    expect(stats.counting).toBe(3);
    expect(stats.completed).toBe(1);
    expect(stats.percent).toBe(33);
  });

  it("counts a fully-read entry as done even without the status", () => {
    const stats = bookStats([book({ id: "ticked", status: "Reading", pagesRead: 300, totalPages: 300 })], NOW);
    expect(stats.completed).toBe(1);
    expect(stats.percent).toBe(100);
  });

  it("adds pages across both units", () => {
    // 528 + 100 + 20 + 0 + (12500/250 = 50)
    expect(bookStats(books, NOW).pagesRead).toBe(698);
  });

  it("averages only the entries that were rated", () => {
    expect(bookStats(books, NOW).averageRating).toBe(4.5);
    expect(bookStats([book({ id: "none" })], NOW).averageRating).toBe(0);
  });

  it("counts a derived upcoming entry as upcoming, not as planned", () => {
    const stats = bookStats(books, NOW);
    expect(stats.upcoming).toBe(1);
    expect(stats.planned).toBe(0);
  });

  it("adds manga chapters and volumes separately", () => {
    const stats = mangaStats(
      [manga({ id: "b", chaptersRead: 300, totalChapters: 374, volumesRead: 34, totalVolumes: 42 })],
      NOW,
    );
    expect(stats.chaptersRead).toBe(300);
    expect(stats.volumesRead).toBe(34);
    expect(stats.volumesTotal).toBe(42);
  });

  it("combines both shelves for the widget stats", () => {
    const reading = createReadingData();
    reading.books = books;
    reading.manga = [manga({ id: "done", status: "Completed", chaptersRead: 10, totalChapters: 10 })];

    const stats = computeReadingStats(reading, NOW);
    expect(stats.totalEntries).toBe(6);
    expect(stats.totalCompleted).toBe(2);
    expect(pagesRead(reading)).toBe(698);
    expect(readingCompleted(reading, NOW)).toBe(2);
  });

  it("lists future releases in date order for the Upcoming tab", () => {
    const reading = createReadingData();
    reading.books = [
      book({ id: "later", releaseDate: "2027-01-01" }),
      book({ id: "sooner", releaseDate: "2026-09-01" }),
      book({ id: "past", releaseDate: "2020-01-01" }),
    ];
    expect(upcomingReleases(reading, NOW).map((row) => row.entry.id)).toEqual(["sooner", "later"]);
  });

  it("is all zeroes, not a division by zero, on an empty library", () => {
    const stats = computeReadingStats(createReadingData(), NOW);
    expect(stats.percent).toBe(0);
    expect(stats.books.percent).toBe(0);
    expect(stats.pagesRead).toBe(0);
  });
});
