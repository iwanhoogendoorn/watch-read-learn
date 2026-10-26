/**
 * `/search`, `/lookup` and `/items` — the cross-domain reads of the local API.
 *
 * The routes are called directly against a real `WatchLogStore` and reading
 * store, loaded from a small fixture through a mocked `loadData`, so the
 * classification (film / show / book / audiobook) and every id match runs on
 * the same objects the plugin holds. `saveData` records every call: none of
 * these routes may write, and the last block says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchLogStore } from "../src/data/store";
import { createReadingStore, type ReadingStore } from "../src/domains/reading/store";
import { createBook, createDefaultData, createReadingData, createTitle } from "../src/data/schema";
import { searchRoutes } from "../src/api/routes/search";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseDateField,
  parseDateRange,
  parseKinds,
  parseLimit,
  parsePlexGuid,
} from "../src/api/query";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse } from "../src/api/types";
import { installDomGlobals } from "./helpers/dom";
import type { TitleV4, WatchLogData } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals();
});

afterEach(() => {
  restore();
});

function fixture(): WatchLogData {
  const data = createDefaultData();
  data.titles = [
    createTitle({
      id: "the-matrix",
      title: "The Matrix",
      type: "Movie",
      tmdbMediaType: "movie",
      tmdbId: 603,
      imdbId: "tt0133093",
      status: "Watched",
      rating: 5,
      year: 1999,
      dateFinished: "2026-01-10",
      dateAdded: "2025-12-01T12:00:00.000Z",
      dateModified: "2026-01-10T12:00:00.000Z",
      plex: { state: "available", ratingKey: "1001" },
    }),
    createTitle({
      id: "the-matrix-reloaded",
      title: "The Matrix Reloaded",
      type: "Movie",
      tmdbMediaType: "movie",
      tmdbId: 604,
      status: "Watched",
      dateFinished: "2026-02-01",
      dateAdded: "2026-01-20T12:00:00.000Z",
      dateModified: "2026-02-01T12:00:00.000Z",
    }),
    createTitle({
      id: "breaking-bad",
      title: "Breaking Bad",
      type: "TV Show",
      tmdbMediaType: "tv",
      tmdbId: 1396,
      tvdbId: 81189,
      imdbId: "tt0903747",
      status: "Watching",
      totalEpisodes: 62,
      dateStarted: "2026-01-05",
      dateAdded: "2026-01-04T12:00:00.000Z",
      dateModified: "2026-01-05T12:00:00.000Z",
      plex: { state: "partial", ratingKey: "2002" },
    }),
    createTitle({
      id: "cowboy-bebop",
      title: "Cowboy Bebop",
      type: "Anime",
      totalEpisodes: 26,
      status: "Watched",
      dateStarted: "2025-12-20",
      dateFinished: "2026-01-31",
      dateAdded: "2025-12-19T12:00:00.000Z",
      dateModified: "2026-01-31T12:00:00.000Z",
    }),
  ];
  const reading = createReadingData();
  const dune = createBook({
    id: "dune",
    title: "Dune",
    author: "Frank Herbert",
    status: "Completed",
    rating: 4,
    googleBooksId: "B1dune",
    dateFinished: "2026-01-15",
    dateAdded: "2025-11-01T12:00:00.000Z",
    dateModified: "2026-01-15T12:00:00.000Z",
  });
  (dune as unknown as Record<string, unknown>).openLibraryKey = "/works/OL893414W";
  const hailMary = createBook({
    id: "project-hail-mary",
    title: "Project Hail Mary",
    status: "Reading",
    dateStarted: "2026-01-20",
    dateAdded: "2026-01-19T12:00:00.000Z",
    dateModified: "2026-01-20T12:00:00.000Z",
  });
  Object.assign(hailMary, { format: "audiobook", openLibraryKey: "/works/OL21745884W", listenedMinutes: 120 });
  reading.books = [dune, hailMary];
  data.reading = reading;
  return data;
}

interface Harness {
  deps: ApiDeps;
  store: WatchLogStore;
  reading: ReadingStore;
  saved: unknown[];
}

async function harness(data: WatchLogData = fixture()): Promise<Harness> {
  const saved: unknown[] = [];
  const text = JSON.stringify(data);
  const store = new WatchLogStore({
    loadData: async () => JSON.parse(text) as unknown,
    saveData: async (value: unknown) => {
      saved.push(value);
    },
  } as never);
  await store.load();
  const reading = createReadingStore(store);
  const deps: ApiDeps = {
    store,
    reading,
    version: "test",
    revision: () => 0,
    now: () => new Date("2026-03-01T12:00:00.000Z"),
  };
  return { deps, store, reading, saved };
}

function request(path: string, query: Record<string, string> = {}, method = "GET"): ApiRequest {
  return { method, path, query, body: undefined, remote: false };
}

async function call(h: Harness, path: string, query: Record<string, string> = {}, method = "GET"): Promise<ApiResponse> {
  const res = await searchRoutes(request(path, query, method), h.deps);
  if (!res) throw new Error(`no route for ${path}`);
  return res;
}

/** The ApiError a call throws, for asserting status and message. */
async function failure(h: Harness, path: string, query: Record<string, string> = {}, method = "GET"): Promise<ApiError> {
  try {
    await searchRoutes(request(path, query, method), h.deps);
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error(`expected ${method} ${path} to fail`);
}

type Summary = { kind: string; id: string; title: string; status: string; ids: Record<string, unknown> };

function idsOf(body: unknown, key: "matches" | "items" | "results"): string[] {
  return ((body as Record<string, Summary[]>)[key] ?? []).map((item) => item.id);
}

// ---------------------------------------------------------------------------

describe("routing", () => {
  it("ignores paths that are not its own", async () => {
    const h = await harness();
    expect(await searchRoutes(request("/films"), h.deps)).toBeUndefined();
    expect(await searchRoutes(request("/health"), h.deps)).toBeUndefined();
  });

  it("refuses non-GET methods with 405", async () => {
    const h = await harness();
    expect((await failure(h, "/items", {}, "POST")).status).toBe(405);
    expect((await failure(h, "/lookup", { tmdb: "603" }, "DELETE")).status).toBe(405);
  });
});

describe("GET /lookup", () => {
  it("finds a film by tmdb, imdb and plexRatingKey", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/lookup", { tmdb: "603" })).body, "matches")).toEqual(["the-matrix"]);
    expect(idsOf((await call(h, "/lookup", { imdb: "tt0133093" })).body, "matches")).toEqual(["the-matrix"]);
    expect(idsOf((await call(h, "/lookup", { plexRatingKey: "1001" })).body, "matches")).toEqual(["the-matrix"]);
  });

  it("finds a show by tvdb", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/lookup", { tvdb: "81189" })).body, "matches")).toEqual(["breaking-bad"]);
  });

  it("maps tmdb://, imdb:// and tvdb:// Plex GUIDs onto the stored ids", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/lookup", { plexGuid: "tmdb://603" })).body, "matches")).toEqual(["the-matrix"]);
    expect(idsOf((await call(h, "/lookup", { plexGuid: "imdb://tt0903747" })).body, "matches")).toEqual([
      "breaking-bad",
    ]);
    expect(idsOf((await call(h, "/lookup", { plexGuid: "tvdb://81189" })).body, "matches")).toEqual([
      "breaking-bad",
    ]);
  });

  it("finds a book and an audiobook by their Open Library work key", async () => {
    const h = await harness();
    const dune = (await call(h, "/lookup", { openLibrary: "/works/OL893414W" })).body as { matches: Summary[] };
    expect(dune.matches.map((m) => [m.id, m.kind])).toEqual([["dune", "book"]]);
    expect(dune.matches[0]?.ids.openLibrary).toBe("/works/OL893414W");
    // The bare id names the same work.
    expect(idsOf((await call(h, "/lookup", { openLibrary: "OL21745884W" })).body, "matches")).toEqual([
      "project-hail-mary",
    ]);
  });

  it("finds a book by its Google Books id", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/lookup", { googleBooks: "B1dune" })).body, "matches")).toEqual(["dune"]);
  });

  it("returns every item matching any of several ids", async () => {
    const h = await harness();
    const body = (await call(h, "/lookup", { tmdb: "603", tvdb: "81189" })).body;
    expect(idsOf(body, "matches").sort()).toEqual(["breaking-bad", "the-matrix"]);
  });

  it("answers an empty list, not a 404, for an id nobody has", async () => {
    const h = await harness();
    const res = await call(h, "/lookup", { tmdb: "999999" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [] });
  });

  it("refuses plex:// GUIDs with 400", async () => {
    const h = await harness();
    const err = await failure(h, "/lookup", { plexGuid: "plex://movie/5d776825880197001ec967c8" });
    expect(err.status).toBe(400);
    expect(err.message).toBe("plex:// GUIDs are not stored; use plexRatingKey or a tmdb/imdb/tvdb GUID");
  });

  it("refuses a lookup with no parameters, or only blank ones, with 400", async () => {
    const h = await harness();
    expect((await failure(h, "/lookup")).status).toBe(400);
    expect((await failure(h, "/lookup", { tmdb: "  " })).status).toBe(400);
  });

  it("refuses malformed ids with 400", async () => {
    const h = await harness();
    expect((await failure(h, "/lookup", { tmdb: "abc" })).status).toBe(400);
    expect((await failure(h, "/lookup", { imdb: "0133093" })).status).toBe(400);
  });
});

describe("GET /items", () => {
  it("ranges over dateFinished by default, inclusive on both ends", async () => {
    const h = await harness();
    const body = (await call(h, "/items", { from: "2026-01-10", to: "2026-01-31" })).body as {
      items: Summary[];
      total: number;
    };
    // 01-10 and 01-31 are the bounds themselves; Reloaded (02-01) is one day out.
    expect(body.items.map((i) => i.id)).toEqual(["cowboy-bebop", "dune", "the-matrix"]);
    expect(body.total).toBe(3);
  });

  it("respects dateField", async () => {
    const h = await harness();
    const started = (await call(h, "/items", { from: "2026-01-05", to: "2026-01-20", dateField: "dateStarted" }))
      .body;
    expect(idsOf(started, "items")).toEqual(["project-hail-mary", "breaking-bad"]);

    const added = (await call(h, "/items", { from: "2026-01-19", dateField: "dateAdded" })).body;
    expect(idsOf(added, "items")).toEqual(["the-matrix-reloaded", "project-hail-mary"]);
  });

  it("refuses a bad date, a backwards range and an unknown dateField with 400", async () => {
    const h = await harness();
    expect((await failure(h, "/items", { from: "2026-02-30" })).status).toBe(400);
    expect((await failure(h, "/items", { from: "26-01-01" })).status).toBe(400);
    expect((await failure(h, "/items", { from: "2026-02-01", to: "2026-01-01" })).status).toBe(400);
    expect((await failure(h, "/items", { dateField: "releaseDate" })).status).toBe(400);
  });

  it("classifies films, shows (anime included), books and audiobooks", async () => {
    const h = await harness();
    const kindOf = async (kind: string) => idsOf((await call(h, "/items", { kind })).body, "items").sort();
    expect(await kindOf("film")).toEqual(["the-matrix", "the-matrix-reloaded"]);
    expect(await kindOf("show")).toEqual(["breaking-bad", "cowboy-bebop"]);
    expect(await kindOf("book")).toEqual(["dune"]);
    expect(await kindOf("audiobook")).toEqual(["project-hail-mary"]);
    expect(await kindOf("book,audiobook")).toEqual(["dune", "project-hail-mary"]);
    expect((await failure(h, "/items", { kind: "manga" })).status).toBe(400);
  });

  it("filters by status, case-insensitively", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/items", { status: "watching" })).body, "items")).toEqual(["breaking-bad"]);
    expect(idsOf((await call(h, "/items", { status: "Watched", kind: "show" })).body, "items")).toEqual([
      "cowboy-bebop",
    ]);
    expect(idsOf((await call(h, "/items", { status: "Reading,Completed" })).body, "items").sort()).toEqual([
      "dune",
      "project-hail-mary",
    ]);
  });

  it("defaults limit to 200 and caps it at 1000", async () => {
    const data = fixture();
    for (let n = 0; n < 1100; n++) {
      data.titles.push(createTitle({ id: `film-${n}`, title: `Film ${n}`, type: "Movie", tmdbMediaType: "movie" }));
    }
    const h = await harness(data);
    const all = (await call(h, "/items")).body as { items: unknown[]; total: number };
    expect(all.items).toHaveLength(DEFAULT_LIMIT);
    expect(all.total).toBe(1106);
    const capped = (await call(h, "/items", { limit: "5000" })).body as { items: unknown[] };
    expect(capped.items).toHaveLength(MAX_LIMIT);
    const few = (await call(h, "/items", { limit: "3" })).body as { items: unknown[]; total: number };
    expect(few.items).toHaveLength(3);
    expect(few.total).toBe(1106);
  });

  it("returns the summary shape", async () => {
    const h = await harness();
    const items = ((await call(h, "/items", { kind: "film" })).body as { items: unknown[] }).items;
    expect(items).toContainEqual({
      kind: "film",
      id: "the-matrix",
      title: "The Matrix",
      year: 1999,
      status: "Watched",
      rating: 5,
      ids: { tmdb: 603, imdb: "tt0133093", tvdb: null, plexRatingKey: "1001" },
    });
  });
});

describe("GET /search", () => {
  it("matches titles case-insensitively across films, shows and books", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/search", { q: "MATRIX" })).body, "results")).toEqual([
      "the-matrix",
      "the-matrix-reloaded",
    ]);
    expect(idsOf((await call(h, "/search", { q: "hail mary" })).body, "results")).toEqual(["project-hail-mary"]);
    expect(idsOf((await call(h, "/search", { q: "bebop" })).body, "results")).toEqual(["cowboy-bebop"]);
  });

  it("puts an exact title ahead of a partial one", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/search", { q: "the matrix reloaded" })).body, "results")).toEqual([
      "the-matrix-reloaded",
    ]);
    expect(idsOf((await call(h, "/search", { q: "dune" })).body, "results")).toEqual(["dune"]);
  });

  it("honours kind and limit", async () => {
    const h = await harness();
    expect(idsOf((await call(h, "/search", { q: "a", kind: "audiobook" })).body, "results")).toEqual([
      "project-hail-mary",
    ]);
    const limited = (await call(h, "/search", { q: "matrix", limit: "1" })).body as { results: unknown[]; total: number };
    expect(limited.results).toHaveLength(1);
    expect(limited.total).toBe(2);
  });

  it("refuses an empty query with 400", async () => {
    const h = await harness();
    expect((await failure(h, "/search")).status).toBe(400);
    expect((await failure(h, "/search", { q: "   " })).status).toBe(400);
  });
});

describe("read-only", () => {
  it("never saves, flushes or mutates", async () => {
    const h = await harness();
    const save = vi.spyOn(h.store, "save");
    const flush = vi.spyOn(h.store, "flush");
    const emit = vi.spyOn(h.store, "emitChanged");
    const before = JSON.stringify(h.store.data);

    await call(h, "/search", { q: "matrix" });
    await call(h, "/lookup", { tmdb: "603", plexGuid: "tvdb://81189", openLibrary: "OL893414W", googleBooks: "B1dune" });
    await call(h, "/items", { from: "2026-01-01", to: "2026-12-31", dateField: "dateModified", limit: "5000" });
    await failure(h, "/lookup", { plexGuid: "plex://show/abc" });
    // Long enough for any debounced write to have fired.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(save).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
    expect(JSON.stringify(h.store.data)).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("query helpers", () => {
  it("parseLimit", () => {
    expect(parseLimit(undefined)).toBe(200);
    expect(parseLimit("")).toBe(200);
    expect(parseLimit("50")).toBe(50);
    expect(parseLimit("1000")).toBe(1000);
    expect(parseLimit("1001")).toBe(1000);
    expect(() => parseLimit("0")).toThrow(ApiError);
    expect(() => parseLimit("-5")).toThrow(ApiError);
    expect(() => parseLimit("ten")).toThrow(ApiError);
  });

  it("parseDateRange and parseDateField", () => {
    expect(parseDateRange({ from: "2026-01-01", to: "2026-01-01" })).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(parseDateRange({})).toEqual({ from: undefined, to: undefined });
    expect(() => parseDateRange({ to: "2026-13-01" })).toThrow(ApiError);
    expect(parseDateField(undefined)).toBe("dateFinished");
    expect(parseDateField("dateadded")).toBe("dateAdded");
  });

  it("parseKinds", () => {
    expect(parseKinds(undefined)).toBeUndefined();
    expect(parseKinds("Film, show,film")).toEqual(["film", "show"]);
    expect(() => parseKinds("game")).toThrow(ApiError);
  });

  it("parsePlexGuid", () => {
    expect(parsePlexGuid("tmdb://123")).toEqual({ source: "tmdb", id: 123 });
    expect(parsePlexGuid("imdb://tt123")).toEqual({ source: "imdb", id: "tt123" });
    expect(parsePlexGuid("tvdb://456")).toEqual({ source: "tvdb", id: 456 });
    expect(() => parsePlexGuid("plex://movie/abc")).toThrow(
      "plex:// GUIDs are not stored; use plexRatingKey or a tmdb/imdb/tvdb GUID",
    );
    for (const bad of ["tmdb://abc", "imdb://123", "tvdb://", "local://1", "123"]) {
      expect(() => parsePlexGuid(bad), bad).toThrow(ApiError);
    }
  });
});

// A title the fixture builds must still classify after migration; pins that
// `createTitle` + `load()` keep the fields the routes read.
describe("fixture sanity", () => {
  it("keeps ids, plex keys and book extras through load", async () => {
    const h = await harness();
    const matrix = h.store.getTitle("the-matrix") as TitleV4;
    expect(matrix.tmdbId).toBe(603);
    expect(matrix.plex?.ratingKey).toBe("1001");
    const hailMary = h.reading.getBook("project-hail-mary") as unknown as Record<string, unknown>;
    expect(hailMary.format).toBe("audiobook");
  });
});
