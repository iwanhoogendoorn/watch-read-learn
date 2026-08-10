/**
 * The parity domains' migration (SPEC2-PARITY.md, W8-contract).
 *
 * `data.reading` and `data.games` have been sitting in the user's `data.json`
 * untouched since v4 shipped — v4 simply had no code that read them. Wave 8
 * adopts them, and adoption is the dangerous moment: the instant a version
 * starts *writing* a structure it previously only carried, every field it does
 * not know about is one careless object literal away from being deleted.
 *
 * So these tests are mostly about what must **not** change. The fixture is a v3
 * file with populated books, manga and games, each carrying fields no version of
 * v4 has ever heard of (`shelfLocation`, `lentTo`, `physicalCopies`,
 * `howLongToBeat`, `modsInstalled`, …) plus unknown keys on every settings
 * object. All of it has to come out the other side.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/data/migrate";
import { createGamesData, createReadingData } from "../src/data/schema";
import { READING_STATUSES, type Book, type Game, type Manga } from "../src/types";

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/data-v3-parity.json",
);
const TEXT = readFileSync(FIXTURE, "utf8");

function load(): Record<string, unknown> {
  return JSON.parse(TEXT) as Record<string, unknown>;
}

function migrated() {
  const { data } = migrate(load());
  return data;
}

/** The raw record, for reading keys TypeScript does not know about. */
function rec(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Nothing of the user's is lost
// ---------------------------------------------------------------------------

describe("unknown fields survive adoption", () => {
  it("keeps per-book fields v4 has never heard of", () => {
    const book = rec(migrated().reading?.books[0]);
    expect(book.shelfLocation).toBe("top shelf, left");
    expect(book.lentTo).toBe("Marta");
  });

  it("keeps per-manga and per-game unknown fields", () => {
    const data = migrated();
    expect(rec(data.reading?.manga[0]).physicalCopies).toBe(12);
    const game = rec(data.games?.games[0]);
    expect(game.howLongToBeat).toBe(96);
    expect(game.modsInstalled).toEqual(["Hell Mode"]);
  });

  it("keeps unknown keys on every settings object, and on the domains themselves", () => {
    const data = migrated();
    expect(rec(data.reading?.settings).readingViewDensity).toBe("cosy");
    expect(rec(data.games?.settings).gamesGridDensity).toBe("compact");
    // Not just inside settings — on the domain object itself.
    expect(rec(data.reading).legacyImportedFrom).toBe("goodreads-2019");
    expect(rec(data.drafts).scannerVersion).toBe(2);
  });

  it("keeps v3's single unnamed reading preset while adding the named list", () => {
    const settings = migrated().reading?.settings;
    // The v3 value is carried verbatim; the v4 list starts empty beside it.
    expect(settings?.savedFilterPreset).toEqual({ statusExclude: ["Dropped"], sort: "title" });
    expect(settings?.savedPresets).toEqual([]);
  });

  it("keeps the games recommendation cache it does not interpret", () => {
    expect(migrated().games?.recommendedDaily).toEqual({ date: "2024-11-02", gameId: "hades" });
  });

  it("carries v3 settings the parity build now owns", () => {
    const settings = migrated().settings;
    expect(settings.googleBooksApiKey).toBe("carried-over-books-key");
    expect(settings.draftsVaultTag).toBe("#toread");
    expect(settings.customListsFolder).toBe("Lists");
    expect(settings.typeApiMapping).toEqual({ Anime: "anime", Docu: "" });
    expect(settings.animeApiSource).toBe("jikan");
    // RAWG is out of scope, so its key is not read — but it is not dropped either.
    expect(rec(settings).rawgApiKey).toBe("dead-key-but-kept");
  });

  it("is idempotent — migrating twice changes nothing further", () => {
    const once = migrate(load()).data;
    const twice = migrate(JSON.parse(JSON.stringify(once)) as unknown).data;
    expect(JSON.stringify(twice.reading)).toBe(JSON.stringify(once.reading));
    expect(JSON.stringify(twice.games)).toBe(JSON.stringify(once.games));
    expect(JSON.stringify(twice.drafts)).toBe(JSON.stringify(once.drafts));
  });
});

// ---------------------------------------------------------------------------
// Missing fields are filled in
// ---------------------------------------------------------------------------

describe("half-written rows are completed, not rejected", () => {
  it("gives a book every field the contract promises", () => {
    const book = migrated().reading?.books[1] as Book;
    expect(book.id).toBe("half-filled");
    expect(book.author).toBe("");
    expect(book.favorite).toBe(false);
    expect(book.rating).toBe(0);
    expect(book.pagesRead).toBe(0);
    expect(book.totalPages).toBe(0);
    expect(book.customFields).toEqual({});
    expect(book.dateStarted).toBeNull();
    // Its own values are untouched.
    expect(book.progressUnit).toBe("words");
    expect(book.wordsRead).toBe(12500);
    // Dates are invented only where absent, and always as timestamps.
    expect(Number.isFinite(Date.parse(book.dateAdded))).toBe(true);
    expect(book.dateModified).toBe(book.dateAdded);
  });

  it("gives a game every field the contract promises", () => {
    const game = migrated().games?.games[1] as Game;
    expect(game.id).toBe("silksong");
    expect(game.platforms).toEqual([]);
    expect(game.playtimeMinutes).toBe(0);
    expect(game.achievementsTotal).toBe(0);
    expect(game.apiSource).toBe("");
    expect(game.lastPlayed).toBeNull();
    expect(game.releaseDate).toBe("2026-12-01");
  });

  it("fills a partial statusColors map without overwriting what is there", () => {
    const colors = migrated().reading?.settings.statusColors;
    expect(colors?.Reading).toBe("#123456"); // the user's
    expect(colors?.Dropped).toBe("#E24B4A"); // back-filled
    for (const status of READING_STATUSES) expect(colors?.[status]).toMatch(/^#/);
  });

  it("leaves a games settings list the user trimmed exactly as trimmed", () => {
    const settings = migrated().games?.settings;
    expect(settings?.statuses.map((s) => s.name)).toEqual(["Playing", "Not started", "Finished"]);
    expect(settings?.types.map((t) => t.name)).toEqual(["RPG"]);
  });
});

// ---------------------------------------------------------------------------
// v3 quirks
// ---------------------------------------------------------------------------

describe("the v3 quirks the shapes carry", () => {
  it("keeps a manga's MAL id a string, even when v3 wrote a number", () => {
    const manga = migrated().reading?.manga[0] as Manga;
    expect(manga.malId).toBe("2");
    expect(typeof manga.malId).toBe("string");
  });

  it("turns the legacy Wishlist *status* into the boolean flag", () => {
    const game = migrated().games?.games[1] as Game;
    expect(game.wishlist).toBe(true);
    expect(game.status).toBe("Not started");
  });

  it("clears the v3 'none' sentinel from a cover url", () => {
    expect((migrated().reading?.manga[0] as Manga).coverUrl).toBe("");
  });

  it("coerces a reading status outside the fixed five", () => {
    const raw = load();
    (rec(rec(raw.reading).books)[0] as unknown as Record<string, unknown>).status = "Abandoned";
    const { data } = migrate(raw);
    expect(data.reading?.books[0]?.status).toBe("Plan to Read");
  });

  it("repairs a custom column whose type is not one of the three", () => {
    const columns = migrated().reading?.bookColumns;
    expect(columns?.[0]?.type).toBe("select");
    expect(columns?.[0]?.options).toEqual(["Sci-Fi", "Crime"]);
    expect(columns?.[1]?.type).toBe("text"); // was "weird-type"
    expect(columns?.[1]?.options).toEqual([]);
  });

  it("normalises ids that arrived as numbers", () => {
    const game = migrated().games?.games[0] as Game;
    expect(game.apiId).toBe("113112");
    expect(game.steamAppId).toBe("1145360");
  });
});

// ---------------------------------------------------------------------------
// Absent, empty and hostile
// ---------------------------------------------------------------------------

describe("a file with no parity data at all", () => {
  it("creates both domains from defaults", () => {
    const { data } = migrate({ schemaVersion: 3, titles: [], settings: {} });
    expect(data.reading).toEqual(createReadingData());
    expect(data.games).toEqual(createGamesData());
    // Drafts stay absent until the scanner has something to say.
    expect(data.drafts).toBeUndefined();
  });

  it("replaces a domain that is not an object, and says so", () => {
    const { data, report } = migrate({
      schemaVersion: 3,
      titles: [],
      settings: {},
      reading: "corrupt",
      games: 42,
    });
    expect(data.reading?.books).toEqual([]);
    expect(data.games?.games).toEqual([]);
    expect(report.notes.join(" ")).toContain("data.reading was not an object");
    expect(report.notes.join(" ")).toContain("data.games was not an object");
  });

  it("drops a non-object row and keeps the rest", () => {
    const { data, report } = migrate({
      schemaVersion: 3,
      titles: [],
      settings: {},
      reading: { books: ["nonsense", { id: "ok", title: "Fine" }], manga: [] },
    });
    expect(data.reading?.books).toHaveLength(1);
    expect(data.reading?.books[0]?.title).toBe("Fine");
    expect(report.notes.join(" ")).toContain("dropped a reading entry");
  });
});
