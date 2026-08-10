/**
 * The Reading toolbar's engine: search language, facets, two-level sort, and the
 * saved views that have to survive a round trip through the frozen `Preset`.
 *
 * The search language is deliberately **not** a second grammar — `parseQuery`
 * from `search/query.ts` does the tokenizing and this domain only re-reads its
 * output against reading fields. So the tests below check both halves: that
 * `author:herbert` works at all, and that everything the shared grammar
 * guarantees (quoting, negation, `|` groups, numeric operators, "nothing is ever
 * a syntax error") still holds after the re-reading.
 */
import { describe, expect, it } from "vitest";
import { createBook, createManga } from "../src/data/schema";
import { ReadingSearchEngine, parseReadingQuery, searchReading } from "../src/domains/reading/query";
import {
  applyReadingFilters,
  clearReadingFilters,
  countActiveReadingFilters,
  createReadingFilterState,
  decadeOf,
  fromPreset,
  nextReadingSort,
  readingFacetOptions,
  readingSortValue,
  sortReading,
  toPreset,
  toggleReadingFacet,
  READING_SORT_KEYS,
} from "../src/domains/reading/viewstate";
import type { Book, CustomColumn, Manga } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

const GENRE: CustomColumn = {
  id: "col-1",
  name: "Genre",
  type: "select",
  options: ["Sci-Fi", "Crime"],
  color: "#7F77DD",
};

function book(overrides: Partial<Book> & { id: string }): Book {
  return createBook({ title: overrides.id, ...overrides });
}

function manga(overrides: Partial<Manga> & { id: string }): Manga {
  return createManga({ title: overrides.id, ...overrides });
}

const DUNE = book({
  id: "dune",
  title: "Dune",
  author: "Frank Herbert",
  status: "Completed",
  rating: 5,
  favorite: true,
  pagesRead: 528,
  totalPages: 528,
  releaseDate: "1965-08-01",
  customFields: { "col-1": "Sci-Fi" },
});

const NEUROMANCER = book({
  id: "neuromancer",
  title: "Neuromancer",
  author: "William Gibson",
  status: "Reading",
  rating: 4,
  pagesRead: 100,
  totalPages: 271,
  releaseDate: "1984-07-01",
  customFields: { "col-1": "Sci-Fi" },
});

const WIP = book({
  id: "wip",
  title: "A Half-Written Row",
  status: "Reading",
  progressUnit: "words",
  wordsRead: 12500,
  totalWords: 90000,
});

const PREORDER = book({
  id: "preorder",
  title: "The Next One",
  author: "Frank Herbert",
  status: "Plan to Read",
  releaseDate: "2026-12-01",
});

const BOOKS = [DUNE, NEUROMANCER, WIP, PREORDER];

// ---------------------------------------------------------------------------
// Search language
// ---------------------------------------------------------------------------

describe("reading fields the shared tokenizer does not know", () => {
  const engine = (): ReadingSearchEngine =>
    new ReadingSearchEngine(BOOKS, { columns: [GENRE], now: NOW });

  it("scopes author:", () => {
    expect(engine().filter("author:herbert").map((entry) => entry.id)).toEqual(["dune", "preorder"]);
  });

  it("compares page counts, folding a word-tracked book in at 250/page", () => {
    // `wip` is 90 000 words — 360 pages — so "long books" means the same thing
    // whichever unit each book happens to be tracked in.
    expect(engine().filter("pages:>300").map((entry) => entry.id)).toEqual(["dune", "wip"]);
    // `preorder` has no page count at all, and "unknown" is not "fewer than 300".
    expect(engine().filter("pages:<300").map((entry) => entry.id)).toEqual(["neuromancer"]);
  });

  it("compares word counts on a word-tracked book", () => {
    expect(engine().filter("words:>=90000").map((entry) => entry.id)).toEqual(["wip"]);
  });

  it("filters on the derived status, not the stored one", () => {
    // `preorder` is stored as `Plan to Read` and shown as `To be released`.
    expect(engine().filter("status:\"To be released\"").map((entry) => entry.id)).toEqual(["preorder"]);
    expect(engine().filter("status:plan").map((entry) => entry.id)).toEqual([]);
  });

  it("filters on the progress percentage", () => {
    expect(engine().filter("progress:100").map((entry) => entry.id)).toEqual(["dune"]);
  });

  it("filters on a custom column's value", () => {
    expect(engine().filter("column:sci-fi").map((entry) => entry.id)).toEqual(["dune", "neuromancer"]);
  });

  it("filters on favourites and on the counting unit", () => {
    expect(engine().filter("favorite:yes").map((entry) => entry.id)).toEqual(["dune"]);
    expect(engine().filter("unit:words").map((entry) => entry.id)).toEqual(["wip"]);
  });

  it("keeps the shared numeric fields working", () => {
    expect(engine().filter("rating:>=5").map((entry) => entry.id)).toEqual(["dune"]);
    expect(engine().filter("year:<1980").map((entry) => entry.id)).toEqual(["dune"]);
  });

  it("counts chapters and volumes for manga", () => {
    const pool = [
      manga({ id: "berserk", chaptersRead: 300, totalChapters: 374, volumesRead: 34, totalVolumes: 42 }),
      manga({ id: "short", chaptersRead: 2, totalChapters: 12, volumesRead: 1, totalVolumes: 2 }),
    ];
    expect(searchReading(pool, "chapters:>100").map((entry) => entry.id)).toEqual(["berserk"]);
    expect(searchReading(pool, "volumes:<10").map((entry) => entry.id)).toEqual(["short"]);
  });
});

describe("everything the shared grammar guarantees still holds", () => {
  const engine = (): ReadingSearchEngine =>
    new ReadingSearchEngine(BOOKS, { columns: [GENRE], now: NOW });

  it("ANDs bare terms and ORs across |", () => {
    expect(engine().filter("frank herbert").map((entry) => entry.id)).toEqual(["dune", "preorder"]);
    expect(engine().filter("dune | neuromancer").map((entry) => entry.id)).toEqual([
      "dune",
      "neuromancer",
    ]);
  });

  it("negates", () => {
    expect(engine().filter("-herbert").map((entry) => entry.id)).toEqual(["neuromancer", "wip"]);
    expect(engine().filter("-author:herbert").map((entry) => entry.id)).toEqual(["neuromancer", "wip"]);
  });

  it("treats a quoted phrase as exact and never fuzzy", () => {
    const session = engine();
    expect(session.filter('"neuromancer"').map((entry) => entry.id)).toEqual(["neuromancer"]);
    expect(session.indexBuilt).toBe(false);
  });

  it("tolerates a typo through Fuse on a bare term", () => {
    expect(engine().filter("neuromance").map((entry) => entry.id)).toEqual(["neuromancer"]);
  });

  it("never treats anything as a syntax error", () => {
    // An unknown field is a literal search, not an exception and not a match-all.
    expect(() => engine().filter("plex:yes")).not.toThrow();
    expect(engine().filter("plex:yes")).toEqual([]);
    expect(engine().filter("pages:soon")).toEqual([]);
  });

  it("returns everything for an empty query", () => {
    expect(engine().filter("   ")).toHaveLength(BOOKS.length);
    expect(parseReadingQuery("  ").isEmpty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe("facets hide, they never include", () => {
  it("counts the derived status, with an (empty) chip for a missing author", () => {
    const state = createReadingFilterState();
    const statuses = readingFacetOptions(BOOKS, "status", state, NOW);
    expect(statuses.map((option) => `${option.value}:${option.count}`)).toEqual([
      "Completed:1",
      "Reading:2",
      "To be released:1",
    ]);

    const authors = readingFacetOptions(BOOKS, "author", state, NOW);
    // `(empty)` sinks to the bottom rather than sorting alphabetically.
    expect(authors.at(-1)).toMatchObject({ value: "", label: "(empty)", count: 1 });
  });

  it("excludes what is toggled off and nothing else", () => {
    const state = createReadingFilterState();
    toggleReadingFacet(state, "status", "Reading");
    expect(applyReadingFilters(BOOKS, state, [GENRE], NOW).map((entry) => entry.id)).toEqual([
      "dune",
      "preorder",
    ]);
    toggleReadingFacet(state, "status", "Reading");
    expect(applyReadingFilters(BOOKS, state, [GENRE], NOW)).toHaveLength(4);
  });

  it("keeps an excluded value on the chip list even at count zero", () => {
    const state = createReadingFilterState();
    toggleReadingFacet(state, "author", "Someone Gone");
    const authors = readingFacetOptions(BOOKS, "author", state, NOW);
    expect(authors.find((option) => option.value === "Someone Gone")).toMatchObject({
      count: 0,
      excluded: true,
    });
  });

  it("buckets release decades, and calls an unknown year (empty)", () => {
    expect(decadeOf(DUNE)).toBe("1960");
    expect(decadeOf(WIP)).toBe("");
  });

  it("filters on a custom select column", () => {
    const state = createReadingFilterState();
    toggleReadingFacet(state, { column: GENRE }, "Sci-Fi");
    expect(applyReadingFilters(BOOKS, state, [GENRE], NOW).map((entry) => entry.id)).toEqual([
      "wip",
      "preorder",
    ]);
  });

  it("lets unrated entries through a minimum-rating filter", () => {
    const state = createReadingFilterState();
    state.minRating = 5;
    const kept = applyReadingFilters(BOOKS, state, [GENRE], NOW).map((entry) => entry.id);
    expect(kept).toContain("dune"); // rated 5
    expect(kept).toContain("wip"); // unrated — always passes
    expect(kept).not.toContain("neuromancer"); // rated 4
  });

  it("counts and clears", () => {
    const state = createReadingFilterState();
    expect(countActiveReadingFilters(state)).toBe(0);
    toggleReadingFacet(state, "status", "Reading");
    state.favoritesOnly = true;
    expect(countActiveReadingFilters(state)).toBe(2);
    clearReadingFilters(state);
    expect(countActiveReadingFilters(state)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("two-level sort, empties last", () => {
  it("sorts by title", () => {
    expect(sortReading(BOOKS, { key: "title", direction: "asc" }, null, NOW).map((e) => e.id)).toEqual([
      "wip",
      "dune",
      "neuromancer",
      "preorder",
    ]);
  });

  it("sorts by author — the axis mapped onto the frozen priority slot", () => {
    const sorted = sortReading(BOOKS, { key: "priority", direction: "asc" }, null, NOW);
    // Same author → the title tiebreak decides, so the order is never random.
    // Authorless entries sink to the bottom whichever way the arrow points.
    expect(sorted.map((entry) => entry.id)).toEqual(["dune", "preorder", "neuromancer", "wip"]);
    const flipped = sortReading(BOOKS, { key: "priority", direction: "desc" }, null, NOW);
    expect(flipped.at(-1)?.id).toBe("wip");
  });

  it("keeps unrated entries last in both directions", () => {
    const asc = sortReading(BOOKS, { key: "rating", direction: "asc" }, null, NOW);
    const desc = sortReading(BOOKS, { key: "rating", direction: "desc" }, null, NOW);
    expect(asc.at(-1)?.rating).toBe(0);
    expect(desc.at(-1)?.rating).toBe(0);
  });

  it("breaks ties with the secondary sort, then deterministically", () => {
    const sorted = sortReading(
      BOOKS,
      { key: "status", direction: "asc" },
      { key: "title", direction: "asc" },
      NOW,
    );
    // Both Reading entries, ordered by title within the status.
    expect(sorted.slice(0, 2).map((entry) => entry.id)).toEqual(["wip", "neuromancer"]);
  });

  it("treats 0 % as a real position and 'nothing to measure' as empty", () => {
    expect(readingSortValue(WIP, "progress", NOW)).toBe(14);
    expect(readingSortValue(book({ id: "blank" }), "progress", NOW)).toBeNull();
  });

  it("adopts a key's natural direction, and flips when re-picked", () => {
    expect(nextReadingSort({ key: "title", direction: "asc" }, "rating")).toEqual({
      key: "rating",
      direction: "desc",
    });
    expect(nextReadingSort({ key: "rating", direction: "desc" }, "rating")).toEqual({
      key: "rating",
      direction: "asc",
    });
  });

  it("offers only axes a book can have", () => {
    expect(READING_SORT_KEYS).not.toContain("nextAirDate");
    expect(READING_SORT_KEYS).not.toContain("timeLeft");
  });
});

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

describe("a saved view survives the frozen Preset shape", () => {
  it("round-trips every part of the reading view", () => {
    const filters = createReadingFilterState();
    toggleReadingFacet(filters, "status", "Dropped");
    toggleReadingFacet(filters, "author", "William Gibson");
    toggleReadingFacet(filters, "decade", "1980");
    toggleReadingFacet(filters, { column: GENRE }, "Crime");
    filters.minRating = 4;
    filters.favoritesOnly = true;

    const preset = toPreset(
      "Unread sci-fi",
      {
        query: "author:herbert pages:>300",
        filters,
        sort: { key: "priority", direction: "asc" },
        secondarySort: { key: "rating", direction: "desc" },
      },
      "preset-1",
    );

    const back = fromPreset(preset);
    expect(back.query).toBe("author:herbert pages:>300");
    expect(back.filters).toEqual(filters);
    expect(back.sort).toEqual({ key: "priority", direction: "asc" });
    expect(back.secondarySort).toEqual({ key: "rating", direction: "desc" });
  });

  it("stores a structurally valid Preset, not a reading-shaped object", () => {
    const filters = createReadingFilterState();
    toggleReadingFacet(filters, "author", "Frank Herbert");
    const preset = toPreset("Herbert", { query: "", filters, sort: { key: "title", direction: "asc" }, secondarySort: null }, "p");
    // Every FilterState key is present, so anything typed against it is safe.
    expect(Object.keys(preset.filters).sort()).toEqual(
      [
        "excludedAiringStates",
        "excludedDecades",
        "excludedGenres",
        "excludedPlexStates",
        "excludedPriorities",
        "excludedRequestStates",
        "excludedStatuses",
        "excludedTags",
        "excludedTypes",
        "favoritesOnly",
        "minRating",
      ].sort(),
    );
    expect(preset.filters.excludedTypes).toEqual(["Frank Herbert"]);
  });

  it("survives a value containing the column separator", () => {
    const filters = createReadingFilterState();
    toggleReadingFacet(filters, { column: GENRE }, "a=b");
    const back = fromPreset(toPreset("x", { query: "", filters, sort: { key: "title", direction: "asc" }, secondarySort: null }, "p"));
    expect(back.filters.excludedColumns["col-1"]).toEqual(["a=b"]);
  });

  it("reads a preset saved before this lane existed without throwing", () => {
    const back = fromPreset({
      id: "old",
      name: "Legacy",
      query: "dune",
      filters: { excludedStatuses: ["Dropped"] } as never,
      sort: { key: "title", direction: "asc" },
      secondarySort: null,
    });
    expect(back.filters.excludedStatuses).toEqual(["Dropped"]);
    expect(back.filters.excludedColumns).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

describe("facets then search then sort, the way the tab runs it", () => {
  it("narrows in that order and ends deterministic", () => {
    const filters = createReadingFilterState();
    toggleReadingFacet(filters, "status", "To be released");

    const faceted = applyReadingFilters(BOOKS, filters, [GENRE], NOW);
    const searched = new ReadingSearchEngine(faceted, { columns: [GENRE], now: NOW }).filter("column:sci-fi");
    const sorted = sortReading(searched, { key: "rating", direction: "desc" }, null, NOW);

    expect(sorted.map((entry) => entry.id)).toEqual(["dune", "neuromancer"]);
  });
});
