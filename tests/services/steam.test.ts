/**
 * The Steam client and the import it feeds — fixtures only, never the network.
 *
 * Two halves. The client is about reading Steam's two body-level failures
 * correctly (a private profile answers 200 with an empty `response`; a game with
 * no achievement schema answers 400 with `success: false`). The import plan is
 * about the promise the modal makes: **nothing the user owns is overwritten**,
 * and playtime only ever goes up.
 */
import { describe, expect, it } from "vitest";
import { createFakeHttp } from "../mocks/http";
import { createRateLimiter } from "../../src/services/ratelimit";
import {
  countAchievements,
  createSteamClient,
  mapOwnedGame,
  steamStoreUrl,
  steamTimestampToDate,
} from "../../src/services/steam";
import { createGame } from "../../src/data/schema";
import {
  findMatch,
  gameFromSteam,
  normalizeTitle,
  planSteamImport,
  selectedRows,
  summarize,
  summaryText,
} from "../../src/domains/games/steam-import";
import type { Game, SteamOwnedGame } from "../../src/types";

const OWNED = {
  response: {
    game_count: 3,
    games: [
      { appid: 1145360, name: "Hades", playtime_forever: 4300, rtime_last_played: 1730505600 },
      { appid: 548430, name: "Deep Rock Galactic", playtime_forever: 1800, rtime_last_played: 0 },
      { appid: 220, name: "Half-Life 2", playtime_forever: 0 },
    ],
  },
};

function build(routes: Parameters<typeof createFakeHttp>[0], credentials?: { apiKey: string; steamId: string }) {
  const fake = createFakeHttp(routes);
  const client = createSteamClient({
    credentials: () => credentials ?? { apiKey: "key", steamId: "76561198000000000" },
    http: fake.http,
    limiter: createRateLimiter(0),
  });
  return { client, fake };
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe("mapping Steam's rows", () => {
  it("keeps playtime in minutes, which is what a game record stores", () => {
    expect(mapOwnedGame({ appid: 220, name: "Half-Life 2", playtime_forever: 1234 })).toEqual({
      appId: "220",
      title: "Half-Life 2",
      playtimeMinutes: 1234,
      lastPlayed: null,
    });
  });

  it("reads `0` as never played rather than as 1 January 1970", () => {
    // The naive conversion would put every unplayed game at the top of a
    // "last played" sort and onto the Upcoming list's past window.
    expect(steamTimestampToDate(0)).toBeNull();
    expect(steamTimestampToDate(undefined)).toBeNull();
    expect(steamTimestampToDate(1730505600)).toBe("2024-11-02");
  });

  it("drops a row with no app id or no name", () => {
    expect(mapOwnedGame({ name: "Nameless" })).toBeNull();
    expect(mapOwnedGame({ appid: 5 })).toBeNull();
  });

  it("counts achievements from the achieved flag", () => {
    expect(
      countAchievements([{ achieved: 1 }, { achieved: 0 }, { achieved: 1 }]),
    ).toEqual({ earned: 2, total: 3 });
    expect(countAchievements(undefined)).toEqual({ earned: 0, total: 0 });
  });

  it("builds the store URL an imported game links to", () => {
    expect(steamStoreUrl("1145360")).toBe("https://store.steampowered.com/app/1145360/");
    expect(steamStoreUrl("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

describe("the owned-games call", () => {
  it("asks for app info and free games, with the key and the id", async () => {
    const { client, fake } = build({ GetOwnedGames: { body: OWNED } });
    const games = await client.ownedGames();

    expect(games.map((game) => game.title)).toEqual(["Hades", "Deep Rock Galactic", "Half-Life 2"]);
    expect(games[0]?.lastPlayed).toBe("2024-11-02");
    expect(games[1]?.lastPlayed).toBeNull();

    const url = fake.urls[0] ?? "";
    expect(url).toContain("include_appinfo=1");
    expect(url).toContain("include_played_free_games=1");
    expect(url).toContain("key=key");
    expect(url).toContain("steamid=76561198000000000");
  });

  it("says a private profile is private, not that the library is empty", async () => {
    // Steam answers 200 with `{"response":{}}` here. "Found 0 games" would send
    // the user looking for a bug that is a privacy setting.
    const { client } = build({ GetOwnedGames: { body: { response: {} } } });
    await expect(client.ownedGames()).rejects.toMatchObject({
      source: "steam",
      reason: "auth",
    });
    await expect(client.ownedGames()).rejects.toThrow(/privacy settings/);
  });

  it("refuses to call anything without a key and an id", async () => {
    const { client, fake } = build({ GetOwnedGames: { body: OWNED } }, { apiKey: "", steamId: "" });
    expect(client.configured()).toBe(false);
    await expect(client.ownedGames()).rejects.toMatchObject({ reason: "no-key" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the achievements call", () => {
  it("counts what the player earned", async () => {
    const { client } = build({
      GetPlayerAchievements: {
        body: {
          playerstats: {
            success: true,
            achievements: [{ achieved: 1 }, { achieved: 1 }, { achieved: 0 }],
          },
        },
      },
    });
    expect(await client.achievements("1145360")).toEqual({ earned: 2, total: 3 });
  });

  it("treats a game with no achievement schema as having none", async () => {
    // Steam answers 400 with `success: false` — an answer, not a failure, and a
    // 3,000-game import must not stop on it.
    const { client } = build({
      GetPlayerAchievements: {
        status: 400,
        body: { playerstats: { error: "Requested app has no stats", success: false } },
      },
    });
    expect(await client.achievements("220")).toBeUndefined();
  });

  it("swallows a per-game failure but reports a bad key", async () => {
    const server = build({ GetPlayerAchievements: { status: 500, body: {} } });
    expect(await server.client.achievements("220")).toBeUndefined();

    const auth = build({ GetPlayerAchievements: { status: 401, body: {} } });
    await expect(auth.client.achievements("220")).rejects.toMatchObject({ reason: "auth" });
  });
});

// ---------------------------------------------------------------------------
// The import plan
// ---------------------------------------------------------------------------

function owned(overrides: Partial<SteamOwnedGame> = {}): SteamOwnedGame {
  return {
    appId: "1145360",
    title: "Hades",
    playtimeMinutes: 4300,
    lastPlayed: "2024-11-02",
    ...overrides,
  };
}

function tracked(overrides: Partial<Game> = {}): Game {
  return createGame({ id: "hades", title: "Hades", ...overrides });
}

const OPTIONS = { defaultStatus: "Not started" };

describe("matching a Steam row to a game already tracked", () => {
  it("prefers the app id, then the name", () => {
    const byId = tracked({ id: "renamed", title: "Hades II", steamAppId: "1145360" });
    expect(findMatch(owned(), [byId])?.id).toBe("renamed");
    expect(findMatch(owned(), [tracked()])?.id).toBe("hades");
  });

  it("folds punctuation and case, so a hand-added game is not duplicated", () => {
    expect(normalizeTitle("Half-Life 2")).toBe(normalizeTitle("half life 2"));
    expect(findMatch(owned({ title: "Half-Life 2" }), [tracked({ title: "half life 2" })])).toBeDefined();
  });

  it("matches nothing when nothing matches", () => {
    expect(findMatch(owned({ title: "Prey" }), [tracked()])).toBeUndefined();
  });
});

describe("what the preview promises", () => {
  it("adds a game that is not tracked", () => {
    const [row] = planSteamImport([owned()], [], OPTIONS);
    expect(row?.action).toBe("add");
    expect(row?.selected).toBe(true);
  });

  it("only ever raises playtime", () => {
    // A larger number already in the tracker usually means another platform;
    // halving someone's hours is data loss, not an import.
    const higher = planSteamImport([owned({ playtimeMinutes: 100 })], [tracked({ playtimeMinutes: 4210, steamAppId: "1145360", storeUrl: "x" })], OPTIONS);
    expect(higher[0]?.patch.playtimeMinutes).toBeUndefined();

    const lower = planSteamImport([owned({ playtimeMinutes: 4300 })], [tracked({ playtimeMinutes: 4210, steamAppId: "1145360", storeUrl: "x" })], OPTIONS);
    expect(lower[0]?.patch.playtimeMinutes).toBe(4300);
    expect(lower[0]?.action).toBe("update");
  });

  it("never touches status, rating, priority, favourite or wishlist", () => {
    const existing = tracked({
      status: "Finished",
      rating: 5,
      priority: "High",
      favorite: true,
      wishlist: true,
      playtimeMinutes: 0,
    });
    const [row] = planSteamImport([owned()], [existing], OPTIONS);
    const patch = row?.patch ?? {};
    expect(Object.keys(patch).sort()).toEqual(["lastPlayed", "playtimeMinutes", "steamAppId", "storeUrl"]);
  });

  it("keeps a store URL the user chose", () => {
    const existing = tracked({ steamAppId: "1145360", storeUrl: "https://www.gog.com/game/hades", playtimeMinutes: 9999, lastPlayed: "2025-01-01" });
    const [row] = planSteamImport([owned()], [existing], OPTIONS);
    expect(row?.action).toBe("skip");
    expect(row?.changes).toEqual(["Already up to date"]);
    expect(row?.selected).toBe(false);
  });

  it("takes the later of the two last-played dates", () => {
    const existing = tracked({ steamAppId: "1145360", storeUrl: "x", playtimeMinutes: 9999, lastPlayed: "2025-06-01" });
    const [row] = planSteamImport([owned()], [existing], OPTIONS);
    expect(row?.patch.lastPlayed).toBeUndefined();
  });

  it("honours a minimum-playtime floor", () => {
    const rows = planSteamImport(
      [owned(), owned({ appId: "220", title: "Half-Life 2", playtimeMinutes: 0, lastPlayed: null })],
      [],
      { ...OPTIONS, minPlaytimeMinutes: 60 },
    );
    expect(rows.map((row) => row.owned.title)).toEqual(["Hades"]);
  });

  it("orders new games first, then updates, then what is already correct", () => {
    const rows = planSteamImport(
      [
        owned({ appId: "1", title: "Skip me", playtimeMinutes: 10 }),
        owned({ appId: "2", title: "Update me", playtimeMinutes: 500 }),
        owned({ appId: "3", title: "Add me", playtimeMinutes: 5 }),
      ],
      [
        tracked({ id: "skip", title: "Skip me", steamAppId: "1", storeUrl: "x", playtimeMinutes: 999, lastPlayed: "2025-01-01" }),
        tracked({ id: "update", title: "Update me", steamAppId: "2", storeUrl: "x", playtimeMinutes: 5 }),
      ],
      OPTIONS,
    );
    expect(rows.map((row) => row.action)).toEqual(["add", "update", "skip"]);
    expect(selectedRows(rows).map((row) => row.owned.title)).toEqual(["Add me", "Update me"]);
    expect(summaryText(summarize(rows))).toBe("1 added, 1 updated, 1 already up to date");
  });

  it("builds a complete game from a Steam row", () => {
    const game = gameFromSteam(owned(), OPTIONS, []);
    expect(game).toMatchObject({
      id: "hades",
      title: "Hades",
      status: "Not started",
      playtimeMinutes: 4300,
      lastPlayed: "2024-11-02",
      steamAppId: "1145360",
      storeUrl: "https://store.steampowered.com/app/1145360/",
      platforms: ["Windows PC"],
      singleplayer: true,
    });
  });

  it("gives two games with the same name different ids", () => {
    // Ids are slugs, and two games called Prey are not a hypothetical.
    const first = gameFromSteam(owned({ appId: "1", title: "Prey" }), OPTIONS, []);
    const second = gameFromSteam(owned({ appId: "2", title: "Prey" }), OPTIONS, [first]);
    expect(first.id).not.toBe(second.id);
  });

  it("says nothing to import when there is nothing to import", () => {
    expect(summaryText(summarize([]))).toBe("Nothing to import");
  });
});
