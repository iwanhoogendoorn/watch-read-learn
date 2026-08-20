/**
 * Sorting and the stand-in query matcher.
 *
 * Sorting is production behaviour, not a stand-in, so the rules that are easy to
 * get wrong are pinned hard: empties last **regardless of direction**, status and
 * priority ordered by the user's configured list rather than alphabetically, and
 * a deterministic tiebreak so the grid never reshuffles between renders.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createFilterState, createTitle } from "../src/data/schema";
import {
  SORT_DEFAULT_DIR,
  createFallbackEngine,
  matchesQuery,
  nextSortSpec,
  norm,
  parseComparison,
  sortTitles,
  sortValue,
  tokenize,
} from "../src/ui/components/engine";
import type { Settings, TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3);
const settings: Settings = createDefaultSettings();

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "t",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "Movie",
    ...overrides,
  });
}

function names(titles: TitleV4[]): string[] {
  return titles.map((t) => t.title);
}

describe("nextSortSpec", () => {
  it("adopts a new key's natural direction", () => {
    expect(nextSortSpec({ key: "title", direction: "asc" }, "rating")).toEqual({
      key: "rating",
      direction: SORT_DEFAULT_DIR.rating,
    });
  });

  it("flips the direction when the active key is picked again", () => {
    expect(nextSortSpec({ key: "rating", direction: "desc" }, "rating")).toEqual({
      key: "rating",
      direction: "asc",
    });
    expect(nextSortSpec({ key: "rating", direction: "asc" }, "rating")).toEqual({
      key: "rating",
      direction: "desc",
    });
  });
});

describe("sortValue", () => {
  it("reports unrated and unprioritised as empty", () => {
    expect(sortValue(title({ rating: 0 }), "rating", settings)).toBeNull();
    expect(sortValue(title({ rating: 4 }), "rating", settings)).toBe(4);
    expect(sortValue(title({ priority: "" }), "priority", settings)).toBeNull();
  });

  it("orders status by the user's configured list, not the alphabet", () => {
    // Configured order is Watching, Plan to watch, Watched, To be released, Dropped.
    expect(sortValue(title({ status: "Watching" }), "status", settings)).toBe(0);
    expect(sortValue(title({ status: "Watched" }), "status", settings)).toBe(2);
    expect(sortValue(title({ status: "Nonsense" }), "status", settings)).toBeNull();
  });

  it("treats a title with no runtime as having no time left", () => {
    expect(sortValue(title({ episodeDuration: 0 }), "timeLeft", settings)).toBeNull();
    expect(
      sortValue(
        title({ episodeDuration: 45, totalEpisodes: 4, status: "Watching" }),
        "timeLeft",
        settings,
      ),
    ).toBe(180);
  });
});

describe("sortTitles", () => {
  const rated = [
    title({ id: "a", title: "Alpha", rating: 3 }),
    title({ id: "b", title: "Beta", rating: 5 }),
    title({ id: "c", title: "Gamma", rating: 0 }),
  ];

  it("puts empties last under descending order", () => {
    const out = sortTitles(rated, { key: "rating", direction: "desc" }, null, settings);
    expect(names(out)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("puts empties last under ascending order too — the whole point", () => {
    const out = sortTitles(rated, { key: "rating", direction: "asc" }, null, settings);
    expect(names(out)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("breaks ties on the secondary spec", () => {
    const titles = [
      title({ id: "a", title: "Alpha", status: "Watching", rating: 2 }),
      title({ id: "b", title: "Beta", status: "Watching", rating: 5 }),
      title({ id: "c", title: "Gamma", status: "Watched", rating: 4 }),
    ];
    const out = sortTitles(
      titles,
      { key: "status", direction: "asc" },
      { key: "rating", direction: "desc" },
      settings,
    );
    expect(names(out)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("falls back to title order so the result is deterministic", () => {
    const titles = [
      title({ id: "b", title: "Beta", rating: 4 }),
      title({ id: "a", title: "Alpha", rating: 4 }),
    ];
    const out = sortTitles(titles, { key: "rating", direction: "desc" }, null, settings);
    expect(names(out)).toEqual(["Alpha", "Beta"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rated];
    sortTitles(input, { key: "title", direction: "asc" }, null, settings);
    expect(names(input)).toEqual(["Alpha", "Beta", "Gamma"]);
  });
});

describe("tokenize", () => {
  it("splits OR groups on a bare pipe", () => {
    const groups = tokenize("sci-fi | thriller");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.[0]?.value).toBe("sci-fi");
    expect(groups[1]?.[0]?.value).toBe("thriller");
  });

  it("captures negation, field scope and quoting", () => {
    const [group] = tokenize('-anime genre:"Sci-Fi" rating:>=4');
    expect(group?.[0]).toMatchObject({ negated: true, field: null, value: "anime" });
    expect(group?.[1]).toMatchObject({ field: "genre", value: "Sci-Fi", quoted: true });
    expect(group?.[2]).toMatchObject({ field: "rating", value: ">=4" });
  });

  it("keeps hyphenated field names intact", () => {
    const [group] = tokenize("eps-left:<5");
    expect(group?.[0]).toMatchObject({ field: "eps-left", value: "<5" });
  });
});

describe("parseComparison", () => {
  it("reads every operator, defaulting a bare number to equals", () => {
    expect(parseComparison(">=4")).toEqual({ op: ">=", value: 4 });
    expect(parseComparison("<2020")).toEqual({ op: "<", value: 2020 });
    expect(parseComparison("3")).toEqual({ op: "=", value: 3 });
  });

  it("accepts a decimal comma", () => {
    expect(parseComparison(">4,5")).toEqual({ op: ">", value: 4.5 });
  });

  it("returns null for anything that is not a comparison", () => {
    expect(parseComparison("soon")).toBeNull();
  });
});

describe("matchesQuery", () => {
  const dexter = title({
    id: "dexter",
    title: "Dexter: Resurrection",
    type: "TV Show",
    status: "Watching",
    genres: ["Crime", "Drama"],
    tags: ["cosy"],
    cast: ["Michael C. Hall"],
    rating: 4,
    year: 2025,
    episodeDuration: 50,
    totalEpisodes: 10,
    plex: { state: "available" },
    request: { id: 3, mediaStatus: 5 },
    airing: { showStatus: "Returning Series" },
  });

  it("matches bare terms across the whole haystack", () => {
    expect(matchesQuery(dexter, "dexter", NOW)).toBe(true);
    expect(matchesQuery(dexter, "michael", NOW)).toBe(true);
    expect(matchesQuery(dexter, "sopranos", NOW)).toBe(false);
  });

  it("is accent-insensitive", () => {
    const cafe = title({ title: "Café Society" });
    expect(matchesQuery(cafe, "cafe", NOW)).toBe(true);
    expect(norm("Café")).toBe("cafe");
  });

  it("scopes a term to one field", () => {
    expect(matchesQuery(dexter, "genre:crime", NOW)).toBe(true);
    expect(matchesQuery(dexter, "genre:comedy", NOW)).toBe(false);
    expect(matchesQuery(dexter, "cast:hall", NOW)).toBe(true);
  });

  it("compares numbers", () => {
    expect(matchesQuery(dexter, "rating:>=4", NOW)).toBe(true);
    expect(matchesQuery(dexter, "rating:>4", NOW)).toBe(false);
    expect(matchesQuery(dexter, "year:>2020", NOW)).toBe(true);
    expect(matchesQuery(dexter, "runtime:<45", NOW)).toBe(false);
  });

  it("excludes an unrated title from any numeric comparison", () => {
    expect(matchesQuery(title({ rating: 0 }), "rating:<3", NOW)).toBe(false);
  });

  it("reads the enum predicates", () => {
    expect(matchesQuery(dexter, "plex:yes", NOW)).toBe(true);
    expect(matchesQuery(dexter, "plex:no", NOW)).toBe(false);
    expect(matchesQuery(dexter, "requested:yes", NOW)).toBe(true);
    expect(matchesQuery(dexter, "airing:returning", NOW)).toBe(true);
    expect(matchesQuery(dexter, "favorite:no", NOW)).toBe(true);
  });

  it("negates", () => {
    expect(matchesQuery(dexter, "-comedy", NOW)).toBe(true);
    expect(matchesQuery(dexter, "-dexter", NOW)).toBe(false);
  });

  it("ANDs within a group and ORs across groups", () => {
    expect(matchesQuery(dexter, "dexter comedy", NOW)).toBe(false);
    expect(matchesQuery(dexter, "comedy | dexter", NOW)).toBe(true);
  });

  it("degrades an unknown prefix to a literal instead of erroring", () => {
    const odd = title({ title: "foo:bar the movie" });
    expect(matchesQuery(odd, "foo:bar", NOW)).toBe(true);
    expect(matchesQuery(dexter, "citty:hague", NOW)).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesQuery(dexter, "   ", NOW)).toBe(true);
  });
});

describe("createFallbackEngine", () => {
  it("applies facets and the query together, then sorts", () => {
    const engine = createFallbackEngine(settings);
    const titles = [
      title({ id: "a", title: "Arrival", type: "Movie", genres: ["Sci-Fi"], rating: 5 }),
      title({ id: "b", title: "Alien", type: "Movie", genres: ["Sci-Fi"], rating: 3 }),
      title({ id: "c", title: "Amelie", type: "Movie", genres: ["Comedy"], rating: 4 }),
    ];
    const state = createFilterState();
    state.excludedGenres = ["Comedy"];

    const filtered = engine.filter(titles, "a", state);
    expect(names(filtered).sort()).toEqual(["Alien", "Arrival"]);

    const sorted = engine.sort(filtered, { key: "rating", direction: "desc" }, null);
    expect(names(sorted)).toEqual(["Arrival", "Alien"]);
  });
});
