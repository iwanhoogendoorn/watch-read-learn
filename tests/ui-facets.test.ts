/**
 * Facet maths — the exclusion filter model.
 *
 * Every one of foodspot's four filter rules is pinned here, because each one is
 * the kind of thing a rewrite quietly gets backwards:
 *   1. exclusion polarity (new values visible by default),
 *   2. multi-value fields hide only when ALL values are excluded,
 *   3. unrated titles always pass `minRating`,
 *   4. `(empty)` is a real, excludable value.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createFilterState, createTitle } from "../src/data/schema";
import {
  airingStateOf,
  buildFacetSections,
  clearFilters,
  decadeOf,
  excludedFor,
  hideAllFacets,
  isFacetValueShown,
  isFilterActive,
  matchesFilters,
  plexStateOf,
  requestStateOf,
  showAllFacets,
  toggleFacetValue,
  yearOf,
} from "../src/ui/components/facets";
import type { TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3); // 2026-08-03, local

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "t",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "Movie",
    ...overrides,
  });
}

describe("value derivation", () => {
  it("prefers an explicit year, then falls back to the release date", () => {
    expect(yearOf(title({ year: 1999, releaseDate: "2010-01-01" }))).toBe(1999);
    expect(yearOf(title({ releaseDate: "2010-01-01" }))).toBe(2010);
    expect(yearOf(title())).toBeNull();
  });

  it("buckets years into decades and marks unknown ones empty", () => {
    expect(decadeOf(title({ year: 1994 }))).toBe("1990");
    expect(decadeOf(title({ year: 2020 }))).toBe("2020");
    expect(decadeOf(title())).toBe("");
  });

  it("treats a missing plex cache as unknown, not as missing", () => {
    expect(plexStateOf(title())).toBe("unknown");
    expect(plexStateOf(title({ plex: { state: "partial" } }))).toBe("partial");
  });

  it("counts a title as requested only once a request id exists", () => {
    expect(requestStateOf(title())).toBe("not-requested");
    expect(requestStateOf(title({ request: { status: 1 } }))).toBe("not-requested");
    expect(requestStateOf(title({ request: { id: 7 } }))).toBe("requested");
  });

  it("classifies airing state, and reports null when there is no signal", () => {
    expect(airingStateOf(title({ airing: { showStatus: "Ended" } }), NOW)).toBe("ended");
    expect(airingStateOf(title({ airing: { showStatus: "Canceled" } }), NOW)).toBe("ended");
    expect(
      airingStateOf(
        title({ airing: { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10" } } }),
        NOW,
      ),
    ).toBe("upcoming");
    expect(airingStateOf(title({ releaseDate: "2027-01-01" }), NOW)).toBe("upcoming");
    expect(airingStateOf(title({ airing: { showStatus: "Returning Series" } }), NOW)).toBe(
      "returning",
    );
    expect(airingStateOf(title({ releaseDate: "1999-01-01" }), NOW)).toBeNull();
  });
});

describe("matchesFilters", () => {
  it("shows everything when nothing is excluded", () => {
    const state = createFilterState();
    expect(matchesFilters(title({ type: "Brand New Type" }), state, NOW)).toBe(true);
  });

  it("hides a single-valued facet when its value is excluded", () => {
    const state = createFilterState();
    state.excludedTypes = ["Movie"];
    expect(matchesFilters(title({ type: "Movie" }), state, NOW)).toBe(false);
    expect(matchesFilters(title({ type: "TV Show" }), state, NOW)).toBe(true);
  });

  it("hides a multi-valued facet only when EVERY value is excluded", () => {
    const state = createFilterState();
    const both = title({ genres: ["Drama", "Comedy"] });
    state.excludedGenres = ["Drama"];
    expect(matchesFilters(both, state, NOW)).toBe(true);
    state.excludedGenres = ["Drama", "Comedy"];
    expect(matchesFilters(both, state, NOW)).toBe(false);
  });

  it("treats a title with no genres as the (empty) value", () => {
    const state = createFilterState();
    state.excludedGenres = [""];
    expect(matchesFilters(title({ genres: [] }), state, NOW)).toBe(false);
    expect(matchesFilters(title({ genres: ["Drama"] }), state, NOW)).toBe(true);
  });

  it("never hides an unrated title behind minRating", () => {
    const state = createFilterState();
    state.minRating = 4;
    expect(matchesFilters(title({ rating: 0 }), state, NOW)).toBe(true);
    expect(matchesFilters(title({ rating: 3 }), state, NOW)).toBe(false);
    expect(matchesFilters(title({ rating: 4 }), state, NOW)).toBe(true);
  });

  it("applies favourites-only as a toggle, not an exclusion list", () => {
    const state = createFilterState();
    state.favoritesOnly = true;
    expect(matchesFilters(title({ favorite: false }), state, NOW)).toBe(false);
    expect(matchesFilters(title({ favorite: true }), state, NOW)).toBe(true);
  });

  it("leaves a title with no airing signal untouched by the airing facet", () => {
    const state = createFilterState();
    state.excludedAiringStates = ["returning", "upcoming", "ended"];
    expect(matchesFilters(title({ releaseDate: "1999-01-01" }), state, NOW)).toBe(true);
  });

  it("filters on the decade bucket, including unknown years", () => {
    const state = createFilterState();
    state.excludedDecades = [""];
    expect(matchesFilters(title(), state, NOW)).toBe(false);
    expect(matchesFilters(title({ year: 2001 }), state, NOW)).toBe(true);
  });
});

describe("state helpers", () => {
  it("reports activity for every dimension and clears them all", () => {
    const state = createFilterState();
    expect(isFilterActive(state)).toBe(false);
    state.excludedTags = ["cosy"];
    expect(isFilterActive(state)).toBe(true);
    clearFilters(state);
    expect(isFilterActive(state)).toBe(false);

    state.minRating = 3;
    expect(isFilterActive(state)).toBe(true);
    clearFilters(state);
    state.favoritesOnly = true;
    expect(isFilterActive(state)).toBe(true);
  });

  it("toggles a value in and out of the exclusion list", () => {
    const state = createFilterState();
    expect(isFacetValueShown(state, "types", "Movie")).toBe(true);
    expect(toggleFacetValue(state, "types", "Movie")).toBe(false);
    expect(state.excludedTypes).toEqual(["Movie"]);
    expect(toggleFacetValue(state, "types", "Movie")).toBe(true);
    expect(state.excludedTypes).toEqual([]);
  });

  it("keeps the enum facets typed while going through the generic path", () => {
    const state = createFilterState();
    toggleFacetValue(state, "plex", "available");
    expect(state.excludedPlexStates).toEqual(["available"]);
    expect(excludedFor(state, "plex")).toEqual(["available"]);
  });

  it("hide-all then show-all is a round trip", () => {
    const settings = createDefaultSettings();
    const titles = [title({ id: "a", type: "Movie", genres: ["Drama"] })];
    const sections = buildFacetSections(titles, settings, NOW);
    const state = createFilterState();

    hideAllFacets(state, sections);
    expect(matchesFilters(titles[0] as TitleV4, state, NOW)).toBe(false);

    showAllFacets(state, sections);
    expect(matchesFilters(titles[0] as TitleV4, state, NOW)).toBe(true);
  });
});

describe("buildFacetSections", () => {
  const settings = createDefaultSettings();
  const titles: TitleV4[] = [
    title({ id: "a", type: "Movie", status: "Watched", genres: ["Drama"], year: 1994 }),
    title({ id: "b", type: "TV Show", status: "Watching", genres: ["Drama", "Sci-Fi"], year: 2021 }),
    title({ id: "c", type: "Movie", status: "Watching", genres: [], tags: ["cosy"] }),
  ];

  it("orders type options by the user's configured list, not alphabetically", () => {
    const section = buildFacetSections(titles, settings, NOW).find((s) => s.key === "types");
    const values = section?.options.map((o) => o.value) ?? [];
    expect(values.slice(0, 5)).toEqual(settings.types.map((t) => t.name));
  });

  it("counts each value across the pool", () => {
    const section = buildFacetSections(titles, settings, NOW).find((s) => s.key === "types");
    expect(section?.options.find((o) => o.value === "Movie")?.count).toBe(2);
    expect(section?.options.find((o) => o.value === "TV Show")?.count).toBe(1);
  });

  it("adds an (empty) chip only when something actually lacks the value", () => {
    const sections = buildFacetSections(titles, settings, NOW);
    const genres = sections.find((s) => s.key === "genres");
    expect(genres?.options.at(-1)?.value).toBe("");
    expect(genres?.options.at(-1)?.count).toBe(1);

    const full = buildFacetSections([titles[0] as TitleV4], settings, NOW);
    expect(full.find((s) => s.key === "genres")?.options.some((o) => o.value === "")).toBe(
      false,
    );
  });

  it("counts a multi-valued genre once per title", () => {
    const genres = buildFacetSections(titles, settings, NOW).find((s) => s.key === "genres");
    expect(genres?.options.find((o) => o.value === "Drama")?.count).toBe(2);
    expect(genres?.options.find((o) => o.value === "Sci-Fi")?.count).toBe(1);
  });

  it("sorts decades newest first and labels them readably", () => {
    const decades = buildFacetSections(titles, settings, NOW).find((s) => s.key === "decades");
    expect(decades?.options.map((o) => o.label)).toEqual(["2020s", "1990s", "(empty)"]);
  });

  it("omits enum options nothing in the pool has", () => {
    const request = buildFacetSections(titles, settings, NOW).find((s) => s.key === "request");
    expect(request?.options.map((o) => o.value)).toEqual(["not-requested"]);
  });
});
