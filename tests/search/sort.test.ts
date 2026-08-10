import { describe, expect, it } from "vitest";
import {
  compareBySpec,
  DEFAULT_DIRECTION,
  flipDirection,
  SORT_LABELS,
  sortContextFrom,
  sortTitles,
  sortValue,
  type SortContext,
} from "../../src/search/sort";
import { createTitle, DEFAULT_PRIORITIES, DEFAULT_STATUSES } from "../../src/data/schema";
import type { SortKey, TitleV4 } from "../../src/types";

const CTX: SortContext = {
  statusOrder: DEFAULT_STATUSES.map((s) => s.name),
  priorityOrder: DEFAULT_PRIORITIES.map((p) => p.name),
};

function title(id: string, overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({ id, title: id, type: "Movie", ...overrides });
}

const ids = (titles: readonly TitleV4[]) => titles.map((t) => t.id);

describe("empty-last", () => {
  it("keeps unrated titles at the bottom in both directions", () => {
    const library = [title("unrated"), title("four", { rating: 4 }), title("two", { rating: 2 })];

    expect(ids(sortTitles(library, { key: "rating", direction: "desc" }, null, CTX))).toEqual([
      "four",
      "two",
      "unrated",
    ]);
    // Flipping the direction reorders the rated titles — it does not promote
    // the blanks to the top.
    expect(ids(sortTitles(library, { key: "rating", direction: "asc" }, null, CTX))).toEqual([
      "two",
      "four",
      "unrated",
    ]);
  });

  it("does the same for every nullable key", () => {
    const keys: SortKey[] = ["releaseDate", "nextAirDate", "timeLeft", "year", "status", "priority"];
    for (const key of keys) {
      const withValue = title("has", {
        releaseDate: "2024-01-01",
        year: 2024,
        status: "Watching",
        priority: "High",
        episodeDuration: 45,
        totalEpisodes: 10,
        seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] }],
        airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-09-01" } },
      });
      const without = title("empty", { status: "", priority: "" });

      for (const direction of ["asc", "desc"] as const) {
        const sorted = sortTitles([without, withValue], { key, direction }, null, CTX);
        expect(ids(sorted), `${key} ${direction}`).toEqual(["has", "empty"]);
      }
    }
  });

  it("treats rating 0 and zero time-left as empty, but 0 % progress as real", () => {
    expect(sortValue(title("x", { rating: 0 }), "rating")).toBeNull();
    expect(sortValue(title("x", { status: "Completed", episodeDuration: 45 }), "timeLeft")).toBeNull();

    const started = title("x", {
      status: "Watching",
      totalEpisodes: 10,
      seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] }],
    });
    expect(sortValue(started, "progress")).toBe(0);
    // Nothing to progress through at all is empty, though.
    expect(sortValue(title("y", { totalEpisodes: 0 }), "progress")).toBeNull();
  });
});

describe("user-configured order", () => {
  it("sorts status by the settings list, not alphabetically", () => {
    const library = [
      title("completed", { status: "Completed" }),
      title("watching", { status: "Watching" }),
      title("dropped", { status: "Dropped" }),
    ];
    // Settings order is Watching, Plan to watch, Completed, To be released, Dropped.
    expect(ids(sortTitles(library, { key: "status", direction: "asc" }, null, CTX))).toEqual([
      "watching",
      "completed",
      "dropped",
    ]);
  });

  it("follows a reordered list without any code change", () => {
    const reversed: SortContext = { statusOrder: [...(CTX.statusOrder ?? [])].reverse() };
    const library = [title("completed", { status: "Completed" }), title("watching", { status: "Watching" })];
    expect(ids(sortTitles(library, { key: "status", direction: "asc" }, null, reversed))).toEqual([
      "completed",
      "watching",
    ]);
  });

  it("sorts priority by list order and sinks unset priorities", () => {
    const library = [
      title("none", { priority: "" }),
      title("high", { priority: "High" }),
      title("low", { priority: "Low" }),
    ];
    expect(ids(sortTitles(library, { key: "priority", direction: "asc" }, null, CTX))).toEqual([
      "low",
      "high",
      "none",
    ]);
  });

  it("sinks a status that is no longer in the settings list", () => {
    const library = [title("stale", { status: "Retired Status" }), title("live", { status: "Watching" })];
    expect(ids(sortTitles(library, { key: "status", direction: "asc" }, null, CTX))).toEqual(["live", "stale"]);
  });

  it("builds a context straight from settings", () => {
    const ctx = sortContextFrom({ statuses: DEFAULT_STATUSES, priorities: DEFAULT_PRIORITIES });
    expect(ctx.statusOrder?.[0]).toBe("Watching");
    expect(ctx.priorityOrder).toEqual(["Low", "Medium", "High"]);
  });
});

describe("keys", () => {
  it("sorts titles accent- and case-insensitively", () => {
    const library = [title("z", { title: "Zodiac" }), title("a", { title: "Amélie" }), title("b", { title: "amadeus" })];
    expect(ids(sortTitles(library, { key: "title", direction: "asc" }, null, CTX))).toEqual(["b", "a", "z"]);
  });

  it("sorts dates newest-first when descending", () => {
    const library = [
      title("old", { dateAdded: "2024-01-01T00:00:00.000Z" }),
      title("new", { dateAdded: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(ids(sortTitles(library, { key: "dateAdded", direction: "desc" }, null, CTX))).toEqual(["new", "old"]);
  });

  it("sorts by the next air date, soonest first", () => {
    const library = [
      title("later", { airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-12-01" } } }),
      title("sooner", { airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-10" } } }),
    ];
    expect(ids(sortTitles(library, { key: "nextAirDate", direction: "asc" }, null, CTX))).toEqual([
      "sooner",
      "later",
    ]);
  });

  it("derives a missing year from the release date", () => {
    expect(sortValue(title("x", { releaseDate: "2011-04-17" }), "year")).toBe(2011);
    expect(sortValue(title("x", { year: 1999, releaseDate: "2011-04-17" }), "year")).toBe(1999);
  });

  it("sorts by time remaining using the one shared formula", () => {
    const base = {
      episodeDuration: 45,
      totalEpisodes: 10,
      status: "Watching",
      seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] }],
    };
    const library = [
      title("lots", { ...base }),
      title("little", { ...base, watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8] }),
    ];
    expect(ids(sortTitles(library, { key: "timeLeft", direction: "asc" }, null, CTX))).toEqual(["little", "lots"]);
  });
});

describe("two levels and stability", () => {
  it("breaks ties with the secondary sort", () => {
    const library = [
      title("b", { status: "Watching", rating: 3 }),
      title("a", { status: "Watching", rating: 5 }),
      title("c", { status: "Completed", rating: 4 }),
    ];
    const sorted = sortTitles(
      library,
      { key: "status", direction: "asc" },
      { key: "rating", direction: "desc" },
      CTX,
    );
    expect(ids(sorted)).toEqual(["a", "b", "c"]);
  });

  it("ignores a secondary sort on the same key", () => {
    const library = [title("b", { rating: 3 }), title("a", { rating: 3 })];
    const sorted = sortTitles(
      library,
      { key: "rating", direction: "desc" },
      { key: "rating", direction: "asc" },
      CTX,
    );
    // Falls through to the title tiebreak instead of comparing rating twice.
    expect(ids(sorted)).toEqual(["a", "b"]);
  });

  it("is stable for identical titles, so the grid does not twitch", () => {
    const library = [title("z-id", { title: "Same" }), title("a-id", { title: "Same" })];
    const once = ids(sortTitles(library, { key: "rating", direction: "desc" }, null, CTX));
    const twice = ids(sortTitles([...library].reverse(), { key: "rating", direction: "desc" }, null, CTX));
    expect(once).toEqual(["a-id", "z-id"]);
    expect(twice).toEqual(once);
  });

  it("does not mutate the input array", () => {
    const library = [title("b"), title("a")];
    sortTitles(library, { key: "title", direction: "asc" }, null, CTX);
    expect(ids(library)).toEqual(["b", "a"]);
  });

  it("compares a single pair the same way the sort does", () => {
    const a = title("a", { rating: 5 });
    const b = title("b", { rating: 2 });
    expect(compareBySpec(a, b, { key: "rating", direction: "desc" }, CTX)).toBeLessThan(0);
    expect(compareBySpec(a, b, { key: "rating", direction: "asc" }, CTX)).toBeGreaterThan(0);
  });
});

describe("menu metadata", () => {
  it("labels and pre-directions every sort key", () => {
    const keys: SortKey[] = [
      "title",
      "dateAdded",
      "dateModified",
      "rating",
      "progress",
      "releaseDate",
      "nextAirDate",
      "timeLeft",
      "year",
      "status",
      "priority",
    ];
    for (const key of keys) {
      expect(SORT_LABELS[key]).toBeTruthy();
      expect(DEFAULT_DIRECTION[key]).toMatch(/asc|desc/);
    }
  });

  it("flips a direction", () => {
    expect(flipDirection("asc")).toBe("desc");
    expect(flipDirection("desc")).toBe("asc");
  });
});
