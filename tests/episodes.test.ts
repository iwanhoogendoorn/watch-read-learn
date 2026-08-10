/**
 * Episode and time maths, with the three v3 bugs from
 * `docs/research/report-watchlog.md` §5 pinned down as tests.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import {
  calcTimeRemaining,
  calcTimeWatched,
  episodesRemaining,
  formatMinutes,
  getEffectiveTotal,
  getNextUnwatchedEpisode,
  getProgress,
  getTotalSkippedCount,
  getWatchedCount,
  isEpisodeSkipped,
  isFullyWatched,
  recomputeOffsets,
  sanitizeWatchedEpisodes,
  seasonEpisodes,
  skippedAbsolute,
  toSeasonEpisode,
  totalFromSeasons,
} from "../src/data/episodes";
import type { TitleV4 } from "../src/types";

/**
 * Two 10-episode seasons. Season 2 skips relative 3, 5, 6 and 7 — absolute
 * 13, 15, 16 and 17. Season 1 is fully watched.
 */
function showWithSkips(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "show",
    title: "Show",
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 20,
    episodeDuration: 45,
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] },
      { name: "Season 2", episodes: 10, offset: 10, skippedEpisodes: [3, 5, 6, 7] },
    ],
    watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ...overrides,
  });
}

function movie(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "movie",
    title: "Movie",
    type: "Movie",
    status: "Plan to watch",
    totalEpisodes: 1,
    episodeDuration: 120,
    seasons: [{ name: "Movie", episodes: 1, offset: 0, skippedEpisodes: [] }],
    watchedEpisodes: [],
    ...overrides,
  });
}

describe("skipped episodes", () => {
  it("resolves season-relative skips to absolute numbers", () => {
    expect([...skippedAbsolute(showWithSkips())].sort((a, b) => a - b)).toEqual([13, 15, 16, 17]);
    expect(getTotalSkippedCount(showWithSkips())).toBe(4);
  });

  it("ignores skip entries outside the season's own range", () => {
    const title = showWithSkips();
    title.seasons[1]!.skippedEpisodes = [3, 0, -1, 11, 999];
    expect([...skippedAbsolute(title)]).toEqual([13]);
  });

  it("answers isEpisodeSkipped per absolute number", () => {
    const title = showWithSkips();
    expect(isEpisodeSkipped(title, 13)).toBe(true);
    expect(isEpisodeSkipped(title, 14)).toBe(false);
    expect(isEpisodeSkipped(title, 3)).toBe(false); // season 1 relative 3 is not skipped
  });

  it("excludes skipped episodes from the effective total", () => {
    expect(getEffectiveTotal(showWithSkips())).toBe(16);
  });
});

/** report-watchlog.md §5 item 2. */
describe("sanitizeWatchedEpisodes", () => {
  it("drops skipped, duplicate and out-of-range entries and sorts the rest", () => {
    const title = showWithSkips({ watchedEpisodes: [10, 1, 13, 1, 15, 99, 0, -3, 11] });
    expect(sanitizeWatchedEpisodes(title)).toEqual([1, 10, 11]);
  });

  it("is idempotent", () => {
    const title = showWithSkips({ watchedEpisodes: [10, 1, 13, 1, 15, 99, 11] });
    const once = sanitizeWatchedEpisodes(title);
    title.watchedEpisodes = once;
    expect(sanitizeWatchedEpisodes(title)).toEqual(once);
  });

  it("keeps progress from ever exceeding 100%", () => {
    // v3 allowed all 20 episodes to be "watched" against an effective total of 16.
    const title = showWithSkips({
      watchedEpisodes: Array.from({ length: 20 }, (_, i) => i + 1),
    });
    expect(getWatchedCount(title)).toBe(16);
    expect(getProgress(title)).toBe(100);
    expect(isFullyWatched(title)).toBe(true);
  });
});

/** report-watchlog.md §5 item 1. */
describe("getNextUnwatchedEpisode", () => {
  it("never offers a skipped episode", () => {
    const title = showWithSkips({
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    });
    // 13 is skipped, so the answer must be 14 — v3 answered 13.
    expect(getNextUnwatchedEpisode(title)).toBe(14);
  });

  it("skips a whole run of skipped episodes", () => {
    const title = showWithSkips({
      watchedEpisodes: [...Array.from({ length: 14 }, (_, i) => i + 1)],
    });
    // 15, 16, 17 are all skipped.
    expect(getNextUnwatchedEpisode(title)).toBe(18);
  });

  it("returns the first gap, not the highest watched + 1", () => {
    const title = showWithSkips({ watchedEpisodes: [1, 2, 4, 5] });
    expect(getNextUnwatchedEpisode(title)).toBe(3);
  });

  it("returns null when nothing is left", () => {
    const title = showWithSkips({
      watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 18, 19, 20],
    });
    expect(getNextUnwatchedEpisode(title)).toBeNull();
  });

  it("handles a movie as episode 1", () => {
    expect(getNextUnwatchedEpisode(movie())).toBe(1);
    expect(getNextUnwatchedEpisode(movie({ watchedEpisodes: [1] }))).toBeNull();
  });
});

describe("progress", () => {
  it("measures against the effective total", () => {
    // 10 of 16 countable episodes.
    expect(getProgress(showWithSkips())).toBe(63);
  });

  it("is 0 when there is nothing to watch", () => {
    const title = showWithSkips({ totalEpisodes: 0, seasons: [], watchedEpisodes: [] });
    expect(getEffectiveTotal(title)).toBe(0);
    expect(getProgress(title)).toBe(0);
    expect(isFullyWatched(title)).toBe(false);
  });
});

/** report-watchlog.md §5 item 3 — one formula, no per-surface variants. */
describe("time maths", () => {
  it("counts watched minutes from the countable episodes", () => {
    expect(calcTimeWatched(showWithSkips())).toBe(10 * 45);
  });

  it("credits a Completed title with its whole effective total", () => {
    const title = showWithSkips({ status: "Completed", watchedEpisodes: [1, 2, 3] });
    expect(calcTimeWatched(title)).toBe(16 * 45);
  });

  it("returns remaining minutes for an in-progress title", () => {
    expect(calcTimeRemaining(showWithSkips())).toBe((16 - 10) * 45);
    expect(episodesRemaining(showWithSkips())).toBe(6);
  });

  it.each(["Completed", "Dropped", "To be released"])(
    "reports zero time remaining for %s — the same answer in every surface",
    (status) => {
      expect(calcTimeRemaining(showWithSkips({ status }))).toBe(0);
    },
  );

  it("reports zero for both totals when the duration is unknown", () => {
    const title = showWithSkips({ episodeDuration: 0 });
    expect(calcTimeWatched(title)).toBe(0);
    expect(calcTimeRemaining(title)).toBe(0);
  });

  it("does not count an unreleased title as watched time", () => {
    expect(calcTimeWatched(showWithSkips({ status: "To be released" }))).toBe(0);
  });

  it("formats minutes", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(105)).toBe("1h 45m");
    expect(formatMinutes(1440)).toBe("1d");
    expect(formatMinutes(1440 + 125)).toBe("1d 2h");
  });
});

describe("season helpers", () => {
  it("maps an absolute episode back to its season", () => {
    const mapped = toSeasonEpisode(showWithSkips(), 13);
    expect(mapped?.seasonIndex).toBe(1);
    expect(mapped?.episode).toBe(3);
    expect(toSeasonEpisode(showWithSkips(), 99)).toBeNull();
  });

  it("lists a season's countable episodes only", () => {
    expect(seasonEpisodes(showWithSkips(), 1)).toEqual([11, 12, 14, 18, 19, 20]);
    expect(seasonEpisodes(showWithSkips(), 0)).toHaveLength(10);
    expect(seasonEpisodes(showWithSkips(), 7)).toEqual([]);
  });

  it("recomputes offsets from the season order", () => {
    const seasons = [
      { name: "S1", episodes: 8, offset: 999, skippedEpisodes: [] },
      { name: "S2", episodes: 12, offset: 999, skippedEpisodes: [] },
      { name: "S3", episodes: 6, offset: 999, skippedEpisodes: [] },
    ];
    recomputeOffsets(seasons);
    expect(seasons.map((s) => s.offset)).toEqual([0, 8, 20]);
    expect(totalFromSeasons(seasons)).toBe(26);
  });
});
