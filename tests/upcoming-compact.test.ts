/**
 * The compact Upcoming layout, mounted.
 *
 * Compact is what the tab opens as, and the detailed layout is a click away.
 * The first block is about that swap and about the thing that makes moving a
 * default safe: a stored value is a *decision*, and nothing but the toggle is
 * allowed to make one. The rest checks that the compact rows say true things
 * about every library's rows rather than only about episodes — the reference
 * plugin this is ported from only ever had TV — and that their availability
 * pills and actions are the detailed layout's, drawn smaller, from one function.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBook,
  createDefaultSettings,
  createGame,
  createGamesData,
  createGamesSettings,
  createReadingSettings,
  createTitle,
} from "../src/data/schema";
import { mountUpcomingTab } from "../src/ui/tabs/upcoming";
import {
  DEFAULT_UPCOMING_LAYOUT,
  readUpcomingLayout,
  readUpcomingLayoutChoice,
  readUpcomingViewState,
  writeUpcomingLayout,
  writeUpcomingViewState,
} from "../src/domains/upcoming/filters";
import type { UnifiedRow } from "../src/domains/upcoming/unified";
import { createHost, installDomGlobals, StubEl } from "./helpers/dom";
import { MediaStatus } from "../src/types";
import type {
  GamesData,
  ReadingData,
  Settings,
  TitleV4,
  WatchLogData,
  WatchLogStoreApi,
} from "../src/types";

let restore: () => void;

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

function storeOf(
  titles: TitleV4[],
  readingData: ReadingData,
  gamesData: GamesData,
  settings: Settings,
): WatchLogStoreApi & { saves: string[] } {
  const data: Partial<WatchLogData> = { titles, reading: readingData, games: gamesData, settings };
  const saves: string[] = [];
  return {
    data,
    settings,
    saves,
    get reading(): ReadingData {
      return data.reading as ReadingData;
    },
    get games(): GamesData {
      return data.games as GamesData;
    },
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((title) => title.id === id),
    save: (reason: string) => saves.push(reason),
    emitChanged: () => undefined,
    logActivity: () => undefined,
  } as unknown as WatchLogStoreApi & { saves: string[] };
}

/** Severance: next episode Thursday 6 August, one week after the last one. */
const SEVERANCE = createTitle({
  id: "severance",
  title: "Severance",
  type: "TV Show",
  airing: {
    lastEpisode: { season: 3, episode: 7, airDate: "2026-07-30" },
    nextEpisode: { season: 3, episode: 8, airDate: "2026-08-06", name: "Gray Goo" },
  },
  plex: { state: "available" },
});

/** Aired three days ago — the past-window tail. */
const OLD_NEWS = createTitle({
  id: "old",
  title: "Old News",
  type: "TV Show",
  airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
});

/** Announced with no date at all — the "TBA" row. */
const UNDATED = createTitle({
  id: "undated",
  title: "Undated Show",
  type: "TV Show",
  airing: { pendingSeason: { number: 4, episodes: 0 } },
});

/** Half-scanned: the pill that doubles as a progress reading, "3/32 eps". */
const PARTIAL = createTitle({
  id: "partial",
  title: "Partly There",
  type: "TV Show",
  totalEpisodes: 32,
  airing: { nextEpisode: { season: 2, episode: 4, airDate: "2026-08-11" } },
  plex: { state: "partial", leafCount: 3 },
});

/** Scanned, genuinely absent, never requested — the Request row. */
const MISSING = createTitle({
  id: "missing",
  title: "Missing Film",
  type: "Movie",
  releaseDate: "2026-08-14",
  plex: { state: "none" },
});

/** Requested and picked up by Radarr — waiting, not askable. */
const QUEUED = createTitle({
  id: "queued",
  title: "On The Way",
  type: "Movie",
  releaseDate: "2026-08-17",
  plex: { state: "none" },
  request: { id: 11, status: 2, mediaStatus: MediaStatus.PROCESSING },
});

const BOOK = createBook({ id: "book", title: "A Book", author: "R. Author", releaseDate: "2026-09-08" });
const GAME = createGame({
  id: "game",
  title: "A Game",
  status: "To be released",
  releaseDate: "2027-02-19",
});

interface Mounted {
  el: StubEl;
  controller: ReturnType<typeof mountUpcomingTab>;
  store: WatchLogStoreApi & { saves: string[] };
  settings: Settings;
  exported: UnifiedRow[];
  /** What each affordance hook was actually called with. */
  fired: { plex: string[]; requested: string[]; acknowledged: string[]; seasons: number[] };
}

function mount(
  titles: TitleV4[],
  options: {
    books?: boolean;
    games?: boolean;
    settings?: Settings;
    rowExport?: boolean;
    /** Wire the Plex/request/acknowledge/season hooks. Off by default. */
    actions?: boolean;
  } = {},
): Mounted {
  const host = createHost(900);
  const settings = options.settings ?? createDefaultSettings();
  const store = storeOf(
    titles,
    reading(options.books ? { books: [BOOK] } : {}),
    { ...createGamesData(), games: options.games ? [GAME] : [], settings: createGamesSettings() },
    settings,
  );
  const exported: UnifiedRow[] = [];
  const fired: Mounted["fired"] = { plex: [], requested: [], acknowledged: [], seasons: [] };
  const controller = mountUpcomingTab(host as unknown as HTMLElement, {
    store,
    now: () => NOW,
    ...(options.rowExport ? { onExportRowCalendar: (row: UnifiedRow) => exported.push(row) } : {}),
    ...(options.actions
      ? {
          onOpenInPlex: (title: TitleV4) => fired.plex.push(title.title),
          onRequest: (title: TitleV4) => fired.requested.push(title.title),
          onAcknowledge: (title: TitleV4) => fired.acknowledged.push(title.title),
          onAddSeason: (_title: TitleV4, season: number) => fired.seasons.push(season),
        }
      : {}),
  });
  return { el: controller.el as unknown as StubEl, controller, store, settings, exported, fired };
}

/** Settings carrying an explicit "detailed" choice, for the two-layout compare. */
function detailedSettings(): Settings {
  const settings = createDefaultSettings();
  writeUpcomingLayout(settings, "detailed");
  return settings;
}

function layoutButton(el: StubEl): StubEl {
  const button = el.querySelector(".wl-upcoming-layout");
  if (!button) throw new Error("no layout button");
  return button;
}

/** Every compact row's headline, in render order. */
function compactNames(el: StubEl): string[] {
  return el
    .querySelectorAll(".wl-upcoming-compact-row")
    .map((row) => row.querySelector(".wl-upcoming-name")?.textContent ?? "");
}

function monthHeadings(el: StubEl): string[] {
  return el.querySelectorAll(".wl-upcoming-month-label").map((node) => node.textContent ?? "");
}

describe("the layout preference", () => {
  it("opens compact, which is what the tab is for", () => {
    expect(DEFAULT_UPCOMING_LAYOUT).toBe("compact");
    expect(readUpcomingLayout(createDefaultSettings())).toBe("compact");

    const { el } = mount([SEVERANCE], { books: true, games: true });
    // The compact rows under their month headings, and no detailed anything.
    expect(el.querySelectorAll(".wl-upcoming-compact-row").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-month-label").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-row")).toHaveLength(0);
    expect(el.querySelectorAll(".wl-upcoming-group-label")).toHaveLength(0);
  });

  it("reads an absent or unreadable stored value as no choice at all", () => {
    expect(readUpcomingLayoutChoice(createDefaultSettings())).toBeNull();

    const settings = createDefaultSettings();
    (settings as unknown as Record<string, unknown>)["v4UpcomingView"] = { layout: "hologram" };
    // Not a layout, so not a decision — and the default therefore still applies.
    expect(readUpcomingLayoutChoice(settings)).toBeNull();
    expect(readUpcomingLayout(settings)).toBe("compact");
  });

  it("keeps a reader who explicitly chose detailed on detailed", () => {
    // The point of the whole tri-state: moving the default must never overrule
    // somebody who already answered the question.
    const settings = createDefaultSettings();
    writeUpcomingLayout(settings, "detailed");
    expect(readUpcomingLayoutChoice(settings)).toBe("detailed");

    const { el } = mount([SEVERANCE], { settings });
    expect(layoutButton(el).dataset.layout).toBe("detailed");
    expect(el.querySelectorAll(".wl-upcoming-row").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-compact-row")).toHaveLength(0);
  });

  it("does not turn the default into a choice just because the view was saved", () => {
    // This is what makes the default safe to move again. Searching or filtering
    // persists the view, and if that write stamped the *drawn* layout in, every
    // reader would silently acquire a preference they never expressed.
    const settings = createDefaultSettings();
    const { el, controller, store } = mount([SEVERANCE, OLD_NEWS], { settings });

    el.querySelector(".wl-filters-btn")?.fire("click");
    const chip = el
      .querySelectorAll(".wl-filter-chip")
      .find((node) => (node.textContent ?? "").startsWith("Next 7 days"));
    chip?.fire("click");
    // …and the teardown flush too, which is the other write nobody asks for.
    controller.destroy();

    expect(store.saves.some((reason) => reason.startsWith("upcoming"))).toBe(true);
    expect(readUpcomingViewState(settings).filters.window).toBe("7d");
    // The filter was recorded. The layout was not.
    expect(readUpcomingLayoutChoice(settings)).toBeNull();
  });

  it("switches to the detailed layout and back from the toolbar", () => {
    const { el } = mount([SEVERANCE], { books: true, games: true });
    const button = layoutButton(el);

    expect(button.dataset.layout).toBe("compact");
    expect(button.getAttribute("aria-label")).toBe("Switch to the detailed layout");

    button.fire("click");
    expect(button.dataset.layout).toBe("detailed");
    expect(button.getAttribute("aria-label")).toBe("Switch to the compact layout");
    expect(el.querySelectorAll(".wl-upcoming-row").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-compact-row")).toHaveLength(0);

    button.fire("click");
    expect(button.dataset.layout).toBe("compact");
    expect(el.querySelectorAll(".wl-upcoming-row")).toHaveLength(0);
    expect(el.querySelectorAll(".wl-upcoming-compact-row").length).toBeGreaterThan(0);
  });

  it("persists the choice, and a remount comes back in it", () => {
    const settings = createDefaultSettings();
    const first = mount([SEVERANCE], { settings });
    layoutButton(first.el).fire("click");
    expect(first.store.saves).toContain("upcoming-layout");
    // Pressing the button IS the decision, so now there is one.
    expect(readUpcomingLayoutChoice(settings)).toBe("detailed");
    first.controller.destroy();

    const second = mount([SEVERANCE], { settings });
    expect(layoutButton(second.el).dataset.layout).toBe("detailed");
    expect(second.el.querySelectorAll(".wl-upcoming-row").length).toBeGreaterThan(0);
  });

  it("is not captured by a saved view — a preset is a question, not a density", () => {
    const settings = createDefaultSettings();
    writeUpcomingLayout(settings, "detailed");
    const state = readUpcomingViewState(settings);
    expect(state.layout).toBe("detailed");
    // Nothing preset-shaped carries it.
    expect(Object.keys(state).includes("layout")).toBe(true);
    expect(JSON.stringify(state.presets)).toBe("[]");

    // …and writing the whole view back keeps it, rather than resetting it.
    writeUpcomingViewState(settings, state);
    expect(readUpcomingLayout(settings)).toBe("detailed");
  });
});

describe("the compact layout", () => {
  /** Compact is simply what mounts now; the helper survives as a name. */
  function compact(titles: TitleV4[], options: Parameters<typeof mount>[1] = {}): Mounted {
    return mount(titles, options);
  }

  it("groups every library's rows under month headings with a count", () => {
    const { el } = compact([SEVERANCE, OLD_NEWS], { books: true, games: true });

    // August holds the row that aired on the 31st of July? No — it holds the
    // 6th; July's arrival gets July's heading, because a month is a month.
    expect(monthHeadings(el)).toEqual([
      "July 2026 (1)",
      "August 2026 (1)",
      "September 2026 (1)",
      "February 2027 (1)",
    ]);
    expect(compactNames(el)).toEqual(["Old News", "Severance", "A Book", "A Game"]);
  });

  it("gives an undated row a trailing group rather than a made-up month", () => {
    const { el } = compact([SEVERANCE, UNDATED]);
    expect(monthHeadings(el)).toEqual(["August 2026 (1)", "Announced — no date yet (1)"]);

    const rows = el.querySelectorAll(".wl-upcoming-compact-row");
    const undated = rows[rows.length - 1];
    expect(undated?.querySelector(".wl-upcoming-countdown-value")?.textContent).toBe("TBA");
    expect(undated?.querySelector(".wl-upcoming-countdown-unit")).toBeNull();
  });

  it("puts the countdown up as a number and a unit", () => {
    const { el } = compact([SEVERANCE]);
    const countdown = el.querySelector(".wl-upcoming-countdown");
    expect(countdown?.querySelector(".wl-upcoming-countdown-value")?.textContent).toBe("3");
    expect(countdown?.querySelector(".wl-upcoming-countdown-unit")?.textContent).toBe("days");
  });

  it("states a cadence only for the row whose data evidences one", () => {
    const { el } = compact([SEVERANCE, OLD_NEWS], { books: true, games: true });
    const cadences = el
      .querySelectorAll(".wl-upcoming-compact-row")
      .map((row) => row.querySelector(".wl-upcoming-compact-cadence")?.textContent ?? null);

    // Old News has no `lastEpisode`; the book and the game have no cadence at
    // all. Severance has two consecutive Thursdays.
    expect(cadences).toEqual([null, "Every Thursday", null, null]);
  });

  it("names what each row is, in its own library's word", () => {
    const { el } = compact([SEVERANCE], { books: true, games: true });
    const chips = el
      .querySelectorAll(".wl-upcoming-compact-row")
      .map((row) => row.querySelector(".wl-upcoming-compact-chip")?.textContent ?? "");
    expect(chips).toEqual(["TV Show", "Book", "Game"]);
  });

  it("carries the episode code and its name", () => {
    const { el } = compact([SEVERANCE]);
    const meta = el.querySelector(".wl-upcoming-compact-meta")?.textContent ?? "";
    expect(meta).toContain("S03E08");
    expect(meta).toContain("Gray Goo");
  });

  it("offers the Google Calendar link on a dated row and none on an undated one", () => {
    const { el } = compact([SEVERANCE, UNDATED]);
    const rows = el.querySelectorAll(".wl-upcoming-compact-row");

    const dated = rows[0]?.querySelector(".wl-upcoming-gcal");
    expect(dated?.getAttribute("href")).toContain("calendar.google.com");
    expect(dated?.getAttribute("aria-label")).toContain("Severance");

    // A create-event form with no date in it looks like it worked. No link.
    expect(rows[rows.length - 1]?.querySelector(".wl-upcoming-gcal")).toBeNull();
  });

  it("offers the per-row .ics export only when a host wired one", () => {
    const without = compact([SEVERANCE]);
    expect(without.el.querySelectorAll(".wl-upcoming-compact-action")).toHaveLength(1);

    const withExport = compact([SEVERANCE], { rowExport: true });
    const actions = withExport.el.querySelectorAll(".wl-upcoming-compact-action");
    expect(actions).toHaveLength(2);
    actions[1]?.fire("click", { stopPropagation: () => undefined });
    expect(withExport.exported.map((row) => row.name)).toEqual(["Severance"]);
  });

  it("goes flat when the sort is not chronological — a month heading would be a lie", () => {
    const settings = createDefaultSettings();
    const state = readUpcomingViewState(settings);
    state.layout = "compact";
    state.sort = { key: "title", direction: "asc" };
    writeUpcomingViewState(settings, state);

    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true, settings });
    expect(compactNames(el)).toEqual(["A Book", "A Game", "Old News", "Severance"]);
    // Alphabetical order interleaves the months, so there are no headings.
    expect(monthHeadings(el)).toEqual([]);
  });

  it("still respects the filters and the search box", () => {
    const { el } = compact([SEVERANCE, OLD_NEWS], { books: true, games: true });
    expect(compactNames(el)).toHaveLength(4);

    el.querySelector(".wl-filters-btn")?.fire("click");
    const chip = el
      .querySelectorAll(".wl-filter-chip")
      .find((node) => (node.textContent ?? "").startsWith("Games"));
    chip?.fire("click");
    expect(compactNames(el)).toEqual(["Old News", "Severance", "A Book"]);
  });
});

/**
 * The compact row's availability and actions.
 *
 * The point of these is not that the compact layout draws pills — it is that it
 * draws the SAME pills and the SAME actions the detailed layout does, because
 * both ask `upcomingRowAffordances` and neither decides anything itself. The
 * last test in this block is the one that would catch a second copy appearing.
 */
describe("the compact row's availability and actions", () => {
  /** The pills on the compact row whose title is `name`. */
  function pillsOf(el: StubEl, name: string): string[] {
    return rowNamed(el, name)
      .querySelectorAll(".wl-pill")
      .map((pill) => pill.textContent ?? "");
  }

  /**
   * The affordance buttons on that row.
   *
   * Picked out of the action strip by their `data-action`, which the calendar
   * links do not carry — the stub DOM matches classes and nothing else, so the
   * attribute is read rather than selected on.
   */
  function actionButtons(el: StubEl, name: string): StubEl[] {
    return rowNamed(el, name)
      .querySelectorAll(".wl-upcoming-compact-action")
      .filter((button) => button.getAttribute("data-action") !== null);
  }

  function actionsOf(el: StubEl, name: string): string[] {
    return actionButtons(el, name).map((button) => button.getAttribute("data-action") ?? "");
  }

  function rowNamed(el: StubEl, name: string): StubEl {
    const row = el
      .querySelectorAll(".wl-upcoming-compact-row")
      .find((node) => node.querySelector(".wl-upcoming-name")?.textContent === name);
    if (!row) throw new Error(`no compact row for “${name}”`);
    return row;
  }

  function click(el: StubEl, name: string, action: string): void {
    const button = actionButtons(el, name).find(
      (node) => node.getAttribute("data-action") === action,
    );
    if (!button) throw new Error(`no “${action}” on the row for “${name}”`);
    button.fire("click", { stopPropagation: () => undefined });
  }

  it("carries the progress pill and the way to watch it", () => {
    const { el } = mount([PARTIAL], { actions: true });
    // "3/32 eps" is the progress reading and the availability answer at once.
    expect(pillsOf(el, "Partly There")).toEqual(["3/32 eps"]);
    expect(actionsOf(el, "Partly There")).toEqual(["open-plex"]);
  });

  it("says On Plex, and never offers to request what is already there", () => {
    const { el } = mount([SEVERANCE], { actions: true });
    expect(pillsOf(el, "Severance")).toEqual(["On Plex"]);
    expect(actionsOf(el, "Severance")).toEqual(["open-plex"]);
  });

  it("offers Request exactly where the title is absent and nothing is coming", () => {
    const { el } = mount([MISSING], { actions: true });
    expect(pillsOf(el, "Missing Film")).toEqual(["Not on Plex"]);
    expect(actionsOf(el, "Missing Film")).toEqual(["request"]);
  });

  it("says Queued for download and offers no button — waiting is the action", () => {
    const { el } = mount([QUEUED], { actions: true });
    expect(pillsOf(el, "On The Way")).toEqual(["Queued for download"]);
    // Overseerr's own word explains rather than competes.
    expect(
      rowNamed(el, "On The Way").querySelector(".wl-pill")?.getAttribute("title"),
    ).toContain("Processing");
    expect(actionsOf(el, "On The Way")).toEqual([]);
  });

  it("never requests anything without an explicit click", () => {
    const { el, fired } = mount([MISSING], { actions: true });
    // Rendering the button must not be the same as pressing it.
    expect(fired.requested).toEqual([]);
    click(el, "Missing Film", "request");
    expect(fired.requested).toEqual(["Missing Film"]);
  });

  it("wires the Plex, season and acknowledge actions to the same hooks", () => {
    const { el, fired } = mount([SEVERANCE, UNDATED, OLD_NEWS], { actions: true });

    click(el, "Severance", "open-plex");
    expect(fired.plex).toEqual(["Severance"]);

    // An announced season the tracker does not have: adopt it, do not request it.
    expect(actionsOf(el, "Undated Show")).toContain("add-season");
    click(el, "Undated Show", "add-season");
    expect(fired.seasons).toEqual([4]);

    // Already aired, so it is due, so there is a way to clear it.
    expect(actionsOf(el, "Old News")).toContain("acknowledge");
    click(el, "Old News", "acknowledge");
    expect(fired.acknowledged).toEqual(["Old News"]);
  });

  it("draws no button a host did not wire", () => {
    // Same rows, no hooks. Pills are facts and stay; buttons are offers and go.
    const { el } = mount([SEVERANCE, MISSING]);
    expect(pillsOf(el, "Severance")).toEqual(["On Plex"]);
    expect(actionsOf(el, "Severance")).toEqual([]);
    expect(actionsOf(el, "Missing Film")).toEqual([]);
  });

  it("gives a book, a game and a TBA row no empty pill and no dead button", () => {
    const { el } = mount([UNDATED], { books: true, games: true, actions: true });

    // Neither other library has a Plex state or a request to make, so neither
    // gets the container at all — an empty pill would be a claim about nothing.
    for (const name of ["A Book", "A Game"]) {
      expect(rowNamed(el, name).querySelectorAll(".wl-upcoming-compact-states")).toHaveLength(0);
      expect(actionsOf(el, name)).toEqual([]);
      // …and they keep the calendar action they always had.
      expect(rowNamed(el, name).querySelectorAll(".wl-upcoming-gcal")).toHaveLength(1);
    }

    // The undated row is a watchlist row, so it does state availability — but it
    // has no date, so it gets no calendar link.
    expect(pillsOf(el, "Undated Show")).toEqual(["Not on Plex"]);
    expect(rowNamed(el, "Undated Show").querySelectorAll(".wl-upcoming-gcal")).toHaveLength(0);
  });

  it("agrees with the detailed layout, row for row", () => {
    // The whole reason `upcomingRowAffordances` exists. If a second copy of the
    // "which buttons does this row deserve" rule ever appears, this is what
    // fails — the two layouts would start disagreeing about the same title.
    const titles = [SEVERANCE, PARTIAL, MISSING, QUEUED, OLD_NEWS, UNDATED];
    const compactMount = mount(titles, { actions: true });
    const detailedMount = mount(titles, { actions: true, settings: detailedSettings() });

    for (const title of titles) {
      const name = title.title;
      const detailedRow = detailedMount.el
        .querySelectorAll(".wl-upcoming-row")
        .find((node) => node.querySelector(".wl-upcoming-name")?.textContent === name);
      if (!detailedRow) throw new Error(`no detailed row for “${name}”`);

      expect(pillsOf(compactMount.el, name)).toEqual(
        detailedRow.querySelectorAll(".wl-pill").map((pill) => pill.textContent ?? ""),
      );

      // The detailed layout words its buttons; the compact one draws the same
      // decision as icons and keeps the wording in `aria-label`.
      const detailedLabels = detailedRow
        .querySelectorAll(".wl-mini-btn")
        // The "Add to Calendar" anchor shares the class and is not an affordance.
        .filter((button) => !button.classes.has("wl-upcoming-gcal"))
        .map((button) => button.getAttribute("aria-label") ?? "");
      const compactLabels = actionButtons(compactMount.el, name).map(
        (button) => button.getAttribute("aria-label") ?? "",
      );
      expect(compactLabels).toEqual(detailedLabels);
    }
  });
});
