/**
 * The compact layout's model.
 *
 * Everything the compact Upcoming layout decides before it touches the DOM:
 * which month a row belongs under, how its countdown splits into a number and a
 * unit, what kind of thing it is, and — the one that matters — whether we are
 * entitled to say it has a cadence at all.
 *
 * The cadence block is the point of this file. The reference plugin prints the
 * weekday of the next episode and calls it "Every Thursday", which is a guess
 * dressed as a fact. These tests pin the opposite rule: two consecutive dated
 * episodes a broadcast interval apart, or nothing.
 */
import { describe, expect, it } from "vitest";
import { createBook, createGame, createTitle } from "../src/data/schema";
import { buildUnifiedUpcoming, type UnifiedRow } from "../src/domains/upcoming/unified";
import {
  UNDATED_MONTH_LABEL,
  cadenceFor,
  compactCountdown,
  compactTypeLabel,
  groupByMonth,
  monthKeyOf,
  monthLabelFor,
  titleCadence,
} from "../src/domains/upcoming/months";

/** Fixed "now": Monday 3 August 2026, local time. */
const NOW = new Date(2026, 7, 3, 14, 30);

function rowsFor(options: {
  titles?: Parameters<typeof buildUnifiedUpcoming>[0];
  books?: ReturnType<typeof createBook>[];
  games?: ReturnType<typeof createGame>[];
}): UnifiedRow[] {
  return buildUnifiedUpcoming(
    options.titles ?? [],
    options.books
      ? ({ books: options.books, manga: [] } as never)
      : undefined,
    options.games ? ({ games: options.games } as never) : undefined,
    { now: NOW },
  );
}

describe("month keys and labels", () => {
  it("files a date under its calendar month", () => {
    expect(monthKeyOf("2026-08-05")).toBe("2026-08");
    expect(monthKeyOf("2027-01-31")).toBe("2027-01");
  });

  it("has no month for a row that has no date", () => {
    expect(monthKeyOf(null)).toBeNull();
    expect(monthKeyOf("")).toBeNull();
    expect(monthKeyOf("soon")).toBeNull();
    expect(monthKeyOf("2026-13-01")).toBeNull();
  });

  it("names months from a table, not the host locale", () => {
    // `toLocaleDateString` answers differently per machine, which makes a
    // heading untestable and a screenshot unreproducible.
    expect(monthLabelFor("2026-08")).toBe("August 2026");
    expect(monthLabelFor("2027-01")).toBe("January 2027");
    expect(monthLabelFor("2026-12")).toBe("December 2026");
  });

  it("labels the undated group rather than inventing a month for it", () => {
    expect(monthLabelFor(null)).toBe(UNDATED_MONTH_LABEL);
  });
});

describe("groupByMonth", () => {
  const SEVERANCE = createTitle({
    id: "severance",
    title: "Severance",
    type: "TV Show",
    airing: { nextEpisode: { season: 3, episode: 8, airDate: "2026-08-06", name: "Gray Goo" } },
  });
  const LATER = createTitle({
    id: "later",
    title: "Later Show",
    type: "TV Show",
    airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-09-14" } },
  });
  const ANNOUNCED = createTitle({
    id: "announced",
    title: "Undated Show",
    type: "TV Show",
    airing: { pendingSeason: { number: 4, episodes: 0 } },
  });
  const BOOK = createBook({ id: "book", title: "A Book", releaseDate: "2026-08-20" });
  const GAME = createGame({
    id: "game",
    title: "A Game",
    status: "To be released",
    releaseDate: "2027-02-19",
  });

  it("groups every library's rows under one set of month headings", () => {
    const groups = groupByMonth(rowsFor({ titles: [SEVERANCE, LATER], books: [BOOK], games: [GAME] }));

    expect(groups.map((group) => group.label)).toEqual([
      "August 2026",
      "September 2026",
      "February 2027",
    ]);
    // A book publication and a game launch are rows like any other here.
    expect(groups[0]?.rows.map((row) => row.name)).toEqual(["Severance", "A Book"]);
    expect(groups[2]?.rows.map((row) => row.name)).toEqual(["A Game"]);
  });

  it("gives a month with a single item its own heading", () => {
    const groups = groupByMonth(rowsFor({ games: [GAME] }));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("February 2027");
    expect(groups[0]?.rows).toHaveLength(1);
  });

  it("puts undated rows in a trailing group instead of dropping them", () => {
    const groups = groupByMonth(rowsFor({ titles: [SEVERANCE, ANNOUNCED] }));

    expect(groups.map((group) => group.label)).toEqual(["August 2026", UNDATED_MONTH_LABEL]);
    const last = groups[groups.length - 1];
    expect(last?.key).toBeNull();
    expect(last?.rows.map((row) => row.name)).toEqual(["Undated Show"]);
  });

  it("gives a month one heading even when the rows arrive out of order", () => {
    // The caller's sort is the user's — `Title A→Z` interleaves months — and a
    // run-length grouping over that would print August twice.
    const rows = rowsFor({ titles: [SEVERANCE, LATER], books: [BOOK] });
    const shuffled = [rows[1], rows[0], rows[2]].filter(Boolean) as UnifiedRow[];

    const groups = groupByMonth(shuffled);
    expect(groups.map((group) => group.label)).toEqual(["August 2026", "September 2026"]);
    expect(groups[0]?.rows).toHaveLength(2);
  });

  it("has no groups at all for no rows", () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe("compactCountdown", () => {
  it("splits a duration into a number and its unit", () => {
    expect(compactCountdown(6)).toEqual({ value: "6", unit: "days" });
    expect(compactCountdown(200)).toEqual({ value: "200", unit: "days" });
  });

  it("gives the one-word answers no unit", () => {
    expect(compactCountdown(0)).toEqual({ value: "Today", unit: "" });
    expect(compactCountdown(1)).toEqual({ value: "Tomorrow", unit: "" });
    expect(compactCountdown(-1)).toEqual({ value: "Yesterday", unit: "" });
  });

  it("counts a past row forwards, not as a negative number", () => {
    expect(compactCountdown(-6)).toEqual({ value: "6", unit: "days ago" });
  });

  it("says TBA rather than printing a number for an undated row", () => {
    expect(compactCountdown(null)).toEqual({ value: "TBA", unit: "" });
  });
});

describe("compactTypeLabel", () => {
  it("uses the watchlist's own type word, whatever the user renamed it to", () => {
    const [row] = rowsFor({
      titles: [
        createTitle({
          id: "anime",
          title: "Frieren",
          type: "Anime",
          airing: { nextEpisode: { season: 2, episode: 1, airDate: "2026-08-09" } },
        }),
      ],
    });
    expect(compactTypeLabel(row as UnifiedRow)).toBe("Anime");
  });

  it("names the other libraries' rows for what they are", () => {
    const [book] = rowsFor({ books: [createBook({ id: "b", title: "B", releaseDate: "2026-08-20" })] });
    const [game] = rowsFor({
      games: [createGame({ id: "g", title: "G", status: "To be released", releaseDate: "2026-08-21" })],
    });
    expect(compactTypeLabel(book as UnifiedRow)).toBe("Book");
    expect(compactTypeLabel(game as UnifiedRow)).toBe("Game");
  });
});

describe("cadenceFor — evidence, never a guess", () => {
  function show(airing: Record<string, unknown>) {
    return createTitle({ id: "show", title: "Show", type: "TV Show", airing: airing as never });
  }

  it("states a weekly cadence when two consecutive episodes are 7 days apart", () => {
    const title = show({
      lastEpisode: { season: 3, episode: 7, airDate: "2026-07-30" },
      nextEpisode: { season: 3, episode: 8, airDate: "2026-08-06", name: "Gray Goo" },
    });
    // 2026-08-06 is a Thursday.
    expect(titleCadence(title)).toBe("Every Thursday");

    const [row] = rowsFor({ titles: [title] });
    expect(cadenceFor(row as UnifiedRow)).toBe("Every Thursday");
  });

  it("recognises the fortnightly and daily intervals too", () => {
    expect(
      titleCadence(
        show({
          lastEpisode: { season: 1, episode: 1, airDate: "2026-07-23" },
          nextEpisode: { season: 1, episode: 2, airDate: "2026-08-06" },
        }),
      ),
    ).toBe("Every other Thursday");

    expect(
      titleCadence(
        show({
          lastEpisode: { season: 1, episode: 1, airDate: "2026-08-05" },
          nextEpisode: { season: 1, episode: 2, airDate: "2026-08-06" },
        }),
      ),
    ).toBe("Daily");
  });

  it("says nothing when only the next episode is known", () => {
    // This is exactly the reference plugin's case, and exactly where it invents
    // a schedule out of one date.
    expect(titleCadence(show({ nextEpisode: { season: 3, episode: 8, airDate: "2026-08-06" } }))).toBeNull();
  });

  it("says nothing when the gap is not an interval anyone broadcasts on", () => {
    expect(
      titleCadence(
        show({
          lastEpisode: { season: 1, episode: 1, airDate: "2026-08-02" },
          nextEpisode: { season: 1, episode: 2, airDate: "2026-08-06" },
        }),
      ),
    ).toBeNull();
  });

  it("says nothing across a season boundary or a gap in the numbering", () => {
    expect(
      titleCadence(
        show({
          lastEpisode: { season: 2, episode: 10, airDate: "2026-07-30" },
          nextEpisode: { season: 3, episode: 1, airDate: "2026-08-06" },
        }),
      ),
    ).toBeNull();

    expect(
      titleCadence(
        show({
          lastEpisode: { season: 3, episode: 5, airDate: "2026-07-30" },
          nextEpisode: { season: 3, episode: 8, airDate: "2026-08-06" },
        }),
      ),
    ).toBeNull();
  });

  it("never claims a cadence for a book, a game or a season announcement", () => {
    const [book] = rowsFor({ books: [createBook({ id: "b", title: "B", releaseDate: "2026-08-20" })] });
    const [game] = rowsFor({
      games: [createGame({ id: "g", title: "G", status: "To be released", releaseDate: "2026-08-21" })],
    });
    const [season] = rowsFor({
      titles: [
        createTitle({
          id: "s",
          title: "S",
          type: "TV Show",
          airing: { pendingSeason: { number: 4, episodes: 8, airDate: "2026-09-01" } } as never,
        }),
      ],
    });

    expect(cadenceFor(book as UnifiedRow)).toBeNull();
    expect(cadenceFor(game as UnifiedRow)).toBeNull();
    expect((season as UnifiedRow).kind).toBe("season");
    expect(cadenceFor(season as UnifiedRow)).toBeNull();
  });
});
