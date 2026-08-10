/**
 * Public book ratings + store links (community.ts): edition picking, the
 * fetch chain, the ISBN-13→10 conversion Amazon product links depend on.
 */
import { describe, expect, it, vi } from "vitest";
import type { BookSearchResult, GoogleBooksClient } from "../src/types";
import {
  amazonUrl,
  communityQuery,
  communityRatingPatch,
  fetchBookRating,
  formatCommunityRating,
  googleBooksUrl,
  isbn13To10,
  pickRatedResult,
} from "../src/domains/reading/community";

const hit = (over: Partial<BookSearchResult>): BookSearchResult => ({
  id: "vol",
  source: "googlebooks",
  title: "Dune",
  authors: ["Frank Herbert"],
  coverUrl: "",
  ...over,
});

describe("pickRatedResult", () => {
  it("takes the first result that actually carries ratings", () => {
    const found = pickRatedResult([
      hit({}),
      hit({ averageRating: 4.5, ratingsCount: 1234 }),
      hit({ averageRating: 3 }),
    ]);
    expect(found).toEqual({ rating: 4.5, votes: 1234 });
  });

  it("returns null when no edition is rated", () => {
    expect(pickRatedResult([hit({}), hit({})])).toBeNull();
    expect(pickRatedResult([])).toBeNull();
  });
});

describe("fetchBookRating", () => {
  const book = { title: "Dune", author: "Frank Herbert", isbn: "9780441172719" };

  it("asks by ISBN first and stops when that edition is rated", async () => {
    const byIsbn = vi.fn(async () => hit({ averageRating: 4.2, ratingsCount: 9, categories: ["Fiction"] }));
    const search = vi.fn();
    const client = { configured: () => true, byIsbn, search } as unknown as GoogleBooksClient;
    expect(await fetchBookRating(client, book)).toEqual({
      rated: { rating: 4.2, votes: 9 },
      categories: ["Fiction"],
    });
    expect(byIsbn).toHaveBeenCalledWith("9780441172719");
    expect(search).not.toHaveBeenCalled();
  });

  it("falls through to a title+author search when the ISBN edition is unrated", async () => {
    const byIsbn = vi.fn(async () => hit({}));
    const search = vi.fn(async () => [hit({ averageRating: 4, ratingsCount: 2 })]);
    const client = { configured: () => true, byIsbn, search } as unknown as GoogleBooksClient;
    expect(await fetchBookRating(client, book)).toEqual({
      rated: { rating: 4, votes: 2 },
      categories: [],
    });
    expect(search).toHaveBeenCalledWith('intitle:"Dune" inauthor:"Frank Herbert"', 10);
  });

  it("recovers the ISBN from an Open Library cover URL", async () => {
    const byIsbn = vi.fn(async () => hit({ averageRating: 5, ratingsCount: 1 }));
    const client = { configured: () => true, byIsbn, search: vi.fn() } as unknown as GoogleBooksClient;
    await fetchBookRating(client, {
      title: "T",
      author: "",
      coverUrl: "https://covers.openlibrary.org/b/isbn/9781484267073-M.jpg?default=false",
    });
    expect(byIsbn).toHaveBeenCalledWith("9781484267073");
  });

  it("keeps the unrated ISBN edition's categories when the search finds the rating", async () => {
    const byIsbn = vi.fn(async () => hit({ categories: ["Computers"] }));
    const search = vi.fn(async () => [hit({ averageRating: 4, ratingsCount: 2 })]);
    const client = { configured: () => true, byIsbn, search } as unknown as GoogleBooksClient;
    expect(await fetchBookRating(client, book)).toEqual({
      rated: { rating: 4, votes: 2 },
      categories: ["Computers"],
    });
  });
});

describe("communityQuery", () => {
  it("drops the author clause when there is no author", () => {
    expect(communityQuery({ title: "Dune", author: "" })).toBe('intitle:"Dune"');
  });
});

describe("communityRatingPatch", () => {
  const NOW = new Date("2026-08-10T12:00:00Z");

  it("stores the find with its stamp", () => {
    expect(
      communityRatingPatch({ rated: { rating: 4.5, votes: 10 }, categories: [] }, {}, NOW),
    ).toEqual({
      communitySource: "google",
      communityRatingLastFetched: "2026-08-10T12:00:00.000Z",
      communityRating: 4.5,
      communityVotes: 10,
    });
  });

  it("stamps an honest zero for 'no rated edition'", () => {
    const patch = communityRatingPatch({ rated: null, categories: [] }, {}, NOW);
    expect(patch.communityRating).toBe(0);
    expect(patch.communityRatingLastFetched).toBe("2026-08-10T12:00:00.000Z");
  });

  it("fills empty categories but never overwrites the user's", () => {
    const fill = communityRatingPatch({ rated: null, categories: ["Computers"] }, {}, NOW);
    expect(fill.categories).toEqual(["Computers"]);
    const keep = communityRatingPatch(
      { rated: null, categories: ["Computers"] },
      { categories: ["My shelf"] },
      NOW,
    );
    expect(keep.categories).toBeUndefined();
  });
});

describe("isbn13To10", () => {
  it("converts a 978 ISBN-13, computing the check digit", () => {
    // 9780441172719 is Dune; its ISBN-10 is 0441172717.
    expect(isbn13To10("9780441172719")).toBe("0441172717");
  });

  it("emits X check digits", () => {
    expect(isbn13To10("9780439420891")).toBe("043942089X");
  });

  it("refuses 979 ISBNs (no ISBN-10 exists for them) and junk", () => {
    expect(isbn13To10("9791234567896")).toBe("");
    expect(isbn13To10("not-an-isbn")).toBe("");
  });
});

describe("store links", () => {
  it("links the exact Google volume when the id is known", () => {
    expect(googleBooksUrl({ title: "Dune", author: "", googleBooksId: "abc123" })).toBe(
      "https://books.google.com/books?id=abc123",
    );
  });

  it("links by ISBN when only the ISBN is known", () => {
    expect(googleBooksUrl({ title: "Dune", author: "", isbn: "9780441172719" })).toBe(
      "https://books.google.com/books?vid=ISBN9780441172719",
    );
  });

  it("amazon uses a product page for a derivable ISBN-10", () => {
    expect(amazonUrl({ title: "Dune", author: "", isbn: "9780441172719" })).toBe(
      "https://www.amazon.com/dp/0441172717",
    );
  });

  it("amazon falls back to a books search without an ISBN", () => {
    expect(amazonUrl({ title: "Dune", author: "Frank Herbert" })).toBe(
      "https://www.amazon.com/s?i=stripbooks&k=Dune%20Frank%20Herbert",
    );
  });
});

describe("formatCommunityRating", () => {
  it("formats value and count, singular and plural", () => {
    expect(formatCommunityRating(4.5, 1234)).toBe("4.5 · 1,234 ratings");
    expect(formatCommunityRating(4, 1)).toBe("4 · 1 rating");
    expect(formatCommunityRating(3.2, 0)).toBe("3.2");
  });
});
