/**
 * Book categories — the multi-value facet, its filter semantics, and the
 * `category:` query field.
 */
import { describe, expect, it } from "vitest";
import { createBook } from "../src/data/schema";
import type { Book } from "../src/types";
import {
  categoriesOf,
  createReadingFilterState,
  matchesReadingFilters,
  readingFacetOptions,
  toggleReadingFacet,
} from "../src/domains/reading/viewstate";
import { searchReading } from "../src/domains/reading/query";
import { availableCategories } from "../src/domains/reading/community";

const book = (id: string, categories?: string[]): Book =>
  createBook({ id, title: id, ...(categories !== undefined ? { categories } : {}) });

describe("categoriesOf", () => {
  it("trims and drops empties, and buckets the uncategorised as (empty)", () => {
    expect(categoriesOf(book("a", [" Computers ", "", "Fiction"]))).toEqual([
      "Computers",
      "Fiction",
    ]);
    expect(categoriesOf(book("b"))).toEqual([""]);
    expect(categoriesOf(book("c", []))).toEqual([""]);
  });
});

describe("category facet", () => {
  const shelf = [
    book("nsx", ["Computers"]),
    book("dune", ["Fiction", "Classics"]),
    book("mixed", ["Computers", "Fiction"]),
    book("none"),
  ];

  it("counts every value an entry holds, plus the (empty) bucket", () => {
    const options = readingFacetOptions(shelf, "category", createReadingFilterState());
    expect(options.map((o) => [o.label, o.count])).toEqual([
      ["Classics", 1],
      ["Computers", 2],
      ["Fiction", 2],
      ["(empty)", 1],
    ]);
  });

  it("excluding a category hides everything that carries it at all", () => {
    const state = createReadingFilterState();
    toggleReadingFacet(state, "category", "Computers");
    const left = shelf.filter((entry) => matchesReadingFilters(entry, state));
    expect(left.map((e) => e.id)).toEqual(["dune", "none"]);
  });

  it("excluding (empty) hides only the uncategorised", () => {
    const state = createReadingFilterState();
    toggleReadingFacet(state, "category", "");
    const left = shelf.filter((entry) => matchesReadingFilters(entry, state));
    expect(left.map((e) => e.id)).toEqual(["nsx", "dune", "mixed"]);
  });

  it("tolerates a filter state persisted before categories existed", () => {
    const state = createReadingFilterState();
    delete (state as Partial<ReturnType<typeof createReadingFilterState>>).excludedCategories;
    expect(matchesReadingFilters(book("a", ["Computers"]), state)).toBe(true);
  });
});

describe("category: query field", () => {
  const shelf = [book("nsx", ["Computers"]), book("dune", ["Fiction"])];

  it("filters by category, with genre as an alias", () => {
    for (const q of ["category:computers", "genre:computers"]) {
      const found = searchReading(shelf, q);
      expect(found.map((e) => e.id)).toEqual(["nsx"]);
    }
  });

  it("a bare term still finds categories through the haystack", () => {
    const found = searchReading(shelf, "fiction");
    expect(found.map((e) => e.id)).toEqual(["dune"]);
  });
});

describe("availableCategories", () => {
  it("offers the defaults, including the hacking shelf", () => {
    const options = availableCategories(undefined, []);
    expect(options).toContain("Hacking");
    expect(options).toContain("Mobile Hacking");
    expect(options).toContain("Computers");
  });

  it("merges user additions and in-use values, deduped case-insensitively", () => {
    const options = availableCategories(["Homelab", "hacking"], [
      { categories: ["Networking", "homelab"] },
    ]);
    expect(options.filter((o) => o.toLowerCase() === "homelab")).toEqual(["Homelab"]);
    expect(options.filter((o) => o.toLowerCase() === "hacking")).toEqual(["Hacking"]);
    expect(options).toContain("Networking");
  });

  it("sorts alphabetically and drops blanks", () => {
    const options = availableCategories(["  ", "zzz"], []);
    expect(options[options.length - 1]).toBe("zzz");
    expect(options).not.toContain("");
    expect([...options].sort((a, b) => a.localeCompare(b))).toEqual(options);
  });
});
