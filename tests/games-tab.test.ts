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
    const cards = el.querySelectorAll(".wl-card");
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
    expect(el.querySelectorAll(".wl-card")).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

/**
 * A game card is the Library's card.
 *
 * The Games tab used to draw its own: its own frame, its own scrim, its own
 * caption furniture in a `.wl-game-*` namespace that predated the dark-scrim
 * rework and therefore stopped matching the day that landed. Same grid, same
 * cell size, visibly different component. It renders into `buildPosterCard`
 * now, so there is one set of classes and no second stylesheet to forget.
 *
 * The stub has no layout engine, so nothing below is a screenshot. What it does
 * check is the thing a restyle actually breaks: which element carries which
 * class, what the caption is allowed to say, and that every affordance the card
 * had before is still on it.
 */
const DOOM = createGame({
  id: "doom",
  title: "DOOM",
  type: "Shooter",
  status: "Playing",
  releaseDate: "2016-05-13",
  platforms: ["Windows PC", "PS4", "Switch"],
  playtimeMinutes: 4210,
  achievementsEarned: 12,
  achievementsTotal: 49,
  rating: 4,
  favorite: true,
  storeUrl: "https://store.steampowered.com/app/379720",
});

/** No cover, no playtime, no achievements, no rating, no genre, no year. */
const BARE = createGame({ id: "bare", title: "Untitled" });

function cardFor(el: StubEl, title: string): StubEl {
  return el.querySelectorAll(".wl-card").find((c) => c.textContent?.includes(title)) as StubEl;
}

describe("a game card is the Library's card", () => {
  it("wears the same classes, which are declared once in 20-cards.css", () => {
    const { el } = mount([DOOM]);
    const card = cardFor(el, "DOOM");

    for (const cls of [
      ".wl-card-poster",
      ".wl-poster",
      ".wl-card-body",
      ".wl-card-title",
      ".wl-card-pills",
      ".wl-card-meta",
      ".wl-card-actions",
      ".wl-card-fav",
    ]) {
      expect(card.querySelectorAll(cls).length, `a game card is missing ${cls}`).toBe(1);
    }
    // And none of the furniture it used to build for itself.
    for (const cls of [".wl-game-card-body", ".wl-game-progress", ".wl-game-fav", ".wl-game-actions"]) {
      expect(card.querySelectorAll(cls).length, `${cls} is a leftover`).toBe(0);
    }
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabindex")).toBe("0");
    expect(card.getAttribute("aria-label")).toBe("DOOM — open details");
    expect(card.dataset.gameId).toBe("doom");
  });

  it("puts the caption rows in the same order a title card does", () => {
    const { el } = mount([DOOM]);
    const body = cardFor(el, "DOOM").querySelector(".wl-card-body") as StubEl;
    const rows = body.children.map((child) => child.className.split(" ")[0]);
    expect(rows.slice(0, 3)).toEqual(["wl-card-title", "wl-card-pills", "wl-card-meta"]);
  });

  it("paints the caption last, so the scrim sits over the artwork", () => {
    const { el } = mount([DOOM]);
    const wrap = cardFor(el, "DOOM").querySelector(".wl-card-poster") as StubEl;
    const last = wrap.children[wrap.children.length - 1] as StubEl;
    expect(last.className.split(" ")).toContain("wl-card-body");
  });

  it("says what a game has, and nothing a game does not", () => {
    const { el } = mount([DOOM]);
    const card = cardFor(el, "DOOM");

    expect(card.querySelector(".wl-card-title")?.textContent).toBe("DOOM");
    // Genre first (it is the short, pinned one), status second.
    expect(card.querySelectorAll(".wl-pill").map((p) => p.textContent)).toEqual([
      "Shooter",
      "Playing",
    ]);
    // The genre is NOT repeated in the meta line — the pill above already says it.
    const meta = card.querySelector(".wl-card-meta") as StubEl;
    expect(meta.textContent).toContain("2016");
    expect(meta.textContent).toContain("70 h");
    expect(meta.textContent).toContain("12 / 49");
    expect(meta.textContent).not.toContain("Shooter");
    // The two numbers keep their icons, on the meta line rather than a row of
    // their own — a row of their own is what made this caption a different
    // height from every other caption in the plugin.
    expect(meta.querySelectorAll(".wl-game-playtime")).toHaveLength(1);
    expect(meta.querySelectorAll(".wl-game-achievements")).toHaveLength(1);

    expect(card.querySelectorAll(".wl-stars")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-progress")).toHaveLength(1);
    // No episode counter, no Plex badge, no airing chip: a game has none of them.
    expect(card.querySelectorAll(".wl-plex-badge")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-card-airing")).toHaveLength(0);
    expect(card.textContent).not.toContain("eps");
  });

  it("spends the meta line on the platform only when there are no numbers to print", () => {
    // A wishlisted game has nothing played and nothing earned, so the line has
    // room for what it does have. A played one does not, and the achievements —
    // the number the card is most often for — must not be pushed off the end.
    const { el } = mount([
      createGame({ id: "hk", title: "Hollow Knight", releaseDate: "2017-02-24", platforms: ["Switch"] }),
      DOOM,
    ]);
    expect(cardFor(el, "Hollow Knight").querySelector(".wl-card-meta")?.textContent).toContain(
      "Switch",
    );
    expect(cardFor(el, "DOOM").querySelector(".wl-card-meta")?.textContent).not.toContain("Windows");
  });

  it("puts the wishlist badge in the shared badge slot, and nowhere when it is not wishlisted", () => {
    const { el } = mount([SILKSONG, DOOM]);
    const wanted = cardFor(el, "Silksong");
    const badges = wanted.querySelector(".wl-card-badges") as StubEl;
    expect(badges.querySelectorAll(".wl-game-badge")).toHaveLength(1);
    expect(badges.textContent).toContain("Wishlist");
    expect(wanted.hasClass("is-wishlist")).toBe(true);

    // An empty badge is worse than no badge: the shell removes the row.
    expect(cardFor(el, "DOOM").querySelectorAll(".wl-card-badges")).toHaveLength(0);
    expect(cardFor(el, "DOOM").hasClass("is-wishlist")).toBe(false);
  });

  it("keeps every affordance the card had before the restyle", () => {
    const { el } = mount([DOOM]);
    const card = cardFor(el, "DOOM");

    // Click and keyboard open the detail modal.
    expect(card.listeners.get("click") ?? []).toHaveLength(1);
    expect(card.listeners.get("keydown") ?? []).toHaveLength(1);
    // Right-clicking the artwork opens the same ⋮ menu the button does.
    const poster = card.querySelector(".wl-card-poster") as StubEl;
    expect(poster.listeners.get("contextmenu") ?? []).toHaveLength(1);

    const actions = card.querySelector(".wl-card-actions") as StubEl;
    expect(actions.children.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove from favourites",
      "Open the store page for DOOM",
      "More actions for DOOM",
    ]);
    expect(actions.children.every((b) => b.hasClass("wl-card-action"))).toBe(true);
    expect(actions.children[2]?.hasClass("wl-card-menu")).toBe(true);
    // The heart corner is drawn because the game is a favourite.
    expect(card.hasClass("is-favorite")).toBe(true);
  });

  it("offers the store button only when there is somewhere to go", () => {
    const { el } = mount([createGame({ id: "no-store", title: "No Store" })]);
    const actions = cardFor(el, "No Store").querySelector(".wl-card-actions") as StubEl;
    expect(actions.children.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Mark as favourite",
      "More actions for No Store",
    ]);
  });

  it("toggles the favourite from the card without opening anything", () => {
    const { el } = mount([DOOM]);
    const heart = cardFor(el, "DOOM").querySelector(".wl-card-actions")?.children[0] as StubEl;
    let stopped = false;
    let defaulted = false;
    heart.fire("click", {
      preventDefault: () => {
        defaulted = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });
    // A card action must never *also* open the detail modal, which is what the
    // shared `cardActionButton` guarantees by swallowing the event.
    expect(stopped).toBe(true);
    expect(defaulted).toBe(true);
    expect(cardFor(el, "DOOM").querySelector(".wl-card-actions")?.children[0]?.getAttribute(
      "aria-label",
    )).toBe("Mark as favourite");
  });
});

describe("a game with nothing in it", () => {
  it("renders cleanly — no empty pill, no NaN, no zero bar", () => {
    const { el } = mount([BARE]);
    const card = cardFor(el, "Untitled");

    expect(card).toBeDefined();
    expect(card.textContent).not.toContain("NaN");
    expect(card.textContent).not.toContain("undefined");
    // One pill: the status every game has. Nothing invents a blank genre chip.
    expect(card.querySelectorAll(".wl-pill").map((p) => p.textContent)).toEqual(["Not started"]);
    // The meta row is present and empty — present because every caption row
    // holds its height, empty because there is genuinely nothing to say.
    expect(card.querySelectorAll(".wl-card-meta")).toHaveLength(1);
    expect(card.querySelector(".wl-card-meta")?.textContent).toBe("");
    expect(card.querySelectorAll(".wl-game-playtime")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-game-achievements")).toHaveLength(0);
    // Absence reads as absence: the gap the stars would fill, not five hollow
    // stars, and no bar at all rather than one pinned at zero.
    expect(card.querySelectorAll(".wl-stars")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-card-rating-empty")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-progress")).toHaveLength(0);
    // No cover: a placeholder, never a broken image.
    expect(card.querySelectorAll(".wl-poster-img")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-poster.is-placeholder")).toHaveLength(1);
    // And no corner badge, because it is not wishlisted.
    expect(card.querySelectorAll(".wl-card-badges")).toHaveLength(0);
  });
});
