/**
 * The reading store — and the promise the whole lane rests on: **editing a v3
 * row does not lose anything v4 has never heard of.**
 *
 * `tests/reading-games.test.ts` pins that for *migration*. This pins it for
 * *writing*, which is the dangerous half: the moment a version starts saving a
 * structure it previously only carried, one `{...defaults, ...patch}` deletes
 * every unknown field on the row. The fixture is the same real-shaped v3 file,
 * carrying `shelfLocation`, `lentTo` and `physicalCopies`, and every test below
 * edits a row and then goes looking for them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WatchLogStore } from "../src/data/store";
import { createReadingStore, buildReadingEntry, findExistingReading } from "../src/domains/reading/store";
import { bumpPatch, progressPatch } from "../src/domains/reading/progress";
import {
  createColumn,
  columnDisplay,
  nextColumnId,
  readColumnValue,
  selectOptions,
  withoutColumn,
  writeColumnValue,
} from "../src/domains/reading/columns";
import { installDomGlobals } from "./helpers/dom";
import type { Book, Manga } from "../src/types";

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/data-v3-parity.json",
);
const TEXT = readFileSync(FIXTURE, "utf8");

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals();
});

afterEach(() => {
  restore();
});

async function loaded() {
  const saved: unknown[] = [];
  const store = new WatchLogStore({
    loadData: async () => JSON.parse(TEXT) as unknown,
    saveData: async (data: unknown) => {
      saved.push(data);
    },
  } as never);
  await store.load();
  return { store, reading: createReadingStore(store), saved };
}

/** The raw record, for reading keys TypeScript does not know about. */
function rec(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("editing a v3 row keeps the v3 row", () => {
  it("loads the fixture's books and manga as they are", async () => {
    const { reading } = await loaded();
    expect(reading.allBooks().map((book) => book.id)).toEqual(["dune", "half-filled"]);
    expect(reading.allManga().map((manga) => manga.id)).toEqual(["berserk"]);
  });

  it("keeps unknown per-row fields through an update", async () => {
    const { reading } = await loaded();
    reading.updateBook("dune", { rating: 4 });
    const book = rec(reading.getBook("dune"));
    expect(book.rating).toBe(4);
    expect(book.shelfLocation).toBe("top shelf, left");
    expect(book.lentTo).toBe("Marta");
  });

  it("keeps unknown per-row fields on a manga through a progress bump", async () => {
    const { reading } = await loaded();
    const berserk = reading.getManga("berserk");
    expect(berserk).toBeDefined();
    if (!berserk) return;
    reading.updateManga("berserk", bumpPatch(berserk, 1));
    const after = rec(reading.getManga("berserk"));
    expect(after.chaptersRead).toBe(301);
    expect(after.physicalCopies).toBe(12);
  });

  it("mutates the live row rather than replacing it", async () => {
    const { reading } = await loaded();
    const before = reading.getBook("dune");
    reading.updateBook("dune", { rating: 3 });
    // Same object identity: anything holding a reference sees the edit, and
    // nothing was rebuilt from a typed literal.
    expect(reading.getBook("dune")).toBe(before);
  });

  it("keeps v3's own settings keys, including the unnamed preset", async () => {
    const { store, reading } = await loaded();
    reading.updateBook("dune", { rating: 5 });
    const settings = rec(store.reading.settings);
    expect(settings.savedFilterPreset).toEqual({ statusExclude: ["Dropped"], sort: "title" });
    expect(settings.readingViewDensity).toBe("cosy");
    expect(rec(store.data.reading).legacyImportedFrom).toBe("goodreads-2019");
  });

  it("stamps dateModified and never dateAdded", async () => {
    const { reading } = await loaded();
    const before = reading.getBook("dune");
    const added = before?.dateAdded;
    reading.updateBook("dune", { rating: 2 });
    const after = reading.getBook("dune");
    expect(after?.dateAdded).toBe(added);
    expect(after?.dateModified).not.toBe("2024-02-01T09:00:00.000Z");
  });

  it("refuses to write id, dateAdded or dateModified from a patch", async () => {
    const { reading } = await loaded();
    reading.updateBook("dune", { id: "hacked", dateAdded: "1999-01-01" } as never);
    const book = reading.getBook("dune");
    expect(book?.id).toBe("dune");
    expect(book?.dateAdded).toBe("2024-01-01T09:00:00.000Z");
  });

  it("skips undefined so a half-filled form cannot blank a field", async () => {
    const { reading } = await loaded();
    reading.updateBook("dune", { author: undefined, rating: 1 });
    expect(reading.getBook("dune")?.author).toBe("Frank Herbert");
  });

  it("persists — the edit reaches the saved payload", async () => {
    const { store, reading, saved } = await loaded();
    reading.updateBook("dune", { rating: 1 });
    await store.flush();
    const payload = rec(saved.at(-1));
    const books = rec(payload.reading).books as Record<string, unknown>[];
    expect(books[0]?.rating).toBe(1);
    expect(books[0]?.lentTo).toBe("Marta");
  });
});

// ---------------------------------------------------------------------------
// Adding and removing
// ---------------------------------------------------------------------------

describe("adding and removing", () => {
  it("adds a complete row with every contract field present", async () => {
    const { reading } = await loaded();
    const entry = buildReadingEntry(
      "book",
      reading.nextId("book", "Neuromancer"),
      { title: "Neuromancer", author: "William Gibson", totalPages: 271 },
      reading.reading,
    ) as Book;
    reading.addBook(entry);

    const stored = reading.getBook(entry.id);
    expect(stored).toBeDefined();
    // The defaults come from `data/schema.ts`, so a new row and a repaired v3
    // row are the same shape.
    expect(stored?.progressUnit).toBe("pages");
    expect(stored?.customFields).toEqual({});
    expect(stored?.status).toBe("Reading"); // the fixture's configured default
    expect(stored?.totalPages).toBe(271);
  });

  it("gives a new row an id nothing else is using", async () => {
    const { reading } = await loaded();
    expect(reading.nextId("book", "Dune")).not.toBe("dune");
  });

  it("logs to the activity history with v3's Reading source", async () => {
    const { store, reading } = await loaded();
    const entry = buildReadingEntry("manga", "vinland", { title: "Vinland Saga" }, reading.reading) as Manga;
    reading.addManga(entry);
    const latest = store.data.history[0];
    expect(latest?.source).toBe("Reading");
    expect(latest?.message).toContain("Vinland Saga");
  });

  it("logs a finish once, when the entry becomes complete", async () => {
    const { store, reading } = await loaded();
    const book = reading.getBook("half-filled");
    expect(book).toBeDefined();
    if (!book) return;
    reading.updateBook("half-filled", progressPatch(book, 90000));
    const completions = store.data.history.filter((entry) => entry.action === "completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.titleId).toBe("half-filled");
  });

  it("removes a row and reports whether it removed one", async () => {
    const { reading } = await loaded();
    expect(reading.deleteBook("dune")).toBe(true);
    expect(reading.deleteBook("dune")).toBe(false);
    expect(reading.allBooks().map((book) => book.id)).toEqual(["half-filled"]);
  });

  it("finds an existing entry by name, case-insensitively", async () => {
    const { reading } = await loaded();
    expect(findExistingReading(reading.reading, "book", "  dune ")?.id).toBe("dune");
    expect(findExistingReading(reading.reading, "manga", "dune")).toBeUndefined();
  });

  it("calls the change hook so the note mirror can follow", async () => {
    const seen: string[] = [];
    const store = new WatchLogStore({
      loadData: async () => JSON.parse(TEXT) as unknown,
      saveData: async () => undefined,
    } as never);
    await store.load();
    const reading = createReadingStore(store, {
      onChanged: (entry, kind, id) => seen.push(`${kind}:${id}:${entry ? "live" : "gone"}`),
    });
    // A patch that changes nothing is not a change: it does not save, does not
    // emit, and does not rewrite a note. The fixture already rates Dune 5.
    reading.updateBook("dune", { rating: 5 });
    expect(seen).toEqual([]);

    reading.updateBook("dune", { rating: 3 });
    reading.deleteBook("dune");
    expect(seen).toEqual(["book:dune:live", "book:dune:gone"]);
  });

  it("survives a note hook that throws — the edit still lands", async () => {
    const store = new WatchLogStore({
      loadData: async () => JSON.parse(TEXT) as unknown,
      saveData: async () => undefined,
    } as never);
    await store.load();
    const reading = createReadingStore(store, {
      onChanged: () => {
        throw new Error("vault is read-only");
      },
    });
    expect(() => reading.updateBook("dune", { rating: 5 })).not.toThrow();
    expect(reading.getBook("dune")?.rating).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Custom columns
// ---------------------------------------------------------------------------

describe("custom columns", () => {
  it("keeps the two column lists apart", async () => {
    const { reading } = await loaded();
    expect(reading.columns("book").map((column) => column.id)).toEqual(["col-1", "col-2"]);
    expect(reading.columns("manga")).toEqual([]);
  });

  it("repairs an unknown column type without dropping the column", async () => {
    const { reading } = await loaded();
    // The fixture's `col-2` has `type: "weird-type"`; migration coerces it.
    const column = reading.columns("book")[1];
    expect(column?.name).toBe("Notes to self");
    expect(["text", "number", "select"]).toContain(column?.type);
  });

  it("reads a value that was stored under a select column", async () => {
    const { reading } = await loaded();
    const column = reading.columns("book")[0];
    const book = reading.getBook("dune");
    expect(column && book && columnDisplay(book, column)).toBe("Sci-Fi");
  });

  it("deletes the key rather than writing an empty string", async () => {
    const { reading } = await loaded();
    const column = reading.columns("book")[0];
    const book = reading.getBook("dune");
    if (!column || !book) throw new Error("fixture changed");
    const cleared = writeColumnValue(book, column, "   ");
    expect(cleared).toEqual({});
    const set = writeColumnValue(book, column, "Crime");
    expect(set).toEqual({ "col-1": "Crime" });
  });

  it("coerces a number column, and keeps unparseable text rather than losing it", async () => {
    const { reading } = await loaded();
    const numeric = createColumn("Copies", "number", reading.columns("book"));
    const book = reading.getBook("dune");
    if (!book) throw new Error("fixture changed");
    expect(writeColumnValue(book, numeric, "12")[numeric.id]).toBe(12);
    expect(writeColumnValue(book, numeric, "twelve")[numeric.id]).toBe("twelve");
    book.customFields[numeric.id] = "12";
    expect(readColumnValue(book, numeric)).toBe(12);
  });

  it("offers every option that exists, declared or not", async () => {
    const { reading } = await loaded();
    const column = reading.columns("book")[0];
    if (!column) throw new Error("fixture changed");
    // `Crime` is declared but unused; `Sci-Fi` is both.
    expect(selectOptions(column, reading.allBooks())).toEqual(["Sci-Fi", "Crime"]);
  });

  it("removing a column keeps what was typed into it", async () => {
    const { reading } = await loaded();
    const before = reading.getBook("dune")?.customFields["col-1"];
    reading.setColumns("book", withoutColumn(reading.columns("book"), "col-1"));
    expect(reading.columns("book").map((column) => column.id)).toEqual(["col-2"]);
    expect(reading.getBook("dune")?.customFields["col-1"]).toBe(before);
  });

  it("continues v3's id shape without colliding", async () => {
    const { reading } = await loaded();
    expect(nextColumnId(reading.columns("book"))).toBe("col-3");
  });
});
