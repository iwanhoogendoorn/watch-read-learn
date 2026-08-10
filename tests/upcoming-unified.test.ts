/**
 * One Upcoming list, three libraries (SPEC2 §"Surfaces that grow").
 *
 * v3's `resolveEntry` gave each source its own nouns — episode, chapter,
 * release — and that is the whole trick: the rows are identical in shape and
 * only the words change. These tests pin the merge, the ordering, the nouns and
 * the status-bar sentence, which is the one place all three libraries have to
 * agree on a single number.
 */
import { describe, expect, it } from "vitest";
import { createBook, createGame, createGamesSettings, createManga, createReadingSettings, createTitle } from "../src/data/schema";
import {
  UPCOMING_NOUNS,
  buildUnifiedUpcoming,
  countUnified,
  countUnifiedDue,
  statusBarText,
} from "../src/domains/upcoming/unified";
import type { GamesData, ReadingData, TitleV4 } from "../src/types";

const NOW = new Date(2026, 7, 3); // Monday 3 August 2026

function reading(overrides: Partial<ReadingData> = {}): ReadingData {
  return {
    books: [],
    manga: [],
    bookColumns: [],
    mangaColumns: [],
    settings: createReadingSettings(),
    ...overrides,
  };
}

function games(list: GamesData["games"] = []): GamesData {
  return { games: list, groups: [], settings: createGamesSettings() };
}

const show = (overrides: Partial<TitleV4> = {}): TitleV4 =>
  createTitle({
    id: "show",
    title: "A Show",
    type: "TV Show",
    airing: { nextEpisode: { season: 2, episode: 3, airDate: "2026-08-05" } },
    ...overrides,
  });

describe("merging the libraries", () => {
  it("puts every source in one chronological list", () => {
    const rows = buildUnifiedUpcoming(
      [show()],
      reading({
        books: [createBook({ id: "b", title: "A Book", author: "An Author", releaseDate: "2026-08-04" })],
      }),
      games([createGame({ id: "g", title: "A Game", status: "To be released", releaseDate: "2026-08-06" })]),
      { now: NOW },
    );

    expect(rows.map((r) => r.name)).toEqual(["A Book", "A Show", "A Game"]);
    expect(rows.map((r) => r.source)).toEqual(["reading", "watchlist", "games"]);
  });

  it("gives each row its own library's nouns", () => {
    const rows = buildUnifiedUpcoming(
      [show()],
      reading({ books: [createBook({ id: "b", title: "B", releaseDate: "2026-08-04" })] }),
      games([createGame({ id: "g", title: "G", status: "To be released", releaseDate: "2026-08-06" })]),
      { now: NOW },
    );
    expect(rows.find((r) => r.source === "watchlist")?.noun).toEqual(UPCOMING_NOUNS.watchlist);
    expect(rows.find((r) => r.source === "reading")?.noun.unit).toBe("chapter");
    expect(rows.find((r) => r.source === "games")?.noun.next).toBe("Releasing next");
  });

  it("keeps undated announcements last, where they displace nothing", () => {
    const rows = buildUnifiedUpcoming(
      [show({ id: "tba", title: "Announced", airing: { newSeasonDetected: 4 } })],
      reading({ books: [createBook({ id: "b", title: "Dated", releaseDate: "2026-08-09" })] }),
      games(),
      { now: NOW },
    );
    expect(rows.map((r) => r.name)).toEqual(["Dated", "Announced"]);
    expect(rows[1]?.daysUntil).toBeNull();
  });

  it("can be scoped to a subset of libraries", () => {
    const rows = buildUnifiedUpcoming(
      [show()],
      reading({ books: [createBook({ id: "b", title: "B", releaseDate: "2026-08-04" })] }),
      games(),
      { now: NOW, sources: ["reading"] },
    );
    expect(rows.map((r) => r.source)).toEqual(["reading"]);
  });

  it("survives a store with no parity libraries at all", () => {
    const rows = buildUnifiedUpcoming([show()], undefined, undefined, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("watchlist");
  });

  it("keeps a just-published book for a week, and says so in the past tense", () => {
    // The same window every other library gets. `upcomingReleases` would have
    // dropped this two days ago — it answers "still to come", which is the right
    // question for a status and the wrong one for a list you read on Monday.
    const rows = buildUnifiedUpcoming(
      [],
      reading({ books: [createBook({ id: "b", title: "Out", releaseDate: "2026-08-01" })] }),
      games(),
      { now: NOW },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Published");
    expect(rows[0]?.daysUntil).toBe(-2);
  });

  it("drops a book published longer ago than the window", () => {
    const rows = buildUnifiedUpcoming(
      [],
      reading({ books: [createBook({ id: "b", title: "Old", releaseDate: "2026-06-01" })] }),
      games(),
      { now: NOW },
    );
    expect(rows).toEqual([]);
  });

  it("carries the author as a book row's second line", () => {
    const rows = buildUnifiedUpcoming(
      [],
      reading({
        manga: [createManga({ id: "m", title: "M", author: "Kentaro Miura", releaseDate: "2026-09-01" })],
      }),
      games(),
      { now: NOW },
    );
    expect(rows[0]?.detail).toBe("Kentaro Miura");
    expect(rows[0]?.entry.source).toBe("reading");
  });
});

describe("counting across libraries", () => {
  const dueEverywhere = () =>
    buildUnifiedUpcoming(
      [show({ airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-03" } } })],
      reading({ books: [createBook({ id: "b", title: "B", releaseDate: "2026-08-03" })] }),
      games([createGame({ id: "g", title: "G", status: "To be released", releaseDate: "2026-08-02" })]),
      { now: NOW },
    );

  it("counts what has arrived, per library and in total", () => {
    const counts = countUnified(dueEverywhere());
    expect(counts.due).toBe(3);
    expect(counts.bySource).toEqual({ watchlist: 1, reading: 1, games: 1 });
    expect(countUnifiedDue(dueEverywhere())).toBe(3);
  });

  it("names the libraries in the status bar when more than one is due", () => {
    expect(statusBarText(dueEverywhere())).toBe("3 due · 1 to watch, 1 to read, 1 to play");
  });

  it("keeps the short sentence when only one library is due", () => {
    const rows = buildUnifiedUpcoming(
      [show({ airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-08-03" } } })],
      reading(),
      games(),
      { now: NOW },
    );
    expect(statusBarText(rows)).toBe("1 due today");
  });

  it("says nothing at all when nothing is due", () => {
    const rows = buildUnifiedUpcoming([show()], reading(), games(), { now: NOW });
    expect(rows.length).toBeGreaterThan(0); // there IS something upcoming
    expect(statusBarText(rows)).toBe(""); // just not today
  });
});
