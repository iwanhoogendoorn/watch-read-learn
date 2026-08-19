/**
 * The Reading tab's poster grid, and the table it toggles with.
 *
 * ## What can be checked here, and what cannot
 *
 * `tests/helpers/dom.ts` has no layout engine and no cascade, so "does it *look*
 * the same" is not a question this file can answer directly. What it can answer
 * — and what actually decides the visual result — is whether the two grids are
 * built out of the same parts:
 *
 *   - a book card wears the **same class names** as a title card, and those
 *     names are declared exactly once, in `styles/20-cards.css`. Two elements
 *     with the same class in the same stylesheet cannot render differently, so
 *     pinning the class list pins the look;
 *   - the caption rows appear in the **same order**, which is what makes every
 *     card in a grid crop its poster on the same line;
 *   - the cells are the Library's own `createVirtualGrid` at the Library's own
 *     `cellHeight` (`width × 1.5`, the 2:3 poster), so the *geometry* is shared
 *     rather than re-derived.
 *
 * The rest is behaviour: the toggle, the one-time default, and the rule that a
 * grid of covers still cannot fire an unlimited request at Open Library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WatchLogStore } from "../src/data/store";
import { mountReadingTab } from "../src/domains/reading";
import { createReadingStore, type ReadingStore } from "../src/domains/reading/store";
import { clearCoverCaches } from "../src/domains/reading/covers";
import { ReadingColumnsModal } from "../src/domains/reading/modals/columns";
import { buildTitleCard } from "../src/ui/components/card";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { ReadingController } from "../src/domains/reading/tab";
import type { LibraryViewMode, OpenLibraryClient, WatchLogStoreApi } from "../src/types";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT = readFileSync(join(ROOT, "tests/fixtures/data-v3-parity.json"), "utf8");

const OL_COVER = "https://covers.openlibrary.org/b/isbn/9780441013593-M.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(1200);
  // The session cover cache is module-level, deliberately — a live search must
  // not re-queue for bytes it already has. Across tests that would mean the
  // second one never asks the client at all, which is the very thing being
  // pinned here.
  clearCoverCaches();
  // `loadCover` draws fetched bytes from an object URL. Neither exists in the
  // node environment; nothing here cares what the string is, only that the
  // bytes came through the client rather than through an `<img src>`.
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:reading-grid",
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal("Blob", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore();
});

interface Mounted {
  host: StubEl;
  store: WatchLogStoreApi;
  reading: ReadingStore;
  controller: ReadingController;
  el: StubEl;
}

/** The reading settings inside a parsed `data.json`, for seeding. */
function readingSettings(data: unknown): Record<string, unknown> {
  return (data as { reading: { settings: Record<string, unknown> } }).reading.settings;
}

/**
 * A `data.json` that already answers "which view?".
 *
 * The marker says the one-time move to the grid has happened, so the stored
 * mode is a *choice* rather than an absence — which is the state every reader
 * is in from their second launch onwards.
 */
function seedMode(data: unknown, mode: LibraryViewMode): unknown {
  const settings = readingSettings(data);
  settings["viewModeGridDefault"] = true;
  settings["viewMode"] = mode;
  return data;
}

/**
 * Mount the tab.
 *
 * `mode` **seeds** the stored view rather than relying on what a fresh install
 * happens to open as: a test about the table sets up a table. Only the tests
 * under "what the tab opens as" leave it unset, because the default is the
 * thing they are about.
 *
 * `data` is passed by reference on purpose — `migrate()` and the tab both
 * write into it, so mounting twice off the same object is what a second launch
 * from the same `data.json` actually looks like.
 */
async function mount(
  options: { data?: unknown; mode?: LibraryViewMode; openLibrary?: OpenLibraryClient } = {},
): Promise<Mounted> {
  const data = "data" in options ? options.data : (JSON.parse(TEXT) as unknown);
  if (options.mode !== undefined && data !== null) seedMode(data, options.mode);
  const store = new WatchLogStore({
    loadData: async () => data,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const reading = createReadingStore(store);
  const host = createHost(1200);
  const controller = mountReadingTab(host as unknown as HTMLElement, {
    app: {} as never,
    store,
    reading,
    ...(options.openLibrary ? { openLibrary: options.openLibrary } : {}),
  });
  return { host, store, reading, controller, el: controller.el as unknown as StubEl };
}

function toggle(el: StubEl): StubEl {
  const button = el.querySelector(".wl-view-toggle");
  if (!button) throw new Error("no view toggle");
  return button;
}

function cards(el: StubEl): StubEl[] {
  return el.querySelectorAll(".wl-card");
}

/** Flush the promise chain inside `loadCover`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Open the tab's own columns modal and switch the Year built-in off.
 *
 * The Modal base class supplies `contentEl`/`modalEl` in Obsidian; the harness
 * supplies them, the same way `tests/book-detail-view.test.ts` does. This drives
 * the REAL modal the toolbar button opens, so the wiring between the tick and
 * the stored list is exercised rather than assumed.
 */
function openColumnsModal(el: StubEl): void {
  const opened: ReadingColumnsModal[] = [];
  const spy = vi
    .spyOn(ReadingColumnsModal.prototype, "open")
    .mockImplementation(function (this: ReadingColumnsModal) {
      opened.push(this);
    });
  el.querySelector(".wl-reading-columns-btn")?.fire("click");
  spy.mockRestore();

  const modal = opened[0];
  if (!modal) throw new Error("the columns button opened no modal");
  const contentEl = createHost(1200);
  Object.assign(modal as unknown as Record<string, unknown>, {
    contentEl,
    modalEl: createHost(1200),
    close: () => undefined,
  });
  modal.onOpen();

  const tick = contentEl
    .querySelectorAll("input")
    .find((input) => input.getAttribute("aria-label") === "Show the Year column");
  if (!tick) throw new Error("no Year tick in the columns modal");
  tick.fire("change");
}

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

describe("the view toggle", () => {
  it("is the Library's control, not a lookalike", async () => {
    const { el, controller } = await mount({ mode: "table" });
    const button = toggle(el);
    // Same classes as `ui/tabs/library.ts` builds, so it inherits the same
    // button styling rather than a parallel set of rules.
    expect(button.className.split(" ").sort()).toEqual(["wl-btn", "wl-icon-btn", "wl-view-toggle"]);
    // The label names the DESTINATION, which is the Library's convention, so
    // it reads differently on each side of the switch.
    expect(button.getAttribute("aria-label")).toBe("Switch to poster grid");
    expect(button.getAttribute("title")).toBe("Switch to poster grid");
    button.fire("click");
    expect(button.getAttribute("aria-label")).toBe("Switch to table view");
    expect(button.getAttribute("title")).toBe("Switch to table view");
    controller.destroy();
  });

  it("sits straight after Sort, where the Library's sits", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    const toolbar = el.querySelector(".wl-toolbar");
    const order = (toolbar?.children ?? []).map((child) => child.className);
    const sortAt = order.findIndex((cls) => cls.includes("wl-sort-btn"));
    const toggleAt = order.findIndex((cls) => cls.includes("wl-view-toggle"));
    expect(sortAt).toBeGreaterThanOrEqual(0);
    expect(toggleAt).toBe(sortAt + 1);
    controller.destroy();
  });

  it("swaps the table for a grid of cards and back", async () => {
    const { el, controller } = await mount({ mode: "table" });
    expect(el.querySelectorAll(".wl-reading-row").length).toBe(2);
    expect(cards(el)).toHaveLength(0);

    toggle(el).fire("click");
    expect(el.querySelectorAll(".wl-reading-row")).toHaveLength(0);
    expect(cards(el)).toHaveLength(2);
    expect(toggle(el).getAttribute("aria-label")).toBe("Switch to table view");

    toggle(el).fire("click");
    expect(el.querySelectorAll(".wl-reading-row")).toHaveLength(2);
    expect(cards(el)).toHaveLength(0);
    controller.destroy();
  });

  it("hides the columns button in grid mode — a grid has no columns", async () => {
    const { el, controller } = await mount({ mode: "table" });
    const columns = el.querySelector(".wl-reading-columns-btn");
    expect(columns?.hasClass("is-hidden")).toBe(false);
    toggle(el).fire("click");
    expect(columns?.hasClass("is-hidden")).toBe(true);
    controller.destroy();
  });

  it("is one preference for both shelves, and it persists", async () => {
    const { el, store, controller } = await mount({ mode: "table" });
    toggle(el).fire("click");
    // Switching to manga keeps the grid: how you like to look at a shelf is
    // not a property of the shelf.
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    expect(cards(el)).toHaveLength(1);
    const settings = store.reading.settings as unknown as Record<string, unknown>;
    expect(settings["viewMode"]).toBe("grid");
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The one-time default
// ---------------------------------------------------------------------------

describe("what the tab opens as", () => {
  const MARKER = "viewModeGridDefault";

  it("gives a fresh install the poster grid, like the Library", async () => {
    const { el, store, controller } = await mount({ data: null });
    const settings = store.reading.settings as unknown as Record<string, unknown>;
    // Nothing to show yet, but the mode is decided and written once.
    expect(settings["viewMode"]).toBe("grid");
    expect(settings[MARKER]).toBe(true);
    expect(el.textContent).toContain("No books yet");
    controller.destroy();
  });

  it("moves a shelf that predates the grid onto it, exactly once", async () => {
    // The fixture is a real v3 file: books, and no answer to a question that
    // did not exist when it was written.
    const data = JSON.parse(TEXT) as unknown;
    expect(readingSettings(data)[MARKER]).toBeUndefined();
    expect(readingSettings(data)["viewMode"]).toBeUndefined();

    const first = await mount({ data });
    expect(cards(first.el)).toHaveLength(2);
    expect(readingSettings(data)["viewMode"]).toBe("grid");
    expect(readingSettings(data)[MARKER]).toBe(true);
    first.controller.destroy();

    // Second launch off the same file: the move has already happened, so the
    // stored answer is simply read back. Nothing is decided twice.
    const second = await mount({ data });
    expect(cards(second.el)).toHaveLength(2);
    expect(readingSettings(data)[MARKER]).toBe(true);
    second.controller.destroy();
  });

  it("carries a stored table across once, then honours the next answer forever", async () => {
    // The whole contract of a one-time move, in one test.
    //
    // Somebody who had picked the table BEFORE the marker existed has a stored
    // `"table"` that predates the question. That is not a choice about the
    // grid — the grid did not exist — so it is moved across, once.
    const data = JSON.parse(TEXT) as unknown;
    readingSettings(data)["viewMode"] = "table";
    expect(readingSettings(data)[MARKER]).toBeUndefined();

    const moved = await mount({ data });
    expect(cards(moved.el)).toHaveLength(2);
    expect(readingSettings(data)["viewMode"]).toBe("grid");
    expect(readingSettings(data)[MARKER]).toBe(true);
    moved.controller.destroy();

    // Launching again does not move anything a second time.
    const again = await mount({ data });
    expect(cards(again.el)).toHaveLength(2);
    again.controller.destroy();

    // Now the reader answers the question for themselves.
    const chosen = await mount({ data });
    toggle(chosen.el).fire("click");
    expect(chosen.el.querySelectorAll(".wl-reading-row")).toHaveLength(2);
    expect(readingSettings(data)["viewMode"]).toBe("table");
    chosen.controller.destroy();

    // And it sticks. This is the assertion the marker exists for: reading the
    // mode alone cannot tell this `"table"` from the one three steps up, and
    // overruling it would be the plugin arguing with the user.
    const kept = await mount({ data });
    expect(kept.el.querySelectorAll(".wl-reading-row")).toHaveLength(2);
    expect(cards(kept.el)).toHaveLength(0);
    kept.controller.destroy();
  });

  it("never overrules a choice already on disk", async () => {
    const data = seedMode(JSON.parse(TEXT) as unknown, "table");
    // Books on the shelf, the marker set, and a stored table — it opens as a
    // table and stays one however many times it is mounted.
    for (let launch = 0; launch < 3; launch += 1) {
      const { el, controller } = await mount({ data });
      expect(el.querySelectorAll(".wl-reading-row")).toHaveLength(2);
      expect(cards(el)).toHaveLength(0);
      expect(readingSettings(data)["viewMode"]).toBe("table");
      controller.destroy();
    }
  });

  it("repairs a marked file whose mode went missing, without asking again", async () => {
    // A hand-edited or half-written file: the question has been asked (the
    // marker is there) but the answer is gone. It falls back to the default
    // rather than to nothing, and the marker is left alone.
    const data = JSON.parse(TEXT) as unknown;
    readingSettings(data)[MARKER] = true;
    const { el, controller } = await mount({ data });
    expect(cards(el)).toHaveLength(2);
    expect(readingSettings(data)["viewMode"]).toBe("grid");
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

describe("a book card is the Library's card", () => {
  it("wears the same classes, which are declared once in 20-cards.css", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    const card = cards(el)[0] as StubEl;

    for (const cls of [
      ".wl-card-poster",
      ".wl-poster",
      ".wl-card-body",
      ".wl-card-title",
      ".wl-card-pills",
      ".wl-card-meta",
      ".wl-card-actions",
    ]) {
      expect(card.querySelectorAll(cls).length, `a book card is missing ${cls}`).toBe(1);
    }
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabindex")).toBe("0");
    controller.destroy();
  });

  it("puts the caption rows in the same order a title card does", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    const body = (cards(el)[0] as StubEl).querySelector(".wl-card-body") as StubEl;
    const bookRows = body.children.map((child) => child.className.split(" ")[0]);

    const titleHost = createHost(900);
    buildTitleCard(
      titleHost as unknown as HTMLElement,
      createTitle({ id: "t", title: "A Title", type: "Movie" }),
      {
        store: { settings: createDefaultSettings() } as unknown as WatchLogStoreApi,
        showRating: true,
        showProgress: true,
        onOpen: () => undefined,
      } as never,
    );
    const titleBody = titleHost.querySelector(".wl-card-body") as StubEl;
    const titleRows = titleBody.children.map((child) => child.className.split(" ")[0]);

    expect(bookRows.slice(0, 3)).toEqual(["wl-card-title", "wl-card-pills", "wl-card-meta"]);
    expect(bookRows.slice(0, 3)).toEqual(titleRows.slice(0, 3));
    controller.destroy();
  });

  it("paints the caption last, so the scrim sits over the artwork", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    const wrap = (cards(el)[0] as StubEl).querySelector(".wl-card-poster") as StubEl;
    const last = wrap.children[wrap.children.length - 1] as StubEl;
    expect(last.className.split(" ")).toContain("wl-card-body");
    controller.destroy();
  });

  it("says what a book has, and nothing a book does not", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    const card = cards(el).find((c) => c.textContent?.includes("Dune")) as StubEl;

    expect(card.querySelector(".wl-card-title")?.textContent).toBe("Dune");
    expect(card.querySelector(".wl-card-meta")?.textContent).toContain("Frank Herbert");
    expect(card.querySelector(".wl-card-meta")?.textContent).toContain("528/528 pages");
    expect(card.querySelectorAll(".wl-pill").map((p) => p.textContent)).toEqual(["Completed"]);
    // Five stars, a heart, a progress strip — and no Plex badge and no airing
    // chip, because neither means anything for a book.
    expect(card.querySelectorAll(".wl-stars")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-card-fav")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-progress")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-plex-badge")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-card-badges")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-card-airing")).toHaveLength(0);
    controller.destroy();
  });

  it("shows a category beside the status, and no blank pill when there is none", async () => {
    const { el, reading, controller } = await mount({ mode: "grid" });
    reading.update("book", "dune", { categories: ["Sci-Fi", "Classics"] }, "test");
    controller.refresh();
    const card = cards(el).find((c) => c.textContent?.includes("Dune")) as StubEl;
    // One category, not all of them: the pill row is capped at one line, and a
    // second row would move every card's poster crop.
    expect(card.querySelectorAll(".wl-pill").map((p) => p.textContent)).toEqual([
      "Completed",
      "Sci-Fi",
    ]);
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The empty book
// ---------------------------------------------------------------------------

describe("a book with nothing in it", () => {
  /** No cover, no author, no page count, no rating, no category, no status colour. */
  async function bare(mode: LibraryViewMode): Promise<Mounted> {
    const data = JSON.parse(TEXT) as {
      reading: { books: Record<string, unknown>[]; manga: unknown[] };
    };
    data.reading.books = [
      {
        id: "bare",
        title: "Untitled",
        author: "",
        status: "Plan to Read",
        rating: 0,
        pagesRead: 0,
        totalPages: 0,
        progressUnit: "pages",
        wordsRead: 0,
        totalWords: 0,
        chaptersRead: 0,
        totalChapters: 0,
        coverUrl: "",
        categories: [],
        customFields: {},
      },
    ];
    data.reading.manga = [];
    return mount({ data, mode });
  }

  it("renders cleanly in the grid — no empty pill, no NaN, no zero bar", async () => {
    const { el, controller } = await bare("grid");
    const card = cards(el)[0] as StubEl;

    expect(card).toBeDefined();
    expect(card.textContent).not.toContain("NaN");
    expect(card.textContent).not.toContain("undefined");
    // Exactly one pill: the status. Nothing invents an empty category chip.
    expect(card.querySelectorAll(".wl-pill").map((p) => p.textContent)).toEqual(["Plan to Read"]);
    // The meta row is present and empty — present because every card's rows
    // hold their height, empty because there is genuinely nothing to say.
    expect(card.querySelectorAll(".wl-card-meta")).toHaveLength(1);
    expect(card.querySelector(".wl-card-meta")?.textContent).toBe("");
    // Absence reads as absence: the gap the stars would fill, not five hollow
    // stars, and no bar at all rather than one pinned at zero.
    expect(card.querySelectorAll(".wl-stars")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-card-rating-empty")).toHaveLength(1);
    expect(card.querySelectorAll(".wl-progress")).toHaveLength(0);
    // No cover and no ISBN: a placeholder, never a broken image.
    expect(card.querySelectorAll(".wl-poster-img")).toHaveLength(0);
    expect(card.querySelectorAll(".wl-poster.is-placeholder")).toHaveLength(1);
    controller.destroy();
  });

  it("renders cleanly in the table too", async () => {
    const { el, controller } = await bare("table");
    const row = el.querySelectorAll(".wl-reading-row")[0] as StubEl;
    expect(row.textContent).not.toContain("NaN");
    expect(row.textContent).not.toContain("undefined");
    // A total nobody knows offers a way to say so, rather than a bare dash.
    expect(row.querySelectorAll(".wl-reading-set-total")).toHaveLength(1);
    expect(row.querySelectorAll(".wl-reading-category-chip")).toHaveLength(0);
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// Covers — the whole reason `covers.ts` exists
// ---------------------------------------------------------------------------

describe("covers in the grid stay on the polite path", () => {
  function client(): { client: OpenLibraryClient; asked: string[] } {
    const asked: string[] = [];
    const stub = {
      configured: () => true,
      coverBytes: async (url: string) => {
        asked.push(url);
        return JPEG;
      },
    } as unknown as OpenLibraryClient;
    return { client: stub, asked };
  }

  it("fetches Open Library covers through the rate-limited client, not an <img src>", async () => {
    const { client: stub, asked } = client();
    const { el, controller } = await mount({ openLibrary: stub, mode: "grid" });
    await settle();

    // The client was asked, by URL — that is the limiter and the User-Agent.
    expect(asked).toContain(OL_COVER);
    // …and nothing anywhere in the grid points an image straight at the CDN,
    // which is the request Chromium would own and the limiter would never see.
    const srcs = el.querySelectorAll(".wl-poster-img").map((img) => img.src);
    expect(srcs.length).toBeGreaterThan(0);
    expect(srcs.filter((src) => src.startsWith("https://covers.openlibrary.org"))).toEqual([]);
    expect(srcs).toContain("blob:reading-grid");
    controller.destroy();
  });

  it("draws a placeholder rather than going around the limiter when there is no client", async () => {
    const { el, controller } = await mount({ mode: "grid" });
    await settle();
    const srcs = el.querySelectorAll(".wl-poster-img").map((img) => img.src);
    expect(srcs.filter((src) => src.startsWith("https://covers.openlibrary.org"))).toEqual([]);
    controller.destroy();
  });

  it("uses the same path in the table, so neither view can drift", async () => {
    const { client: stub, asked } = client();
    const { el, controller } = await mount({ openLibrary: stub, mode: "table" });
    await settle();
    expect(asked).toContain(OL_COVER);
    const srcs = el.querySelectorAll(".wl-poster-img").map((img) => img.src);
    expect(srcs.filter((src) => src.startsWith("https://covers.openlibrary.org"))).toEqual([]);
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The table, made as dense as the Library's
// ---------------------------------------------------------------------------

describe("the table reads like the Library's", () => {
  it("puts the bar and its number on one line", async () => {
    const { el, controller } = await mount({ mode: "table" });
    const row = el.querySelectorAll(".wl-reading-row")[0] as StubEl;
    const line = row.querySelector(".wl-reading-progress-line") as StubEl;
    expect(line).toBeDefined();
    expect(line.querySelectorAll(".wl-reading-bar")).toHaveLength(1);
    expect(line.querySelectorAll(".wl-reading-progress-text")).toHaveLength(1);
    controller.destroy();
  });

  it("puts the public's rating beside the stars, not under them", async () => {
    const { el, reading, controller } = await mount({ mode: "table" });
    reading.update("book", "dune", { communityRating: 4.2, communityVotes: 900 }, "test");
    controller.refresh();
    const row = el
      .querySelectorAll(".wl-reading-row")
      .find((r) => r.textContent?.includes("Dune")) as StubEl;
    const cell = row.querySelector(".wl-reading-rating-cell") as StubEl;
    const community = row.querySelector(".wl-reading-community-cell") as StubEl;
    expect(community).toBeDefined();
    // A span in the same cell as the stars — a block here was a second row on
    // every rated book.
    expect(community.tag).toBe("span");
    expect(cell.contains(community)).toBe(true);
    controller.destroy();
  });

  it("counts the categories it does not have room for", async () => {
    const { el, reading, controller } = await mount({ mode: "table" });
    reading.update(
      "book",
      "dune",
      { categories: ["Sci-Fi", "Classics", "Adventure", "Politics"] },
      "test",
    );
    controller.refresh();
    const row = el
      .querySelectorAll(".wl-reading-row")
      .find((r) => r.textContent?.includes("Dune")) as StubEl;
    expect(row.querySelectorAll(".wl-reading-category-chip").map((c) => c.textContent)).toEqual([
      "Sci-Fi",
      "Classics",
    ]);
    const more = row.querySelector(".wl-reading-category-more") as StubEl;
    expect(more.textContent).toBe("+2");
    // The names are not lost, only folded.
    expect(more.getAttribute("title")).toBe("Adventure, Politics");
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The Year column
// ---------------------------------------------------------------------------

describe("the built-in Year column", () => {
  it("is on without anybody asking, and reads off releaseDate", async () => {
    const { el, controller } = await mount({ mode: "table" });
    const headers = el.querySelectorAll("th").map((cell) => cell.textContent);
    expect(headers).toContain("Year");
    // The fixture's Dune is `"releaseDate": "1965-08-01"`. The year is not
    // stored anywhere — it is the same field the detail screen prints.
    const row = el
      .querySelectorAll(".wl-reading-row")
      .find((r) => r.textContent?.includes("Dune")) as StubEl;
    expect(row.querySelector(".wl-reading-builtin-cell")?.textContent).toBe("1965");
    controller.destroy();
  });

  it("says — for a book whose year nobody knows, never a blank or NaN", async () => {
    const { el, reading, controller } = await mount({ mode: "table" });
    // Three ways a row fails to answer: no date, an empty one, and a
    // half-written one that `Number.parseInt` would happily turn into NaN.
    reading.update("book", "dune", { releaseDate: null }, "test");
    reading.update("book", "half-filled", { releaseDate: "not-a-date" }, "test");
    controller.refresh();

    const cells = el.querySelectorAll(".wl-reading-builtin-cell").map((c) => c.textContent);
    expect(cells).toHaveLength(2);
    expect(cells).toEqual(["—", "—"]);
    expect(el.textContent).not.toContain("NaN");
    controller.destroy();
  });

  it("hides its header and its cells together when switched off", async () => {
    const data = seedMode(JSON.parse(TEXT) as unknown, "table");
    // The shape the columns modal writes: hidden per shelf, by id.
    readingSettings(data)["hiddenColumns"] = { book: ["year"] };
    const { el, controller } = await mount({ data });
    expect(el.querySelectorAll("th").map((cell) => cell.textContent)).not.toContain("Year");
    // Header and cells go together, or the whole table shears one column left.
    expect(el.querySelectorAll(".wl-reading-builtin-head")).toHaveLength(0);
    expect(el.querySelectorAll(".wl-reading-builtin-cell")).toHaveLength(0);
    controller.destroy();
  });

  it("is switched off per shelf, like every other column", async () => {
    const data = seedMode(JSON.parse(TEXT) as unknown, "table");
    readingSettings(data)["hiddenColumns"] = { book: ["year"] };
    const { el, controller } = await mount({ data });
    expect(el.querySelectorAll(".wl-reading-builtin-cell")).toHaveLength(0);
    // Manga said nothing about it, so manga still has it.
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    expect(el.querySelectorAll("th").map((cell) => cell.textContent)).toContain("Year");
    expect(el.querySelector(".wl-reading-builtin-cell")?.textContent).toBe("1989");
    controller.destroy();
  });

  it("is switched off from the columns modal, and stays off", async () => {
    const data = seedMode(JSON.parse(TEXT) as unknown, "table");
    const { el, controller } = await mount({ data });
    expect(el.querySelectorAll(".wl-reading-builtin-cell")).toHaveLength(2);

    // Drive the real modal the way `book-detail-view.test.ts` does: the Modal
    // base class supplies these two in Obsidian, the harness supplies them here.
    let hidden = readingSettings(data)["hiddenColumns"];
    expect(hidden).toBeUndefined();
    openColumnsModal(el);

    hidden = readingSettings(data)["hiddenColumns"];
    expect(hidden).toEqual({ book: ["year"] });
    expect(el.querySelectorAll(".wl-reading-builtin-cell")).toHaveLength(0);
    controller.destroy();

    // And it is on disk, so the next launch opens without it.
    const again = await mount({ data });
    expect(again.el.querySelectorAll("th").map((c) => c.textContent)).not.toContain("Year");
    again.controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// Category chips
// ---------------------------------------------------------------------------

describe("category chips are the plugin's pill", () => {
  it("wears .wl-pill in the table, not a look of its own", async () => {
    const { el, reading, controller } = await mount({ mode: "table" });
    reading.update("book", "dune", { categories: ["Sci-Fi"] }, "test");
    controller.refresh();

    const chip = el.querySelector(".wl-reading-category-chip") as StubEl;
    const classes = chip.className.split(" ");
    // The shared pill, plus the modifier that names its colour source, plus
    // the class that only adds "it is a button and it filters".
    expect(classes).toContain("wl-pill");
    expect(classes).toContain("is-category");
    expect(classes).toContain("wl-reading-category-chip");
    // The label is a `.wl-pill-text` span, like every other pill's, so the
    // pill's own truncation applies to it.
    expect(chip.querySelector(".wl-pill-text")?.textContent).toBe("Sci-Fi");
    // Still a button, and still the thing that filters.
    expect(chip.tag).toBe("button");
    chip.fire("click", { stopPropagation: () => undefined });
    expect(el.querySelectorAll(".wl-reading-row")).toHaveLength(1);
    controller.destroy();
  });

  it("wears the same modifier on a card, so both surfaces say it in one colour", async () => {
    const { el, reading, controller } = await mount({ mode: "grid" });
    reading.update("book", "dune", { categories: ["Sci-Fi"] }, "test");
    controller.refresh();

    const card = cards(el).find((c) => c.textContent?.includes("Dune")) as StubEl;
    const pills = card.querySelectorAll(".wl-pill");
    const category = pills.find((pill) => pill.hasClass("is-category")) as StubEl;
    expect(category).toBeDefined();
    expect(category.textContent).toBe("Sci-Fi");
    // The status keeps its own colour source; only the category borrows one.
    expect(pills.filter((pill) => pill.hasClass("is-category"))).toHaveLength(1);
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("teardown", () => {
  it("takes the grid with it", async () => {
    const { host, el, controller } = await mount({ mode: "grid" });
    expect(el.querySelectorAll(".wl-vgrid").length).toBe(1);
    controller.destroy();
    expect(host.children).toHaveLength(0);
  });
});
