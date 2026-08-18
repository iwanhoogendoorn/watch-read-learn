/**
 * The air-date guard — "you did not watch that, it has not happened".
 *
 * The bug these pin was not that the grid drew a future episode as clickable;
 * it was that dimming the cell was the *whole* defence. `store.markEpisodeWatched`
 * accepted Reacher's S04E08 five episodes before it airs, and so did every other
 * door into the store: the card's quick "mark next episode" action, the command
 * palette, the `obsidian://watchlog` URI handler, the code-block widgets and CSV
 * import. The guard now lives in the store, where none of them can go round it.
 *
 * The shape below is the user's real library, read out of the running app:
 *
 *     Reacher, totalEpisodes 32
 *     airing.lastEpisode = { season 4, episode 3, airDate 2026-08-12 }
 *     airing.nextEpisode = { season 4, episode 4, airDate 2026-08-19 }
 *
 * Every test holds `now` at 2026-08-18, the day that was true.
 *
 * The other half of these tests is the half that matters more: **nothing that
 * worked before may stop working.** Three of the user's seven shows carry no
 * `lastEpisode` at all, and a guard that refused their clicks would be a far
 * worse bug than the one it fixes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

// A refusal the user cannot see is indistinguishable from a broken button, so
// the Notice is part of the contract and is recorded rather than swallowed.
vi.mock("obsidian", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Notice: class {
      constructor(public message: string) {
        notices.push(message);
      }
      hide(): void {
        /* no-op */
      }
      setMessage(message: string): this {
        this.message = message;
        return this;
      }
    },
  };
});

import {
  absoluteEpisodeAirState,
  airedEpisodesAmong,
  episodeAirState,
  isAbsoluteEpisodeMarkable,
  isEpisodeMarkable,
} from "../src/data/aired";
import { createTitle } from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import type { Season, TitleV4 } from "../src/types";

/** Midday on the day the Reacher reading was taken. */
const NOW = new Date(2026, 7, 18, 12, 0, 0);

// ---------------------------------------------------------------------------
// Harness — the store needs a document to dispatch its change event on.
// ---------------------------------------------------------------------------

beforeEach(() => {
  notices.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !== "function") {
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class {
        constructor(
          public type: string,
          public init?: unknown,
        ) {}
      },
    });
  }
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  vi.useRealTimers();
});

function fakePlugin() {
  return {
    loadData: vi.fn(async () => null),
    saveData: vi.fn(async () => undefined),
  };
}

function storeWith(...titles: TitleV4[]): WatchLogStore {
  const store = new WatchLogStore(fakePlugin() as never);
  store.data.titles.push(...titles);
  return store;
}

/** `count` seasons of `episodes` each, offsets already correct. */
function seasons(count: number, episodes: number, airDate: string | null = null): Season[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Season ${i + 1}`,
    episodes,
    offset: i * episodes,
    skippedEpisodes: [] as number[],
    seasonNumber: i + 1,
    airDate,
  }));
}

/**
 * Reacher exactly as the app holds it: four seasons of eight, S04E03 aired last
 * Wednesday, S04E04 airs tomorrow. Absolute 27 is S04E03; absolute 32 is S04E08.
 */
function reacher(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "reacher",
    title: "Reacher",
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 32,
    seasons: seasons(4, 8),
    watchedEpisodes: [],
    airing: {
      showStatus: "Returning Series",
      inProduction: true,
      lastEpisode: { season: 4, episode: 3, airDate: "2026-08-12" },
      nextEpisode: {
        season: 4,
        episode: 4,
        airDate: "2026-08-19",
        name: "Karambits and Pieces",
      },
      seasonCount: 4,
      episodeCount: 32,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The state machine itself
// ---------------------------------------------------------------------------

describe("episodeAirState — the evidence, and its limits", () => {
  it("reads Reacher's real shape: S04E03 aired, S04E04 onwards has not", () => {
    const title = reacher();
    expect(episodeAirState(title, 4, 3, NOW)).toBe("aired");
    expect(episodeAirState(title, 4, 4, NOW)).toBe("unaired");
    expect(episodeAirState(title, 4, 8, NOW)).toBe("unaired");
    // Earlier seasons are untouched by any of it.
    expect(episodeAirState(title, 1, 1, NOW)).toBe("aired");
    expect(episodeAirState(title, 3, 8, NOW)).toBe("aired");
  });

  it("says `unknown` — and stays markable — for a title with no airing cache", () => {
    const title = createTitle({
      id: "quiet",
      title: "No Upstream Data",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: seasons(1, 10),
    });
    expect(episodeAirState(title, 1, 10, NOW)).toBe("unknown");
    expect(isEpisodeMarkable(title, 1, 10, NOW)).toBe(true);
    expect(absoluteEpisodeAirState(title, 10, NOW)).toBe("unknown");
  });

  it("treats an episode airing TODAY as aired — only the strictly future is refused", () => {
    const title = reacher({
      airing: {
        nextEpisode: { season: 4, episode: 4, airDate: "2026-08-18" },
        lastEpisode: { season: 4, episode: 3, airDate: "2026-08-11" },
      },
    });
    expect(episodeAirState(title, 4, 4, NOW)).toBe("aired");
    // The date has effectively passed, so the cache says nothing about later
    // episodes either — silence, not a guess.
    expect(episodeAirState(title, 4, 5, NOW)).toBe("aired");
  });

  it("ignores a stale nextEpisode rather than refusing episodes that have aired", () => {
    const title = reacher({
      airing: {
        nextEpisode: { season: 4, episode: 2, airDate: "2026-07-01" },
        lastEpisode: { season: 4, episode: 1, airDate: "2026-06-24" },
      },
    });
    // Six weeks behind. Every episode stays clickable — a wrong refusal has no
    // escape hatch, a wrong permission does.
    expect(episodeAirState(title, 4, 8, NOW)).toBe("aired");
    expect(isAbsoluteEpisodeMarkable(title, 32, NOW)).toBe(true);
  });

  it("marks every episode of a season that has not premiered", () => {
    const title = createTitle({
      id: "pending",
      title: "Pending Season",
      type: "TV Show",
      totalEpisodes: 16,
      seasons: [
        { name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1, airDate: "2025-01-01" },
        { name: "Season 2", episodes: 8, offset: 8, skippedEpisodes: [], seasonNumber: 2, airDate: "2026-11-01" },
      ],
    });
    expect(episodeAirState(title, 1, 8, NOW)).toBe("unknown");
    expect(episodeAirState(title, 2, 1, NOW)).toBe("unaired");
    expect(absoluteEpisodeAirState(title, 9, NOW)).toBe("unaired");
  });

  it("leaves an ENDED show whose finale is the last aired episode fully markable", () => {
    const title = createTitle({
      id: "ended",
      title: "Ended Show",
      type: "TV Show",
      totalEpisodes: 24,
      seasons: seasons(3, 8),
      airing: {
        showStatus: "Ended",
        inProduction: false,
        lastEpisode: { season: 3, episode: 8, airDate: "2025-05-20" },
        checkedAt: NOW.toISOString(),
      },
    });
    for (let ep = 1; ep <= 24; ep += 1) {
      expect(isAbsoluteEpisodeMarkable(title, ep, NOW)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// lastEpisode — the extra evidence, and the two gates that keep it honest
// ---------------------------------------------------------------------------

describe("episodeAirState — lastEpisode as evidence", () => {
  /** Mid-run, no next date announced yet. The case nextEpisode cannot cover. */
  function midRun(checkedAt: string | undefined): TitleV4 {
    return createTitle({
      id: "gap",
      title: "Mid Run",
      type: "TV Show",
      totalEpisodes: 8,
      seasons: seasons(1, 8),
      airing: {
        showStatus: "Returning Series",
        lastEpisode: { season: 1, episode: 3, airDate: "2026-08-12" },
        ...(checkedAt !== undefined ? { checkedAt } : {}),
      },
    });
  }

  it("refuses episodes after the last aired one when the cache was checked today", () => {
    const title = midRun(new Date(2026, 7, 18, 8, 0, 0).toISOString());
    expect(episodeAirState(title, 1, 3, NOW)).toBe("aired");
    // E4 is the immediate successor: it may have aired *since* this morning's
    // check, so it stays markable. Everything beyond it cannot have.
    expect(episodeAirState(title, 1, 4, NOW)).toBe("aired");
    expect(episodeAirState(title, 1, 5, NOW)).toBe("unaired");
    expect(episodeAirState(title, 1, 8, NOW)).toBe("unaired");
  });

  it("will not use a cache from yesterday — staleness must never cost a click", () => {
    const title = midRun(new Date(2026, 7, 17, 23, 0, 0).toISOString());
    expect(episodeAirState(title, 1, 5, NOW)).toBe("aired");
    expect(episodeAirState(title, 1, 8, NOW)).toBe("aired");
  });

  it("will not use a cache with no timestamp at all", () => {
    const title = midRun(undefined);
    expect(episodeAirState(title, 1, 8, NOW)).toBe("aired");
  });
});

// ---------------------------------------------------------------------------
// The store — the door none of the UI paths can go round
// ---------------------------------------------------------------------------

describe("store.markEpisodeWatched — the guard that cannot be bypassed", () => {
  it("refuses Reacher's absolute 32 (S04E08) and accepts 27 (S04E03)", () => {
    const title = reacher();
    const store = storeWith(title);

    store.markEpisodeWatched("reacher", 32, true);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual(["Reacher — S04E08 has not aired yet."]);

    store.markEpisodeWatched("reacher", 27, true);
    expect(title.watchedEpisodes).toEqual([27]);
    expect(notices).toHaveLength(1);
  });

  it("always allows un-marking an unaired episode that somehow got marked", () => {
    const title = reacher({ watchedEpisodes: [32] });
    const store = storeWith(title);

    store.markEpisodeWatched("reacher", 32, false);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("changes nothing for a title with no airing data — the common case", () => {
    const title = createTitle({
      id: "quiet",
      title: "No Upstream Data",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: seasons(1, 10),
    });
    const store = storeWith(title);

    store.markEpisodeWatched("quiet", 10, true);
    expect(title.watchedEpisodes).toEqual([10]);
    expect(notices).toEqual([]);
  });

  it("still refuses a skipped episode, and does not blame the air date for it", () => {
    const title = reacher();
    title.seasons[3]!.skippedEpisodes = [2]; // S04E02, absolute 26
    const store = storeWith(title);

    store.markEpisodeWatched("reacher", 26, true);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);

    // A skipped episode that is *also* unaired is refused by the skip rule
    // first, so the guard never contradicts it.
    title.seasons[3]!.skippedEpisodes = [2, 6];
    store.markEpisodeWatched("reacher", 30, true);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("does not auto-complete a show off the back of a future episode", () => {
    const title = reacher({ watchedEpisodes: Array.from({ length: 31 }, (_, i) => i + 1) });
    const store = storeWith(title);
    store.settings.autoCompleteOnLastEpisode = true;

    store.markEpisodeWatched("reacher", 32, true);
    expect(title.watchedEpisodes).toHaveLength(31);
    expect(title.status).toBe("Watching");
  });
});

describe("store.markSeasonWatched — capped at what has aired", () => {
  it("marks only the aired episodes of a part-aired season, and does not complete the show", () => {
    const title = reacher({ watchedEpisodes: Array.from({ length: 24 }, (_, i) => i + 1) });
    const store = storeWith(title);
    store.settings.autoCompleteOnLastEpisode = true;

    store.markSeasonWatched("reacher", 3, true);

    // Season 4 is absolutes 25..32; only 25, 26, 27 have aired.
    expect(title.watchedEpisodes).toEqual([...Array.from({ length: 27 }, (_, i) => i + 1)]);
    expect(title.status).toBe("Watching");
    expect(notices).toEqual([
      "Reacher — marked the 3 aired episodes of Season 4; the rest have not aired yet.",
    ]);
  });

  it("refuses outright when nothing in the season has aired", () => {
    const title = reacher({
      airing: {
        nextEpisode: { season: 4, episode: 1, airDate: "2026-09-01" },
      },
    });
    const store = storeWith(title);

    store.markSeasonWatched("reacher", 3, true);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual(["Reacher — nothing in Season 4 has aired yet."]);
  });

  it("never caps an unmark", () => {
    const title = reacher({ watchedEpisodes: [25, 26, 27, 32] });
    const store = storeWith(title);

    store.markSeasonWatched("reacher", 3, false);
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("skips a skipped episode and still stops at the air boundary", () => {
    const title = reacher();
    title.seasons[3]!.skippedEpisodes = [2]; // S04E02, absolute 26
    const store = storeWith(title);

    store.markSeasonWatched("reacher", 3, true);
    expect(title.watchedEpisodes).toEqual([25, 27]);
  });

  it("marks a fully aired season in full, with no notice", () => {
    const title = reacher();
    const store = storeWith(title);

    store.markSeasonWatched("reacher", 0, true);
    expect(title.watchedEpisodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(notices).toEqual([]);
  });
});

describe("store.updateTitle — the bulk patch path is guarded too", () => {
  it("drops unaired episodes a `watchedEpisodes` patch tries to introduce", () => {
    const title = reacher();
    const store = storeWith(title);

    // Exactly the patch `markEpisodesPatch` builds for a "watch all" click.
    store.updateTitle("reacher", {
      watchedEpisodes: [25, 26, 27, 28, 29, 30, 31, 32],
    });

    expect(title.watchedEpisodes).toEqual([25, 26, 27]);
    expect(notices).toEqual(["Reacher — 5 episodes have not aired yet and were not marked."]);
  });

  it("leaves an unaired episode that was already stored alone", () => {
    // Marked before the guard existed, or before the schedule moved. Deleting
    // it behind the user's back would be its own silent data loss.
    const title = reacher({ watchedEpisodes: [32] });
    const store = storeWith(title);

    store.updateTitle("reacher", { watchedEpisodes: [27, 32] });
    expect(title.watchedEpisodes).toEqual([27, 32]);
    expect(notices).toEqual([]);
  });

  it("lets a patch clear the list — the reset action must keep working", () => {
    const title = reacher({ watchedEpisodes: [25, 26, 27, 32] });
    const store = storeWith(title);

    store.updateTitle("reacher", { watchedEpisodes: [], status: "Plan to watch" });
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("does not interfere with a patch that carries no watched episodes", () => {
    const title = reacher({ watchedEpisodes: [] });
    const store = storeWith(title);

    store.updateTitle("reacher", { totalEpisodes: 32, seasons: seasons(4, 8) });
    expect(title.watchedEpisodes).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("changes nothing for a title with no airing data", () => {
    const title = createTitle({
      id: "quiet",
      title: "No Upstream Data",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: seasons(1, 10),
    });
    const store = storeWith(title);

    store.updateTitle("quiet", { watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    expect(title.watchedEpisodes).toHaveLength(10);
    expect(notices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The bulk helper the season head uses to size its button
// ---------------------------------------------------------------------------

describe("airedEpisodesAmong", () => {
  it("is the ceiling for a bulk mark, in absolute numbers", () => {
    const title = reacher();
    expect(airedEpisodesAmong(title, [25, 26, 27, 28, 29, 30, 31, 32], NOW)).toEqual([25, 26, 27]);
  });

  it("returns everything when nothing is known", () => {
    const title = createTitle({
      id: "quiet",
      title: "No Upstream Data",
      type: "TV Show",
      totalEpisodes: 4,
      seasons: seasons(1, 4),
    });
    expect(airedEpisodesAmong(title, [1, 2, 3, 4], NOW)).toEqual([1, 2, 3, 4]);
  });
});
