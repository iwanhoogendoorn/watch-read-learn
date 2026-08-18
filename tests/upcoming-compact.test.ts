/**
 * The compact Upcoming layout, mounted.
 *
 * The layout is an **option**, and that is what most of this file checks: the
 * detailed layout is what mounts by default, it is untouched by the new code,
 * and the switch is a preference that survives a remount. The rest checks that
 * the compact rows say true things about every library's rows rather than only
 * about episodes — the reference plugin this is ported from only ever had TV.
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
  readUpcomingViewState,
  writeUpcomingLayout,
  writeUpcomingViewState,
} from "../src/domains/upcoming/filters";
import type { UnifiedRow } from "../src/domains/upcoming/unified";
import { createHost, installDomGlobals, StubEl } from "./helpers/dom";
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
}

function mount(
  titles: TitleV4[],
  options: {
    books?: boolean;
    games?: boolean;
    settings?: Settings;
    rowExport?: boolean;
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
  const controller = mountUpcomingTab(host as unknown as HTMLElement, {
    store,
    now: () => NOW,
    ...(options.rowExport ? { onExportRowCalendar: (row: UnifiedRow) => exported.push(row) } : {}),
  });
  return { el: controller.el as unknown as StubEl, controller, store, settings, exported };
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
  it("defaults to the layout the tab has always drawn", () => {
    expect(DEFAULT_UPCOMING_LAYOUT).toBe("detailed");
    expect(readUpcomingLayout(createDefaultSettings())).toBe("detailed");

    const { el } = mount([SEVERANCE], { books: true, games: true });
    // The detailed rows, its relative-time buckets, and no compact anything.
    expect(el.querySelectorAll(".wl-upcoming-row").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-group-label").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-compact-row")).toHaveLength(0);
    expect(el.querySelectorAll(".wl-upcoming-month-label")).toHaveLength(0);
  });

  it("survives an unreadable or absent stored value", () => {
    const settings = createDefaultSettings();
    (settings as unknown as Record<string, unknown>)["v4UpcomingView"] = { layout: "hologram" };
    expect(readUpcomingLayout(settings)).toBe("detailed");
  });

  it("switches to the compact layout and back from the toolbar", () => {
    const { el } = mount([SEVERANCE], { books: true, games: true });
    const button = layoutButton(el);

    expect(button.dataset.layout).toBe("detailed");
    expect(button.getAttribute("aria-label")).toBe("Switch to the compact layout");

    button.fire("click");
    expect(button.dataset.layout).toBe("compact");
    expect(button.getAttribute("aria-label")).toBe("Switch to the detailed layout");
    expect(el.querySelectorAll(".wl-upcoming-compact-row").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-upcoming-row")).toHaveLength(0);

    button.fire("click");
    expect(button.dataset.layout).toBe("detailed");
    expect(el.querySelectorAll(".wl-upcoming-compact-row")).toHaveLength(0);
    expect(el.querySelectorAll(".wl-upcoming-row").length).toBeGreaterThan(0);
  });

  it("persists the choice, and a remount comes back in it", () => {
    const settings = createDefaultSettings();
    const first = mount([SEVERANCE], { settings });
    layoutButton(first.el).fire("click");
    expect(first.store.saves).toContain("upcoming-layout");
    expect(readUpcomingLayout(settings)).toBe("compact");
    first.controller.destroy();

    const second = mount([SEVERANCE], { settings });
    expect(layoutButton(second.el).dataset.layout).toBe("compact");
    expect(second.el.querySelectorAll(".wl-upcoming-compact-row").length).toBeGreaterThan(0);
  });

  it("is not captured by a saved view — a preset is a question, not a density", () => {
    const settings = createDefaultSettings();
    writeUpcomingLayout(settings, "compact");
    const state = readUpcomingViewState(settings);
    expect(state.layout).toBe("compact");
    // Nothing preset-shaped carries it.
    expect(Object.keys(state).includes("layout")).toBe(true);
    expect(JSON.stringify(state.presets)).toBe("[]");

    // …and writing the whole view back keeps it, rather than resetting it.
    writeUpcomingViewState(settings, state);
    expect(readUpcomingLayout(settings)).toBe("compact");
  });
});

describe("the compact layout", () => {
  function compact(titles: TitleV4[], options: Parameters<typeof mount>[1] = {}): Mounted {
    const mounted = mount(titles, options);
    layoutButton(mounted.el).fire("click");
    return mounted;
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
