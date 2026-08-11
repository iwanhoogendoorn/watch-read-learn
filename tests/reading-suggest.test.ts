/**
 * Book suggestions.
 *
 * Books have no "people who liked this also liked" — Goodreads' API closed in
 * 2020 and Google Books needs a key — so the signal is Open Library's subjects,
 * which are specific enough to be useful and noisy enough to need filtering.
 * These tests pin both halves: what gets scored, and what gets refused.
 */
import { describe, expect, it } from "vitest";
import {
  bookKey,
  pickReadingSeeds,
  rankBookSuggestions,
  readingSeedWeight,
  usefulSubjects,
  type BookCandidate,
} from "../src/domains/reading/suggest";
import { createBook } from "../src/data/schema";
import type { Book, BookSuggestionHit } from "../src/types";

function hit(over: Partial<BookSuggestionHit> = {}): BookSuggestionHit {
  return {
    id: "/works/OL1W",
    source: "openlibrary",
    title: "A Book",
    authors: ["An Author"],
    coverUrl: "",
    subjects: [],
    ratingsAverage: 4,
    ratingsCount: 20,
    ...over,
  };
}

function book(over: Partial<Book>): Book {
  const b = createBook({ id: "b", title: "Seed" });
  Object.assign(b, over);
  return b;
}

describe("how much a book's opinion is worth", () => {
  it("lets a rating speak loudest", () => {
    expect(readingSeedWeight(book({ rating: 5 }))).toBe(1);
  });

  it("treats finishing as a quieter yes and dropping as a no", () => {
    expect(readingSeedWeight(book({ rating: 0, status: "Completed" }))).toBe(0.7);
    expect(readingSeedWeight(book({ rating: 5, status: "Dropped" }))).toBe(0);
  });

  it("never seeds from a book it was told to drop", () => {
    expect(pickReadingSeeds([book({ title: "Abandoned", status: "Dropped" })])).toHaveLength(0);
  });
});

describe("picking subjects worth searching on", () => {
  it("drops library metadata masquerading as a topic", () => {
    const subjects = usefulSubjects([
      "Accessible book",
      "Protected DAISY",
      "In library",
      "Computer security",
    ]);
    expect(subjects).toEqual(["Computer security"]);
  });

  it("prefers the specific over the broad", () => {
    // Longer is a decent proxy for specific: "Mobile computing" finds
    // neighbours, "Computers" finds the whole floor.
    expect(usefulSubjects(["Computers", "Mobile computing", "Fiction"], 1)).toEqual([
      "Mobile computing",
    ]);
  });

  it("stops at the limit, because subjects are ANDed", () => {
    expect(usefulSubjects(["Aaaa", "Bbbbb", "Cccccc", "Ddddddd"], 3)).toHaveLength(3);
  });
});

describe("ranking book candidates", () => {
  const subjectHit = (title: string, shared: string[], over: Partial<BookSuggestionHit> = {}) =>
    ({
      hit: hit({ id: `/works/${title}`, title, ...over }),
      source: "subject" as const,
      seedName: "Hacking Exposed Mobile",
      seedWeight: 1,
      sharedSubjects: shared,
    }) satisfies BookCandidate;

  it("puts a close neighbour above a shelf-mate", () => {
    const ranked = rankBookSuggestions([
      subjectHit("Near", ["Computer security", "Hackers", "Computer crimes"]),
      subjectHit("Far", ["Computers"]),
    ]);
    expect(ranked[0]?.hit.title).toBe("Near");
  });

  it("names the author when that is the reason", () => {
    const ranked = rankBookSuggestions([
      {
        hit: hit({ title: "The Art of Deception" }),
        source: "author",
        seedName: "Ghost in the Wires",
        seedWeight: 1,
      },
    ]);
    expect(ranked[0]?.reasons[0]).toBe("Same author as Ghost in the Wires");
  });

  it("explains a subject match in the user's own terms", () => {
    const ranked = rankBookSuggestions([subjectHit("Hackers", ["Computer security", "Hackers"])]);
    expect(ranked[0]?.reasons[0]).toContain("Computer security");
    expect(ranked[0]?.reasons[0]).toContain("Hacking Exposed Mobile");
  });

  it("never suggests a book already on the shelf, punctuation and all", () => {
    const ranked = rankBookSuggestions([subjectHit("Hacking: The Art of Exploitation", ["x"])], {
      ownedTitles: new Set([bookKey("Hacking - the art of exploitation")]),
    });
    expect(ranked).toHaveLength(0);
  });

  it("never suggests a book the user dismissed", () => {
    const ranked = rankBookSuggestions([subjectHit("Nope", ["x"])], {
      dismissed: new Set(["/works/Nope"]),
    });
    expect(ranked).toHaveLength(0);
  });

  it("treats a five-star rating from two people as unknown, not brilliant", () => {
    const lonely = subjectHit("Lonely", ["a", "b"], { ratingsAverage: 5, ratingsCount: 1 });
    const solid = subjectHit("Solid", ["a", "b"], { ratingsAverage: 4.3, ratingsCount: 40 });
    const ranked = rankBookSuggestions([lonely, solid]);
    expect(ranked[0]?.hit.title).toBe("Solid");
  });

  it("merges the same book found twice rather than listing it twice", () => {
    const ranked = rankBookSuggestions([
      subjectHit("Hackers", ["Computer security"]),
      { ...subjectHit("Hackers", ["Hackers"]), seedName: "Redefining Hacking" },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reasons[0]).toContain("Computer security");
  });

  it("caps the list when asked", () => {
    const many = Array.from({ length: 20 }, (_, i) => subjectHit(`B${i}`, ["a"]));
    expect(rankBookSuggestions(many, { limit: 4 })).toHaveLength(4);
  });
});
