/**
 * CSV (SPEC2-PARITY.md §D-EXTRAS, item 3; report §2.5).
 *
 * The compatibility surface is the point of most of this file. v3's export is
 * fourteen named columns in a fixed order, and its importer auto-maps a foreign
 * header row through a synonym table. Both are things a user has files sitting
 * on disk for; both are asserted literally here rather than described.
 *
 * The round trip is the strongest of the tests: export a title, import the
 * result, and every one of the fourteen fields has to survive — including a
 * comma in the notes, a quote in the title, and a studio list that was joined
 * into one cell on the way out.
 */
import { describe, expect, it } from "vitest";
import {
  autoDetectMapping,
  buildImportPlan,
  coerceRow,
  escapeCsvCell,
  exportFileName,
  exportGamesCsv,
  exportReadingCsv,
  exportWatchlistCsv,
  fieldsFor,
  indexExisting,
  parseCsv,
  parseLooseDate,
  serializeCsv,
  WATCHLIST_FIELDS,
} from "../src/data/csv";
import { createBook, createGame, createTitle } from "../src/data/schema";
import { CSV_WATCHLIST_COLUMNS } from "../src/types";

// ---------------------------------------------------------------------------
// The reader and the writer
// ---------------------------------------------------------------------------

describe("parseCsv", () => {
  it("reads quoted cells, doubled quotes and embedded newlines", () => {
    const text = 'a,b\n"one, two","he said ""hi"""\n"line\nbreak",x';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["one, two", 'he said "hi"'],
      ["line\nbreak", "x"],
    ]);
  });

  it("normalises CRLF and drops trailing blank rows", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells rather than collapsing the row", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("escapeCsvCell", () => {
  it("quotes only what needs it", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("two\nlines")).toBe('"two\nlines"');
    expect(escapeCsvCell(null)).toBe("");
  });

  it("round-trips through the reader", () => {
    const cells = ["a,b", 'q"q', "n\nn", ""];
    expect(parseCsv(serializeCsv(["x"], cells.map((cell) => [cell])))[1]?.[0]).toBe("a,b");
  });
});

// ---------------------------------------------------------------------------
// Lenient dates (v3 `dn`)
// ---------------------------------------------------------------------------

describe("parseLooseDate", () => {
  it("passes an ISO date straight through", () => {
    expect(parseLooseDate("2024-03-09")).toBe("2024-03-09");
  });

  it("reads an unambiguous slash date whichever way round it is", () => {
    expect(parseLooseDate("25/03/2024")).toBe("2024-03-25");
    expect(parseLooseDate("03/25/2024")).toBe("2024-03-25");
  });

  it("reads an ambiguous slash date as day/month — v3's rule", () => {
    expect(parseLooseDate("03/09/2024")).toBe("2024-09-03");
  });

  it("reads written months in both orders", () => {
    expect(parseLooseDate("9 March 2024")).toBe("2024-03-09");
    expect(parseLooseDate("March 9, 2024")).toBe("2024-03-09");
    expect(parseLooseDate("Mar 9 2024")).toBe("2024-03-09");
  });

  it("reads dotted and dashed day-first dates", () => {
    expect(parseLooseDate("09.03.2024")).toBe("2024-03-09");
    expect(parseLooseDate("09-03-2024")).toBe("2024-03-09");
  });

  it("returns null for an empty cell and for nonsense", () => {
    expect(parseLooseDate("")).toBeNull();
    expect(parseLooseDate("   ")).toBeNull();
    expect(parseLooseDate("soon")).toBeNull();
    expect(parseLooseDate("45/45/2024")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function sampleTitle() {
  return createTitle({
    id: "arrival",
    title: 'Arrival, or "Story of Your Life"',
    type: "Movie",
    status: "Completed",
    priority: "",
    rating: 4.5,
    totalEpisodes: 1,
    episodeDuration: 116,
    dateStarted: "2024-03-09",
    dateFinished: "2024-03-09",
    releaseDate: "2016-11-11",
    dateAdded: "2024-03-01T10:00:00.000Z",
    externalLink: "https://www.imdb.com/title/tt2543164/",
    notes: "Rewatch, with subtitles",
    studio: ["Lava Bear Films"],
    manualStudio: ["FilmNation"],
  });
}

describe("exportWatchlistCsv", () => {
  it("writes v3's exact fourteen columns in v3's order", () => {
    const header = exportWatchlistCsv([]).split("\n")[0];
    expect(header).toBe(CSV_WATCHLIST_COLUMNS.join(","));
    expect(CSV_WATCHLIST_COLUMNS).toHaveLength(14);
  });

  it("merges API and manual studios into the one column", () => {
    const row = parseCsv(exportWatchlistCsv([sampleTitle()]))[1]!;
    expect(row[13]).toBe("Lava Bear Films; FilmNation");
  });

  it("writes an empty cell for a null date rather than the word null", () => {
    const title = createTitle({ id: "x", title: "X", type: "Movie" });
    const row = parseCsv(exportWatchlistCsv([title]))[1]!;
    expect(row[7]).toBe("");
    expect(row[9]).toBe("");
  });

  it("names the file the way v3 did", () => {
    const day = new Date(2026, 7, 3);
    expect(exportFileName("watchlist", day)).toBe("watchlog-export-2026-08-03.csv");
    expect(exportFileName("games", day)).toBe("watchlog-export-games-2026-08-03.csv");
  });
});

describe("reading and games exports", () => {
  it("write their own field names", () => {
    const books = exportReadingCsv([createBook({ id: "dune", title: "Dune", author: "Herbert" })]);
    expect(books.split("\n")[0]).toContain("author");
    expect(parseCsv(books)[1]?.[1]).toBe("Herbert");

    const games = exportGamesCsv([
      createGame({ id: "hades", title: "Hades", platforms: ["Windows PC", "Nintendo Switch 2"] }),
    ]);
    expect(parseCsv(games)[1]).toContain("Windows PC; Nintendo Switch 2");
  });
});

// ---------------------------------------------------------------------------
// The synonym table
// ---------------------------------------------------------------------------

describe("autoDetectMapping", () => {
  it("maps v3's own header row onto itself", () => {
    const mapping = autoDetectMapping([...CSV_WATCHLIST_COLUMNS], "watchlist");
    for (const column of CSV_WATCHLIST_COLUMNS) expect(mapping[column]).toBe(column);
  });

  it("maps the synonyms v3 shipped", () => {
    const mapping = autoDetectMapping(
      ["Name", "Score", "Runtime", "Start Date", "Finish Date", "Network", "URL"],
      "watchlist",
    );
    expect(mapping).toEqual({
      Name: "title",
      Score: "rating",
      Runtime: "episodeDuration",
      "Start Date": "dateStarted",
      "Finish Date": "dateFinished",
      Network: "studio",
      URL: "externalLink",
    });
  });

  it("leaves a header it does not recognise unmapped", () => {
    expect(autoDetectMapping(["Title", "Vibes"], "watchlist")).toEqual({ Title: "title" });
  });

  it("never maps two columns onto the same field", () => {
    const mapping = autoDetectMapping(["title", "name"], "watchlist");
    expect(Object.values(mapping)).toEqual(["title"]);
  });

  it("uses each domain's own table", () => {
    expect(autoDetectMapping(["Author", "Number of Pages"], "reading")).toEqual({
      Author: "author",
      "Number of Pages": "totalPages",
    });
    expect(autoDetectMapping(["Playtime", "Platform"], "games")).toEqual({
      Playtime: "playtimeMinutes",
      Platform: "platforms",
    });
  });

  it("exposes a field list per domain for the mapping dropdowns", () => {
    expect(fieldsFor("watchlist")).toBe(WATCHLIST_FIELDS);
    expect(fieldsFor("reading").some((field) => field.key === "author")).toBe(true);
    expect(fieldsFor("games").some((field) => field.key === "playtimeMinutes")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The import plan
// ---------------------------------------------------------------------------

const FOREIGN = [
  ["Name", "Type", "Score", "Runtime", "Vibes"],
  ["Arrival", "Movie", "4.5", "116", "melancholy"],
  ["Sicario", "Movie", "4", "121", "tense"],
  ["", "", "", "", ""],
];

describe("buildImportPlan", () => {
  const existing = indexExisting([{ id: "arrival", title: "Arrival" }]);

  it("keeps only mapped columns, and reports the rest", () => {
    const mapping = autoDetectMapping(FOREIGN[0]!, "watchlist");
    const plan = buildImportPlan("watchlist", FOREIGN, mapping, existing);
    expect(plan.unmapped).toEqual(["Vibes"]);
    expect(plan.rows[0]?.values).toEqual({
      title: "Arrival",
      type: "Movie",
      rating: "4.5",
      episodeDuration: "116",
    });
  });

  it("flags a duplicate by title, case-insensitively", () => {
    const plan = buildImportPlan(
      "watchlist",
      FOREIGN,
      autoDetectMapping(FOREIGN[0]!, "watchlist"),
      indexExisting([{ id: "arrival", title: "arrival" }]),
    );
    expect(plan.rows[0]?.duplicateOf).toBe("arrival");
    expect(plan.rows[1]?.duplicateOf).toBeUndefined();
  });

  it("drops rows that are entirely blank", () => {
    const plan = buildImportPlan(
      "watchlist",
      FOREIGN,
      autoDetectMapping(FOREIGN[0]!, "watchlist"),
      existing,
    );
    expect(plan.rows).toHaveLength(2);
  });

  it("drops a row whose only values are in unmapped columns", () => {
    const plan = buildImportPlan("watchlist", FOREIGN, { Vibes: "notes" }, existing);
    expect(plan.rows.map((row) => row.values.notes)).toEqual(["melancholy", "tense"]);
    // …and with nothing mapped at all, nothing is imported.
    expect(buildImportPlan("watchlist", FOREIGN, {}, existing).rows).toHaveLength(0);
  });
});

describe("coerceRow", () => {
  it("turns strings into the types the entity wants", () => {
    const values = coerceRow("watchlist", {
      title: "Arrival",
      rating: "4.5",
      totalEpisodes: "1",
      dateStarted: "09/03/2024",
      studio: "Lava Bear Films; FilmNation",
    });
    expect(values).toEqual({
      title: "Arrival",
      rating: 4.5,
      totalEpisodes: 1,
      // Day-first, per `parseLooseDate`'s documented ambiguity rule.
      dateStarted: "2024-03-09",
      studio: ["Lava Bear Films", "FilmNation"],
    });
  });

  it("clamps a rating to 0–5", () => {
    expect(coerceRow("watchlist", { rating: "11" }).rating).toBe(5);
    expect(coerceRow("watchlist", { rating: "-2" }).rating).toBe(0);
  });

  it("drops a cell it cannot parse rather than writing a zero", () => {
    // A silent 0 duration is worse than no duration: it makes every time
    // statistic quietly wrong instead of visibly missing.
    expect(coerceRow("watchlist", { episodeDuration: "about two hours" })).toEqual({});
    expect(coerceRow("watchlist", { dateStarted: "soon" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe("export → import", () => {
  it("survives commas, quotes and joined lists", () => {
    const original = sampleTitle();
    const rows = parseCsv(exportWatchlistCsv([original]));
    const mapping = autoDetectMapping(rows[0]!, "watchlist");
    const plan = buildImportPlan("watchlist", rows, mapping, indexExisting([]));
    const values = coerceRow("watchlist", plan.rows[0]!.values);

    expect(values.title).toBe(original.title);
    expect(values.type).toBe("Movie");
    expect(values.status).toBe("Completed");
    expect(values.rating).toBe(4.5);
    expect(values.totalEpisodes).toBe(1);
    expect(values.episodeDuration).toBe(116);
    expect(values.dateStarted).toBe("2024-03-09");
    expect(values.dateFinished).toBe("2024-03-09");
    expect(values.releaseDate).toBe("2016-11-11");
    expect(values.externalLink).toBe(original.externalLink);
    expect(values.notes).toBe("Rewatch, with subtitles");
    expect(values.studio).toEqual(["Lava Bear Films", "FilmNation"]);
  });

  it("re-importing an export flags every row as a duplicate", () => {
    const original = sampleTitle();
    const rows = parseCsv(exportWatchlistCsv([original]));
    const plan = buildImportPlan(
      "watchlist",
      rows,
      autoDetectMapping(rows[0]!, "watchlist"),
      indexExisting([original]),
    );
    expect(plan.rows.every((row) => row.duplicateOf === "arrival")).toBe(true);
  });

  it("round-trips a book through its own field set", () => {
    const book = createBook({
      id: "dune",
      title: "Dune",
      author: "Frank Herbert",
      totalPages: 412,
      status: "Reading",
    });
    const rows = parseCsv(exportReadingCsv([book]));
    const plan = buildImportPlan(
      "reading",
      rows,
      autoDetectMapping(rows[0]!, "reading"),
      indexExisting([]),
    );
    const values = coerceRow("reading", plan.rows[0]!.values);
    expect(values.author).toBe("Frank Herbert");
    expect(values.totalPages).toBe(412);
    expect(values.status).toBe("Reading");
  });
});
