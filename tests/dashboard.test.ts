/**
 * Dashboard model — SPEC §4.7.
 *
 * The two things worth locking down: every minute comes from the single time
 * formula in `data/episodes.ts`, and status order follows the user's configured
 * list rather than the alphabet or v3's hardcoded array.
 */
import { describe, expect, it } from "vitest";
import { computeDashboard, DASHBOARD_MONTHS, titleYear } from "../src/ui/tabs/dashboard";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { calcTimeRemaining, calcTimeWatched } from "../src/data/episodes";
import type { Settings, TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

function settings(): Settings {
  return createDefaultSettings();
}

function title(overrides: Partial<TitleV4> & { id: string }): TitleV4 {
  return createTitle({
    title: overrides.id,
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 10,
    episodeDuration: 30,
    dateAdded: "2026-08-01T10:00:00.000Z",
    dateModified: "2026-08-01T10:00:00.000Z",
    ...overrides,
  });
}

describe("completion ratio", () => {
  it("excludes Dropped and To be released from the denominator", () => {
    const model = computeDashboard(
      [
        title({ id: "done", status: "Watched" }),
        title({ id: "watching" }),
        title({ id: "dropped", status: "Dropped" }),
        title({ id: "unreleased", status: "To be released" }),
      ],
      settings(),
      NOW,
    );
    expect(model.total).toBe(4);
    expect(model.counting).toBe(2);
    expect(model.completed).toBe(1);
    expect(model.percent).toBe(50);
  });

  it("counts a fully-ticked title as completed even without the status", () => {
    const model = computeDashboard(
      [title({ id: "ticked", watchedEpisodes: Array.from({ length: 10 }, (_, i) => i + 1) })],
      settings(),
      NOW,
    );
    expect(model.completed).toBe(1);
    expect(model.percent).toBe(100);
  });
});

describe("time totals", () => {
  it("are the sum of the shared per-title formulas, nothing else", () => {
    const titles = [
      title({ id: "a", watchedEpisodes: [1, 2, 3] }),
      title({ id: "b", status: "Watched" }),
      title({ id: "c", status: "Dropped", watchedEpisodes: [1] }),
      title({ id: "d", status: "To be released" }),
    ];
    const model = computeDashboard(titles, settings(), NOW);

    expect(model.timeWatched).toBe(titles.reduce((sum, t) => sum + calcTimeWatched(t), 0));
    expect(model.timeRemaining).toBe(titles.reduce((sum, t) => sum + calcTimeRemaining(t), 0));
    // 3 watched + 10 completed + 1 dropped-but-watched, all at 30 minutes.
    expect(model.timeWatched).toBe(14 * 30);
    // Only the Watching title has time left; Dropped and To be released are zero.
    expect(model.timeRemaining).toBe(7 * 30);
  });
});

describe("charts", () => {
  it("orders statuses by the user's configured list, then anything unknown", () => {
    const custom = settings();
    custom.statuses = [
      { name: "Watched", color: "#000000" },
      { name: "Watching", color: "#000000" },
    ];
    const model = computeDashboard(
      [
        title({ id: "w", status: "Watching" }),
        title({ id: "c", status: "Watched" }),
        title({ id: "x", status: "Abandoned mid-season" }),
      ],
      custom,
      NOW,
    );
    expect(model.byStatus.map((b) => b.label)).toEqual([
      "Watched",
      "Watching",
      "Abandoned mid-season",
    ]);
  });

  it("derives the year from releaseDate and buckets unknowns separately", () => {
    expect(titleYear(title({ id: "a", year: 1999 }))).toBe(1999);
    expect(titleYear(title({ id: "b", releaseDate: "2021-04-05" }))).toBe(2021);
    expect(titleYear(title({ id: "c" }))).toBeNull();

    const model = computeDashboard(
      [
        title({ id: "a", year: 2021 }),
        title({ id: "b", releaseDate: "2019-01-01" }),
        title({ id: "c" }),
      ],
      settings(),
      NOW,
    );
    expect(model.byYear).toEqual([
      { label: "2019", count: 1 },
      { label: "2021", count: 1 },
      { label: "(unknown)", count: 1 },
    ]);
  });

  it("always produces twelve month buckets ending in the current month", () => {
    const model = computeDashboard([title({ id: "a" })], settings(), NOW);
    expect(model.addedOverTime).toHaveLength(DASHBOARD_MONTHS);
    expect(model.addedOverTime.at(-1)).toEqual({ label: "2026-08", count: 1 });
    expect(model.addedOverTime[0]?.label).toBe("2025-09");
  });
});

describe("credits", () => {
  it("merges manual entries, dedupes case-insensitively and respects the cap", () => {
    const custom = settings();
    custom.dashboardTopCredits = 2;
    const model = computeDashboard(
      [
        title({ id: "a", cast: ["Ann Lee", "Bo Ng"], manualCast: ["ann lee", "Cy Rus"] }),
        title({ id: "b", cast: ["Ann Lee", "Bo Ng"] }),
        title({ id: "c", cast: ["Ann Lee"] }),
      ],
      custom,
      NOW,
    );
    expect(model.topCast).toEqual([
      { label: "Ann Lee", count: 3 },
      { label: "Bo Ng", count: 2 },
    ]);
  });
});

describe("shelves", () => {
  it("puts in-progress titles in Continue watching, most recent first", () => {
    const model = computeDashboard(
      [
        title({ id: "stale", watchedEpisodes: [1], dateModified: "2026-07-01T00:00:00.000Z" }),
        title({ id: "fresh", watchedEpisodes: [1, 2], dateModified: "2026-08-02T00:00:00.000Z" }),
        title({ id: "done", status: "Watched", watchedEpisodes: Array.from({ length: 10 }, (_, i) => i + 1) }),
        title({ id: "dropped", status: "Dropped", watchedEpisodes: [1] }),
      ],
      settings(),
      NOW,
    );
    expect(model.continueWatching.map((t) => t.id)).toEqual(["fresh", "stale"]);
  });

  it("takes the three soonest dated airing items for Up next", () => {
    const model = computeDashboard(
      [
        title({ id: "a", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-20" } } }),
        title({ id: "b", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-05" } } }),
        title({ id: "c", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-10" } } }),
        title({ id: "d", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-25" } } }),
        title({ id: "undated", airing: { newSeasonDetected: 3 } }),
      ],
      settings(),
      NOW,
    );
    expect(model.upNext.map((e) => e.title.id)).toEqual(["b", "c", "a"]);
  });

  it("excludes items that have already aired from Up next", () => {
    const model = computeDashboard(
      [title({ id: "past", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-01" } } })],
      settings(),
      NOW,
    );
    expect(model.upNext).toEqual([]);
  });

  it("orders Recently added by dateAdded, newest first", () => {
    const model = computeDashboard(
      [
        title({ id: "old", dateAdded: "2026-01-01T00:00:00.000Z" }),
        title({ id: "new", dateAdded: "2026-08-02T00:00:00.000Z" }),
      ],
      settings(),
      NOW,
    );
    expect(model.recentlyAdded.map((t) => t.id)).toEqual(["new", "old"]);
  });
});

describe("per-type cards", () => {
  it("follows the configured type order and computes its own ratio", () => {
    const custom = settings();
    custom.types = [
      { name: "Movie", color: "#000000" },
      { name: "TV Show", color: "#000000" },
    ];
    const model = computeDashboard(
      [
        title({ id: "s1", type: "TV Show", status: "Watched" }),
        title({ id: "s2", type: "TV Show" }),
        title({ id: "m1", type: "Movie", status: "Watched", totalEpisodes: 1, episodeDuration: 120 }),
      ],
      custom,
      NOW,
    );
    expect(model.byType.map((t) => t.type)).toEqual(["Movie", "TV Show"]);
    expect(model.byType[0]?.percent).toBe(100);
    expect(model.byType[0]?.timeWatched).toBe(120);
    expect(model.byType[1]?.percent).toBe(50);
  });
});
