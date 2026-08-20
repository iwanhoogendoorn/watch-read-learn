/**
 * End-to-end for the episode-runtime repair: wire payload → real clients →
 * composed details source → real sweep → store, and check what lands.
 *
 * The unit tests either side of this one prove the pieces. This one exists
 * because the bug was never in a piece — `normalize.ts` reads the fallback
 * correctly and `sweep.ts` writes what it is given, yet Reacher stayed at
 * `episodeDuration: 0` in the real vault, because the payload that reached the
 * normaliser had been through Overseerr and Overseerr strips `runtime` off the
 * episode stub. Only the assembled pipeline shows that.
 *
 * The fixtures are the real payloads reduced to the fields under test, with the
 * Overseerr stub carrying exactly the keys the live server sends — no `runtime`.
 * No network.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../../src/data/schema";
import { metadataPatch } from "../../src/integration";
import { createDetailsSource } from "../../src/services/details";
import { createOverseerrClient } from "../../src/services/overseerr";
import { createPassthroughLimiter, type RateLimiter } from "../../src/services/ratelimit";
import { createMetadataSweep, SWEEP_TTL_HOURS_DEFAULT } from "../../src/services/sweep";
import { createTmdbClient } from "../../src/services/tmdb";
import { createFakeHttp } from "../mocks/http";
import type { TitlePatch, TitleV4, WatchLogStoreApi } from "../../src/types";

/**
 * `/api/v1/tv/108978` as Overseerr actually answers it.
 *
 * `episodeRunTime: []` and a `lastEpisodeToAir` whose key list is TMDB's minus
 * `runtime` — that omission is the whole bug, so the fixture spells the keys out
 * rather than trimming them to the ones the test reads.
 */
const overseerrReacher = {
  id: 108978,
  name: "Reacher",
  overview: "An ex-military policeman drifts into a small town.",
  posterPath: "/reacher.jpg",
  firstAirDate: "2022-02-04",
  status: "Returning Series",
  inProduction: true,
  numberOfSeasons: 4,
  numberOfEpisodes: 27,
  episodeRunTime: [],
  voteAverage: 8.1,
  voteCount: 3079,
  genres: [{ id: 10759, name: "Action & Adventure" }],
  networks: [{ id: 1024, name: "Prime Video" }],
  seasons: [{ id: 1, seasonNumber: 1, name: "Season 1", episodeCount: 8, airDate: "2022-02-04" }],
  lastEpisodeToAir: {
    id: 6146011,
    airDate: "2026-08-06",
    episodeNumber: 3,
    name: "One Small Step",
    overview: "Reacher goes looking.",
    productionCode: "",
    seasonNumber: 4,
    showId: 108978,
    voteAverage: 7.5,
    voteCount: 4,
    stillPath: "/still.jpg",
  },
  nextEpisodeToAir: {
    id: 6146012,
    airDate: "2026-08-13",
    episodeNumber: 4,
    name: "Karambits and Pieces",
    overview: "",
    productionCode: "",
    seasonNumber: 4,
    showId: 108978,
    voteAverage: 0,
    voteCount: 0,
    stillPath: null,
  },
  credits: { cast: [{ id: 1, name: "Alan Ritchson" }], crew: [] },
  externalIds: { imdbId: "tt9288030" },
  mediaInfo: { id: 244, mediaType: "tv", tmdbId: 108978, status: 4, status4k: 1 },
  relatedVideos: [],
};

/** `/tv/108978` as TMDB answers it — same show, and the stub keeps `runtime`. */
const tmdbReacher = {
  id: 108978,
  name: "Reacher",
  overview: "An ex-military policeman drifts into a small town.",
  poster_path: "/reacher.jpg",
  first_air_date: "2022-02-04",
  status: "Returning Series",
  in_production: true,
  number_of_seasons: 4,
  number_of_episodes: 27,
  episode_run_time: [],
  vote_average: 8.1,
  vote_count: 3080,
  genres: [{ id: 10759, name: "Action & Adventure" }],
  networks: [{ id: 1024, name: "Prime Video" }],
  seasons: [{ id: 1, season_number: 1, name: "Season 1", episode_count: 8, air_date: "2022-02-04" }],
  last_episode_to_air: {
    id: 6146011,
    air_date: "2026-08-06",
    episode_number: 3,
    episode_type: "standard",
    name: "One Small Step",
    season_number: 4,
    show_id: 108978,
    runtime: 44,
    still_path: "/still.jpg",
    vote_average: 7.5,
    vote_count: 4,
  },
  next_episode_to_air: {
    id: 6146012,
    air_date: "2026-08-13",
    episode_number: 4,
    name: "Karambits and Pieces",
    season_number: 4,
    show_id: 108978,
    runtime: 42,
  },
  credits: { cast: [{ id: 1, name: "Alan Ritchson" }], crew: [] },
  external_ids: { imdb_id: "tt9288030" },
};

function reacher(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "reacher",
    title: "Reacher",
    type: "TV Show",
    status: "Watching",
    tmdbId: 108978,
    tmdbMediaType: "tv",
    totalEpisodes: 27,
    episodeDuration: 0,
    communityRatingLastFetched: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function fakeStore(titles: TitleV4[]): WatchLogStoreApi {
  return {
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
    updateTitle: (id: string, patch: TitlePatch) => {
      const title = titles.find((t) => t.id === id);
      if (!title) return undefined;
      Object.assign(title, patch); // mutated in place, as the real store does
      return title;
    },
    logActivity: () => undefined,
  } as unknown as WatchLogStoreApi;
}

function pipeline(options: { tmdbToken?: string } = {}) {
  const fake = createFakeHttp({
    "/api/v1/tv/108978": { body: overseerrReacher },
    "api.themoviedb.org/3/tv/108978": { body: tmdbReacher },
  });
  const overseerr = createOverseerrClient(() => ({ url: "http://10.11.111.66:5055", apiKey: "k" }), {
    http: fake.http,
    limiter: createPassthroughLimiter(),
  });
  const tmdb = createTmdbClient(() => ({ token: options.tmdbToken ?? "eyJtest" }), {
    http: fake.http,
    limiter: createPassthroughLimiter(),
  });
  return { fake, overseerr, tmdb, source: createDetailsSource({ overseerr, tmdb }) };
}

describe("the payload really is the problem", () => {
  it("Overseerr answers 0 and TMDB answers 44 for the same show", async () => {
    const { overseerr, tmdb } = pipeline();
    expect((await overseerr.details(108978, "tv")).runtime).toBe(0);
    expect((await tmdb.details(108978, "tv")).runtime).toBe(44);
  });

  it("and the composed source answers 44 in ONE request, off the homelab entirely", async () => {
    // TMDB-primary since "make this not dependent on the home lab server":
    // the runtime arrives natively, the homelab is never dialled, and the
    // top-up that used to buy this same 44 with a second request is retired.
    const { fake, source } = pipeline();
    const details = await source(108978, "tv");
    expect(details.runtime).toBe(44);
    expect(details.voteCount).toBe(3080); // TMDB's document, not Overseerr's 3079
    expect(details.mediaInfo).toBeUndefined(); // the honest price; availability is background work
    expect(fake.urls).toHaveLength(1);
    expect(fake.urls[0]).toContain("api.themoviedb.org");
  });
});

describe("through the sweep, into the store", () => {
  it("lands episodeDuration 44 on Reacher — the bug, fixed end to end", async () => {
    const titles = [reacher()];
    const store = fakeStore(titles);
    const { source } = pipeline();

    const sweep = createMetadataSweep({
      store,
      configured: () => true,
      details: source,
      buildPatch: metadataPatch,
      getTtlHours: () => SWEEP_TTL_HOURS_DEFAULT,
      limiter: createPassthroughLimiter(),
    });

    const result = await sweep.run({ force: true });
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(titles[0]?.episodeDuration).toBe(44);
  });

  it("falls back to Overseerr whole — mediaInfo included — when TMDB 404s", async () => {
    const titles = [reacher()];
    const store = fakeStore(titles);
    const fake = createFakeHttp({
      "/api/v1/tv/108978": { body: overseerrReacher },
      "api.themoviedb.org/3/tv/108978": { status: 404, body: { message: "gone" } },
    });
    const overseerr = createOverseerrClient(() => ({ url: "http://x:5055", apiKey: "k" }), {
      http: fake.http,
      limiter: createPassthroughLimiter(),
    });
    const tmdb = createTmdbClient(() => ({ token: "eyJtest" }), {
      http: fake.http,
      limiter: createPassthroughLimiter(),
    });

    const sweep = createMetadataSweep({
      store,
      configured: () => true,
      details: createDetailsSource({ overseerr, tmdb }),
      buildPatch: metadataPatch,
      getTtlHours: () => SWEEP_TTL_HOURS_DEFAULT,
      limiter: createPassthroughLimiter(),
    });

    const result = await sweep.run({ force: true });
    expect(result.refreshed).toBe(1); // not counted as a failure
    expect(result.failed).toBe(0);
    expect(titles[0]?.episodeDuration).toBe(0); // unchanged, honestly
    expect(titles[0]?.cast).toEqual(["Alan Ritchson"]); // everything else landed
  });
});

describe("the sweep's stagger still governs the request", () => {
  it("the one request happens inside the limiter slot, not alongside it", async () => {
    const events: string[] = [];
    const inner = createPassthroughLimiter();
    // A limiter that brackets each slot, so the ordering of the HTTP calls
    // against `enter`/`exit` is observable. The real sweep limiter is a min-gap
    // limiter with the same `run` contract.
    const spying: RateLimiter = {
      run: async <T,>(fn: () => Promise<T>) => {
        events.push("slot:enter");
        try {
          return await inner.run(fn);
        } finally {
          events.push("slot:exit");
        }
      },
      get pending() {
        return inner.pending;
      },
      idle: () => inner.idle(),
    };

    const fake = createFakeHttp({
      "/api/v1/tv/108978": () => {
        events.push("http:overseerr");
        return { body: overseerrReacher };
      },
      "api.themoviedb.org/3/tv/108978": () => {
        events.push("http:tmdb");
        return { body: tmdbReacher };
      },
    });
    const overseerr = createOverseerrClient(() => ({ url: "http://x:5055", apiKey: "k" }), {
      http: fake.http,
      limiter: createPassthroughLimiter(),
    });
    const tmdb = createTmdbClient(() => ({ token: "eyJtest" }), {
      http: fake.http,
      limiter: createPassthroughLimiter(),
    });

    const titles = [reacher()];
    const sweep = createMetadataSweep({
      store: fakeStore(titles),
      configured: () => true,
      details: createDetailsSource({ overseerr, tmdb }),
      buildPatch: metadataPatch,
      getTtlHours: () => SWEEP_TTL_HOURS_DEFAULT,
      limiter: spying,
    });

    await sweep.run({ force: true });

    // One title, one request, inside the slot — the flip halved the traffic
    // the top-up era needed for the same 44, and none of it is the homelab's.
    expect(events).toEqual(["slot:enter", "http:tmdb", "slot:exit"]);
    expect(titles[0]?.episodeDuration).toBe(44);
  });

  it("an Overseerr-only vault still answers, runtime honestly 0", async () => {
    // No token means the homelab IS the provider — and its stripped payload
    // means the runtime stays 0, exactly as it did before the top-up existed.
    const { fake, source } = pipeline({ tmdbToken: "" });
    expect((await source(108978, "tv")).runtime).toBe(0);
    expect(fake.urls).toHaveLength(1);
    expect(fake.urls[0]).toContain("10.11.111.66");
  });
});
