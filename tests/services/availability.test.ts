/**
 * The TMDB → Plex matcher, driven through the *real* Plex client so the fixture
 * shapes are exercised end to end; only the transport is faked.
 */
import { describe, expect, it } from "vitest";
import { createAvailabilityService, confirmsMatch, expectedEpisodes, normalizeTitle, showState } from "../../src/services/availability";
import { createPlexClient, type PlexConfig } from "../../src/services/plex";
import { createTitle } from "../../src/data/schema";
import type { TitleV4 } from "../../src/types";
import { createFakeHttp, type FakeRoute } from "../mocks/http";
import * as fx from "../fixtures/plex";

const CONFIG: PlexConfig = {
  url: "http://192.168.1.10:32400",
  token: "secret-token",
  machineId: "51d31168cdbab4f2f238cac328b3d979b1f3d706",
};

const NOW = new Date("2026-08-03T12:00:00.000Z");

function service(routes: Record<string, FakeRoute>, config: PlexConfig = CONFIG) {
  const fake = createFakeHttp(routes);
  const plex = createPlexClient(() => config, { http: fake.http });
  return {
    fake,
    plex,
    availability: createAvailabilityService({
      plex,
      getMachineId: () => config.machineId,
      now: () => NOW,
    }),
  };
}

/** The library as it stands in the fixtures: two movies, one show. */
const LIBRARY_ROUTES: Record<string, FakeRoute> = {
  "/library/sections": { body: fx.sectionsResponse },
  "/library/sections/1/all": { body: fx.moviesPageResponse },
  "/library/sections/2/all": { body: fx.showsPageResponse },
};

function movie(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "anora",
    title: "Anora",
    type: "Movie",
    tmdbId: 1064213,
    tmdbMediaType: "movie",
    year: 2024,
    totalEpisodes: 1,
    ...overrides,
  });
}

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "shrinking",
    title: "Shrinking",
    type: "TV Show",
    tmdbId: 136311,
    tmdbMediaType: "tv",
    year: 2023,
    totalEpisodes: 33,
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 12, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      { name: "Season 3", episodes: 11, offset: 22, skippedEpisodes: [], seasonNumber: 3 },
    ],
    ...overrides,
  });
}

describe("index building", () => {
  it("indexes every external id and skips home-video sections", async () => {
    const { availability, fake } = service(LIBRARY_ROUTES);
    const index = await availability.buildIndex();

    expect(index.itemCount).toBe(3);
    expect(index.guids.get("tmdb://1064213")?.ratingKey).toBe("884");
    expect(index.guids.get("imdb://tt28607951")?.ratingKey).toBe("884");
    expect(index.guids.get("tvdb://355641")?.ratingKey).toBe("884");
    expect(index.guids.get("tmdb://136311")?.ratingKey).toBe("3846");

    // Sections 3 (music), 4 (photos) and 5 (agent .none) are never walked.
    expect(fake.urls.filter((u) => u.includes("/all"))).toEqual([
      expect.stringContaining("/library/sections/1/all"),
      expect.stringContaining("/library/sections/2/all"),
    ]);
  });

  it("goes stale only when a section has actually been scanned again", async () => {
    let sections = structuredClone(fx.sectionsResponse);
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/sections": () => ({ body: sections }),
    });

    await availability.buildIndex();
    expect(await availability.isIndexStale()).toBe(false);

    sections = structuredClone(fx.sectionsResponse);
    const movies = sections.MediaContainer.Directory[0];
    if (movies) movies.scannedAt = 1785999999;
    expect(await availability.isIndexStale()).toBe(true);
  });

  it("reports itself stale before it has ever been built", async () => {
    const { availability } = service(LIBRARY_ROUTES);
    expect(await availability.isIndexStale()).toBe(true);
    expect(availability.getIndex()).toBeUndefined();
  });

  it("reuses the index until forced", async () => {
    const { availability, fake } = service(LIBRARY_ROUTES);
    await availability.ensureIndex();
    await availability.ensureIndex();
    const first = fake.calls.length;
    await availability.ensureIndex(true);
    expect(fake.calls.length).toBeGreaterThan(first);
  });
});

describe("matching", () => {
  it("takes Overseerr's ratingKey and skips matching entirely", async () => {
    const { availability, fake } = service({
      "/library/metadata/3846": { body: fx.showMetadataResponse },
    });

    const match = await availability.match(show(), {
      mediaInfo: { id: 1, mediaType: "tv", tmdbId: 136311, status: 5, status4k: 1, ratingKey: "3846" },
    });

    expect(match).toMatchObject({ via: "overseerr", entry: { ratingKey: "3846" } });
    // No section listing at all — that is the point of the shortcut.
    expect(fake.urls.some((u) => u.includes("/library/sections"))).toBe(false);
  });

  it("falls back to the GUID index when Overseerr knows nothing", async () => {
    const { availability } = service(LIBRARY_ROUTES);
    const match = await availability.match(movie());
    expect(match).toMatchObject({ via: "guid", entry: { ratingKey: "884", title: "Anora" } });
  });

  it("matches on imdb when the title has no TMDB id", async () => {
    const { availability } = service(LIBRARY_ROUTES);
    const match = await availability.match(movie({ tmdbId: 0, imdbId: "tt28607951" }));
    expect(match).toMatchObject({ via: "guid", entry: { ratingKey: "884" } });
  });

  it("falls through to fuzzy search and confirms the hit", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/sections/1/all": { body: { MediaContainer: { size: 0, Metadata: [] } } },
      "/hubs/search": { body: fx.hubsSearchResponse },
      "/library/metadata/884": { body: fx.showMetadataResponse },
    });

    const match = await availability.match(movie({ tmdbId: 0, imdbId: "" }));
    expect(match).toMatchObject({ via: "search", entry: { ratingKey: "884" } });
  });

  it("refuses an unconfirmed fuzzy hit rather than badging the wrong film", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/sections/1/all": { body: { MediaContainer: { size: 0, Metadata: [] } } },
      "/hubs/search": { body: fx.hubsSearchResponse },
    });

    // Same fuzzy hit, but the tracker is after a 1997 film called Anora.
    const match = await availability.match(movie({ tmdbId: 0, imdbId: "", year: 1997, releaseDate: "1997-01-01" }));
    expect(match).toBeUndefined();
  });

  it("can be told to skip the fuzzy pass entirely", async () => {
    const { availability, fake } = service({
      ...LIBRARY_ROUTES,
      "/library/sections/1/all": { body: { MediaContainer: { size: 0, Metadata: [] } } },
    });
    expect(await availability.match(movie({ tmdbId: 0 }), { skipSearch: true })).toBeUndefined();
    expect(fake.urls.some((u) => u.includes("/hubs/search"))).toBe(false);
  });
});

describe("confirmsMatch", () => {
  const candidate = {
    ratingKey: "884",
    librarySectionID: "1",
    type: "movie" as const,
    title: "Anora",
    year: 2024,
    guids: ["tmdb://1064213"],
  };

  it("accepts a shared external id without looking at anything else", () => {
    expect(confirmsMatch(movie({ title: "Completely Different" }), candidate)).toBe(true);
  });

  it("rejects a candidate that advertises a different TMDB id", () => {
    expect(confirmsMatch(movie({ tmdbId: 999 }), candidate)).toBe(false);
  });

  it("accepts a title match within a year of drift", () => {
    const noGuids = { ...candidate, guids: [] };
    expect(confirmsMatch(movie({ tmdbId: 0, year: 2025 }), noGuids)).toBe(true);
    expect(confirmsMatch(movie({ tmdbId: 0, year: 2019 }), noGuids)).toBe(false);
  });

  it("is accent- and punctuation-insensitive on titles", () => {
    expect(normalizeTitle("Amélie: Le Fabuleux Destin")).toBe("amelie le fabuleux destin");
    const accented = { ...candidate, guids: [], title: "Amélie" };
    expect(confirmsMatch(movie({ tmdbId: 0, title: "Amelie", year: 2024 }), accented)).toBe(true);
  });
});

describe("refreshTitle", () => {
  it("marks a matched movie available and stamps the deep-link machine id", async () => {
    const { availability } = service(LIBRARY_ROUTES);
    const cache = await availability.refreshTitle(movie());
    expect(cache).toMatchObject({
      state: "available",
      ratingKey: "884",
      machineId: "51d31168cdbab4f2f238cac328b3d979b1f3d706",
      checkedAt: NOW.toISOString(),
    });
    expect(cache.episodes).toBeUndefined();
  });

  it("reads per-episode presence for a show and calls it partial", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/metadata/3846/allLeaves": { body: fx.allLeavesResponse },
    });

    // The index says 33 episodes are on disk; the tracker expects 33 upstream…
    const cache = await availability.refreshTitle(show({ airing: { episodeCount: 34 } }));
    expect(cache.leafCount).toBe(33);
    expect(cache.state).toBe("partial");
    expect(cache.episodes).toEqual([
      { s: 1, e: 1 },
      { s: 1, e: 2 },
      { s: 1, e: 3 },
      { s: 2, e: 1 },
      { s: 2, e: 2 },
    ]);
  });

  it("calls a show available once disk meets the upstream count", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/metadata/3846/allLeaves": { body: fx.allLeavesResponse },
    });
    const cache = await availability.refreshTitle(show({ airing: { episodeCount: 33 } }));
    expect(cache.state).toBe("available");
  });

  it("says `none` when the library genuinely does not have it", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/hubs/search": { body: { MediaContainer: { size: 17, Hub: [] } } },
    });
    const cache = await availability.refreshTitle(movie({ tmdbId: 424242 }));
    expect(cache).toMatchObject({ state: "none", checkedAt: NOW.toISOString() });
  });

  it("says `unknown` — never `none` — when Plex is unreachable", async () => {
    const { availability } = service({ "/library/sections": { status: 500, text: "" } });
    const cache = await availability.refreshTitle(movie());
    expect(cache.state).toBe("unknown");
  });

  it("says `unknown` when Plex is not configured at all", async () => {
    const { availability } = service({}, { ...CONFIG, url: "" });
    expect((await availability.refreshTitle(movie())).state).toBe("unknown");
  });

  it("still reports the show when allLeaves fails, using the index leafCount", async () => {
    const { availability } = service({
      ...LIBRARY_ROUTES,
      "/library/metadata/3846/allLeaves": { status: 500, text: "" },
    });
    const cache = await availability.refreshTitle(show({ airing: { episodeCount: 33 } }));
    expect(cache).toMatchObject({ state: "available", leafCount: 33, episodes: [] });
  });
});

describe("state maths", () => {
  it("maps disk count against upstream count", () => {
    expect(showState(0, 10)).toBe("none");
    expect(showState(4, 10)).toBe("partial");
    expect(showState(10, 10)).toBe("available");
    expect(showState(12, 10)).toBe("available");
    // Nothing to compare against: present episodes without a known total.
    expect(showState(4, 0)).toBe("partial");
  });

  it("prefers the upstream episode count over the tracker's own maths", () => {
    expect(expectedEpisodes(show({ airing: { episodeCount: 40 } }))).toBe(40);
    expect(expectedEpisodes(show())).toBe(33);
  });

  // Review P1-1: skipping is a statement about what the user will watch, not
  // about what exists. Netting skips out of the expectation made an incomplete
  // library report itself complete.
  it("ignores skipped episodes in the local expectation", () => {
    const withSkips = show({
      seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [3, 4], seasonNumber: 1 }],
      totalEpisodes: 10,
    });
    expect(expectedEpisodes(withSkips)).toBe(10);
  });
});

describe("needsRefresh", () => {
  it("refreshes a title that has never been checked", () => {
    const { availability } = service({});
    expect(availability.needsRefresh(movie(), 6)).toBe(true);
  });

  it("honours the TTL", () => {
    const { availability } = service({});
    const fresh = movie({ plex: { state: "available", checkedAt: "2026-08-03T09:00:00.000Z" } });
    expect(availability.needsRefresh(fresh, 6)).toBe(false);
    expect(availability.needsRefresh(fresh, 2)).toBe(true);
  });

  it("refreshes when the stamp is unreadable", () => {
    const { availability } = service({});
    expect(availability.needsRefresh(movie({ plex: { state: "none", checkedAt: "not a date" } }), 6)).toBe(true);
  });
});
