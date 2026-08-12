/**
 * Book-file linking — the pure candidate/destination logic behind the
 * "File in vault" field (bookfile.ts).
 */
import { describe, expect, it } from "vitest";
import {
  bookFileScore,
  collisionFreePath,
  importDestination,
  isBookFilePath,
  pdfProgressActions,
  rankBookFiles,
  recordBookPage,
} from "../src/domains/reading/bookfile";

describe("isBookFilePath", () => {
  it("accepts the readable formats, case-insensitively", () => {
    expect(isBookFilePath("Books/Dune.epub")).toBe(true);
    expect(isBookFilePath("Books/Dune.PDF")).toBe(true);
    expect(isBookFilePath("Comics/One Piece v1.cbz")).toBe(true);
  });

  it("rejects notes, images and the extensionless", () => {
    expect(isBookFilePath("Books/Dune.md")).toBe(false);
    expect(isBookFilePath("covers/dune.jpg")).toBe(false);
    expect(isBookFilePath("README")).toBe(false);
  });
});

describe("bookFileScore", () => {
  it("scores full title coverage as 1", () => {
    expect(bookFileScore("Books/Getting Started with NSX-T.pdf", "Getting Started with NSX-T")).toBe(1);
  });

  it("scores by fraction of title words present, ignoring punctuation and case", () => {
    // logical + routing hit, "and"/"switching" miss (2/4), one extra word (nsx).
    expect(bookFileScore("books/nsx-t-logical-routing.epub", "Logical Routing and Switching")).toBeCloseTo(
      0.49,
      5,
    );
  });

  it("prefers the exact file over one that says more than the title", () => {
    const exact = bookFileScore("Books/Dune.epub", "Dune");
    const longer = bookFileScore("Books/Dune Messiah.epub", "Dune");
    expect(exact).toBeGreaterThan(longer);
  });

  it("gives an unrelated file a non-positive score", () => {
    expect(bookFileScore("Recipes/pasta.pdf", "Dune")).toBeLessThanOrEqual(0);
  });
});

describe("rankBookFiles", () => {
  const paths = [
    "Recipes/pasta.pdf",
    "Books/Dune.epub",
    "Books/Dune Messiah.epub",
    "Notes/Dune.md",
    "att/scan.jpg",
  ];

  it("keeps only book formats, best title match first, and drops nothing readable", () => {
    expect(rankBookFiles(paths, "Dune")).toEqual([
      "Books/Dune.epub",
      "Books/Dune Messiah.epub",
      "Recipes/pasta.pdf",
    ]);
  });

  it("breaks score ties alphabetically for a stable list", () => {
    expect(rankBookFiles(["b/x.pdf", "a/x.pdf"], "unrelated words")).toEqual(["a/x.pdf", "b/x.pdf"]);
  });
});

describe("importDestination", () => {
  it("lands in the configured reading folder", () => {
    expect(importDestination("Reading", "Dune.epub")).toBe("Reading/Dune.epub");
  });

  it("falls back to the vault root when no folder is set", () => {
    expect(importDestination("", "Dune.epub")).toBe("Dune.epub");
    expect(importDestination("  ", "Dune.epub")).toBe("Dune.epub");
  });

  it("tolerates stray slashes in the setting", () => {
    expect(importDestination("/Reading/Books/", "Dune.epub")).toBe("Reading/Books/Dune.epub");
  });
});

describe("collisionFreePath", () => {
  it("keeps a free path as-is", () => {
    expect(collisionFreePath("Books/Dune.epub", () => false)).toBe("Books/Dune.epub");
  });

  it("numbers past every taken name, keeping the extension", () => {
    const taken = new Set(["Books/Dune.epub", "Books/Dune-2.epub"]);
    expect(collisionFreePath("Books/Dune.epub", (p) => taken.has(p))).toBe("Books/Dune-3.epub");
  });

  it("handles extensionless paths", () => {
    expect(collisionFreePath("Books/README", (p) => p === "Books/README")).toBe("Books/README-2");
  });
});

describe("recordBookPage", () => {
  const book = (filePath?: string, filePage?: number) =>
    ({ filePath, filePage }) as { filePath?: string; filePage?: number };

  it("bookmarks the entry that links the open file", () => {
    const entry = book("Books/Dune.pdf");
    const changed = recordBookPage({ books: [entry], manga: [] }, "Books/Dune.pdf", 87);
    expect(changed).toBe(true);
    expect(entry.filePage).toBe(87);
  });

  it("is silent when the page has not moved", () => {
    const entry = book("Books/Dune.pdf", 87);
    expect(recordBookPage({ books: [entry], manga: [] }, "Books/Dune.pdf", 87)).toBe(false);
  });

  it("ignores files no entry links", () => {
    const entry = book("Books/Dune.pdf", 12);
    expect(recordBookPage({ books: [entry], manga: [] }, "Other/War.pdf", 3)).toBe(false);
    expect(entry.filePage).toBe(12);
  });

  it("covers manga too", () => {
    const entry = book("Manga/BLAME v1.pdf");
    expect(recordBookPage({ books: [], manga: [entry] }, "Manga/BLAME v1.pdf", 5)).toBe(true);
    expect(entry.filePage).toBe(5);
  });
});

describe("pdfProgressActions", () => {
  const tracked = (over: Partial<import("../src/domains/reading/bookfile").TrackedBook> = {}) => ({
    id: "dune",
    filePath: "Books/Dune.pdf",
    pagesRead: 0,
    totalPages: 0,
    progressUnit: "pages",
    ...over,
  });
  const open = (page: number, pageCount?: number) => [
    pageCount === undefined
      ? { path: "Books/Dune.pdf", page }
      : { path: "Books/Dune.pdf", page, pageCount },
  ];

  it("adopts the PDF's total for a book without one, immediately", () => {
    const actions = pdfProgressActions([tracked()], open(1, 320), new Map());
    expect(actions).toEqual([{ id: "dune", read: 1, adoptTotal: 320 }]);
  });

  it("waits a stride before flushing an advance", () => {
    const flushed = new Map([["Books/Dune.pdf", 10]]);
    expect(pdfProgressActions([tracked({ pagesRead: 10, totalPages: 320 })], open(12, 320), flushed)).toEqual([]);
    expect(pdfProgressActions([tracked({ pagesRead: 10, totalPages: 320 })], open(13, 320), flushed)).toEqual([
      { id: "dune", read: 13 },
    ]);
  });

  it("flushes the final page without waiting for a stride", () => {
    const flushed = new Map([["Books/Dune.pdf", 319]]);
    expect(pdfProgressActions([tracked({ pagesRead: 319, totalPages: 320 })], open(320, 320), flushed)).toEqual([
      { id: "dune", read: 320 },
    ]);
  });

  it("follows the reader backwards, because progress is where you are", () => {
    const actions = pdfProgressActions(
      [tracked({ pagesRead: 100, totalPages: 320 })],
      open(3, 320),
      new Map(),
    );
    expect(actions).toEqual([{ id: "dune", read: 3 }]);
  });

  it("throttles going back by the same stride as going forward", () => {
    const flushed = new Map([["Books/Dune.pdf", 100]]);
    // Two pages back is a glance, not a move.
    expect(
      pdfProgressActions([tracked({ pagesRead: 100, totalPages: 320 })], open(98, 320), flushed),
    ).toEqual([]);
    expect(
      pdfProgressActions([tracked({ pagesRead: 100, totalPages: 320 })], open(97, 320), flushed),
    ).toEqual([{ id: "dune", read: 97 }]);
  });

  it("says nothing while the page has not moved at all", () => {
    const flushed = new Map([["Books/Dune.pdf", 100]]);
    expect(
      pdfProgressActions([tracked({ pagesRead: 100, totalPages: 320 })], open(100, 320), flushed),
    ).toEqual([]);
  });

  it("refuses auto-progress when the user's total disagrees with the PDF", () => {
    // 528 print pages typed by hand, 560-page PDF: page numbers are not
    // comparable, so the counter stays the user's.
    const actions = pdfProgressActions(
      [tracked({ pagesRead: 10, totalPages: 528 })],
      open(90, 560),
      new Map(),
    );
    expect(actions).toEqual([]);
  });

  it("leaves word-tracked books alone", () => {
    expect(pdfProgressActions([tracked({ progressUnit: "words" })], open(50, 320), new Map())).toEqual([]);
  });

  it("does nothing without any total to measure against", () => {
    expect(pdfProgressActions([tracked()], open(50), new Map())).toEqual([]);
  });

  it("clamps a viewer page past the total to the last page", () => {
    const done = pdfProgressActions(
      [tracked({ pagesRead: 300, totalPages: 320 })],
      open(400, 320),
      new Map(),
    );
    expect(done).toEqual([{ id: "dune", read: 320 }]);
  });
});

describe("what may be imported from disk", () => {
  it("accepts the formats a vault plausibly holds a book in", () => {
    // The file picker's `accept` list is built from this, so a format missing
    // here is a format the user cannot choose.
    for (const ext of ["pdf", "epub", "mobi", "azw3", "cbz", "cbr", "djvu"]) {
      expect(isBookFilePath(`Somewhere/A Book.${ext}`), ext).toBe(true);
    }
  });

  it("refuses what is not a book, whatever it is called", () => {
    expect(isBookFilePath("Notes/A Book.md")).toBe(false);
    expect(isBookFilePath("Covers/A Book.jpg")).toBe(false);
    expect(isBookFilePath("A Book")).toBe(false);
  });

  it("lands an import in the reading folder, and in the root without one", () => {
    expect(importDestination("WRL/Reading", "Dune.epub")).toBe("WRL/Reading/Dune.epub");
    expect(importDestination("", "Dune.epub")).toBe("Dune.epub");
  });

  it("never overwrites a book already sitting there", () => {
    const taken = new Set(["WRL/Reading/Dune.epub", "WRL/Reading/Dune-2.epub"]);
    expect(collisionFreePath("WRL/Reading/Dune.epub", (p) => taken.has(p))).toBe(
      "WRL/Reading/Dune-3.epub",
    );
  });
});
