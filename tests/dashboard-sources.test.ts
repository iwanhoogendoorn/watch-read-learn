/**
 * The dashboard's library switch.
 *
 * It used to sit inside the "More statistics" header and govern three charts,
 * so clicking "Reading" changed almost nothing on a page still full of films.
 * These tests pin the fix at the level the complaint was made: after switching,
 * nothing from the other library is on screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountDashboardTab } from "../src/ui/tabs/dashboard";
import { buildTitleCard } from "../src/ui/components/card";
import { createBook, createDefaultSettings, createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { Book, CardContext, TitleV4, WatchLogStoreApi } from "../src/types";
import type { TabDeps } from "../src/ui/tabs/upcoming";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(1200);
});

afterEach(() => {
  restore();
});

const FILM = "A Film Nobody Should See Here";
const BOOK = "A Book That Should Be Here";

function storeOf(titles: TitleV4[], books: Book[]): WatchLogStoreApi {
  return {
    settings: createDefaultSettings(),
    allTitles: () => titles,
    getTitle: (id: string) => titles.find((t) => t.id === id),
    reading: { books, manga: [], settings: {}, columns: [] },
    games: { games: [], settings: {} },
  } as unknown as WatchLogStoreApi;
}

function mount(): StubEl {
  const film = createTitle({ id: "f", title: FILM, type: "Movie" });
  film.status = "Completed";
  film.rating = 5;
  const book = createBook({ id: "b", title: BOOK });
  book.author = "An Author";
  book.status = "Reading";
  book.totalPages = 300;
  book.pagesRead = 120;

  const host = createHost(1200);
  const deps: TabDeps = {
    store: storeOf([film], [book]),
    buildCard: (parent: HTMLElement, title: TitleV4, ctx: CardContext) => {
      buildTitleCard(parent, title, ctx);
    },
    now: () => new Date(2026, 7, 11),
  } as unknown as TabDeps;
  return mountDashboardTab(host as unknown as HTMLElement, deps).el as unknown as StubEl;
}

/** The chips that pick a library. The harness has no descendant selectors. */
function sourceChips(el: StubEl): StubEl[] {
  const bar = el.querySelectorAll(".wl-source-bar")[0];
  return bar ? bar.querySelectorAll(".wl-chip") : [];
}

describe("switching the dashboard's library", () => {
  it("offers a chip per library that has anything in it", () => {
    const labels = sourceChips(mount()).map((chip) => chip.textContent);
    expect(labels).toEqual(["Watchlist", "Reading"]);
  });

  it("starts on the watchlist", () => {
    const el = mount();
    expect(el.textContent).toContain(FILM);
  });

  it("puts the whole page on the shelf, not just the charts", () => {
    const el = mount();
    sourceChips(el).find((chip) => chip.textContent === "Reading")?.fire("click");

    expect(el.textContent).toContain(BOOK);
    // The complaint, as a test: no film content survives the switch.
    expect(el.textContent).not.toContain(FILM);
  });

  it("renames the panels rather than showing the wrong title over right data", () => {
    const el = mount();
    sourceChips(el).find((chip) => chip.textContent === "Reading")?.fire("click");
    const headings = el.querySelectorAll(".wl-section-title").map((h) => h.textContent);

    expect(headings).toContain("Continue reading");
    expect(headings).toContain("Recently finished");
    expect(headings).toContain("Top authors");
    expect(headings).not.toContain("Continue watching");
    expect(headings).not.toContain("Recently watched");
    expect(headings).not.toContain("Top credits");
  });

  it("counts pages rather than minutes", () => {
    const el = mount();
    sourceChips(el).find((chip) => chip.textContent === "Reading")?.fire("click");
    const labels = el.querySelectorAll(".wl-stat-label").map((s) => s.textContent);
    expect(labels).toContain("Pages read");
    expect(labels).not.toContain("Time watched");
  });

  it("goes back", () => {
    const el = mount();
    sourceChips(el).find((chip) => chip.textContent === "Reading")?.fire("click");
    sourceChips(el).find((chip) => chip.textContent === "Watchlist")?.fire("click");
    expect(el.textContent).toContain(FILM);
    expect(el.textContent).not.toContain(BOOK);
  });
});
