/**
 * v3 → v4 migration.
 *
 * The fixture is modelled on Iwan's real `data.json`: three titles (two movies,
 * one show) carrying the exact sentinels his file contains (`trailerUrl: "none"`,
 * `studio: ["none"]`), plus the `reading` / `games` / `history` subtrees that
 * must survive untouched so a rollback to v3 stays possible.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate, needsMigration } from "../src/data/migrate";
import { SCHEMA_VERSION, type TitleV4 } from "../src/types";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/data-v3.json", import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

function loadFixture(): Record<string, unknown> {
  return JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
}

function byId(titles: TitleV4[], id: string): TitleV4 {
  const found = titles.find((t) => t.id === id);
  if (!found) throw new Error(`fixture is missing title ${id}`);
  return found;
}

describe("needsMigration", () => {
  it("flags a v3 file and a garbage file, but not a v4 file", () => {
    expect(needsMigration(loadFixture())).toBe(true);
    expect(needsMigration(null)).toBe(true);
    expect(needsMigration({ schemaVersion: SCHEMA_VERSION })).toBe(false);
  });
});

describe("migrate — verbatim round-trip of keys v4 does not own", () => {
  const original = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
  const { data } = migrate(loadFixture());
  const out = data as unknown as Record<string, unknown>;

  // `reading` and `games` left this list in Wave 8: v4 now *owns* them, so they
  // are normalised in place like titles rather than passed through untouched.
  // What must still hold — that nothing of the user's is lost — is asserted in
  // `reading-games.test.ts`, key by key and including keys v4 has never heard of.
  it.each(["airtime", "recommendedDaily", "posterRetryDone", "migratedReadingHistory"])(
    "preserves top-level %s byte-identically",
    (key) => {
      expect(JSON.stringify(out[key])).toBe(JSON.stringify(original[key]));
    },
  );

  it("preserves the activity log byte-identically", () => {
    expect(JSON.stringify(out.history)).toBe(JSON.stringify(original.history));
  });

  it.each([
    "omdbApiKey",
    "colorTheme",
    "activeApi",
    "animeApiSource",
    "gamesApiSource",
    "typeApiMapping",
    "listFilters",
    "gamesFilters",
    "rowsLayout",
    "seasonPalette",
    "readingTypeColors",
    "cardTextStyles",
    "customListsFolder",
    "draftsVaultTag",
    "episodeNumbering",
  ])("preserves settings.%s byte-identically", (key) => {
    const before = (original.settings as Record<string, unknown>)[key];
    const after = (out.settings as Record<string, unknown>)[key];
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("preserves unknown per-title keys", () => {
    const dexter = byId(data.titles, "dexter-resurrection") as unknown as Record<string, unknown>;
    expect(dexter.lastInteracted).toBe("2026-08-03T13:53:36.526Z");
    expect(dexter.anilistId).toBeUndefined(); // absent in the fixture, not invented
  });

  it("hands back the same object it was given, so nothing can be dropped", () => {
    const input = loadFixture();
    const result = migrate(input);
    expect(result.data as unknown).toBe(input);
  });
});

describe("migrate — schema version and report", () => {
  it("stamps schemaVersion 4 and reports the upgrade", () => {
    const { data, report } = migrate(loadFixture());
    expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.fromVersion).toBe(0);
    expect(report.toVersion).toBe(SCHEMA_VERSION);
    expect(report.changed).toBe(true);
    expect(report.reset).toBe(false);
    expect(report.titlesMigrated).toBe(3);
  });

  it("is idempotent — migrating twice changes nothing further", () => {
    const once = migrate(loadFixture()).data;
    const first = JSON.stringify(once);
    const twice = migrate(JSON.parse(first) as unknown).data;
    expect(JSON.stringify(twice)).toBe(first);
  });

  it("falls back to defaults when the file is not a Watch, Read and Learn file", () => {
    const { data, report } = migrate({ hello: "world" });
    expect(report.reset).toBe(true);
    expect(data.titles).toEqual([]);
    expect(data.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("produces defaults for a fresh install without claiming a reset", () => {
    const { data, report } = migrate(null);
    expect(report.reset).toBe(false);
    expect(data.settings.rootFolder).toBe("Watch Read Learn");
  });
});

describe("migrate — sentinel cleanup", () => {
  const { data } = migrate(loadFixture());

  it('turns trailerUrl "none" into an empty string plus a fetchFailed flag', () => {
    const odyssey = byId(data.titles, "the-odyssey");
    expect(odyssey.trailerUrl).toBe("");
    expect(odyssey.fetchFailed?.trailer).toBe(true);
  });

  it('turns posterUrl "none" into an empty string plus a fetchFailed flag', () => {
    const spidey = byId(data.titles, "spider-man-brand-new-day");
    expect(spidey.posterUrl).toBe("");
    expect(spidey.fetchFailed?.poster).toBe(true);
  });

  it("keeps a real poster URL untouched", () => {
    expect(byId(data.titles, "the-odyssey").posterUrl).toContain("media-amazon.com");
  });

  it('turns studio ["none"] into an empty array', () => {
    for (const title of data.titles) {
      expect(title.studio).toEqual([]);
      expect(title.fetchFailed?.credits).toBe(true);
    }
  });

  it("never leaves the string 'none' anywhere in a title", () => {
    const serialised = JSON.stringify(data.titles);
    expect(serialised).not.toContain('"none"');
  });

  it("keeps genuine credits", () => {
    expect(byId(data.titles, "the-odyssey").director).toEqual(["Christopher Nolan"]);
    expect(byId(data.titles, "the-odyssey").cast).toHaveLength(3);
  });
});

describe("migrate — title normalisation", () => {
  const { data } = migrate(loadFixture());

  it("gives every title a tags array", () => {
    for (const title of data.titles) expect(title.tags).toEqual([]);
  });

  it("backfills the missing skippedEpisodes array on a season", () => {
    const dexter = byId(data.titles, "dexter-resurrection");
    expect(dexter.seasons[0]?.skippedEpisodes).toEqual([]);
    expect(dexter.seasons[1]?.skippedEpisodes).toEqual([3, 5, 6, 7]);
  });

  it("infers tmdbMediaType from the title type instead of always saying movie", () => {
    expect(byId(data.titles, "dexter-resurrection").tmdbMediaType).toBe("tv");
  });

  it("derives the release year", () => {
    expect(byId(data.titles, "the-odyssey").year).toBe(2026);
    expect(byId(data.titles, "dexter-resurrection").year).toBe(2025);
  });

  it("backfills manual credit arrays that v3 omitted", () => {
    const dexter = byId(data.titles, "dexter-resurrection");
    expect(dexter.manualCast).toEqual([]);
    expect(dexter.manualDirector).toEqual([]);
    expect(dexter.manualPosterUrl).toBe("");
  });

  it("keeps dateFavorited on a favourite and drops it otherwise", () => {
    expect(byId(data.titles, "dexter-resurrection").dateFavorited).toBe("2026-08-03T13:55:00.000Z");
    expect(byId(data.titles, "the-odyssey").dateFavorited).toBeUndefined();
  });

  /** report-watchlog.md §5 item 2 — this state was representable in v3. */
  it("removes skipped, duplicate and out-of-range episodes from watchedEpisodes", () => {
    const dexter = byId(data.titles, "dexter-resurrection");
    // fixture had [10,1..9,13,15,99,3]; 13 and 15 are skipped, 99 is out of range.
    expect(dexter.watchedEpisodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("migrate — settings", () => {
  const { data } = migrate(loadFixture());
  const settings = data.settings;

  it("re-inserts the To be released status the fixture is missing", () => {
    expect(settings.statuses.map((s) => s.name)).toContain("To be released");
  });

  it("renames the fixture's Completed status, and the title standing on it", () => {
    // The fixture IS a pre-rename vault — that is what makes it the right place
    // to assert this. The rename's own edge cases live in
    // `watched-status-rename.test.ts`.
    expect(settings.statuses.map((s) => s.name)).toContain("Watched");
    expect(settings.statuses.map((s) => s.name)).not.toContain("Completed");
    expect(data.titles.filter((t) => t.status === "Watched")).toHaveLength(1);
    expect(data.titles.filter((t) => t.status === "Completed")).toEqual([]);
  });

  it("recolours the legacy grey Plan to watch", () => {
    const status = settings.statuses.find((s) => s.name === "Plan to watch");
    expect(status?.color).toBe("#00A9A5");
  });

  it("adds the v4 integration keys, empty", () => {
    expect(settings.overseerrUrl).toBe("");
    expect(settings.overseerrApiKey).toBe("");
    expect(settings.plexUrl).toBe("");
    expect(settings.plexMachineId).toBe("");
  });

  it("refuses to carry a v3 TMDB key over as a v4 read token", () => {
    expect(settings.tmdbToken).toBe("");
  });

  it("carries the v3 sort and exclusions into the v4 view state", () => {
    expect(settings.sort).toEqual({ key: "rating", direction: "asc" });
    expect(settings.filterState.excludedTypes).toEqual(["Anime"]);
    expect(settings.filterState.excludedStatuses).toEqual([]);
    expect(settings.filterState.minRating).toBe(0);
  });

  it("adds the v4 defaults", () => {
    expect(settings.generateNotes).toBe(true);
    expect(settings.trailerMode).toBe("embed");
    expect(settings.savedPresets).toEqual([]);
    expect(settings.secondarySort).toBeNull();
    expect(settings.libraryViewMode).toBe("grid");
  });

  it("keeps a well-formed rating system untouched", () => {
    expect(settings.ratingSystem).toHaveLength(5);
    expect(settings.ratingSystem[0]?.label).toBe("Poor");
  });

  it("resets a malformed rating system wholesale", () => {
    const raw = loadFixture();
    (raw.settings as Record<string, unknown>).ratingSystem = [{ label: "Only one" }];
    const { data: fixed, report } = migrate(raw);
    expect(fixed.settings.ratingSystem).toHaveLength(5);
    expect(report.notes.join(" ")).toContain("rating system");
  });
});

describe("migrate — resilience", () => {
  it("survives titles that are not objects", () => {
    const raw = loadFixture();
    (raw.titles as unknown[]).push(null, 42, "nope");
    const { data, report } = migrate(raw);
    expect(data.titles).toHaveLength(3);
    expect(report.notes.join(" ")).toContain("not an object");
  });

  it("de-duplicates colliding ids", () => {
    const raw = loadFixture();
    const titles = raw.titles as Record<string, unknown>[];
    titles.push({ ...titles[0] });
    const { data } = migrate(raw);
    const ids = data.titles.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("the-odyssey-2");
  });

  it("repairs a title with no seasons at all", () => {
    const raw = loadFixture();
    const titles = raw.titles as Record<string, unknown>[];
    delete titles[0]!.seasons;
    const { data } = migrate(raw);
    const odyssey = byId(data.titles, "the-odyssey");
    expect(odyssey.seasons).toHaveLength(1);
    expect(odyssey.seasons[0]?.name).toBe("Movie");
    expect(odyssey.seasons[0]?.episodes).toBe(1);
  });
});
