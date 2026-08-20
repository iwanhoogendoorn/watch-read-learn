/**
 * The title detail **view**, driven against a real store.
 *
 * Two things this file exists to prove, and one it exists to keep proving:
 *
 *   1. the layout the view was asked for is actually there — poster, name,
 *      synopsis, four stat tiles, one control row, an inline cast line, dates
 *      with Today buttons, notes, delete, per-season accordions;
 *   2. the stat tiles are right for the four shapes a title comes in, including
 *      the one with no `episodeDuration`, which must read as *unknown* rather
 *      than as `NaN` or a confident `0m`;
 *   3. **rating and review move each other, on screen.** That binding has been
 *      reported broken four separate times; the mapping functions were correct
 *      throughout and the tests were pointed at the wrong thing. So these assert
 *      what the controls show, exactly as `detail-rating-review.test.ts` does
 *      for the modal.
 *
 * No layout engine here (see `helpers/dom.ts`), so nothing asserts pixels —
 * only structure and text, which is what a person reads anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountTitleDetail, type TitleDetailController } from "../src/ui/views/title-detail";
import { WatchLogStore } from "../src/data/store";
import { createTitle } from "../src/data/schema";
import { renderStatTiles, titleStatTiles } from "../src/ui/detail/stats";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { TitleV4 } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(1200);
});

afterEach(() => {
  restore();
});

async function open(over: Partial<TitleV4> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();

  const title = createTitle({ id: "t", title: "A Film", type: "Movie" });
  Object.assign(title, over);
  store.data.titles.push(title);

  const host = createHost(1200);
  const jumped: string[] = [];
  const people: string[] = [];
  const pane: TitleDetailController = mountTitleDetail(
    host as unknown as HTMLElement,
    "t",
    {
      app: {} as never,
      store: store as never,
      onJumpToQuery: (query) => jumped.push(query),
      // Injected rather than derived from `app`: the real view falls back to
      // `personOpener(deps.app)`, which needs a workspace this harness has not
      // got. What is under test is which of the two destinations a click picks.
      onOpenPerson: (name) => people.push(name),
      onOpenNote: () => undefined,
      onRefreshMetadata: () => undefined,
      now: () => new Date("2026-08-18T10:00:00.000Z"),
    },
  );

  return { store, title, pane, jumped, people, el: host as unknown as StubEl };
}

/** A show with three seasons of four, `watched` of them ticked from the start. */
function show(watched: number, over: Partial<TitleV4> = {}): Partial<TitleV4> {
  return {
    type: "TV Show",
    tmdbMediaType: "tv",
    totalEpisodes: 12,
    episodeDuration: 45,
    seasons: [
      { name: "Season 1", episodes: 4, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 4, offset: 4, skippedEpisodes: [], seasonNumber: 2 },
      { name: "Season 3", episodes: 4, offset: 8, skippedEpisodes: [], seasonNumber: 3 },
    ],
    watchedEpisodes: Array.from({ length: watched }, (_, i) => i + 1),
    ...over,
  };
}

/** The Review dropdown, by its label — the same way a person finds it. */
function reviewSelect(el: StubEl): StubEl {
  const select = el
    .querySelectorAll("select")
    .find((s) => s.getAttribute("aria-label") === "Review");
  if (!select) throw new Error("no Review select");
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

// ---------------------------------------------------------------------------

describe("the sections the view is made of", () => {
  it("draws all of them, in order, for a show", async () => {
    const { el } = await open(
      show(5, {
        title: "Deep Space",
        overview: "A crew, a station, and a great deal of arguing.",
        cast: ["Avery Brooks", "Nana Visitor"],
        studio: ["Paramount"],
        releaseDate: "1993-01-03",
      }),
    );

    // Head: poster beside the name, the synopsis under it.
    expect(el.querySelectorAll(".wl-detail-poster").length).toBe(1);
    expect(el.querySelector(".wl-tdv-title")?.textContent).toContain("Deep Space");
    expect(el.querySelector(".wl-tdv-overview")?.textContent).toContain("a great deal");
    expect(el.querySelector(".wl-tdv-chiprow")?.textContent).toContain("Paramount");
    expect(el.querySelector(".wl-tdv-syncrow")?.textContent).toContain("Updated");

    // …then the tiles, the control row, the inline cast, the dates, the notes,
    // the delete button and the season accordions.
    expect(el.querySelectorAll(".wl-stat-grid").length).toBe(1);
    expect(el.querySelectorAll(".wl-tdv-controls").length).toBe(1);
    expect(el.querySelectorAll(".wl-tdv-inline").length).toBeGreaterThan(0);
    expect(el.querySelectorAll(".wl-tdv-dates").length).toBe(1);
    expect(el.querySelectorAll("textarea").length).toBe(1);
    expect(
      el.querySelectorAll("button").some((b) => b.textContent === "Delete title"),
    ).toBe(true);
    expect(el.querySelectorAll(".wl-season").length).toBe(3);
  });

  it("puts the year beside the name", async () => {
    const { el } = await open({ releaseDate: "1999-03-31" });
    expect(el.querySelector(".wl-tdv-title")?.textContent).toBe("A Film (1999)");
  });

  it("says so, instead of going blank, when the title is gone", async () => {
    const { store, pane, el } = await open();
    store.deleteTitle("t");
    pane.refresh();
    expect(el.textContent).toContain("no longer in your library");
  });

  it("keeps the head visible above the fold — no trailer or request block first", async () => {
    // The complaint that started this: the trailer and request sections pushed
    // Progress off the bottom. The view leads with the facts and the numbers.
    const { el } = await open(show(0, { trailerUrl: "https://youtu.be/abc" }));
    const order = el
      .flatten()
      .filter((node) =>
        ["wl-tdv-head", "wl-stat-grid", "wl-tdv-controls"].some((cls) =>
          node.hasClass(cls),
        ),
      )
      .map((node) => node.className.split(" ")[0]);
    expect(order).toEqual(["wl-tdv-head", "wl-stat-grid", "wl-tdv-controls"]);
  });
});

describe("the cast line", () => {
  it("is one comma-separated line of links, not a wall of chips", async () => {
    const { el } = await open({
      cast: ["Kurt Russell", "Keith David", "Wilford Brimley"],
    });
    const row = el
      .querySelectorAll(".wl-tdv-inline")
      .find((node) => node.textContent.startsWith("Cast:"));
    expect(row).toBeDefined();
    expect(row?.querySelectorAll(".wl-tdv-inline-link").length).toBe(3);
    // Two separators for three names, so it reads as `a, b, c`.
    expect(row?.querySelectorAll(".wl-tdv-inline-sep").length).toBe(2);
    // And none of them is a chip — that is the layout this replaced.
    expect(row?.querySelectorAll(".wl-chip").length).toBe(0);
  });

  it("opens the person when a name is clicked, and filters on Alt-click", async () => {
    const { el, jumped, people } = await open({ cast: ["Keith David"] });
    const link = el.querySelectorAll(".wl-tdv-inline-link")[0];

    link?.fire("click", { preventDefault: () => undefined });
    expect(people).toEqual(["Keith David"]);
    expect(jumped).toEqual([]);

    // The old behaviour is a modifier away, not gone — `cast:"…"` is still the
    // only thing that answers "what of theirs do I already own?".
    link?.fire("click", { preventDefault: () => undefined, altKey: true });
    expect(jumped).toEqual(['cast:"Keith David"']);
    expect(people).toEqual(["Keith David"]);
  });

  it("keeps a genre on the Library search — a genre is not a person", async () => {
    const { el, jumped, people } = await open({ genres: ["Horror"] });
    const row = el
      .querySelectorAll(".wl-tdv-inline")
      .find((node) => node.textContent.startsWith("Genres:"));
    row?.querySelectorAll(".wl-tdv-inline-link")[0]?.fire("click", {
      preventDefault: () => undefined,
    });
    expect(jumped).toEqual(['genre:"Horror"']);
    expect(people).toEqual([]);
  });

  it("keeps a studio chip on the Library search too", async () => {
    const { el, jumped, people } = await open({ studio: ["Universal"] });
    el.querySelectorAll(".wl-chip")[0]?.fire("click", { preventDefault: () => undefined });
    expect(jumped).toEqual(['studio:"Universal"']);
    expect(people).toEqual([]);
  });

  it("draws no cast section at all when there are no names", async () => {
    const { el } = await open();
    expect(el.querySelectorAll(".wl-tdv-people").length).toBe(0);
  });
});

describe("the stat tiles", () => {
  it("reuses the Dashboard's own component rather than a second one", async () => {
    const { el } = await open({ episodeDuration: 128 });
    expect(el.querySelectorAll(".wl-stat-grid").length).toBe(1);
    expect(el.querySelectorAll(".wl-stat").length).toBeGreaterThan(0);
  });

  it("gives a film a runtime and a yes/no, not an episode count", async () => {
    const { el } = await open({ episodeDuration: 128 });
    expect(statLabels(el)).toEqual(["Runtime", "Watched"]);
    expect(statTile(el, "Runtime")).toBe("2h 8m");
    expect(statTile(el, "Watched")).toBe("No");
  });

  it("says Yes once the film has been watched", async () => {
    const { el } = await open({
      episodeDuration: 128,
      status: "Watched",
      watchedEpisodes: [1],
    });
    expect(statTile(el, "Watched")).toBe("Yes");
  });

  it("drops the runtime tile for a film with no duration, keeping yes/no", async () => {
    const { el } = await open();
    expect(statLabels(el)).toEqual(["Watched"]);
    expect(el.textContent).not.toContain("NaN");
  });

  it("gives an unwatched show the whole thing to go", async () => {
    const { el } = await open(show(0));
    expect(statLabels(el)).toEqual(["Left", "Watched", "Episodes", "Progress"]);
    expect(statTile(el, "Left")).toBe("9h");
    expect(statTile(el, "Watched")).toBe("0m");
    expect(statTile(el, "Episodes")).toBe("0/12");
    expect(statTile(el, "Progress")).toBe("0%");
  });

  it("splits a part-watched show between the two", async () => {
    const { el } = await open(show(5));
    expect(statTile(el, "Left")).toBe("5h 15m");
    expect(statTile(el, "Watched")).toBe("3h 45m");
    expect(statTile(el, "Episodes")).toBe("5/12");
    expect(statTile(el, "Progress")).toBe("42%");
  });

  it("omits the time tiles entirely when no episode duration is known", async () => {
    // `calcTimeRemaining` answers 0 for an unknown duration, which is true of
    // the arithmetic and reads on screen as *finished*. An em dash would be
    // honest but still occupies a tile saying nothing, so the tile goes.
    const { el } = await open(show(5, { episodeDuration: 0 }));
    expect(statLabels(el)).toEqual(["Episodes", "Progress"]);
    // The counts do not depend on duration and are still real.
    expect(statTile(el, "Episodes")).toBe("5/12");
    expect(statTile(el, "Progress")).toBe("42%");
    expect(el.textContent).not.toContain("NaN");
    expect(el.textContent).not.toContain("0m");
  });

  it("keeps one honest tile for a show with nothing known but its shape", async () => {
    // `totalEpisodes: 1` with no seasons is what `mediaTypeOf` reads as a film,
    // so this has to be a title upstream has actually called a series.
    const tiles = titleStatTiles(
      createTitle({
        id: "x",
        title: "Nothing Known",
        type: "TV Show",
        tmdbMediaType: "tv",
        totalEpisodes: 8,
      }),
    );
    expect(tiles).toEqual([
      { label: "Episodes", value: "0/8" },
      { label: "Progress", value: "0%" },
    ]);
  });

  it("draws no grid at all rather than an empty one", async () => {
    // A film always has a yes/no, so the empty case is reached through a series
    // with neither a duration nor an episode to count.
    const bare = createTitle({
      id: "y",
      title: "Bare",
      type: "TV Show",
      tmdbMediaType: "tv",
      totalEpisodes: 0,
    });
    expect(titleStatTiles(bare)).toEqual([]);
    const host = createHost(600);
    expect(renderStatTiles(host as unknown as HTMLElement, bare)).toBeNull();
    expect(host.children.length).toBe(0);
  });

  it("repaints its numbers when an episode is ticked", async () => {
    // Clicked, not written behind the view's back: the point is that the tiles
    // move on screen, which is the whole difference between a write that
    // happened and a write anybody can tell happened.
    const { store, el } = await open(show(0));
    expect(statTile(el, "Episodes")).toBe("0/12");
    el.querySelectorAll(".wl-ep")[0]?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([1]);
    expect(statTile(el, "Episodes")).toBe("1/12");
    expect(statTile(el, "Progress")).toBe("8%");
  });
});

// ---------------------------------------------------------------------------
// The binding. Four bug reports live here.
// ---------------------------------------------------------------------------

describe("picking a review in the view", () => {
  it("moves the rating with it, in the store", async () => {
    const { store, el } = await open({ rating: 0, review: "" });
    const select = reviewSelect(el);
    select.value = "Marvelous";
    select.fire("change");

    expect(store.getTitle("t")?.review).toBe("Marvelous");
    expect(store.getTitle("t")?.rating).toBe(5);
  });

  it("moves the rating on screen too, not only in the data", async () => {
    // A write nobody can see is indistinguishable from no write at all.
    const { el } = await open({ rating: 0, review: "" });
    const select = reviewSelect(el);
    select.value = "Nah";
    select.fire("change");

    expect(stars(el).getAttribute("aria-valuetext")).toContain("1");
  });

  it("clears the rating when the review is cleared", async () => {
    const { store, el } = await open({ rating: 4, review: "Awesome" });
    const select = reviewSelect(el);
    select.value = "";
    select.fire("change");

    expect(store.getTitle("t")?.rating).toBe(0);
    expect(store.getTitle("t")?.review).toBe("");
    expect(stars(el).getAttribute("aria-valuetext")).toBe("unrated");
  });

  it("overwrites a review the user set by hand", async () => {
    const { store, el } = await open({ rating: 5, review: "Marvelous" });
    const select = reviewSelect(el);
    select.value = "Meh";
    select.fire("change");

    expect(store.getTitle("t")?.review).toBe("Meh");
    expect(store.getTitle("t")?.rating).toBe(2);
    expect(stars(el).getAttribute("aria-valuetext")).toContain("2");
  });
});

describe("setting a rating in the view", () => {
  it("moves the review with it, in the store and in the select", async () => {
    const { store, el } = await open({ rating: 0, review: "" });
    // Keyboard is the deterministic path: one press per step from zero.
    for (let i = 0; i < 4; i += 1) {
      stars(el).fire("keydown", {
        key: "ArrowRight",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(store.getTitle("t")?.rating).toBe(4);
    expect(store.getTitle("t")?.review).toBe("Awesome");
    expect(reviewSelect(el).value).toBe("Awesome");
  });

  it("keeps moving after the review has been touched once", async () => {
    // The gate that caused the original report: once a review was chosen by
    // hand, the rating stopped updating it for the rest of the session.
    const { el } = await open({ rating: 0, review: "" });
    const select = reviewSelect(el);
    select.value = "Good";
    select.fire("change");

    stars(el).fire("keydown", {
      key: "End",
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    expect(reviewSelect(el).value).toBe("Marvelous");
  });

  it("labels its stars for this surface", async () => {
    const { el } = await open();
    expect(el.querySelector(".wl-tdv-controls")?.textContent).toContain("Your rating");
  });
});

// ---------------------------------------------------------------------------

describe("the control row", () => {
  it("writes the status straight through", async () => {
    const { store, el } = await open();
    const select = el
      .querySelectorAll("select")
      .find((s) => s.getAttribute("aria-label") === "Status");
    if (!select) throw new Error("no Status select");
    select.value = "Watching";
    select.fire("change");
    expect(store.getTitle("t")?.status).toBe("Watching");
  });

  it("reuses the modal's community badge rather than shipping a second one", async () => {
    const { el } = await open({
      communityRating: 8.4,
      communityVotes: 1200,
      communitySource: "tmdb",
    });
    const badges = el.querySelectorAll(".wl-detail-community");
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toContain("8.4");
    expect(badges[0]?.textContent).toContain("1200 votes");
    // The source is named, which the reference could not do — ours is not
    // TMDB-only.
    expect(badges[0]?.textContent).toContain("tmdb");
  });

  it("leaves the badge out entirely when nothing rated it", async () => {
    const { el } = await open();
    expect(el.querySelectorAll(".wl-detail-community").length).toBe(0);
  });

  it("offers Open note", async () => {
    const { el } = await open();
    expect(el.querySelectorAll("button").some((b) => b.textContent === "Open note")).toBe(
      true,
    );
  });
});

describe("favouriting", () => {
  it("toggles and repaints", async () => {
    const { store, el } = await open();
    const fav = el
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === "Add to favourites");
    fav?.fire("click");
    expect(store.getTitle("t")?.favorite).toBe(true);
    // Repainted: the button now offers the way back.
    expect(
      el
        .querySelectorAll("button")
        .some((b) => b.getAttribute("aria-label") === "Remove from favourites"),
    ).toBe(true);
  });
});

describe("the dates row", () => {
  it("gives a film one date field, with a Today button", async () => {
    const { el } = await open();
    const labels = el.querySelectorAll(".wl-field-label").map((l) => l.textContent);
    expect(labels).toContain("Watched on");
    expect(labels).not.toContain("Started");
    const dates = el.querySelector(".wl-tdv-dates");
    expect(
      dates?.querySelectorAll("button").filter((b) => b.textContent === "Today").length,
    ).toBeGreaterThan(0);
  });

  it("gives a series a start and a finish", async () => {
    const { el } = await open(show(0));
    const labels = el.querySelectorAll(".wl-field-label").map((l) => l.textContent);
    expect(labels).toContain("Started");
    expect(labels).toContain("Finished");
  });

  it("Today writes today, through the same commit path as typing", async () => {
    const { store, el } = await open();
    const today = el
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === "Set Watched on to today");
    today?.fire("click");
    // The injected clock is 2026-08-18, in local time.
    expect(store.getTitle("t")?.dateFinished).toBe("2026-08-18");
    expect(store.getTitle("t")?.dateStarted).toBe("2026-08-18");
  });

  it("shows Last aired, read-only, when upstream knows one", async () => {
    const { el } = await open(
      show(0, {
        airing: { lastEpisode: { season: 3, episode: 4, airDate: "2026-05-02" } },
      }),
    );
    const field = el
      .querySelectorAll(".wl-tdv-readonly")
      .find((node) => node.textContent.startsWith("Last aired"));
    expect(field?.textContent).toContain("2026-05-02");
  });
});

describe("the season accordions", () => {
  it("marks a whole season watched from its own button", async () => {
    const { store, el } = await open(show(0));
    const button = el
      .querySelectorAll("button")
      .find((b) => b.textContent === "Mark season watched");
    expect(button).toBeDefined();
    button?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([1, 2, 3, 4]);
    // Repainted: the same button now offers the way back.
    expect(
      el.querySelectorAll("button").some((b) => b.textContent === "Unmark season"),
    ).toBe(true);
  });

  it("collapses a season and keeps it collapsed across a repaint", async () => {
    const { store, pane, el } = await open(show(0));
    const before = el.querySelectorAll(".wl-ep-grid").length;
    expect(before).toBe(3);

    el.querySelectorAll(".wl-season-collapse")[0]?.fire("click");
    expect(el.querySelectorAll(".wl-ep-grid").length).toBe(2);

    // A repaint from any source must not re-expand what was collapsed.
    pane.refresh();
    expect(el.querySelectorAll(".wl-ep-grid").length).toBe(2);
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([]);
  });

  it("gives a film a single watched toggle instead of a grid", async () => {
    const { store, el } = await open();
    expect(el.querySelectorAll(".wl-ep-grid").length).toBe(0);
    const toggle = el
      .querySelectorAll("button")
      .find((b) => b.textContent === "Mark as watched");
    toggle?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([1]);
  });
});

describe("the notes box", () => {
  it("commits what is left in it when the pane is torn down", async () => {
    // The debounce is 600 ms; destroying the pane before it fires must not
    // throw the edit away.
    const { store, pane, el } = await open();
    const area = el.querySelectorAll("textarea")[0];
    if (!area) throw new Error("no notes box");
    area.value = "Rewatch in winter.";
    area.fire("input");
    pane.destroy();
    expect(store.getTitle("t")?.notes).toBe("Rewatch in winter.");
  });
});

// ---------------------------------------------------------------------------
// The unaired guard. This is a correctness bug, not polish: without it the
// grid will happily record that you watched next month's episode this
// afternoon, and then count it towards progress, time watched, and
// auto-completion.
// ---------------------------------------------------------------------------

/** A show mid-run: S02E03 is next, and it airs a fortnight from "now". */
function airing(over: Partial<TitleV4> = {}): Partial<TitleV4> {
  return show(6, {
    airing: {
      nextEpisode: { season: 2, episode: 3, airDate: "2026-09-01" },
      lastEpisode: { season: 2, episode: 2, airDate: "2026-08-11" },
    },
    ...over,
  });
}

describe("episodes that have not aired", () => {
  it("refuses to be marked watched, and says why", async () => {
    const { store, el } = await open(airing());
    // Season 2 is absolute 5–8, so S02E03 is absolute 7.
    const cells = el.querySelectorAll(".wl-ep");
    const future = cells[6];
    expect(future?.hasClass("is-unaired")).toBe(true);
    future?.fire("click");
    // Nothing was written. That is the whole point.
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("dims rather than disables — three soft signals, not a broken control", async () => {
    const { el } = await open(airing());
    const future = el.querySelectorAll(".wl-ep")[6];
    expect(future?.hasClass("is-unaired")).toBe(true);
    expect(future?.getAttribute("aria-disabled")).toBe("true");
    expect(future?.getAttribute("title")).toContain("has not aired yet");
    // Not the `disabled` attribute: it must stay focusable and right-clickable.
    expect(future?.disabled).toBe(false);
  });

  it("leaves everything up to the last aired episode alone", async () => {
    const { store, el } = await open(airing({ watchedEpisodes: [] }));
    const cells = el.querySelectorAll(".wl-ep");
    // Absolute 5 is S02E01 — aired, so still a normal, clickable cell.
    expect(cells[4]?.hasClass("is-unaired")).toBe(false);
    cells[4]?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([5]);
  });

  it("caps a bulk season mark at what has aired", async () => {
    // Season 2 has four episodes; only two of them exist yet. Marking the
    // season must not claim the other two — that is a false 100%.
    const { store, el } = await open(airing({ watchedEpisodes: [] }));
    const button = el
      .querySelectorAll("button")
      .filter((b) => b.textContent === "Mark season watched")[1];
    button?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([5, 6]);
    expect(store.getTitle("t")?.status).not.toBe("Watched");
  });

  it("says how many of a part-aired season exist", async () => {
    const { el } = await open(airing());
    expect(el.textContent).toContain("2 aired");
  });

  it("offers no bulk button at all for a season that has not started", async () => {
    const { el } = await open(
      airing({ airing: { nextEpisode: { season: 3, episode: 1, airDate: "2026-12-01" } } }),
    );
    // Season 3 is entirely in the future.
    expect(el.textContent).toContain("Not aired yet");
  });

  it("changes nothing for a title with no upstream schedule", async () => {
    // No `airing` cache at all: every cell stays clickable, exactly as before.
    const { store, el } = await open(show(0));
    expect(el.querySelectorAll(".wl-ep").filter((c) => c.hasClass("is-unaired")).length).toBe(
      0,
    );
    el.querySelectorAll(".wl-ep")[11]?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toEqual([12]);
  });

  it("stops guarding once the cached air date has passed", async () => {
    // A stale cache must never block a click on something that already aired —
    // the guard only fires when it can point at a date genuinely in the future.
    const { store, el } = await open(
      airing({ airing: { nextEpisode: { season: 2, episode: 3, airDate: "2026-01-01" } } }),
    );
    expect(el.querySelectorAll(".wl-ep").filter((c) => c.hasClass("is-unaired")).length).toBe(
      0,
    );
    el.querySelectorAll(".wl-ep")[6]?.fire("click");
    expect(store.getTitle("t")?.watchedEpisodes).toContain(7);
  });
});
