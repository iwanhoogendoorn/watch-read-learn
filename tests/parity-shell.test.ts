/**
 * The parity shell (SPEC2-PARITY.md, W8-contract).
 *
 * Four lanes are about to build against this in parallel, so what is frozen has
 * to be pinned: the tab list, the widget domain default, the stat vocabulary,
 * and — the one with teeth — that a stub tab tells the truth about the data
 * already sitting in the vault.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountStubTab } from "../src/ui/tabs/stub";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import { WatchLogStore } from "../src/data/store";
import { createWidgetSpec } from "../src/widgets/parser";
import { emptySpec } from "../src/widgets/render";
import {
  READING_STATUSES,
  TAB_IDS,
  WIDGET_DOMAINS,
  WORDS_PER_PAGE,
  type WidgetStat,
} from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

describe("the seven-tab shell", () => {
  it("is the SPEC2 tab list, in order", () => {
    expect(TAB_IDS).toEqual([
      "dashboard",
      "library",
      "reading",
      "games",
      "upcoming",
      "lists",
      "activity",
    ]);
  });

  it("has no drafts tab — drafts are a panel in the Library", () => {
    expect(TAB_IDS).not.toContain("drafts");
  });
});

describe("a stub tab", () => {
  const mount = (existing?: string): StubEl => {
    const host = createHost(900);
    const controller = mountStubTab(host as unknown as HTMLElement, {
      id: "reading",
      icon: "book-open",
      title: "Reading",
      body: "Books and manga.",
      ...(existing !== undefined ? { existing } : {}),
      planned: ["Books and Manga sub-tabs", "Open Library search"],
    });
    return controller.el as unknown as StubEl;
  };

  it("says what the tab is for and that it is not built", () => {
    const el = mount();
    expect(el.textContent).toContain("Reading");
    expect(el.textContent).toContain("Books and manga.");
    expect(el.textContent).toContain("Coming in this build");
    // The plan, so the tab is a promise rather than a dead end.
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("reassures about data already in the vault, when there is some", () => {
    // The failure this prevents: a user with 40 books in v3 opens the Reading
    // tab, sees an empty panel, and concludes the migration ate them.
    const el = mount("12 books and 3 manga already in your data file, kept exactly as they are.");
    expect(el.textContent).toContain("kept exactly as they are");
    expect(el.querySelectorAll(".wl-stub-existing")).toHaveLength(1);
  });

  it("says nothing about existing data when there is none", () => {
    expect(mount().querySelectorAll(".wl-stub-existing")).toHaveLength(0);
  });

  it("tears itself down cleanly", () => {
    const host = createHost(900);
    const controller = mountStubTab(host as unknown as HTMLElement, {
      id: "games",
      icon: "gamepad-2",
      title: "Games",
      body: "…",
      planned: [],
    });
    expect(host.children).toHaveLength(1);
    controller.destroy();
    expect(host.children).toHaveLength(0);
  });
});

describe("the widget DSL's parity keys", () => {
  it("defaults every block to the watchlist, so old blocks mean what they meant", () => {
    expect(createWidgetSpec("cards").domain).toBe("watchlist");
    expect(createWidgetSpec("stat").domain).toBe("watchlist");
    expect(emptySpec().domain).toBe("watchlist");
  });

  it("knows exactly three domains", () => {
    expect(WIDGET_DOMAINS).toEqual(["watchlist", "reading", "games"]);
  });

  it("keeps the watchlist stats and adds one per new domain", () => {
    // Typed, so this fails at compile time too if the union drifts.
    const stats: WidgetStat[] = [
      "time",
      "completed",
      "counts",
      "by-status",
      "pages-read",
      "time-played",
      "reading-completed",
      "games-completed",
    ];
    expect(new Set(stats).size).toBe(stats.length);
  });
});

describe("reading constants", () => {
  it("fixes the five statuses v3 fixed", () => {
    expect(READING_STATUSES).toEqual([
      "Reading",
      "Completed",
      "Plan to Read",
      "To be released",
      "Dropped",
    ]);
  });

  it("keeps v3's words-to-pages rate, so old stats stay comparable", () => {
    expect(WORDS_PER_PAGE).toBe(250);
  });
});

describe("the store exposes both parity domains", () => {
  it("hands out a reading and a games library without the caller checking", () => {
    // Migration creates both, so this is about the contract rather than the
    // repair: four lanes must not each write `data.reading?.books`.
    const store = new WatchLogStore({
      loadData: async () => null,
      saveData: async () => undefined,
    } as never);

    expect(store.reading.books).toEqual([]);
    expect(store.reading.settings.defaultStatus).toBe("Plan to Read");
    expect(store.games.games).toEqual([]);
    expect(store.games.settings.statuses.map((s) => s.name)).toContain("Playing");
  });

  it("creates them on the data object, so what appears is what gets saved", () => {
    const store = new WatchLogStore({
      loadData: async () => null,
      saveData: async () => undefined,
    } as never);
    // Touch the accessors, then confirm the keys are on the persisted object.
    void store.reading;
    void store.games;
    expect(store.data.reading).toBe(store.reading);
    expect(store.data.games).toBe(store.games);
  });
});
