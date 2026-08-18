/**
 * The plan, and the promise the whole feature rests on.
 *
 * **Importing a title you already have must not cost you anything.** Not the
 * rating you gave it, not the review, not the note, not an episode you ticked
 * off in the plugin and never logged on the tracker. A merge may fill a gap and
 * add an episode; it may not replace a value or remove one. Every branch of
 * `mergePatch` is guarded for that, and the test below is the one that would
 * catch it if a later change stopped being careful.
 *
 * The second half is matching, where the failure mode is quieter: a name match
 * onto the wrong film produces a library that looks fine and is subtly not the
 * one the user has. So ids win, and a name match is refused when either side's
 * id contradicts it.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import {
  buildTitle,
  buildTrackerPlan,
  deriveSeasons,
  expandEpisodes,
  indexLibrary,
  matchRecord,
  mergePatch,
  resolveStatusName,
  resolveTypeName,
  toAbsolute,
} from "../src/domains/import/plan";
import { parseSimkl, parseTrakt } from "../src/domains/import/sources";
import { SIMKL_BACKUP, traktFiles } from "./fixtures/trackers";
import type { ImportRecord } from "../src/domains/import/types";
import type { Season, Settings, TitleV4 } from "../src/types";

const SETTINGS: Settings = createDefaultSettings();

function seasons(...lengths: number[]): Season[] {
  let offset = 0;
  return lengths.map((episodes, index) => {
    const season: Season = {
      name: `Season ${index + 1}`,
      episodes,
      offset,
      skippedEpisodes: [],
      seasonNumber: index + 1,
    };
    offset += episodes;
    return season;
  });
}

/** A show the user has already been living with: rated, reviewed, annotated. */
function lovedShow(): TitleV4 {
  return createTitle({
    id: "fixture-signal",
    title: "Fixture Signal",
    type: "TV Show",
    status: "Watching",
    rating: 5,
    review: "Awesome",
    notes: "Watch the pilot twice.",
    favorite: true,
    tags: ["rewatch"],
    priority: "High",
    year: 2016,
    tmdbId: 4242,
    tmdbMediaType: "tv",
    seasons: seasons(6, 6),
    totalEpisodes: 12,
    // Episode 9 — S02E03 — is one the user ticked off here and never logged.
    watchedEpisodes: [9],
    dateStarted: "2020-01-01",
  });
}

// ---------------------------------------------------------------------------
// The settings vocabulary
// ---------------------------------------------------------------------------

describe("resolving names against the user's settings", () => {
  it("uses the configured status names, not hardcoded ones", () => {
    expect(resolveStatusName("completed", SETTINGS.statuses)).toBe("Completed");
    expect(resolveStatusName("planned", SETTINGS.statuses)).toBe("Plan to watch");
    expect(resolveStatusName("dropped", SETTINGS.statuses)).toBe("Dropped");
  });

  it("falls back to Watching for on-hold, which v4 has no name for", () => {
    expect(resolveStatusName("on-hold", SETTINGS.statuses)).toBe("Watching");
  });

  it("uses a custom on-hold status when the user has added one", () => {
    const custom = [...SETTINGS.statuses, { name: "On hold", color: "#000" }];
    expect(resolveStatusName("on-hold", custom)).toBe("On hold");
  });

  it("survives a renamed status list rather than writing a name nothing renders", () => {
    const renamed = [
      { name: "Seen it", color: "#1" },
      { name: "Queued up", color: "#2" },
    ];
    expect(renamed.map((entry) => entry.name)).toContain(resolveStatusName("completed", renamed));
    expect(renamed.map((entry) => entry.name)).toContain(resolveStatusName("planned", renamed));
  });

  it("maps a media kind onto a configured type", () => {
    expect(resolveTypeName("movie", SETTINGS.types, "Anime")).toBe("Movie");
    expect(resolveTypeName("tv", SETTINGS.types, "Anime")).not.toBe("Movie");
  });
});

// ---------------------------------------------------------------------------
// Season geometry
// ---------------------------------------------------------------------------

describe("deriveSeasons", () => {
  it("makes each season as long as the highest episode watched in it", () => {
    const record: ImportRecord = {
      source: "trakt",
      title: "X",
      mediaType: "tv",
      episodes: [
        { season: 1, episode: 3 },
        { season: 2, episode: 1 },
      ],
    };
    expect(deriveSeasons(record).map((season) => [season.seasonNumber, season.episodes, season.offset])).toEqual([
      [1, 3, 0],
      [2, 1, 3],
    ]);
  });

  it("grows the LAST season to reach a stated aired count", () => {
    // Growing an earlier one would move every absolute number after it — and
    // the watched episodes being written in the same breath are those numbers.
    const record: ImportRecord = {
      source: "trakt",
      title: "X",
      mediaType: "tv",
      airedEpisodes: 12,
      episodes: [
        { season: 1, episode: 2 },
        { season: 2, episode: 1 },
      ],
    };
    const derived = deriveSeasons(record);
    expect(derived.map((season) => season.episodes)).toEqual([2, 10]);
    expect(derived.map((season) => season.offset)).toEqual([0, 2]);
    // S01E02 is still absolute 2 and S02E01 is still absolute 3.
    expect(toAbsolute(derived, { season: 1, episode: 2 })).toBe(2);
    expect(toAbsolute(derived, { season: 2, episode: 1 })).toBe(3);
  });

  it("has nothing to derive from a record with no episodes", () => {
    expect(deriveSeasons({ source: "imdb", title: "X", mediaType: "tv" })).toEqual([]);
  });
});

describe("expandEpisodes", () => {
  it("takes an event list literally, gaps and all", () => {
    // Trakt logs what was watched. A gap is a gap, and filling it in would
    // invent watches the user never had.
    const record: ImportRecord = {
      source: "trakt",
      title: "X",
      episodes: [
        { season: 1, episode: 1 },
        { season: 1, episode: 5 },
      ],
    };
    expect(expandEpisodes(record, seasons(6, 6)).absolute).toEqual([1, 5]);
  });

  it("expands a high-water mark into everything up to it", () => {
    // Simkl says "last watched S02E03" and means the first nine episodes.
    const record: ImportRecord = {
      source: "simkl",
      title: "X",
      episodes: [{ season: 2, episode: 3 }],
      progressIsHighWaterMark: true,
    };
    expect(expandEpisodes(record, seasons(6, 6)).absolute).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("says so when a high-water mark can only be applied from its own season", () => {
    // A show being created from this same file has no seasons 1 and 2 to
    // expand into, so what is claimed is only what can be justified.
    const record: ImportRecord = {
      source: "simkl",
      title: "X",
      mediaType: "tv",
      episodes: [{ season: 3, episode: 4 }],
      progressIsHighWaterMark: true,
    };
    const derived = deriveSeasons(record);
    const expanded = expandEpisodes(record, derived);
    expect(expanded.absolute).toEqual([1, 2, 3, 4]);
    expect(expanded.partialHighWaterMark).toBe(true);
  });

  it("counts, rather than mangles, an episode no season can hold", () => {
    const record: ImportRecord = {
      source: "trakt",
      title: "X",
      episodes: [
        { season: 1, episode: 1 },
        { season: 9, episode: 1 },
      ],
    };
    const expanded = expandEpisodes(record, seasons(6));
    expect(expanded.absolute).toEqual([1]);
    expect(expanded.dropped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("matchRecord", () => {
  const library = [
    createTitle({ id: "a", title: "Fixture Rain", type: "Movie", year: 2019, tmdbId: 4243, tmdbMediaType: "movie" }),
    createTitle({ id: "b", title: "Fixture Orphan", type: "Movie", year: 1974, imdbId: "tt1000009" }),
    createTitle({ id: "c", title: "Nameless Year Film", type: "Movie", year: 2011 }),
  ];
  const index = indexLibrary(library);

  it("matches on a TMDB id before anything else", () => {
    const hit = matchRecord({ source: "simkl", title: "Totally Different Name", tmdbId: 4243 }, index);
    expect(hit?.title.id).toBe("a");
    expect(hit?.by).toBe("tmdbId");
  });

  it("matches on an IMDb id when there is no TMDB one", () => {
    const hit = matchRecord({ source: "trakt", title: "Whatever", imdbId: "tt1000009" }, index);
    expect(hit?.title.id).toBe("b");
    expect(hit?.by).toBe("imdbId");
  });

  it("matches by name when the years agree", () => {
    const hit = matchRecord({ source: "letterboxd", title: "fixture  rain", year: 2019 }, index);
    expect(hit?.title.id).toBe("a");
    expect(hit?.by).toBe("title");
  });

  it("refuses a name match when the years contradict each other", () => {
    // Same name, thirty years apart: a remake, not the same film.
    expect(matchRecord({ source: "letterboxd", title: "Fixture Rain", year: 1989 }, index)).toBeUndefined();
  });

  it("refuses a name match when the ids contradict each other", () => {
    const hit = matchRecord({ source: "simkl", title: "Fixture Rain", year: 2019, tmdbId: 999 }, index);
    expect(hit).toBeUndefined();
  });

  it("refuses to match a film onto a show, TMDB ids being per-namespace", () => {
    // Id 557 is Spider-Man as a film and something else entirely as a series.
    const shows = indexLibrary([
      createTitle({ id: "s", title: "Ambiguous", type: "TV Show", tmdbId: 557, tmdbMediaType: "tv" }),
    ]);
    expect(matchRecord({ source: "ryot", title: "Ambiguous", tmdbId: 557, mediaType: "movie" }, shows)).toBeUndefined();
  });

  it("matches a year-less record by name alone, which is all Letterboxd gives", () => {
    const hit = matchRecord({ source: "letterboxd", title: "Nameless Year Film" }, index);
    expect(hit?.title.id).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// Merging — the promise
// ---------------------------------------------------------------------------

describe("mergePatch never clobbers the user's own data", () => {
  const incoming: ImportRecord = {
    source: "trakt",
    title: "Fixture Signal",
    year: 2016,
    mediaType: "tv",
    status: "completed",
    rating: 2,
    notes: "imported note",
    dateStarted: "2024-06-18",
    dateFinished: "2024-06-20",
    tmdbId: 4242,
    imdbId: "tt1000002",
    episodes: [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ],
  };

  it("leaves a rating the user gave alone", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.rating).toBeUndefined();
  });

  it("leaves the review, favourite, tags and priority entirely alone", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.review).toBeUndefined();
    expect(patch.favorite).toBeUndefined();
    expect(patch.tags).toBeUndefined();
    expect(patch.priority).toBeUndefined();
  });

  it("leaves a note the user wrote alone", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.notes).toBeUndefined();
  });

  it("adds watched episodes without removing the ones already ticked", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    // 9 is the one the user ticked in the plugin and never logged on Trakt.
    expect(patch.watchedEpisodes).toEqual([1, 2, 9]);
  });

  it("leaves a date the user already set alone", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.dateStarted).toBeUndefined();
    expect(patch.dateFinished).toBe("2024-06-20");
  });

  it("does not move a status away from anything but the default", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.status).toBeUndefined();
  });

  it("does move a status off the untouched default", () => {
    const untouched = createTitle({
      id: "x",
      title: "Fixture Signal",
      type: "TV Show",
      status: "Plan to watch",
    });
    const { patch } = mergePatch(untouched, incoming, SETTINGS);
    expect(patch.status).toBe("Completed");
  });

  it("does not overwrite a real season list with one derived from watch history", () => {
    const { patch } = mergePatch(lovedShow(), incoming, SETTINGS);
    expect(patch.seasons).toBeUndefined();
    expect(patch.totalEpisodes).toBeUndefined();
  });

  it("does give seasons to a title that has none", () => {
    const bare = createTitle({ id: "y", title: "Fixture Signal", type: "TV Show" });
    const { patch } = mergePatch(bare, { ...incoming, airedEpisodes: 12 }, SETTINGS);
    expect(patch.seasons?.map((season) => season.episodes)).toEqual([12]);
    expect(patch.totalEpisodes).toBe(12);
  });

  it("fills in the ids the library was missing", () => {
    const noIds = createTitle({ id: "z", title: "Fixture Signal", type: "TV Show" });
    const { patch } = mergePatch(noIds, incoming, SETTINGS);
    expect(patch.tmdbId).toBe(4242);
    expect(patch.tmdbMediaType).toBe("tv");
    expect(patch.imdbId).toBe("tt1000002");
  });

  it("does not repoint an id the library already has", () => {
    const owned = createTitle({ id: "z", title: "Fixture Signal", type: "TV Show", tmdbId: 111 });
    const { patch } = mergePatch(owned, incoming, SETTINGS);
    expect(patch.tmdbId).toBeUndefined();
  });

  it("fills in an unrated title, since 0 is this plugin's 'no opinion'", () => {
    const unrated = createTitle({ id: "z", title: "Fixture Signal", type: "TV Show", rating: 0 });
    const { patch } = mergePatch(unrated, incoming, SETTINGS);
    expect(patch.rating).toBe(2);
  });

  it("reports every field it would touch, so the preview can say", () => {
    const bare = createTitle({ id: "y", title: "Fixture Signal", type: "TV Show" });
    const { changes } = mergePatch(bare, incoming, SETTINGS);
    expect(changes.join(" ")).toContain("TMDB id 4242");
    expect(changes.join(" ")).toContain("watched episode");
  });
});

// ---------------------------------------------------------------------------
// The whole plan
// ---------------------------------------------------------------------------

describe("buildTrackerPlan", () => {
  const trakt = parseTrakt(traktFiles());

  it("adds everything against an empty library", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [], SETTINGS, trakt.warnings);
    expect(plan.counts.add).toBe(4);
    expect(plan.counts.merge).toBe(0);
    expect(plan.entries.every((entry) => entry.newTitle !== undefined)).toBe(true);
  });

  it("merges rather than duplicates against a library that has them", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [lovedShow()], SETTINGS);
    const signal = plan.entries.find((entry) => entry.record.title === "Fixture Signal");
    expect(signal?.action).toBe("merge");
    expect(signal?.titleId).toBe("fixture-signal");
    expect(signal?.matchedBy).toBe("tmdbId");
    expect(plan.counts.add).toBe(3);
  });

  it("does not add the same work twice when two files describe it", () => {
    // Trakt's own records are already merged by its parser; two *sources* in one
    // run are the case this covers.
    const simkl = parseSimkl(SIMKL_BACKUP);
    const both = [...trakt.records, ...simkl.records];
    const plan = buildTrackerPlan("trakt", both, [], SETTINGS);
    const rains = plan.entries.filter((entry) => entry.record.title === "Fixture Rain");
    expect(rains).toHaveLength(2);
    // One creation, and a second entry that writes nothing of its own.
    expect(rains.map((entry) => entry.action)).toEqual(["add", "skip"]);
    expect(rains[1]?.mergedIntoPlanned).toBe(true);
    // Trakt's four, plus the one title only Simkl knows about.
    expect(plan.entries.filter((entry) => entry.action === "add")).toHaveLength(5);
  });

  it("folds the second source's extra facts into the title the first is creating", () => {
    // Trakt knows Fixture Signal but has no memo; Simkl has one. Importing both
    // must end with one title carrying both files' facts, not with Simkl ignored.
    const simkl = parseSimkl(SIMKL_BACKUP);
    const plan = buildTrackerPlan("trakt", [...trakt.records, ...simkl.records], [], SETTINGS);
    const created = plan.entries.find(
      (entry) => entry.action === "add" && entry.record.title === "Fixture Signal",
    );
    expect(created?.newTitle?.notes).toBe("Best one yet");
    const folded = plan.entries.find(
      (entry) => entry.mergedIntoPlanned === true && entry.record.source === "simkl" && entry.record.title === "Fixture Signal",
    );
    expect(folded?.changes.join(" ")).toContain("notes");
  });

  it("counts exact matches against name-only ones", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [], SETTINGS);
    // Everything in the Trakt fixture has a TMDB or IMDb id.
    expect(plan.counts.exact).toBe(4);
    expect(plan.counts.byName).toBe(0);
  });

  it("leaves an existing title completely alone when asked to", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [lovedShow()], SETTINGS, [], {
      skipExisting: true,
    });
    const signal = plan.entries.find((entry) => entry.record.title === "Fixture Signal");
    expect(signal?.action).toBe("skip");
    expect(signal?.patch).toBeUndefined();
  });

  it("marks a merge that would change nothing as a skip", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [], SETTINGS);
    const again = buildTrackerPlan(
      "trakt",
      trakt.records,
      plan.entries.flatMap((entry) => (entry.newTitle ? [entry.newTitle] : [])),
      SETTINGS,
    );
    // Re-importing the same file a second time is a no-op, which is what makes
    // "just try it and see" a safe thing to tell someone.
    expect(again.counts.add).toBe(0);
    expect(again.counts.merge).toBe(0);
    expect(again.counts.skip).toBe(4);
  });

  it("carries the parser's warnings through to the preview", () => {
    const plan = buildTrackerPlan("trakt", trakt.records, [], SETTINGS, trakt.warnings);
    expect(plan.warnings.join(" ")).toContain("IMDb id but no TMDB one");
  });
});

describe("buildTitle", () => {
  it("marks a watched film as watched, so it is not stuck at 0%", () => {
    const title = buildTitle(
      { source: "letterboxd", title: "Fixture Rain", year: 2019, mediaType: "movie", status: "completed" },
      SETTINGS,
      "fixture-rain",
    );
    expect(title.type).toBe("Movie");
    expect(title.status).toBe("Completed");
    expect(title.totalEpisodes).toBe(1);
    expect(title.watchedEpisodes).toEqual([1]);
  });

  it("gives a show the geometry its watch history implies", () => {
    const simkl = parseSimkl(SIMKL_BACKUP);
    const signal = simkl.records.find((record) => record.title === "Fixture Signal") as ImportRecord;
    const title = buildTitle(signal, SETTINGS, "fixture-signal");
    expect(title.seasons.map((season) => season.seasonNumber)).toEqual([3]);
    expect(title.watchedEpisodes).toEqual([1, 2, 3, 4]);
    expect(title.tmdbId).toBe(4242);
    expect(title.imdbId).toBe("tt1000002");
  });

  it("leaves an unrated record at this plugin's 'unrated', which is 0", () => {
    const title = buildTitle({ source: "imdb", title: "X", mediaType: "movie" }, SETTINGS, "x");
    expect(title.rating).toBe(0);
  });
});
