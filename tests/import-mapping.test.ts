/**
 * `autoDetectMapping` against the header rows trackers actually ship.
 *
 * The claim at the top of `data/csv.ts` is that a Trakt, Letterboxd or IMDb
 * export "lands somewhere in that table". This is that claim, written down as
 * something that can fail. It could, before: matching was equality-only, and
 * IMDb's column is `Your Rating` — so the single column a ratings export exists
 * for went into `unmapped` and the import produced a library of films with no
 * ratings on any of them.
 *
 * The dangerous half of the fix is the other direction. A substring pass that
 * runs per-header lets a loose match take a field that an exact match later in
 * the same row wants, which is a *worse* failure than the one being fixed —
 * silently wrong beats visibly missing. So the passes are whole-row and ordered,
 * and the tests below pin the ordering rather than just the happy path.
 *
 * The tracker importer itself does not go through here — `parseImdb` asks for
 * `"your rating"` by name — so this covers the generic CSV path, where the user
 * still sees and can correct the mapping before anything is written.
 */
import { describe, expect, it } from "vitest";
import { autoDetectMapping } from "../src/data/csv";

/** IMDb's export, verbatim, in its real column order. */
const IMDB_HEADERS = [
  "Const",
  "Your Rating",
  "Date Rated",
  "Title",
  "Original Title",
  "URL",
  "Title Type",
  "IMDb Rating",
  "Runtime (mins)",
  "Year",
  "Genres",
  "Num Votes",
  "Release Date",
  "Directors",
];

const LETTERBOXD_HEADERS = ["Date", "Name", "Year", "Letterboxd URI", "Rating"];

describe("autoDetectMapping picks up the real IMDb header row", () => {
  const mapping = autoDetectMapping(IMDB_HEADERS, "watchlist");

  it("maps Your Rating, which equality alone missed entirely", () => {
    expect(mapping["Your Rating"]).toBe("rating");
  });

  it("does not let IMDb's crowd rating take the field instead", () => {
    // Both contain "rating". `Your Rating` comes first in IMDb's real header,
    // and once it has claimed the field nothing else can.
    expect(mapping["IMDb Rating"]).toBeUndefined();
  });

  it("maps the runtime, parenthesised units and all", () => {
    expect(mapping["Runtime (mins)"]).toBe("episodeDuration");
  });

  it("maps Title exactly and leaves Title Type to the type field", () => {
    expect(mapping["Title"]).toBe("title");
    expect(mapping["Title Type"]).toBe("type");
    // `Original Title` must not have taken `title` — an exact hit elsewhere in
    // the row wins, wherever in the row it is.
    expect(mapping["Original Title"]).toBeUndefined();
  });

  it("maps the columns it always could", () => {
    expect(mapping["URL"]).toBe("externalLink");
    expect(mapping["Release Date"]).toBe("releaseDate");
  });
});

describe("autoDetectMapping picks up the real Letterboxd header row", () => {
  const mapping = autoDetectMapping(LETTERBOXD_HEADERS, "watchlist");

  it("maps Name and Rating", () => {
    expect(mapping["Name"]).toBe("title");
    expect(mapping["Rating"]).toBe("rating");
  });

  it("still cannot place Letterboxd URI, and that is a synonym gap not a matching one", () => {
    // The link synonyms are link/url/externallink — "uri" is none of them, and
    // no amount of substring matching invents it. Closing this needs "uri"
    // added to `externalLink`, which is a change to the frozen synonym table
    // rather than to how it is searched, so it is reported rather than taken.
    expect(mapping["Letterboxd URI"]).toBeUndefined();
  });
});

describe("exact always beats substring, wherever the columns sit", () => {
  it("gives a field to its exact column even when a loose one comes first", () => {
    // Read per-header rather than in two passes, "Ratings summary" would claim
    // `rating` before the column actually called `rating` was ever considered.
    const mapping = autoDetectMapping(["Ratings summary", "rating"], "watchlist");
    expect(mapping["rating"]).toBe("rating");
    expect(mapping["Ratings summary"]).toBeUndefined();
  });

  it("prefers the longest synonym on the substring pass", () => {
    // `date started` and `started` both match; the specific one has to win, or
    // a shorter synonym belonging to another field could claim the column.
    const mapping = autoDetectMapping(["My date started"], "watchlist");
    expect(mapping["My date started"]).toBe("dateStarted");
  });

  it("only matches header-contains-synonym, never the reverse", () => {
    // `type` must not be able to claim a column called `t`.
    expect(autoDetectMapping(["t", "n"], "watchlist")).toEqual({});
  });

  it("ignores synonyms too short to mean anything on their own", () => {
    // Reading always maps `by` to author on an exact hit, and never on a
    // substring one — otherwise "Bought by" and "Nearby shelf" both become the
    // author column.
    const mapping = autoDetectMapping(["Bought by"], "reading");
    expect(mapping["Bought by"]).toBeUndefined();
    expect(autoDetectMapping(["by"], "reading")["by"]).toBe("author");
  });

  it("still maps a v3 export exactly, which is the compatibility promise", () => {
    const v3 = ["title", "type", "status", "priority", "rating", "notes", "studio"];
    expect(autoDetectMapping(v3, "watchlist")).toEqual({
      title: "title",
      type: "type",
      status: "status",
      priority: "priority",
      rating: "rating",
      notes: "notes",
      studio: "studio",
    });
  });
});
