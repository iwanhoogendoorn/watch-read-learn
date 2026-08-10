import { describe, expect, it } from "vitest";
import {
  airingStateOf,
  applyFilters,
  countActiveFilters,
  decadeOf,
  EMPTY_FACET,
  facetOptions,
  hasActiveFilters,
  matchesFilters,
  plexStateOf,
  requestStateOf,
} from "../../src/search/filter";
import { createFilterState } from "../../src/data/schema";
import { MediaStatus, type FilterState, type TitleV4 } from "../../src/types";
import { createTitle } from "../../src/data/schema";

const NOW = new Date(2026, 7, 3, 12, 0, 0);

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "t",
    title: "A Title",
    type: "Movie",
    status: "Watching",
    ...overrides,
  });
}

function filters(overrides: Partial<FilterState> = {}): FilterState {
  return { ...createFilterState(), ...overrides };
}

describe("derived facet values", () => {
  it("buckets years into decades and calls an unknown year empty", () => {
    expect(decadeOf(title({ year: 2024 }))).toBe("2020");
    expect(decadeOf(title({ year: 1999 }))).toBe("1990");
    expect(decadeOf(title({ releaseDate: "2011-04-17" }))).toBe("2010");
    expect(decadeOf(title())).toBe(EMPTY_FACET);
  });

  it("reads Plex state, defaulting to unknown rather than to missing", () => {
    expect(plexStateOf(title())).toBe("unknown");
    expect(plexStateOf(title({ plex: { state: "partial" } }))).toBe("partial");
  });

  it("counts a title as requested from an id, a status, or Overseerr's own state", () => {
    expect(requestStateOf(title())).toBe("not-requested");
    expect(requestStateOf(title({ request: {} }))).toBe("not-requested");
    expect(requestStateOf(title({ request: { id: 12 } }))).toBe("requested");
    expect(requestStateOf(title({ request: { status: 1 } }))).toBe("requested");
    expect(requestStateOf(title({ request: { mediaStatus: MediaStatus.PROCESSING } }))).toBe("requested");
    // UNKNOWN is Overseerr's "tracked but nothing happening" — not a request.
    expect(requestStateOf(title({ request: { mediaStatus: MediaStatus.UNKNOWN } }))).toBe("not-requested");
  });

  it("derives an airing state, or none at all", () => {
    expect(airingStateOf(title(), NOW)).toBeUndefined();
    expect(airingStateOf(title({ releaseDate: "2026-12-01" }), NOW)).toBe("upcoming");
    expect(
      airingStateOf(title({ airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-10" } } }), NOW),
    ).toBe("returning");
    expect(airingStateOf(title({ airing: { showStatus: "Ended" } }), NOW)).toBe("ended");
    expect(airingStateOf(title({ airing: { showStatus: "Returning Series" } }), NOW)).toBe("returning");
  });
});

describe("the exclusion model", () => {
  it("shows everything when nothing is excluded", () => {
    expect(matchesFilters(title(), filters(), { now: NOW })).toBe(true);
  });

  it("shows a brand-new value nobody has excluded yet", () => {
    // The point of the model: an unseen type is visible by default.
    const excluded = filters({ excludedTypes: ["Movie", "TV Show"] });
    expect(matchesFilters(title({ type: "Documentary" }), excluded, { now: NOW })).toBe(true);
  });

  it("hides single-valued facets by exact value", () => {
    expect(matchesFilters(title({ type: "Movie" }), filters({ excludedTypes: ["Movie"] }), { now: NOW })).toBe(false);
    expect(
      matchesFilters(title({ status: "Completed" }), filters({ excludedStatuses: ["Completed"] }), { now: NOW }),
    ).toBe(false);
  });

  it("treats an empty priority as the (empty) chip", () => {
    expect(matchesFilters(title({ priority: "" }), filters({ excludedPriorities: [""] }), { now: NOW })).toBe(false);
    expect(matchesFilters(title({ priority: "High" }), filters({ excludedPriorities: [""] }), { now: NOW })).toBe(true);
  });
});

describe("multi-value facets", () => {
  const scifiDrama = title({ genres: ["Sci-Fi", "Drama"] });

  it("keeps a title that still has a surviving value", () => {
    expect(matchesFilters(scifiDrama, filters({ excludedGenres: ["Drama"] }), { now: NOW })).toBe(true);
  });

  it("hides it only once every value is excluded", () => {
    expect(matchesFilters(scifiDrama, filters({ excludedGenres: ["Drama", "Sci-Fi"] }), { now: NOW })).toBe(false);
  });

  it("does not hide an untagged title by excluding every named tag", () => {
    const untagged = title({ tags: [] });
    expect(matchesFilters(untagged, filters({ excludedTags: ["rewatch", "with-dad"] }), { now: NOW })).toBe(true);
  });

  it("hides an untagged title via the (empty) chip", () => {
    expect(matchesFilters(title({ tags: [] }), filters({ excludedTags: [EMPTY_FACET] }), { now: NOW })).toBe(false);
    expect(matchesFilters(title({ tags: ["rewatch"] }), filters({ excludedTags: [EMPTY_FACET] }), { now: NOW })).toBe(true);
  });
});

describe("minRating", () => {
  it("lets unrated titles through, always", () => {
    // The UI says so out loud; this is the behaviour behind that sentence.
    expect(matchesFilters(title({ rating: 0 }), filters({ minRating: 4 }), { now: NOW })).toBe(true);
  });

  it("still applies to rated titles", () => {
    expect(matchesFilters(title({ rating: 3 }), filters({ minRating: 4 }), { now: NOW })).toBe(false);
    expect(matchesFilters(title({ rating: 4 }), filters({ minRating: 4 }), { now: NOW })).toBe(true);
    expect(matchesFilters(title({ rating: 3 }), filters({ minRating: 0 }), { now: NOW })).toBe(true);
  });
});

describe("derived-state facets", () => {
  it("hides by Plex state", () => {
    const missing = title({ plex: { state: "none" } });
    expect(matchesFilters(missing, filters({ excludedPlexStates: ["none"] }), { now: NOW })).toBe(false);
    expect(matchesFilters(missing, filters({ excludedPlexStates: ["available"] }), { now: NOW })).toBe(true);
  });

  it("hides by request state", () => {
    const requested = title({ request: { id: 1 } });
    expect(matchesFilters(requested, filters({ excludedRequestStates: ["requested"] }), { now: NOW })).toBe(false);
  });

  it("cannot hide a title that has no airing state at all", () => {
    const plain = title();
    const everything = filters({ excludedAiringStates: ["returning", "upcoming", "ended"] });
    expect(matchesFilters(plain, everything, { now: NOW })).toBe(true);
  });

  it("hides by favourites", () => {
    expect(matchesFilters(title({ favorite: false }), filters({ favoritesOnly: true }), { now: NOW })).toBe(false);
    expect(matchesFilters(title({ favorite: true }), filters({ favoritesOnly: true }), { now: NOW })).toBe(true);
  });
});

describe("applyFilters", () => {
  const library = [
    title({ id: "a", title: "Anora", type: "Movie", year: 2024, rating: 5, genres: ["Drama"] }),
    title({ id: "b", title: "Shrinking", type: "TV Show", year: 2023, rating: 0, genres: ["Comedy", "Drama"] }),
    title({ id: "c", title: "Alien", type: "Movie", year: 1979, rating: 4, genres: [] }),
  ];

  it("filters and preserves input order", () => {
    const result = applyFilters(library, filters({ excludedTypes: ["TV Show"] }), { now: NOW });
    expect(result.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("combines facets conjunctively", () => {
    const result = applyFilters(
      library,
      filters({ excludedDecades: ["1970"], excludedGenres: ["Comedy", "Drama"] }),
      { now: NOW },
    );
    // "a" is all-Drama → hidden. "b" is Comedy+Drama → hidden. "c" is 1970s → hidden.
    expect(result).toEqual([]);
  });
});

describe("active-filter accounting", () => {
  it("counts nothing for a clean state", () => {
    expect(countActiveFilters(createFilterState())).toBe(0);
    expect(hasActiveFilters(createFilterState())).toBe(false);
  });

  it("counts each engaged facet once", () => {
    const state = filters({ excludedTypes: ["Movie", "TV Show"], minRating: 3, favoritesOnly: true });
    expect(countActiveFilters(state)).toBe(3);
    expect(hasActiveFilters(state)).toBe(true);
  });
});

describe("facetOptions", () => {
  const library = [
    title({ id: "a", type: "Movie", genres: ["Drama"], year: 2024 }),
    title({ id: "b", type: "Movie", genres: ["Comedy", "Drama"], year: 2023 }),
    title({ id: "c", type: "TV Show", genres: [], year: 1979 }),
  ];

  it("counts every value in the data, including the synthetic empty", () => {
    const options = facetOptions(library, "genres", createFilterState());
    expect(options).toEqual([
      { value: "Comedy", label: "Comedy", count: 1, excluded: false },
      { value: "Drama", label: "Drama", count: 2, excluded: false },
      { value: EMPTY_FACET, label: "(empty)", count: 1, excluded: false },
    ]);
  });

  it("marks exclusions and keeps an excluded value that no longer occurs", () => {
    const state = filters({ excludedTypes: ["Movie", "Documentary"] });
    const options = facetOptions(library, "type", state);
    expect(options).toEqual([
      { value: "Documentary", label: "Documentary", count: 0, excluded: true },
      { value: "Movie", label: "Movie", count: 2, excluded: true },
      { value: "TV Show", label: "TV Show", count: 1, excluded: false },
    ]);
  });

  it("sorts decades newest first", () => {
    const options = facetOptions(library, "decade", createFilterState());
    expect(options.map((o) => o.value)).toEqual(["2020", "1970"]);
  });
});
