/**
 * The two book clients (SPEC2 §D-READING; `report-media-apis.md` §2).
 *
 * Every response body below is copied from the live captures in the research
 * report, and every one of them is a fixture: no test in this repo touches the
 * network, and the fake transport throws loudly on an unrouted URL.
 *
 * What is worth pinning is the set of facts that are cheap to lose in a refactor
 * and expensive to notice in production — the User-Agent that triples the rate
 * limit, `?default=false` on covers, `/api/books` over the redirecting ISBN
 * endpoint, `fields=` on search, and the fact that a keyless Google Books call
 * must fail *before* it is made.
 */
import { describe, expect, it } from "vitest";
import { createFakeHttp, createTestClock } from "../mocks/http";
import { createRateLimiter } from "../../src/services/ratelimit";
import {
  DEFAULT_OPEN_LIBRARY_UA,
  createOpenLibraryClient,
  describeBookError,
  openLibraryCoverUrl,
  pickIsbn,
} from "../../src/services/openlibrary";
import {
  cleanThumbnail,
  createGoogleBooksClient,
  isbnFromVolume,
  normalizeVolume,
} from "../../src/services/googlebooks";
import { isApiError } from "../../src/services/http";

// --- fixtures, verbatim from the report ------------------------------------

const SEARCH_BODY = {
  numFound: 20956,
  start: 0,
  docs: [
    {
      key: "/works/OL893414W",
      title: "Dune",
      author_name: ["Frank Herbert"],
      first_publish_year: 1965,
      isbn: ["0425071790", "9780441013593"],
      cover_i: 6976407,
      number_of_pages_median: 528,
    },
  ],
};

const API_BOOKS_BODY = {
  "ISBN:9780441013593": {
    url: "http://openlibrary.org/books/OL17952222M/Dune",
    key: "/books/OL17952222M",
    title: "Dune",
    authors: [{ url: "http://openlibrary.org/authors/OL79034A/Frank_Herbert", name: "Frank Herbert" }],
    number_of_pages: 528,
    identifiers: { isbn_13: ["9780441013593"], openlibrary: ["OL17952222M"] },
    publishers: [{ name: "Ace Books" }],
    publish_date: "2005",
  },
};

const GOOGLE_BODY = {
  kind: "books#volumes",
  totalItems: 1041,
  items: [
    {
      id: "B1hSG45JCX4C",
      volumeInfo: {
        title: "Dune",
        authors: ["Frank Herbert"],
        publishedDate: "2005-08-02",
        description: "A stunning blend of adventure and mysticism.",
        industryIdentifiers: [
          { type: "ISBN_10", identifier: "0441013597" },
          { type: "ISBN_13", identifier: "9780441013593" },
        ],
        pageCount: 528,
        imageLinks: {
          smallThumbnail: "http://books.google.com/books/content?id=B1&zoom=5&edge=curl",
          thumbnail: "http://books.google.com/books/content?id=B1&zoom=1&edge=curl",
        },
      },
    },
  ],
};

/** Instant limiter, so the 334 ms politeness gap never costs a test 334 ms. */
function limiter() {
  const { clock } = createTestClock();
  return createRateLimiter(0, clock);
}

function openLibrary(routes: Record<string, unknown>, userAgent = DEFAULT_OPEN_LIBRARY_UA) {
  const fake = createFakeHttp(routes as never);
  const client = createOpenLibraryClient(() => ({ userAgent }), {
    http: fake.http,
    limiter: limiter(),
  });
  return { client, fake };
}

function googleBooks(routes: Record<string, unknown>, apiKey: string) {
  const fake = createFakeHttp(routes as never);
  const client = createGoogleBooksClient(() => ({ apiKey }), {
    http: fake.http,
    limiter: limiter(),
  });
  return { client, fake };
}

// ---------------------------------------------------------------------------
// Open Library
// ---------------------------------------------------------------------------

describe("Open Library search", () => {
  it("is usable with no key at all", () => {
    const { client } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    expect(client.configured()).toBe(true);
  });

  it("sends the descriptive User-Agent — it is worth 3 req/s instead of 1", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    await client.search("dune");
    expect(fake.calls[0]?.headers?.["User-Agent"]).toBe(DEFAULT_OPEN_LIBRARY_UA);
  });

  it("falls back to the default UA rather than going out anonymous", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } }, "   ");
    await client.search("dune");
    expect(fake.calls[0]?.headers?.["User-Agent"]).toBe(DEFAULT_OPEN_LIBRARY_UA);
  });

  it("always asks for a field list — a bare doc carries 60+ ISBNs", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    await client.search("dune");
    const url = fake.urls[0] ?? "";
    expect(url).toContain("fields=");
    expect(url).toContain("number_of_pages_median");
  });

  it("normalises a doc into the shared result shape", async () => {
    const { client } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    const [hit] = await client.search("dune");
    expect(hit).toMatchObject({
      id: "/works/OL893414W",
      source: "openlibrary",
      title: "Dune",
      authors: ["Frank Herbert"],
      firstPublishYear: 1965,
      pageCount: 528,
    });
    // The 13-digit ISBN is preferred over the 10-digit one.
    expect(hit?.isbn).toBe("9780441013593");
  });

  it("covers a result from its cover id, with the blank-image guard", async () => {
    const { client } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    const [hit] = await client.search("dune");
    expect(hit?.coverUrl).toBe(
      "https://covers.openlibrary.org/b/id/6976407-M.jpg?default=false",
    );
  });

  it("returns nothing for an empty query without calling out", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    expect(await client.search("   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Open Library ISBN lookup", () => {
  it("uses /api/books, not the redirecting /isbn/{isbn}.json", async () => {
    const { client, fake } = openLibrary({ "/api/books": { body: API_BOOKS_BODY } });
    await client.byIsbn("978-0-441-01359-3");
    const url = fake.urls[0] ?? "";
    expect(url).toContain("/api/books");
    expect(url).toContain("bibkeys=ISBN%3A9780441013593");
    expect(url).toContain("jscmd=data");
  });

  it("reads the record out from under the bibkey it was asked for", async () => {
    const { client } = openLibrary({ "/api/books": { body: API_BOOKS_BODY } });
    const hit = await client.byIsbn("9780441013593");
    expect(hit).toMatchObject({
      title: "Dune",
      authors: ["Frank Herbert"],
      pageCount: 528,
      firstPublishYear: 2005,
      isbn: "9780441013593",
    });
    expect(hit?.coverUrl).toContain("/b/olid/OL17952222M-M.jpg?default=false");
  });

  it("treats an empty object as a miss — a bad ISBN is a 200, not a 404", async () => {
    const { client } = openLibrary({ "/api/books": { body: {} } });
    expect(await client.byIsbn("0000000000")).toBeUndefined();
  });
});

describe("cover URLs", () => {
  it("always carries ?default=false, or a missing cover caches as a blank image", () => {
    expect(openLibraryCoverUrl("isbn", "9780441013593")).toBe(
      "https://covers.openlibrary.org/b/isbn/9780441013593-M.jpg?default=false",
    );
    expect(openLibraryCoverUrl("olid", "OL1M", "L")).toContain("-L.jpg?default=false");
  });

  it("is empty for an empty key, rather than a URL that 404s", () => {
    expect(openLibraryCoverUrl("isbn", "  ")).toBe("");
  });
});

describe("pickIsbn", () => {
  it("prefers ISBN-13 and strips punctuation", () => {
    expect(pickIsbn(["0-441-01359-7", "978-0-441-01359-3"])).toBe("9780441013593");
  });

  it("falls back to whatever it has", () => {
    expect(pickIsbn(["044101359X"])).toBe("044101359X");
    expect(pickIsbn([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Google Books
// ---------------------------------------------------------------------------

describe("Google Books", () => {
  it("is not configured without a key — the anonymous quota is zero", () => {
    const { client } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "");
    expect(client.configured()).toBe(false);
  });

  it("refuses to make a keyless request at all", async () => {
    const { client, fake } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "");
    await expect(client.search("dune")).rejects.toThrow();
    // The point: it fails *before* the call, not with a 429 from Google.
    expect(fake.calls).toHaveLength(0);
    await client.search("dune").catch((error: unknown) => {
      expect(isApiError(error) && error.reason).toBe("no-key");
    });
  });

  it("sends the key and honours the 40-result ceiling", async () => {
    const { client, fake } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "abc123");
    await client.search("dune", 500);
    const url = fake.urls[0] ?? "";
    expect(url).toContain("key=abc123");
    expect(url).toContain("maxResults=40");
  });

  it("normalises a volume, upgrading the thumbnail to https", async () => {
    const { client } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "abc123");
    const [hit] = await client.search("dune");
    expect(hit).toMatchObject({
      id: "B1hSG45JCX4C",
      source: "googlebooks",
      title: "Dune",
      authors: ["Frank Herbert"],
      firstPublishYear: 2005,
      pageCount: 528,
      isbn: "9780441013593",
    });
    expect(hit?.coverUrl.startsWith("https://")).toBe(true);
    expect(hit?.coverUrl).not.toContain("edge=curl");
  });

  it("searches by ISBN with the isbn: operator", async () => {
    const { client, fake } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "abc123");
    await client.byIsbn("978-0-441-01359-3");
    expect(fake.urls[0]).toContain("q=isbn%3A9780441013593");
  });

  it("ignores totalItems, which disagrees with items.length", async () => {
    const { client } = googleBooks({ "/volumes": { body: GOOGLE_BODY } }, "abc123");
    expect(await client.search("dune")).toHaveLength(1);
  });

  it("falls back to an Open Library cover when Google has no image", () => {
    const hit = normalizeVolume({
      id: "x",
      volumeInfo: {
        title: "Old Edition",
        industryIdentifiers: [{ type: "ISBN_13", identifier: "9780441013593" }],
      },
    });
    expect(hit.coverUrl).toContain("covers.openlibrary.org");
    expect(hit.coverUrl).toContain("default=false");
  });
});

describe("volume helpers", () => {
  it("prefers ISBN-13 over ISBN-10", () => {
    expect(
      isbnFromVolume({
        industryIdentifiers: [
          { type: "ISBN_10", identifier: "0441013597" },
          { type: "ISBN_13", identifier: "9780441013593" },
        ],
      }),
    ).toBe("9780441013593");
  });

  it("cleans a thumbnail without inventing one", () => {
    expect(cleanThumbnail("")).toBe("");
    expect(cleanThumbnail("http://x/y?edge=curl&a=1")).toBe("https://x/y?a=1");
  });
});

// ---------------------------------------------------------------------------
// Failure sentences
// ---------------------------------------------------------------------------

describe("describeBookError", () => {
  it("names the provider that actually failed", async () => {
    const { client } = googleBooks({ "/volumes": { status: 429, body: { error: {} } } }, "abc");
    const message = await client.search("dune").then(
      () => "",
      (error: unknown) => describeBookError(error),
    );
    expect(message).toContain("Google Books");
    expect(message).toContain("quota");
  });

  it("points a rate-limited Open Library user at the setting that helps", async () => {
    const { client } = openLibrary({ "/search.json": { status: 429, body: {} } });
    const message = await client.search("dune").then(
      () => "",
      (error: unknown) => describeBookError(error),
    );
    expect(message).toContain("Open Library");
    expect(message).toContain("contact address");
  });

  it("handles a plain Error without pretending it was an API failure", () => {
    expect(describeBookError(new Error("boom"))).toBe("boom");
  });
});
