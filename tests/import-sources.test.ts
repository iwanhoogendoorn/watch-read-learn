/**
 * The five source parsers.
 *
 * What is asserted here is not "the parser runs" but **the awkward case each
 * source is known for**, because that is where an importer silently produces a
 * library that looks right and is wrong:
 *
 *   - a Letterboxd row with no year, which must stay year-less rather than being
 *     given a plausible one;
 *   - a Trakt entry with an IMDb id and no TMDB one, which is still an exact
 *     identity and must not be downgraded to a name;
 *   - a Simkl show whose progress is a mid-season `LastEpWatched` mark;
 *   - ratings on four different scales, all landing on this plugin's 0–5;
 *   - an IMDb `tvEpisode` row, which is not a title;
 *   - a Ryot entry with no title anywhere in the file.
 */
import { describe, expect, it } from "vitest";
import {
  detectSource,
  parseExport,
  parseImdb,
  parseLetterboxd,
  parseRyot,
  parseSimkl,
  parseTrakt,
} from "../src/domains/import/sources";
import { parseLastEpisode } from "../src/domains/import/sources/simkl";
import { convertRating, inferRyotScale } from "../src/domains/import/types";
import {
  IMDB_RATINGS,
  IMDB_WATCHLIST,
  letterboxdFiles,
  RYOT_EXPORT,
  SIMKL_BACKUP,
  traktFiles,
} from "./fixtures/trackers";
import type { ImportRecord } from "../src/domains/import/types";

function byTitle(records: readonly ImportRecord[], title: string): ImportRecord {
  const hit = records.find((record) => record.title === title);
  expect(hit, `no record titled "${title}"`).toBeDefined();
  return hit as ImportRecord;
}

// ---------------------------------------------------------------------------
// Rating scales
// ---------------------------------------------------------------------------

describe("convertRating", () => {
  it("maps every source's scale onto 0–5", () => {
    expect(convertRating(8, 10)).toBe(4); // IMDb / Trakt / Simkl
    expect(convertRating(3.5, 5)).toBe(3.5); // Letterboxd, already half stars
    expect(convertRating(70, 100)).toBe(3.5); // Ryot, out of 100
  });

  it("rounds to a half star rather than a whole one", () => {
    // 7/10 is 3.5 stars. Rounding to 4 would inflate a whole library by half a
    // star with nothing left on disk to say it happened.
    expect(convertRating(7, 10)).toBe(3.5);
    expect(convertRating(9, 10)).toBe(4.5);
  });

  it("treats no rating as absent, never as zero", () => {
    expect(convertRating(0, 10)).toBeUndefined();
    expect(convertRating(Number.NaN, 10)).toBeUndefined();
  });

  it("infers Ryot's scale from the value, since the export never states it", () => {
    expect(inferRyotScale(70)).toBe(100);
    expect(inferRyotScale(8)).toBe(10);
    expect(inferRyotScale(4)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Letterboxd
// ---------------------------------------------------------------------------

describe("Letterboxd", () => {
  const parsed = parseLetterboxd(letterboxdFiles());

  it("merges watched, ratings and watchlist into one record per film", () => {
    expect(parsed.records).toHaveLength(3);
    const rain = byTitle(parsed.records, "Fixture Rain");
    expect(rain.year).toBe(2019);
    expect(rain.status).toBe("completed");
    expect(rain.rating).toBe(3.5);
    expect(rain.dateFinished).toBe("2024-01-04");
  });

  it("leaves a film with no year year-less rather than inventing one", () => {
    const nameless = byTitle(parsed.records, "Nameless Year Film");
    expect(nameless.year).toBeUndefined();
    expect("year" in nameless).toBe(false);
    // It still carries everything else the file said.
    expect(nameless.rating).toBe(5);
    expect(nameless.status).toBe("completed");
  });

  it("says out loud that a year-less row can only be matched by name", () => {
    expect(parsed.warnings.join(" ")).toContain("no year");
  });

  it("keeps the watchlist as planned, not as watched", () => {
    expect(byTitle(parsed.records, "Unseen Fixture").status).toBe("planned");
  });

  it("carries no ids at all, which is Letterboxd's actual limitation", () => {
    for (const record of parsed.records) {
      expect(record.tmdbId).toBeUndefined();
      expect(record.imdbId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// IMDb
// ---------------------------------------------------------------------------

describe("IMDb", () => {
  const parsed = parseImdb(IMDB_RATINGS);

  it("reads through the BOM Excel leaves on the header row", () => {
    // Without stripping it the first column is named "﻿Const" and no
    // lookup for "const" ever matches.
    expect(byTitle(parsed.records, "Fixture Rain").imdbId).toBe("tt1000001");
  });

  it("converts 1–10 to 0–5", () => {
    expect(byTitle(parsed.records, "Fixture Rain").rating).toBe(4);
    expect(byTitle(parsed.records, "Fixture Signal").rating).toBe(5);
  });

  it("never imports IMDb's own crowd rating as the user's", () => {
    // `IMDb Rating` for Fixture Rain is 7.4, which would be 3.7 stars.
    expect(byTitle(parsed.records, "Fixture Rain").ratingRaw).toEqual({ value: 8, scale: 10 });
  });

  it("drops a tvEpisode row rather than making it a title", () => {
    expect(parsed.records.map((record) => record.title)).not.toContain("Fixture Signal: Chapter Two");
    expect(parsed.warnings.join(" ")).toContain("episode rating");
  });

  it("reads Title Type as the media kind", () => {
    expect(byTitle(parsed.records, "Fixture Rain").mediaType).toBe("movie");
    expect(byTitle(parsed.records, "Fixture Signal").mediaType).toBe("tv");
  });

  it("carries the runtime, which is what a time statistic needs", () => {
    expect(byTitle(parsed.records, "Fixture Signal").runtimeMinutes).toBe(47);
  });

  it("reads a watchlist export, which has no rating column at all", () => {
    const list = parseImdb(IMDB_WATCHLIST);
    const unseen = byTitle(list.records, "Unseen Fixture");
    expect(unseen.status).toBe("planned");
    expect(unseen.rating).toBeUndefined();
    expect(unseen.imdbId).toBe("tt1000004");
  });
});

// ---------------------------------------------------------------------------
// Simkl
// ---------------------------------------------------------------------------

describe("Simkl", () => {
  const parsed = parseSimkl(SIMKL_BACKUP);

  it("carries both ids, which is what makes the match exact", () => {
    const signal = byTitle(parsed.records, "Fixture Signal");
    expect(signal.tmdbId).toBe(4242);
    expect(signal.imdbId).toBe("tt1000002");
    expect(signal.tvdbId).toBe(777001);
  });

  it("reads per-episode progress as a high-water mark", () => {
    const signal = byTitle(parsed.records, "Fixture Signal");
    expect(signal.episodes).toEqual([{ season: 3, episode: 4 }]);
    // The flag is the whole point: S03E04 means *everything up to* S03E04, and
    // expanding it needs season lengths this file does not contain.
    expect(signal.progressIsHighWaterMark).toBe(true);
    expect(signal.status).toBe("watching");
  });

  it("converts the 0–10 rating and keeps the memo as a note", () => {
    const signal = byTitle(parsed.records, "Fixture Signal");
    expect(signal.rating).toBe(4.5);
    expect(signal.notes).toBe("Best one yet");
  });

  it("maps the Watchlist column onto a status", () => {
    expect(byTitle(parsed.records, "Fixture Rain").status).toBe("completed");
    expect(byTitle(parsed.records, "Fixture Silence").status).toBe("planned");
  });

  it("reads anime as television, which is what it is here", () => {
    expect(byTitle(parsed.records, "Fixture Silence").mediaType).toBe("tv");
  });

  it("parses the mark in every spelling, and refuses nonsense", () => {
    expect(parseLastEpisode("S03E04")).toEqual({ season: 3, episode: 4 });
    expect(parseLastEpisode("s1e12")).toEqual({ season: 1, episode: 12 });
    expect(parseLastEpisode("7")).toEqual({ season: 1, episode: 7 });
    expect(parseLastEpisode("")).toBeUndefined();
    expect(parseLastEpisode("finale")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ryot
// ---------------------------------------------------------------------------

describe("Ryot", () => {
  const parsed = parseRyot(RYOT_EXPORT);

  it("imports the TMDB entries as exact ids", () => {
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records.map((record) => record.tmdbId).sort()).toEqual([4242, 4243]);
  });

  it("names an entry after its id, because the export has no titles in it", () => {
    const movie = parsed.records.find((record) => record.tmdbId === 4243);
    expect(movie?.title).toBe("TMDB movie 4243");
    expect(parsed.warnings.join(" ")).toContain("ids rather than names");
  });

  it("uses only the work-level review, never a per-episode one", () => {
    // The show has a 90 overall and a 20 on one episode. Averaging them would
    // invent a rating the user never gave.
    const show = parsed.records.find((record) => record.tmdbId === 4242);
    expect(show?.rating).toBe(4.5);
  });

  it("reads seen_history into episodes, completed ones only", () => {
    const show = parsed.records.find((record) => record.tmdbId === 4242);
    expect(show?.episodes).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
    expect(show?.status).toBe("completed");
  });

  it("reports the entries it cannot use instead of dropping them silently", () => {
    const text = parsed.warnings.join(" ");
    expect(text).toContain("not from TMDB");
    expect(text).toContain("not a film or a show");
  });

  it("says what is wrong with a file that is not a Ryot export", () => {
    expect(parseRyot("{").warnings.join(" ")).toContain("not valid JSON");
    expect(parseRyot("{}").warnings.join(" ")).toContain("metadata");
  });
});

// ---------------------------------------------------------------------------
// Trakt
// ---------------------------------------------------------------------------

describe("Trakt", () => {
  const parsed = parseTrakt(traktFiles());

  it("merges the six files into one record per work", () => {
    expect(parsed.records.map((record) => record.title).sort()).toEqual([
      "Fixture Orphan",
      "Fixture Rain",
      "Fixture Signal",
      "Unseen Fixture",
    ]);
  });

  it("keeps an entry that has an IMDb id and no TMDB one as an exact match", () => {
    const orphan = byTitle(parsed.records, "Fixture Orphan");
    expect(orphan.tmdbId).toBeUndefined();
    expect(orphan.imdbId).toBe("tt1000009");
    expect(parsed.warnings.join(" ")).toContain("IMDb id but no TMDB one");
  });

  it("joins the rating file to the watched file", () => {
    // Neither file alone knows both facts about Fixture Rain.
    const rain = byTitle(parsed.records, "Fixture Rain");
    expect(rain.rating).toBe(3.5);
    expect(rain.status).toBe("completed");
    expect(rain.dateFinished).toBe("2024-01-04");
  });

  it("counts a rewatch once and leaves specials out", () => {
    const signal = byTitle(parsed.records, "Fixture Signal");
    // S01E01 is logged twice and S00E01 once; two episodes survive.
    expect(signal.episodes).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });

  it("calls a show with fewer watches than aired episodes Watching, not Watched", () => {
    const signal = byTitle(parsed.records, "Fixture Signal");
    expect(signal.airedEpisodes).toBe(12);
    expect(signal.status).toBe("watching");
  });

  it("truncates watch timestamps to a date without shifting the day", () => {
    // 21:15Z on the 4th is the 5th in a positive timezone if it goes through a
    // local-time Date. It must not.
    expect(byTitle(parsed.records, "Fixture Rain").dateFinished).toBe("2024-01-04");
  });

  it("keeps the watchlist as planned", () => {
    expect(byTitle(parsed.records, "Unseen Fixture").status).toBe("planned");
  });

  it("says so when none of its files are there", () => {
    const empty = parseTrakt(new Map([["notes.txt", "hello"]]));
    expect(empty.records).toHaveLength(0);
    expect(empty.warnings.join(" ")).toContain("watched-movies.json");
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("detectSource", () => {
  it("recognises each export by its content, not by its extension", () => {
    expect(detectSource(traktFiles())).toBe("trakt");
    expect(detectSource(letterboxdFiles())).toBe("letterboxd");
    expect(detectSource(new Map([["backup.csv", SIMKL_BACKUP]]))).toBe("simkl");
    expect(detectSource(new Map([["anything.csv", IMDB_RATINGS]]))).toBe("imdb");
    expect(detectSource(new Map([["dump.json", RYOT_EXPORT]]))).toBe("ryot");
  });

  it("returns nothing rather than guessing at an unrelated file", () => {
    expect(detectSource(new Map([["shopping.csv", "item,qty\nmilk,2\n"]]))).toBeNull();
  });
});

describe("parseExport", () => {
  it("routes a chosen source at a single-file export", () => {
    const parsed = parseExport("simkl", new Map([["backup.csv", SIMKL_BACKUP]]));
    expect(parsed.source).toBe("simkl");
    expect(parsed.records).toHaveLength(3);
  });

  it("reports the file's own complaint when nothing parses", () => {
    const parsed = parseExport("imdb", new Map([["x.csv", "a,b\n1,2\n"]]));
    expect(parsed.records).toHaveLength(0);
    expect(parsed.warnings.join(" ")).toContain("No Title column");
  });
});
