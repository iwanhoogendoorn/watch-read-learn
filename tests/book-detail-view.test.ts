/**
 * The book detail **view**, driven against a real store — and the modal beside
 * it, driven through the same assertions.
 *
 * The complaint that started this was one sentence: "the book pages and authors
 * etc etc still behave differently as the movies one". A film had already been
 * given a workspace leaf with its poster beside its facts, its numbers as tiles
 * and its rating bound to its review; a book had a narrow stacked modal and no
 * review at all. So this file exists to prove four things:
 *
 *   1. the layout a book was asked for is actually there — cover, title, author,
 *      publisher and year, synopsis, stat tiles, one control row, progress,
 *      dates with Today buttons, categories, the file field, notes, delete;
 *   2. the stat tiles are right for the shapes a book comes in, including the
 *      one with no page count, which must read as *unknown* rather than as
 *      `NaN` or a confident `0%`;
 *   3. **rating and review move each other, on screen.** That binding has been
 *      reported broken four separate times and it is the same binding here as
 *      everywhere else — `data/review.ts` through `ui/detail/judgement.ts` —
 *      so these assert what the controls *show*, exactly as
 *      `detail-rating-review.test.ts` does for a film;
 *   4. **the modal and the view agree**, because neither owns a control. They
 *      lay them out differently on purpose; the only thing stopping them
 *      drifting is that both render from `domains/reading/detail/`.
 *
 * No layout engine here (see `helpers/dom.ts`), so nothing asserts pixels — and
 * no network: no client is injected, which every section treats as a real
 * answer rather than as a reason to fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WatchLogStore } from "../src/data/store";
import { createBook, createManga } from "../src/data/schema";
import { createReadingStore, type ReadingStore } from "../src/domains/reading/store";
import { ReadingDetailModal } from "../src/domains/reading/modals/detail";
import {
  readingStatTiles,
  renderReadingStatTiles,
} from "../src/domains/reading/detail/stats";
import { readingExtra } from "../src/domains/reading/detail/extras";
import { fetchBookRating, pickDescription } from "../src/domains/reading/community";
import {
  mountBookDetail,
  openBookDetail,
  isBookDetailViewRegistered,
  type BookDetailController,
} from "../src/ui/views/book-detail";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import {
  readExtra,
  type Book,
  type BookSearchResult,
  type GoogleBooksClient,
} from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(1200);
});

afterEach(() => {
  restore();
});

const NOW = (): Date => new Date("2026-08-18T10:00:00.000Z");

async function shelf(over: Partial<Book> & Record<string, unknown> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const reading: ReadingStore = createReadingStore(store);

  const book = createBook({ id: "b", title: "Dune", author: "Frank Herbert" });
  Object.assign(book, over);
  reading.reading.books.push(book);
  return { store, reading, book };
}

async function open(over: Partial<Book> & Record<string, unknown> = {}) {
  const { store, reading, book } = await shelf(over);
  const host = createHost(1200);
  const jumped: string[] = [];
  const authors: string[] = [];
  const closed: number[] = [];
  const pane: BookDetailController = mountBookDetail(
    host as unknown as HTMLElement,
    { kind: "book", id: "b" },
    {
      app: {} as never,
      store: store as never,
      reading,
      onJumpToQuery: (query) => jumped.push(query),
      onOpenNote: () => undefined,
      onClose: () => closed.push(1),
      now: NOW,
    },
  );
  return { store, reading, book, pane, jumped, authors, closed, el: host as unknown as StubEl };
}

/** The same book in the modal, so both surfaces face the same assertions. */
async function openModal(over: Partial<Book> & Record<string, unknown> = {}) {
  const { store, reading, book } = await shelf(over);
  const jumped: string[] = [];
  const modal = new ReadingDetailModal({} as never, {
    store: reading,
    watch: store as never,
    kind: "book",
    id: "b",
    onJumpToQuery: (query) => jumped.push(query),
    now: NOW,
  });
  const contentEl = createHost(1200);
  const modalEl = createHost(1200);
  Object.assign(modal as unknown as Record<string, unknown>, {
    contentEl,
    modalEl,
    close: () => undefined,
  });
  modal.onOpen();
  return { store, reading, book, jumped, el: contentEl as unknown as StubEl };
}

function reviewSelect(el: StubEl): StubEl {
  const select = el
    .querySelectorAll("select")
    .find((s) => s.getAttribute("aria-label") === "Review");
  if (!select) throw new Error("no Review select");
  return select;
}

function statusSelect(el: StubEl): StubEl {
  const select = el
    .querySelectorAll("select")
    .find((s) => s.getAttribute("aria-label") === "Status");
  if (!select) throw new Error("no Status select");
  return select;
}

function stars(el: StubEl): StubEl {
  const widget = el.querySelectorAll(".wl-stars")[0];
  if (!widget) throw new Error("no stars widget");
  return widget;
}

function statTile(el: StubEl, label: string): string {
  const tile = el
    .querySelectorAll(".wl-stat")
    .find((box) => box.querySelector(".wl-stat-label")?.textContent === label);
  return tile?.querySelector(".wl-stat-value")?.textContent ?? "";
}

function statLabels(el: StubEl): string[] {
  return el.querySelectorAll(".wl-stat-label").map((label) => label.textContent);
}

function fieldByLabel(el: StubEl, label: string): StubEl | undefined {
  return el
    .querySelectorAll("input")
    .concat(el.querySelectorAll("textarea"))
    .find((node) => node.getAttribute("aria-label") === label);
}

// ---------------------------------------------------------------------------

describe("the sections the book view is made of", () => {
  it("draws all of them, in order", async () => {
    const { el } = await open({
      totalPages: 528,
      pagesRead: 312,
      categories: ["Science Fiction"],
      releaseDate: "1965-08-01",
      publisher: "Chilton Books",
      description: "A desert planet, a spice, and a great deal of scheming.",
    });

    // Head: the cover beside the facts, the synopsis under them.
    expect(el.querySelectorAll(".wl-reading-cover").length).toBe(1);
    expect(el.querySelector(".wl-bdv-title")?.textContent).toBe("Dune");
    expect(el.querySelector(".wl-reading-author")?.textContent).toBe("Frank Herbert");
    expect(el.querySelector(".wl-bdv-facts")?.textContent).toBe("Chilton Books · 1965");
    expect(el.querySelector(".wl-bdv-overview")?.textContent).toContain("desert planet");
    expect(el.querySelector(".wl-bdv-pills")?.textContent).toContain("Science Fiction");

    // …then the tiles, the control row, progress, dates, the editor, delete.
    expect(el.querySelectorAll(".wl-stat-grid").length).toBe(1);
    expect(el.querySelectorAll(".wl-bdv-controls").length).toBe(1);
    expect(el.querySelectorAll(".wl-bdv-progress").length).toBe(1);
    expect(el.querySelectorAll(".wl-bdv-dates").length).toBe(1);
    expect(el.querySelectorAll(".wl-reading-categories-field").length).toBe(1);
    expect(el.querySelectorAll(".wl-reading-file-field").length).toBe(1);
    expect(el.querySelectorAll("textarea").length).toBe(2);
    expect(el.querySelectorAll("button").some((b) => b.textContent === "Delete")).toBe(true);
  });

  it("keeps the head above the fold — cover, facts, numbers, controls", async () => {
    const { el } = await open({ totalPages: 300 });
    const order = el
      .flatten()
      .filter((node) =>
        ["wl-bdv-head", "wl-stat-grid", "wl-bdv-controls"].some((cls) => node.hasClass(cls)),
      )
      .map((node) => node.className.split(" ")[0]);
    expect(order).toEqual(["wl-bdv-head", "wl-stat-grid", "wl-bdv-controls"]);
  });

  it("gives every date a Today button, as the film view does", async () => {
    const { el } = await open();
    const dates = el.querySelectorAll(".wl-bdv-dates")[0];
    expect(dates?.querySelectorAll(".wl-date-input").length).toBe(3);
    expect(
      dates?.querySelectorAll("button").filter((b) => b.textContent === "Today").length,
    ).toBe(3);
  });

  it("says so, instead of going blank, when the book is gone", async () => {
    const { reading, pane, el } = await open();
    reading.deleteBook("b");
    pane.refresh();
    expect(el.textContent).toContain("no longer in your library");
  });
});

// ---------------------------------------------------------------------------
// Degrading cleanly. A book with nothing filled in is the common case.
// ---------------------------------------------------------------------------

describe("a book with nothing filled in", () => {
  it("draws a placeholder cover, an honest synopsis line and no NaN anywhere", async () => {
    const { el } = await open();
    // No cover URL and no ISBN: the placeholder, not a broken image.
    expect(el.querySelectorAll(".wl-poster-initial").length).toBe(1);
    expect(el.querySelectorAll("img").length).toBe(0);
    expect(el.querySelector(".wl-bdv-overview")?.textContent).toContain(
      "No synopsis stored",
    );
    expect(el.textContent).not.toContain("NaN");
    expect(el.textContent).not.toContain("undefined");
  });

  it("draws no facts line at all rather than an empty one", async () => {
    const { el } = await open();
    expect(el.querySelectorAll(".wl-bdv-facts").length).toBe(0);
  });

  it("offers both ways to attach a file when none is linked", async () => {
    const { el } = await open();
    const labels = el.querySelectorAll("button").map((b) => b.textContent);
    expect(labels).toContain("Choose from vault");
    expect(labels).toContain("Import from disk…");
    // Nothing linked, so nothing pretends to open it.
    expect(
      el.querySelectorAll("button").some((b) => b.getAttribute("aria-label") === "Open the book"),
    ).toBe(false);
  });

  it("offers to open the file once one is linked", async () => {
    const { el } = await open({ filePath: "Books/Dune.pdf" });
    expect(
      el.querySelectorAll("button").some((b) => b.getAttribute("aria-label") === "Open the book"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tiles
// ---------------------------------------------------------------------------

describe("the stat tiles", () => {
  it("reuses the detail surfaces' own component rather than a third one", async () => {
    const { el } = await open({ totalPages: 528, pagesRead: 312 });
    expect(el.querySelectorAll(".wl-stat-grid.wl-stat-tiles").length).toBe(1);
    expect(el.querySelectorAll(".wl-stat").length).toBe(3);
  });

  it("splits a part-read book between read, left and progress", async () => {
    const { el } = await open({ totalPages: 528, pagesRead: 312 });
    expect(statLabels(el)).toEqual(["Pages read", "Pages left", "Progress"]);
    expect(statTile(el, "Pages read")).toBe("312");
    expect(statTile(el, "Pages left")).toBe("216");
    expect(statTile(el, "Progress")).toBe("59%");
  });

  it("counts a word-tracked book in words, and says so", async () => {
    const { el } = await open({ progressUnit: "words", wordsRead: 12500, totalWords: 90000 });
    expect(statLabels(el)).toEqual(["Words read", "Words left", "Progress"]);
    // Grouped, so 90 000 does not read as a wall of zeros.
    expect(statTile(el, "Words left")).toBe("77 500");
    expect(statTile(el, "Progress")).toBe("14%");
  });

  it("drops the tiles it has no number for rather than inventing a zero", async () => {
    // No total: "0 pages left" and "0%" are true of the arithmetic and read on
    // screen as *unmeasured being reported as unstarted*.
    const { el } = await open({ pagesRead: 40 });
    expect(statLabels(el)).toEqual(["Pages read"]);
    expect(statTile(el, "Pages read")).toBe("40");
    expect(el.textContent).not.toContain("NaN");
    expect(el.textContent).not.toContain("%");
  });

  it("draws no grid at all rather than an empty one", async () => {
    const bare = createBook({ id: "bare", title: "Bare" });
    expect(readingStatTiles(bare)).toEqual([]);
    const host = createHost(600);
    expect(renderReadingStatTiles(host as unknown as HTMLElement, bare)).toBeNull();
    expect(host.children.length).toBe(0);
  });

  it("gives a manga its volumes as well as its chapters", () => {
    const manga = createManga({ id: "m", title: "Berserk" });
    Object.assign(manga, {
      chaptersRead: 100,
      totalChapters: 374,
      volumesRead: 12,
      totalVolumes: 41,
    });
    expect(readingStatTiles(manga)).toEqual([
      { label: "Chapters read", value: "100" },
      { label: "Chapters left", value: "274" },
      { label: "Volumes", value: "12/41" },
      { label: "Progress", value: "27%" },
    ]);
  });

  it("repaints its numbers when the counter is bumped", async () => {
    // Clicked, not written behind the view's back: the point is that the tiles
    // move on screen, which is the difference between a write that happened and
    // a write anybody can tell happened.
    const { el, reading } = await open({ totalPages: 100, pagesRead: 10 });
    expect(statTile(el, "Progress")).toBe("10%");
    const plus = el
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === "One more page");
    plus?.fire("click");
    expect(reading.getBook("b")?.pagesRead).toBe(11);
    expect(statTile(el, "Pages read")).toBe("11");
    expect(statTile(el, "Progress")).toBe("11%");
  });
});

// ---------------------------------------------------------------------------
// The binding. Four bug reports live here, and now a book is inside it too.
// ---------------------------------------------------------------------------

describe("picking a review for a book", () => {
  it("moves the rating with it, in the store", async () => {
    const { reading, el } = await open();
    const select = reviewSelect(el);
    select.value = "Marvelous";
    select.fire("change");

    const book = reading.getBook("b");
    expect(readExtra<string>(book as object, "review")).toBe("Marvelous");
    expect(book?.rating).toBe(5);
  });

  it("moves the rating on screen too, not only in the data", async () => {
    // A write nobody can see is indistinguishable from no write at all.
    const { el } = await open();
    const select = reviewSelect(el);
    select.value = "Nah";
    select.fire("change");

    expect(stars(el).getAttribute("aria-valuetext")).toContain("1");
  });

  it("clears the rating when the review is cleared", async () => {
    const { reading, el } = await open({ rating: 4, review: "Awesome" });
    const select = reviewSelect(el);
    select.value = "";
    select.fire("change");

    const book = reading.getBook("b");
    expect(book?.rating).toBe(0);
    expect(readExtra<string>(book as object, "review")).toBe("");
    expect(stars(el).getAttribute("aria-valuetext")).toBe("unrated");
  });

  it("overwrites a review the user set by hand", async () => {
    const { reading, el } = await open({ rating: 5, review: "Marvelous" });
    const select = reviewSelect(el);
    select.value = "Meh";
    select.fire("change");

    expect(readExtra<string>(reading.getBook("b") as object, "review")).toBe("Meh");
    expect(reading.getBook("b")?.rating).toBe(2);
    expect(stars(el).getAttribute("aria-valuetext")).toContain("2");
  });
});

describe("setting a rating on a book", () => {
  it("moves the review with it, in the store and in the select", async () => {
    const { reading, el } = await open();
    // Keyboard is the deterministic path: one press per step from zero.
    for (let i = 0; i < 4; i += 1) {
      stars(el).fire("keydown", {
        key: "ArrowRight",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(reading.getBook("b")?.rating).toBe(4);
    expect(readExtra<string>(reading.getBook("b") as object, "review")).toBe("Awesome");
    expect(reviewSelect(el).value).toBe("Awesome");
  });

  it("uses the same five labels a film uses — one scale, twice", async () => {
    const { el } = await open();
    const options = reviewSelect(el)
      .querySelectorAll("option")
      .map((option) => option.value);
    expect(options).toEqual(["", "Nah", "Meh", "Good", "Awesome", "Marvelous"]);
  });
});

describe("the modal, through the same assertions", () => {
  it("renders the same controls — it does not own any of them", async () => {
    const { el } = await openModal({ totalPages: 528, pagesRead: 312 });
    expect(el.querySelectorAll(".wl-stat-grid.wl-stat-tiles").length).toBe(1);
    expect(el.querySelectorAll(".wl-reading-progress-row").length).toBe(1);
    expect(reviewSelect(el)).toBeDefined();
    expect(stars(el)).toBeDefined();
    expect(statusSelect(el)).toBeDefined();
    // The dates come from the shared field, so they carry Today here too.
    expect(el.querySelectorAll("button").filter((b) => b.textContent === "Today").length).toBe(3);
  });

  it("binds rating and review exactly as the view does", async () => {
    const { reading, el } = await openModal();
    const select = reviewSelect(el);
    select.value = "Good";
    select.fire("change");

    expect(reading.getBook("b")?.rating).toBe(3);
    expect(readExtra<string>(reading.getBook("b") as object, "review")).toBe("Good");
    expect(stars(el).getAttribute("aria-valuetext")).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// Status, fields and the preserved keys
// ---------------------------------------------------------------------------

describe("the fields", () => {
  it("does not offer a status the next render would overrule", async () => {
    const { el } = await open();
    const values = statusSelect(el)
      .querySelectorAll("option")
      .map((option) => option.value);
    expect(values).toEqual(["Reading", "Completed", "Plan to Read", "Dropped"]);
  });

  it("fills the counter in when the book is marked finished", async () => {
    const { reading, el } = await open({ totalPages: 528, pagesRead: 10 });
    const select = statusSelect(el);
    select.value = "Completed";
    select.fire("change");
    expect(reading.getBook("b")?.pagesRead).toBe(528);
    expect(statTile(el, "Progress")).toBe("100%");
  });

  it("keeps the synopsis, the publisher and the notes on the row", async () => {
    const { reading, el } = await open();

    const synopsis = fieldByLabel(el, "Synopsis");
    synopsis!.value = "A desert planet.";
    synopsis!.fire("change");

    const publisher = fieldByLabel(el, "Publisher");
    publisher!.value = "Chilton Books";
    publisher!.fire("change");

    const notes = fieldByLabel(el, "Notes");
    notes!.value = "Lent to Anna.";
    notes!.fire("change");

    const book = reading.getBook("b") as object;
    expect(readingExtra(book as never, "description")).toBe("A desert planet.");
    expect(readingExtra(book as never, "publisher")).toBe("Chilton Books");
    expect(readingExtra(book as never, "notes")).toBe("Lent to Anna.");
  });

  it("shows what it stored, on the next paint", async () => {
    const { el } = await open();
    const publisher = fieldByLabel(el, "Publisher");
    publisher!.value = "Chilton Books";
    publisher!.fire("change");
    expect(el.querySelector(".wl-bdv-facts")?.textContent).toBe("Chilton Books");
  });
});

// ---------------------------------------------------------------------------
// The author seam
// ---------------------------------------------------------------------------

describe("the author", () => {
  it("filters the shelf when there is nowhere else to go — today's behaviour", async () => {
    const { el, jumped } = await open();
    el.querySelector(".wl-reading-author")?.fire("click", {});
    expect(jumped).toEqual(['author:"Frank Herbert"']);
  });

  it("opens the author when an opener is wired, and Alt-click still filters", async () => {
    const { store, reading } = await shelf();
    const host = createHost(1200);
    const jumped: string[] = [];
    const opened: string[] = [];
    mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      {
        app: {} as never,
        store: store as never,
        reading,
        onJumpToQuery: (query) => jumped.push(query),
        onOpenAuthor: (name) => opened.push(name),
        now: NOW,
      },
    );
    const el = host as unknown as StubEl;
    const link = el.querySelector(".wl-reading-author");

    link?.fire("click", {});
    expect(opened).toEqual(["Frank Herbert"]);
    expect(jumped).toEqual([]);

    link?.fire("click", { altKey: true });
    expect(jumped).toEqual(['author:"Frank Herbert"']);
    expect(opened).toEqual(["Frank Herbert"]);
  });

  it("draws no author at all when the book has none", async () => {
    const { el } = await open({ author: "" });
    expect(el.querySelectorAll(".wl-reading-author").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Where a synopsis comes from
// ---------------------------------------------------------------------------

describe("the Google pass", () => {
  const hit = (over: Partial<BookSearchResult>): BookSearchResult => ({
    id: "vol",
    source: "googlebooks",
    title: "Dune",
    authors: ["Frank Herbert"],
    coverUrl: "",
    ...over,
  });

  it("takes the blurb off the first edition that has one", () => {
    expect(pickDescription([hit({}), hit({ description: "  A desert planet.  " })])).toBe(
      "A desert planet.",
    );
    expect(pickDescription([hit({}), hit({ description: "   " })])).toBe("");
  });

  it("carries it back with the rating — one button, one quota hit", async () => {
    const client = {
      configured: () => true,
      byIsbn: async () => undefined,
      search: async () => [hit({ averageRating: 4.2, ratingsCount: 9, description: "Spice." })],
    } as unknown as GoogleBooksClient;
    const info = await fetchBookRating(client, { title: "Dune", author: "Frank Herbert" });
    expect(info.rated).toEqual({ rating: 4.2, votes: 9 });
    expect(info.description).toBe("Spice.");
  });

  it("says nothing rather than 'no description' when nobody looked", async () => {
    const client = {
      configured: () => true,
      byIsbn: async () => undefined,
      search: async () => [hit({})],
    } as unknown as GoogleBooksClient;
    const info = await fetchBookRating(client, { title: "Dune", author: "Frank Herbert" });
    expect(info.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Opening it
// ---------------------------------------------------------------------------

describe("openBookDetail", () => {
  it("refuses rather than opening an empty leaf when nothing registered the view", async () => {
    // `main.ts` registers it in `onload`; until it does, the Reading tab has to
    // be able to tell, so it can fall back to the modal instead of handing the
    // user a blank tab.
    expect(isBookDetailViewRegistered()).toBe(false);
    expect(await openBookDetail({} as never, { kind: "book", id: "b" })).toBe(false);
  });
});
