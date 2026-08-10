/**
 * The rest of the pure component logic: star maths, grid geometry, poster
 * resolution, badge/chip formatters, the season episode-list codec, and the
 * provider-details → title builder behind the Add modal.
 *
 * None of these touch the DOM, which is the point — the parts of the UI that can
 * be wrong in a way a screenshot will not show are the parts worth testing.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import type {
  OverseerrDetails,
  TitleV4,
  WatchLogStoreApi,
} from "../src/types";
import {
  MAX_STARS,
  fillPercents,
  formatRating,
  ratingFromPointer,
  stepRating,
  tierFor,
  tierIndex,
} from "../src/ui/components/stars";
import { computeColumns, visibleRowRange } from "../src/ui/components/virtual";
import {
  clearPosterFailures,
  initialOf,
  isPosterFailed,
  markPosterFailed,
  posterUrlFor,
  resolvePosterUrl,
  tintBucket,
  tintFor,
} from "../src/ui/components/posters";
import {
  airingChipText,
  colorFor,
  daysBetween,
  episodeCode,
  episodesLeftText,
  formatCountdown,
  plexBadge,
  progressText,
  relativeTime,
  requestStatus,
  sanitizeColor,
} from "../src/ui/components/pills";
import {
  formatEpisodeList,
  fromDrafts,
  parseEpisodeList,
  toDrafts,
} from "../src/ui/modals/seasons";
import {
  buildTitleFromDetails,
  defaultTypeFor,
  findExisting,
  seasonsFromDetails,
} from "../src/ui/modals/add";

const NOW = new Date(2026, 7, 3); // 2026-08-03 local

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "t",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "Movie",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe("stars", () => {
  it("fills fractionally rather than in halves only", () => {
    expect(fillPercents(0)).toEqual([0, 0, 0, 0, 0]);
    expect(fillPercents(3)).toEqual([100, 100, 100, 0, 0]);
    expect(fillPercents(3.5)).toEqual([100, 100, 100, 50, 0]);
    expect(fillPercents(4.2)).toEqual([100, 100, 100, 100, 20]);
  });

  it("clamps out-of-range ratings", () => {
    expect(fillPercents(-1)).toEqual([0, 0, 0, 0, 0]);
    expect(fillPercents(99)).toEqual([100, 100, 100, 100, 100]);
  });

  it("maps a rating onto its tier, ceiling-style", () => {
    expect(tierIndex(0)).toBeNull();
    expect(tierIndex(0.5)).toBe(0);
    expect(tierIndex(4)).toBe(3);
    expect(tierIndex(4.2)).toBe(4);
    expect(tierIndex(5)).toBe(4);

    const tiers = createDefaultSettings().ratingSystem;
    expect(tierFor(5, tiers)?.label).toBe("Masterpiece");
    expect(tierFor(0, tiers)).toBeNull();
  });

  it("derives half-steps from where in the star you clicked", () => {
    const rect = { left: 100, width: 20 };
    expect(ratingFromPointer(105, rect, 2, true)).toBe(2.5);
    expect(ratingFromPointer(118, rect, 2, true)).toBe(3);
    // With halves off, anywhere in the star means the whole star.
    expect(ratingFromPointer(105, rect, 2, false)).toBe(3);
  });

  it("steps by the configured increment and stops at the ends", () => {
    expect(stepRating(3, 1, false)).toBe(4);
    expect(stepRating(3, 1, true)).toBe(3.5);
    expect(stepRating(0, -1, true)).toBe(0);
    expect(stepRating(MAX_STARS, 1, true)).toBe(MAX_STARS);
  });

  it("formats ratings for the aria value text", () => {
    expect(formatRating(0)).toBe("unrated");
    expect(formatRating(4)).toBe("4");
    expect(formatRating(4.5)).toBe("4.5");
  });
});

// ---------------------------------------------------------------------------

describe("virtual grid geometry", () => {
  it("fits as many columns as the minimum width allows", () => {
    expect(computeColumns(600, 140, 12)).toBe(4);
    expect(computeColumns(300, 140, 12)).toBe(2);
    expect(computeColumns(100, 140, 12)).toBe(1);
  });

  it("never returns fewer than one column, even before layout", () => {
    expect(computeColumns(0, 140, 12)).toBe(1);
    expect(computeColumns(-5, 140, 12)).toBe(1);
  });

  it("mounts the visible rows plus overscan on both sides", () => {
    expect(visibleRowRange(0, 600, 200, 10, 2)).toEqual({ first: 0, last: 8 });
    expect(visibleRowRange(1000, 600, 200, 40, 2)).toEqual({ first: 3, last: 11 });
  });

  it("clamps the window to the row count", () => {
    expect(visibleRowRange(0, 600, 200, 2, 2)).toEqual({ first: 0, last: 2 });
    expect(visibleRowRange(0, 600, 200, 0, 2)).toEqual({ first: 0, last: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("posters", () => {
  it("prefers the manual override and never returns the v3 sentinel", () => {
    expect(posterUrlFor(title({ posterUrl: "a.jpg", manualPosterUrl: "b.jpg" }))).toBe("b.jpg");
    expect(posterUrlFor(title({ posterUrl: "a.jpg" }))).toBe("a.jpg");
    expect(posterUrlFor(title({ posterUrl: "none", manualPosterUrl: "none" }))).toBe("");
    expect(posterUrlFor(title())).toBe("");
  });

  it("expands a bare TMDB path into a CDN url and leaves full urls alone", () => {
    expect(resolvePosterUrl("/abc.jpg")).toBe("https://image.tmdb.org/t/p/w342/abc.jpg");
    expect(resolvePosterUrl("/abc.jpg", "w500")).toBe("https://image.tmdb.org/t/p/w500/abc.jpg");
    expect(resolvePosterUrl("https://x/y.jpg")).toBe("https://x/y.jpg");
    expect(resolvePosterUrl("  ")).toBe("");
  });

  it("caches negative results so a dead url is not retried", () => {
    clearPosterFailures();
    expect(isPosterFailed("https://x/dead.jpg")).toBe(false);
    markPosterFailed("https://x/dead.jpg");
    expect(isPosterFailed("https://x/dead.jpg")).toBe(true);
    clearPosterFailures();
    expect(isPosterFailed("https://x/dead.jpg")).toBe(false);
  });

  it("hashes a stable placeholder tint per title", () => {
    expect(tintBucket("Dexter")).toBe(tintBucket("Dexter"));
    expect(tintBucket("Dexter")).toBeGreaterThanOrEqual(0);
    expect(tintBucket("Dexter")).toBeLessThan(4);
    expect(tintFor("Dexter")).toMatch(/^\d+%$/);
  });

  it("picks a placeholder glyph, even for an empty name", () => {
    expect(initialOf("dexter")).toBe("D");
    expect(initialOf("  ")).toBe("?");
  });
});

// ---------------------------------------------------------------------------

describe("pills and badges", () => {
  it("badges only availability, never absence", () => {
    expect(plexBadge(title())).toBeNull();
    expect(plexBadge(title({ plex: { state: "none" } }))).toBeNull();
    expect(plexBadge(title({ plex: { state: "available" } }))?.text).toBe("On Plex");
    expect(
      plexBadge(title({ totalEpisodes: 33, plex: { state: "partial", leafCount: 12 } }))?.text,
    ).toBe("12/33 eps");
  });

  it("only accepts hex colours into the DOM", () => {
    expect(sanitizeColor("#1D9E75")).toBe("#1D9E75");
    expect(sanitizeColor("#abc")).toBe("#abc");
    expect(sanitizeColor("red; background: url(x)")).toBe("");
    expect(sanitizeColor("")).toBe("");
  });

  it("looks colours up by configured name", () => {
    const settings = createDefaultSettings();
    expect(colorFor(settings.statuses, "Watching")).toBe("#1D9E75");
    expect(colorFor(settings.statuses, "Nonexistent")).toBe("");
  });

  it("counts whole days at local midnight", () => {
    expect(daysBetween(NOW, "2026-08-03")).toBe(0);
    expect(daysBetween(NOW, "2026-08-05")).toBe(2);
    expect(daysBetween(NOW, "2026-08-01")).toBe(-2);
    expect(daysBetween(NOW, "nonsense")).toBeNull();
  });

  it("says today / tomorrow before it says in N days", () => {
    expect(formatCountdown("2026-08-03", NOW)).toBe("today");
    expect(formatCountdown("2026-08-04", NOW)).toBe("tomorrow");
    expect(formatCountdown("2026-08-02", NOW)).toBe("yesterday");
    expect(formatCountdown("2026-08-10", NOW)).toBe("in 7 days");
    expect(formatCountdown("2026-07-27", NOW)).toBe("7 days ago");
  });

  it("builds the airing chip from the next episode, then the release date", () => {
    expect(
      airingChipText(
        title({ airing: { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-05" } } }),
        NOW,
      ),
    ).toBe("S03E08 · in 2 days");
    expect(airingChipText(title({ releaseDate: "2026-09-01" }), NOW)).toBe(
      "Releases in 29 days",
    );
    expect(airingChipText(title({ releaseDate: "1999-01-01" }), NOW)).toBeNull();
  });

  it("pads episode codes", () => {
    expect(episodeCode(3, 8)).toBe("S03E08");
    expect(episodeCode(12, 104)).toBe("S12E104");
  });

  it("stays quiet about progress on a single-episode title", () => {
    expect(progressText(title({ totalEpisodes: 1 }))).toBe("");
    expect(progressText(title({ totalEpisodes: 10, watchedEpisodes: [1, 2, 3] }))).toBe(
      "3 / 10",
    );
  });

  it("pluralises episodes left, and says nothing when there are none", () => {
    expect(episodesLeftText(title({ totalEpisodes: 10, watchedEpisodes: [1] }))).toBe(
      "9 eps left",
    );
    expect(
      episodesLeftText(
        title({ totalEpisodes: 2, watchedEpisodes: [1] }),
      ),
    ).toBe("1 ep left");
    expect(episodesLeftText(title({ totalEpisodes: 1, watchedEpisodes: [1] }))).toBe("");
  });

  it("reads the two Overseerr enums separately", () => {
    expect(requestStatus(title())).toBeNull();
    expect(requestStatus(title({ request: { status: 1 } }))).toBeNull();
    expect(requestStatus(title({ request: { id: 1, status: 1 } }))?.text).toBe("Requested");
    expect(requestStatus(title({ request: { id: 1, status: 2 } }))?.text).toBe("Approved");
    expect(requestStatus(title({ request: { id: 1, status: 2, mediaStatus: 3 } }))?.text).toBe(
      "Processing",
    );
    expect(requestStatus(title({ request: { id: 1, status: 2, mediaStatus: 4 } }))?.text).toBe(
      "Partly available",
    );
    expect(requestStatus(title({ request: { id: 1, status: 5, mediaStatus: 5 } }))).toEqual({
      text: "Available",
      tone: "ok",
    });
    expect(requestStatus(title({ request: { id: 1, status: 3 } }))).toEqual({
      text: "Declined",
      tone: "warn",
    });
  });

  it("renders relative time in human buckets", () => {
    const iso = (days: number): string =>
      new Date(NOW.getTime() - days * 86_400_000).toISOString();
    expect(relativeTime(iso(0), NOW)).toBe("today");
    expect(relativeTime(iso(1), NOW)).toBe("yesterday");
    expect(relativeTime(iso(3), NOW)).toBe("3 d ago");
    expect(relativeTime(iso(14), NOW)).toBe("2 w ago");
    expect(relativeTime(iso(60), NOW)).toBe("2 mo ago");
    expect(relativeTime(iso(800), NOW)).toBe("2 y ago");
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("season episode-list codec", () => {
  it("parses singles and ranges, and ignores junk", () => {
    expect(parseEpisodeList("1, 3, 5-7", 10)).toEqual([1, 3, 5, 6, 7]);
    expect(parseEpisodeList("7-5", 10)).toEqual([5, 6, 7]);
    expect(parseEpisodeList("banana, 2", 10)).toEqual([2]);
    expect(parseEpisodeList("", 10)).toEqual([]);
  });

  it("clamps to the season length so a stale list cannot widen a season", () => {
    expect(parseEpisodeList("1, 12, 8-20", 10)).toEqual([1, 8, 9, 10]);
    expect(parseEpisodeList("0", 10)).toEqual([]);
  });

  it("round-trips through the formatter", () => {
    expect(formatEpisodeList([1, 3, 5, 6, 7])).toBe("1, 3, 5-7");
    expect(formatEpisodeList([1, 2])).toBe("1, 2");
    expect(formatEpisodeList([])).toBe("");
    expect(parseEpisodeList(formatEpisodeList([2, 4, 5, 6]), 10)).toEqual([2, 4, 5, 6]);
  });

  it("recomputes offsets from the row order on the way back", () => {
    const seasons = fromDrafts([
      { name: "Season 1", episodes: 10, skipped: "", airDate: "", seasonNumber: 1 },
      { name: "Season 2", episodes: 8, skipped: "3, 5-6", airDate: "2025-01-01", seasonNumber: 2 },
    ]);
    expect(seasons.map((s) => s.offset)).toEqual([0, 10]);
    expect(seasons[1]?.skippedEpisodes).toEqual([3, 5, 6]);
    expect(seasons[1]?.airDate).toBe("2025-01-01");
  });

  it("names an unnamed row and drops an empty air date to null", () => {
    const seasons = fromDrafts([
      { name: "   ", episodes: 5, skipped: "", airDate: "", seasonNumber: null },
    ]);
    expect(seasons[0]?.name).toBe("Season 1");
    expect(seasons[0]?.seasonNumber).toBe(1);
    expect(seasons[0]?.airDate).toBeNull();
  });

  it("survives a drafts round trip", () => {
    const original = fromDrafts([
      { name: "Season 1", episodes: 10, skipped: "2, 4-5", airDate: "", seasonNumber: 1 },
    ]);
    expect(fromDrafts(toDrafts(original))).toEqual(original);
  });
});

// ---------------------------------------------------------------------------

describe("building a title from provider details", () => {
  const tvDetails: OverseerrDetails = {
    tmdbId: 259909,
    mediaType: "tv",
    title: "Dexter: Resurrection",
    overview: "Dexter wakes up.",
    posterUrl: "https://image.tmdb.org/t/p/w342/x.jpg",
    backdropUrl: "",
    releaseDate: "2025-07-11",
    genres: ["Crime", "Drama"],
    runtime: 50,
    voteAverage: 8.1,
    voteCount: 420,
    imdbId: "tt28607951",
    trailerUrl: "https://www.youtube.com/watch?v=abc",
    director: ["Marcos Siega"],
    cast: ["Michael C. Hall"],
    studio: ["Showtime"],
    showStatus: "Returning Series",
    inProduction: true,
    numberOfSeasons: 2,
    numberOfEpisodes: 20,
    seasons: [
      { seasonNumber: 0, name: "Specials", episodeCount: 3, airDate: null },
      { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-07-01" },
      { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-11" },
    ],
    nextEpisodeToAir: {
      seasonNumber: 2,
      episodeNumber: 3,
      airDate: "2026-08-10",
      name: "Blood Money",
    },
  };

  it("drops specials, sorts seasons and recomputes offsets", () => {
    const seasons = seasonsFromDetails(tvDetails);
    expect(seasons.map((s) => s.seasonNumber)).toEqual([1, 2]);
    expect(seasons.map((s) => s.offset)).toEqual([0, 10]);
    expect(seasons.map((s) => s.episodes)).toEqual([10, 8]);
  });

  it("derives totals, year and the airing cache", () => {
    const built = buildTitleFromDetails(tvDetails, {
      type: "TV Show",
      status: "Plan to watch",
      takenIds: [],
    });
    expect(built.id).toBe("dexter-resurrection");
    expect(built.totalEpisodes).toBe(18);
    expect(built.episodeDuration).toBe(50);
    expect(built.year).toBe(2025);
    expect(built.tmdbId).toBe(259909);
    expect(built.communitySource).toBe("tmdb");
    expect(built.airing?.nextEpisode).toEqual({
      season: 2,
      episode: 3,
      airDate: "2026-08-10",
      name: "Blood Money",
    });
    // Sentinel policy: unknown stays empty, never the string "none".
    expect(built.manualPosterUrl).toBe("");
    expect(built.manualCast).toEqual([]);
  });

  it("gives a movie exactly one episode and no seasons", () => {
    const movie = buildTitleFromDetails(
      { ...tvDetails, mediaType: "movie", seasons: undefined, title: "Arrival" },
      { type: "Movie", status: "Plan to watch", takenIds: [] },
    );
    expect(movie.totalEpisodes).toBe(1);
    expect(movie.seasons).toEqual([]);
  });

  it("suffixes a colliding id rather than overwriting", () => {
    const built = buildTitleFromDetails(tvDetails, {
      type: "TV Show",
      status: "Plan to watch",
      takenIds: ["dexter-resurrection"],
    });
    expect(built.id).toBe("dexter-resurrection-2");
  });

  it("honours defaultAddType and its last-used sentinel, within the media kind", () => {
    const settings = createDefaultSettings();
    settings.defaultAddType = "__wl_last_used__";
    settings.lastAddedType = "Anime";
    expect(defaultTypeFor("tv", settings)).toBe("Anime");

    settings.lastAddedType = "Deleted Type";
    expect(defaultTypeFor("movie", settings)).toBe("Movie");

    // The preference only chooses between names that agree with `mediaType`:
    // an episodic default can never be pinned onto a film (QA1 B2).
    settings.defaultAddType = "TV Show";
    expect(defaultTypeFor("movie", settings)).toBe("Movie");
    expect(defaultTypeFor("tv", settings)).toBe("TV Show");
  });

  it("spots an already-tracked title by tmdb id first, then by name", () => {
    const existing = [
      title({ id: "arrival", title: "Arrival", tmdbId: 329865 }),
      title({ id: "alien", title: "Alien" }),
    ];
    const store = {
      allTitles: () => existing,
      getTitleByName: (name: string) =>
        existing.find((t) => t.title.toLowerCase() === name.toLowerCase()),
    } as unknown as WatchLogStoreApi;

    expect(findExisting(store, { tmdbId: 329865, title: "Anything" })?.id).toBe("arrival");
    expect(findExisting(store, { tmdbId: 1, title: "Alien" })?.id).toBe("alien");
    expect(findExisting(store, { tmdbId: 2, title: "Nope" })).toBeUndefined();
  });
});
