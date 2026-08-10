/**
 * QA round 3 — "why do all seasons of one show need a separate tracker?"
 *
 * The data model was never the problem: one title holds every season. The
 * *workflow* was — each new season arrived as an announcement with an "add it"
 * button, which is per-season homework for a show the user already follows.
 *
 * These tests pin the new bargain: seasons are adopted automatically, watched
 * state survives the geometry change, and nothing about the user's own row —
 * status, finish date, ratings — is touched behind their back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchLogStore } from "../src/data/store";
import { createTitle } from "../src/data/schema";
import {
  computeAiring,
  detectPendingSeason,
  isEmptySyncPlan,
  seasonRebuildPlan,
  seasonSyncPlan,
} from "../src/services/airing";
import {
  getWatchedCount,
  rememberSeasonGeometry,
  sanitizeWatchedEpisodes,
  withAddedSeason,
} from "../src/data/episodes";
import { buildUpcomingEntries, formatCountdown } from "../src/ui/tabs/upcoming";
import { identityMatches, typeFamilyOf, typeRepairFor } from "../src/services/match";
import { hasUnwatchedNewSeason, nextUpText, progressText } from "../src/ui/components/pills";
import type { OverseerrDetails, TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3);

// ---------------------------------------------------------------------------
// The store needs a document to dispatch its change event on.
// ---------------------------------------------------------------------------

beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !== "function") {
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class {
        constructor(
          public type: string,
          public init?: unknown,
        ) {}
      },
    });
  }
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  vi.useRealTimers();
});

function fakePlugin() {
  return {
    loadData: vi.fn(async () => null),
    saveData: vi.fn(async () => undefined),
  };
}

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "dexter-resurrection",
    title: "Dexter: Resurrection",
    type: "TV Show",
    status: "Completed",
    totalEpisodes: 10,
    watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    dateFinished: "2025-09-08",
    tmdbId: 259909,
    tmdbMediaType: "tv",
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
    ],
    ...overrides,
  });
}

function details(overrides: Partial<OverseerrDetails> = {}): OverseerrDetails {
  return {
    tmdbId: 259909,
    mediaType: "tv",
    title: "Dexter: Resurrection",
    overview: "",
    posterUrl: "",
    backdropUrl: "",
    releaseDate: "2025-07-13",
    genres: [],
    runtime: 0,
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
    seasons: [
      { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
      { seasonNumber: 2, name: "Season 2", episodeCount: 0, airDate: null },
    ],
    nextEpisodeToAir: null,
    lastEpisodeToAir: { seasonNumber: 1, episodeNumber: 10, airDate: "2025-09-07" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fix 1 — the plan
// ---------------------------------------------------------------------------

describe("W6-1 — upstream seasons are adopted, not offered", () => {
  it("plans to append an announced season that has no episodes yet", () => {
    const plan = seasonSyncPlan(show(), details());
    expect(plan.added).toEqual([
      { seasonNumber: 2, episodes: 0, name: "Season 2", airDate: null },
    ]);
    expect(plan.grown).toEqual([]);
    expect(isEmptySyncPlan(plan)).toBe(false);
  });

  it("plans nothing when the tracker is already in step", () => {
    const upToDate = show({
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 0, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });
    expect(isEmptySyncPlan(seasonSyncPlan(upToDate, details()))).toBe(true);
  });

  it("never back-fills seasons the user deliberately skipped", () => {
    // Someone who tracks only seasons 2–3 of a long-runner did not ask for
    // season 1 to appear — and nothing asks them first, so the restraint has to
    // live here.
    const partial = show({
      seasons: [
        { name: "Season 2", episodes: 12, offset: 0, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 12, offset: 12, skippedEpisodes: [], seasonNumber: 3 },
      ],
    });
    const plan = seasonSyncPlan(
      partial,
      details({
        numberOfSeasons: 4,
        seasons: [
          { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2023-01-01" },
          { seasonNumber: 2, name: "Season 2", episodeCount: 12, airDate: "2024-01-01" },
          { seasonNumber: 3, name: "Season 3", episodeCount: 12, airDate: "2025-01-01" },
          { seasonNumber: 4, name: "Season 4", episodeCount: 0, airDate: null },
        ],
      }),
    );
    expect(plan.added.map((a) => a.seasonNumber)).toEqual([4]);
  });

  it("plans several seasons at once, in order, for a long-neglected tracker", () => {
    const plan = seasonSyncPlan(
      show(),
      details({
        numberOfSeasons: 4,
        seasons: [
          { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
          { seasonNumber: 3, name: "Season 3", episodeCount: 8, airDate: "2027-01-01" },
          { seasonNumber: 2, name: "Season 2", episodeCount: 9, airDate: "2026-09-01" },
        ],
      }),
    );
    expect(plan.added.map((a) => a.seasonNumber)).toEqual([2, 3]);
    expect(plan.added.map((a) => a.episodes)).toEqual([9, 8]);
  });

  it("plans nothing for a film", () => {
    const film = createTitle({ id: "anora", title: "Anora", type: "Movie", tmdbMediaType: "movie" });
    expect(isEmptySyncPlan(seasonSyncPlan(film, details({ mediaType: "movie" })))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — the write, and what it must not disturb
// ---------------------------------------------------------------------------

describe("W6-3 — adopting a season leaves the user's row alone", () => {
  const storeWith = (title: TitleV4): WatchLogStore => {
    const store = new WatchLogStore(fakePlugin() as never);
    store.data.titles.push(title);
    return store;
  };

  it("keeps a Completed show Completed when a season is appended", () => {
    const title = show();
    const store = storeWith(title);
    const seasons = withAddedSeason(title.seasons, 2, 0, null);

    store.updateTitle(
      title.id,
      { seasons, totalEpisodes: 10 },
      "seasons-synced",
      { autoStatus: false },
    );

    const after = store.getTitle(title.id);
    expect(after?.status).toBe("Completed");
    expect(after?.dateFinished).toBe("2025-09-08");
    expect(after?.seasons.map((s) => s.seasonNumber)).toEqual([1, 2]);
    // Every watched episode survives.
    expect(after?.watchedEpisodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("still un-completes when the *user* is the one editing", () => {
    // The same geometry change through the normal path keeps its old behaviour:
    // `autoStatus: false` is about who made the edit, not about what changed.
    const title = show();
    const store = storeWith(title);
    const seasons = withAddedSeason(title.seasons, 2, 8, null);
    store.updateTitle(title.id, { seasons, totalEpisodes: 18 }, "season-added");
    expect(store.getTitle(title.id)?.status).toBe("Watching");
  });

  it("preserves watched episodes when a middle season grows and shifts the rest", () => {
    // S1 (10, all watched) + S2 (0) + S3 (5, all watched at 11..15). Upstream
    // then publishes S2 as 8 episodes, which moves S3 from offset 10 to 18.
    const title = show({
      status: "Watching",
      totalEpisodes: 15,
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 0, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 5, offset: 10, skippedEpisodes: [], seasonNumber: 3 },
      ],
    });
    const store = storeWith(title);

    store.updateTitle(
      title.id,
      {
        seasons: [
          { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
          { name: "Season 2", episodes: 8, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
          { name: "Season 3", episodes: 5, offset: 18, skippedEpisodes: [], seasonNumber: 3 },
        ],
        totalEpisodes: 23,
      },
      "seasons-synced",
      { autoStatus: false },
    );

    const after = store.getTitle(title.id);
    // Season 1 keeps 1–10; season 3's five episodes are re-expressed at 19–23.
    expect(after?.watchedEpisodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 19, 20, 21, 22, 23]);
    expect(getWatchedCount(after as TitleV4)).toBe(15);
    // The eight new middle episodes are the only unwatched ones.
    expect((after?.totalEpisodes ?? 0) - getWatchedCount(after as TitleV4)).toBe(8);
  });

  it("leaves a rating, notes and the watched list untouched", () => {
    const title = show({ rating: 4.5, notes: "great finale" });
    const store = storeWith(title);
    store.updateTitle(
      title.id,
      { seasons: withAddedSeason(title.seasons, 2, 0, null), totalEpisodes: 10 },
      "seasons-synced",
      { autoStatus: false },
    );
    const after = store.getTitle(title.id) as TitleV4;
    expect(after.rating).toBe(4.5);
    expect(after.notes).toBe("great finale");
    expect(sanitizeWatchedEpisodes(after)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — what the Upcoming row is now reporting
// ---------------------------------------------------------------------------

describe("W6-2 — the pending season is show status, not homework", () => {
  it("names the next season that has not started airing", () => {
    expect(detectPendingSeason(details(), NOW)).toEqual({ number: 2, episodes: 0 });
  });

  it("carries the premiere date once upstream sets one", () => {
    const dated = details({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-09-01" },
      ],
    });
    expect(detectPendingSeason(dated, NOW)).toEqual({
      number: 2,
      episodes: 8,
      airDate: "2026-09-01",
    });
  });

  it("reports the nearest unaired season, not the furthest out", () => {
    const two = details({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-09-01" },
        { seasonNumber: 3, name: "Season 3", episodeCount: 0, airDate: null },
      ],
    });
    expect(detectPendingSeason(two, NOW)?.number).toBe(2);
  });

  it("says nothing once the season has started airing", () => {
    const airing = details({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-07-01" },
      ],
      lastEpisodeToAir: { seasonNumber: 2, episodeNumber: 3, airDate: "2026-08-01" },
    });
    expect(detectPendingSeason(airing, NOW)).toBeUndefined();
  });

  it("puts the pending season on the airing cache", () => {
    const cache = computeAiring(show(), details(), { now: NOW });
    expect(cache.pendingSeason).toEqual({ number: 2, episodes: 0 });
    // Still recorded for the auto-sync-off path, where it drives the add button.
    expect(cache.newSeasonDetected).toBe(2);
  });
});

describe("W6-2 — the Upcoming row for a followed show", () => {
  const tracked = show({
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 0, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
    ],
  });

  it("reports the season without nagging once it has been adopted", () => {
    const entries = buildUpcomingEntries(
      [{ ...tracked, airing: computeAiring(tracked, details(), { now: NOW }) }],
      NOW,
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("season");
    expect(entry?.label).toBe("Season 2");
    expect(entry?.tracked).toBe(true);
    expect(entry?.detail).toBe("");
    expect(entry?.detail).not.toContain("not on your tracker");
    expect(formatCountdown(entry?.daysUntil ?? null)).toBe("date TBA");
  });

  it("shows the premiere date and the episode count once upstream has them", () => {
    const dated = details({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-09-01" },
      ],
    });
    const entries = buildUpcomingEntries(
      [{ ...tracked, airing: computeAiring(tracked, dated, { now: NOW }) }],
      NOW,
    );
    expect(entries[0]?.date).toBe("2026-09-01");
    expect(entries[0]?.detail).toBe("8 episodes announced");
    expect(entries[0]?.tracked).toBe(true);
  });

  it("keeps the nag only where it is still true — auto-sync off", () => {
    const notAdopted = show(); // season 2 never added
    const entries = buildUpcomingEntries(
      [{ ...notAdopted, airing: computeAiring(notAdopted, details(), { now: NOW }) }],
      NOW,
    );
    expect(entries[0]?.tracked).toBe(false);
    expect(entries[0]?.detail).toContain("not on your tracker yet");
  });

  it("hands over to the normal episode rows once the season is airing", () => {
    const airingNow = details({
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2025-07-13" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2026-08-01" },
      ],
      nextEpisodeToAir: { seasonNumber: 2, episodeNumber: 2, airDate: "2026-08-08", name: "Blood Money" },
      lastEpisodeToAir: { seasonNumber: 2, episodeNumber: 1, airDate: "2026-08-01" },
    });
    const entries = buildUpcomingEntries(
      [{ ...tracked, airing: computeAiring(tracked, airingNow, { now: NOW }) }],
      NOW,
    );
    expect(entries.map((e) => e.kind)).toEqual(["episode"]);
    expect(entries[0]?.label).toBe("S02E02");
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — a title that says it is one thing and is another
// ---------------------------------------------------------------------------

describe("W6-4 — media type is authoritative, display type is repaired", () => {
  /** The vault's actual pre-B2 chimera. */
  const chimera = (): TitleV4 =>
    createTitle({
      id: "spider-man",
      title: "Spider-Man",
      type: "TV Show", // wrong: it is the 2002 film
      tmdbId: 557,
      tmdbMediaType: "movie",
      totalEpisodes: 1,
      episodeDuration: 121,
      releaseDate: "2002-05-01",
      seasons: [],
    });

  const types = [
    { name: "Anime", color: "" },
    { name: "Movie", color: "" },
    { name: "TV Show", color: "" },
  ];

  const movieDetails = (overrides: Partial<OverseerrDetails> = {}): OverseerrDetails => ({
    ...details({ mediaType: "movie" }),
    tmdbId: 557,
    title: "Spider-Man",
    releaseDate: "2002-05-01",
    runtime: 121,
    seasons: undefined,
    showStatus: undefined,
    nextEpisodeToAir: null,
    lastEpisodeToAir: null,
    ...overrides,
  });

  it("knows which display types belong to which media kind", () => {
    expect(typeFamilyOf("Movie")).toBe("movie");
    expect(typeFamilyOf("TV Show")).toBe("tv");
    expect(typeFamilyOf("Anime")).toBe("tv");
    expect(typeFamilyOf("Korean TV Show")).toBe("tv");
  });

  it("does not accept a 200 as proof — ids are only unique per namespace", () => {
    const title = chimera();
    // `/movie/557` really is this title.
    expect(identityMatches(title, movieDetails())).toBe(true);
    // `/tv/557` answers with something else entirely, and answering is not
    // agreeing: this is the whole reason the check exists.
    expect(
      identityMatches(title, movieDetails({ title: "Barbapapa", releaseDate: "1974-01-01" })),
    ).toBe(false);
  });

  it("rejects a same-name hit from the wrong decade", () => {
    const title = chimera();
    expect(identityMatches(title, movieDetails({ releaseDate: "2017-07-05" }))).toBe(false);
    // One year out is still the same film.
    expect(identityMatches(title, movieDetails({ releaseDate: "2003-01-01" }))).toBe(true);
  });

  it("repairs the display type of a film labelled as a series", () => {
    const repair = typeRepairFor(chimera(), types);
    expect(repair).toBeDefined();
    expect(repair?.from).toBe("TV Show");
    expect(repair?.to).toBe("Movie");
    expect(repair?.patch).toMatchObject({ type: "Movie", seasons: [], totalEpisodes: 1 });
  });

  it("gives a repaired film the shape QA1 B2 depends on — no synthetic season", () => {
    // A one-episode "Movie" season would put an episode grid on a film and
    // take its "Mark as watched" button away again.
    const withSeasons = createTitle({
      ...chimera(),
      seasons: [{ name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
      totalEpisodes: 8,
      watchedEpisodes: [1, 2, 3],
    });
    const repair = typeRepairFor(withSeasons, types);
    expect(repair?.patch.seasons).toEqual([]);
    expect(repair?.patch.totalEpisodes).toBe(1);
    // Something was watched, so the film stays watched.
    expect(repair?.patch.watchedEpisodes).toEqual([1]);
  });

  it("repairs the other direction too — a series labelled Movie", () => {
    const mislabelled = createTitle({
      id: "shrinking",
      title: "Shrinking",
      type: "Movie",
      tmdbId: 136311,
      tmdbMediaType: "tv",
      totalEpisodes: 10,
    });
    const repair = typeRepairFor(mislabelled, types);
    expect(repair?.to).toBe("Anime"); // the first configured episodic type
    // Seasons are left to the auto-sync pass rather than invented here.
    expect(repair?.patch.seasons).toBeUndefined();
  });

  it("leaves a title whose types already agree completely alone", () => {
    expect(typeRepairFor(show(), types)).toBeUndefined(); // TV Show + tv
    const film = createTitle({
      id: "anora",
      title: "Anora",
      type: "Movie",
      tmdbMediaType: "movie",
    });
    expect(typeRepairFor(film, types)).toBeUndefined();
    // And a title with no media type at all is not guessed about.
    expect(typeRepairFor(createTitle({ id: "x", title: "X", type: "TV Show" }), types)).toBeUndefined();
  });

  it("is migration-safe: a repaired film keeps its own fields", () => {
    const title = createTitle({ ...chimera(), rating: 5, notes: "childhood favourite", tags: ["rewatch"] });
    const repair = typeRepairFor(title, types);
    expect(repair?.patch).not.toHaveProperty("rating");
    expect(repair?.patch).not.toHaveProperty("notes");
    expect(repair?.patch).not.toHaveProperty("tags");
    expect(repair?.patch).not.toHaveProperty("status");
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — what a multi-season card says
// ---------------------------------------------------------------------------

describe("W6-5 — multi-season context on the card", () => {
  const twoSeasons = (overrides: Partial<TitleV4> = {}): TitleV4 =>
    show({
      status: "Watching",
      totalEpisodes: 18,
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 8, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
      ...overrides,
    });

  it("counts progress across every season, not per season", () => {
    expect(progressText(twoSeasons())).toBe("10 / 18");
  });

  it("says where you are, with the season's own number", () => {
    expect(nextUpText(twoSeasons())).toBe("S02E01 next");
    // A tracker holding only seasons 2–3 must not claim S01E01.
    const later = show({
      status: "Watching",
      totalEpisodes: 20,
      watchedEpisodes: [],
      seasons: [
        { name: "Season 2", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 10, offset: 10, skippedEpisodes: [], seasonNumber: 3 },
      ],
    });
    expect(nextUpText(later)).toBe("S02E01 next");
  });

  it("says nothing for a film or a single-season show", () => {
    expect(nextUpText(createTitle({ id: "m", title: "M", type: "Movie" }))).toBe("");
    expect(nextUpText(show({ status: "Watching", watchedEpisodes: [] }))).toBe("");
  });

  it("badges a finished show that has grown a season — and only that", () => {
    // The case fix 3 refuses to handle by rewriting the status.
    const grown = twoSeasons({ status: "Completed" });
    expect(hasUnwatchedNewSeason(grown)).toBe(true);

    // Part-way through is not "new season", it is just watching.
    expect(hasUnwatchedNewSeason(twoSeasons())).toBe(false);
    // Finished and nothing new: nothing to say.
    expect(
      hasUnwatchedNewSeason(
        twoSeasons({ status: "Completed", watchedEpisodes: Array.from({ length: 18 }, (_, i) => i + 1) }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repair — a structure that was wrong when it was written
// ---------------------------------------------------------------------------

describe("rebuilding a season structure from upstream", () => {
  /** What a flattened import looks like: one "season" holding every episode. */
  const flattened = () =>
    show({
      title: "Reacher",
      totalEpisodes: 32,
      seasons: [{ name: "Season 1", episodes: 32, offset: 0, skippedEpisodes: [] }],
      watchedEpisodes: Array.from({ length: 24 }, (_, i) => i + 1),
    });

  const fourSeasons = () =>
    details({
      numberOfSeasons: 4,
      numberOfEpisodes: 32,
      seasons: [
        { seasonNumber: 1, name: "Season 1", episodeCount: 8, airDate: "2022-02-03" },
        { seasonNumber: 2, name: "Season 2", episodeCount: 8, airDate: "2023-12-15" },
        { seasonNumber: 3, name: "Season 3", episodeCount: 8, airDate: "2025-02-20" },
        { seasonNumber: 4, name: "Season 4", episodeCount: 8, airDate: "2026-08-12" },
      ],
    });

  it("replaces one fake season with the real ones", () => {
    const plan = seasonRebuildPlan(flattened(), fourSeasons());
    expect(plan).not.toBeNull();
    expect(plan?.seasons.map((s) => [s.seasonNumber, s.episodes, s.offset])).toEqual([
      [1, 8, 0],
      [2, 8, 8],
      [3, 8, 16],
      [4, 8, 24],
    ]);
    expect(plan?.totalEpisodes).toBe(32);
  });

  it("leaves watched progress meaning the same thing", () => {
    // The whole safety argument: episode 24 is the last episode of season 3
    // before the repair and after it, because absolute numbering is preserved.
    const plan = seasonRebuildPlan(flattened(), fourSeasons());
    const seasons = plan?.seasons ?? [];
    const season3 = seasons[2];
    expect((season3?.offset ?? 0) + (season3?.episodes ?? 0)).toBe(24);
  });

  it("says nothing when the structure already matches", () => {
    const correct = show({
      seasons: [
        { name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 8, offset: 8, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 8, offset: 16, skippedEpisodes: [], seasonNumber: 3 },
        { name: "Season 4", episodes: 8, offset: 24, skippedEpisodes: [], seasonNumber: 4 },
      ],
    });
    expect(seasonRebuildPlan(correct, fourSeasons())).toBeNull();
  });

  it("carries a user's skipped episodes across for a season that survives", () => {
    const withSkips = show({
      seasons: [
        { name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [3], seasonNumber: 1 },
        { name: "Season 2", episodes: 24, offset: 8, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });
    const plan = seasonRebuildPlan(withSkips, fourSeasons());
    expect(plan?.seasons[0]?.skippedEpisodes).toEqual([3]);
  });

  it("refuses to touch a film", () => {
    expect(seasonRebuildPlan(flattened(), details({ mediaType: "movie" }))).toBeNull();
  });

  it("ignores specials, which the tracker has never counted", () => {
    const withSpecials = details({
      seasons: [
        { seasonNumber: 0, name: "Specials", episodeCount: 5, airDate: null },
        { seasonNumber: 1, name: "Season 1", episodeCount: 8, airDate: "2022-02-03" },
      ],
    });
    const plan = seasonRebuildPlan(flattened(), withSpecials);
    expect(plan?.seasons.map((s) => s.seasonNumber)).toEqual([1]);
  });
});

describe("a repair must not cost the user their progress", () => {
  it("keeps every watched episode when one fake season becomes four real ones", () => {
    // The live failure: Reacher stored as 1x32 with episodes 1-24 watched.
    // Rebasing read 24 as "season 1, episode 24", found the new season 1 only
    // has 8, and threw 16 episodes of progress away.
    const store = new WatchLogStore(fakePlugin() as never);
    const title = createTitle({ id: "reacher", title: "Reacher", type: "TV Show" });
    title.seasons = [{ name: "Season 1", episodes: 32, offset: 0, skippedEpisodes: [] }];
    title.totalEpisodes = 32;
    title.watchedEpisodes = Array.from({ length: 24 }, (_, i) => i + 1);
    store.data.titles.push(title);
    rememberSeasonGeometry(title);

    const seasons = [1, 2, 3, 4].map((n) => ({
      name: `Season ${n}`,
      episodes: 8,
      offset: (n - 1) * 8,
      skippedEpisodes: [],
      seasonNumber: n,
    }));
    store.updateTitle("reacher", { seasons, totalEpisodes: 32 }, "seasons-repaired", {
      autoStatus: false,
      preserveAbsoluteEpisodes: true,
    });

    const after = store.getTitle("reacher");
    expect(after?.watchedEpisodes).toHaveLength(24);
    expect(after?.watchedEpisodes[23]).toBe(24);
    expect(getWatchedCount(after as TitleV4)).toBe(24);
  });

  it("still rebases when a season genuinely grows, which is the other case", () => {
    const store = new WatchLogStore(fakePlugin() as never);
    const title = createTitle({ id: "show", title: "Show", type: "TV Show" });
    title.seasons = [
      { name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 8, offset: 8, skippedEpisodes: [], seasonNumber: 2 },
    ];
    title.totalEpisodes = 16;
    title.watchedEpisodes = [9]; // season 2, episode 1
    store.data.titles.push(title);
    rememberSeasonGeometry(title);

    // Season 1 turns out to have 10 episodes, so season 2 starts two later —
    // and "season 2 episode 1" must follow it to 11.
    store.updateTitle(
      "show",
      {
        seasons: [
          { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
          { name: "Season 2", episodes: 8, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
        ],
        totalEpisodes: 18,
      },
      "season-length-filled",
      { autoStatus: false },
    );
    expect(store.getTitle("show")?.watchedEpisodes).toEqual([11]);
  });
});
