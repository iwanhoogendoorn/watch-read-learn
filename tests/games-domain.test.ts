/**
 * The Games domain (SPEC2-PARITY.md §D-GAMES).
 *
 * The load-bearing test in this file is the first one: a real v3 vault's games
 * carry keys v4 has never heard of, and the moment v4 starts *writing* those
 * records, one object literal is all it takes to delete them. Everything else —
 * the playtime and achievement maths, the note mirror, the Upcoming rows — is
 * arithmetic that several surfaces read, which is exactly the kind that drifted
 * apart in v3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/data/migrate";
import { createGame, createGamesSettings } from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import {
  createGamesStore,
  readGamesViewState,
  writeGamesViewState,
} from "../src/domains/games/store";
import {
  achievementPercent,
  achievementText,
  achievementTotals,
  countsByStatus,
  formatPlaytime,
  formatPlaytimeShort,
  gameProgress,
  gameYear,
  gamesCompletedStat,
  timePlayedStat,
  totalPlaytimeMinutes,
} from "../src/domains/games/stats";
import {
  buildGameFrontmatter,
  composeGameNote,
  gameNotePath,
} from "../src/domains/games/notes";
import {
  buildGameUpcomingEntries,
  daysUntil,
  isUnreleased,
} from "../src/domains/games/upcoming";
import {
  buildGameFromResult,
  findExistingGame,
  foldPlatforms,
  pickGameGenre,
} from "../src/domains/games/modals/add";
import { parsePlaytime, playtimeFieldValue } from "../src/domains/games/modals/detail";
import { installDomGlobals } from "./helpers/dom";
import type { Game, GameSearchResult, WatchLogData } from "../src/types";

// The store dispatches `watchlog-data-changed` on every mutation, so even the
// data-shape checks need somewhere for that event to go.
let restoreDom: () => void;

beforeEach(() => {
  restoreDom = installDomGlobals(900);
});

afterEach(() => {
  restoreDom();
});

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/data-v3-parity.json",
);
const RAW = readFileSync(FIXTURE, "utf8");

function fakePlugin() {
  return {
    loadData: vi.fn(async () => JSON.parse(RAW) as unknown),
    saveData: vi.fn(async () => undefined),
  };
}

async function loadedStore(): Promise<WatchLogStore> {
  const store = new WatchLogStore(fakePlugin() as never);
  await store.load();
  return store;
}

/** The raw record, for keys TypeScript does not know about. */
function rec(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function migratedData(): WatchLogData {
  return migrate(JSON.parse(RAW) as unknown).data;
}

// ---------------------------------------------------------------------------
// v3-shape round trip
// ---------------------------------------------------------------------------

describe("the games store writes without destroying what it does not know", () => {
  it("keeps a game's unknown v3 keys through an update", async () => {
    const store = await loadedStore();
    const games = createGamesStore({ store });

    const before = rec(games.getGame("hades"));
    expect(before.howLongToBeat).toBe(96);

    games.updateGame("hades", { rating: 4, playtimeMinutes: 4300 }, "test");

    const after = rec(games.getGame("hades"));
    // The edit landed…
    expect(after.rating).toBe(4);
    expect(after.playtimeMinutes).toBe(4300);
    // …and everything v4 has never heard of is still there.
    expect(after.howLongToBeat).toBe(96);
    expect(after.modsInstalled).toEqual(["Hell Mode"]);
    expect(after.vaultPage).toBe("WatchLog/Games/Hades.md");
  });

  it("mutates the stored object rather than replacing it", async () => {
    const store = await loadedStore();
    const games = createGamesStore({ store });
    const identity = games.getGame("hades");
    games.updateGame("hades", { favorite: false }, "test");
    // Same object: a replacement would strand every reference the UI holds and
    // silently drop the keys migration preserved.
    expect(games.getGame("hades")).toBe(identity);
  });

  it("stamps dateModified and leaves dateAdded alone", async () => {
    const store = await loadedStore();
    const games = createGamesStore({ store, now: () => "2026-08-03T10:00:00.000Z" });
    const added = games.getGame("hades")?.dateAdded;
    games.updateGame("hades", { rating: 3 }, "test");
    expect(games.getGame("hades")?.dateModified).toBe("2026-08-03T10:00:00.000Z");
    expect(games.getGame("hades")?.dateAdded).toBe(added);
  });

  it("adds, deletes, and unhooks a deleted game from its groups", async () => {
    const store = await loadedStore();
    const games = createGamesStore({ store });

    const game = createGame({ id: "prey", title: "Prey" });
    games.addGame(game);
    expect(games.getGame("prey")).toBeDefined();

    // `silksong` is the only member of the fixture's Backlog group.
    expect(games.games.groups[0]?.gameIds).toEqual(["silksong"]);
    expect(games.deleteGame("silksong")).toBe(true);
    expect(games.games.groups[0]?.gameIds).toEqual([]);
    expect(games.deleteGame("silksong")).toBe(false);
  });

  it("logs to the shared activity history with v3's source name", async () => {
    const store = await loadedStore();
    const games = createGamesStore({ store });
    const before = store.data.history.length;

    games.updateGame("silksong", { status: "Finished" }, "test");

    const entry = store.data.history[store.data.history.length - 1];
    expect(store.data.history.length).toBe(before + 1);
    expect(entry?.source).toBe("Games");
    expect(entry?.action).toBe("completed");
  });

  it("notifies the note mirror with the ids it changed", async () => {
    const store = await loadedStore();
    const seen: string[][] = [];
    const games = createGamesStore({ store, onMutated: (ids) => seen.push(ids) });
    games.updateGame("hades", { rating: 5 }, "test");
    expect(seen).toEqual([["hades"]]);
  });

  it("round-trips the tab's view state through the frozen settings shape", () => {
    const data = migratedData();
    const games = data.games;
    if (!games) throw new Error("fixture has no games");

    const initial = readGamesViewState(games);
    expect(initial.mode).toBe("grid");
    expect(initial.sort.key).toBe("dateAdded");

    initial.filters.excludedStatuses = ["Dropped"];
    initial.sort = { key: "playtime", direction: "desc" };
    initial.mode = "table";
    writeGamesViewState(games, initial);

    // Survives a serialisation round trip — this lives in `data.json`.
    const reloaded = readGamesViewState(
      JSON.parse(JSON.stringify(games)) as typeof games,
    );
    expect(reloaded.filters.excludedStatuses).toEqual(["Dropped"]);
    expect(reloaded.sort).toEqual({ key: "playtime", direction: "desc" });
    expect(reloaded.mode).toBe("table");

    // And the v3 key sitting beside it is untouched.
    expect(rec(games.settings).gamesGridDensity).toBe("compact");
  });

  it("repairs nonsense in a hand-edited view state instead of throwing", () => {
    const data = migratedData();
    const games = data.games;
    if (!games) throw new Error("fixture has no games");
    (games.settings as unknown as Record<string, unknown>).v4ViewState = {
      filters: { excludedStatuses: "Dropped", minRating: -4 },
      sort: { key: "not-a-key", direction: "sideways" },
      mode: "hologram",
    };
    const state = readGamesViewState(games);
    expect(state.filters.excludedStatuses).toEqual([]);
    expect(state.filters.minRating).toBe(0);
    expect(state.sort).toEqual({ key: "dateAdded", direction: "desc" });
    expect(state.mode).toBe("grid");
  });
});

// ---------------------------------------------------------------------------
// Playtime and achievement maths
// ---------------------------------------------------------------------------

function game(overrides: Partial<Game> = {}): Game {
  return createGame({ id: "g", title: "A Game", ...overrides });
}

describe("playtime", () => {
  it("sums only positive minutes", () => {
    expect(
      totalPlaytimeMinutes([
        game({ playtimeMinutes: 600 }),
        game({ playtimeMinutes: 0 }),
        game({ playtimeMinutes: -30 }),
      ]),
    ).toBe(600);
  });

  it("formats in hours, because a game is not a box set", () => {
    // 4,210 minutes is "70 h" to everyone who plays, and "2d 22h" to nobody —
    // which is why this is not `formatMinutes` from data/episodes.ts.
    expect(formatPlaytime(4210)).toBe("70 h");
    expect(formatPlaytime(90)).toBe("1 h 30 m");
    expect(formatPlaytime(45)).toBe("45 m");
    expect(formatPlaytime(0)).toBe("—");
    // Past ten hours the minutes stop being information.
    expect(formatPlaytime(632)).toBe("10 h");
    expect(formatPlaytimeShort(4210)).toBe("70h");
    expect(formatPlaytimeShort(0)).toBe("");
  });

  it("counts only the games that contribute", () => {
    const stat = timePlayedStat([
      game({ playtimeMinutes: 600 }),
      game({ playtimeMinutes: 0 }),
      game({ playtimeMinutes: 60 }),
    ]);
    expect(stat.minutes).toBe(660);
    expect(stat.games).toBe(2);
    expect(stat.label).toBe("11 h");
  });
});

describe("achievements", () => {
  it("reports null, not zero, for a game that has none", () => {
    // "0%" on a game without achievements is a lie the card would repeat forever.
    expect(achievementPercent(game({ achievementsTotal: 0, achievementsEarned: 0 }))).toBeNull();
    expect(achievementText(game({ achievementsTotal: 0 }))).toBe("");
  });

  it("clamps a total Steam briefly reported wrong", () => {
    const g = game({ achievementsEarned: 55, achievementsTotal: 49 });
    expect(achievementPercent(g)).toBe(100);
    expect(achievementText(g)).toBe("49 / 49");
  });

  it("sums across the library, ignoring games with no schema", () => {
    const totals = achievementTotals([
      game({ achievementsEarned: 49, achievementsTotal: 49 }),
      game({ achievementsEarned: 5, achievementsTotal: 51 }),
      game({ achievementsEarned: 0, achievementsTotal: 0 }),
    ]);
    expect(totals).toEqual({ earned: 54, total: 100, percent: 54, games: 2 });
  });
});

describe("progress and completion", () => {
  it("treats a finished game as finished whatever the slider says", () => {
    expect(gameProgress(game({ status: "Finished", progress: 12 }))).toBe(100);
  });

  it("falls back to achievements so a Steam import shows movement", () => {
    expect(gameProgress(game({ progress: 0, achievementsEarned: 25, achievementsTotal: 50 }))).toBe(50);
    expect(gameProgress(game({ progress: 30, achievementsEarned: 25, achievementsTotal: 50 }))).toBe(30);
    expect(gameProgress(game())).toBe(0);
  });

  it("excludes dropped, unreleased and TBA from the completion ratio", () => {
    const stat = gamesCompletedStat([
      game({ status: "Finished" }),
      game({ status: "Playing" }),
      game({ status: "Dropped" }),
      game({ status: "To be released" }),
      game({ status: "TBA" }),
    ]);
    expect(stat).toEqual({ finished: 1, counted: 2, percent: 50 });
  });

  it("keeps a status the user deleted visible in the counts", () => {
    const counts = countsByStatus([game({ status: "Shelved" })], [{ name: "Playing", color: "#1" }]);
    expect(counts).toEqual([
      { name: "Playing", color: "#1", count: 0 },
      { name: "Shelved", color: "", count: 1 },
    ]);
  });

  it("reads the year off the release date", () => {
    expect(gameYear(game({ releaseDate: "2020-09-17" }))).toBe(2020);
    expect(gameYear(game({ releaseDate: null }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The playtime field
// ---------------------------------------------------------------------------

describe("the playtime field speaks human", () => {
  it("takes hours, minutes, clock time and decimals", () => {
    expect(parsePlaytime("12h 30m")).toBe(750);
    expect(parsePlaytime("12h")).toBe(720);
    expect(parsePlaytime("90m")).toBe(90);
    expect(parsePlaytime("1:30")).toBe(90);
    expect(parsePlaytime("1.5")).toBe(90);
    expect(parsePlaytime("40")).toBe(2400); // a bare number is hours
    expect(parsePlaytime("")).toBe(0);
  });

  it("refuses what it cannot read rather than storing a zero", () => {
    expect(parsePlaytime("ages")).toBeNull();
    expect(parsePlaytime("12h 30")).toBeNull();
  });

  it("shows minutes back as hours and minutes", () => {
    expect(playtimeFieldValue(4210)).toBe("70h 10m");
    expect(playtimeFieldValue(720)).toBe("12h");
    expect(playtimeFieldValue(45)).toBe("45m");
    expect(playtimeFieldValue(0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

describe("the note mirror", () => {
  const settings = migratedData().games?.settings;

  it("writes to the folder v3 wrote to", () => {
    if (!settings) throw new Error("fixture has no games settings");
    expect(gameNotePath(settings, game({ title: "Hades" }))).toBe("WatchLog/Games/Hades.md");
    // Characters Obsidian refuses become dashes.
    expect(gameNotePath(settings, game({ title: "Halo: CE" }))).toBe("WatchLog/Games/Halo- CE.md");
  });

  it("omits fields the game does not have rather than writing them empty", () => {
    const front = buildGameFrontmatter(game({ title: "Prey", status: "Playing" }));
    expect(front).toContain('title: "Prey"');
    expect(front).toContain('status: "Playing"');
    expect(front).not.toContain("achievements:");
    expect(front).not.toContain("playtime:");
    expect(front).not.toContain("developer:");
  });

  it("prints playtime in both forms, so the note is readable and sortable", () => {
    const front = buildGameFrontmatter(game({ playtimeMinutes: 4210 }));
    expect(front).toContain('playtime: "70 h"');
    expect(front).toContain("playtimeMinutes: 4210");
  });

  it("gives a new note an empty Notes section", () => {
    expect(composeGameNote(undefined, game())).toContain("## Notes");
  });

  it("never rewrites what the user wrote", () => {
    // Game has no `notes` field in the v3 shape, so regenerating this section
    // from an empty string is the one way this could eat someone's writing.
    const existing = `---\ntitle: "old"\n---\n\n## Notes\n\nBest boss: Hades himself.\n\n## My runs\n\n- 42\n`;
    const next = composeGameNote(existing, game({ title: "Hades" }));
    expect(next).toContain("Best boss: Hades himself.");
    expect(next).toContain("## My runs");
    expect(next).toContain('title: "Hades"');
    expect(next).not.toContain('title: "old"');
  });
});

// ---------------------------------------------------------------------------
// Upcoming
// ---------------------------------------------------------------------------

describe("game releases on the Upcoming list", () => {
  const now = new Date(2026, 7, 3); // 2026-08-03, local

  it("counts days the way the watchlist does", () => {
    expect(daysUntil(now, "2026-08-03")).toBe(0);
    expect(daysUntil(now, "2026-08-04")).toBe(1);
    expect(daysUntil(now, "2026-08-01")).toBe(-2);
    expect(daysUntil(now, "nonsense")).toBeNull();
  });

  it("keeps future releases and a week of past ones, in order", () => {
    const entries = buildGameUpcomingEntries(
      [
        game({ id: "a", title: "Later", releaseDate: "2026-12-01" }),
        game({ id: "b", title: "Soon", releaseDate: "2026-08-10" }),
        game({ id: "c", title: "Just out", releaseDate: "2026-07-30" }),
        game({ id: "d", title: "Ancient", releaseDate: "2020-01-01" }),
        game({ id: "e", title: "Undated", status: "TBA", releaseDate: null }),
      ],
      now,
    );
    expect(entries.map((entry) => entry.game.id)).toEqual(["c", "b", "a"]);
    expect(entries[0]?.daysUntil).toBe(-4);
    expect(entries[0]?.kind).toBe("release");
    expect(entries[0]?.label).toBe("Release");
  });

  it("includes undated announcements only when asked, and puts them last", () => {
    const entries = buildGameUpcomingEntries(
      [
        game({ id: "e", title: "Undated", status: "TBA", releaseDate: null }),
        game({ id: "b", title: "Soon", releaseDate: "2026-08-10" }),
        game({ id: "f", title: "Out already", status: "Playing", releaseDate: null }),
      ],
      now,
      { includeUndated: true },
    );
    expect(entries.map((entry) => entry.game.id)).toEqual(["b", "e"]);
    expect(entries[1]?.date).toBeNull();
  });

  it("knows what has not come out yet without rewriting the status", () => {
    expect(isUnreleased(game({ releaseDate: "2026-12-01" }), now)).toBe(true);
    expect(isUnreleased(game({ releaseDate: "2020-01-01" }), now)).toBe(false);
    expect(isUnreleased(game({ releaseDate: null }), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IGDB result → game
// ---------------------------------------------------------------------------

function hit(overrides: Partial<GameSearchResult> = {}): GameSearchResult {
  return {
    id: "113112",
    source: "igdb",
    title: "Hades",
    summary: "A rogue-like dungeon crawler.",
    firstReleaseDate: 1600300800, // 2020-09-17
    coverUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg",
    platforms: ["PC (Microsoft Windows)", "Nintendo Switch"],
    genres: ["Role-playing (RPG)", "Indie"],
    developer: "Supergiant Games",
    ...overrides,
  };
}

describe("an IGDB result becomes a game", () => {
  const settings = migratedData().games?.settings;

  it("prefers a configured genre so the colour and the chip work", () => {
    expect(pickGameGenre(["Role-playing (RPG)", "Indie"], ["RPG", "Indie"])).toBe("RPG");
    expect(pickGameGenre(["Shooter"], ["RPG"])).toBe("Shooter");
    expect(pickGameGenre([], ["RPG"])).toBe("");
  });

  it("folds platform names onto the configured ones", () => {
    // "PC (Microsoft Windows)" and "Windows PC" are the same machine, and a
    // facet holding both is a filter that lies.
    expect(foldPlatforms(["PC (Microsoft Windows)"], ["Windows PC"])).toEqual(["Windows PC"]);
    expect(foldPlatforms(["Nintendo Switch"], ["Windows PC"])).toEqual(["Nintendo Switch"]);
  });

  it("fills the record from the result", () => {
    if (!settings) throw new Error("fixture has no games settings");
    const built = buildGameFromResult(hit(), {
      settings,
      takenIds: [],
      now: new Date(2026, 7, 3),
    });
    expect(built.title).toBe("Hades");
    expect(built.apiSource).toBe("igdb");
    expect(built.apiId).toBe("113112");
    expect(built.releaseDate).toBe("2020-09-17");
    expect(built.developer).toBe("Supergiant Games");
    expect(built.coverUrl).toContain("t_cover_big");
    expect(built.status).toBe(settings.defaultStatus);
  });

  it("marks something that has not come out yet as to be released", () => {
    const built = buildGameFromResult(
      // 2027-01-01
      hit({ firstReleaseDate: 1798761600, title: "Silksong 2" }),
      { settings: createGamesSettings(), takenIds: [], now: new Date(2026, 7, 3) },
    );
    expect(built.status).toBe("To be released");
  });

  it("never invents a status the user's settings do not have", () => {
    // The fixture's vault trimmed the status list to three; a future release
    // date must not conjure "To be released" back into existence.
    if (!settings) throw new Error("fixture has no games settings");
    expect(settings.statuses.map((status) => status.name)).not.toContain("To be released");
    const built = buildGameFromResult(hit({ firstReleaseDate: 1798761600 }), {
      settings,
      takenIds: [],
      now: new Date(2026, 7, 3),
    });
    expect(built.status).toBe(settings.defaultStatus);
  });

  it("spots a game already tracked, by IGDB id or by name", () => {
    const tracked = [
      createGame({ id: "hades", title: "Hades", apiSource: "igdb", apiId: "113112" }),
    ];
    expect(findExistingGame(tracked, { id: "113112", title: "Something else" })?.id).toBe("hades");
    expect(findExistingGame(tracked, { id: "999", title: "hades" })?.id).toBe("hades");
    expect(findExistingGame(tracked, { id: "999", title: "Prey" })).toBeUndefined();
  });
});
