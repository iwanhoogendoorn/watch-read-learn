/**
 * The Games tab, mounted.
 *
 * Not a screenshot test — the three things checked here are the ones that were
 * *reported* as "the tab looks broken" on other tabs: a grid that renders no
 * cells, an empty state that says the wrong thing, and an affordance offered for
 * something that is not configured. Plus the teardown, because a tab that leaks
 * its poster observer takes the detached DOM with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultSettings, createGame, createGamesData } from "../src/data/schema";
import { createGamesStore } from "../src/domains/games/store";
import { mountGamesTab } from "../src/domains/games/tab";
import { createHost, installDomGlobals, StubEl } from "./helpers/dom";
import type {
  Game,
  GamesData,
  IgdbClient,
  SteamClient,
  WatchLogData,
  WatchLogStoreApi,
} from "../src/types";

let restore: () => void;

/**
 * The stub DOM has no `ownerDocument`, and two shared components legitimately
 * want one: the virtual grid asks it for a scroll parent, and the filter drawer
 * registers its outside-click listener on it. One prototype property, removed
 * again afterwards, rather than a fork of the helper four lanes share.
 */
const OWNER_DOCUMENT = {
  defaultView: null,
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
};

beforeEach(() => {
  restore = installDomGlobals(900);
  (StubEl.prototype as unknown as Record<string, unknown>).ownerDocument = OWNER_DOCUMENT;
});

afterEach(() => {
  delete (StubEl.prototype as unknown as Record<string, unknown>).ownerDocument;
  restore();
});

function storeOf(games: Game[]): WatchLogStoreApi {
  const data: Partial<WatchLogData> = { games: { ...createGamesData(), games } };
  const settings = createDefaultSettings();
  return {
    data,
    settings,
    get games(): GamesData {
      return data.games as GamesData;
    },
    save: () => undefined,
    emitChanged: () => undefined,
    logActivity: () => undefined,
  } as unknown as WatchLogStoreApi;
}

function client(configured: boolean): IgdbClient & SteamClient {
  return {
    configured: () => configured,
    testConnection: async () => ({ ok: true, message: "" }),
    search: async () => [],
    details: async () => undefined,
    ownedGames: async () => [],
    achievements: async () => undefined,
  } as unknown as IgdbClient & SteamClient;
}

interface Mounted {
  el: StubEl;
  controller: ReturnType<typeof mountGamesTab>;
  host: StubEl;
}

function mount(games: Game[], options: { steam?: boolean; igdb?: boolean } = {}): Mounted {
  const host = createHost(900);
  const store = storeOf(games);
  const controller = mountGamesTab(host as unknown as HTMLElement, {
    app: {} as never,
    store,
    games: createGamesStore({ store }),
    ...(options.igdb === undefined ? {} : { igdb: client(options.igdb) }),
    ...(options.steam === undefined ? {} : { steam: client(options.steam) }),
  });
  return { el: controller.el as unknown as StubEl, controller, host };
}

const HADES = createGame({
  id: "hades",
  title: "Hades",
  type: "RPG",
  status: "Finished",
  platforms: ["Windows PC"],
  playtimeMinutes: 4210,
  achievementsEarned: 49,
  achievementsTotal: 49,
  rating: 5,
});

const SILKSONG = createGame({
  id: "silksong",
  title: "Hollow Knight: Silksong",
  type: "Platformer",
  status: "To be released",
  wishlist: true,
  releaseDate: "2026-12-01",
});

describe("the Games tab", () => {
  it("renders a card per game, with the two numbers a games library is for", () => {
    const { el } = mount([HADES, SILKSONG]);
    const cards = el.querySelectorAll(".wl-game-card");
    expect(cards).toHaveLength(2);

    const text = el.textContent ?? "";
    expect(text).toContain("Hades");
    expect(text).toContain("70 h"); // playtime, in hours
    expect(text).toContain("49 / 49"); // achievements
  });

  it("counts what is on screen and how long it took", () => {
    const { el } = mount([HADES, SILKSONG]);
    expect(el.querySelector(".wl-results-info")?.textContent).toBe("2 games");
    expect(el.querySelector(".wl-games-played")?.textContent).toContain("70 h played across 1 game");
  });

  it("tells a first-run user something different from a no-match one", () => {
    const empty = mount([]);
    expect(empty.el.querySelector(".is-first-run")?.textContent).toContain("No games tracked yet");
    expect(empty.el.querySelectorAll(".is-no-match")).toHaveLength(0);

    const filtered = mount([HADES]);
    filtered.controller.applyQuery("nothing matches this");
    expect(filtered.el.querySelector(".is-no-match")?.textContent).toContain("No games match");
    expect(filtered.el.querySelector(".wl-results-info")?.textContent).toBe("0 of 1 game");
  });

  it("filters live through the cross-tab query handoff", () => {
    const { el, controller } = mount([HADES, SILKSONG]);
    controller.applyQuery("wishlist:yes");
    expect(el.querySelectorAll(".wl-game-card")).toHaveLength(1);
    expect(el.textContent).toContain("Silksong");
    expect(el.textContent).not.toContain("Hades");
  });

  it("offers the Steam import only when Steam is configured", () => {
    // A button that can only ever say "add a key first" is a button that lies.
    expect(mount([HADES]).el.querySelectorAll(".wl-game-import-btn")).toHaveLength(0);
    expect(mount([HADES], { steam: false }).el.querySelectorAll(".wl-game-import-btn")).toHaveLength(0);
    expect(mount([HADES], { steam: true }).el.querySelectorAll(".wl-game-import-btn")).toHaveLength(1);
  });

  it("says search is optional when IGDB is not set up", () => {
    const without = mount([]);
    expect(without.el.querySelector(".is-first-run")?.textContent).toContain("optional");
    const with_ = mount([], { igdb: true });
    expect(with_.el.querySelector(".is-first-run")?.textContent).toContain("IGDB");
  });

  it("switches to a table with the columns a game has", () => {
    const { el } = mount([HADES]);
    const toggle = el.querySelector(".wl-view-toggle");
    toggle?.fire("click");
    const headers = el.querySelectorAll("th").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Game",
      "Genre",
      "Status",
      "Platforms",
      "Played",
      "Achievements",
      "Progress",
      "Rating",
    ]);
    expect(el.querySelectorAll(".wl-table-row")).toHaveLength(1);
  });

  it("persists the view mode where the next mount will find it", () => {
    const host = createHost(900);
    const store = storeOf([HADES]);
    const first = mountGamesTab(host as unknown as HTMLElement, {
      app: {} as never,
      store,
      games: createGamesStore({ store }),
    });
    (first.el as unknown as StubEl).querySelector(".wl-view-toggle")?.fire("click");
    first.destroy();

    const second = mountGamesTab(host as unknown as HTMLElement, {
      app: {} as never,
      store,
      games: createGamesStore({ store }),
    });
    expect((second.el as unknown as StubEl).querySelectorAll(".wl-table")).toHaveLength(1);
    second.destroy();
  });

  it("takes itself off the page when it is destroyed", () => {
    const { controller, host } = mount([HADES]);
    expect(host.children).toHaveLength(1);
    controller.destroy();
    expect(host.children).toHaveLength(0);
  });
});
