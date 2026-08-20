/**
 * Where you watched it — the venue, end to end.
 *
 * The field only earns its place if it is a *fact the user typed*, so most of
 * this file is about the two ways it could stop being one:
 *
 *   1. **Nothing may ever write it on the user's behalf.** Migration does not,
 *      a Plex sweep does not, and the wizard's Plex pre-selection is a
 *      suggestion sitting in a dropdown — it becomes a write only because the
 *      user pressed Mark watched with it showing.
 *   2. **The numbers may not quietly drop anything.** A venue deleted from
 *      settings still counts, and every title with no venue recorded lands in
 *      one honest `Unrecorded` row rather than vanishing out of a panel that
 *      then claims to describe the library.
 *
 * The surfaces are driven for real — the actual modal, the actual view, the
 * actual dashboard mount — for the same reason the rating/review tests are:
 * a helper returning the right value has never been the thing that was broken.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailModal } from "../src/ui/modals/detail";
import { WatchedModal, suggestedVenue, type WatchedResult } from "../src/ui/modals/watched";
import { mountTitleDetail } from "../src/ui/views/title-detail";
import {
  DEFAULT_WATCHED_VIA,
  createDefaultSettings,
  createTitle,
} from "../src/data/schema";
import { migrate } from "../src/data/migrate";
import { WatchLogStore } from "../src/data/store";
import { buildFrontmatter } from "../src/data/notes";
import { autoDetectMapping, coerceRow } from "../src/data/csv";
import { searchTitles } from "../src/search/query";
import { buildTitleCard } from "../src/ui/components/card";
import {
  computeDashboard,
  mountDashboardTab,
  venueStats,
  type VenueStat,
} from "../src/ui/tabs/dashboard";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { CardContext, Settings, TitleV4, WatchLogStoreApi } from "../src/types";
import type { TabDeps } from "../src/ui/tabs/upcoming";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

function title(over: Partial<TitleV4> = {}): TitleV4 {
  const made = createTitle({ id: over.id ?? "t", title: "A Film", type: "Movie" });
  Object.assign(made, over);
  return made;
}

/** A watched film with a known runtime, so it contributes real minutes. */
function watched(id: string, venue: string, minutes: number): TitleV4 {
  return title({
    id,
    status: "Watched",
    watchedVia: venue,
    episodeDuration: minutes,
    totalEpisodes: 1,
    watchedEpisodes: [1],
  });
}

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

describe("the field and the list", () => {
  it("gives a fresh install the eight venues, in order", () => {
    expect(createDefaultSettings().watchedViaOptions.map((v) => v.name)).toEqual([
      "Plex",
      "Cinema",
      "Netflix",
      "HBO Max",
      "Disney+",
      "Prime Video",
      "Apple TV+",
      "Somewhere else",
    ]);
  });

  it("gives every colour from the palette, and a distinct one each", () => {
    const colors = DEFAULT_WATCHED_VIA.map((v) => v.color);
    for (const color of colors) expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("starts a new title with no venue at all", () => {
    expect(createTitle({ id: "x", title: "X", type: "Movie" }).watchedVia).toBe("");
  });

  it("brings every existing title across with an empty venue, never a guess", () => {
    const { data } = migrate({
      schemaVersion: 3,
      titles: [
        { id: "a", title: "A", type: "Movie", status: "Watched" },
        // Even one Plex says it has: migration is not the user.
        { id: "b", title: "B", type: "Movie", plex: { state: "available" } },
      ],
      settings: {},
    });
    expect(data.titles.map((t) => t.watchedVia)).toEqual(["", ""]);
  });

  it("gives an install that predates venues the defaults, disturbing nothing else", () => {
    const { data } = migrate({
      schemaVersion: 3,
      titles: [],
      settings: { reviews: [{ name: "Fine", color: "#123456" }], rootFolder: "Media" },
    });
    expect(data.settings.watchedViaOptions.map((v) => v.name)).toEqual(
      DEFAULT_WATCHED_VIA.map((v) => v.name),
    );
    expect(data.settings.reviews).toEqual([{ name: "Fine", color: "#123456" }]);
    expect(data.settings.rootFolder).toBe("Media");
  });

  it("keeps a list the user has already edited", () => {
    const { data } = migrate({
      schemaVersion: 4,
      titles: [{ id: "a", title: "A", type: "Movie", watchedVia: "The pub" }],
      settings: { watchedViaOptions: [{ name: "The pub", color: "#ABCDEF" }] },
    });
    expect(data.settings.watchedViaOptions).toEqual([{ name: "The pub", color: "#ABCDEF" }]);
    expect(data.titles[0]?.watchedVia).toBe("The pub");
  });
});

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

function labels(rows: readonly VenueStat[]): string[] {
  return rows.map((row) => row.label);
}

describe("venueStats", () => {
  const settings = createDefaultSettings();

  it("says nothing about an empty library", () => {
    expect(venueStats([], settings)).toEqual([]);
  });

  it("puts a library nobody has answered for into one Unrecorded row", () => {
    const rows = venueStats([watched("a", "", 100), watched("b", "", 20), title({ id: "c" })], settings);
    expect(rows).toEqual([
      { label: "Unrecorded", count: 3, minutes: 120, color: "", unrecorded: true },
    ]);
  });

  it("counts titles and minutes per venue, ranked, with Unrecorded last", () => {
    const rows = venueStats(
      [
        watched("a", "Netflix", 50),
        watched("b", "Netflix", 50),
        watched("c", "Cinema", 130),
        title({ id: "d" }),
      ],
      settings,
    );
    expect(rows).toEqual([
      { label: "Netflix", count: 2, minutes: 100, color: "#E24B4A", unrecorded: false },
      { label: "Cinema", count: 1, minutes: 130, color: "#BA7517", unrecorded: false },
      { label: "Unrecorded", count: 1, minutes: 0, color: "", unrecorded: true },
    ]);
  });

  it("leaves Unrecorded out entirely when every title has an answer", () => {
    const rows = venueStats([watched("a", "Plex", 10)], settings);
    expect(labels(rows)).toEqual(["Plex"]);
  });

  it("still counts a venue the user has deleted from settings, in a neutral pill", () => {
    // Deleting "Netflix" from the list does not un-watch what was watched on it.
    const trimmed: Settings = {
      ...settings,
      watchedViaOptions: settings.watchedViaOptions.filter((v) => v.name !== "Netflix"),
    };
    const rows = venueStats([watched("a", "Netflix", 90), watched("b", "Plex", 30)], trimmed);
    expect(rows).toEqual([
      // Tied on count; the longer one wins, and neither has a configured colour
      // to borrow from the other.
      { label: "Netflix", count: 1, minutes: 90, color: "", unrecorded: false },
      { label: "Plex", count: 1, minutes: 30, color: "#E8873A", unrecorded: false },
    ]);
  });

  it("breaks a full tie alphabetically, so the order never shuffles", () => {
    const rows = venueStats([watched("a", "Zetflix", 10), watched("b", "Alpha", 10)], settings);
    expect(labels(rows)).toEqual(["Alpha", "Zetflix"]);
  });

  it("takes its minutes from the one watched-time formula", () => {
    // Not started, so `calcTimeWatched` is zero even though the runtime is known
    // — the venue counts the title, the clock does not.
    const planned = title({ id: "a", watchedVia: "Cinema", episodeDuration: 120 });
    expect(venueStats([planned], settings)).toEqual([
      { label: "Cinema", count: 1, minutes: 0, color: "#BA7517", unrecorded: false },
    ]);
  });

  it("treats whitespace as no answer at all", () => {
    expect(labels(venueStats([title({ id: "a", watchedVia: "   " })], settings))).toEqual([
      "Unrecorded",
    ]);
  });

  it("is what the dashboard model carries", () => {
    const model = computeDashboard([watched("a", "Plex", 45)], settings, new Date(2026, 7, 3));
    expect(model.byVenue).toEqual(venueStats([watched("a", "Plex", 45)], settings));
  });
});

// ---------------------------------------------------------------------------
// The gesture
// ---------------------------------------------------------------------------

const VENUES = [
  { name: "Plex", color: "#a" },
  { name: "Cinema", color: "#b" },
  { name: "Netflix", color: "#c" },
];

function openWizard(over: Partial<TitleV4> = {}, options = VENUES) {
  const subject = title(over);
  let saved: WatchedResult | null = null;
  const modal = new WatchedModal({} as never, {
    title: subject,
    dateFormat: "european",
    ratingTiers: [
      { label: "Poor", color: "#a" },
      { label: "Fair", color: "#b" },
      { label: "Good", color: "#c" },
      { label: "Great", color: "#d" },
      { label: "Masterpiece", color: "#e" },
    ],
    halfStars: false,
    reviews: [{ name: "Good", color: "#c" }],
    watchedViaOptions: options,
    now: new Date(2026, 7, 14),
    onConfirm: (result) => {
      saved = result as WatchedResult;
    },
  });
  const contentEl = createHost(900);
  const modalEl = createHost(900);
  Object.assign(modal as unknown as Record<string, unknown>, { contentEl, modalEl });
  modal.onOpen();

  const el = contentEl as unknown as StubEl;
  const venue = el
    .querySelectorAll("select")
    .find((s) => s.getAttribute("aria-label") === "Where did you watch it?");
  if (!venue) throw new Error("no venue select");
  return {
    el,
    venue,
    result: () => saved,
    save: () =>
      el
        .querySelectorAll("button")
        .find((b) => b.textContent === "Mark watched")
        ?.fire("click"),
  };
}

describe("the wizard asks where", () => {
  it("offers the venues, plus a way of not saying", () => {
    const w = openWizard();
    expect(w.venue.children.map((option) => option.value)).toEqual([
      "",
      "Plex",
      "Cinema",
      "Netflix",
    ]);
  });

  it("opens blank when the plugin has no idea", () => {
    expect(openWizard().venue.value).toBe("");
  });

  it("suggests Plex when Plex says it has the file", () => {
    expect(openWizard({ plex: { state: "available" } }).venue.value).toBe("Plex");
  });

  it("suggests nothing for a title Plex only half has", () => {
    expect(openWizard({ plex: { state: "partial", leafCount: 2 } }).venue.value).toBe("");
  });

  it("follows a renamed Plex, and suggests nothing once it is deleted", () => {
    const renamed = [{ name: "Home server", color: "#a" }];
    expect(suggestedVenue(title({ plex: { state: "available" } }), renamed)).toBe("");
    expect(
      suggestedVenue(title({ plex: { state: "available" } }), [{ name: "plex", color: "#a" }]),
    ).toBe("plex");
    expect(suggestedVenue(title({ plex: { state: "available" } }), [])).toBe("");
  });

  it("writes nothing when the question goes unanswered", () => {
    const w = openWizard();
    w.save();
    expect(w.result()?.watchedVia).toBe("");
  });

  it("saves the venue the user picked", () => {
    const w = openWizard();
    w.venue.value = "Cinema";
    w.venue.fire("change");
    w.save();
    expect(w.result()?.watchedVia).toBe("Cinema");
  });

  it("saves the Plex suggestion only because the user confirmed the wizard", () => {
    const w = openWizard({ plex: { state: "available" } });
    // Nothing has been written yet — this is a dropdown, not a patch.
    expect(w.result()).toBeNull();
    w.save();
    expect(w.result()?.watchedVia).toBe("Plex");
  });

  it("lets the suggestion be turned down", () => {
    const w = openWizard({ plex: { state: "available" } });
    w.venue.value = "";
    w.venue.fire("change");
    w.save();
    expect(w.result()?.watchedVia).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

async function storeWith(over: Partial<TitleV4> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const subject = title(over);
  store.data.titles.push(subject);
  return store;
}

function venueSelect(el: StubEl): StubEl {
  const select = el
    .querySelectorAll("select")
    .find((s) => s.getAttribute("aria-label") === "Watched via");
  if (!select) throw new Error("no Watched via select");
  return select;
}

describe("the detail modal", () => {
  async function open(over: Partial<TitleV4> = {}) {
    const store = await storeWith(over);
    const modal = new DetailModal({} as never, { store: store as never, titleId: "t" });
    const contentEl = createHost(900);
    const modalEl = createHost(900);
    Object.assign(modal as unknown as Record<string, unknown>, { contentEl, modalEl });
    modal.onOpen();
    return { store, el: contentEl as unknown as StubEl };
  }

  it("shows the stored venue", async () => {
    const { el } = await open({ watchedVia: "Cinema" });
    expect(venueSelect(el).value).toBe("Cinema");
  });

  it("writes a pick straight through", async () => {
    const { store, el } = await open();
    const select = venueSelect(el);
    select.value = "Netflix";
    select.fire("change");
    expect(store.getTitle("t")?.watchedVia).toBe("Netflix");
  });

  it("repaints, so the control shows what was written", async () => {
    const { el } = await open();
    const select = venueSelect(el);
    select.value = "Netflix";
    select.fire("change");
    // The surface repaints on every patch: the select on screen is a new one.
    expect(venueSelect(el).value).toBe("Netflix");
  });

  it("clears back to unrecorded", async () => {
    const { store, el } = await open({ watchedVia: "Netflix" });
    const select = venueSelect(el);
    select.value = "";
    select.fire("change");
    expect(store.getTitle("t")?.watchedVia).toBe("");
  });

  it("leaves the judgement alone", async () => {
    const { store, el } = await open({ rating: 4, review: "Awesome" });
    const select = venueSelect(el);
    select.value = "Plex";
    select.fire("change");
    expect(store.getTitle("t")?.rating).toBe(4);
    expect(store.getTitle("t")?.review).toBe("Awesome");
  });
});

describe("the detail view", () => {
  async function open(over: Partial<TitleV4> = {}) {
    const store = await storeWith(over);
    const host = createHost(1200);
    mountTitleDetail(host as unknown as HTMLElement, "t", {
      app: {} as never,
      store: store as never,
      onJumpToQuery: () => undefined,
      onOpenPerson: () => undefined,
      onOpenNote: () => undefined,
      onRefreshMetadata: () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    });
    return { store, el: host as unknown as StubEl };
  }

  it("offers the same control the modal does", async () => {
    const { el } = await open({ watchedVia: "Plex" });
    expect(venueSelect(el).value).toBe("Plex");
  });

  it("writes and repaints", async () => {
    const { store, el } = await open();
    const select = venueSelect(el);
    select.value = "Cinema";
    select.fire("change");
    expect(store.getTitle("t")?.watchedVia).toBe("Cinema");
    expect(venueSelect(el).value).toBe("Cinema");
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function mountDashboard(titles: TitleV4[], settings = createDefaultSettings()) {
  const host = createHost(900);
  const jumped: string[] = [];
  const deps: TabDeps = {
    store: {
      settings,
      allTitles: () => titles,
      getTitle: (id: string) => titles.find((t) => t.id === id),
    } as unknown as WatchLogStoreApi,
    buildCard: (parent: HTMLElement, entry: TitleV4, ctx: CardContext) => {
      buildTitleCard(parent, entry, ctx);
    },
    onOpenTitle: () => undefined,
    onJumpToQuery: (query) => jumped.push(query),
    onGoToTab: () => undefined,
    now: () => new Date(2026, 7, 3),
  };
  const controller = mountDashboardTab(host as unknown as HTMLElement, deps);
  const root = controller.el as unknown as StubEl;
  const panel = root
    .querySelectorAll(".wl-section")
    .find((s) => s.querySelector(".wl-section-title")?.textContent === "Where you watch");
  return { root, panel, jumped };
}

/** `["Netflix 2 · 1h 40m", …]` — what a person actually reads off the panel. */
function rowsOf(panel: StubEl): string[] {
  return panel.querySelectorAll(".wl-credit-row").map((row) => row.textContent ?? "");
}

describe("the Where you watch panel", () => {
  it("ranks the venues with their counts and their time", () => {
    const { panel } = mountDashboard([
      watched("a", "Netflix", 50),
      watched("b", "Netflix", 50),
      watched("c", "Cinema", 130),
    ]);
    if (!panel) throw new Error("no Where you watch panel");
    expect(rowsOf(panel)).toEqual(["Netflix 2 · 1h 40m", "Cinema 1 · 2h 10m"]);
  });

  it("says Unrecorded rather than quietly dropping most of the library", () => {
    const { panel } = mountDashboard([
      watched("a", "Plex", 60),
      title({ id: "b" }),
      title({ id: "c" }),
    ]);
    if (!panel) throw new Error("no Where you watch panel");
    expect(rowsOf(panel)).toEqual(["Plex 1 · 1h", "Unrecorded 2"]);
  });

  it("paints the venue's own colour, and nothing for Unrecorded", () => {
    const { panel } = mountDashboard([watched("a", "Netflix", 10), title({ id: "b" })]);
    if (!panel) throw new Error("no Where you watch panel");
    const pills = panel.querySelectorAll(".wl-pill");
    expect(pills[0]?.style.getPropertyValue("--wl-pill")).toBe("#E24B4A");
    expect(pills[1]?.style.getPropertyValue("--wl-pill")).toBe("");
  });

  it("jumps to the query for a venue, and never for Unrecorded", () => {
    const { panel, jumped } = mountDashboard([watched("a", "Netflix", 10), title({ id: "b" })]);
    if (!panel) throw new Error("no Where you watch panel");
    const pills = panel.querySelectorAll(".wl-pill");
    pills[0]?.fire("click");
    pills[1]?.fire("click");
    expect(jumped).toEqual(['via:"Netflix"']);
    expect(pills[1]?.classes.has("is-clickable")).toBe(false);
  });

  it("keeps a venue no longer in settings on the board", () => {
    const settings = createDefaultSettings();
    settings.watchedViaOptions = settings.watchedViaOptions.filter((v) => v.name !== "Cinema");
    const { panel } = mountDashboard([watched("a", "Cinema", 130)], settings);
    if (!panel) throw new Error("no Where you watch panel");
    expect(rowsOf(panel)).toEqual(["Cinema 1 · 2h 10m"]);
    expect(panel.querySelectorAll(".wl-pill")[0]?.style.getPropertyValue("--wl-pill")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The venue travels
// ---------------------------------------------------------------------------

describe("frontmatter", () => {
  it("writes the venue when there is one", () => {
    expect(buildFrontmatter(title({ watchedVia: "Cinema" }))).toContain('watchedVia: "Cinema"');
  });

  it("writes no empty key when there is not", () => {
    expect(buildFrontmatter(title())).not.toContain("watchedVia");
  });

  it("round-trips through a YAML reader", () => {
    const front = buildFrontmatter(title({ watchedVia: 'The "Rex"' }));
    const line = front.split("\n").find((l) => l.startsWith("watchedVia:"));
    expect(line).toBe('watchedVia: "The \\"Rex\\""');
  });
});

describe("CSV", () => {
  it("recognises a venue column by several spellings", () => {
    expect(autoDetectMapping(["Title", "Watched via"], "watchlist")).toEqual({
      Title: "title",
      "Watched via": "watchedVia",
    });
    expect(autoDetectMapping(["watchedVia"], "watchlist")).toEqual({ watchedVia: "watchedVia" });
    expect(autoDetectMapping(["Venue"], "watchlist")).toEqual({ Venue: "watchedVia" });
  });

  it("carries the value into the seed a title is built from", () => {
    const values = coerceRow("watchlist", { title: "A Film", watchedVia: "Cinema" });
    expect(values.watchedVia).toBe("Cinema");
    expect(createTitle({ ...values, id: "a", title: "A Film", type: "Movie" }).watchedVia).toBe(
      "Cinema",
    );
  });

  it("leaves the venue unset when the file did not say", () => {
    expect(coerceRow("watchlist", { title: "A Film", watchedVia: "" }).watchedVia).toBeUndefined();
  });

  it("still maps v3's own header row onto itself", () => {
    // The new field must not steal a column from the frozen fourteen.
    expect(autoDetectMapping(["title", "status", "notes"], "watchlist")).toEqual({
      title: "title",
      status: "status",
      notes: "notes",
    });
  });
});

describe("the via: query", () => {
  const pool = [
    watched("net", "Netflix", 10),
    watched("cin", "Cinema", 10),
    watched("none", "", 10),
  ];

  it("filters the library by venue", () => {
    expect(searchTitles(pool, 'via:"Netflix"').map((t) => t.id)).toEqual(["net"]);
  });

  it("accepts venue: as well", () => {
    expect(searchTitles(pool, "venue:cinema").map((t) => t.id)).toEqual(["cin"]);
  });

  it("negates", () => {
    expect(searchTitles(pool, '-via:"Netflix"').map((t) => t.id).sort()).toEqual(["cin", "none"]);
  });
});
