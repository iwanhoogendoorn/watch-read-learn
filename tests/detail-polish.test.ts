/**
 * Three defects measured in the running app, pinned as structure.
 *
 * There is no layout engine behind `helpers/dom.ts` (deliberately — see that
 * file), so none of this can assert a pixel. What it can assert is the thing the
 * CSS keys off, and in each case here the visual defect and the structure are
 * the same fact:
 *
 *   1. **The stat panel's empty box.** `.wl-stat-grid` is written for the
 *      Dashboard's `.wl-overview`, a flex *row*, where `flex: 1 1 240px` is a
 *      240px width. Both detail surfaces are flex *columns*, where the identical
 *      declaration is a 240px **height** — which is why a show with no
 *      `episodeDuration` drew two tiles above ~300px of grey nothing. The fix is
 *      a container variant, so what a test can hold is that the row is marked
 *      for it, that it has exactly the tiles it should, and that it is not
 *      rendered at all when there are none.
 *   2. **"Today" on both surfaces.** It used to be a `renderDateField` opt-in
 *      that only the view passed, so the same field offered a different set of
 *      affordances depending on how you had opened the title. It now lives in
 *      `renderDateInput`, which is the one date control, and these drive the
 *      *modal* — the half that did not have it.
 *   3. **"Updated …" on the person screen.** A Refresh button with nothing
 *      saying how stale the page is is an offer with no reason attached.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailModal } from "../src/ui/modals/detail";
import { WatchLogStore } from "../src/data/store";
import { createTitle } from "../src/data/schema";
import { renderStatTiles } from "../src/ui/detail/stats";
import { mountPersonScreen, type PersonScreenDeps } from "../src/ui/views/person";
import type {
  PersonCacheEntry,
  PersonService,
  TmdbPerson,
} from "../src/services/tmdb-person";
import { createHost, installDomGlobals, StubEl } from "./helpers/dom";
import type { TitleV4 } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------
// 1 — the tile row sizes to its tiles
// ---------------------------------------------------------------------------

function seasonsOf(count: number, each: number): TitleV4["seasons"] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Season ${i + 1}`,
    episodes: each,
    offset: i * each,
    skippedEpisodes: [],
    seasonNumber: i + 1,
  }));
}

function series(over: Partial<TitleV4> = {}): TitleV4 {
  const title = createTitle({ id: "s", title: "Reacher", type: "TV Show" });
  Object.assign(title, {
    tmdbMediaType: "tv",
    totalEpisodes: 32,
    episodeDuration: 45,
    seasons: seasonsOf(4, 8),
    watchedEpisodes: Array.from({ length: 24 }, (_, i) => i + 1),
  } satisfies Partial<TitleV4>);
  Object.assign(title, over);
  return title;
}

function tilesIn(host: StubEl): { value: string; label: string }[] {
  return host.querySelectorAll(".wl-stat").map((tile) => ({
    value: tile.querySelectorAll(".wl-stat-value")[0]?.textContent ?? "",
    label: tile.querySelectorAll(".wl-stat-label")[0]?.textContent ?? "",
  }));
}

describe("the stat tile row", () => {
  it("is marked as the detail variant, not the Dashboard's grid", () => {
    // The whole fix hangs off this class: without it the row inherits
    // `flex: 1 1 240px` in a column and holds a 240px void open under itself.
    const host = createHost(900);
    const row = renderStatTiles(host as unknown as HTMLElement, series());
    expect(row).not.toBeNull();
    expect((row as unknown as StubEl).hasClass("wl-stat-tiles")).toBe(true);
    // Still kin to the Dashboard's row — only its container behaviour differs.
    expect((row as unknown as StubEl).hasClass("wl-stat-grid")).toBe(true);
  });

  it("draws four tiles for a show that knows how long an episode is", () => {
    const host = createHost(900);
    renderStatTiles(host as unknown as HTMLElement, series());
    expect(tilesIn(host).map((t) => t.label)).toEqual([
      "Left",
      "Watched",
      "Episodes",
      "Progress",
    ]);
  });

  it("draws exactly two for the same show with no runtime — and no third, empty one", () => {
    // Reacher, as opened in the real vault: `episodeDuration` 0 because the
    // runtime was never fetched. "Left" and "Watched" are time, and a time we do
    // not have is a tile we do not draw — but the row must then *be* two tiles
    // tall, not four.
    const host = createHost(900);
    renderStatTiles(host as unknown as HTMLElement, series({ episodeDuration: 0 }));
    const tiles = tilesIn(host);
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.label)).toEqual(["Episodes", "Progress"]);
    expect(tiles.map((t) => t.value)).toEqual(["24/32", "75%"]);
  });

  it("renders no row at all when there is not one figure worth showing", () => {
    // An empty bordered box is worse than nothing: it reads as a panel whose
    // contents failed to load.
    const host = createHost(900);
    // `tmdbMediaType` matters: a title upstream has not called a series reads
    // as a film, and a film always has a yes/no tile to draw.
    const bare = createTitle({
      id: "b",
      title: "Nothing Known",
      type: "TV Show",
      tmdbMediaType: "tv",
      totalEpisodes: 0,
    });
    expect(renderStatTiles(host as unknown as HTMLElement, bare)).toBeNull();
    expect(host.querySelectorAll(".wl-stat-tiles")).toHaveLength(0);
    expect(host.querySelectorAll(".wl-stat")).toHaveLength(0);
  });

  it("puts the value above the label in every tile", () => {
    const host = createHost(900);
    renderStatTiles(host as unknown as HTMLElement, series());
    for (const tile of host.querySelectorAll(".wl-stat")) {
      const classes = tile.children.map((child) => child.className);
      expect(classes).toEqual(["wl-stat-value", "wl-stat-label"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — "Today" in the modal, which is the half that lacked it
// ---------------------------------------------------------------------------

async function openModal(over: Partial<TitleV4> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();

  const title = createTitle({ id: "t", title: "A Film", type: "Movie" });
  Object.assign(title, over);
  store.data.titles.push(title);

  const modal = new DetailModal({} as never, { store: store as never, titleId: "t" });
  const contentEl = createHost(900);
  const modalEl = createHost(900);
  Object.assign(modal as unknown as Record<string, unknown>, { contentEl, modalEl });
  modal.onOpen();

  return { store, el: contentEl as unknown as StubEl };
}

function todayButton(el: StubEl, label: string): StubEl {
  const found = el
    .querySelectorAll("button")
    .find((b) => b.getAttribute("aria-label") === `Set ${label} to today`);
  if (!found) throw new Error(`no Today button for ${label}`);
  return found;
}

describe("the modal's date fields", () => {
  it("offer Today beside every one of them", async () => {
    const { el } = await openModal({ type: "TV Show", tmdbMediaType: "tv" });
    for (const label of ["Started", "Finished", "Released"]) {
      expect(todayButton(el, label).textContent).toBe("Today");
    }
  });

  it("writes the local calendar day through the field's own commit path", async () => {
    const { store, el } = await openModal();
    todayButton(el, "Watched on").fire("click");

    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    // A film writes both halves from the one field, exactly as typing does.
    expect(store.getTitle("t")?.dateStarted).toBe(expected);
    expect(store.getTitle("t")?.dateFinished).toBe(expected);
  });

  it("puts Today inside the date control, so it reads as one thing", async () => {
    // Not merely somewhere in the field: in the row that already holds the text
    // input and the calendar button.
    const { el } = await openModal();
    const control = el.querySelectorAll(".wl-date-field")[0];
    expect(control).toBeDefined();
    expect(
      control?.querySelectorAll("button").filter((b) => b.textContent === "Today"),
    ).toHaveLength(1);
  });

  it("shows the day it just wrote, in the user's own date format", async () => {
    const { el } = await openModal();
    todayButton(el, "Watched on").fire("click");
    const input = el.querySelectorAll(".wl-date-input")[0];
    // The default format is european, so a written date never surfaces as
    // storage form — that was the whole point of replacing `<input type=date>`.
    expect(input?.value).toMatch(/^\d{2}-\d{2}-\d{4}$/);
  });
});

// ---------------------------------------------------------------------------
// 3 — the person screen says how old its answer is
// ---------------------------------------------------------------------------

const PERSON: TmdbPerson = {
  id: 525,
  name: "Christopher Nolan",
  biography: "A British-American film director.",
  birthday: "1970-07-30",
  deathday: null,
  placeOfBirth: "London, England, UK",
  profileUrl: "",
  knownForDepartment: "Directing",
  alsoKnownAs: [],
  gender: "Male",
  imdbId: "nm0634240",
  homepage: "",
  popularity: 12,
};

function personScreen(fetchedAt: string, today = "2026-08-18"): StubEl {
  const host = new StubEl("div", "wl-person-host");
  const cached: PersonCacheEntry = { person: PERSON, credits: [], fetchedAt };
  const people: PersonService = {
    configured: () => true,
    cached: () => cached,
    isStale: () => false,
    cachedResolution: () => undefined,
    resolve: () => {
      throw new Error("resolve must not be called");
    },
    load: () => {
      throw new Error("load must not be called");
    },
    rememberChoice: () => undefined,
  };
  const deps: PersonScreenDeps = {
    people,
    titles: () => [],
    onOpenTitle: () => undefined,
    onAdd: async () => undefined,
    notify: () => undefined,
  };
  mountPersonScreen(host as unknown as HTMLElement, deps, () => today).open({
    personId: 525,
  });
  return host;
}

function syncLabel(host: StubEl): string {
  return host.querySelectorAll(".wl-person-synclabel")[0]?.textContent ?? "";
}

describe("the person screen's provenance line", () => {
  it("says how long ago TMDB was asked", () => {
    expect(syncLabel(personScreen("2026-08-01T00:00:00.000Z"))).toBe("Updated 2 w ago");
  });

  it("says today for a page fetched today", () => {
    expect(syncLabel(personScreen("2026-08-18T09:00:00.000Z"))).toBe("Updated today");
  });

  it("does not invent a date it does not have", () => {
    expect(syncLabel(personScreen(""))).toBe("Never updated");
  });
});
