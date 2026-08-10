/**
 * The Games tab's search, facets and sort.
 *
 * The grammar is the Library's, so the tests that matter here are the ones that
 * pin the *differences*: games' own field vocabulary, `playtime:` meaning hours,
 * a game with no achievements never matching an achievements comparison, and
 * empties sorting last under both directions.
 */
import { describe, expect, it } from "vitest";
import { createGame, createGamesSettings } from "../src/data/schema";
import {
  GameSearchEngine,
  parseGameQuery,
  searchGames,
} from "../src/domains/games/query";
import {
  buildGameFacetSections,
  clearGameFilters,
  createGameFilterState,
  gameDecade,
  hideAllGameFacets,
  isGameFilterActive,
  matchesGameFilters,
  normalizeGameFilterState,
  toggleGameFacetValue,
} from "../src/domains/games/facets";
import {
  GAME_SORT_DEFAULT_DIR,
  gameSortValue,
  nextGameSortSpec,
  sortGames,
} from "../src/domains/games/sort";
import type { Game } from "../src/types";

function game(overrides: Partial<Game> & { id: string; title: string }): Game {
  return createGame(overrides);
}

const HADES = game({
  id: "hades",
  title: "Hades",
  type: "RPG",
  status: "Finished",
  developer: "Supergiant Games",
  publisher: "Supergiant Games",
  platforms: ["Windows PC", "Nintendo Switch 2"],
  playtimeMinutes: 4210,
  achievementsEarned: 49,
  achievementsTotal: 49,
  rating: 5,
  favorite: true,
  singleplayer: true,
  releaseDate: "2020-09-17",
});

const SILKSONG = game({
  id: "silksong",
  title: "Hollow Knight: Silksong",
  type: "Platformer",
  status: "To be released",
  wishlist: true,
  platforms: ["Nintendo Switch 2"],
  releaseDate: "2026-12-01",
});

const DEEP_ROCK = game({
  id: "drg",
  title: "Deep Rock Galactic",
  type: "Shooter",
  status: "Playing",
  developer: "Ghost Ship Games",
  platforms: ["Windows PC"],
  playtimeMinutes: 1800,
  achievementsEarned: 40,
  achievementsTotal: 100,
  coop: true,
  multiplayer: true,
  rating: 4,
  priority: "High",
  releaseDate: "2020-05-13",
});

const POOL = [HADES, SILKSONG, DEEP_ROCK];

const ids = (games: readonly Game[]): string[] => games.map((entry) => entry.id);

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

describe("the games query language", () => {
  it("finds by name without any syntax at all", () => {
    expect(ids(searchGames(POOL, "hades"))).toEqual(["hades"]);
    expect(ids(searchGames(POOL, ""))).toEqual(["hades", "silksong", "drg"]);
  });

  it("scopes to games' own text fields", () => {
    expect(ids(searchGames(POOL, "platform:windows"))).toEqual(["hades", "drg"]);
    expect(ids(searchGames(POOL, 'dev:"ghost ship"'))).toEqual(["drg"]);
    expect(ids(searchGames(POOL, "genre:shooter"))).toEqual(["drg"]);
    // v3 calls a game's genre its `type`, so both spellings work.
    expect(ids(searchGames(POOL, "type:rpg"))).toEqual(["hades"]);
  });

  it("reads playtime in hours and minutes in minutes", () => {
    // The trap this exists to avoid: `playtime:>40` meaning forty *minutes*.
    expect(ids(searchGames(POOL, "playtime:>40"))).toEqual(["hades"]);
    expect(ids(searchGames(POOL, "playtime:>=30"))).toEqual(["hades", "drg"]);
    expect(ids(searchGames(POOL, "minutes:>2000"))).toEqual(["hades"]);
  });

  it("never matches an achievements comparison on a game that has none", () => {
    expect(ids(searchGames(POOL, "achievements:=100"))).toEqual(["hades"]);
    expect(ids(searchGames(POOL, "achievements:<50"))).toEqual(["drg"]);
    // Silksong has no achievement schema — it is absent from both answers,
    // rather than counting as 0%.
    expect(ids(searchGames(POOL, "achievements:>=0"))).toEqual(["hades", "drg"]);
  });

  it("handles the flags and the play modes", () => {
    expect(ids(searchGames(POOL, "wishlist:yes"))).toEqual(["silksong"]);
    expect(ids(searchGames(POOL, "favorite:no"))).toEqual(["silksong", "drg"]);
    expect(ids(searchGames(POOL, "mode:coop"))).toEqual(["drg"]);
    expect(ids(searchGames(POOL, "mode:solo"))).toEqual(["hades"]);
    expect(ids(searchGames(POOL, "played:no"))).toEqual(["silksong"]);
  });

  it("negates, ORs and quotes exactly like the Library", () => {
    expect(ids(searchGames(POOL, "-wishlist:yes"))).toEqual(["hades", "drg"]);
    expect(ids(searchGames(POOL, "genre:rpg | genre:shooter"))).toEqual(["hades", "drg"]);
    expect(ids(searchGames(POOL, '"hollow knight"'))).toEqual(["silksong"]);
  });

  it("never errors on a half-typed query", () => {
    // Every one of these degrades to a literal search rather than throwing.
    expect(() => searchGames(POOL, "playtime:")).not.toThrow();
    expect(() => searchGames(POOL, "playtime:soon")).not.toThrow();
    expect(() => searchGames(POOL, "wishlist:maybe")).not.toThrow();
    expect(() => searchGames(POOL, 'unclosed "quote')).not.toThrow();
    expect(ids(searchGames(POOL, "nonsense:value"))).toEqual([]);
  });

  it("parses an unknown prefix as literal text, not as an error", () => {
    const parsed = parseGameQuery("foo:bar");
    expect(parsed.groups[0]?.[0]).toMatchObject({ kind: "fuzzy", value: "foo:bar" });
    expect(parseGameQuery("   ").isEmpty).toBe(true);
  });

  it("builds the fuzzy index only when a bare term needs one", () => {
    // A field-scoped or enum query must not pay for Fuse.
    const scoped = new GameSearchEngine(POOL);
    scoped.filter("platform:windows");
    expect(scoped.indexBuilt).toBe(false);

    const bare = new GameSearchEngine(POOL);
    bare.filter("halo");
    expect(bare.indexBuilt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe("the games facet filters", () => {
  it("shows everything until something is excluded", () => {
    const state = createGameFilterState();
    expect(isGameFilterActive(state)).toBe(false);
    expect(POOL.every((entry) => matchesGameFilters(entry, state))).toBe(true);
  });

  it("hides by status, genre and priority", () => {
    const state = createGameFilterState();
    state.excludedStatuses = ["To be released"];
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual(["hades", "drg"]);
    state.excludedStatuses = [];
    state.excludedGenres = ["RPG"];
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual(["silksong", "drg"]);
  });

  it("hides a game only when *every* platform it has is excluded", () => {
    const state = createGameFilterState();
    state.excludedPlatforms = ["Windows PC"];
    // Hades is also on Switch, so it stays.
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual([
      "hades",
      "silksong",
    ]);
    state.excludedPlatforms = ["Windows PC", "Nintendo Switch 2"];
    expect(POOL.filter((entry) => matchesGameFilters(entry, state))).toEqual([]);
  });

  it("never hides an unrated game behind a minimum rating", () => {
    const state = createGameFilterState();
    state.minRating = 5;
    // Silksong is unrated (0) and still shows; Deep Rock's 4 does not clear 5.
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual([
      "hades",
      "silksong",
    ]);
  });

  it("filters to favourites and to the wishlist", () => {
    const state = createGameFilterState();
    state.favoritesOnly = true;
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual(["hades"]);
    state.favoritesOnly = false;
    state.wishlistOnly = true;
    expect(ids(POOL.filter((entry) => matchesGameFilters(entry, state)))).toEqual(["silksong"]);
  });

  it("buckets releases by decade, with a real (empty) option", () => {
    expect(gameDecade(HADES)).toBe("2020");
    expect(gameDecade(game({ id: "x", title: "X" }))).toBe("");

    const sections = buildGameFacetSections(
      [...POOL, game({ id: "x", title: "Undated" })],
      createGamesSettings(),
    );
    const decades = sections.find((section) => section.key === "decades");
    expect(decades?.options.map((option) => option.label)).toEqual(["2020s", "(empty)"]);
  });

  it("keeps a value the settings list no longer has", () => {
    // A genre the user deleted while games still carry it must stay filterable.
    const settings = createGamesSettings();
    settings.types = [{ name: "RPG", color: "#1" }];
    const sections = buildGameFacetSections(POOL, settings);
    const genres = sections.find((section) => section.key === "genres");
    expect(genres?.options.map((option) => option.value)).toEqual([
      "RPG",
      "Platformer",
      "Shooter",
    ]);
  });

  it("toggles one value and hides them all, then resets", () => {
    const state = createGameFilterState();
    expect(toggleGameFacetValue(state, "statuses", "Playing")).toBe(false);
    expect(state.excludedStatuses).toEqual(["Playing"]);
    expect(toggleGameFacetValue(state, "statuses", "Playing")).toBe(true);

    const sections = buildGameFacetSections(POOL, createGamesSettings());
    hideAllGameFacets(state, sections);
    expect(isGameFilterActive(state)).toBe(true);
    clearGameFilters(state);
    expect(isGameFilterActive(state)).toBe(false);
  });

  it("repairs a filter state a hand edit broke", () => {
    const state = normalizeGameFilterState({ excludedGenres: ["RPG", 7], minRating: "five" });
    expect(state.excludedGenres).toEqual(["RPG"]);
    expect(state.minRating).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe("games sorting", () => {
  const context = {
    statuses: createGamesSettings().statuses,
    priorities: [
      { name: "High", color: "#1" },
      { name: "Medium", color: "#2" },
      { name: "Low", color: "#3" },
    ],
  };

  it("puts empties last under both directions", () => {
    const asc = sortGames(POOL, { key: "playtime", direction: "asc" }, null, context);
    const desc = sortGames(POOL, { key: "playtime", direction: "desc" }, null, context);
    // Silksong has never been played; it is last either way.
    expect(ids(asc)).toEqual(["drg", "hades", "silksong"]);
    expect(ids(desc)).toEqual(["hades", "drg", "silksong"]);
  });

  it("treats an unrated game as empty rather than as zero", () => {
    expect(gameSortValue(SILKSONG, "rating", context)).toBeNull();
    expect(gameSortValue(HADES, "rating", context)).toBe(5);
  });

  it("breaks ties on the secondary spec, then on title", () => {
    const a = game({ id: "a", title: "Beta", status: "Playing", rating: 4 });
    const b = game({ id: "b", title: "Alpha", status: "Playing", rating: 4 });
    const c = game({ id: "c", title: "Gamma", status: "Playing", rating: 5 });
    const sorted = sortGames([a, b, c], { key: "status", direction: "asc" }, { key: "rating", direction: "desc" }, context);
    expect(ids(sorted)).toEqual(["c", "b", "a"]);
  });

  it("adopts a new key's natural direction and flips a repeated one", () => {
    const start = { key: "title", direction: "asc" } as const;
    expect(nextGameSortSpec(start, "title")).toEqual({ key: "title", direction: "desc" });
    expect(nextGameSortSpec(start, "playtime")).toEqual({
      key: "playtime",
      direction: GAME_SORT_DEFAULT_DIR.playtime,
    });
  });

  it("sorts achievements by percentage, not by count", () => {
    // 40/100 is less complete than 49/49, however much bigger 40 looks.
    const sorted = sortGames([DEEP_ROCK, HADES], { key: "achievements", direction: "desc" }, null, context);
    expect(ids(sorted)).toEqual(["hades", "drg"]);
  });
});
