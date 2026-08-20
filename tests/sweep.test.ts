/**
 * The library-wide metadata sweep (`services/sweep.ts`).
 *
 * This is the one background job in the plugin that touches *every* title, so
 * the things worth testing are the things that would be catastrophic at scale:
 *
 *   - **The skip rules.** Dropped titles and finished films are not refreshed;
 *     a finished *show* still is, because that is how a new season is noticed.
 *   - **The write whitelist.** Nothing the user owns may be overwritten —
 *     rating, review, notes, status, tags, watched episodes, and above all the
 *     `manual*` overrides, which exist specifically to beat the API. This is
 *     tested against a deliberately hostile patch builder, because a patch
 *     builder is exactly the thing that grows a new field one day.
 *   - **`autoStatus: false`.** A background refresh must not reshuffle statuses.
 *   - **Partial failure.** One title 404ing must cost that title and nothing
 *     else.
 *   - **Re-entry.** Two sweeps must never overlap; the second caller is told so
 *     and does nothing.
 *
 * No network: the provider is a `vi.fn`, and the limiter is a passthrough so
 * the suite never waits on the 1 req/s stagger.
 */
import { describe, expect, it, vi } from "vitest";
import { createTitle } from "../src/data/schema";
import { metadataPatch } from "../src/integration";
import { ApiError } from "../src/services/http";
import { createPassthroughLimiter } from "../src/services/ratelimit";
import {
  createMetadataSweep,
  isSweepEligible,
  needsMetadataSweep,
  providerOnlyPatch,
  selectSweepTitles,
  SWEEP_MAX_PER_RUN,
  SWEEP_TTL_HOURS_DEFAULT,
  type SweepDeps,
} from "../src/services/sweep";
import type {
  OverseerrDetails,
  Season,
  TitlePatch,
  TitleV4,
  WatchLogStoreApi,
} from "../src/types";

const NOW = new Date("2026-08-18T12:00:00Z");
/** Older than the weekly TTL, so every fixture is due unless it says otherwise. */
const STALE = "2026-01-01T00:00:00.000Z";
const FRESH = "2026-08-18T06:00:00.000Z";

function season(number: number, episodes: number): Season {
  return { name: `Season ${number}`, episodes, offset: 0, skippedEpisodes: [], seasonNumber: number };
}

function film(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "dune-2",
    title: "Dune: Part Two",
    type: "Movie",
    tmdbId: 693134,
    tmdbMediaType: "movie",
    totalEpisodes: 1,
    communityRatingLastFetched: STALE,
    ...overrides,
  });
}

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "severance",
    title: "Severance",
    type: "TV Show",
    tmdbId: 95396,
    tmdbMediaType: "tv",
    totalEpisodes: 19,
    seasons: [season(1, 9), season(2, 10)],
    communityRatingLastFetched: STALE,
    ...overrides,
  });
}

function details(overrides: Partial<OverseerrDetails> = {}): OverseerrDetails {
  return {
    tmdbId: 95396,
    mediaType: "tv",
    title: "Severance",
    overview: "A fresh overview from upstream",
    releaseDate: "2022-02-18",
    posterUrl: "https://image.tmdb.org/t/p/w342/upstream.jpg",
    trailerUrl: "https://www.youtube.com/watch?v=upstream",
    genres: ["Drama"],
    director: ["Ben Stiller"],
    cast: ["Adam Scott"],
    studio: ["Red Hour"],
    voteAverage: 8.4,
    voteCount: 2000,
    runtime: 47,
    seasons: [],
    ...overrides,
  } as OverseerrDetails;
}

// ---------------------------------------------------------------------------
// A store that records exactly what was written and how
// ---------------------------------------------------------------------------

interface Write {
  id: string;
  patch: TitlePatch;
  reason?: string;
  options?: { autoStatus?: boolean };
}

function fakeStore(titles: TitleV4[]): WatchLogStoreApi & { writes: Write[]; activity: string[] } {
  const writes: Write[] = [];
  const activity: string[] = [];
  const store = {
    writes,
    activity,
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
    updateTitle: (
      id: string,
      patch: TitlePatch,
      reason?: string,
      options?: { autoStatus?: boolean },
    ) => {
      const title = titles.find((t) => t.id === id);
      if (!title) return undefined;
      writes.push({ id, patch, ...(reason !== undefined ? { reason } : {}), ...(options ? { options } : {}) });
      // Mutated in place, never rebuilt from a literal — the store's own
      // contract, and the reason unknown keys survive a write at all.
      Object.assign(title, patch);
      return title;
    },
    logActivity: (entry: { message: string }) => {
      activity.push(entry.message);
    },
  };
  return store as unknown as WatchLogStoreApi & { writes: Write[]; activity: string[] };
}

function sweepDeps(
  titles: TitleV4[],
  overrides: Partial<SweepDeps> = {},
): SweepDeps & { store: ReturnType<typeof fakeStore> } {
  const { store: given, ...rest } = overrides;
  const store = (given as ReturnType<typeof fakeStore> | undefined) ?? fakeStore(titles);
  return {
    configured: () => true,
    details: vi.fn(async () => details()),
    buildPatch: metadataPatch,
    getTtlHours: () => SWEEP_TTL_HOURS_DEFAULT,
    now: () => NOW,
    // No real stagger in tests; the limiter's own gap is covered by
    // `services/ratelimit.test.ts`.
    limiter: createPassthroughLimiter(),
    ...rest,
    store,
  };
}

// ---------------------------------------------------------------------------
// Which titles
// ---------------------------------------------------------------------------

describe("isSweepEligible", () => {
  it("skips a dropped title — the user said they are done with it", () => {
    expect(isSweepEligible(show({ status: "Dropped" }))).toBe(false);
    expect(isSweepEligible(film({ status: "Dropped" }))).toBe(false);
  });

  it("skips a completed film — a finished film's metadata is settled", () => {
    expect(isSweepEligible(film({ status: "Watched" }))).toBe(false);
  });

  it("skips a fully-watched film even when its status says otherwise", () => {
    expect(isSweepEligible(film({ status: "Watching", watchedEpisodes: [1] }))).toBe(false);
  });

  it("KEEPS refreshing a completed show — that is how a new season is noticed", () => {
    expect(isSweepEligible(show({ status: "Watched" }))).toBe(true);
  });

  it("keeps refreshing a show whose every episode is ticked", () => {
    const watched = Array.from({ length: 19 }, (_, i) => i + 1);
    expect(isSweepEligible(show({ status: "Watched", watchedEpisodes: watched }))).toBe(true);
  });

  it("skips a title with no TMDB id — there is nothing to look up", () => {
    expect(isSweepEligible(show({ tmdbId: undefined }))).toBe(false);
  });

  it("sweeps an unreleased film, which is where a date actually changes", () => {
    expect(isSweepEligible(film({ status: "To be released" }))).toBe(true);
  });

  it("sweeps a status the user invented, rather than silently switching off", () => {
    // Statuses are user-configurable; a name this code has never heard of must
    // default to "refresh it", not to "skip it".
    expect(isSweepEligible(show({ status: "Rewatching with Dad" }))).toBe(true);
  });

  it("treats a show with no explicit media type as a show", () => {
    const chimera = show({ tmdbMediaType: undefined, status: "Watched" });
    expect(isSweepEligible(chimera)).toBe(true);
  });
});

describe("needsMetadataSweep", () => {
  it("is due when nothing has ever been fetched", () => {
    expect(needsMetadataSweep(show({ communityRatingLastFetched: "" }), 168, NOW)).toBe(true);
  });

  it("is due once the stamp is older than the TTL", () => {
    expect(needsMetadataSweep(show({ communityRatingLastFetched: STALE }), 168, NOW)).toBe(true);
  });

  it("is not due while the stamp is inside the TTL", () => {
    expect(needsMetadataSweep(show({ communityRatingLastFetched: FRESH }), 168, NOW)).toBe(false);
  });

  it("inherits the manual Refresh button's write for free", () => {
    // The per-title button stamps the same field, so refreshing by hand today
    // buys a week of the sweep leaving that title alone.
    const justRefreshed = show({ communityRatingLastFetched: NOW.toISOString() });
    expect(needsMetadataSweep(justRefreshed, 168, NOW)).toBe(false);
  });

  it("is due on an unparseable stamp rather than never", () => {
    expect(needsMetadataSweep(show({ communityRatingLastFetched: "yesterday" }), 168, NOW)).toBe(true);
  });

  it("cannot be turned into a hot loop by a zero TTL", () => {
    const anHourAgo = new Date(NOW.getTime() - 3600_000 + 1).toISOString();
    expect(needsMetadataSweep(show({ communityRatingLastFetched: anHourAgo }), 0, NOW)).toBe(false);
  });
});

describe("selectSweepTitles", () => {
  it("picks the due and eligible, and nothing else", () => {
    const titles = [
      show({ id: "due-show" }),
      show({ id: "fresh-show", communityRatingLastFetched: FRESH }),
      film({ id: "done-film", status: "Watched" }),
      show({ id: "dropped-show", status: "Dropped" }),
      film({ id: "due-film" }),
    ];
    expect(selectSweepTitles(titles, { ttlHours: 168, now: NOW }).map((t) => t.id)).toEqual([
      "due-show",
      "due-film",
    ]);
  });

  it("ignores the TTL under force, but never the skip rules", () => {
    const titles = [
      show({ id: "fresh-show", communityRatingLastFetched: FRESH }),
      film({ id: "done-film", status: "Watched" }),
    ];
    expect(
      selectSweepTitles(titles, { ttlHours: 168, now: NOW, force: true }).map((t) => t.id),
    ).toEqual(["fresh-show"]);
  });

  it("caps a run and takes the oldest first, so successive runs cover the library", () => {
    const titles = Array.from({ length: 5 }, (_, i) =>
      show({ id: `s${i}`, communityRatingLastFetched: `2026-0${i + 1}-01T00:00:00.000Z` }),
    );
    expect(selectSweepTitles(titles.reverse(), { ttlHours: 168, now: NOW, limit: 2 }).map((t) => t.id)).toEqual([
      "s0",
      "s1",
    ]);
  });

  it("defaults the cap rather than running unbounded", () => {
    const titles = Array.from({ length: SWEEP_MAX_PER_RUN + 20 }, (_, i) => show({ id: `s${i}` }));
    expect(selectSweepTitles(titles, { ttlHours: 168, now: NOW })).toHaveLength(SWEEP_MAX_PER_RUN);
  });
});

// ---------------------------------------------------------------------------
// What may be written
// ---------------------------------------------------------------------------

describe("providerOnlyPatch", () => {
  it("keeps the provider-sourced fields", () => {
    const kept = providerOnlyPatch({
      overview: "new",
      posterUrl: "https://example.invalid/p.jpg",
      cast: ["A"],
      communityRating: 8,
      year: 2022,
      episodeDuration: 47,
    });
    expect(kept).toEqual({
      overview: "new",
      posterUrl: "https://example.invalid/p.jpg",
      cast: ["A"],
      communityRating: 8,
      year: 2022,
      episodeDuration: 47,
    });
  });

  it("strips every field the user owns, including the manual* overrides", () => {
    // The worst possible bug in this feature: `manual*` exists precisely to beat
    // the API, so a sweep that wrote them would destroy the one thing the user
    // did by hand to say "no, not that poster".
    const hostile = {
      overview: "kept",
      rating: 5,
      review: "Loved it",
      notes: "watched with Sam",
      favorite: true,
      status: "Watched",
      priority: "High",
      tags: ["rewatch"],
      watchedEpisodes: [1, 2, 3],
      dateStarted: "2026-01-01",
      dateFinished: "2026-01-02",
      manualPosterUrl: "https://mine.invalid/p.jpg",
      manualTrailerUrl: "https://mine.invalid/t",
      manualCast: ["Someone the API missed"],
      manualDirector: ["Also missed"],
      manualStudio: ["Ditto"],
    } as unknown as TitlePatch;
    expect(providerOnlyPatch(hostile)).toEqual({ overview: "kept" });
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe("createMetadataSweep", () => {
  it("refreshes the due titles and writes provider fields through", async () => {
    const title = show();
    const deps = sweepDeps([title]);
    const result = await createMetadataSweep(deps).run();

    expect(result.total).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(deps.details).toHaveBeenCalledTimes(1);
    expect(deps.details).toHaveBeenCalledWith(95396, "tv");
    expect(title.overview).toBe("A fresh overview from upstream");
    expect(title.posterUrl).toBe("https://image.tmdb.org/t/p/w342/upstream.jpg");
    expect(title.communityRating).toBe(8.4);
  });

  it("passes autoStatus:false — a background refresh is not a user action", async () => {
    const deps = sweepDeps([show()]);
    await createMetadataSweep(deps).run();
    expect(deps.store.writes).toHaveLength(1);
    expect(deps.store.writes[0]?.options).toEqual({ autoStatus: false });
  });

  it("leaves every user field and every manual* override untouched", async () => {
    const watched = [1, 2, 3, 4, 5];
    const title = show({
      rating: 5,
      review: "Masterpiece",
      notes: "Ep 7 is the one",
      favorite: true,
      status: "Watched",
      priority: "High",
      tags: ["rewatch", "sci-fi"],
      watchedEpisodes: watched,
      dateStarted: "2026-01-01",
      dateFinished: "2026-02-02",
      manualPosterUrl: "https://mine.invalid/poster.jpg",
      manualTrailerUrl: "https://mine.invalid/trailer",
      manualCast: ["Uncredited Person"],
      manualDirector: ["Uncredited Director"],
      manualStudio: ["Uncredited Studio"],
    });

    // A hostile patch builder: even if `metadataPatch` grew these fields
    // tomorrow, the sweep must still refuse to write them.
    const deps = sweepDeps([title], {
      buildPatch: (t, d) =>
        ({
          ...metadataPatch(t, d),
          rating: 1,
          review: "",
          notes: "",
          favorite: false,
          status: "Plan to watch",
          priority: "",
          tags: [],
          watchedEpisodes: [],
          dateStarted: null,
          dateFinished: null,
          manualPosterUrl: "",
          manualTrailerUrl: "",
          manualCast: [],
          manualDirector: [],
          manualStudio: [],
        }) as unknown as TitlePatch,
    });

    await createMetadataSweep(deps).run();

    expect(title.rating).toBe(5);
    expect(title.review).toBe("Masterpiece");
    expect(title.notes).toBe("Ep 7 is the one");
    expect(title.favorite).toBe(true);
    expect(title.status).toBe("Watched");
    expect(title.priority).toBe("High");
    expect(title.tags).toEqual(["rewatch", "sci-fi"]);
    expect(title.watchedEpisodes).toEqual(watched);
    expect(title.dateStarted).toBe("2026-01-01");
    expect(title.dateFinished).toBe("2026-02-02");
    expect(title.manualPosterUrl).toBe("https://mine.invalid/poster.jpg");
    expect(title.manualTrailerUrl).toBe("https://mine.invalid/trailer");
    expect(title.manualCast).toEqual(["Uncredited Person"]);
    expect(title.manualDirector).toEqual(["Uncredited Director"]);
    expect(title.manualStudio).toEqual(["Uncredited Studio"]);

    // And it did do its actual job.
    expect(title.overview).toBe("A fresh overview from upstream");
  });

  it("leaves dateModified alone, so a poll cannot reshuffle 'Last updated'", async () => {
    // `types.ts` on `updateCaches`: a background refresh is not the user editing
    // the title. A sweep restamping every title to the same minute would flatten
    // the "Last updated" sort and scramble the "Recently watched" shelf, which
    // reads the same field.
    const title = show({ dateModified: "2026-03-04T10:00:00.000Z" });
    const deps = sweepDeps([title]);
    // The fake store stamps it the way the real one does.
    deps.store.updateTitle = ((id: string, patch: TitlePatch) => {
      const found = [title].find((t) => t.id === id);
      if (!found) return undefined;
      Object.assign(found, patch);
      found.dateModified = new Date().toISOString();
      return found;
    }) as WatchLogStoreApi["updateTitle"];

    await createMetadataSweep(deps).run();

    expect(title.dateModified).toBe("2026-03-04T10:00:00.000Z");
    expect(title.overview).toBe("A fresh overview from upstream");
  });

  it("never overwrites a season structure that already exists", async () => {
    // Season structures hold the user's skipped episodes; replacing one is data
    // loss, so `metadataPatch` only fills them in when there are none.
    const title = show();
    const before = title.seasons;
    await createMetadataSweep(
      sweepDeps([title], {
        details: async () =>
          details({ seasons: [{ seasonNumber: 1, episodeCount: 99, name: "Season 1" }] as never }),
      }),
    ).run();
    expect(title.seasons).toBe(before);
    expect(title.totalEpisodes).toBe(19);
  });

  it("keeps going when one title fails, and counts it", async () => {
    const good = show({ id: "good" });
    const bad = show({ id: "bad", tmdbId: 111 });
    const alsoGood = show({ id: "also-good", tmdbId: 222 });
    const deps = sweepDeps([good, bad, alsoGood], {
      details: vi.fn(async (tmdbId: number) => {
        if (tmdbId === 111) {
          throw new ApiError({ source: "overseerr", reason: "not-found", status: 404 });
        }
        return details();
      }),
    });

    const result = await createMetadataSweep(deps).run();

    expect(result.total).toBe(3);
    expect(result.refreshed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.message).toContain("1 skipped");
    // The title after the failure was still refreshed — that is the whole point.
    expect(deps.store.writes.map((w) => w.id)).toEqual(["good", "also-good"]);
  });

  it("survives a plain thrown Error as well as an ApiError", async () => {
    const deps = sweepDeps([show()], {
      details: async () => {
        throw new Error("socket hang up");
      },
    });
    const result = await createMetadataSweep(deps).run();
    expect(result.failed).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(deps.store.writes).toHaveLength(0);
  });

  it("refuses to start a second sweep while one is running", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = sweepDeps([show(), show({ id: "two", tmdbId: 2 })], {
      details: vi.fn(async () => {
        await gate;
        return details();
      }),
    });
    const sweep = createMetadataSweep(deps);

    const first = sweep.run();
    // Let the first run get as far as its first provider call.
    await Promise.resolve();
    expect(sweep.running).toBe(true);

    const second = await sweep.run();
    expect(second.skipped).toBe(true);
    expect(second.refreshed).toBe(0);
    expect(second.message).toContain("already running");

    release();
    const result = await first;
    expect(result.refreshed).toBe(2);
    // Two titles, two calls — not four.
    expect(deps.details).toHaveBeenCalledTimes(2);
    expect(sweep.running).toBe(false);
  });

  it("stops after the title it is on when cancelled", async () => {
    const titles = Array.from({ length: 5 }, (_, i) => show({ id: `s${i}`, tmdbId: 100 + i }));
    const deps = sweepDeps(titles);
    const sweep = createMetadataSweep(deps);
    const result = await sweep.run({
      onProgress: (done) => {
        if (done === 1) sweep.cancel();
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.total).toBe(5);
    expect(result.refreshed).toBe(2);
    expect(result.message).toContain("stopped after 2 of 5");
    expect(deps.store.writes).toHaveLength(2);
  });

  it("reports progress once per title, from zero", async () => {
    const titles = [show({ id: "a" }), show({ id: "b", tmdbId: 2 })];
    const seen: [number, number, string][] = [];
    await createMetadataSweep(sweepDeps(titles)).run({
      onProgress: (done, total, title) => seen.push([done, total, title.id]),
    });
    expect(seen).toEqual([
      [0, 2, "a"],
      [1, 2, "b"],
    ]);
  });

  it("does nothing when no provider is configured", async () => {
    const deps = sweepDeps([show()], { configured: () => false });
    const result = await createMetadataSweep(deps).run();
    expect(result.total).toBe(0);
    expect(deps.details).not.toHaveBeenCalled();
    expect(result.message).toContain("No metadata provider");
  });

  it("is switched off by a zero TTL, but the manual command still forces it", async () => {
    const deps = sweepDeps([show()], { getTtlHours: () => 0 });
    const sweep = createMetadataSweep(deps);

    const off = await sweep.run();
    expect(off.total).toBe(0);
    expect(off.message).toContain("switched off");
    expect(deps.details).not.toHaveBeenCalled();

    const forced = await sweep.run({ force: true });
    expect(forced.refreshed).toBe(1);
  });

  it("says so plainly when nothing is stale", async () => {
    const deps = sweepDeps([show({ communityRatingLastFetched: FRESH })]);
    const result = await createMetadataSweep(deps).run();
    expect(result.total).toBe(0);
    expect(result.message).toContain("already up to date");
    expect(deps.details).not.toHaveBeenCalled();
  });

  it("patches the live title, not the copy it queued minutes ago", async () => {
    // The run is minutes long; the user may edit a title while it waits. The
    // sweep re-reads from the store before patching so it cannot write back a
    // stale copy.
    const title = show();
    const store = fakeStore([title]);
    const seen: string[] = [];
    const deps = sweepDeps([title], {
      store: store as unknown as WatchLogStoreApi,
      buildPatch: (t, d) => {
        seen.push(t.notes);
        return metadataPatch(t, d);
      },
      details: async () => {
        title.notes = "edited mid-sweep";
        return details();
      },
    });

    await createMetadataSweep(deps).run();
    expect(seen).toEqual(["edited mid-sweep"]);
    expect(title.notes).toBe("edited mid-sweep");
  });

  it("counts what a sweep would do without doing it", () => {
    const deps = sweepDeps([
      show({ id: "due" }),
      show({ id: "fresh", communityRatingLastFetched: FRESH }),
      film({ id: "done", status: "Watched" }),
    ]);
    expect(createMetadataSweep(deps).dueCount()).toBe(1);
    expect(deps.details).not.toHaveBeenCalled();
  });
});
