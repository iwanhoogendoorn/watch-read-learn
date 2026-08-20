/**
 * QA round 2 regressions — "Upcoming does not work" (`BUGS-QA1.md`, W5 section).
 *
 * The live case behind every test here: *Dexter: Resurrection* sits in the vault
 * as a migrated v3 row (no `tmdbId`, no `airing`), locally **Watched**, while
 * Overseerr says `Returning Series` with a Season 2 that has zero episodes and
 * no air date yet. Every link in that chain had to hold for the announcement to
 * reach the Upcoming tab.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import {
  computeAiring,
  createAiringService,
  detectNewSeason,
  seasonLengthUpdates,
  shouldTrackAiring,
} from "../src/services/airing";
import { buildUpcomingEntries, bucketFor, formatCountdown } from "../src/ui/tabs/upcoming";
import { usesOperators } from "../src/ui/components/searchbox";
import type { OverseerrClient, OverseerrDetails, TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3);

/** The vault's row, as migration left it. */
function dexter(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "dexter-resurrection",
    title: "Dexter: Resurrection",
    type: "TV Show",
    status: "Watched",
    totalEpisodes: 10,
    releaseDate: "2025-07-11",
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
    ],
    ...overrides,
  });
}

/** `GET /tv/259909`, as the live server actually answers it. */
function dexterDetails(overrides: Partial<OverseerrDetails> = {}): OverseerrDetails {
  return {
    tmdbId: 259909,
    mediaType: "tv",
    title: "Dexter: Resurrection",
    overview: "",
    posterUrl: "",
    backdropUrl: "",
    releaseDate: "2025-07-13",
    genres: [],
    runtime: 0, // episodeRunTime: [] — real, and why duration stays user-editable
    voteAverage: 0,
    voteCount: 0,
    trailerUrl: "",
    director: [],
    cast: [],
    studio: [],
    showStatus: "Returning Series",
    inProduction: true,
    numberOfSeasons: 2,
    numberOfEpisodes: 10,
    // Specials are dropped by `normalizeSeasons` before this point.
    seasons: [
      { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
      { seasonNumber: 2, name: "Season 2", episodeCount: 0, airDate: null },
    ],
    nextEpisodeToAir: null,
    lastEpisodeToAir: {
      seasonNumber: 1,
      episodeNumber: 10,
      airDate: "2025-09-07",
      name: "And Justice for All...",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 2 — what gets refreshed
// ---------------------------------------------------------------------------

describe("W5-2 — the local watch status never gates an airing refresh", () => {
  it("tracks a returning show the user has already completed", () => {
    const done = dexter({
      tmdbId: 259909,
      tmdbMediaType: "tv",
      status: "Watched",
      airing: { showStatus: "Returning Series", checkedAt: NOW.toISOString() },
    });
    expect(shouldTrackAiring(done, NOW)).toBe(true);
  });

  it("treats every local status the same — only upstream decides", () => {
    for (const status of ["Watching", "Watched", "Dropped", "Plan to watch"]) {
      const returning = dexter({ tmdbId: 259909, status, airing: { showStatus: "Returning Series" } });
      const ended = dexter({ tmdbId: 259909, status, airing: { showStatus: "Ended" } });
      expect(shouldTrackAiring(returning, NOW)).toBe(true);
      expect(shouldTrackAiring(ended, NOW)).toBe(false);
    }
  });

  it("keeps refreshing an 'Ended' show that still has an episode scheduled", () => {
    const contradicted = dexter({
      tmdbId: 259909,
      airing: {
        showStatus: "Ended",
        nextEpisode: { season: 2, episode: 1, airDate: "2026-09-01" },
      },
    });
    expect(shouldTrackAiring(contradicted, NOW)).toBe(true);
  });

  it("respects the TTL on a catch-up, and lets `force` reach even an ended show", async () => {
    const calls: number[] = [];
    const client = {
      configured: () => true,
      details: async (tmdbId: number) => {
        calls.push(tmdbId);
        return dexterDetails();
      },
    } as unknown as OverseerrClient;
    const service = createAiringService({
      overseerr: client,
      getTtlHours: () => 12,
      now: () => NOW,
      // Straight through: this test is about *which* titles are queued, not
      // about the 1 req/s stagger (`ratelimit.test.ts` owns that).
      limiter: { run: <T>(fn: () => Promise<T>) => fn(), pending: 0, idle: async () => undefined },
    });

    const fresh = dexter({
      tmdbId: 259909,
      airing: {
        showStatus: "Returning Series",
        checkedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      },
    });
    const ended = dexter({
      id: "ended",
      tmdbId: 1405,
      airing: { showStatus: "Ended", checkedAt: new Date(NOW.getTime() - 999 * 3600_000).toISOString() },
    });

    // Within the TTL, and terminal upstream: nothing to do.
    expect(await service.refreshAll([fresh, ended], { force: false })).toHaveLength(0);
    expect(calls).toEqual([]);

    // The user pressed Refresh: both are reachable.
    const forced = await service.refreshAll([fresh, ended], { force: true });
    expect(forced).toHaveLength(2);
    expect(calls.sort()).toEqual([1405, 259909]);
  });

  it("still refuses a title with no TMDB id — but the backfill runs first now", async () => {
    const service = createAiringService({
      overseerr: { configured: () => true } as unknown as OverseerrClient,
      getTtlHours: () => 12,
      now: () => NOW,
    });
    expect(shouldTrackAiring(dexter(), NOW)).toBe(false);
    expect(await service.refreshAll([dexter()], { force: true })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — announced seasons with nothing in them yet
// ---------------------------------------------------------------------------

describe("W5-3 — a zero-episode, undated season is still an announcement", () => {
  it("detects Season 2 from the live payload", () => {
    expect(detectNewSeason(dexter({ tmdbId: 259909 }), dexterDetails())).toBe(2);
  });

  it("does not count specials as a season on either side", () => {
    // A tracker row that kept the specials as season 0 must not make upstream
    // look one season behind.
    const withSpecials = dexter({
      tmdbId: 259909,
      seasons: [
        { name: "Specials", episodes: 3, offset: 0, skippedEpisodes: [], seasonNumber: 0 },
        { name: "Season 1", episodes: 10, offset: 3, skippedEpisodes: [], seasonNumber: 1 },
      ],
    });
    expect(detectNewSeason(withSpecials, dexterDetails())).toBe(2);

    // And an upstream payload that *does* include season 0 must not inflate the
    // count into a phantom announcement.
    const upToDate = dexter({
      tmdbId: 259909,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 0, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });
    expect(
      detectNewSeason(upToDate, dexterDetails({
        numberOfSeasons: 3, // some servers count specials here
        seasons: [
          { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
          { seasonNumber: 2, name: "Season 2", episodeCount: 0, airDate: null },
        ],
      })),
    ).toBeUndefined();
  });

  it("records the announcement even though the season has no episodes yet", () => {
    const airing = computeAiring(dexter({ tmdbId: 259909 }), dexterDetails(), { now: NOW });
    expect(airing.showStatus).toBe("Returning Series");
    expect(airing.newSeasonDetected).toBe(2);
    // Zero is "upstream has not filled it in", not "a season with no episodes".
    expect(airing.newSeasonEpisodes).toBeUndefined();
    expect(airing.nextEpisode).toBeUndefined();
  });

  it("puts a 'Season 2 announced' row in Upcoming with no dates", () => {
    const airing = computeAiring(dexter({ tmdbId: 259909 }), dexterDetails(), { now: NOW });
    const entries = buildUpcomingEntries([dexter({ tmdbId: 259909, airing })], NOW);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("season");
    expect(entry?.label).toBe("Season 2");
    expect(entry?.detail).toContain("announced");
    expect(entry?.date).toBeNull();
    expect(entry?.daysUntil).toBeNull();
    expect(bucketFor(entry!)).toBe("tba");
    expect(formatCountdown(entry?.daysUntil ?? null)).toBe("date TBA");
  });
});

describe("W5-3 — a season added empty is filled in later", () => {
  it("reports the upstream length once the season has episodes", () => {
    // The user pressed "Add season 2" while upstream still had 0 episodes.
    const tracked = dexter({
      tmdbId: 259909,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 0, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });

    // Nothing to do while upstream is still empty.
    expect(seasonLengthUpdates(tracked, dexterDetails())).toEqual([]);

    // TMDB published the episode list.
    const published = dexterDetails({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-09-01" },
      ],
    });
    expect(seasonLengthUpdates(tracked, published)).toEqual([{ seasonNumber: 2, episodes: 8 }]);
  });

  it("never re-sizes a season the user trimmed", () => {
    const trimmed = dexter({
      tmdbId: 259909,
      seasons: [
        { name: "Season 1", episodes: 4, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      ],
    });
    expect(seasonLengthUpdates(trimmed, dexterDetails())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Report 2 — search that does not demand a syntax
// ---------------------------------------------------------------------------

describe("W5 report 2 — plain words are the default", () => {
  it("treats ordinary typing as plain, hyphens and all", () => {
    expect(usesOperators("")).toBe(false);
    expect(usesOperators("dexter")).toBe(false);
    expect(usesOperators("breaking bad")).toBe(false);
    // The hyphen inside a name is not a negation.
    expect(usesOperators("spider-man")).toBe(false);
    expect(usesOperators("sci-fi thriller")).toBe(false);
  });

  it("recognises the query language when it is actually used", () => {
    expect(usesOperators('genre:"Sci-Fi"')).toBe(true);
    expect(usesOperators("rating:>=4")).toBe(true);
    expect(usesOperators("-anime")).toBe(true);
    expect(usesOperators("dexter -anime")).toBe(true);
    expect(usesOperators('"breaking bad"')).toBe(true);
    expect(usesOperators("dexter OR shrinking")).toBe(true);
  });
});
