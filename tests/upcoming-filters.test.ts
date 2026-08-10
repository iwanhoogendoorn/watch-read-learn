/**
 * The Upcoming toolbar's model — facets, the time window, sorting, search and
 * the persisted view state.
 *
 * The fixtures deliberately contain the three awkward cases a schedule always
 * has and a naive filter always gets wrong: an entry with **no date** (an
 * announced season upstream has not scheduled), an entry in the **past** (aired
 * last week, still inside the seven-day tail), and rows from **all three
 * libraries** at once.
 */
import { describe, expect, it } from "vitest";
import {
  createBook,
  createDefaultSettings,
  createGame,
  createGamesSettings,
  createManga,
  createReadingSettings,
  createTitle,
} from "../src/data/schema";
import {
  buildUnifiedUpcoming,
  upcomingStateOf,
  type UnifiedRow,
} from "../src/domains/upcoming/unified";
import {
  applyUpcomingFilters,
  availabilityOf,
  buildUpcomingFacetSections,
  clearUpcomingFilters,
  createUpcomingFilterState,
  defaultUpcomingSort,
  excludedForUpcoming,
  fromUpcomingPreset,
  isUpcomingFilterActive,
  matchesUpcomingFilters,
  readUpcomingViewState,
  hasArrived,
  setExcludedForUpcoming,
  sortUpcomingRows,
  toUpcomingPreset,
  typeOf,
  watchStateOf,
  withinWindow,
  writeUpcomingViewState,
  type UpcomingFilterState,
  type UpcomingWindow,
} from "../src/domains/upcoming/filters";
import { UpcomingSearchEngine, parseUpcomingQuery } from "../src/domains/upcoming/query";
import { MediaStatus } from "../src/types";
import type { GamesData, ReadingData, Settings, TitleV4 } from "../src/types";

/** Fixed "now": Monday 3 August 2026, local time. */
const NOW = new Date(2026, 7, 3, 14, 30);

function reading(overrides: Partial<ReadingData> = {}): ReadingData {
  return {
    books: [],
    manga: [],
    bookColumns: [],
    mangaColumns: [],
    settings: createReadingSettings(),
    ...overrides,
  };
}

function games(list: GamesData["games"] = []): GamesData {
  return { games: list, groups: [], settings: createGamesSettings() };
}

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "show",
    title: overrides.title ?? "A Show",
    type: "TV Show",
    ...overrides,
  });
}

/**
 * The standing fixture: six rows, three libraries, every state.
 *
 *   Severance   watchlist  episode  in 2 days   on Plex
 *   Old News    watchlist  episode  3 days ago  not on Plex
 *   Dune 3      watchlist  release  in 60 days  queued for download
 *   Foundation  watchlist  season   no date     never scanned → not on Plex
 *   A Book      reading    release  in 5 days
 *   A Game      games      release  in 200 days
 */
function fixtureRows(): UnifiedRow[] {
  const titles: TitleV4[] = [
    show({
      id: "severance",
      title: "Severance",
      airing: {
        nextEpisode: { season: 2, episode: 3, airDate: "2026-08-05", name: "The Grid" },
        checkedAt: "2026-08-03T09:00:00.000Z",
      },
      plex: { state: "available" },
      favorite: true,
    }),
    show({
      id: "old",
      title: "Old News",
      airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
      plex: { state: "none" },
    }),
    show({
      id: "dune",
      title: "Dune 3",
      type: "Movie",
      releaseDate: "2026-10-02",
      request: { id: 7, status: 2 },
    }),
    show({
      id: "foundation",
      title: "Foundation",
      type: "",
      airing: { pendingSeason: { number: 4, episodes: 10 } },
    }),
  ];

  return buildUnifiedUpcoming(
    titles,
    reading({
      books: [
        createBook({ id: "book", title: "A Book", author: "An Author", releaseDate: "2026-08-08" }),
      ],
    }),
    games([
      createGame({
        id: "game",
        title: "A Game",
        status: "To be released",
        releaseDate: "2027-02-19",
      }),
    ]),
    { now: NOW },
  );
}

const names = (rows: readonly UnifiedRow[]): string[] => rows.map((row) => row.name);

describe("the fixture itself", () => {
  it("covers all three libraries, a past row and a dateless one", () => {
    const rows = fixtureRows();
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["watchlist", "reading", "games"]));
    expect(rows.find((r) => r.name === "Old News")?.daysUntil).toBe(-3);
    expect(rows.find((r) => r.name === "Foundation")?.daysUntil).toBeNull();
    expect(rows.find((r) => r.name === "Foundation")?.kind).toBe("season");
    expect(rows.find((r) => r.name === "A Book")?.kind).toBe("release");
  });
});

// ---------------------------------------------------------------------------
// The time window
// ---------------------------------------------------------------------------

describe("the time window", () => {
  const inWindow = (window: UpcomingWindow): string[] => {
    const state = createUpcomingFilterState();
    state.window = window;
    return names(applyUpcomingFilters(fixtureRows(), state, NOW));
  };

  it("shows everything by default, including the past and the dateless", () => {
    expect(createUpcomingFilterState().window).toBe("all");
    expect(inWindow("all")).toEqual(names(fixtureRows()));
    expect(inWindow("all")).toContain("Old News");
    expect(inWindow("all")).toContain("Foundation");
  });

  it("looks forward only — a forward window never includes what has aired", () => {
    expect(inWindow("7d")).toEqual(["Severance", "A Book"]);
    expect(inWindow("7d")).not.toContain("Old News");
  });

  it("widens as the window does", () => {
    expect(inWindow("30d")).toEqual(["Severance", "A Book"]);
    expect(inWindow("3m")).toEqual(["Severance", "A Book", "Dune 3"]);
  });

  it("reads “this year” as the calendar year, not the next 365 days", () => {
    // The game releases in Feb 2027 — inside twelve months, outside this year.
    expect(inWindow("year")).toEqual(["Severance", "A Book", "Dune 3"]);
    expect(inWindow("year")).not.toContain("A Game");
  });

  it("has a recently-released window for the backlog", () => {
    expect(inWindow("past")).toEqual(["Old News"]);
  });

  it("keeps an undated announcement out of every bounded window", () => {
    // It cannot be placed on a calendar, so no bounded window can claim it.
    for (const window of ["7d", "30d", "3m", "year", "past"] as UpcomingWindow[]) {
      expect(inWindow(window)).not.toContain("Foundation");
    }
    expect(withinWindow({ daysUntil: null, date: null }, "all")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe("facet filtering", () => {
  it("is an exclusion model — an empty state hides nothing", () => {
    const state = createUpcomingFilterState();
    expect(isUpcomingFilterActive(state)).toBe(false);
    expect(applyUpcomingFilters(fixtureRows(), state, NOW)).toHaveLength(6);
  });

  it("hides a whole library on demand", () => {
    const state = createUpcomingFilterState();
    state.excludedDomains = ["reading", "games"];
    expect(names(applyUpcomingFilters(fixtureRows(), state, NOW))).toEqual([
      "Old News",
      "Severance",
      "Dune 3",
      "Foundation",
    ]);
  });

  it("filters by event kind", () => {
    const state = createUpcomingFilterState();
    state.excludedKinds = ["release", "season"];
    expect(names(applyUpcomingFilters(fixtureRows(), state, NOW))).toEqual([
      "Old News",
      "Severance",
    ]);
  });

  it("filters by the same three states the header counts", () => {
    const rows = fixtureRows();
    expect(upcomingStateOf(rows.find((r) => r.name === "Old News")?.daysUntil ?? 0)).toBe("due");
    const state = createUpcomingFilterState();
    state.excludedStates = ["due", "announced"];
    expect(names(applyUpcomingFilters(rows, state, NOW))).toEqual([
      "Severance",
      "A Book",
      "Dune 3",
      "A Game",
    ]);
  });

  it("has three answers, each with an action behind it", () => {
    const rows = fixtureRows();
    const by = (name: string): string =>
      availabilityOf(rows.find((row) => row.name === name) as UnifiedRow);
    expect(by("Severance")).toBe("plex");
    expect(by("Old News")).toBe("not-plex");
    expect(by("Dune 3")).toBe("queued");
    // A scan that could not answer is filed with "not there yet", so the row
    // offers the one action that can change anything: request it.
    expect(by("Foundation")).toBe("not-plex");
    // Books and games are never on Plex.
    expect(by("A Book")).toBe("not-plex");
  });

  it("sees Radarr/Sonarr through Overseerr, with no request row at all", () => {
    // The real case: a show added straight to Sonarr. Overseerr's service scan
    // imported it, so `mediaInfo.status` is PROCESSING while `request.id` is
    // undefined and nobody ever pressed Request.
    const inSonarr = show({
      id: "sonarr",
      title: "In The Pipeline",
      airing: { nextEpisode: { season: 4, episode: 1, airDate: "2026-08-12" } },
      plex: { state: "unknown" },
      request: { mediaStatus: MediaStatus.PROCESSING, checkedAt: "2026-08-03T09:00:00.000Z" },
    });
    const row = buildUnifiedUpcoming([inSonarr], reading(), games(), {
      now: NOW,
    })[0] as UnifiedRow;
    expect(availabilityOf(row)).toBe("queued");
    // …and it is still not "requested" as far as the Library's own facet goes,
    // because no request row exists. Two different questions, two answers.
    expect(inSonarr.request?.id).toBeUndefined();
  });

  it("counts a request as queued only while something is still coming", () => {
    const make = (request: TitleV4["request"]): TitleV4 =>
      show({ id: "req", title: "Requested", releaseDate: "2026-08-09", request });
    const availability = (title: TitleV4): string =>
      availabilityOf(
        buildUnifiedUpcoming([title], reading(), games(), { now: NOW })[0] as UnifiedRow,
      );
    expect(availability(make({ id: 1, status: 1 }))).toBe("queued"); // pending
    expect(availability(make({ id: 1, status: 2 }))).toBe("queued"); // approved
    expect(availability(make({ id: 1, mediaStatus: MediaStatus.PROCESSING }))).toBe("queued");
    expect(availability(make({ mediaStatus: MediaStatus.PARTIALLY_AVAILABLE }))).toBe("queued");
    // Nothing is coming for these two, whatever the request row says.
    expect(availability(make({ id: 1, mediaStatus: MediaStatus.DELETED }))).toBe("not-plex");
    // Overseerr moved these integers between versions — the live server this was
    // built against reports 7 for a dropped title. Anything past AVAILABLE means
    // nothing is coming, whatever the release calls it.
    expect(availability(make({ id: 1, mediaStatus: 7 }))).toBe("not-plex");
    expect(availability(make({ mediaStatus: 6 }))).toBe("not-plex");
    expect(availability(make({ mediaStatus: MediaStatus.UNKNOWN }))).toBe("not-plex");
    // Declined and failed mean nothing is on the way — ask again.
    expect(availability(make({ id: 1, status: 3 }))).toBe("not-plex");
    expect(availability(make({ id: 1, status: 4 }))).toBe("not-plex");
    // Available means the Plex scan is the thing to believe, not the request.
    expect(availability(make({ id: 1, mediaStatus: MediaStatus.AVAILABLE }))).toBe("not-plex");
  });

  it("filters by availability", () => {
    const state = createUpcomingFilterState();
    state.excludedAvailability = ["plex", "queued"];
    expect(names(applyUpcomingFilters(fixtureRows(), state, NOW))).toEqual([
      "Old News",
      "A Book",
      "A Game",
      "Foundation",
    ]);
  });

  it("gives every library's rows a type, and `(empty)` is a real value", () => {
    const rows = fixtureRows();
    const by = (name: string): string => typeOf(rows.find((row) => row.name === name) as UnifiedRow);
    expect(by("Severance")).toBe("TV Show");
    expect(by("Dune 3")).toBe("Movie");
    expect(by("A Book")).toBe("Book");
    expect(by("A Game")).toBe("Game");
    expect(by("Foundation")).toBe("");

    const state = createUpcomingFilterState();
    state.excludedTypes = [""];
    expect(names(applyUpcomingFilters(rows, state, NOW))).not.toContain("Foundation");
    // …and excluding every *named* type does not hide the empty one.
    const other = createUpcomingFilterState();
    other.excludedTypes = ["TV Show", "Movie", "Book", "Game"];
    expect(names(applyUpcomingFilters(rows, other, NOW))).toEqual(["Foundation"]);
  });

  it("tells watched from not watched, per row rather than per entry", () => {
    // A show whose season 1 is fully ticked, with S01E09 as the row: watched.
    // The same show's next episode, S01E10, is not — and that is the row you
    // want "Not watched" to leave on screen.
    const watchedShow = createTitle({
      id: "ticked",
      title: "Ticked",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: [{ name: "Season 1", seasonNumber: 1, episodes: 10, offset: 0, skippedEpisodes: [] }],
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
    });
    const nextUp = createTitle({
      id: "next",
      title: "Next Up",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: [{ name: "Season 1", seasonNumber: 1, episodes: 10, offset: 0, skippedEpisodes: [] }],
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      airing: { nextEpisode: { season: 1, episode: 10, airDate: "2026-08-05" } },
    });
    const rows = buildUnifiedUpcoming([watchedShow, nextUp], reading(), games(), { now: NOW });
    const by = (name: string): string =>
      watchStateOf(rows.find((row) => row.name === name) as UnifiedRow);
    expect(by("Ticked")).toBe("watched");
    expect(by("Next Up")).toBe("unwatched");
  });

  it("reads watched as finished in each library's own words", () => {
    const rows = buildUnifiedUpcoming(
      [],
      reading({
        books: [
          createBook({ id: "done", title: "Read It", releaseDate: "2026-08-01", status: "Completed" }),
          createBook({ id: "todo", title: "Not Yet", releaseDate: "2026-08-01" }),
        ],
      }),
      games([
        createGame({ id: "fin", title: "Finished Game", releaseDate: "2026-08-01", status: "Finished" }),
        createGame({ id: "unfin", title: "Backlog Game", releaseDate: "2026-08-01", status: "Playing" }),
      ]),
      { now: NOW },
    );
    const by = (name: string): string =>
      watchStateOf(rows.find((row) => row.name === name) as UnifiedRow);
    expect(by("Read It")).toBe("watched");
    expect(by("Not Yet")).toBe("unwatched");
    expect(by("Finished Game")).toBe("watched");
    expect(by("Backlog Game")).toBe("unwatched");
  });

  it("never calls an unaired thing watched", () => {
    const rows = fixtureRows();
    for (const row of rows) expect(watchStateOf(row)).toBe("unwatched");
  });

  it("filters on watched-ness", () => {
    const ticked = createTitle({
      id: "ticked",
      title: "Ticked",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: [{ name: "Season 1", seasonNumber: 1, episodes: 10, offset: 0, skippedEpisodes: [] }],
      watchedEpisodes: [9],
      airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
    });
    const rows = buildUnifiedUpcoming([ticked, ...[]], reading(), games(), { now: NOW });
    const hideWatched = createUpcomingFilterState();
    hideWatched.excludedWatchStates = ["watched"];
    expect(applyUpcomingFilters(rows, hideWatched, NOW)).toHaveLength(0);

    const hideUnwatched = createUpcomingFilterState();
    hideUnwatched.excludedWatchStates = ["unwatched"];
    expect(names(applyUpcomingFilters(rows, hideUnwatched, NOW))).toEqual(["Ticked"]);
  });

  it("filters to favourites across libraries", () => {
    const state = createUpcomingFilterState();
    state.favoritesOnly = true;
    expect(names(applyUpcomingFilters(fixtureRows(), state, NOW))).toEqual(["Severance"]);
  });

  it("clears back to showing everything", () => {
    const state: UpcomingFilterState = {
      excludedDomains: ["games"],
      excludedKinds: ["season"],
      excludedStates: ["due"],
      excludedAvailability: ["queued"],
      excludedWatchStates: ["watched"],
      excludedTypes: ["Movie"],
      favoritesOnly: true,
      window: "7d",
    };
    expect(isUpcomingFilterActive(state)).toBe(true);
    clearUpcomingFilters(state);
    expect(isUpcomingFilterActive(state)).toBe(false);
    expect(state.window).toBe("all");
    expect(applyUpcomingFilters(fixtureRows(), state, NOW)).toHaveLength(6);
  });

  it("treats the window alone as an active filter", () => {
    const state = createUpcomingFilterState();
    state.window = "7d";
    expect(isUpcomingFilterActive(state)).toBe(true);
  });
});

describe("facet sections", () => {
  it("drops facet values nothing produces rather than showing dead chips", () => {
    const rows = buildUnifiedUpcoming(
      [show({ airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-05" } } })],
      reading(),
      games(),
      { now: NOW },
    );
    const sections = buildUpcomingFacetSections(rows);
    const domains = sections.find((s) => s.key === "domains");
    expect(domains?.options.map((o) => o.value)).toEqual(["watchlist"]);
    const kinds = sections.find((s) => s.key === "kinds");
    expect(kinds?.options.map((o) => o.value)).toEqual(["episode"]);
  });

  it("keeps an excluded value on the list even at count zero, so it can be undone", () => {
    const state = createUpcomingFilterState();
    state.excludedDomains = ["games"];
    const rows = buildUnifiedUpcoming(
      [show({ airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-05" } } })],
      reading(),
      games(),
      { now: NOW },
    );
    const domains = buildUpcomingFacetSections(rows, state).find((s) => s.key === "domains");
    expect(domains?.options.map((o) => o.value)).toEqual(["watchlist", "games"]);
    expect(domains?.options.find((o) => o.value === "games")?.count).toBe(0);
  });

  it("counts the unfiltered pool, and puts `(empty)` last", () => {
    const sections = buildUpcomingFacetSections(fixtureRows());
    const types = sections.find((s) => s.key === "types");
    expect(types?.options.map((o) => o.label)).toEqual([
      "Book",
      "Game",
      "Movie",
      "TV Show",
      "(empty)",
    ]);
    const domains = sections.find((s) => s.key === "domains");
    expect(domains?.options.find((o) => o.value === "watchlist")?.count).toBe(4);
    expect(domains?.options.find((o) => o.value === "reading")?.count).toBe(1);
  });

  it("round-trips every facet through the key accessors", () => {
    const state = createUpcomingFilterState();
    for (const section of buildUpcomingFacetSections(fixtureRows())) {
      const first = section.options[0];
      if (!first) continue;
      setExcludedForUpcoming(state, section.key, [first.value]);
      expect(excludedForUpcoming(state, section.key)).toEqual([first.value]);
    }
    expect(isUpcomingFilterActive(state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sorting", () => {
  it("defaults to soonest first", () => {
    expect(defaultUpcomingSort()).toEqual({ key: "date", direction: "asc" });
    expect(names(sortUpcomingRows(fixtureRows(), defaultUpcomingSort()))).toEqual([
      "Old News",
      "Severance",
      "A Book",
      "Dune 3",
      "A Game",
      "Foundation",
    ]);
  });

  it("keeps dateless rows last in BOTH directions", () => {
    const asc = names(sortUpcomingRows(fixtureRows(), { key: "date", direction: "asc" }));
    const desc = names(sortUpcomingRows(fixtureRows(), { key: "date", direction: "desc" }));
    expect(asc[asc.length - 1]).toBe("Foundation");
    expect(desc[desc.length - 1]).toBe("Foundation");
    expect(desc[0]).toBe("A Game");
  });

  it("sorts by title, by library, and by when the news arrived", () => {
    expect(names(sortUpcomingRows(fixtureRows(), { key: "title", direction: "asc" }))).toEqual([
      "A Book",
      "A Game",
      "Dune 3",
      "Foundation",
      "Old News",
      "Severance",
    ]);
    expect(
      sortUpcomingRows(fixtureRows(), { key: "domain", direction: "asc" }).map((r) => r.source),
    ).toEqual(["watchlist", "watchlist", "watchlist", "watchlist", "reading", "games"]);
  });

  it("reads “recently announced” off the schedule check, newest first", () => {
    // The signal is `airing.checkedAt` — when this news was last confirmed
    // upstream — with the entry's own timestamp as the fallback.
    const rows = buildUnifiedUpcoming(
      [
        show({
          id: "old-check",
          title: "Checked Last Week",
          airing: {
            nextEpisode: { season: 1, episode: 1, airDate: "2026-08-05" },
            checkedAt: "2026-07-27T09:00:00.000Z",
          },
        }),
        show({
          id: "new-check",
          title: "Checked Today",
          airing: {
            nextEpisode: { season: 1, episode: 1, airDate: "2026-08-09" },
            checkedAt: "2026-08-03T09:00:00.000Z",
          },
        }),
      ],
      reading(),
      games(),
      { now: NOW },
    );
    expect(names(sortUpcomingRows(rows, { key: "announced", direction: "desc" }))).toEqual([
      "Checked Today",
      "Checked Last Week",
    ]);
  });

  it("breaks ties on the second level, then on the name", () => {
    const rows = buildUnifiedUpcoming(
      [
        show({ id: "b", title: "Bravo", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-05" } } }),
        show({ id: "a", title: "Alpha", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-05" } } }),
      ],
      reading({ books: [createBook({ id: "c", title: "Charlie", releaseDate: "2026-08-05" })] }),
      games(),
      { now: NOW },
    );
    expect(names(sortUpcomingRows(rows, { key: "date", direction: "asc" }))).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(
      names(sortUpcomingRows(rows, { key: "date", direction: "asc" }, { key: "domain", direction: "desc" })),
    ).toEqual(["Charlie", "Alpha", "Bravo"]);
  });

  it("never mutates the input", () => {
    const rows = fixtureRows();
    const before = names(rows);
    sortUpcomingRows(rows, { key: "title", direction: "desc" });
    expect(names(rows)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("search", () => {
  const run = (query: string): string[] => names(new UpcomingSearchEngine(fixtureRows()).filter(query));

  it("matches plain typing against the show name", () => {
    expect(run("severance")).toEqual(["Severance"]);
  });

  it("is fuzzy, so a typo still finds it", () => {
    expect(run("severnce")).toEqual(["Severance"]);
  });

  it("matches the episode title as well as the show", () => {
    expect(run("grid")).toEqual(["Severance"]);
    expect(run('episode:"the grid"')).toEqual(["Severance"]);
    expect(run("show:severance")).toEqual(["Severance"]);
    // …and the show scope does not match on the episode name.
    expect(run("show:grid")).toEqual([]);
  });

  it("scopes to a library, a kind and a state with the facets' own words", () => {
    expect(run("domain:games")).toEqual(["A Game"]);
    expect(run("kind:season")).toEqual(["Foundation"]);
    expect(run("state:due")).toEqual(["Old News"]);
    // Everything that is not on Plex and has nothing on the way — which now
    // includes the rows no scan could answer for.
    expect(run("plex:no")).toEqual(["Old News", "A Book", "A Game", "Foundation"]);
    expect(run("plex:queued")).toEqual(["Dune 3"]);
    expect(run("plex:yes")).toEqual(["Severance"]);
  });

  it("scopes to watched-ness, under any of its spellings", () => {
    expect(run("watched:no")).toHaveLength(6);
    expect(run("watched:yes")).toEqual([]);
    // `seen:`, `read:` and `played:` are the same field in other words.
    expect(run("seen:no")).toHaveLength(6);
    expect(run("played:no")).toHaveLength(6);
  });

  it("compares the countdown numerically", () => {
    expect(run("days:<=7")).toEqual(["Old News", "Severance", "A Book"]);
    expect(run("days:>0 days:<=7")).toEqual(["Severance", "A Book"]);
  });

  it("negates, and ORs", () => {
    expect(run("-domain:watchlist")).toEqual(["A Book", "A Game"]);
    expect(run("domain:games | domain:reading")).toEqual(["A Book", "A Game"]);
  });

  it("never errors on a half-typed query", () => {
    expect(parseUpcomingQuery("nonsense:").isEmpty).toBe(false);
    expect(() => run("nonsense:")).not.toThrow();
    expect(run("")).toHaveLength(6);
  });

  it("builds the fuzzy index only when a bare term needs it", () => {
    const engine = new UpcomingSearchEngine(fixtureRows());
    engine.filter("domain:games");
    expect(engine.indexBuilt).toBe(false);
    engine.filter("severnce");
    expect(engine.indexBuilt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("the persisted view state", () => {
  function settings(): Settings {
    return createDefaultSettings();
  }

  it("defaults to an unfiltered, soonest-first view", () => {
    const state = readUpcomingViewState(settings());
    expect(state.query).toBe("");
    expect(state.sort).toEqual({ key: "date", direction: "asc" });
    expect(state.filters.window).toBe("all");
    expect(state.presets).toEqual([]);
  });

  it("round-trips through the settings object under one key", () => {
    const s = settings();
    const state = readUpcomingViewState(s);
    state.query = "domain:games";
    state.filters.excludedStates = ["announced"];
    state.filters.window = "30d";
    state.sort = { key: "title", direction: "desc" };
    state.secondarySort = { key: "domain", direction: "asc" };
    writeUpcomingViewState(s, state);

    const restored = readUpcomingViewState(s);
    expect(restored.query).toBe("domain:games");
    expect(restored.filters.excludedStates).toEqual(["announced"]);
    expect(restored.filters.window).toBe("30d");
    expect(restored.sort).toEqual({ key: "title", direction: "desc" });
    expect(restored.secondarySort).toEqual({ key: "domain", direction: "asc" });
  });

  it("keeps a saved availability filter meaning what it meant", () => {
    // The four-state model this replaced: `requested` became `queued`, and
    // `unknown` folded into `not-plex`. A view saved before that must not
    // silently start filtering on something else.
    const s = createDefaultSettings() as unknown as Record<string, unknown>;
    s.v4UpcomingView = {
      filters: { excludedAvailability: ["requested", "unknown", "plex"] },
    };
    expect(readUpcomingViewState(s as unknown as Settings).filters.excludedAvailability).toEqual([
      "queued",
      "not-plex",
      "plex",
    ]);
  });

  it("survives junk on disk rather than throwing", () => {
    const s = settings() as unknown as Record<string, unknown>;
    s.v4UpcomingView = {
      query: 42,
      filters: { excludedDomains: ["nope", "games"], window: "century", favoritesOnly: "yes" },
      sort: { key: "colour", direction: "sideways" },
      presets: [{ name: "" }, "nonsense"],
    };
    const restored = readUpcomingViewState(s as unknown as Settings);
    expect(restored.query).toBe("");
    expect(restored.filters.excludedDomains).toEqual(["games"]);
    expect(restored.filters.window).toBe("all");
    expect(restored.filters.favoritesOnly).toBe(false);
    expect(restored.sort).toEqual({ key: "date", direction: "asc" });
    expect(restored.presets).toEqual([]);
  });

  it("leaves every other settings key alone", () => {
    const s = settings() as unknown as Record<string, unknown>;
    s.omdbApiKey = "a-v3-key";
    writeUpcomingViewState(s as unknown as Settings, readUpcomingViewState(s as unknown as Settings));
    expect(s.omdbApiKey).toBe("a-v3-key");
    expect((s as unknown as Settings).rootFolder).toBe(createDefaultSettings().rootFolder);
  });
});

describe("saved views", () => {
  it("captures the whole toolbar, and restores it without aliasing", () => {
    const filters = createUpcomingFilterState();
    filters.window = "7d";
    filters.excludedAvailability = ["plex"];
    const preset = toUpcomingPreset(
      "This week, not on Plex",
      { query: "kind:episode", filters, sort: { key: "date", direction: "asc" }, secondarySort: null },
      "preset-1",
    );

    // Mutating the live state afterwards must not touch the saved view.
    filters.window = "all";
    filters.excludedAvailability = [];

    const restored = fromUpcomingPreset(preset);
    expect(restored.query).toBe("kind:episode");
    expect(restored.filters.window).toBe("7d");
    expect(restored.filters.excludedAvailability).toEqual(["plex"]);

    // …and mutating the restored copy must not touch the preset either.
    restored.filters.window = "30d";
    expect(preset.filters.window).toBe("7d");
  });

  it("survives a save/load cycle with its presets intact", () => {
    const s = createDefaultSettings();
    const state = readUpcomingViewState(s);
    const filters = createUpcomingFilterState();
    filters.window = "7d";
    filters.excludedAvailability = ["plex"];
    state.presets = [
      toUpcomingPreset("This week, not on Plex", {
        query: "",
        filters,
        sort: { key: "date", direction: "asc" },
        secondarySort: null,
      }, "p1"),
    ];
    writeUpcomingViewState(s, state);

    const restored = readUpcomingViewState(s);
    expect(restored.presets).toHaveLength(1);
    expect(restored.presets[0]?.name).toBe("This week, not on Plex");
    expect(restored.presets[0]?.filters.window).toBe("7d");

    // And the preset actually does what it says on the fixture.
    const applied = fromUpcomingPreset(restored.presets[0] as never);
    const rows = applyUpcomingFilters(fixtureRows(), applied.filters, NOW);
    expect(names(rows)).toEqual(["A Book"]);
  });
});

describe("still to come versus already arrived", () => {
  it("splits on the countdown, and keeps a dateless announcement out of the past", () => {
    const rows = fixtureRows();
    expect(names(rows.filter((row) => hasArrived(row)))).toEqual(["Old News"]);
    expect(names(rows.filter((row) => !hasArrived(row)))).toEqual([
      "Severance",
      "A Book",
      "Dune 3",
      "A Game",
      "Foundation",
    ]);
    // An announcement with no date is future news, not a past release.
    expect(hasArrived({ daysUntil: null })).toBe(false);
    // Today counts as still to come — it has not been and gone.
    expect(hasArrived({ daysUntil: 0 })).toBe(false);
    expect(hasArrived({ daysUntil: -1 })).toBe(true);
  });
});

describe("one row at a time", () => {
  it("is the predicate the list filter is built from", () => {
    const rows = fixtureRows();
    const state = createUpcomingFilterState();
    state.excludedDomains = ["games"];
    const game = rows.find((row) => row.source === "games") as UnifiedRow;
    expect(matchesUpcomingFilters(game, state, NOW)).toBe(false);
    expect(matchesUpcomingFilters(rows[0] as UnifiedRow, state, NOW)).toBe(true);
  });

  it("counts a manga as its own type", () => {
    const rows = buildUnifiedUpcoming(
      [],
      reading({ manga: [createManga({ id: "m", title: "A Manga", releaseDate: "2026-08-05" })] }),
      games(),
      { now: NOW },
    );
    expect(typeOf(rows[0] as UnifiedRow)).toBe("Manga");
  });
});
