/**
 * Dashboard poster shelves.
 *
 * The selection half (`domains/shelves.ts`) is pure and takes `now`, so every
 * date rule below is a fact rather than a thing that passes until midnight. The
 * three rules worth locking down, because each has a way of failing silently:
 *
 *   1. **Order and cap.** A "recently X" shelf is twelve items in one specific
 *      order; a wrong comparator still renders twelve posters and still looks
 *      fine. Favourites is the exception and is uncapped — a hand-built set that
 *      quietly loses its back half is the failure that never gets reported.
 *   2. **An empty shelf does not exist.** Not "renders empty" — is not in the
 *      list at all, so a heading can never appear over a void.
 *   3. **"Recently released" means released.** A show whose next episode airs
 *      next week is upcoming, not recent, and upstream data routinely carries
 *      dates in the future.
 *
 * The component half is checked for the three things that are not CSS: it uses
 * the injected card factory rather than a second card implementation, its track
 * is reachable and operable from the keyboard without swallowing the page's own
 * vertical keys, and it does not squat on `.wl-shelf`, which already names the
 * Continue-watching grid.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHELF_SIZE,
  buildShelves,
  favouritesShelf,
  isActivelyFollowed,
  recentlyAddedShelf,
  recentlyReleasedShelf,
  recentlyWatchedShelf,
  releaseKey,
} from "../src/domains/shelves";
import { renderShelfRow } from "../src/ui/components/shelf";
import { mountDashboardTab } from "../src/ui/tabs/dashboard";
import { buildTitleCard } from "../src/ui/components/card";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { StubEl, createHost, installDomGlobals } from "./helpers/dom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CardContext, TitleV4, WatchLogStoreApi } from "../src/types";
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
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 10,
    episodeDuration: 30,
    dateAdded: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function movie(overrides: Partial<TitleV4> & { id: string }): TitleV4 {
  return title({ type: "Movie", totalEpisodes: 1, ...overrides });
}

function ids(titles: readonly TitleV4[]): string[] {
  return titles.map((t) => t.id);
}

/** `n` titles that differ only in the field under test. */
function many(count: number, make: (index: number) => Partial<TitleV4>): TitleV4[] {
  return Array.from({ length: count }, (_, i) => title({ id: `t${i}`, ...make(i) }));
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

describe("the favourites shelf", () => {
  it("holds only favourites, sorted by title", () => {
    const shelf = favouritesShelf([
      title({ id: "zulu", title: "Zulu", favorite: true }),
      title({ id: "alpha", title: "Alpha", favorite: true }),
      title({ id: "plain", title: "Bravo" }),
      title({ id: "mike", title: "Mike", favorite: true }),
    ]);
    expect(ids(shelf)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("is NOT capped — a hand-built set must not lose its back half", () => {
    // The other three shelves are windows onto something unbounded and are cut
    // at twelve. This one is a set the user assembled by hand; hiding half of
    // it silently is the one thing it must not do.
    const shelf = favouritesShelf(
      many(30, (i) => ({ title: `Film ${String(i).padStart(2, "0")}`, favorite: true })),
    );
    expect(shelf).toHaveLength(30);
    expect(shelf.length).toBeGreaterThan(SHELF_SIZE);
    expect(shelf[0]?.title).toBe("Film 00");
    expect(shelf[29]?.title).toBe("Film 29");
  });
});

// ---------------------------------------------------------------------------
// Recently added
// ---------------------------------------------------------------------------

describe("the recently added shelf", () => {
  it("puts the newest first", () => {
    const shelf = recentlyAddedShelf([
      title({ id: "old", dateAdded: "2024-03-01T00:00:00.000Z" }),
      title({ id: "newest", dateAdded: "2026-07-30T00:00:00.000Z" }),
      title({ id: "middle", dateAdded: "2025-11-11T00:00:00.000Z" }),
    ]);
    expect(ids(shelf)).toEqual(["newest", "middle", "old"]);
  });

  it("caps at twelve and keeps the twelve newest", () => {
    const shelf = recentlyAddedShelf(
      many(20, (i) => ({ dateAdded: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` })),
    );
    expect(shelf).toHaveLength(SHELF_SIZE);
    expect(ids(shelf)[0]).toBe("t19");
    expect(ids(shelf)[SHELF_SIZE - 1]).toBe("t8");
  });

  it("drops a half-migrated row with no date rather than sorting it to the front", () => {
    // `dateAdded` is guaranteed by migration and absent on hand-edited rows —
    // the exact shape that once took the whole Recently-added section down.
    const broken = title({ id: "broken" });
    (broken as { dateAdded?: string }).dateAdded = undefined;
    const shelf = recentlyAddedShelf([broken, title({ id: "fine" })]);
    expect(ids(shelf)).toEqual(["fine"]);
  });
});

// ---------------------------------------------------------------------------
// Recently watched
// ---------------------------------------------------------------------------

describe("the recently watched shelf", () => {
  it("holds only titles with something watched, newest first", () => {
    const shelf = recentlyWatchedShelf([
      title({ id: "untouched", status: "Plan to watch", dateModified: "2026-08-01T00:00:00.000Z" }),
      title({ id: "ticked", watchedEpisodes: [1, 2], dateModified: "2026-06-01T00:00:00.000Z" }),
      movie({ id: "finished", status: "Watched", dateFinished: "2026-07-04" }),
    ]);
    expect(ids(shelf)).toEqual(["finished", "ticked"]);
  });

  it("caps at twelve", () => {
    const shelf = recentlyWatchedShelf(
      many(18, (i) => ({
        watchedEpisodes: [1],
        dateModified: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      })),
    );
    expect(shelf).toHaveLength(SHELF_SIZE);
    expect(ids(shelf)[0]).toBe("t17");
  });
});

// ---------------------------------------------------------------------------
// Recently released
// ---------------------------------------------------------------------------

describe("what counts as actively followed", () => {
  it("is everything except dropped, unreleased and finished", () => {
    expect(isActivelyFollowed(title({ id: "a" }))).toBe(true);
    expect(isActivelyFollowed(title({ id: "b", status: "Plan to watch" }))).toBe(true);
    expect(isActivelyFollowed(title({ id: "c", status: "Dropped" }))).toBe(false);
    expect(isActivelyFollowed(title({ id: "d", status: "To be released" }))).toBe(false);
    expect(isActivelyFollowed(title({ id: "e", status: "Watched" }))).toBe(false);
    expect(
      isActivelyFollowed(title({ id: "f", watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })),
    ).toBe(false);
  });

  it("follows a status the user invented, because nothing here is an allow-list", () => {
    // Statuses come from `settings.statuses[].name` and are editable, so
    // "followed" is defined by exclusion. A status the plugin has never heard
    // of must not silently empty a shelf.
    expect(isActivelyFollowed(title({ id: "rewatch", status: "Rewatching" }))).toBe(true);
    expect(isActivelyFollowed(title({ id: "someday", status: "On the pile" }))).toBe(true);
  });
});

describe("the release signal", () => {
  it("is the release date for a film", () => {
    expect(releaseKey(movie({ id: "m", releaseDate: "2019-04-26" }))).toBe("2019-04-26");
  });

  it("is the most recently aired episode for a show, not its first air date", () => {
    const show = title({
      id: "s",
      releaseDate: "2011-04-17",
      airing: { lastEpisode: { season: 8, episode: 6, airDate: "2026-07-28" } },
    });
    expect(releaseKey(show)).toBe("2026-07-28");
  });

  it("falls back to the release date when nothing upstream is cached", () => {
    expect(releaseKey(title({ id: "s", releaseDate: "2011-04-17" }))).toBe("2011-04-17");
  });
});

describe("the recently released shelf", () => {
  it("orders by the release signal, newest first", () => {
    const shelf = recentlyReleasedShelf(
      [
        movie({ id: "old-film", releaseDate: "2002-05-01" }),
        title({
          id: "airing-show",
          releaseDate: "2011-04-17",
          airing: { lastEpisode: { season: 8, episode: 6, airDate: "2026-07-28" } },
        }),
        movie({ id: "new-film", releaseDate: "2026-06-01" }),
      ],
      NOW,
    );
    expect(ids(shelf)).toEqual(["airing-show", "new-film", "old-film"]);
  });

  it("excludes a title whose release date is still in the future", () => {
    const shelf = recentlyReleasedShelf(
      [
        movie({ id: "out", releaseDate: "2026-08-02" }),
        movie({ id: "today", releaseDate: "2026-08-03" }),
        movie({ id: "next-month", releaseDate: "2026-09-14" }),
      ],
      NOW,
    );
    expect(ids(shelf)).toEqual(["today", "out"]);
  });

  it("excludes a show whose cached last episode has not aired yet", () => {
    const shelf = recentlyReleasedShelf(
      [
        title({
          id: "future-airing",
          releaseDate: "2011-04-17",
          airing: { lastEpisode: { season: 2, episode: 1, airDate: "2026-08-20" } },
        }),
      ],
      NOW,
    );
    expect(shelf).toEqual([]);
  });

  it("excludes dropped, unreleased and finished titles however recent", () => {
    const shelf = recentlyReleasedShelf(
      [
        movie({ id: "dropped", status: "Dropped", releaseDate: "2026-08-01" }),
        movie({ id: "unreleased", status: "To be released", releaseDate: "2026-08-01" }),
        movie({ id: "done", status: "Watched", releaseDate: "2026-08-01" }),
        movie({ id: "following", releaseDate: "2026-08-01" }),
      ],
      NOW,
    );
    expect(ids(shelf)).toEqual(["following"]);
  });

  it("caps at twelve", () => {
    const shelf = recentlyReleasedShelf(
      Array.from({ length: 25 }, (_, i) =>
        movie({ id: `m${i}`, releaseDate: `2026-01-${String(i + 1).padStart(2, "0")}` }),
      ),
      NOW,
    );
    expect(shelf).toHaveLength(SHELF_SIZE);
    expect(ids(shelf)[0]).toBe("m24");
  });
});

// ---------------------------------------------------------------------------
// The set of shelves
// ---------------------------------------------------------------------------

describe("buildShelves", () => {
  it("omits every shelf with nothing on it", () => {
    // Nothing favourited, nothing watched, nothing released — one shelf left.
    const shelves = buildShelves(
      [movie({ id: "a", status: "Plan to watch", releaseDate: "2027-01-01" })],
      NOW,
    );
    expect(shelves.map((s) => s.id)).toEqual(["recentlyAdded"]);
  });

  it("returns nothing at all for an empty library", () => {
    expect(buildShelves([], NOW)).toEqual([]);
  });

  it("returns the four shelves in reading order when all have something", () => {
    const shelves = buildShelves(
      [
        movie({ id: "fav", favorite: true, releaseDate: "2020-01-01" }),
        movie({ id: "watched", status: "Watched", dateFinished: "2026-07-01" }),
        movie({ id: "recent", releaseDate: "2026-07-20" }),
      ],
      NOW,
    );
    expect(shelves.map((s) => s.id)).toEqual([
      "favourites",
      "recentlyAdded",
      "recentlyWatched",
      "recentlyReleased",
    ]);
    expect(shelves.map((s) => s.label)).toEqual([
      "Favourites",
      "Recently added",
      "Recently watched",
      "Recently released",
    ]);
    // Every shelf handed back has cards, so no caller has to check for empty.
    for (const shelf of shelves) expect(shelf.titles.length).toBeGreaterThan(0);
  });

  it("never mutates the array it was handed", () => {
    const titles = [
      movie({ id: "b", releaseDate: "2020-01-01" }),
      movie({ id: "a", releaseDate: "2026-01-01" }),
    ];
    buildShelves(titles, NOW);
    expect(ids(titles)).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// The row component
// ---------------------------------------------------------------------------

function ctxFor(): CardContext {
  return {
    store: { settings: createDefaultSettings() } as unknown as WatchLogStoreApi,
    variant: "full",
    showActions: false,
    showPlexBadge: true,
    showAiringChip: true,
    showProgress: true,
    showRating: true,
    embedded: false,
    // The Dashboard always wires this (`deps.onOpenTitle`), and the card only
    // becomes a labelled `role="button"` when it is present — so a context
    // without it would be testing a card the user never sees.
    onOpen: () => undefined,
  };
}

/** Stands in for `buildTitleCard`, so this file never re-implements a card. */
function spyFactory(): { build: (p: HTMLElement, t: TitleV4) => void; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    build: (parent: HTMLElement, t: TitleV4) => {
      seen.push(t.id);
      (parent as unknown as StubEl).createDiv({ cls: "wl-card", text: t.title });
    },
  };
}

function mountRow(titles: TitleV4[]): { host: StubEl; row: StubEl | null; seen: string[] } {
  const host = new StubEl("div");
  const factory = spyFactory();
  const row = renderShelfRow(host as unknown as HTMLElement, {
    label: "Recently added",
    titles,
    build: factory.build,
    ctx: ctxFor(),
  });
  return { host, row: row as unknown as StubEl | null, seen: factory.seen };
}

describe("the shelf row", () => {
  it("renders nothing at all for an empty shelf — no heading over a void", () => {
    const { host, row } = mountRow([]);
    expect(row).toBeNull();
    expect(host.children).toHaveLength(0);
  });

  it("hands every title to the injected card factory, in order", () => {
    const { row, seen } = mountRow([movie({ id: "a" }), movie({ id: "b" }), movie({ id: "c" })]);
    expect(seen).toEqual(["a", "b", "c"]);
    // The cards are the factory's, inside the track — not a second
    // implementation living in this component.
    const track = row?.querySelector(".wl-rail-track");
    expect(track?.querySelectorAll(".wl-card")).toHaveLength(3);
  });

  it("does not reuse `.wl-shelf`, which is already the Continue-watching grid", () => {
    // A wrapping grid of compact rows and a horizontal rail are not the same
    // box; one class means one component (`tests/styles.test.ts`).
    const { row } = mountRow([movie({ id: "a" })]);
    expect(row?.classes.has("wl-shelf")).toBe(false);
    expect(row?.classes.has("wl-rail")).toBe(true);
    expect(row?.querySelectorAll(".wl-shelf")).toHaveLength(0);
  });

  it("wears the tab's own heading, so a shelf head matches a panel head", () => {
    const { row } = mountRow([movie({ id: "a" })]);
    expect(row?.querySelector(".wl-section-title")?.textContent).toBe("Recently added");
  });

  it("gives the track a tab stop, a role and a name", () => {
    const { row } = mountRow([movie({ id: "a" })]);
    const track = row?.querySelector(".wl-rail-track");
    expect(track?.getAttribute("role")).toBe("group");
    expect(track?.getAttribute("tabindex")).toBe("0");
    expect(track?.getAttribute("aria-label")).toContain("Recently added");
    expect(track?.getAttribute("aria-label")).toContain("arrow keys");
  });

  it("scrolls sideways on the arrow keys and leaves the page's own scroll alone", () => {
    const { row } = mountRow([movie({ id: "a" }), movie({ id: "b" })]);
    const track = row?.querySelector(".wl-rail-track") as StubEl;
    track.width = 400;

    const press = (key: string): boolean => {
      let prevented = false;
      track.fire("keydown", { key, preventDefault: () => (prevented = true) });
      return prevented;
    };

    expect(press("ArrowRight")).toBe(true);
    const afterRight = (track as unknown as { scrollLeft: number }).scrollLeft;
    expect(afterRight).toBeGreaterThan(0);

    expect(press("ArrowLeft")).toBe(true);
    expect((track as unknown as { scrollLeft: number }).scrollLeft).toBeLessThan(afterRight);

    // A vertical key is not claimed: the row scrolls sideways, the page still
    // scrolls down. Trapping this is the classic carousel accessibility bug.
    expect(press("ArrowDown")).toBe(false);
    expect(press("PageDown")).toBe(false);
    expect(press(" ")).toBe(false);
  });

  it("ships no arrow buttons — the track answers the keyboard itself", () => {
    // Buttons here would be dead tab stops repeating a key the track already
    // has, and every pointer can already scroll a row sideways.
    const { row } = mountRow([movie({ id: "a" })]);
    expect(row?.querySelectorAll("button")).toHaveLength(0);
    // The heading is the tab's own, and it is the whole head.
    expect(row?.querySelector(".wl-section-head")?.children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Truncation
//
// The `full` variant in a 110px rail was measured in the live vault and came
// out as `Pla…`, `Co…`, `2024 · 20 / 20…` — a caption that costs the space and
// carries none of the meaning. The fix is a variant swap, not a font size, and
// these are the two rules that make it hold.
//
// Note what is NOT claimed: the suite's DOM stub has no layout engine, so no
// test here can prove a box does not overflow. Both rules below are therefore
// structural — "the field is not rendered at all" and "the stylesheet reserves
// the space it allows" — which are checkable without geometry.
// ---------------------------------------------------------------------------

describe("a shelf card does not truncate anything into nonsense", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(900);
  });

  afterEach(() => {
    restore();
  });

  /** A real `buildTitleCard`, mounted through a real rail. */
  function mountRealCards(titles: TitleV4[]): StubEl {
    const host = createHost(900);
    const ctx: CardContext = {
      ...ctxFor(),
      variant: "mini",
      showProgress: false,
      showRating: false,
    };
    renderShelfRow(host as unknown as HTMLElement, {
      label: "Recently added",
      titles,
      build: (parent, t, c) => {
        buildTitleCard(parent, t, c);
      },
      ctx,
    });
    return host;
  }

  const LONG = movie({
    id: "long",
    title: "Spider-Man: Brand New Day and the Very Long Subtitle",
    status: "Plan to watch",
    rating: 4,
    releaseDate: "2026-07-31",
    watchedEpisodes: [1],
  });

  it("renders the poster and the title, and nothing else that would have to be cut", () => {
    const root = mountRealCards([LONG]);

    // Present.
    expect(root.querySelectorAll(".wl-card-mini")).toHaveLength(1);
    expect(root.querySelectorAll(".wl-card-mini-poster")).toHaveLength(1);
    expect(root.querySelector(".wl-card-mini-title")?.textContent).toBe(LONG.title);

    // Absent — these are the fields that produced `Pla…` and `2024 · 20 / 20…`.
    for (const gone of [
      ".wl-card-pills",
      ".wl-pill",
      ".wl-card-meta",
      ".wl-card-title",
      ".wl-stars",
      ".wl-progress",
      ".wl-card-actions",
      ".wl-airing-chip",
    ]) {
      expect(root.querySelectorAll(gone), `${gone} must not be on a shelf card`).toHaveLength(0);
    }
  });

  it("keeps the full name reachable even though 110px cannot show it", () => {
    const root = mountRealCards([LONG]);
    // Pointer: the wrapper's tooltip. Screen reader: the card's own label.
    expect(root.querySelector(".wl-rail-item")?.getAttribute("title")).toBe(LONG.title);
    expect(root.querySelector(".wl-card-mini")?.getAttribute("aria-label")).toContain(LONG.title);
  });

  it("reserves two full lines for the title instead of cutting it to one", () => {
    // `.wl-card-mini-title` is nowrap + ellipsis in `20-cards.css`, which is
    // right for a dense list and cuts a title to ~14 characters at 110px. The
    // rail overrides it, and `min-height` reserves the second line whether or
    // not it is used so a row of cards stays flush.
    const css = readFileSync(DASHBOARD_CSS, "utf8");
    const rule = /\.wl-rail-track \.wl-card-mini-title\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, "the rail must override the one-line title").toBeDefined();
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/min-height:\s*calc\(2 \* 1\.3em\)/);
    expect(rule).toMatch(/line-height:\s*1\.3/);
  });

  it("sizes the rail item without ever setting a height on it", () => {
    // The card carries `aspect-ratio: 2 / 3`; a height here would fight it and
    // is what makes a rail crop its own posters.
    const css = readFileSync(DASHBOARD_CSS, "utf8");
    const item = /\.wl-rail-item\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(item).toMatch(/width:\s*var\(--wl-rail-card-width\)/);
    expect(item).not.toMatch(/(^|;|\s)height\s*:/);
    const track = /\.wl-rail-track\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(track).not.toMatch(/(^|;|\s)height\s*:/);
    expect(track).not.toMatch(/align-items\s*:/);
  });
});

// ---------------------------------------------------------------------------
// End to end
//
// Everything above tests the rail and the selection in isolation, which leaves
// exactly one line unguarded: the variant the Dashboard actually asks for. Flip
// it back to `full` and every other test in this file still passes while the
// live tab goes back to rendering `Pla…`.
// ---------------------------------------------------------------------------

describe("the Dashboard's own shelves", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(900);
  });

  afterEach(() => {
    restore();
  });

  function mountTab(titles: TitleV4[]): StubEl {
    const store = {
      settings: createDefaultSettings(),
      allTitles: () => titles,
      getTitle: (id: string) => titles.find((t) => t.id === id),
    } as unknown as WatchLogStoreApi;
    const deps: TabDeps = {
      store,
      buildCard: (parent, t, c) => {
        buildTitleCard(parent, t, c);
      },
      onOpenTitle: () => undefined,
      now: () => NOW,
    };
    return mountDashboardTab(createHost(900) as unknown as HTMLElement, deps)
      .el as unknown as StubEl;
  }

  it("asks for mini cards, never the full caption that cannot fit", () => {
    const root = mountTab([
      movie({ id: "a", title: "The Odyssey", favorite: true, releaseDate: "2026-07-17" }),
      movie({ id: "b", title: "Spider-Man: Brand New Day", releaseDate: "2026-07-31" }),
    ]);

    const rails = root.querySelectorAll(".wl-rail-track");
    expect(rails.length).toBeGreaterThan(0);

    for (const rail of rails) {
      expect(rail.querySelectorAll(".wl-card-mini").length).toBeGreaterThan(0);
      // `.wl-card` is the full poster card; it must not be in a rail.
      expect(rail.querySelectorAll(".wl-card")).toHaveLength(0);
      expect(rail.querySelectorAll(".wl-pill")).toHaveLength(0);
      expect(rail.querySelectorAll(".wl-card-meta")).toHaveLength(0);
      expect(rail.querySelectorAll(".wl-stars")).toHaveLength(0);
    }
  });

  it("leaves the statistics below it untouched", () => {
    const root = mountTab([movie({ id: "a", title: "The Odyssey", releaseDate: "2026-07-17" })]);
    // The rails lead, the tab it was added to still says everything it said.
    expect(root.querySelectorAll(".is-broken")).toHaveLength(0);
    for (const heading of ["By type", "By status", "By year", "Top credits", "Up next"]) {
      expect(root.textContent, `${heading} must survive`).toContain(heading);
    }
  });
});
