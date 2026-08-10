/**
 * Wave-2 integration logic — the pure half of everything the composition root
 * wires together.
 *
 * Four surfaces, all of which can be wrong in ways a screenshot will not show:
 *
 *   - the YouTube URL codec behind the trailer modal;
 *   - the season defaults and outcome mapping behind the request flow;
 *   - the request poller's transition detection (the Notice must fire once, on
 *     the *crossing*, and never again);
 *   - `metadataPatch`, which decides what a "refresh metadata" is allowed to
 *     overwrite — the one place in the plugin where a bug is silent data loss.
 */
import { describe, expect, it, vi } from "vitest";
import { createTitle } from "../src/data/schema";
import {
  MediaRequestStatus,
  MediaStatus,
  type OverseerrDetails,
  type OverseerrRequest,
  type RequestCache,
  type Season,
  type TitleV4,
  type WatchLogStoreApi,
} from "../src/types";
import {
  trailerUrlOf,
  youtubeEmbedUrl,
  youtubeKey,
  youtubeWatchUrl,
} from "../src/ui/modals/trailer";
import {
  becameAvailable,
  becamePartiallyAvailable,
  cacheFromRequest,
  createRequestService,
  defaultSeasonSelection,
  interpretOutcome,
  isRequestSettled,
  mediaTypeOf,
  needsSeasonPicker,
  plexEpisodesBySeason,
  requestChanged,
  seasonOnPlex,
  trackedRequests,
} from "../src/services/requests";
import { metadataPatch } from "../src/integration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function season(number: number, episodes: number, skipped: number[] = []): Season {
  return {
    name: `Season ${number}`,
    episodes,
    offset: 0,
    skippedEpisodes: skipped,
    seasonNumber: number,
  };
}

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "show",
    title: "Shrinking",
    type: "TV Show",
    tmdbId: 202526,
    tmdbMediaType: "tv",
    totalEpisodes: 22,
    seasons: [season(1, 10), season(2, 12)],
    ...overrides,
  });
}

function movie(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "movie",
    title: "Anora",
    type: "Movie",
    tmdbId: 1064213,
    tmdbMediaType: "movie",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Trailers (SPEC 4.3)
// ---------------------------------------------------------------------------

describe("youtubeKey", () => {
  it("reads every URL shape we might have stored", () => {
    expect(youtubeKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeKey("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(youtubeKey("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeKey("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
    expect(youtubeKey("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeKey("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("accepts a bare 11-character id", () => {
    expect(youtubeKey("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns empty for non-YouTube and unusable input", () => {
    expect(youtubeKey("")).toBe("");
    expect(youtubeKey("none")).toBe("");
    expect(youtubeKey("https://vimeo.com/12345")).toBe("");
    expect(youtubeKey("not a url")).toBe("");
    // Right host, no id — must not produce a broken embed.
    expect(youtubeKey("https://www.youtube.com/results?search_query=anora")).toBe("");
  });

  it("does not mistake a lookalike host for YouTube", () => {
    expect(youtubeKey("https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ")).toBe("");
  });
});

describe("trailer URLs", () => {
  it("embeds through youtube-nocookie with autoplay", () => {
    const url = youtubeEmbedUrl("dQw4w9WgXcQ");
    expect(url).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(url).toContain("autoplay=1");
    expect(url).toContain("rel=0");
  });

  it("always has a plain watch URL for the escape hatch", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("prefers the manual override and ignores the v3 sentinel", () => {
    expect(trailerUrlOf(movie({ trailerUrl: "auto", manualTrailerUrl: "manual" }))).toBe("manual");
    expect(trailerUrlOf(movie({ trailerUrl: "auto", manualTrailerUrl: "" }))).toBe("auto");
    expect(trailerUrlOf(movie({ trailerUrl: "none", manualTrailerUrl: "none" }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Season picker defaults (SPEC 4.2)
// ---------------------------------------------------------------------------

describe("season selection", () => {
  it("pre-checks the seasons Plex does not have", () => {
    const title = show({
      plex: {
        state: "partial",
        // Season 1 complete, season 2 half-there.
        episodes: [
          ...Array.from({ length: 10 }, (_, i) => ({ s: 1, e: i + 1 })),
          ...Array.from({ length: 6 }, (_, i) => ({ s: 2, e: i + 1 })),
        ],
      },
    });
    expect(seasonOnPlex(title, 0)).toBe(true);
    expect(seasonOnPlex(title, 1)).toBe(false);
    expect(defaultSeasonSelection(title)).toEqual([2]);
  });

  // Review P1-1: a season is complete when Plex holds every real episode of it.
  // Skipped episodes are watch progress and never shrink that requirement.
  it("does not count a season complete just because the skipped ones are missing", () => {
    const title = show({
      seasons: [season(1, 10, [9, 10])],
      plex: {
        state: "partial",
        episodes: Array.from({ length: 8 }, (_, i) => ({ s: 1, e: i + 1 })),
      },
    });
    expect(seasonOnPlex(title, 0)).toBe(false);
  });

  it("counts a season complete once every real episode is present", () => {
    const title = show({
      seasons: [season(1, 10, [9, 10])],
      plex: {
        state: "available",
        episodes: Array.from({ length: 10 }, (_, i) => ({ s: 1, e: i + 1 })),
      },
    });
    expect(seasonOnPlex(title, 0)).toBe(true);
  });

  it("pre-checks everything when Plex knows nothing — unknown is not 'have it'", () => {
    expect(defaultSeasonSelection(show())).toEqual([1, 2]);
  });

  it("falls back to every season rather than an empty request", () => {
    const complete = show({
      plex: {
        state: "available",
        episodes: [
          ...Array.from({ length: 10 }, (_, i) => ({ s: 1, e: i + 1 })),
          ...Array.from({ length: 12 }, (_, i) => ({ s: 2, e: i + 1 })),
        ],
      },
    });
    // Everything is already there, so there is no useful default — offering the
    // full list beats offering nothing and disabling the button.
    expect(defaultSeasonSelection(complete)).toEqual([1, 2]);
  });

  it("counts Plex episodes per season", () => {
    const counts = plexEpisodesBySeason(
      show({ plex: { state: "partial", episodes: [{ s: 1, e: 1 }, { s: 1, e: 2 }, { s: 3, e: 1 }] } }),
    );
    expect(counts.get(1)).toBe(2);
    expect(counts.get(3)).toBe(1);
    expect(counts.get(2)).toBeUndefined();
  });

  it("sends movies straight through and shows to the picker", () => {
    expect(needsSeasonPicker(movie())).toBe(false);
    expect(needsSeasonPicker(show())).toBe(true);
    expect(mediaTypeOf(movie())).toBe("movie");
    expect(mediaTypeOf(show())).toBe("tv");
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function requestRow(overrides: Partial<OverseerrRequest> = {}): OverseerrRequest {
  return {
    id: 77,
    status: MediaRequestStatus.PENDING,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    is4k: false,
    seasons: [2, 1],
    ...overrides,
  };
}

describe("interpretOutcome", () => {
  const at = "2026-08-03T12:00:00.000Z";

  it("stores the new request on 201", () => {
    const result = interpretOutcome(show(), { kind: "created", request: requestRow() }, at);
    expect(result.ok).toBe(true);
    expect(result.cache?.id).toBe(77);
    // Overseerr's echo is not sorted; ours is, because the UI prints it.
    expect(result.cache?.seasons).toEqual([1, 2]);
  });

  it("adopts the pre-existing request on 409 rather than reporting an error", () => {
    const result = interpretOutcome(
      show(),
      { kind: "duplicate", request: requestRow({ id: 12 }), message: "Already requested" },
      at,
    );
    expect(result.ok).toBe(true);
    expect(result.cache?.id).toBe(12);
  });

  it("stores nothing for 202 and 403", () => {
    const nothing = interpretOutcome(show(), { kind: "nothing-to-request", message: "" }, at);
    expect(nothing.ok).toBe(false);
    expect(nothing.cache).toBeUndefined();

    const denied = interpretOutcome(show(), { kind: "denied", message: "Quota exceeded" }, at);
    expect(denied.ok).toBe(false);
    expect(denied.message).toBe("Quota exceeded");
  });

  it("keeps the original requestedAt across updates", () => {
    const previous: RequestCache = { id: 77, requestedAt: "2026-07-01T00:00:00.000Z" };
    const cache = cacheFromRequest(requestRow(), at, previous);
    expect(cache.requestedAt).toBe("2026-07-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Poll transitions
// ---------------------------------------------------------------------------

describe("poll transitions", () => {
  it("fires on the crossing and never again", () => {
    const before: RequestCache = { id: 1, mediaStatus: MediaStatus.PROCESSING };
    const after: RequestCache = { id: 1, mediaStatus: MediaStatus.AVAILABLE };
    expect(becameAvailable(before, after)).toBe(true);
    expect(becameAvailable(after, after)).toBe(false);
  });

  it("treats partial availability as its own crossing", () => {
    const before: RequestCache = { id: 1, mediaStatus: MediaStatus.PROCESSING };
    const after: RequestCache = { id: 1, mediaStatus: MediaStatus.PARTIALLY_AVAILABLE };
    expect(becamePartiallyAvailable(before, after)).toBe(true);
    expect(becameAvailable(before, after)).toBe(false);
  });

  it("stops polling once a request is available, declined or failed", () => {
    expect(isRequestSettled(undefined)).toBe(true);
    expect(isRequestSettled({ id: 1, mediaStatus: MediaStatus.PROCESSING })).toBe(false);
    expect(isRequestSettled({ id: 1, mediaStatus: MediaStatus.AVAILABLE })).toBe(true);
    expect(isRequestSettled({ id: 1, status: MediaRequestStatus.DECLINED })).toBe(true);
    expect(isRequestSettled({ id: 1, status: MediaRequestStatus.FAILED })).toBe(true);
  });

  it("only repaints when something the UI renders moved", () => {
    const base: RequestCache = { id: 1, status: 1, mediaStatus: 2, checkedAt: "a" };
    expect(requestChanged(base, { ...base, checkedAt: "b" })).toBe(false);
    expect(requestChanged(base, { ...base, status: 2 })).toBe(true);
    expect(requestChanged(base, { ...base, mediaStatus: 5 })).toBe(true);
    expect(requestChanged(undefined, base)).toBe(true);
  });

  it("only polls unsettled requests", () => {
    const titles = [
      show({ id: "a", request: { id: 1, mediaStatus: MediaStatus.PROCESSING } }),
      show({ id: "b", request: { id: 2, mediaStatus: MediaStatus.AVAILABLE } }),
      show({ id: "c" }),
    ];
    expect(trackedRequests(titles).map((t) => t.id)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// The service, against a fake store
// ---------------------------------------------------------------------------

function fakeStore(titles: TitleV4[]): WatchLogStoreApi & { activity: string[] } {
  const activity: string[] = [];
  const store = {
    activity,
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
    updateCaches: (id: string, patch: Record<string, unknown>) => {
      const title = titles.find((t) => t.id === id);
      if (title) Object.assign(title, patch);
      return title;
    },
    logActivity: (entry: { message: string }) => {
      activity.push(entry.message);
    },
  };
  return store as unknown as WatchLogStoreApi & { activity: string[] };
}

describe("createRequestService", () => {
  it("announces exactly once when a tracked request lands", async () => {
    const title = show({ request: { id: 9, mediaStatus: MediaStatus.PROCESSING } });
    const store = fakeStore([title]);
    const notify = vi.fn();
    const onAvailable = vi.fn();

    const overseerr = {
      configured: () => true,
      getRequest: vi.fn(async () =>
        requestRow({
          id: 9,
          status: MediaRequestStatus.COMPLETED,
          media: { status: MediaStatus.AVAILABLE } as OverseerrRequest["media"],
        }),
      ),
    } as unknown as Parameters<typeof createRequestService>[0]["overseerr"];

    const service = createRequestService({ overseerr, store, notify, onAvailable });

    const first = await service.pollOnce();
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("available");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.activity).toEqual(["«Shrinking» is now on Plex"]);
    expect(onAvailable).toHaveBeenCalledTimes(1);

    // The request is settled now, so a second pass must be a complete no-op —
    // this is the "notified me every five minutes forever" bug.
    const second = await service.pollOnce();
    expect(second).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit without a TMDB id instead of posting nonsense", async () => {
    const title = show({ tmdbId: undefined });
    const store = fakeStore([title]);
    const request = vi.fn();
    const service = createRequestService({
      overseerr: { configured: () => true, request } as never,
      store,
    });

    const result = await service.submit(title, [1]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no TMDB id");
    expect(request).not.toHaveBeenCalled();
  });

  it("says so plainly when Overseerr is not configured", async () => {
    const title = show();
    const service = createRequestService({
      overseerr: { configured: () => false } as never,
      store: fakeStore([title]),
    });
    const result = await service.submit(title, [1]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// metadataPatch — what a refresh may and may not touch
// ---------------------------------------------------------------------------

function details(overrides: Partial<OverseerrDetails> = {}): OverseerrDetails {
  return {
    tmdbId: 202526,
    mediaType: "tv",
    title: "Shrinking",
    overview: "Fresh overview",
    posterUrl: "https://image.tmdb.org/t/p/w342/new.jpg",
    backdropUrl: "",
    releaseDate: "2023-01-27",
    genres: ["Comedy"],
    runtime: 30,
    voteAverage: 8.2,
    voteCount: 900,
    trailerUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    director: ["Bill Lawrence"],
    cast: ["Jason Segel"],
    studio: ["Apple"],
    ...overrides,
  };
}

describe("metadataPatch", () => {
  it("never touches anything the user owns", () => {
    const patch = metadataPatch(show(), details());
    for (const key of [
      "rating",
      "notes",
      "status",
      "priority",
      "tags",
      "favorite",
      "watchedEpisodes",
      "manualPosterUrl",
      "manualTrailerUrl",
      "manualCast",
    ]) {
      expect(patch).not.toHaveProperty(key);
    }
  });

  it("keeps a working poster when the provider came back empty", () => {
    const existing = show({ posterUrl: "https://image.tmdb.org/t/p/w342/old.jpg" });
    const patch = metadataPatch(existing, details({ posterUrl: "", trailerUrl: "" }));
    expect(patch.posterUrl).toBeUndefined();
    expect(patch.trailerUrl).toBeUndefined();
  });

  it("adopts a fresh poster and trailer when there is one", () => {
    const patch = metadataPatch(show(), details());
    expect(patch.posterUrl).toBe("https://image.tmdb.org/t/p/w342/new.jpg");
    expect(patch.trailerUrl).toContain("dQw4w9WgXcQ");
    expect(patch.year).toBe(2023);
  });

  it("keeps existing credits when the provider returns none", () => {
    const existing = show({ cast: ["Harrison Ford"], genres: ["Drama"] });
    const patch = metadataPatch(existing, details({ cast: [], genres: [], director: [], studio: [] }));
    expect(patch.cast).toEqual(["Harrison Ford"]);
    expect(patch.genres).toEqual(["Drama"]);
  });

  it("refuses to overwrite seasons — that would discard skipped episodes", () => {
    const tracked = show({ seasons: [season(1, 10, [3, 4])] });
    const patch = metadataPatch(
      tracked,
      details({
        seasons: [
          { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: null },
          { seasonNumber: 2, name: "Season 2", episodeCount: 12, airDate: null },
        ],
        numberOfSeasons: 2,
      }),
    );
    expect(patch.seasons).toBeUndefined();
    expect(patch.totalEpisodes).toBeUndefined();
  });

  it("does adopt seasons when the tracker has none at all", () => {
    const bare = show({ seasons: [], totalEpisodes: 1 });
    const patch = metadataPatch(
      bare,
      details({
        seasons: [
          { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: null },
          { seasonNumber: 2, name: "Season 2", episodeCount: 12, airDate: null },
        ],
      }),
    );
    expect(patch.seasons).toHaveLength(2);
    expect(patch.totalEpisodes).toBe(22);
  });
});
