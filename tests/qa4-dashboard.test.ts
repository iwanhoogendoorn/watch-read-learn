/**
 * QA round 4 — "the dashboard looks broken".
 *
 * The report came with no screenshot, so these tests cover the three ways a tab
 * can look broken rather than guessing at one: a section that threw and rendered
 * an error panel, a section that rendered nothing at all, and arithmetic that
 * reached the DOM as `NaN` / `Infinity` / `undefined`.
 *
 * The library the user actually has is the hard case for the third: 4 titles,
 * none rated, none in progress, so half the dashboard's denominators are zero.
 * Every fixture below is at least that hostile.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBook,
  createDefaultSettings,
  createGame,
  createGamesSettings,
  createManga,
  createReadingSettings,
  createTitle,
} from "../src/data/schema";
import { computeDashboard, mountDashboardTab, sourceCharts } from "../src/ui/tabs/dashboard";
import { buildTitleCard } from "../src/ui/components/card";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { CardContext, Settings, TitleV4, WatchLogStoreApi } from "../src/types";
import type { TabDeps } from "../src/ui/tabs/upcoming";

const NOW = new Date(2026, 7, 3);

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

function storeOf(titles: TitleV4[], settings: Settings = createDefaultSettings()): WatchLogStoreApi {
  return {
    settings,
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
  } as unknown as WatchLogStoreApi;
}

function mount(titles: TitleV4[], settings?: Settings): StubEl {
  const host = createHost(900);
  const deps: TabDeps = {
    store: storeOf(titles, settings),
    buildCard: (parent: HTMLElement, title: TitleV4, ctx: CardContext) => {
      buildTitleCard(parent, title, ctx);
    },
    onOpenTitle: () => undefined,
    onJumpToQuery: () => undefined,
    onGoToTab: () => undefined,
    now: () => NOW,
  };
  const controller = mountDashboardTab(host as unknown as HTMLElement, deps);
  return controller.el as unknown as StubEl;
}

/** Every section, with whatever it managed to render. */
function sectionsOf(root: StubEl): { name: string; el: StubEl }[] {
  return root.querySelectorAll(".wl-section").map((el) => ({
    el,
    name:
      el.querySelector(".wl-section-title")?.textContent ??
      el.querySelector(".wl-error-panel-head")?.textContent ??
      "(overview)",
  }));
}

function brokenSections(root: StubEl): string[] {
  return root
    .querySelectorAll(".is-broken")
    .map((el) => `${el.querySelector(".wl-error-panel-head")?.textContent ?? "?"}: ${el.querySelector(".wl-error-panel-body")?.textContent ?? ""}`);
}

/** Text and attributes that leaked a non-number. */
function badNumbers(root: StubEl): string[] {
  const out: string[] = [];
  for (const el of root.flatten()) {
    if (el.ownText && /\b(NaN|Infinity|-Infinity|undefined)\b/.test(el.ownText)) {
      out.push(`text: ${el.ownText}`);
    }
    for (const [key, value] of el.attrs) {
      if (/NaN|Infinity|undefined/.test(value)) out.push(`${key}="${value}"`);
    }
    for (const key of ["--wl-bar-pct", "--wl-col-pct", "width"]) {
      const value = el.style.getPropertyValue(key);
      if (value && /NaN|Infinity|undefined/.test(value)) out.push(`${key}: ${value}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("the dashboard renders without breaking", () => {
  it("shows its first-run empty state for an empty library", () => {
    const root = mount([]);
    expect(brokenSections(root)).toEqual([]);
    expect(root.textContent).toContain("No statistics yet");
    expect(badNumbers(root)).toEqual([]);
  });

  it("renders every section over the real vault's shape: 4 titles, none rated, none in progress", () => {
    const titles = [
      createTitle({ id: "a", title: "The Odyssey", type: "Movie", status: "Plan to watch", releaseDate: "2026-07-17" }),
      createTitle({ id: "b", title: "Brand New Day", type: "Movie", status: "Completed", releaseDate: "2026-07-31", watchedEpisodes: [1] }),
      createTitle({ id: "c", title: "Dexter", type: "TV Show", status: "Completed", totalEpisodes: 10, watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 }] }),
      createTitle({ id: "d", title: "Spider-Man", type: "Movie", status: "Completed", releaseDate: "2002-05-01", watchedEpisodes: [1] }),
    ];
    const root = mount(titles);

    expect(brokenSections(root)).toEqual([]);
    expect(badNumbers(root)).toEqual([]);

    const sections = sectionsOf(root);
    expect(sections.map((s) => s.name)).toEqual([
      // The poster shelves lead the tab: "what now" before "how am I doing".
      // Only the ones with something on them — nothing here is a favourite, so
      // there is no Favourites row (`domains/shelves.ts`).
      "Recently added",
      "Recently watched",
      "Recently released",
      // And no status rows: those are off until the "Choose visible shelves"
      // modal turns one on, so an untouched vault paints exactly this.
      "(overview)",
      "By type",
      // The parity source filter sits above the per-library charts (W8).
      "More statistics",
      "By status",
      "By year",
      "Added over time",
      "Top credits",
      "Continue watching",
      "Up next",
      "Recently watched",
      "Recently added",
    ]);
    // Every one either has content or says why it has none.
    for (const { name, el } of sections) {
      const hasEmptyState = el.querySelector(".wl-chart-empty") !== null;
      const hasContent = el.flatten().some((child) => child !== el && child.ownText !== "");
      expect(hasEmptyState || hasContent, `${name} rendered nothing`).toBe(true);
    }
    // The two that must be empty states for this library, by name.
    expect(root.textContent).toContain("Nothing in progress");
  });

  it("survives a library where every denominator is zero", () => {
    // Nothing counts towards completion (all Dropped), nothing is watched,
    // nothing has a duration, a year, credits or a release date.
    const titles = [
      createTitle({ id: "x", title: "X", type: "TV Show", status: "Dropped", totalEpisodes: 0, episodeDuration: 0 }),
      createTitle({ id: "y", title: "Y", type: "", status: "", totalEpisodes: 0, episodeDuration: 0 }),
    ];
    const root = mount(titles);

    expect(brokenSections(root)).toEqual([]);
    expect(badNumbers(root)).toEqual([]);
    // The ring reads 0%, not NaN% — the number the user would have seen.
    expect(root.querySelector(".wl-ring-value-label")?.textContent).toBe("0%");
  });

  it("does not divide by a zero maximum in either chart", () => {
    const titles = [createTitle({ id: "z", title: "Z", type: "Movie", status: "Dropped" })];
    const root = mount(titles);
    for (const fill of root.querySelectorAll(".wl-bar-fill")) {
      expect(fill.style.getPropertyValue("--wl-bar-pct")).toMatch(/^\d+%$/);
    }
    for (const bar of root.querySelectorAll(".wl-column-bar")) {
      expect(bar.style.getPropertyValue("--wl-col-pct")).toMatch(/^\d+%$/);
    }
  });

  it("does not throw on a title whose dates are missing or malformed", () => {
    // A hand-edited or half-migrated row. `section()` would catch a throw and
    // print a panel; the point is that there is nothing to catch.
    const broken = createTitle({ id: "b", title: "Broken", type: "Movie" });
    (broken as { dateAdded: unknown }).dateAdded = "";
    const alsoBroken = createTitle({ id: "b2", title: "Also", type: "Movie" });
    (alsoBroken as { dateAdded: unknown }).dateAdded = undefined;
    (alsoBroken as { dateModified: unknown }).dateModified = "not a date";
    (alsoBroken as { dateFinished: unknown }).dateFinished = "13-45-9999";

    const root = mount([broken, alsoBroken]);
    expect(brokenSections(root)).toEqual([]);
    expect(badNumbers(root)).toEqual([]);
  });

  it("keeps the poster card's class to itself", () => {
    // `.wl-card` is the poster card and carries a 2:3 aspect-ratio. The
    // dashboard's panels must not wear it, or they inherit that ratio and turn
    // into screen-tall empty rectangles — which is what "looks broken" was.
    const root = mount([createTitle({ id: "a", title: "A", type: "Movie", status: "Completed" })]);
    const panels = root.querySelectorAll(".wl-panel");
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) expect(panel.classes.has("wl-card")).toBe(false);
  });
});

describe("the dashboard model with nothing to average", () => {
  it("reports 0%, never NaN, when nothing counts", () => {
    const settings = createDefaultSettings();
    const model = computeDashboard(
      [createTitle({ id: "a", title: "A", type: "Movie", status: "Dropped" })],
      settings,
      NOW,
    );
    expect(model.counting).toBe(0);
    expect(model.percent).toBe(0);
    expect(Number.isNaN(model.percent)).toBe(false);
    expect(model.byType.every((t) => Number.isFinite(t.percent))).toBe(true);
  });

  it("returns finite totals for a library of zero-length titles", () => {
    const model = computeDashboard(
      [createTitle({ id: "a", title: "A", type: "Movie", totalEpisodes: 0, episodeDuration: 0 })],
      createDefaultSettings(),
      NOW,
    );
    expect(Number.isFinite(model.timeWatched)).toBe(true);
    expect(Number.isFinite(model.timeRemaining)).toBe(true);
    expect(model.addedOverTime).toHaveLength(12);
    expect(model.addedOverTime.every((b) => Number.isFinite(b.count))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W8-integration: the parity domains on the dashboard
// ---------------------------------------------------------------------------

describe("per-library cards and the source filter", () => {
  const withDomains = (): WatchLogStoreApi => {
    const store = storeOf([
      createTitle({ id: "t", title: "A Show", type: "TV Show", status: "Completed" }),
    ]) as unknown as Record<string, unknown>;
    store.reading = {
      books: [
        createBook({ id: "dune", title: "Dune", status: "Completed", pagesRead: 528, totalPages: 528 }),
        createBook({ id: "wip", title: "In Progress", status: "Reading", pagesRead: 100, totalPages: 400 }),
      ],
      manga: [createManga({ id: "berserk", title: "Berserk", chaptersRead: 300, totalChapters: 374, volumesRead: 34 })],
      bookColumns: [],
      mangaColumns: [],
      settings: createReadingSettings(),
    };
    store.games = {
      games: [
        createGame({ id: "hades", title: "Hades", status: "Finished", playtimeMinutes: 4210 }),
        createGame({ id: "next", title: "Next", status: "Playing", playtimeMinutes: 120 }),
      ],
      groups: [],
      settings: createGamesSettings(),
    };
    return store as unknown as WatchLogStoreApi;
  };

  const mountWith = (store: WatchLogStoreApi): StubEl => {
    const host = createHost(900);
    const controller = mountDashboardTab(host as unknown as HTMLElement, {
      store,
      now: () => NOW,
    });
    return controller.el as unknown as StubEl;
  };

  it("shows a card per library, with the numbers each is judged by", () => {
    const root = mountWith(withDomains());
    expect(brokenSections(root)).toEqual([]);
    expect(badNumbers(root)).toEqual([]);

    const text = root.textContent;
    expect(text).toContain("Books");
    expect(text).toContain("pages");
    expect(text).toContain("Manga");
    expect(text).toContain("chapters");
    expect(text).toContain("Games");
    // Time played is the games equivalent of time watched.
    expect(text).toContain("played across 2 games");
  });

  it("offers one chip per non-empty library, watchlist first", () => {
    const root = mountWith(withDomains());
    const chips = root.querySelectorAll(".wl-source-chips")[0]?.children ?? [];
    expect(chips.map((c) => c.ownText)).toEqual(["Watchlist", "Reading", "Games"]);
    expect(chips[0]?.classes.has("is-active")).toBe(true);
  });

  it("does not offer a library with nothing in it", () => {
    // The watchlist-only vault: no Reading or Games chip to click into a blank.
    const root = mountWith(storeOf([createTitle({ id: "t", title: "A", type: "Movie" })]));
    const chips = root.querySelectorAll(".wl-source-chips")[0]?.children ?? [];
    expect(chips.map((c) => c.ownText)).toEqual(["Watchlist"]);
    expect(root.textContent).not.toContain("Libraries");
  });

  it("repaints the charts against the library you pick", () => {
    const store = withDomains();
    const root = mountWith(store);
    const readingChip = root
      .querySelectorAll(".wl-chip")
      .find((chip) => chip.ownText === "Reading");
    expect(readingChip).toBeDefined();
    readingChip?.fire("click");

    // The by-status chart now speaks the reading vocabulary.
    const labels = root.querySelectorAll(".wl-bar-label").map((el) => el.ownText);
    expect(labels).toContain("Reading");
    expect(labels).toContain("Completed");
    expect(labels).not.toContain("Plan to watch"); // the watchlist status
    expect(badNumbers(root)).toEqual([]);
  });

  it("survives a store that predates the parity contract", () => {
    // A harness or embedded host may hand over a store with no reading/games.
    // That line sits outside every section wrapper, so it must not blank the tab.
    const root = mountWith(storeOf([createTitle({ id: "t", title: "A", type: "Movie" })]));
    expect(brokenSections(root)).toEqual([]);
    expect(root.querySelectorAll(".wl-section").length).toBeGreaterThan(5);
  });
});

describe("sourceCharts", () => {
  const reading = {
    books: [createBook({ id: "b", title: "B", status: "Reading", releaseDate: "2020-01-01" })],
    manga: [createManga({ id: "m", title: "M", status: "Completed", releaseDate: "2019-01-01" })],
    bookColumns: [],
    mangaColumns: [],
    settings: createReadingSettings(),
  };
  const games = {
    games: [createGame({ id: "g", title: "G", status: "Finished", releaseDate: "2021-06-01" })],
    groups: [],
    settings: createGamesSettings(),
  };
  const model = computeDashboard([], createDefaultSettings(), NOW);

  it("keeps the watchlist model untouched for the watchlist source", () => {
    const charts = sourceCharts("watchlist", model, reading, games, NOW);
    expect(charts.byStatus).toBe(model.byStatus);
  });

  it("buckets reading by its derived status and release year", () => {
    const charts = sourceCharts("reading", model, reading, games, NOW);
    expect(charts.byStatus.map((b) => b.label)).toEqual(["Reading", "Completed"]);
    expect(charts.byYear.map((b) => b.label)).toEqual(["2019", "2020"]);
    expect(charts.addedOverTime).toHaveLength(12);
  });

  it("buckets games in the user's configured status order", () => {
    const charts = sourceCharts("games", model, reading, games, NOW);
    expect(charts.byStatus).toEqual([{ label: "Finished", count: 1 }]);
    expect(charts.byYear).toEqual([{ label: "2021", count: 1 }]);
  });

  it("never divides by zero for an empty library", () => {
    const empty = { books: [], manga: [], bookColumns: [], mangaColumns: [], settings: createReadingSettings() };
    const charts = sourceCharts("reading", model, empty, games, NOW);
    expect(charts.byStatus).toEqual([]);
    expect(charts.addedOverTime.every((b) => Number.isFinite(b.count))).toBe(true);
  });
});
