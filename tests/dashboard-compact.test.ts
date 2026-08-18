/**
 * The compact Dashboard layout, and the shelf checklist that feeds both layouts.
 *
 * Two features, one test file, because they are one thing from the user's side:
 * the buttons that decide what the Dashboard looks like.
 *
 * What is worth locking down, and why each of these can fail silently:
 *
 *   1. **The rich layout is the default, permanently.** A preference that reads
 *      as "compact" for a missing key, a misspelled key, or a key written by
 *      some future version is a preference that silently replaces the tab
 *      everybody already has. Every wrong value must read as `rich`.
 *   2. **The compact layout is an arrangement, not a second implementation.**
 *      Every number in it is asserted against `computeDashboard` and
 *      `formatMinutes` rather than against a literal, so a second time formula
 *      or a second completion count would fail here rather than merely look
 *      slightly wrong on screen.
 *   3. **The toggles are generated.** Not "there are five status toggles" —
 *      there are exactly the user's statuses, whatever they are. The fixture
 *      below deliberately uses three statuses that are not the shipped five.
 *   4. **Unknown settings keys survive.** Both preferences are stored through
 *      `writeExtra`, and the whole point of that escape hatch is that the
 *      user's books and games are still there afterwards (`types.ts` header).
 *
 * On text fitting: the harness has no layout engine, so no assertion here can
 * prove that a tile's subtext does not clip — a stub would pass an overflowing
 * box just as happily as a fitting one. What *can* be proved is the structural
 * property that makes clipping impossible, and that is what the last block
 * checks: the tracks reflow rather than squeeze, and nothing in a tile or a
 * rail is allowed to declare `nowrap` or an ellipsis.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_LAYOUT_KEY,
  computeDashboard,
  mountDashboardTab,
  readDashboardLayout,
  setDashboardLayout,
} from "../src/ui/tabs/dashboard";
import {
  CURATED_SHELF_IDS,
  isShelfVisible,
  readVisibleShelves,
  SHELF_SIZE,
  setShelfVisible,
  shelfDefaultVisible,
  shelfLabel,
  shelfStatusNames,
  shelfToggles,
  statusShelf,
  statusShelfId,
  statusShelfName,
} from "../src/domains/shelves";
import { renderShelfSettings } from "../src/ui/modals/shelfsettings";
import { buildTitleCard } from "../src/ui/components/card";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { formatMinutes } from "../src/data/episodes";
import { readExtra, writeExtra } from "../src/types";
import { StubEl, createHost, installDomGlobals } from "./helpers/dom";
import type { CardContext, Settings, TitleV4, WatchLogStoreApi } from "../src/types";
import type { TabDeps } from "../src/ui/tabs/upcoming";

const DASHBOARD_CSS = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "styles",
  "50-dashboard.css",
);

const NOW = new Date(2026, 7, 3, 12, 0);

function title(overrides: Partial<TitleV4> & { id: string }): TitleV4 {
  return createTitle({
    title: overrides.id,
    type: "Movie",
    status: "Watching",
    totalEpisodes: 1,
    episodeDuration: 120,
    dateAdded: "2026-08-01T10:00:00.000Z",
    dateModified: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

/** A library with something for every tile, rail and ranked list to say. */
function library(): TitleV4[] {
  return [
    title({
      id: "odyssey",
      title: "The Odyssey",
      favorite: true,
      releaseDate: "2026-07-17",
      year: 2026,
      cast: ["Matt Damon", "Tom Holland"],
      director: ["Christopher Nolan"],
      studio: ["Universal"],
    }),
    title({
      id: "spider",
      title: "Spider-Man",
      status: "Completed",
      releaseDate: "2002-05-01",
      year: 2002,
      watchedEpisodes: [1],
      dateFinished: "2026-07-20",
      cast: ["Tom Holland"],
      director: ["Sam Raimi"],
      studio: ["Sony"],
    }),
    title({
      id: "dexter",
      title: "Dexter",
      type: "TV Show",
      status: "Plan to watch",
      totalEpisodes: 10,
      episodeDuration: 45,
      year: 2006,
      releaseDate: "2006-10-01",
      cast: ["Michael C. Hall"],
      studio: ["Showtime"],
    }),
  ];
}

interface MountResult {
  root: StubEl;
  refresh: () => void;
  settings: Settings;
  /** Every `openPersonView` target this mount produced, newest last. */
  opened: { name?: string }[];
  saves: string[];
}

function mount(
  titles: TitleV4[],
  settings: Settings = createDefaultSettings(),
  options: { withApp?: boolean; onJumpToQuery?: (query: string) => void } = {},
): MountResult {
  const saves: string[] = [];
  const opened: { name?: string }[] = [];
  const store = {
    settings,
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
    save: (reason?: string) => saves.push(reason ?? ""),
  } as unknown as WatchLogStoreApi;

  // Just enough workspace for `openPersonView` to run to completion: it asks
  // for existing leaves, takes one, sets its state and reveals it.
  const app = {
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => ({
        setViewState: (state: { state?: { name?: string } }) => {
          opened.push({ name: state.state?.name });
          return Promise.resolve();
        },
        view: null,
      }),
      revealLeaf: () => undefined,
    },
  };

  const deps: TabDeps = {
    store,
    ...(options.withApp === false ? {} : { app: app as unknown as TabDeps["app"] }),
    buildCard: (parent: HTMLElement, t: TitleV4, ctx: CardContext) => {
      buildTitleCard(parent, t, ctx);
    },
    onOpenTitle: () => undefined,
    onJumpToQuery: options.onJumpToQuery ?? (() => undefined),
    now: () => NOW,
  };

  const controller = mountDashboardTab(createHost(900) as unknown as HTMLElement, deps);
  return { root: controller.el as unknown as StubEl, refresh: controller.refresh, settings, opened, saves };
}

/** The tab's own control buttons, left to right. */
function tools(root: StubEl): StubEl[] {
  return root.querySelectorAll(".wl-dash-tools")[0]?.querySelectorAll(".wl-icon-btn") ?? [];
}

function sectionTitles(root: StubEl): string[] {
  return root.querySelectorAll(".wl-section-title").map((el) => el.textContent);
}

/**
 * The headings of the poster rails only.
 *
 * Not `sectionTitles`: the rich layout also has a *panel* called "Recently
 * added" at the bottom of the tab, and a shelf test that only looked at section
 * titles would pass whether or not the rail had actually gone.
 */
function railTitles(root: StubEl): string[] {
  return root
    .querySelectorAll(".wl-rail")
    .flatMap((rail) => rail.querySelectorAll(".wl-section-title").map((el) => el.textContent));
}

function tileTexts(root: StubEl): string[] {
  return root.querySelectorAll(".wl-stat-tile").map((tile) => tile.textContent);
}

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------
// The preference
// ---------------------------------------------------------------------------

describe("the dashboard layout preference", () => {
  it("is rich until something explicitly says compact", () => {
    expect(readDashboardLayout(createDefaultSettings())).toBe("rich");
  });

  it("reads every wrong value as rich, never as compact", () => {
    for (const wrong of [undefined, null, "", "Compact", "cosy", 1, true, {}, []]) {
      const settings = createDefaultSettings();
      writeExtra(settings, DASHBOARD_LAYOUT_KEY, wrong);
      expect(readDashboardLayout(settings), `${JSON.stringify(wrong)} must read as rich`).toBe(
        "rich",
      );
    }
  });

  it("round-trips, and leaves the keys TypeScript cannot see alone", () => {
    const settings = createDefaultSettings();
    writeExtra(settings, "games", { count: 7 });
    setDashboardLayout(settings, "compact");
    expect(readDashboardLayout(settings)).toBe("compact");
    setDashboardLayout(settings, "rich");
    expect(readDashboardLayout(settings)).toBe("rich");
    expect(readExtra(settings, "games")).toEqual({ count: 7 });
  });
});

// ---------------------------------------------------------------------------
// Switching between the two
// ---------------------------------------------------------------------------

describe("switching layouts", () => {
  it("opens on the rich layout and paints its rings and charts", () => {
    const { root } = mount(library());
    expect(root.querySelectorAll(".wl-ring").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".wl-stat-strip")).toHaveLength(0);
    expect(sectionTitles(root)).toContain("Added over time");
  });

  it("switches to the compact layout from the toolbar, and back again", () => {
    const { root, settings } = mount(library());

    tools(root)[0]?.fire("click");
    expect(readDashboardLayout(settings)).toBe("compact");
    expect(root.querySelectorAll(".wl-stat-strip").length).toBeGreaterThan(0);
    expect(root.querySelectorAll(".wl-ring")).toHaveLength(0);
    expect(root.classes.has("is-compact")).toBe(true);
    // The compact arrangement replaces the charts rather than adding to them.
    expect(sectionTitles(root)).not.toContain("Added over time");
    expect(sectionTitles(root)).toContain("Library statistics");

    tools(root)[0]?.fire("click");
    expect(readDashboardLayout(settings)).toBe("rich");
    expect(root.querySelectorAll(".wl-stat-strip")).toHaveLength(0);
    expect(root.querySelectorAll(".wl-ring").length).toBeGreaterThan(0);
    expect(root.classes.has("is-compact")).toBe(false);
  });

  it("saves the choice rather than only repainting", () => {
    const { root, saves } = mount(library());
    tools(root)[0]?.fire("click");
    expect(saves).toContain("dashboard layout");
  });

  it("survives a data-changed repaint", () => {
    const { root, refresh } = mount(library());
    tools(root)[0]?.fire("click");
    refresh();
    expect(root.querySelectorAll(".wl-stat-strip").length).toBeGreaterThan(0);
  });

  it("renders neither layout broken", () => {
    const { root } = mount(library());
    tools(root)[0]?.fire("click");
    expect(root.querySelectorAll(".is-broken")).toHaveLength(0);
    tools(root)[0]?.fire("click");
    expect(root.querySelectorAll(".is-broken")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What the compact layout says
// ---------------------------------------------------------------------------

describe("the compact layout", () => {
  function compact(titles = library(), settings = createDefaultSettings()): MountResult {
    const result = mount(titles, settings);
    tools(result.root)[0]?.fire("click");
    return result;
  }

  it("leads with one row of tiles, every number from the shared model", () => {
    const titles = library();
    const settings = createDefaultSettings();
    const model = computeDashboard(titles, settings, NOW);
    const { root } = compact(titles, settings);

    const texts = tileTexts(root);
    const total = texts.find((t) => t.startsWith("Total titles"));
    expect(total).toContain(String(model.total));
    // The subtext is the per-type breakdown, so it cannot disagree with the
    // By-type tiles below it.
    for (const type of model.byType) expect(total).toContain(`${type.total} ${type.type}`);

    expect(texts.some((t) => t.startsWith("Completed") && t.includes(String(model.completed)))).toBe(
      true,
    );
    // Durations go through the one formatter, day-scale included.
    expect(texts.some((t) => t.includes(formatMinutes(model.timeWatched)))).toBe(true);
    expect(texts.some((t) => t.includes(formatMinutes(model.timeRemaining)))).toBe(true);
  });

  it("formats a huge total at day scale rather than in minutes", () => {
    // 144d 23h is the shape the reference shows; ours comes out of the same
    // `formatMinutes` every other surface uses.
    const titles = [
      title({ id: "long", status: "Completed", totalEpisodes: 1, episodeDuration: 208_740 }),
    ];
    const { root } = compact(titles);
    expect(tileTexts(root).some((t) => t.includes("144d 23h"))).toBe(true);
  });

  it("offers a Watching tile only when that status exists", () => {
    const withIt = compact();
    expect(tileTexts(withIt.root).some((t) => t.startsWith("Watching"))).toBe(true);

    const renamed = createDefaultSettings();
    renamed.statuses = [{ name: "On the go", color: "var(--color-blue)" }];
    const withoutIt = compact(
      library().map((t) => ({ ...t, status: "On the go" })),
      renamed,
    );
    // Rather than a "Watching: 0" for a vault that calls it something else.
    expect(tileTexts(withoutIt.root).some((t) => t.startsWith("Watching"))).toBe(false);
  });

  it("gives each type a percentage and two lines of detail", () => {
    const titles = library();
    const settings = createDefaultSettings();
    const model = computeDashboard(titles, settings, NOW);
    const { root } = compact(titles, settings);

    for (const type of model.byType) {
      const tile = tileTexts(root).find((t) => t.startsWith(type.type));
      expect(tile, `${type.type} tile`).toBeDefined();
      expect(tile).toContain(`${type.percent}%`);
      expect(tile).toContain(`${type.total} total, ${type.completed} completed`);
    }
  });

  it("keeps the poster rails, still as mini cards", () => {
    const { root } = compact();
    const rails = root.querySelectorAll(".wl-rail-track");
    expect(rails.length).toBeGreaterThan(0);
    for (const rail of rails) {
      expect(rail.querySelectorAll(".wl-card-mini").length).toBeGreaterThan(0);
      expect(rail.querySelectorAll(".wl-card")).toHaveLength(0);
    }
  });

  it("closes with one panel of four ranked lists", () => {
    const { root } = compact();
    const headings = root.querySelectorAll(".wl-credit-heading").map((el) => el.textContent);
    expect(headings).toEqual(["By year", "Top cast", "Top directors", "Top studios"]);
    // Newest year first — the rich layout charts them ascending, a ranked list
    // reads the other way.
    const years = root
      .querySelectorAll(".wl-credit-card")[0]
      ?.querySelectorAll(".wl-chip")
      .map((el) => el.textContent);
    expect(years).toEqual(["2026", "2006", "2002"]);
  });

  it("survives a library where every denominator is zero", () => {
    // Nothing counts towards completion, nothing is watched, nothing has a
    // duration, a year, a credit or a release date. The rich layout has this
    // test (`qa4-dashboard.test.ts`) and the compact one needs its own: it is a
    // different set of panels reading the same hostile model.
    const { root } = compact([
      title({ id: "x", title: "X", type: "TV Show", status: "Dropped", totalEpisodes: 0, episodeDuration: 0 }),
      title({ id: "y", title: "Y", type: "", status: "", totalEpisodes: 0, episodeDuration: 0 }),
    ]);

    expect(root.querySelectorAll(".is-broken")).toHaveLength(0);
    for (const el of root.flatten()) {
      expect(el.ownText).not.toMatch(/\b(NaN|Infinity|undefined)\b/);
    }
    // Every ranked list either has rows or says why it has none. A bare empty
    // box under a heading is the shape "the dashboard looks broken" took.
    const cards = root.querySelectorAll(".wl-credit-card");
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const hasRows = card.querySelectorAll(".wl-credit-row").length > 0;
      const saysWhy = card.querySelectorAll(".wl-chart-empty").length > 0;
      expect(hasRows || saysWhy, `${card.textContent} rendered nothing`).toBe(true);
    }
    // A title with no type still has to be counted somewhere nameable.
    expect(tileTexts(root).some((t) => t.includes("(no type)"))).toBe(true);
  });

  it("opens the person view from a name, and the Library search from a studio", () => {
    const { root, opened } = compact();
    const cards = root.querySelectorAll(".wl-credit-card");
    const castChip = cards[1]?.querySelectorAll(".wl-chip")[0];
    expect(castChip?.textContent).toBe("Tom Holland");
    castChip?.fire("click");
    expect(opened).toEqual([{ name: "Tom Holland" }]);

    // A studio is not a person; it keeps the search handoff, so it opens
    // nothing here.
    cards[3]?.querySelectorAll(".wl-chip")[0]?.fire("click");
    expect(opened).toHaveLength(1);
  });

  it("falls back to the search when there is no app to open a leaf in", () => {
    const result = mount(library(), createDefaultSettings(), { withApp: false });
    // No app means no shelf button either, so the layout switch is button one.
    tools(result.root)[0]?.fire("click");
    const chip = result.root.querySelectorAll(".wl-credit-card")[1]?.querySelectorAll(".wl-chip")[0];
    expect(chip?.tag).toBe("button");
    chip?.fire("click");
    expect(result.opened).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Credit chips, in whichever layout you are looking at
//
// The two layouts used to disagree: compact opened the person, rich could only
// run a `cast:"…"` search — same list, same names, different meaning depending
// on a preference. Both now go through `bindCreditLink`, so the primary click
// is the person and the search is a modifier away in either one.
// ---------------------------------------------------------------------------

describe("the ranked credit lists", () => {
  /** The chip at the top of the list under `heading`, in whatever layout. */
  function topChip(root: StubEl, heading: string): StubEl | undefined {
    const card = root
      .querySelectorAll(".wl-credit-card")
      .find((el) => el.querySelectorAll(".wl-credit-heading")[0]?.textContent === heading);
    return card?.querySelectorAll(".wl-chip")[0];
  }

  it("opens the person from the rich layout too, not only the compact one", () => {
    const { root, opened } = mount(library());
    const chip = topChip(root, "Cast");
    expect(chip?.textContent).toBe("Tom Holland");
    chip?.fire("click", {});
    expect(opened).toEqual([{ name: "Tom Holland" }]);

    topChip(root, "Directors")?.fire("click", {});
    expect(opened).toHaveLength(2);
  });

  it("keeps the Library search on Alt-click in the rich layout", () => {
    const jumped: string[] = [];
    const { root, opened } = mount(library(), createDefaultSettings(), {
      onJumpToQuery: (query) => jumped.push(query),
    });
    topChip(root, "Cast")?.fire("click", { altKey: true });
    expect(jumped).toEqual(['cast:"Tom Holland"']);
    expect(opened).toHaveLength(0);
  });

  it("keeps the Library search on Alt-click in the compact layout", () => {
    const jumped: string[] = [];
    const result = mount(library(), createDefaultSettings(), {
      onJumpToQuery: (query) => jumped.push(query),
    });
    tools(result.root)[0]?.fire("click");
    topChip(result.root, "Top cast")?.fire("click", { altKey: true });
    expect(jumped).toEqual(['cast:"Tom Holland"']);
    expect(result.opened).toHaveLength(0);
  });

  it("never turns a studio into a person, in either layout", () => {
    const { root, opened } = mount(library());
    topChip(root, "Studios")?.fire("click", {});
    expect(opened).toHaveLength(0);
  });

  it("leaves a bucket list with nowhere to go as a plain label", () => {
    const result = mount(library(), createDefaultSettings(), { withApp: false });
    tools(result.root)[0]?.fire("click");
    // "By year" has no query field at all: it is counts, not chips.
    expect(topChip(result.root, "By year")?.tag).toBe("span");
  });
});

// ---------------------------------------------------------------------------
// The shelf checklist
// ---------------------------------------------------------------------------

describe("shelf ids", () => {
  it("round-trips a status name, including one with a colon in it", () => {
    for (const name of ["Watching", "Plan to watch", "Re: watching", ""]) {
      expect(statusShelfName(statusShelfId(name))).toBe(name);
    }
  });

  it("labels a curated shelf by its name and a status shelf by the status", () => {
    expect(shelfLabel("recentlyAdded")).toBe("Recently added");
    expect(shelfLabel(statusShelfId("Plan to watch"))).toBe("Plan to watch");
  });

  it("never treats a curated id as a status", () => {
    for (const id of CURATED_SHELF_IDS) expect(statusShelfName(id)).toBeNull();
  });
});

describe("the toggles the modal offers", () => {
  it("are generated from the user's statuses, not from a hardcoded five", () => {
    const settings = createDefaultSettings();
    settings.statuses = [
      { name: "Queued", color: "var(--color-blue)" },
      { name: "Halfway", color: "var(--color-orange)" },
      { name: "Seen", color: "var(--color-green)" },
    ];
    const groups = shelfToggles(settings);

    expect(groups.curated.map((t) => t.id)).toEqual([...CURATED_SHELF_IDS]);
    expect(groups.statuses.map((t) => t.label)).toEqual(["Queued", "Halfway", "Seen"]);
    expect(groups.statuses.map((t) => t.id)).toEqual([
      "status:Queued",
      "status:Halfway",
      "status:Seen",
    ]);
    // Nothing from the shipped defaults leaks through.
    expect(groups.statuses.map((t) => t.label)).not.toContain("Watching");
  });

  it("drops blank and duplicate status names, which cannot be shelves", () => {
    const settings = createDefaultSettings();
    settings.statuses = [
      { name: "Queued", color: "" },
      { name: "  ", color: "" },
      { name: "Queued", color: "" },
    ];
    expect(shelfStatusNames(settings)).toEqual(["Queued"]);
    expect(shelfToggles(settings).statuses).toHaveLength(1);
  });

  it("has the curated shelves on and the status shelves off, untouched", () => {
    // Opposite defaults on purpose: the curated four are what the Dashboard has
    // always drawn, so switching them off by default would be a regression
    // wearing a preference's clothes. The status rows are new and there is one
    // per status, so they are something to add rather than something to
    // discover and remove.
    const settings = createDefaultSettings();
    const groups = shelfToggles(settings);
    for (const toggle of groups.curated) {
      expect(toggle.visible, `${toggle.id} must default to visible`).toBe(true);
    }
    expect(groups.statuses.length).toBeGreaterThan(0);
    for (const toggle of groups.statuses) {
      expect(toggle.visible, `${toggle.id} must default to hidden`).toBe(false);
    }
    // And the switch a user sees never disagrees with the row they look at.
    for (const toggle of [...groups.curated, ...groups.statuses]) {
      expect(isShelfVisible(settings, toggle.id)).toBe(toggle.visible);
      expect(shelfDefaultVisible(toggle.id)).toBe(toggle.visible);
    }
  });

  it("treats a malformed stored map as no preference at all", () => {
    for (const junk of ["yes", 42, null, ["recentlyAdded"]]) {
      const settings = createDefaultSettings();
      writeExtra(settings, "visibleShelves", junk);
      expect(readVisibleShelves(settings)).toEqual({});
      // Back to each shelf's own default, not to a blanket true or false.
      expect(isShelfVisible(settings, "recentlyAdded")).toBe(true);
      expect(isShelfVisible(settings, statusShelfId("Watching"))).toBe(false);
    }
    // A map with one usable entry keeps that entry and drops the rest.
    const settings = createDefaultSettings();
    writeExtra(settings, "visibleShelves", { recentlyAdded: false, favourites: "no" });
    expect(readVisibleShelves(settings)).toEqual({ recentlyAdded: false });
  });
});

describe("the modal body", () => {
  function render(settings: Settings): { host: StubEl; changes: number } {
    const host = createHost(600);
    const box = { changes: 0 };
    renderShelfSettings(host as unknown as HTMLElement, {
      settings,
      onChange: () => {
        box.changes += 1;
      },
    });
    return { host, get changes() {
      return box.changes;
    } };
  }

  it("draws one row per shelf, in two named groups", () => {
    const settings = createDefaultSettings();
    settings.statuses = [
      { name: "Queued", color: "" },
      { name: "Seen", color: "" },
    ];
    const { host } = render(settings);

    expect(host.querySelectorAll(".wl-shelfset-group").map((el) => el.textContent)).toEqual([
      "Curated shelves",
      "Status shelves",
    ]);
    expect(host.querySelectorAll(".wl-shelfset-name").map((el) => el.textContent)).toEqual([
      "Favourites",
      "Recently added",
      "Recently watched",
      "Recently released",
      "Queued",
      "Seen",
    ]);
    // Every row says what it selects; a bare list of names is not a setting.
    for (const desc of host.querySelectorAll(".wl-shelfset-desc")) {
      expect(desc.textContent.length).toBeGreaterThan(10);
    }
    // And the group whose switches are all off says why, or it reads as broken.
    expect(host.textContent).toContain("off until you turn it on");
  });

  it("draws the curated boxes ticked and the status boxes clear", () => {
    const settings = createDefaultSettings();
    settings.statuses = [{ name: "Queued", color: "" }];
    const { host } = render(settings);
    const boxes = host
      .querySelectorAll(".wl-shelfset-row")
      .map((row) => (row.children[0] as unknown as { checked: boolean }).checked);
    expect(boxes).toEqual([true, true, true, true, false]);
  });

  it("says so rather than drawing an empty group when there are no statuses", () => {
    const settings = createDefaultSettings();
    settings.statuses = [];
    const { host } = render(settings);
    expect(host.querySelectorAll(".wl-shelfset-name").map((el) => el.textContent)).toEqual([
      "Favourites",
      "Recently added",
      "Recently watched",
      "Recently released",
    ]);
    expect(host.textContent).toContain("no status shelves");
  });

  it("saves on the toggle itself, with no OK button to forget", () => {
    const settings = createDefaultSettings();
    const rendered = render(settings);
    const rows = rendered.host.querySelectorAll(".wl-shelfset-row");
    const box = rows[1]?.children[0] as unknown as { checked: boolean } & StubEl;

    expect(box.checked).toBe(true);
    box.checked = false;
    box.fire("change");

    expect(isShelfVisible(settings, "recentlyAdded")).toBe(false);
    expect(rendered.changes).toBe(1);
    // And the other three are untouched, not reset.
    expect(isShelfVisible(settings, "favourites")).toBe(true);
  });

  it("writes the map without destroying the keys TypeScript cannot see", () => {
    const settings = createDefaultSettings();
    writeExtra(settings, "drafts", ["one"]);
    setShelfVisible(settings, "favourites", false);
    setShelfVisible(settings, statusShelfId("Queued"), false);
    expect(readVisibleShelves(settings)).toEqual({ favourites: false, "status:Queued": false });
    expect(readExtra(settings, "drafts")).toEqual(["one"]);
  });
});

// ---------------------------------------------------------------------------
// What the toggles actually do to the tab
// ---------------------------------------------------------------------------

describe("hiding a shelf", () => {
  it("draws no status rail at all until one is switched on", () => {
    // The user's own vault, near enough: five statuses, three of them with
    // something in them. None of those rows appears without being asked for.
    const settings = createDefaultSettings();
    const { root } = mount(library(), settings);
    const rails = railTitles(root);
    for (const status of settings.statuses.map((s) => s.name)) {
      expect(rails, `${status} must not appear unasked`).not.toContain(status);
    }
    expect(rails).toEqual(["Favourites", "Recently added", "Recently watched", "Recently released"]);
  });

  it("puts one rail per switched-on status on the tab, in the configured order", () => {
    const settings = createDefaultSettings();
    settings.statuses = [
      { name: "Plan to watch", color: "" },
      { name: "Watching", color: "" },
      { name: "Completed", color: "" },
    ];
    for (const status of settings.statuses) {
      setShelfVisible(settings, statusShelfId(status.name), true);
    }
    const { root } = mount(library(), settings);
    const rails = railTitles(root);
    expect(rails.indexOf("Plan to watch")).toBeGreaterThan(-1);
    expect(rails.indexOf("Watching")).toBeGreaterThan(rails.indexOf("Plan to watch"));
    expect(rails.indexOf("Completed")).toBeGreaterThan(rails.indexOf("Watching"));
    // And every status rail sits after every curated one.
    expect(rails.indexOf("Plan to watch")).toBeGreaterThan(rails.indexOf("Recently released"));
  });

  it("shows a status rail the moment its toggle goes on, and hides it again", () => {
    // The half of the modal that is off by default is the half that has to
    // prove it does something: a group of switches that all look inert is
    // indistinguishable from a broken screen.
    const settings = createDefaultSettings();
    const { root, refresh } = mount(library(), settings);
    expect(railTitles(root)).not.toContain("Plan to watch");

    setShelfVisible(settings, statusShelfId("Plan to watch"), true);
    refresh();
    expect(railTitles(root)).toContain("Plan to watch");

    setShelfVisible(settings, statusShelfId("Plan to watch"), false);
    refresh();
    expect(railTitles(root)).not.toContain("Plan to watch");
    // And the curated four were never involved.
    expect(railTitles(root)).toContain("Recently added");
  });

  it("still draws nothing for a status with nothing in it, switched on or not", () => {
    // Two of this vault's five statuses are empty. A heading over a void is
    // the one thing a shelf strip must never produce, whatever the toggle says.
    const settings = createDefaultSettings();
    for (const status of settings.statuses) {
      setShelfVisible(settings, statusShelfId(status.name), true);
    }
    const { root } = mount(library(), settings);
    const rails = railTitles(root);
    expect(rails).toContain("Plan to watch");
    expect(rails).toContain("Completed");
    expect(rails).not.toContain("To be released");
    expect(rails).not.toContain("Dropped");
  });

  it("takes it off the tab, and only it", () => {
    const settings = createDefaultSettings();
    const { root, refresh } = mount(library(), settings);
    expect(railTitles(root)).toContain("Recently added");

    setShelfVisible(settings, "recentlyAdded", false);
    refresh();

    const shown = railTitles(root);
    expect(shown).not.toContain("Recently added");
    expect(shown).toContain("Favourites");
    expect(shown).toContain("Recently watched");
    // The bottom-of-tab "Recently added" *panel* is a different thing and is
    // not what this switch governs.
    expect(sectionTitles(root)).toContain("Recently added");
  });

  it("hides it in the compact layout too — one shelf system, two arrangements", () => {
    const settings = createDefaultSettings();
    const { root } = mount(library(), settings);
    tools(root)[0]?.fire("click");
    expect(railTitles(root)).toContain("Recently added");

    setShelfVisible(settings, "recentlyAdded", false);
    tools(root)[0]?.fire("click"); // back to rich
    tools(root)[0]?.fire("click"); // and into compact again
    expect(railTitles(root)).not.toContain("Recently added");
  });

  it("leaves the two-argument selection contract exactly as it was", () => {
    // Callers that do not pass settings get the four curated shelves and no
    // filtering — the older, smaller contract every pure shelf test relies on.
    const settings = createDefaultSettings();
    setShelfVisible(settings, "recentlyAdded", false);
    expect(statusShelf(library(), "Plan to watch").map((t) => t.id)).toEqual(["dexter"]);
  });
});

// ---------------------------------------------------------------------------
// How a status shelf is ordered
// ---------------------------------------------------------------------------

describe("statusShelf", () => {
  it("selects only that status, most recently touched first", () => {
    const shelf = statusShelf(
      [
        title({ id: "old", status: "Watching", dateModified: "2026-01-01T00:00:00.000Z" }),
        title({ id: "new", status: "Watching", dateModified: "2026-08-01T00:00:00.000Z" }),
        title({ id: "elsewhere", status: "Dropped", dateModified: "2026-09-01T00:00:00.000Z" }),
        // Finished later than it was last edited: `watchedKey` takes the
        // later of the two, which is the whole point of that helper.
        title({
          id: "mid",
          status: "Watching",
          dateModified: "2026-02-01T00:00:00.000Z",
          dateFinished: "2026-05-01",
        }),
      ],
      "Watching",
    );
    expect(shelf.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts the undated to the back, then alphabetically — never wherever sort left them", () => {
    // The real failure this guards: a vault where a whole status carries no
    // usable timestamp. "Most recently touched" then orders nothing, and
    // without the tiebreak the row is a different row after every save.
    const undated = ["Zulu", "Alpha", "Mike"].map((name) =>
      title({ id: name, title: name, status: "Watching", dateModified: "", dateFinished: "" }),
    );
    const dated = title({
      id: "dated",
      title: "Dated",
      status: "Watching",
      dateModified: "2026-03-03T00:00:00.000Z",
    });

    const forwards = statusShelf([dated, ...undated], "Watching");
    const backwards = statusShelf([...undated].reverse().concat(dated), "Watching");

    expect(forwards.map((t) => t.title)).toEqual(["Dated", "Alpha", "Mike", "Zulu"]);
    // Same library, same row, whatever order it arrived in.
    expect(backwards.map((t) => t.title)).toEqual(forwards.map((t) => t.title));
  });

  it("breaks an exact timestamp tie by title rather than by luck", () => {
    const same = "2026-04-04T00:00:00.000Z";
    const shelf = statusShelf(
      [
        title({ id: "b", title: "Beta", status: "Watching", dateModified: same }),
        title({ id: "a", title: "Alpha", status: "Watching", dateModified: same }),
      ],
      "Watching",
    );
    expect(shelf.map((t) => t.title)).toEqual(["Alpha", "Beta"]);
  });

  it("caps at twelve like every other window, and never mutates its input", () => {
    const titles = Array.from({ length: 20 }, (_, i) =>
      title({
        id: `t${i}`,
        title: `T${i}`,
        status: "Watching",
        dateModified: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const before = titles.map((t) => t.id);
    expect(statusShelf(titles, "Watching")).toHaveLength(SHELF_SIZE);
    expect(titles.map((t) => t.id)).toEqual(before);
  });

  it("returns nothing for a status nobody is in", () => {
    expect(statusShelf(library(), "Not a status anyone uses")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Text that must not clip
// ---------------------------------------------------------------------------

describe("the compact layout's text boxes", () => {
  const css = readFileSync(DASHBOARD_CSS, "utf8");

  /** Top-level rule bodies whose selector mentions `needle`. */
  function bodiesFor(needle: string): string[] {
    const out: string[] = [];
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = rule.exec(stripped)) !== null) {
      if (match[1]?.includes(needle)) out.push(match[2] ?? "");
    }
    return out;
  }

  it("reflows the tiles instead of squeezing them below a floor", () => {
    // The harness has no layout engine, so this is the structural guarantee
    // rather than a measurement: an `auto-fit` track with a `minmax` floor
    // drops a tile onto the next row rather than shrinking it past the width
    // its text needs.
    const strip = bodiesFor(".wl-stat-strip").join("\n");
    expect(strip).toMatch(/repeat\(\s*auto-fit\s*,\s*minmax\(\s*\d+px/);
    expect(bodiesFor(".wl-stat-strip.is-wide").join("\n")).toMatch(/minmax\(\s*260px/);
    // The floor is a track width, so the tile's padding has to live inside it.
    expect(bodiesFor(".wl-stat-tile").join("\n")).toMatch(/box-sizing:\s*border-box/);
  });

  it("lets every line in a tile wrap rather than truncate", () => {
    for (const needle of [".wl-stat-tile", ".wl-stat-sub"]) {
      const bodies = bodiesFor(needle);
      expect(bodies.length, `${needle} must be styled`).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body, `${needle} must not clip`).not.toMatch(/white-space:\s*nowrap/);
        expect(body, `${needle} must not clip`).not.toMatch(/text-overflow:\s*ellipsis/);
      }
    }
    expect(bodiesFor(".wl-stat-sub").join("\n")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the rail's two-line title box, which is what stops a poster clipping", () => {
    // The rails are the one place in the compact layout where a name genuinely
    // cannot fit; `renderShelfRow` puts the full title in the wrapper's `title`
    // attribute and the CSS gives it two reserved lines.
    const clamp = bodiesFor(".wl-rail-track .wl-card-mini-title").join("\n");
    expect(clamp).toMatch(/line-clamp:\s*2/);
    expect(clamp).toMatch(/min-height:\s*calc\(2 \* 1\.3em\)/);
  });

  it("puts the full title on every rail item for a pointer to read", () => {
    const { root } = mount(library());
    tools(root)[0]?.fire("click");
    const items = root.querySelectorAll(".wl-rail-item");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.attrs.get("title")).toBeTruthy();
  });
});
