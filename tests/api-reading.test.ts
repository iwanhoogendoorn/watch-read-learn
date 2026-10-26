/**
 * `/books` and `/audiobooks` over the API — against the real `WatchLogStore`
 * and reading store, with only `loadData`/`saveData` mocked.
 *
 * The fixture is the v3 parity file, so every write below lands on a data root
 * and on rows carrying keys v4 has never declared (`maybe`, `shelfLocation`,
 * `lentTo`, `legacyImportedFrom`). The preservation tests compare saved JSON
 * before and after a write and insist that everything the write did not touch
 * is deep-equal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WatchLogStore } from "../src/data/store";
import { createReadingStore } from "../src/domains/reading/store";
import { readingRoutes } from "../src/api/routes/reading";
import { ApiError, type ApiDeps, type ApiResponse } from "../src/api/types";
import { installDomGlobals } from "./helpers/dom";

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/data-v3-parity.json",
);
const TEXT = readFileSync(FIXTURE, "utf8");

/** A fixed "now": local 14 March 2026, so `todayString` is predictable. */
const NOW = new Date(2026, 2, 14, 12, 0, 0);

type Json = Record<string, unknown>;

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals();
});

afterEach(() => {
  restore();
});

async function setup() {
  /** Deep copies of every write, in order — what actually reached "disk". */
  const saved: Json[] = [];
  const store = new WatchLogStore({
    loadData: async () => JSON.parse(TEXT) as unknown,
    saveData: async (data: unknown) => {
      // A write that takes a moment, so "awaited" and "merely queued" differ.
      await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(JSON.parse(JSON.stringify(data)) as Json);
    },
  } as never);
  await store.load();
  const reading = createReadingStore(store);
  const deps: ApiDeps = { store, reading, version: "test", revision: () => 0, now: () => NOW };

  /** One request, with `ApiError` mapped the way the server maps it. */
  async function call(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<ApiResponse> {
    try {
      const res = await readingRoutes({ method, path, query, body, remote: false }, deps);
      if (res === undefined) return { status: -1, body: undefined };
      return res;
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  }

  /** The current state of the data, as `saveData` would see it. */
  const snapshot = (): Json => JSON.parse(JSON.stringify(store.data)) as Json;
  const last = (): Json => {
    const value = saved[saved.length - 1];
    if (!value) throw new Error("nothing was saved");
    return value;
  };
  const savedBooks = (): Json[] => ((last().reading as Json).books as Json[]);
  const savedBook = (id: string): Json | undefined => savedBooks().find((book) => book.id === id);

  return { store, reading, deps, call, saved, snapshot, last, savedBook };
}

const ids = (res: ApiResponse): string[] => (res.body as Json[]).map((item) => item.id as string);
const json = (res: ApiResponse): Json => res.body as Json;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe("books CRUD", () => {
  it("creates, reads, updates and deletes a book", async () => {
    const { call, savedBook } = await setup();

    const made = await call("POST", "/books", {
      title: "The Left Hand of Darkness",
      author: "Ursula K. Le Guin",
      categories: ["Fiction"],
      ids: { googleBooks: "abc123", openLibrary: "/works/OL59863W" },
      progress: { unit: "pages", totalPages: 304 },
    });
    expect(made.status).toBe(201);
    const book = json(made);
    expect(book).toMatchObject({
      kind: "book",
      title: "The Left Hand of Darkness",
      author: "Ursula K. Le Guin",
      status: "Reading",
      rating: 0,
      review: null,
      favorite: false,
      categories: ["Fiction"],
      ids: { googleBooks: "abc123", openLibrary: "/works/OL59863W" },
      progress: { unit: "pages", pagesRead: 0, totalPages: 304 },
    });
    const id = book.id as string;
    expect(savedBook(id)).toMatchObject({ title: "The Left Hand of Darkness", totalPages: 304, openLibraryKey: "/works/OL59863W" });
    expect(savedBook(id)).not.toHaveProperty("format");

    const got = await call("GET", `/books/${id}`);
    expect(got.status).toBe(200);
    expect(json(got)).toEqual(book);

    const patched = await call("PATCH", `/books/${id}`, { rating: 4, favorite: true, pagesRead: 120 });
    expect(patched.status).toBe(200);
    expect(json(patched)).toMatchObject({ rating: 4, favorite: true, progress: { pagesRead: 120, totalPages: 304, percent: 39 } });
    expect(savedBook(id)).toMatchObject({ rating: 4, favorite: true, pagesRead: 120 });

    expect(ids(await call("GET", "/books"))).toContain(id);

    const gone = await call("DELETE", `/books/${id}`);
    expect(gone.status).toBe(200);
    expect(savedBook(id)).toBeUndefined();
    expect((await call("GET", `/books/${id}`)).status).toBe(404);
  });

  it("serves the fixture's v3 rows, words and all", async () => {
    const { call } = await setup();
    const res = await call("GET", "/books/half-filled");
    expect(json(res)).toMatchObject({
      kind: "book",
      status: "Reading",
      progress: { unit: "words", wordsRead: 12500, totalWords: 90000, percent: 14 },
    });
  });
});

describe("audiobooks CRUD", () => {
  it("creates, reads, updates and deletes an audiobook, with minutes and the Open Library key as extra keys", async () => {
    const { call, savedBook } = await setup();

    const made = await call("POST", "/audiobooks", {
      title: "Project Hail Mary",
      author: "Andy Weir",
      openLibraryKey: "/works/OL21745884W",
      review: "  Rocky!  ",
      progress: { unit: "minutes", listenedMinutes: 90, totalMinutes: 970 },
    });
    expect(made.status).toBe(201);
    const book = json(made);
    const id = book.id as string;
    expect(book).toMatchObject({
      kind: "audiobook",
      review: "Rocky!",
      ids: { googleBooks: null, openLibrary: "/works/OL21745884W" },
      progress: { unit: "minutes", listenedMinutes: 90, totalMinutes: 970, percent: 9 },
    });

    const row = savedBook(id);
    expect(row).toMatchObject({
      format: "audiobook",
      listenedMinutes: 90,
      totalMinutes: 970,
      openLibraryKey: "/works/OL21745884W",
      review: "Rocky!",
    });

    expect(json(await call("GET", `/audiobooks/${id}`))).toEqual(book);

    const patched = await call("PATCH", `/audiobooks/${id}`, { listenedMinutes: 500, review: "Better on a re-listen" });
    expect(patched.status).toBe(200);
    expect(json(patched)).toMatchObject({ review: "Better on a re-listen", progress: { listenedMinutes: 500, totalMinutes: 970 } });
    expect(savedBook(id)).toMatchObject({ listenedMinutes: 500, review: "Better on a re-listen", format: "audiobook" });

    // A PATCH touching only extra keys still reaches disk.
    const cleared = await call("PATCH", `/audiobooks/${id}`, { review: null, openLibraryKey: null });
    expect(json(cleared)).toMatchObject({ review: null, ids: { openLibrary: null } });
    expect(savedBook(id)).not.toHaveProperty("review");
    expect(savedBook(id)).not.toHaveProperty("openLibraryKey");

    expect((await call("DELETE", `/audiobooks/${id}`)).status).toBe(200);
    expect(savedBook(id)).toBeUndefined();
    expect((await call("GET", `/audiobooks/${id}`)).status).toBe(404);
  });

  it("refuses page counters on an audiobook and minutes on a book", async () => {
    const { call } = await setup();
    expect((await call("POST", "/audiobooks", { title: "X", pagesRead: 3 })).status).toBe(400);
    expect((await call("POST", "/books", { title: "Y", listenedMinutes: 3 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The two collections
// ---------------------------------------------------------------------------

describe("books and audiobooks are disjoint", () => {
  it("lists each row in exactly one collection, and 404s it through the other", async () => {
    const { call, reading } = await setup();
    const audio = json(await call("POST", "/audiobooks", { title: "Dune", totalMinutes: 1260 }));
    const book = json(await call("POST", "/books", { title: "Neuromancer" }));
    const audioId = audio.id as string;
    const bookId = book.id as string;

    const books = ids(await call("GET", "/books"));
    const audiobooks = ids(await call("GET", "/audiobooks"));
    expect(books).toContain(bookId);
    expect(books).toContain("dune");
    expect(books).not.toContain(audioId);
    expect(audiobooks).toEqual([audioId]);

    expect((await call("GET", `/books/${audioId}`)).status).toBe(404);
    expect((await call("PATCH", `/books/${audioId}`, { rating: 1 })).status).toBe(404);
    expect((await call("DELETE", `/books/${audioId}`)).status).toBe(404);
    expect((await call("POST", `/books/${audioId}/read`, {})).status).toBe(404);
    expect((await call("GET", `/audiobooks/${bookId}`)).status).toBe(404);
    expect((await call("DELETE", `/audiobooks/dune`)).status).toBe(404);
    expect(reading.getBook(audioId)).toBeDefined();
    expect(reading.getBook("dune")).toBeDefined();
  });

  it("leaves paths that are not its own alone", async () => {
    const { call } = await setup();
    expect((await call("GET", "/films")).status).toBe(-1);
    expect((await call("GET", "/manga")).status).toBe(-1);
    expect((await call("GET", "/books/dune/notes")).status).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Preservation
// ---------------------------------------------------------------------------

describe("writes keep what they did not touch", () => {
  it("PATCH keeps customFields, unknown row keys and unknown root keys", async () => {
    const { call, snapshot, last } = await setup();
    const before = snapshot();

    const res = await call("PATCH", "/books/dune", { rating: 3, review: "Spice" });
    expect(res.status).toBe(200);
    const after = last();

    // The root: everything but the activity log and the reading block is untouched.
    const strip = (data: Json): Json => {
      const { history: _history, reading: _reading, ...rest } = data;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after.maybe).toEqual([{ id: "maybe-something", releaseDate: "2027-01-01" }]);

    const beforeReading = before.reading as Json;
    const afterReading = after.reading as Json;
    const { books: beforeBooks, ...beforeRest } = beforeReading;
    const { books: afterBooks, ...afterRest } = afterReading;
    expect(afterRest).toEqual(beforeRest);
    expect(afterRest).toHaveProperty("legacyImportedFrom");

    // The other row is identical; the edited row differs only where it was edited.
    const find = (rows: unknown, id: string): Json => (rows as Json[]).find((row) => row.id === id) as Json;
    expect(find(afterBooks, "half-filled")).toEqual(find(beforeBooks, "half-filled"));
    const { rating: r0, dateModified: m0, ...duneBefore } = find(beforeBooks, "dune");
    const { rating: r1, dateModified: m1, review, ...duneAfter } = find(afterBooks, "dune");
    expect([r0, r1]).toEqual([5, 3]);
    expect(m1).not.toBe(m0);
    expect(review).toBe("Spice");
    expect(duneAfter).toEqual(duneBefore);
    expect(duneAfter).toMatchObject({ shelfLocation: "top shelf, left", lentTo: "Marta", customFields: { "col-1": "Sci-Fi" } });
  });

  it("log read keeps unknown row keys too", async () => {
    const { call, savedBook } = await setup();
    await call("POST", "/books/dune/read", { date: "2026-03-01" });
    expect(savedBook("dune")).toMatchObject({
      shelfLocation: "top shelf, left",
      lentTo: "Marta",
      customFields: { "col-1": "Sci-Fi" },
      dateFinished: "2026-03-01",
    });
  });
});

// ---------------------------------------------------------------------------
// Log read
// ---------------------------------------------------------------------------

describe("log read", () => {
  it("finishes a book on the given date and fills its counter", async () => {
    const { call, savedBook } = await setup();
    const res = await call("POST", "/books/half-filled/read", { date: "2026-03-10", rating: 4, review: "Long" });
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      status: "Completed",
      rating: 4,
      review: "Long",
      dates: { dateFinished: "2026-03-10", dateStarted: "2026-03-10" },
      progress: { unit: "words", wordsRead: 90000, totalWords: 90000, percent: 100 },
    });
    expect(savedBook("half-filled")).toMatchObject({ status: "Completed", dateFinished: "2026-03-10", review: "Long" });
  });

  it("defaults to today, keeps an existing start date, and treats rating 0 and an empty review as not given", async () => {
    const { call, savedBook } = await setup();
    const res = await call("POST", "/books/dune/read", { rating: 0, review: "  " });
    expect(json(res)).toMatchObject({
      status: "Completed",
      rating: 5,
      review: null,
      dates: { dateStarted: "2024-01-01", dateFinished: "2026-03-14" },
    });
    expect(savedBook("dune")).not.toHaveProperty("review");
  });

  it("finishes an audiobook by filling its minutes", async () => {
    const { call, savedBook } = await setup();
    const id = json(await call("POST", "/audiobooks", { title: "Circe", listenedMinutes: 10, totalMinutes: 720 })).id as string;
    const res = await call("POST", `/audiobooks/${id}/read`, {});
    expect(json(res)).toMatchObject({
      status: "Completed",
      dates: { dateFinished: "2026-03-14" },
      progress: { listenedMinutes: 720, totalMinutes: 720, percent: 100 },
    });
    expect(savedBook(id)).toMatchObject({ status: "Completed", dateFinished: "2026-03-14", listenedMinutes: 720 });
  });

  it("rejects a malformed date", async () => {
    const { call } = await setup();
    expect((await call("POST", "/books/dune/read", { date: "2026-02-30" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Validation and errors
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("rejects an unknown status with 400", async () => {
    const { call } = await setup();
    expect((await call("POST", "/books", { title: "Z", status: "Finished" })).status).toBe(400);
    expect((await call("PATCH", "/books/dune", { status: "Read" })).status).toBe(400);
    expect((await call("GET", "/books", undefined, { status: "nope" })).status).toBe(400);
  });

  it("rejects out-of-range ratings, negative or fractional progress and a missing title", async () => {
    const { call } = await setup();
    expect((await call("PATCH", "/books/dune", { rating: 6 })).status).toBe(400);
    expect((await call("PATCH", "/books/dune", { pagesRead: -1 })).status).toBe(400);
    expect((await call("PATCH", "/books/dune", { progress: { totalPages: 1.5 } })).status).toBe(400);
    expect((await call("POST", "/books", { author: "Nobody" })).status).toBe(400);
    expect((await call("POST", "/books", "not an object")).status).toBe(400);
  });

  it("answers a duplicate title in the same collection with 409", async () => {
    const { call } = await setup();
    expect((await call("POST", "/books", { title: "  dune " })).status).toBe(409);
    // The same title as an audiobook is a different thing to own.
    expect((await call("POST", "/audiobooks", { title: "Dune" })).status).toBe(201);
    expect((await call("POST", "/audiobooks", { title: "DUNE" })).status).toBe(409);
    expect((await call("PATCH", "/books/half-filled", { title: "Dune" })).status).toBe(409);
  });

  it("answers a missing id with 404", async () => {
    const { call } = await setup();
    expect((await call("GET", "/books/no-such-book")).status).toBe(404);
    expect((await call("PATCH", "/books/no-such-book", { rating: 1 })).status).toBe(404);
    expect((await call("DELETE", "/audiobooks/no-such-book")).status).toBe(404);
    expect((await call("POST", "/books/no-such-book/read", {})).status).toBe(404);
  });
});

describe("lists", () => {
  it("filters by status and honours limit", async () => {
    const { call } = await setup();
    expect(ids(await call("GET", "/books", undefined, { status: "Completed" }))).toEqual(["dune"]);
    expect(ids(await call("GET", "/books", undefined, { status: "Reading" }))).toEqual(["half-filled"]);
    expect(ids(await call("GET", "/books", undefined, { limit: "1" }))).toHaveLength(1);
    expect((await call("GET", "/books", undefined, { limit: "0" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe("every write is on disk before it answers", () => {
  it("has completed saveData by the time each write handler resolves", async () => {
    const { call, saved, savedBook } = await setup();
    const writes: [string, string, unknown][] = [
      ["POST", "/audiobooks", { title: "Piranesi", totalMinutes: 400 }],
      ["PATCH", "/books/dune", { favorite: false }],
      ["POST", "/books/half-filled/read", {}],
      ["DELETE", "/books/half-filled", undefined],
    ];
    for (const [method, path, body] of writes) {
      const count = saved.length;
      const res = await call(method, path, body);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(saved.length).toBeGreaterThan(count);
    }
    expect(savedBook("dune")).toMatchObject({ favorite: false });
    expect(savedBook("half-filled")).toBeUndefined();
  });
});
