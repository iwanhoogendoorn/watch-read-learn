/**
 * Writing the plan, and looking up what the file could not name.
 *
 * The plan tests prove the *decisions* are safe. This one proves the decisions
 * survive contact with the store — that a merge really does reach `updateTitle`
 * with the auto-status rules held off, that an added title gets an id nothing
 * else is using, and that running the same import twice leaves the library
 * exactly where the first run left it.
 *
 * The second half pins the id contract, which is a *deliberate absence*. The
 * importer writes the ids the export itself supplied — exact and free — and
 * writes nothing at all for the rest. Searching for them is
 * `integration.ts:backfillTmdbIds`'s job, it already runs over every title
 * lacking a `tmdbId` on every catch-up, and it is the stricter path: an answer
 * it is not sure about becomes `tmdbMatch: "ambiguous"` and surfaces the manual
 * picker. A second search here would have produced ids with no record that they
 * were ever in doubt.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WatchLogStore } from "../src/data/store";
import { createDefaultData, createDefaultSettings, createTitle } from "../src/data/schema";
import { applyTrackerPlan } from "../src/domains/import/apply";
import { buildTrackerPlan } from "../src/domains/import/plan";
import { parseLetterboxd, parseTrakt } from "../src/domains/import/sources";
import { needsTmdbBackfill } from "../src/services/match";
import { installDomGlobals } from "./helpers/dom";
import { letterboxdFiles, traktFiles } from "./fixtures/trackers";
import type { Settings, TitleV4 } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals();
});

afterEach(() => {
  restore();
});

async function emptyStore(seed: readonly TitleV4[] = []) {
  const data = createDefaultData();
  data.titles = [...seed];
  const store = new WatchLogStore({
    loadData: async () => JSON.parse(JSON.stringify(data)) as unknown,
    saveData: async () => undefined,
  } as never);
  await store.load();
  return store;
}

const SETTINGS: Settings = createDefaultSettings();

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

describe("applyTrackerPlan", () => {
  it("adds every planned title, with ids nothing else is using", async () => {
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    const plan = buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS);

    const result = await applyTrackerPlan(store, plan);
    expect(result.added).toBe(4);
    expect(store.allTitles()).toHaveLength(4);
    const ids = store.allTitles().map((title) => title.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("fixture-rain");
  });

  it("does not collide with an id the library already uses", async () => {
    // Something unrelated is already called `fixture-rain`.
    const store = await emptyStore([createTitle({ id: "fixture-rain", title: "Other Thing", type: "Movie" })]);
    const parsed = parseTrakt(traktFiles());
    const plan = buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS);
    await applyTrackerPlan(store, plan);
    expect(store.getTitle("fixture-rain")?.title).toBe("Other Thing");
    expect(store.getTitle("fixture-rain-2")?.title).toBe("Fixture Rain");
  });

  it("merges into an existing title without touching what the user wrote", async () => {
    const loved = createTitle({
      id: "fixture-signal",
      title: "Fixture Signal",
      type: "TV Show",
      status: "Watching",
      rating: 5,
      review: "Awesome",
      notes: "Watch the pilot twice.",
      favorite: true,
      tmdbId: 4242,
      tmdbMediaType: "tv",
      seasons: [
        { name: "Season 1", episodes: 6, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 6, offset: 6, skippedEpisodes: [], seasonNumber: 2 },
      ],
      totalEpisodes: 12,
      watchedEpisodes: [9],
    });
    const store = await emptyStore([loved]);
    const parsed = parseTrakt(traktFiles());
    const plan = buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS);
    const result = await applyTrackerPlan(store, plan);

    expect(result.merged).toBe(1);
    const after = store.getTitle("fixture-signal");
    expect(after?.rating).toBe(5);
    expect(after?.review).toBe("Awesome");
    expect(after?.notes).toBe("Watch the pilot twice.");
    expect(after?.favorite).toBe(true);
    expect(after?.status).toBe("Watching");
    // Episode 9 survives, and the two the file knew about are added.
    expect(after?.watchedEpisodes).toEqual([1, 2, 9]);
    // The real season list is not replaced by one derived from watch history.
    expect(after?.seasons.map((season) => season.episodes)).toEqual([6, 6]);
  });

  it("does not let an import flip a status behind the user's back", async () => {
    // A Dropped show whose every episode arrives in the file must stay Dropped:
    // the auto-complete rules exist for the user ticking a last episode, not for
    // a file landing on top of them.
    const dropped = createTitle({
      id: "d",
      title: "Fixture Signal",
      type: "TV Show",
      status: "Dropped",
      tmdbId: 4242,
      tmdbMediaType: "tv",
      seasons: [{ name: "Season 1", episodes: 2, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
      totalEpisodes: 2,
    });
    const store = await emptyStore([dropped]);
    const parsed = parseTrakt(traktFiles());
    const plan = buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS);
    await applyTrackerPlan(store, plan);

    const after = store.getTitle("d");
    expect(after?.watchedEpisodes).toEqual([1, 2]);
    expect(after?.status).toBe("Dropped");
    expect(after?.dateFinished).toBeNull();
  });

  it("is a no-op the second time, so trying it is safe", async () => {
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    await applyTrackerPlan(
      store,
      buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS),
    );
    const snapshot = JSON.stringify(store.allTitles().map((title) => ({ ...title, dateModified: "" })));

    const second = await applyTrackerPlan(
      store,
      buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS),
    );
    expect(second.added).toBe(0);
    expect(second.merged).toBe(0);
    expect(store.allTitles()).toHaveLength(4);
    expect(JSON.stringify(store.allTitles().map((title) => ({ ...title, dateModified: "" })))).toBe(snapshot);
  });

  it("stops where it is told to and keeps what it wrote", async () => {
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    const plan = buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS);

    let written = 0;
    const result = await applyTrackerPlan(store, plan, {
      chunk: 1,
      isCancelled: () => written++ >= 2,
    });
    expect(result.cancelled).toBe(true);
    expect(store.allTitles().length).toBeGreaterThan(0);
    expect(store.allTitles().length).toBeLessThan(4);
  });

  it("writes one activity entry rather than one per title", async () => {
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    const before = store.data.history.length;
    await applyTrackerPlan(
      store,
      buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS),
    );
    const added = store.data.history.slice(before);
    expect(added.filter((entry) => entry.message.startsWith("Imported"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ids: what the importer writes, and what it deliberately leaves undone
// ---------------------------------------------------------------------------

describe("the ids an import writes", () => {
  it("writes the ids the export supplied, so no search is needed for them", async () => {
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    await applyTrackerPlan(
      store,
      buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS),
    );

    const rain = store.allTitles().find((title) => title.title === "Fixture Rain");
    expect(rain?.tmdbId).toBe(4243);
    expect(rain?.tmdbMediaType).toBe("movie");
    expect(needsTmdbBackfill(rain as TitleV4)).toBe(false);
  });

  it("keeps an IMDb-only entry's id rather than throwing it away", async () => {
    // Trakt's Fixture Orphan has an IMDb id and no TMDB one. The id is exact,
    // the Plex GUID index reads `imdb://tt…` directly, and the backfill can
    // resolve the rest — so it is written even though it is not the key.
    const store = await emptyStore();
    const parsed = parseTrakt(traktFiles());
    await applyTrackerPlan(
      store,
      buildTrackerPlan("trakt", parsed.records, store.allTitles(), SETTINGS),
    );

    const orphan = store.allTitles().find((title) => title.title === "Fixture Orphan");
    expect(orphan?.imdbId).toBe("tt1000009");
    expect(orphan?.tmdbId).toBeUndefined();
  });

  it("leaves a name-only title for the backfill, and never guesses one itself", async () => {
    // Letterboxd carries no ids at all. Every one of its titles must arrive
    // needing a backfill — that is the handover, and it is what makes the
    // manual picker reachable for the ones TMDB cannot settle.
    const store = await emptyStore();
    const parsed = parseLetterboxd(letterboxdFiles());
    await applyTrackerPlan(
      store,
      buildTrackerPlan("letterboxd", parsed.records, store.allTitles(), SETTINGS),
    );

    expect(store.allTitles()).toHaveLength(3);
    for (const title of store.allTitles()) {
      expect(title.tmdbId).toBeUndefined();
      expect(needsTmdbBackfill(title)).toBe(true);
      // And nothing pretends a search already happened and failed.
      expect(title.tmdbMatch).toBeUndefined();
    }
  });

  it("never writes a tmdbMatch verdict of its own", async () => {
    // `tmdbMatch` is the backfill's record of *why* a title has no id. An
    // importer writing one would be claiming a search it never ran.
    const store = await emptyStore();
    const parsed = parseLetterboxd(letterboxdFiles());
    const plan = buildTrackerPlan("letterboxd", parsed.records, store.allTitles(), SETTINGS);
    for (const entry of plan.entries) expect(entry.newTitle?.tmdbMatch).toBeUndefined();
  });
});
