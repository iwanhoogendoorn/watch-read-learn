/**
 * Upcoming model — SPEC §4.4.
 *
 * The v3 bugs pinned down here: a next-episode date parsed as UTC read as the
 * previous day in every timezone west of Greenwich, and the tracker could only
 * ever surface a single dated item.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import {
  BUCKET_LABELS,
  bucketFor,
  buildUpcomingEntries,
  countDue,
  daysBetween,
  formatCountdown,
  formatDate,
  formatEpisodeCode,
  groupByBucket,
  parseDateOnly,
  plexPill,
  progressSentence,
  requestPill,
} from "../src/ui/tabs/upcoming";
import { MediaStatus, type TitleV4 } from "../src/types";

/** Fixed "now": Monday 3 August 2026, local time. */
const NOW = new Date(2026, 7, 3, 14, 30);

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "show",
    title: overrides.title ?? "Show",
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 10,
    episodeDuration: 45,
    ...overrides,
  });
}

describe("date helpers", () => {
  it("parses YYYY-MM-DD as a local calendar date, not UTC midnight", () => {
    const date = parseDateOnly("2026-08-03");
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7);
    expect(date?.getDate()).toBe(3);
  });

  it("rejects junk and empty input", () => {
    expect(parseDateOnly("")).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly("nope")).toBeNull();
    expect(parseDateOnly("2026-13-01")).toBeNull();
  });

  it("counts whole calendar days regardless of time of day", () => {
    expect(daysBetween(NOW, new Date(2026, 7, 3, 1, 0))).toBe(0);
    expect(daysBetween(NOW, new Date(2026, 7, 4, 23, 59))).toBe(1);
    expect(daysBetween(NOW, new Date(2026, 7, 1))).toBe(-2);
  });

  it("formats countdowns the way the spec words them", () => {
    expect(formatCountdown(0)).toBe("today");
    expect(formatCountdown(1)).toBe("tomorrow");
    expect(formatCountdown(4)).toBe("in 4 days");
    expect(formatCountdown(-1)).toBe("yesterday");
    expect(formatCountdown(-3)).toBe("3 days ago");
    expect(formatCountdown(90)).toBe("in 3 months");
    expect(formatCountdown(null)).toBe("date TBA");
  });

  it("formats dates in each configured style", () => {
    expect(formatDate("2026-12-31", "european")).toBe("31-12-2026");
    expect(formatDate("2026-12-31", "american")).toBe("12/31/2026");
    expect(formatDate("2026-12-31", "iso")).toBe("2026-12-31");
    expect(formatDate("", "iso")).toBe("");
  });

  it("formats episode codes with padding", () => {
    expect(formatEpisodeCode(3, 8)).toBe("S03E08");
    expect(formatEpisodeCode(12, 104)).toBe("S12E104");
    expect(formatEpisodeCode(undefined, 4)).toBe("E04");
  });
});

describe("buildUpcomingEntries", () => {
  it("emits a row per next episode, sorted ascending", () => {
    const entries = buildUpcomingEntries(
      [
        show({
          id: "later",
          title: "Later",
          airing: { nextEpisode: { season: 2, episode: 3, airDate: "2026-08-10" } },
        }),
        show({
          id: "sooner",
          title: "Sooner",
          airing: { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-04", name: "Pilot" } },
        }),
      ],
      NOW,
    );

    expect(entries.map((e) => e.title.id)).toEqual(["sooner", "later"]);
    expect(entries[0]?.label).toBe("S03E08");
    expect(entries[0]?.detail).toBe("Pilot");
    expect(entries[0]?.daysUntil).toBe(1);
    expect(entries[1]?.daysUntil).toBe(7);
  });

  it("keeps recently aired episodes inside the past window and drops older ones", () => {
    const entries = buildUpcomingEntries(
      [
        show({ id: "recent", airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-01" } } }),
        show({ id: "ancient", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-06-01" } } }),
      ],
      NOW,
    );
    expect(entries.map((e) => e.title.id)).toEqual(["recent"]);
    expect(entries[0]?.daysUntil).toBe(-2);
  });

  it("emits a movie release row and labels it once it has passed", () => {
    const entries = buildUpcomingEntries(
      [
        createTitle({ id: "soon", title: "Soon", type: "Movie", releaseDate: "2026-08-05" }),
        createTitle({ id: "out", title: "Out", type: "Movie", releaseDate: "2026-08-02" }),
      ],
      NOW,
    );
    expect(entries.map((e) => e.title.id)).toEqual(["out", "soon"]);
    expect(entries[0]?.kind).toBe("release");
    // One label per row, one tense: the past-tense label carries it, and the
    // second line is dropped rather than repeating the word (QA1 B4).
    expect(entries[0]?.label).toBe("Released");
    expect(entries[0]?.detail).toBe("");
    expect(entries[1]?.label).toBe("Release");
    expect(entries[1]?.detail).toBe("Movie release");
  });

  it("falls back to the digital release once the theatrical date is long past", () => {
    const entries = buildUpcomingEntries(
      [
        createTitle({
          id: "movie",
          title: "Movie",
          type: "Movie",
          releaseDate: "2026-01-01",
          airing: { digitalReleaseDate: "2026-08-06" },
        }),
      ],
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Digital release");
    expect(entries[0]?.daysUntil).toBe(3);
  });

  it("announces a new season, undated when upstream has not scheduled it", () => {
    const entries = buildUpcomingEntries([show({ airing: { newSeasonDetected: 4 } })], NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("season");
    expect(entries[0]?.label).toBe("Season 4");
    expect(entries[0]?.date).toBeNull();
    expect(entries[0]?.daysUntil).toBeNull();
  });

  it("stands the season row down once that season has a scheduled episode", () => {
    const entries = buildUpcomingEntries(
      [
        show({
          airing: {
            newSeasonDetected: 4,
            nextEpisode: { season: 4, episode: 1, airDate: "2026-08-09" },
          },
        }),
      ],
      NOW,
    );
    // The episode row is the better version of the same news: same date, and
    // it says which episode (QA3 — announcements stop being their own workflow).
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("episode");
    expect(entries[0]?.label).toBe("S04E01");
    expect(entries[0]?.daysUntil).toBe(6);
  });

  it("keeps both rows when the announced season is not the one airing next", () => {
    const entries = buildUpcomingEntries(
      [
        show({
          airing: {
            newSeasonDetected: 5,
            nextEpisode: { season: 4, episode: 9, airDate: "2026-08-05" },
          },
        }),
      ],
      NOW,
    );
    expect(entries.map((e) => e.kind)).toEqual(["episode", "season"]);
  });

  it("prefers the episode row over a release row for a returning show", () => {
    const entries = buildUpcomingEntries(
      [
        show({
          releaseDate: "2026-08-20",
          airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-04" } },
        }),
      ],
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("episode");
  });

  it("ignores titles with no airing or release data at all", () => {
    expect(buildUpcomingEntries([show()], NOW)).toEqual([]);
  });
});

describe("buckets and the due count", () => {
  const entries = buildUpcomingEntries(
    [
      show({ id: "a", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-03" } } }),
      show({ id: "b", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-04" } } }),
      show({ id: "c", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-08" } } }),
      show({ id: "d", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-09-30" } } }),
      show({ id: "e", airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-01" } } }),
      show({ id: "f", airing: { newSeasonDetected: 2 } }),
    ],
    NOW,
  );

  it("assigns each entry to a bucket", () => {
    const byId = new Map(entries.map((e) => [e.title.id, bucketFor(e)]));
    expect(byId.get("a")).toBe("today");
    expect(byId.get("b")).toBe("tomorrow");
    expect(byId.get("c")).toBe("week");
    expect(byId.get("d")).toBe("later");
    expect(byId.get("e")).toBe("aired");
    expect(byId.get("f")).toBe("tba");
  });

  it("groups in display order and drops empty buckets", () => {
    const groups = groupByBucket(entries).map((g) => g.bucket);
    expect(groups).toEqual(["aired", "today", "tomorrow", "week", "later", "tba"]);
    expect(BUCKET_LABELS.today).toBe("Today");
  });

  it("counts today and overdue as due — that is the status-bar number", () => {
    expect(countDue(entries)).toBe(2);
  });
});

describe("state pills", () => {
  it("describes Plex availability, and says nothing when unchecked", () => {
    expect(plexPill(show())).toBeNull();
    expect(plexPill(show({ plex: { state: "unknown" } }))).toBeNull();
    expect(plexPill(show({ plex: { state: "available" } }))?.text).toBe("On Plex");
    expect(plexPill(show({ plex: { state: "none" } }))).toEqual({
      text: "Not on Plex",
      tone: "muted",
    });
    expect(plexPill(show({ plex: { state: "partial", leafCount: 4 } }))?.text).toBe("4/10 eps");
  });

  it("keeps the request and media status enums apart", () => {
    expect(requestPill(show())).toBeNull();
    expect(requestPill(show({ request: { id: 7, status: 1 } }))?.text).toBe("Requested");
    expect(requestPill(show({ request: { id: 7, status: 2 } }))?.text).toBe("Approved");
    // mediaStatus wins: an approved request whose media is available reads "Available".
    expect(
      requestPill(show({ request: { id: 7, status: 2, mediaStatus: MediaStatus.AVAILABLE } }))?.text,
    ).toBe("Available");
    expect(
      requestPill(show({ request: { id: 7, mediaStatus: MediaStatus.PROCESSING } }))?.text,
    ).toBe("Processing");
  });
});

describe("progressSentence", () => {
  it("says nothing for a single-episode title", () => {
    expect(progressSentence(createTitle({ id: "m", title: "M", type: "Movie" }))).toBe("");
  });

  it("names the next episode and how many are left", () => {
    const title = show({
      seasons: [
        { name: "Season 1", episodes: 5, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 5, offset: 5, skippedEpisodes: [], seasonNumber: 2 },
      ],
      watchedEpisodes: [1, 2, 3, 4, 5, 6],
    });
    expect(progressSentence(title)).toBe("Next up S02E02 · 4 left");
  });

  it("reports completion when everything is watched", () => {
    const title = show({ watchedEpisodes: Array.from({ length: 10 }, (_, i) => i + 1) });
    expect(progressSentence(title)).toBe("All episodes watched");
  });
});
