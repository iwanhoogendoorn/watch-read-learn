/**
 * Authors — the name resolver, the cache and the bibliography shaping.
 *
 * The two things worth pinning hardest are the same two the person service pins,
 * because they are the two ways an author page can be confidently wrong:
 *
 *   - **Ambiguity is reported, never guessed.** `John Williams` is the composer
 *     *and* the novelist. A resolver that takes the first hit puts a stranger's
 *     entire body of work on the page and says nothing about it.
 *   - **A second open is free.** Everything fetched lands in `data.json`, so the
 *     screen has no reason to touch the network twice. Several tests here assert
 *     the *absence* of calls rather than their result.
 *
 * No network, ever: the client is a stub whose unstubbed methods fail the test
 * the moment they are reached.
 */
import { describe, expect, it, vi } from "vitest";
import { createBook } from "../src/data/schema";
import type { Book, BookSearchResult, WatchLogData } from "../src/types";
import type { AuthorCandidate, OpenLibraryAuthor, OpenLibraryAuthorApi } from "../src/services/openlibrary";
import {
  AUTHOR_CACHE_KEY,
  authorCacheOf,
  authorNameKey,
  authorNamesOf,
  booksBy,
  createAuthorService,
  evictAuthors,
  exactAuthorHits,
  ownedBookFor,
  resolveAuthorByName,
  sameAuthorName,
  sortWorks,
  type AuthorCacheEntry,
  type AuthorStoreLike,
} from "../src/services/openlibrary-author";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function author(overrides: Partial<OpenLibraryAuthor> = {}): OpenLibraryAuthor {
  return {
    key: "OL79034A",
    name: "Frank Herbert",
    personalName: "",
    biography: "American science fiction writer.",
    birthDate: "8 October 1920",
    deathDate: "11 February 1986",
    alternateNames: [],
    links: [],
    photoUrl: "",
    wikipedia: "",
    workCount: 0,
    ...overrides,
  };
}

function work(title: string, year?: number, id = `/works/${title}`): BookSearchResult {
  const result: BookSearchResult = {
    id,
    source: "openlibrary",
    title,
    authors: [],
    coverUrl: "",
  };
  if (year !== undefined) result.firstPublishYear = year;
  return result;
}

function candidate(overrides: Partial<AuthorCandidate> & { key: string; name: string }): AuthorCandidate {
  return {
    alternateNames: [],
    birthDate: "",
    deathDate: "",
    topWork: "",
    workCount: 0,
    ...overrides,
  };
}

function book(overrides: Partial<Book> & { id: string; title: string }): Book {
  return createBook(overrides);
}

/** A store stub. Cast because the test only owns the keys the service reads. */
function storeStub(books: Book[] = []) {
  const data = { schemaVersion: 4, titles: [], groups: [], history: [] } as unknown as WatchLogData;
  const save = vi.fn();
  const store: AuthorStoreLike & { save: ReturnType<typeof vi.fn> } = {
    data,
    books: () => books,
    save,
  };
  return store;
}

/**
 * A client that fails the test if a method it was not given is reached.
 *
 * This is what makes "renders with no network call" a proof rather than a claim:
 * a path that reaches for the network throws instead of merely being slow.
 */
function fakeClient(overrides: Partial<OpenLibraryAuthorApi> = {}): OpenLibraryAuthorApi & {
  calls: string[];
} {
  const calls: string[] = [];
  const guard = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return {
    calls,
    author: guard("author"),
    authorWorks: guard("authorWorks"),
    searchAuthors: guard("searchAuthors"),
    authorKeysFor: guard("authorKeysFor"),
    ...overrides,
  } as OpenLibraryAuthorApi & { calls: string[] };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("author name keys", () => {
  it("sees through the punctuation an initial is written with", () => {
    // The same name arrives from two providers spelled two ways; a bibliography
    // that misses because of a full stop is a bibliography nobody sees.
    expect(sameAuthorName("Samuel R. Delany", "Samuel R Delany")).toBe(true);
    expect(sameAuthorName("J.R.R. Tolkien", "J R R Tolkien")).toBe(true);
    expect(sameAuthorName("Ursula K. Le Guin", "Ursula K Le  Guin")).toBe(true);
  });

  it("sees through diacritics, which the stored string may or may not carry", () => {
    expect(sameAuthorName("Gabriel Garcia Marquez", "Gabriel García Márquez")).toBe(true);
    expect(authorNameKey("Émile Zola")).toBe(authorNameKey("Emile Zola"));
  });

  it("treats an apostrophe as joining, not separating", () => {
    // The half of the key the person side does not need: this one is applied to
    // book titles too, and `hitchhiker s guide` matches nothing.
    expect(authorNameKey("The Hitchhiker\u2019s Guide")).toBe("the hitchhikers guide");
    expect(sameAuthorName("O'Brian", "OBrian")).toBe(true);
  });

  it("still tells two different authors apart", () => {
    expect(sameAuthorName("Frank Herbert", "Brian Herbert")).toBe(false);
    expect(sameAuthorName("", "")).toBe(false);
    expect(sameAuthorName("   ", "Frank Herbert")).toBe(false);
  });

  it("reads a multi-author field as the list it is, and as the string it might be", () => {
    expect(authorNamesOf({ author: "Frank Herbert, Brian Herbert" })).toEqual([
      "Frank Herbert, Brian Herbert",
      "Frank Herbert",
      "Brian Herbert",
    ]);
    expect(authorNamesOf({ author: "Gilbert & Sullivan" })).toContain("Sullivan");
    expect(authorNamesOf({ author: "Frank Herbert" })).toEqual(["Frank Herbert"]);
    expect(authorNamesOf({})).toEqual([]);
  });

  it("finds the books by an author, most recently touched first", () => {
    const shelf = [
      book({ id: "a", title: "Dune", author: "Frank Herbert", dateModified: "2026-01-01T00:00:00Z" }),
      book({ id: "b", title: "Dune Messiah", author: "Frank Herbert", dateModified: "2026-05-01T00:00:00Z" }),
      book({ id: "c", title: "Stoner", author: "John Williams" }),
    ];
    expect(booksBy(shelf, "frank herbert").map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("exact author hits", () => {
  it("keeps only the authors who actually carry the name", () => {
    const hits = [
      candidate({ key: "OL1A", name: "Frank Herbert", workCount: 5 }),
      candidate({ key: "OL2A", name: "Frank Herbert Jr.", workCount: 900 }),
    ];
    expect(exactAuthorHits(hits, "Frank Herbert").map((h) => h.key)).toEqual(["OL1A"]);
  });

  it("counts an alternate spelling as the same person, which is what it means", () => {
    const hits = [candidate({ key: "OL1A", name: "Fyodor Dostoevsky", alternateNames: ["Fëdor Dostoevskij"] })];
    expect(exactAuthorHits(hits, "Fëdor Dostoevskij")).toHaveLength(1);
  });

  it("leads with the fuller body of work without ever choosing it", () => {
    const hits = [
      candidate({ key: "OL1A", name: "John Williams", workCount: 34 }),
      candidate({ key: "OL2A", name: "John Williams", workCount: 118 }),
    ];
    expect(exactAuthorHits(hits, "John Williams").map((h) => h.key)).toEqual(["OL2A", "OL1A"]);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolving a name to an author", () => {
  it("prefers the key Open Library itself attached to a book the user owns", async () => {
    const client = fakeClient({
      authorKeysFor: async () => [{ key: "OL79034A", name: "Frank Herbert" }],
    });
    const outcome = await resolveAuthorByName("Frank Herbert", {
      client,
      books: [book({ id: "a", title: "Dune", author: "Frank Herbert" })],
    });

    expect(outcome).toEqual({
      state: "resolved",
      key: "OL79034A",
      name: "Frank Herbert",
      source: "books",
    });
    // The name search was never reached — the owned book was an answer.
    expect(client.calls).toEqual([]);
  });

  it("asks which author rather than picking, when two owned books disagree", async () => {
    // Two keys, one name, both in this library. This is the case a resolver that
    // takes the first hit gets confidently, invisibly wrong.
    const client = fakeClient({
      authorKeysFor: async (title) => [
        title === "Stoner"
          ? { key: "OL118060A", name: "John Williams" }
          : { key: "OL234297A", name: "John Williams" },
      ],
    });
    const outcome = await resolveAuthorByName("John Williams", {
      client,
      books: [
        book({ id: "a", title: "Stoner", author: "John Williams", dateModified: "2026-05-01T00:00:00Z" }),
        book({ id: "b", title: "Star Wars", author: "John Williams", dateModified: "2026-01-01T00:00:00Z" }),
      ],
    });

    expect(outcome.state).toBe("ambiguous");
    if (outcome.state !== "ambiguous") return;
    expect(outcome.candidates.map((c) => c.key).sort()).toEqual(["OL118060A", "OL234297A"]);
    // And each one says which book placed it, or the picker cannot be answered.
    expect(outcome.candidates.map((c) => c.topWork).sort()).toEqual(["Star Wars", "Stoner"]);
  });

  it("asks which author rather than picking, when the name search returns two", async () => {
    const client = fakeClient({
      searchAuthors: async () => [
        candidate({ key: "OL118060A", name: "John Williams", topWork: "Stoner", workCount: 34 }),
        candidate({ key: "OL234297A", name: "John Williams", topWork: "Star Wars", workCount: 118 }),
      ],
    });
    const outcome = await resolveAuthorByName("John Williams", { client, books: [] });

    expect(outcome.state).toBe("ambiguous");
    if (outcome.state !== "ambiguous") return;
    expect(outcome.candidates.map((c) => c.key)).toEqual(["OL234297A", "OL118060A"]);
  });

  it("resolves a name written with initials against a record written without", async () => {
    const client = fakeClient({
      searchAuthors: async () => [
        candidate({ key: "OL26320A", name: "Samuel R Delany", workCount: 90 }),
        candidate({ key: "OL99A", name: "Samuel Delany-Smith", workCount: 4 }),
      ],
    });
    const outcome = await resolveAuthorByName("Samuel R. Delany", { client, books: [] });
    expect(outcome).toMatchObject({ state: "resolved", key: "OL26320A", source: "search" });
  });

  it("falls through to the name search when the owned books say nothing", async () => {
    const client = fakeClient({
      authorKeysFor: async () => [],
      searchAuthors: async () => [candidate({ key: "OL79034A", name: "Frank Herbert" })],
    });
    const outcome = await resolveAuthorByName("Frank Herbert", {
      client,
      books: [book({ id: "a", title: "Dune", author: "Frank Herbert" })],
    });
    expect(outcome).toMatchObject({ state: "resolved", source: "search" });
  });

  it("keeps going when one book's lookup fails", async () => {
    let asked = 0;
    const client = fakeClient({
      authorKeysFor: async () => {
        asked += 1;
        if (asked === 1) throw new Error("upstream is down");
        return [{ key: "OL79034A", name: "Frank Herbert" }];
      },
    });
    const outcome = await resolveAuthorByName("Frank Herbert", {
      client,
      books: [
        book({ id: "a", title: "Dune", author: "Frank Herbert", dateModified: "2026-05-01T00:00:00Z" }),
        book({ id: "b", title: "Dune Messiah", author: "Frank Herbert", dateModified: "2026-01-01T00:00:00Z" }),
      ],
    });
    expect(outcome).toMatchObject({ state: "resolved", key: "OL79034A" });
  });

  it("spends at most three requests on the shelf before asking by name", async () => {
    let asked = 0;
    const client = fakeClient({
      authorKeysFor: async () => {
        asked += 1;
        return [];
      },
      searchAuthors: async () => [],
    });
    const shelf = Array.from({ length: 9 }, (_, i) =>
      book({ id: `b${i}`, title: `Book ${i}`, author: "Frank Herbert" }),
    );
    await resolveAuthorByName("Frank Herbert", { client, books: shelf });
    expect(asked).toBe(3);
  });

  it("says it does not know rather than inventing an author", async () => {
    const client = fakeClient({ searchAuthors: async () => [] });
    expect(await resolveAuthorByName("Nobody At All", { client, books: [] })).toEqual({
      state: "unknown",
      name: "Nobody At All",
    });
    // A failing search is not an author either.
    const broken = fakeClient({
      searchAuthors: async () => {
        throw new Error("offline");
      },
    });
    expect(await resolveAuthorByName("Frank Herbert", { client: broken, books: [] })).toMatchObject({
      state: "unknown",
    });
  });

  it("does not go looking for an empty name", async () => {
    const client = fakeClient();
    expect(await resolveAuthorByName("   ", { client, books: [] })).toMatchObject({ state: "unknown" });
    expect(client.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bibliography shaping
// ---------------------------------------------------------------------------

describe("bibliography shaping", () => {
  it("puts the newest work first and the undated ones at the end", () => {
    const sorted = sortWorks([
      work("Undated B"),
      work("Dune", 1965),
      work("Undated A"),
      work("Dune Messiah", 1969),
    ]);
    expect(sorted.map((w) => w.title)).toEqual([
      "Dune Messiah",
      "Dune",
      "Undated A",
      "Undated B",
    ]);
  });

  it("does not mutate the list it was handed", () => {
    const works = [work("B", 1), work("A", 2)];
    sortWorks(works);
    expect(works.map((w) => w.title)).toEqual(["B", "A"]);
  });

  it("recognises a book already on the shelf, punctuation and all", () => {
    const shelf = [
      book({ id: "a", title: "The Hitchhikers Guide to the Galaxy", author: "Douglas Adams" }),
    ];
    expect(ownedBookFor(work("The Hitchhiker's Guide to the Galaxy"), shelf)?.id).toBe("a");
    expect(ownedBookFor(work("Dune"), shelf)).toBeUndefined();
    expect(ownedBookFor(work(""), shelf)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

describe("the author cache", () => {
  it("lives under a preserved key and is created on first use", () => {
    const store = storeStub();
    const cache = authorCacheOf(store.data);
    expect(cache).toEqual({ version: 1, byKey: {}, names: {} });
    expect((store.data as unknown as Record<string, unknown>)[AUTHOR_CACHE_KEY]).toBe(cache);
  });

  it("discards a cache written by a version it cannot read", () => {
    const store = storeStub();
    (store.data as unknown as Record<string, unknown>)[AUTHOR_CACHE_KEY] = {
      version: 99,
      byKey: { OL1A: {} },
      names: {},
    };
    expect(authorCacheOf(store.data).byKey).toEqual({});
  });

  it("evicts the oldest authors at the cap", () => {
    const cache = { version: 1, byKey: {} as Record<string, AuthorCacheEntry>, names: {} };
    for (let i = 0; i < 5; i += 1) {
      cache.byKey[`OL${i}A`] = {
        author: author(),
        works: [],
        fetchedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
      };
    }
    evictAuthors(cache, 3);
    expect(Object.keys(cache.byKey).sort()).toEqual(["OL2A", "OL3A", "OL4A"]);
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

describe("the author service", () => {
  it("fetches an author once and answers from the cache after that", async () => {
    let loads = 0;
    const client = fakeClient({
      author: async () => {
        loads += 1;
        return author();
      },
      authorWorks: async () => [work("Dune", 1965)],
    });
    const store = storeStub();
    const service = createAuthorService({ store, client, now: () => 1_000 });

    const first = await service.load("OL79034A");
    expect(first.author.name).toBe("Frank Herbert");
    expect(first.works[0]?.authors).toEqual(["Frank Herbert"]);
    expect(store.save).toHaveBeenCalledWith("author-cached");

    await service.load("OL79034A");
    expect(loads).toBe(1);
    // And synchronously, with no promise at all.
    expect(service.cached("OL79034A")?.author.name).toBe("Frank Herbert");
    expect(service.cached("ol79034a")?.author.name).toBe("Frank Herbert");
  });

  it("orders the bibliography as it caches it", async () => {
    const client = fakeClient({
      author: async () => author(),
      authorWorks: async () => [work("Undated"), work("Dune", 1965), work("Dune Messiah", 1969)],
    });
    const service = createAuthorService({ store: storeStub(), client, now: () => 0 });
    const entry = await service.load("OL79034A");
    expect(entry.works.map((w) => w.title)).toEqual(["Dune Messiah", "Dune", "Undated"]);
  });

  it("serves the stale copy rather than an error screen", async () => {
    const client = fakeClient({
      author: async () => author(),
      authorWorks: async () => [],
    });
    const store = storeStub();
    let now = 0;
    const service = createAuthorService({ store, client, now: () => now, ttlMs: 10_000 });
    await service.load("OL79034A");

    now = 999_999;
    const broken = createAuthorService({
      store,
      client: fakeClient({
        author: async () => {
          throw new Error("upstream is down");
        },
      }),
      now: () => now,
      ttlMs: 10_000,
    });
    const entry = await broken.load("OL79034A");
    expect(entry.author.name).toBe("Frank Herbert");
    expect(broken.isStale(entry)).toBe(true);
  });

  it("throws when there is nothing cached to fall back to", async () => {
    const service = createAuthorService({
      store: storeStub(),
      client: fakeClient({
        author: async () => {
          throw new Error("upstream is down");
        },
      }),
      now: () => 0,
    });
    await expect(service.load("OL79034A")).rejects.toThrow("upstream is down");
  });

  it("resolves a name once and never asks again", async () => {
    let searches = 0;
    const client = fakeClient({
      searchAuthors: async () => {
        searches += 1;
        return [candidate({ key: "OL79034A", name: "Frank Herbert" })];
      },
    });
    const store = storeStub();
    const service = createAuthorService({ store, client, now: () => 0 });

    expect(await service.resolve("Frank Herbert")).toMatchObject({ key: "OL79034A" });
    expect(await service.resolve("frank  herbert")).toMatchObject({ source: "cache" });
    expect(searches).toBe(1);
    // The synchronous path is what the screen uses to paint without a request.
    expect(service.cachedResolution("Frank Herbert")).toMatchObject({
      state: "resolved",
      key: "OL79034A",
    });
  });

  it("remembers an ambiguity as an ambiguity, not as its first candidate", async () => {
    const client = fakeClient({
      searchAuthors: async () => [
        candidate({ key: "OL118060A", name: "John Williams", workCount: 34 }),
        candidate({ key: "OL234297A", name: "John Williams", workCount: 118 }),
      ],
    });
    const store = storeStub();
    const service = createAuthorService({ store, client, now: () => 0 });

    expect(await service.resolve("John Williams")).toMatchObject({ state: "ambiguous" });
    // Re-asked, it is still a question — never quietly settled into an answer.
    const again = service.cachedResolution("John Williams");
    expect(again?.state).toBe("ambiguous");
    if (again?.state !== "ambiguous") return;
    expect(again.candidates.map((c) => c.key)).toEqual(["OL234297A", "OL118060A"]);
  });

  it("pins the answer the user gave to the picker", async () => {
    const client = fakeClient();
    const store = storeStub();
    const service = createAuthorService({ store, client, now: () => 0 });

    service.rememberChoice("John Williams", "ol118060a");
    expect(service.cachedResolution("John Williams")).toMatchObject({
      state: "resolved",
      key: "OL118060A",
    });
    // Nothing was fetched to record a choice.
    expect(client.calls).toEqual([]);
  });

  it("keeps a name that has never been looked up out of the cache", () => {
    const service = createAuthorService({ store: storeStub(), client: fakeClient(), now: () => 0 });
    expect(service.cachedResolution("Nobody")).toBeUndefined();
    expect(service.cachedResolution("   ")).toBeUndefined();
  });

  it("is available with no key at all — Open Library needs none", () => {
    const service = createAuthorService({ store: storeStub(), client: fakeClient() });
    expect(service.configured()).toBe(true);
  });
});
