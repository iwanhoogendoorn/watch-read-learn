/**
 * The real `LibraryEngine` — the bridge that replaced the UI lane's stand-in.
 *
 * The bridge itself is three lines, so what is worth pinning is that it is
 * wired the right way round: facets before search (not the reverse, which would
 * search the whole library and then throw most of it away), the *user's*
 * configured status order driving the status sort, and the token language
 * reaching the Library rather than the stand-in's substring matcher.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createFilterState, createTitle } from "../src/data/schema";
import { createLibraryEngine } from "../src/search/engine";
import type { FilterState, Settings, TitleV4 } from "../src/types";

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? overrides.title ?? "t",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "TV Show",
    ...overrides,
  });
}

const settings: Settings = createDefaultSettings();
const engine = createLibraryEngine(settings);
const noFilters = (): FilterState => createFilterState();

describe("createLibraryEngine.filter", () => {
  const pool = [
    title({ id: "a", title: "Dexter: Resurrection", genres: ["Crime"], rating: 5 }),
    title({ id: "b", title: "Shrinking", genres: ["Comedy"], rating: 3 }),
    title({ id: "c", title: "Anora", type: "Movie", genres: ["Comedy"], rating: 4 }),
  ];

  it("returns everything for an empty query and no facets", () => {
    expect(engine.filter(pool, "", noFilters())).toHaveLength(3);
    expect(engine.filter(pool, "   ", noFilters())).toHaveLength(3);
  });

  it("speaks the real token language, not substrings", () => {
    expect(engine.filter(pool, 'genre:"Comedy"', noFilters()).map((t) => t.id)).toEqual(["b", "c"]);
    expect(engine.filter(pool, "rating:>=4", noFilters()).map((t) => t.id)).toEqual(["a", "c"]);
    expect(engine.filter(pool, "-anora", noFilters()).map((t) => t.id)).toEqual(["a", "b"]);
    expect(engine.filter(pool, "type:Movie", noFilters()).map((t) => t.id)).toEqual(["c"]);
  });

  it("applies facets and the query together, facets first", () => {
    const filters = noFilters();
    filters.excludedTypes = ["Movie"];
    // "Comedy" matches b and c; the Movie facet has already removed c.
    expect(engine.filter(pool, 'genre:"Comedy"', filters).map((t) => t.id)).toEqual(["b"]);
  });

  it("degrades an unknown prefix to literal text rather than erroring", () => {
    expect(() => engine.filter(pool, "nonsense:value", noFilters())).not.toThrow();
    expect(engine.filter(pool, "nonsense:value", noFilters())).toHaveLength(0);
  });
});

describe("createLibraryEngine.sort", () => {
  it("orders status by the user's configured list, not alphabetically", () => {
    const order = settings.statuses.map((s) => s.name);
    const pool = [...order].reverse().map((status, i) => title({ id: `t${i}`, title: `T${i}`, status }));

    const sorted = engine.sort(pool, { key: "status", direction: "asc" }, null);
    expect(sorted.map((t) => t.status)).toEqual(order);
  });

  it("reads settings live, so re-ordering statuses re-orders the sort", () => {
    const live: Settings = createDefaultSettings();
    const liveEngine = createLibraryEngine(live);
    const [first, second] = live.statuses;
    if (!first || !second) throw new Error("default settings need at least two statuses");

    const pool = [
      title({ id: "x", title: "X", status: second.name }),
      title({ id: "y", title: "Y", status: first.name }),
    ];
    expect(liveEngine.sort(pool, { key: "status", direction: "asc" }, null).map((t) => t.id)).toEqual([
      "y",
      "x",
    ]);

    // The settings tab lets the user drag these around; the engine must follow.
    live.statuses = [second, first, ...live.statuses.slice(2)];
    expect(liveEngine.sort(pool, { key: "status", direction: "asc" }, null).map((t) => t.id)).toEqual([
      "x",
      "y",
    ]);
  });

  it("applies the secondary key as a tiebreak", () => {
    const pool = [
      title({ id: "a", title: "Beta", rating: 4 }),
      title({ id: "b", title: "Alpha", rating: 4 }),
    ];
    const sorted = engine.sort(pool, { key: "rating", direction: "desc" }, { key: "title", direction: "asc" });
    expect(sorted.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the array it is handed", () => {
    const pool = [title({ id: "b", title: "B" }), title({ id: "a", title: "A" })];
    const before = pool.map((t) => t.id);
    engine.sort(pool, { key: "title", direction: "asc" }, null);
    expect(pool.map((t) => t.id)).toEqual(before);
  });
});
