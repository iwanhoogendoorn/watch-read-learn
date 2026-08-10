import { describe, expect, it, vi } from "vitest";
import {
  AIRING_STAGGER_MS,
  computeAiring,
  countdownLabel,
  createAiringService,
  daysUntil,
  describeAiringChange,
  detectNewSeason,
  isAirDay,
  isTerminalShowStatus,
  mediaTypeForTitle,
  needsAiringRefresh,
  releaseCountdown,
  shouldTrackAiring,
  toDateString,
} from "../../src/services/airing";
import { createOverseerrClient } from "../../src/services/overseerr";
import { createTmdbClient } from "../../src/services/tmdb";
import { createTitle } from "../../src/data/schema";
import { createRateLimiter } from "../../src/services/ratelimit";
import type { OverseerrDetails, TitleV4 } from "../../src/types";
import { createFakeHttp, createTestClock, type FakeRoute } from "../mocks/http";
import * as overseerrFx from "../fixtures/overseerr";
import * as tmdbFx from "../fixtures/tmdb";

/** Fixed "now": 2026-08-03, local noon. Shrinking's next episode is 2026-08-10. */
const NOW = new Date(2026, 7, 3, 12, 0, 0);

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "shrinking",
    title: "Shrinking",
    type: "TV Show",
    tmdbId: 136311,
    tmdbMediaType: "tv",
    totalEpisodes: 22,
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 12, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
    ],
    ...overrides,
  });
}

function film(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "anora",
    title: "Anora",
    type: "Movie",
    tmdbId: 1064213,
    tmdbMediaType: "movie",
    totalEpisodes: 1,
    ...overrides,
  });
}

describe("day maths", () => {
  it("counts whole calendar days in both directions", () => {
    expect(daysUntil("2026-08-03", NOW)).toBe(0);
    expect(daysUntil("2026-08-04", NOW)).toBe(1);
    expect(daysUntil("2026-08-10", NOW)).toBe(7);
    expect(daysUntil("2026-08-02", NOW)).toBe(-1);
  });

  it("does not flip because it is late in the evening", () => {
    const lateNight = new Date(2026, 7, 3, 23, 59, 0);
    expect(daysUntil("2026-08-04", lateNight)).toBe(1);
  });

  it("survives a month and a DST boundary", () => {
    // 2026-10-25 is the European DST change; the day count must stay whole.
    expect(daysUntil("2026-11-01", new Date(2026, 9, 25, 12, 0, 0))).toBe(7);
  });

  it("rejects a malformed date instead of guessing", () => {
    expect(daysUntil("soon", NOW)).toBeUndefined();
    expect(daysUntil("", NOW)).toBeUndefined();
  });

  it("labels countdowns the way the chips read", () => {
    expect(countdownLabel(0)).toBe("today");
    expect(countdownLabel(1)).toBe("tomorrow");
    expect(countdownLabel(7)).toBe("in 7 days");
    expect(countdownLabel(-1)).toBe("yesterday");
    expect(countdownLabel(-12)).toBe("12 days ago");
  });

  it("formats a local calendar day, not a UTC one", () => {
    // 00:30 local in a positive-offset zone is still "today" locally.
    expect(toDateString(new Date(2026, 7, 3, 0, 30))).toBe("2026-08-03");
  });
});

describe("terminal statuses", () => {
  it("accepts both spellings of cancelled", () => {
    expect(isTerminalShowStatus("Ended")).toBe(true);
    expect(isTerminalShowStatus("Canceled")).toBe(true);
    expect(isTerminalShowStatus("Cancelled")).toBe(true);
    expect(isTerminalShowStatus("Returning Series")).toBe(false);
    expect(isTerminalShowStatus(undefined)).toBe(false);
  });
});

describe("what gets tracked", () => {
  it("infers the media type from whatever the title knows", () => {
    expect(mediaTypeForTitle(show())).toBe("tv");
    expect(mediaTypeForTitle(film())).toBe("movie");
    expect(mediaTypeForTitle(createTitle({ id: "x", title: "X", type: "Anime", totalEpisodes: 12 }))).toBe("tv");
  });

  it("never tracks a title without a TMDB id", () => {
    expect(shouldTrackAiring(show({ tmdbId: 0 }), NOW)).toBe(false);
  });

  it("drops ended shows out of the queue", () => {
    expect(shouldTrackAiring(show({ airing: { showStatus: "Ended" } }), NOW)).toBe(false);
    expect(shouldTrackAiring(show({ airing: { showStatus: "Returning Series" } }), NOW)).toBe(true);
    expect(shouldTrackAiring(show(), NOW)).toBe(true);
  });

  it("keeps an 'ended' show that nonetheless has an episode scheduled", () => {
    const contradictory = show({
      airing: { showStatus: "Ended", nextEpisode: { season: 4, episode: 1, airDate: "2026-09-01" } },
    });
    expect(shouldTrackAiring(contradictory, NOW)).toBe(true);
  });

  it("keeps a film until a week past release, then lets it go", () => {
    expect(shouldTrackAiring(film({ releaseDate: "2026-12-01" }), NOW)).toBe(true);
    expect(shouldTrackAiring(film({ releaseDate: "2026-08-01" }), NOW)).toBe(true);
    expect(shouldTrackAiring(film({ releaseDate: "2024-10-17" }), NOW)).toBe(false);
  });
});

describe("TTL", () => {
  const checked = (iso: string) => show({ airing: { checkedAt: iso, showStatus: "Returning Series" } });

  it("refreshes anything never checked", () => {
    expect(needsAiringRefresh(show(), 12, NOW)).toBe(true);
  });

  it("holds off for 12 hours normally", () => {
    expect(needsAiringRefresh(checked(new Date(NOW.getTime() - 3 * 3600_000).toISOString()), 12, NOW)).toBe(false);
    expect(needsAiringRefresh(checked(new Date(NOW.getTime() - 13 * 3600_000).toISOString()), 12, NOW)).toBe(true);
  });

  it("collapses to an hour on the day something airs", () => {
    const airingToday = show({
      airing: {
        checkedAt: new Date(NOW.getTime() - 3 * 3600_000).toISOString(),
        nextEpisode: { season: 3, episode: 8, airDate: toDateString(NOW) },
      },
    });
    expect(isAirDay(airingToday, NOW)).toBe(true);
    expect(needsAiringRefresh(airingToday, 12, NOW)).toBe(true);
  });

  it("treats an overdue episode as an air day too", () => {
    const overdue = show({
      airing: { checkedAt: NOW.toISOString(), nextEpisode: { season: 3, episode: 8, airDate: "2026-07-30" } },
    });
    expect(isAirDay(overdue, NOW)).toBe(true);
  });

  it("is not an air day a week out", () => {
    expect(isAirDay(show({ airing: { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10" } } }), NOW)).toBe(false);
  });
});

describe("release countdown", () => {
  it("counts down to an unreleased film", () => {
    expect(releaseCountdown(film({ releaseDate: "2026-08-10" }), NOW)).toMatchObject({
      state: "upcoming",
      days: 7,
      label: "in 7 days",
    });
  });

  it("prefers the digital date over the theatrical one", () => {
    const title = film({ releaseDate: "2026-07-01", airing: { digitalReleaseDate: "2026-09-15" } });
    expect(releaseCountdown(title, NOW)).toMatchObject({ state: "upcoming", date: "2026-09-15" });
  });

  it("knows when today is the day", () => {
    expect(releaseCountdown(film({ releaseDate: "2026-08-03" }), NOW).state).toBe("today");
  });

  it("has nothing to say without a date", () => {
    expect(releaseCountdown(film(), NOW)).toEqual({ state: "unknown", label: "" });
  });
});

describe("computeAiring", () => {
  const details: OverseerrDetails = {
    tmdbId: 136311,
    mediaType: "tv",
    title: "Shrinking",
    overview: "",
    posterUrl: "",
    backdropUrl: "",
    releaseDate: "2023-01-27",
    genres: [],
    runtime: 30,
    voteAverage: 8.2,
    voteCount: 512,
    trailerUrl: "",
    director: [],
    cast: [],
    studio: [],
    showStatus: "Returning Series",
    inProduction: true,
    numberOfSeasons: 3,
    numberOfEpisodes: 34,
    seasons: [
      { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2023-01-27" },
      { seasonNumber: 2, name: "Season 2", episodeCount: 12, airDate: "2024-10-16" },
      { seasonNumber: 3, name: "Season 3", episodeCount: 12, airDate: "2026-01-14" },
    ],
    nextEpisodeToAir: { seasonNumber: 3, episodeNumber: 8, airDate: "2026-08-10", name: "The Last Session" },
    lastEpisodeToAir: { seasonNumber: 3, episodeNumber: 7, airDate: "2026-08-03" },
  };

  it("captures the schedule and the counts", () => {
    const airing = computeAiring(show(), details, { now: NOW });
    expect(airing).toMatchObject({
      showStatus: "Returning Series",
      inProduction: true,
      seasonCount: 3,
      episodeCount: 34,
      nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10", name: "The Last Session" },
      lastEpisode: { season: 3, episode: 7, airDate: "2026-08-03" },
      checkedAt: NOW.toISOString(),
    });
  });

  it("stores no countdown — only the date, so it cannot go stale", () => {
    const airing = computeAiring(show(), details, { now: NOW });
    expect(JSON.stringify(airing)).not.toContain("in 7 days");
  });

  it("detects the announced season the tracker is missing", () => {
    expect(computeAiring(show(), details, { now: NOW }).newSeasonDetected).toBe(3);
  });

  it("says nothing when the tracker is already up to date", () => {
    const upToDate = show({
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 12, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 12, offset: 22, skippedEpisodes: [], seasonNumber: 3 },
      ],
    });
    expect(computeAiring(upToDate, details, { now: NOW }).newSeasonDetected).toBeUndefined();
  });

  it("does not nag a user who deliberately tracks only later seasons", () => {
    const partial = show({
      seasons: [
        { name: "Season 2", episodes: 12, offset: 0, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 12, offset: 12, skippedEpisodes: [], seasonNumber: 3 },
      ],
    });
    // Upstream's newest season (3) is already tracked; season 1 is a gap the
    // user chose, not an announcement.
    expect(detectNewSeason(partial, details)).toBeUndefined();
  });

  it("names the next season along when no season list came back", () => {
    const countOnly = { ...details, seasons: [], numberOfSeasons: 4 };
    expect(detectNewSeason(show(), countOnly)).toBe(4);
  });

  it("leaves the schedule empty for an ended show and keeps the status", () => {
    // Internally consistent on purpose: the season list and the count have to
    // agree, or this is testing which of the two `detectNewSeason` believes
    // rather than what it does with an ended show. (It believes the list —
    // `numberOfSeasons` is computed with specials included on some servers.)
    const ended: OverseerrDetails = {
      ...details,
      showStatus: "Ended",
      inProduction: false,
      nextEpisodeToAir: null,
      numberOfSeasons: 2,
      seasons: (details.seasons ?? []).slice(0, 2),
    };
    const airing = computeAiring(show(), ended, { now: NOW });
    expect(airing.nextEpisode).toBeUndefined();
    expect(airing.showStatus).toBe("Ended");
    expect(airing.newSeasonDetected).toBeUndefined();
  });

  it("writes nothing TV-shaped for a film, but keeps the digital date", () => {
    const movieDetails: OverseerrDetails = { ...details, mediaType: "movie", showStatus: undefined };
    const airing = computeAiring(film(), movieDetails, { now: NOW, digitalReleaseDate: "2026-09-15" });
    expect(airing).toEqual({ checkedAt: NOW.toISOString(), digitalReleaseDate: "2026-09-15" });
  });
});

describe("change detection", () => {
  it("announces a new season", () => {
    const message = describeAiringChange(show(), undefined, { newSeasonDetected: 3 });
    expect(message).toBe("Season 3 of «Shrinking» was announced");
  });

  it("announces a show ending, once", () => {
    const previous = { showStatus: "Returning Series" };
    expect(describeAiringChange(show(), previous, { showStatus: "Ended" })).toContain("now marked Ended");
    expect(describeAiringChange(show(), { showStatus: "Ended" }, { showStatus: "Ended" })).toBeUndefined();
  });

  it("announces a newly scheduled episode with a zero-padded code", () => {
    const message = describeAiringChange(show(), undefined, {
      nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10" },
    });
    expect(message).toBe("«Shrinking» S03E08 airs 2026-08-10");
  });

  it("stays quiet when nothing moved", () => {
    const same = { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10" } };
    expect(describeAiringChange(show(), same, same)).toBeUndefined();
  });
});

describe("the refresh queue", () => {
  function build(routes: Record<string, FakeRoute>, ttlHours = 12) {
    const fake = createFakeHttp(routes);
    const { clock } = createTestClock();
    const overseerr = createOverseerrClient(() => ({ url: "http://server:5055", apiKey: "k" }), {
      http: fake.http,
    });
    const tmdb = createTmdbClient(() => ({ token: "" }), { http: fake.http, clock });
    const service = createAiringService({
      overseerr,
      tmdb,
      getTtlHours: () => ttlHours,
      now: () => NOW,
      limiter: createRateLimiter(AIRING_STAGGER_MS, clock),
    });
    return { fake, service, clock };
  }

  it("refreshes one title through Overseerr and reports the change", async () => {
    const { service } = build({ "/tv/136311": { body: overseerrFx.tvDetailsShrinking } });
    const result = await service.refreshTitle(show());
    expect(result.titleId).toBe("shrinking");
    expect(result.airing).toMatchObject({
      showStatus: "Returning Series",
      seasonCount: 3,
      newSeasonDetected: 3,
      nextEpisode: { season: 3, episode: 8, airDate: "2026-08-10" },
    });
    expect(result.change).toContain("Season 3");
    expect(result.error).toBeUndefined();
  });

  /**
   * The Radarr/Sonarr question, answered without a Radarr or Sonarr key.
   *
   * Overseerr's service scans import whatever those instances hold, so
   * `mediaInfo.status` says "something is already coming" for a title nobody
   * requested through Overseerr. The details call the airing refresh already
   * makes carries it, so it rides along rather than costing a second request.
   */
  it("carries Overseerr's media status back with the airing cache", async () => {
    const { service } = build({ "/tv/136311": { body: overseerrFx.tvDetailsShrinking } });
    const result = await service.refreshTitle(show());
    expect(result.mediaStatus).toBe(4); // PARTIALLY_AVAILABLE, from the fixture
  });

  it("leaves the media status absent when Overseerr has never tracked the title", async () => {
    // `movieDetailsAnora` carries no `mediaInfo` at all.
    const { service } = build({ "/movie/1064213": { body: overseerrFx.movieDetailsAnora } });
    const result = await service.refreshTitle(film());
    expect(result.airing).toBeDefined();
    // Absent ≠ UNKNOWN: nothing is written, so nothing claims to know.
    expect(result.mediaStatus).toBeUndefined();
  });

  it("staggers requests one second apart", async () => {
    const { service, clock } = build({
      "/tv/136311": { body: overseerrFx.tvDetailsShrinking },
      "/tv/1399": { body: overseerrFx.tvDetailsEnded },
    });
    const titles = [show(), show({ id: "got", title: "Game of Thrones", tmdbId: 1399 })];
    await service.refreshAll(titles);
    // Both ran; the limiter advanced the virtual clock by one stagger.
    expect(clock.now()).toBe(AIRING_STAGGER_MS);
  });

  it("only refreshes what is due, unless forced", async () => {
    const { service, fake } = build({ "/tv/136311": { body: overseerrFx.tvDetailsShrinking } });
    const fresh = show({
      airing: {
        checkedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
        showStatus: "Returning Series",
      },
    });

    expect(await service.refreshAll([fresh])).toEqual([]);
    expect(fake.calls).toHaveLength(0);

    const forced = await service.refreshAll([fresh], { force: true });
    expect(forced).toHaveLength(1);
  });

  it("never queues an ended show", async () => {
    const { service, fake } = build({});
    const results = await service.refreshAll([show({ airing: { showStatus: "Ended" } })]);
    expect(results).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("reports progress as it drains", async () => {
    const { service } = build({
      "/tv/136311": { body: overseerrFx.tvDetailsShrinking },
      "/tv/1399": { body: overseerrFx.tvDetailsEnded },
    });
    const onProgress = vi.fn();
    await service.refreshAll([show(), show({ id: "got", tmdbId: 1399 })], { onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });

  it("keeps one failure from taking the batch down", async () => {
    const { service } = build({
      "/tv/136311": { body: overseerrFx.tvDetailsShrinking },
      "/tv/1399": { status: 500, body: { message: "boom" } },
    });
    const results = await service.refreshAll([show(), show({ id: "got", tmdbId: 1399 })]);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.titleId === "shrinking")?.airing).toBeDefined();
    const failed = results.find((r) => r.titleId === "got");
    expect(failed?.error).toBeTruthy();
    // No airing cache at all, so the caller keeps the previous one.
    expect(failed?.airing).toBeUndefined();
  });

  it("adds the digital release date for an unreleased film when TMDB is configured", async () => {
    const fake = createFakeHttp({
      "/api/v1/movie/1064213": { body: overseerrFx.movieDetailsAnora },
      "/movie/1064213/release_dates": { body: tmdbFx.releaseDatesResponse },
    });
    const { clock } = createTestClock();
    const service = createAiringService({
      overseerr: createOverseerrClient(() => ({ url: "http://server:5055", apiKey: "k" }), { http: fake.http }),
      tmdb: createTmdbClient(() => ({ token: "eyJfake" }), { http: fake.http, clock }),
      getTtlHours: () => 12,
      getRegion: () => "NL",
      now: () => NOW,
      limiter: createRateLimiter(0, clock),
    });

    const result = await service.refreshTitle(film({ releaseDate: "2026-12-01" }));
    expect(result.airing?.digitalReleaseDate).toBe("2000-04-01");
  });

  it("falls back to direct TMDB when Overseerr is not configured", async () => {
    const fake = createFakeHttp({ "/tv/1399": { body: tmdbFx.tvDetailsResponse } });
    const { clock } = createTestClock();
    const service = createAiringService({
      overseerr: createOverseerrClient(() => ({ url: "", apiKey: "" }), { http: fake.http }),
      tmdb: createTmdbClient(() => ({ token: "eyJfake" }), { http: fake.http, clock }),
      getTtlHours: () => 12,
      now: () => NOW,
      limiter: createRateLimiter(0, clock),
    });

    const result = await service.refreshTitle(show({ id: "got", tmdbId: 1399 }));
    expect(result.airing?.showStatus).toBe("Ended");
    expect(fake.urls[0]).toContain("api.themoviedb.org");
  });

  it("errors cleanly when no provider is configured at all", async () => {
    const fake = createFakeHttp({});
    const { clock } = createTestClock();
    const service = createAiringService({
      overseerr: createOverseerrClient(() => ({ url: "", apiKey: "" }), { http: fake.http }),
      getTtlHours: () => 12,
      now: () => NOW,
      limiter: createRateLimiter(0, clock),
    });
    expect((await service.refreshTitle(show())).error).toContain("No metadata provider");
  });
});
