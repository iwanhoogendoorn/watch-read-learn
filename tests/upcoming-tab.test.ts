/**
 * The Upcoming tab, mounted.
 *
 * It was the only tab without a toolbar, so what is checked here is that the
 * toolbar is real rather than decorative: the facets actually narrow the list,
 * the counter says how much was narrowed, the two empty states are told apart,
 * and the whole view survives a remount because it was persisted.
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
  readUpcomingViewState,
  writeUpcomingViewState,
} from "../src/domains/upcoming/filters";
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

/**
 * The stub DOM has no `ownerDocument`, and the shared filter panel legitimately
 * wants one for its outside-click listener. One prototype property, removed
 * again afterwards, rather than a fork of the helper every lane shares.
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
  readingData: ReadingData = reading(),
  gamesData: GamesData = { ...createGamesData(), settings: createGamesSettings() },
  settings: Settings = createDefaultSettings(),
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

const SEVERANCE = createTitle({
  id: "severance",
  title: "Severance",
  type: "TV Show",
  airing: { nextEpisode: { season: 2, episode: 3, airDate: "2026-08-05", name: "The Grid" } },
  plex: { state: "available" },
});

const OLD_NEWS = createTitle({
  id: "old",
  title: "Old News",
  type: "TV Show",
  airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
  plex: { state: "none" },
});

const BOOK = createBook({ id: "book", title: "A Book", releaseDate: "2026-08-08" });
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
}

function mount(
  titles: TitleV4[],
  options: { books?: boolean; games?: boolean; settings?: Settings; app?: boolean } = {},
): Mounted {
  const host = createHost(900);
  const store = storeOf(
    titles,
    reading(options.books ? { books: [BOOK] } : {}),
    { ...createGamesData(), games: options.games ? [GAME] : [] },
    options.settings ?? createDefaultSettings(),
  );
  const controller = mountUpcomingTab(host as unknown as HTMLElement, {
    store,
    now: () => NOW,
    // The modals need an app; a host that wires none still gets a working tab.
    ...(options.app ? { app: {} as never } : {}),
  });
  return { el: controller.el as unknown as StubEl, controller, store };
}

/** Every row's headline, in render order. */
function rowNames(el: StubEl): string[] {
  return el.querySelectorAll(".wl-upcoming-name").map((node) => node.textContent ?? "");
}

function counter(el: StubEl): string {
  return el.querySelector(".wl-results-info")?.textContent ?? "";
}

/** Open the filter drawer and click a chip by its visible label. */
function clickChip(el: StubEl, label: string): void {
  el.querySelector(".wl-filters-btn")?.fire("click");
  const chip = el
    .querySelectorAll(".wl-filter-chip")
    .find((node) => (node.textContent ?? "").startsWith(label));
  if (!chip) throw new Error(`no filter chip labelled “${label}”`);
  chip.fire("click");
}

describe("the Upcoming toolbar", () => {
  it("mounts search, filters and sort — the same toolbar the other tabs have", () => {
    const { el } = mount([SEVERANCE]);
    expect(el.querySelectorAll(".wl-searchbox")).toHaveLength(1);
    expect(el.querySelectorAll(".wl-filters-btn")).toHaveLength(1);
    expect(el.querySelectorAll(".wl-sort-btn")).toHaveLength(1);
    expect(el.querySelector(".wl-sort-btn")?.textContent).toContain("Air / release date");
  });

  it("lists every library in one chronological list", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    // Still to come, soonest first — then the past-window tail, on its own.
    expect(rowNames(el)).toEqual(["Severance", "A Book", "A Game", "Old News"]);
    expect(counter(el)).toBe("3 upcoming · 1 recently released");
    expect(el.querySelector(".wl-upcoming-summary")?.textContent).toContain("1 due");
  });

  it("narrows the list from the facet panel, and says so in the counter", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    clickChip(el, "Games");
    expect(rowNames(el)).toEqual(["Severance", "A Book", "Old News"]);
    expect(counter(el)).toBe("2 of 3 upcoming · 1 recently released");
    // The dot and the clear button are the always-on signal that a filter is on.
    expect(el.querySelector(".wl-filters-dot")?.hasClass("is-visible")).toBe(true);
    expect(el.querySelector(".wl-filters-clear")?.hasClass("is-visible")).toBe(true);
  });

  it("filters to a time window, which excludes the aired backlog", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    clickChip(el, "Next 7 days");
    expect(rowNames(el)).toEqual(["Severance", "A Book"]);
    expect(counter(el)).toBe("2 of 3 upcoming");
    // A forward window is the one case where the released section is gone.
    expect(el.querySelectorAll(".is-released")).toHaveLength(0);
  });

  it("clears everything from the × on the toolbar", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    clickChip(el, "Next 7 days");
    el.querySelector(".wl-filters-clear")?.fire("click");
    expect(rowNames(el)).toHaveLength(4);
    expect(counter(el)).toBe("3 upcoming · 1 recently released");
    expect(el.querySelector(".wl-filters-dot")?.hasClass("is-visible")).toBe(false);
  });

  it("keeps what has already landed out of the list, in its own section", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    const released = el.querySelector(".is-released");
    expect(released).toBeDefined();
    // The aired row is in that section and nowhere else.
    expect(released?.querySelectorAll(".wl-upcoming-name").map((n) => n.textContent)).toEqual([
      "Old News",
    ]);
    const ahead = el
      .querySelectorAll(".wl-upcoming-group")
      .filter((group) => !group.hasClass("is-released"))
      .flatMap((group) => group.querySelectorAll(".wl-upcoming-name").map((n) => n.textContent));
    expect(ahead).toEqual(["Severance", "A Book", "A Game"]);
    expect(ahead).not.toContain("Old News");
  });

  it("shows only the released section under the Recently released window", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS], { books: true, games: true });
    clickChip(el, "Recently released");
    expect(rowNames(el)).toEqual(["Old News"]);
    expect(el.querySelectorAll(".is-released")).toHaveLength(1);
    expect(counter(el)).toBe("0 of 3 upcoming · 1 recently released");
  });

  it("filters on watched, which is per row rather than per title", () => {
    // S01E09 aired on Friday and is ticked off; S02E03 is still to come.
    const ticked = createTitle({
      id: "ticked",
      title: "Ticked",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: [
        { name: "Season 1", seasonNumber: 1, episodes: 10, offset: 0, skippedEpisodes: [] },
      ],
      watchedEpisodes: [9],
      airing: { nextEpisode: { season: 1, episode: 9, airDate: "2026-07-31" } },
    });
    const { el } = mount([SEVERANCE, ticked]);
    expect(rowNames(el)).toEqual(["Severance", "Ticked"]);

    clickChip(el, "Watched");
    expect(rowNames(el)).toEqual(["Severance"]);
    expect(counter(el)).toBe("1 of 1 upcoming");
  });

  it("offers the action that fits the row's availability", () => {
    const rowFor = (el: StubEl, name: string): StubEl =>
      el
        .querySelectorAll(".wl-upcoming-row")
        .find((row) => (row.textContent ?? "").includes(name)) as StubEl;
    // The *availability* actions. "Add to Calendar" wears the same class but is
    // on every dated row regardless of where the title is, so it would drown
    // out the thing this check is about; it has its own tests in
    // `upcoming-gcal.test.ts`.
    const buttons = (row: StubEl): string[] =>
      row
        .querySelectorAll(".wl-mini-btn")
        .filter((b) => !b.classes.has("wl-upcoming-gcal"))
        .map((b) => b.textContent ?? "");

    const neverScanned = createTitle({
      id: "unscanned",
      title: "Never Scanned",
      type: "TV Show",
      // No `plex` cache at all — the scan has never answered for this one.
      airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-05" } },
    });
    const queued = createTitle({
      id: "queued",
      title: "On Its Way",
      type: "Movie",
      releaseDate: "2026-08-06",
      plex: { state: "none" },
      request: { id: 4, status: 2 },
    });
    const host = createHost(900);
    const controller = mountUpcomingTab(host as unknown as HTMLElement, {
      store: storeOf([SEVERANCE, neverScanned, queued]),
      now: () => NOW,
      onRequest: () => undefined,
      onOpenInPlex: () => undefined,
    });
    const el = controller.el as unknown as StubEl;

    // On Plex → watch it, and never a Request button.
    expect(buttons(rowFor(el, "Severance"))).toEqual(["Open in Plex"]);
    expect(
      rowFor(el, "Severance").querySelectorAll(".wl-pill").map((p) => p.textContent),
    ).toEqual(["On Plex"]);
    // Not on Plex — including "nobody could check" → ask for it.
    expect(buttons(rowFor(el, "Never Scanned"))).toEqual(["Request"]);
    expect(
      rowFor(el, "Never Scanned").querySelectorAll(".wl-pill").map((p) => p.textContent),
    ).toEqual(["Not on Plex"]);
    // Already queued → nothing to press, and ONE pill saying so. "Not on Plex"
    // beside "Approved" was two true statements that argued with each other.
    expect(buttons(rowFor(el, "On Its Way"))).toEqual([]);
    const queuedPills = rowFor(el, "On Its Way")
      .querySelectorAll(".wl-pill")
      .map((p) => p.textContent);
    expect(queuedPills).toEqual(["Queued for download"]);
    expect(rowFor(el, "On Its Way").textContent).not.toContain("Not on Plex");
    // Overseerr's own word stays, in the tooltip.
    expect(
      rowFor(el, "On Its Way").querySelector(".wl-pill")?.getAttribute("title"),
    ).toContain("Approved");
    controller.destroy();
  });

  it("offers saved views when there is an app to open the modal with, and not otherwise", () => {
    expect(mount([SEVERANCE], { app: true }).el.querySelectorAll(".wl-preset-btn")).toHaveLength(1);
    expect(mount([SEVERANCE]).el.querySelectorAll(".wl-preset-btn")).toHaveLength(0);
    // …and the tab works either way.
    expect(rowNames(mount([SEVERANCE]).el)).toEqual(["Severance"]);
  });

  it("offers the search-syntax tips only when it can open them", () => {
    expect(mount([SEVERANCE], { app: true }).el.querySelectorAll(".wl-searchbox-tips")).toHaveLength(1);
    expect(mount([SEVERANCE]).el.querySelectorAll(".wl-searchbox-tips")).toHaveLength(0);
  });

  it("groups by bucket while the list is chronological, and not otherwise", () => {
    const { el } = mount([SEVERANCE, OLD_NEWS]);
    expect(el.querySelectorAll(".wl-upcoming-group-label").map((n) => n.textContent)).toEqual([
      "This week",
      "Recently released · 1",
    ]);

    // Sorted by title, "Today / This week" would be a lie about the order.
    const settings = createDefaultSettings();
    const state = readUpcomingViewState(settings);
    state.sort = { key: "title", direction: "asc" };
    writeUpcomingViewState(settings, state);
    const byTitle = mount([SEVERANCE, OLD_NEWS], { settings });
    // The released section keeps its heading — it is a section, not a bucket —
    // but the list above it is one flat run in the chosen order.
    expect(byTitle.el.querySelectorAll(".wl-upcoming-group-label").map((n) => n.textContent)).toEqual([
      "Recently released · 1",
    ]);
    expect(rowNames(byTitle.el)).toEqual(["Severance", "Old News"]);
    expect(byTitle.el.querySelector(".wl-sort-btn")?.textContent).toContain("Title");
  });
});

describe("the Upcoming empty states", () => {
  it("tells a first-run user something different from a no-match one", () => {
    const empty = mount([]);
    expect(empty.el.querySelector(".is-first-run")?.textContent).toContain(
      "Nothing to look forward to yet",
    );
    expect(empty.el.querySelectorAll(".is-no-match")).toHaveLength(0);

    const tracked = mount([createTitle({ id: "x", title: "No Schedule", type: "Movie" })]);
    expect(tracked.el.querySelector(".is-first-run")?.textContent).toContain("Nothing scheduled");

    const filtered = mount([SEVERANCE]);
    clickChip(filtered.el, "Recently released");
    expect(filtered.el.querySelector(".is-no-match")?.textContent).toContain("Nothing matches");
    expect(counter(filtered.el)).toBe("0 of 1 upcoming");
  });

  it("offers the clear-filters way out, and it works", () => {
    const { el } = mount([SEVERANCE]);
    clickChip(el, "Recently released");
    const action = el
      .querySelectorAll("button")
      .find((node) => node.textContent === "Clear search & filters");
    expect(action).toBeDefined();
    action?.fire("click");
    expect(rowNames(el)).toEqual(["Severance"]);
  });
});

describe("the Upcoming view state", () => {
  it("persists the filters and comes back to the same view", () => {
    const settings = createDefaultSettings();
    const first = mount([SEVERANCE, OLD_NEWS], { books: true, games: true, settings });
    clickChip(first.el, "Next 7 days");
    // Stamped into settings at once; only the disk write waits for the debounce.
    expect(readUpcomingViewState(settings).filters.window).toBe("7d");
    first.controller.destroy();
    // …and tearing the tab down flushes that write rather than dropping it.
    expect(first.store.saves.some((reason) => reason.startsWith("upcoming"))).toBe(true);

    const second = mount([SEVERANCE, OLD_NEWS], { books: true, games: true, settings });
    expect(rowNames(second.el)).toEqual(["Severance", "A Book"]);
    expect(counter(second.el)).toBe("2 of 3 upcoming");
  });

  it("leaves nothing behind when torn down", () => {
    const { el, controller } = mount([SEVERANCE]);
    controller.destroy();
    expect(el.parentElement).toBeNull();
  });
});
