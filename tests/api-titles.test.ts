/**
 * `/films` and `/shows`, driven against a real `WatchLogStore`.
 *
 * Only `loadData`/`saveData` are faked, so everything between the route and
 * the disk — migration, the episode sanitiser, the air-date guard,
 * auto-complete, the write chain — is the code that runs in Obsidian. What
 * reaches `saveData` is captured as JSON, which is the only honest way to say
 * "the unknown keys survived".
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { titleRoutes } from "../src/api/routes/titles";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse } from "../src/api/types";
import { WatchLogStore } from "../src/data/store";
import { watchedPatch } from "../src/data/watched";
import type { TitleV4 } from "../src/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

beforeEach(() => {
  // The store dispatches its change event on a document.
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined },
  });
  if (typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !== "function") {
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class {
        constructor(
          public type: string,
          public init?: unknown,
        ) {}
      },
    });
  }
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
});

const NOW = new Date(2026, 9, 26, 22, 30);

/** The parity fixture plus a film and a show, each carrying keys v4 never declared. */
function rawData(): Record<string, unknown> {
  const raw = JSON.parse(
    readFileSync(new URL("./fixtures/data-v3-parity.json", import.meta.url), "utf8"),
  ) as { titles: unknown[] } & Record<string, unknown>;
  raw.titles.push(
    {
      id: "arrival",
      title: "Arrival",
      type: "Movie",
      status: "Plan to watch",
      totalEpisodes: 1,
      watchedEpisodes: [],
      tmdbId: 329865,
      tmdbMediaType: "movie",
      someoneElsesKey: { kept: true },
    },
    {
      id: "the-wire",
      title: "The Wire",
      type: "TV Show",
      status: "Watching",
      totalEpisodes: 9,
      dateStarted: "2026-09-01",
      seasons: [
        { name: "Season 1", episodes: 3, offset: 0, skippedEpisodes: [2], seasonNumber: 1 },
        { name: "Season 2", episodes: 4, offset: 3, skippedEpisodes: [], seasonNumber: 2 },
        { name: "Season 3", episodes: 2, offset: 7, skippedEpisodes: [], seasonNumber: 3, airDate: "2099-01-01" },
      ],
      watchedEpisodes: [1],
      showOnlyExtra: [1, 2, 3],
    },
  );
  return raw;
}

interface Harness {
  store: WatchLogStore;
  deps: ApiDeps;
  /** Every `saveData` payload, as the JSON that would have hit the disk. */
  saves: Record<string, unknown>[];
  lastSave(): Record<string, unknown>;
  call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<ApiResponse>;
  plugin: { loadData: () => Promise<unknown>; saveData: (data: unknown) => Promise<void> };
}

async function harness(options: { saveDelayMs?: number } = {}): Promise<Harness> {
  const saves: Record<string, unknown>[] = [];
  const plugin = {
    loadData: vi.fn(async () => rawData()),
    saveData: vi.fn(async (data: unknown) => {
      if (options.saveDelayMs) await new Promise((resolve) => setTimeout(resolve, options.saveDelayMs));
      saves.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
    }),
  };
  const store = new WatchLogStore(plugin as never);
  await store.load();
  const deps: ApiDeps = {
    store,
    reading: {} as never,
    version: "test",
    revision: () => 0,
    now: () => NOW,
  };
  const call = async (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
    const res = await titleRoutes({ method, path, query, body, remote: false } satisfies ApiRequest, deps);
    if (!res) throw new Error(`no route for ${method} ${path}`);
    return res;
  };
  const lastSave = () => {
    const last = saves[saves.length - 1];
    if (!last) throw new Error("nothing was saved");
    return last;
  };
  return { store, deps, saves, lastSave, call, plugin };
}

/** The error a handler threw, for asserting status codes. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the handler to throw an ApiError");
}

function savedTitle(saved: Record<string, unknown>, id: string): Record<string, unknown> {
  const found = (saved.titles as Record<string, unknown>[]).find((t) => t.id === id);
  if (!found) throw new Error(`title ${id} not in saved data`);
  return found;
}

function without(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// Routing and classification
// ---------------------------------------------------------------------------

describe("titleRoutes: routing", () => {
  it("ignores paths that are not its own", async () => {
    const h = await harness();
    expect(await titleRoutes({ method: "GET", path: "/books", query: {}, body: undefined, remote: false }, h.deps)).toBeUndefined();
  });

  it("splits films from shows with isSingleSitting", async () => {
    const h = await harness();
    const films = (await h.call("GET", "/films")).body as { items: { id: string; kind: string }[] };
    const shows = (await h.call("GET", "/shows")).body as { items: { id: string; kind: string }[] };
    expect(films.items.map((t) => t.id)).toEqual(["arrival"]);
    expect(shows.items.map((t) => t.id).sort()).toEqual(["dexter", "the-wire"]);
    expect(films.items.every((t) => t.kind === "film")).toBe(true);
    expect(shows.items.every((t) => t.kind === "show")).toBe(true);
  });

  it("classes a one-episode anime with no TMDB type as a film, and a multi-episode one as a show", async () => {
    const h = await harness();
    const one = await h.call("POST", "/films", { title: "Your Name", type: "Anime" });
    expect((one.body as { kind: string }).kind).toBe("film");
    const many = await h.call("POST", "/shows", { title: "Frieren", type: "Anime", totalEpisodes: 28 });
    expect((many.body as { kind: string }).kind).toBe("show");
  });

  it("answers 404 for an unknown id, and for a show asked for as a film", async () => {
    const h = await harness();
    expect((await failure(h.call("GET", "/films/nope"))).status).toBe(404);
    expect((await failure(h.call("GET", "/films/the-wire"))).status).toBe(404);
    expect((await failure(h.call("POST", "/shows/nope/watched", {}))).status).toBe(404);
    expect((await failure(h.call("GET", "/shows/the-wire/nonsense"))).status).toBe(404);
  });

  it("filters lists by status and honours limit", async () => {
    const h = await harness();
    const watching = (await h.call("GET", "/shows", undefined, { status: "watching" })).body as {
      total: number;
      items: { id: string }[];
    };
    expect(watching.items.map((t) => t.id)).toEqual(["the-wire"]);
    const one = (await h.call("GET", "/shows", undefined, { limit: "1" })).body as { total: number; items: unknown[] };
    expect(one.total).toBe(2);
    expect(one.items).toHaveLength(1);
    expect((await failure(h.call("GET", "/shows", undefined, { limit: "1001" }))).status).toBe(400);
    expect((await failure(h.call("GET", "/shows", undefined, { limit: "0" }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe("titleRoutes: CRUD round-trip", () => {
  it("creates, reads, patches and deletes a film", async () => {
    const h = await harness();
    const made = await h.call("POST", "/films", {
      title: "Arrival",
      ids: { tmdb: 1, imdb: "tt2543164" },
      tags: ["sci-fi", " sci-fi ", "cosy"],
    });
    expect(made.status).toBe(201);
    const created = made.body as { id: string; kind: string; type: string; status: string; tags: string[]; ids: Record<string, unknown> };
    // Same slug rules as the Add modal: "arrival" is taken.
    expect(created.id).toBe("arrival-2");
    expect(created.kind).toBe("film");
    expect(created.type).toBe("Movie");
    expect(created.status).toBe("Plan to watch");
    expect(created.tags).toEqual(["sci-fi", "cosy"]);
    expect(created.ids).toMatchObject({ tmdb: 1, tmdbMediaType: "movie", imdb: "tt2543164" });
    expect(savedTitle(h.lastSave(), "arrival-2").title).toBe("Arrival");

    const read = await h.call("GET", "/films/arrival-2");
    expect(read.body).toEqual(created);

    const patched = await h.call("PATCH", "/films/arrival-2", {
      status: "Watched",
      notes: "Rewatch with subtitles",
      dates: { finished: "2026-10-20" },
    });
    expect(patched.body).toMatchObject({
      status: "Watched",
      notes: "Rewatch with subtitles",
      dates: { finished: "2026-10-20", started: null },
    });

    const cleared = await h.call("PATCH", "/films/arrival-2", { notes: null, dates: { finished: null }, ids: { imdb: null } });
    expect(cleared.body).toMatchObject({ notes: "", dates: { finished: null }, ids: { imdb: null, tmdb: 1 } });

    const gone = await h.call("DELETE", "/films/arrival-2");
    expect(gone.body).toEqual({ id: "arrival-2", deleted: true });
    expect((h.lastSave().titles as { id: string }[]).some((t) => t.id === "arrival-2")).toBe(false);
    expect((await failure(h.call("GET", "/films/arrival-2"))).status).toBe(404);
  });

  it("creates, reads, patches and deletes a show with seasons", async () => {
    const h = await harness();
    const made = await h.call("POST", "/shows", {
      title: "Slow Horses",
      status: "Watching",
      seasons: [{ episodes: 6 }, { episodes: 6, skippedEpisodes: [3, 3] }],
    });
    expect(made.status).toBe(201);
    const body = made.body as {
      id: string;
      kind: string;
      type: string;
      progress: { totalEpisodes: number; effectiveTotal: number; seasons: { seasonNumber: number; name: string }[] };
    };
    expect(body).toMatchObject({ id: "slow-horses", kind: "show", type: "TV Show" });
    expect(body.progress.totalEpisodes).toBe(12);
    expect(body.progress.effectiveTotal).toBe(11);
    expect(body.progress.seasons.map((s) => [s.seasonNumber, s.name])).toEqual([
      [1, "Season 1"],
      [2, "Season 2"],
    ]);
    const saved = savedTitle(h.lastSave(), "slow-horses");
    expect((saved.seasons as { offset: number }[]).map((s) => s.offset)).toEqual([0, 6]);

    const patched = await h.call("PATCH", "/shows/slow-horses", { favorite: true, tags: ["spy"] });
    expect(patched.body).toMatchObject({ favorite: true, tags: ["spy"] });
    expect(savedTitle(h.lastSave(), "slow-horses").dateFavorited).toBe(NOW.toISOString());

    await h.call("DELETE", "/shows/slow-horses");
    expect((await failure(h.call("GET", "/shows/slow-horses"))).status).toBe(404);
  });

  it("refuses a show with one episode and nothing else saying it is a series", async () => {
    const h = await harness();
    expect((await failure(h.call("POST", "/shows", { title: "Pilot", totalEpisodes: 1 }))).status).toBe(400);
    expect((await failure(h.call("POST", "/films", {}))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH preservation and validation
// ---------------------------------------------------------------------------

describe("titleRoutes: PATCH", () => {
  it("leaves every untouched part of data.json exactly as it was", async () => {
    const h = await harness();
    await h.store.flush();
    const before = h.lastSave();

    await h.call("PATCH", "/films/arrival", { rating: 4, tags: ["seen"] });
    const after = h.lastSave();

    // The root, unknown keys and all, minus the two keys a title write touches.
    expect(without(after, "titles", "history")).toEqual(without(before, "titles", "history"));
    expect(after.reading).toEqual(before.reading);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.maybe).toEqual(before.maybe);

    // Every other title, untouched to the byte.
    for (const id of ["dexter", "the-wire"]) expect(savedTitle(after, id)).toEqual(savedTitle(before, id));

    // The patched title: the patched fields, the bound review, the stamp — and nothing else.
    const was = savedTitle(before, "arrival");
    const now = savedTitle(after, "arrival");
    expect(now).toMatchObject({ rating: 4, review: "Awesome", tags: ["seen"] });
    expect(now.someoneElsesKey).toEqual({ kept: true });
    expect(without(now, "rating", "review", "tags", "dateModified")).toEqual(
      without(was, "rating", "review", "tags", "dateModified"),
    );
  });

  it("binds rating and review the way the detail surfaces do", async () => {
    const h = await harness();
    // A review alone implies its rating.
    expect((await h.call("PATCH", "/films/arrival", { review: "good" })).body).toMatchObject({ rating: 3, review: "Good" });
    // A rating alone proposes its review.
    expect((await h.call("PATCH", "/films/arrival", { rating: 5 })).body).toMatchObject({ rating: 5, review: "Marvelous" });
    // Both together are both kept, even when they disagree.
    expect((await h.call("PATCH", "/films/arrival", { rating: 2, review: "Awesome" })).body).toMatchObject({
      rating: 2,
      review: "Awesome",
    });
    // Clearing the review clears the judgement.
    expect((await h.call("PATCH", "/films/arrival", { review: null })).body).toMatchObject({ rating: 0, review: "" });
  });

  it("rejects values the settings do not allow", async () => {
    const h = await harness();
    const cases: unknown[] = [
      { status: "Binged" },
      { type: "Podcast" },
      { review: "Sublime" },
      { watchedVia: "A friend's sofa" },
      { rating: 6 },
      { rating: 3.5 },
      { rating: -1 },
      { dates: { finished: "2026-02-30" } },
      { ids: { imdb: "1234" } },
      { title: "" },
      { colour: "red" },
      { id: "renamed" },
      {},
    ];
    for (const body of cases) {
      expect((await failure(h.call("PATCH", "/films/arrival", body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("accepts half stars only when the setting allows them", async () => {
    const h = await harness();
    h.store.settings.halfStarRatings = true;
    expect((await h.call("PATCH", "/films/arrival", { rating: 3.5 })).body).toMatchObject({ rating: 3.5 });
    expect((await failure(h.call("PATCH", "/films/arrival", { rating: 3.25 }))).status).toBe(400);
  });

  it("matches list names case-insensitively and stores the configured spelling", async () => {
    const h = await harness();
    expect((await h.call("PATCH", "/films/arrival", { watchedVia: "netflix", status: "dropped" })).body).toMatchObject({
      watchedVia: "Netflix",
      status: "Dropped",
    });
  });
});

// ---------------------------------------------------------------------------
// Episodes and seasons
// ---------------------------------------------------------------------------

describe("titleRoutes: show progress", () => {
  it("reports progress per season, skipped episodes left out", async () => {
    const h = await harness();
    const res = await h.call("GET", "/shows/the-wire/progress");
    expect(res.body).toEqual({
      id: "the-wire",
      status: "Watching",
      totalEpisodes: 9,
      effectiveTotal: 8,
      watchedEpisodes: 1,
      nextEpisode: { absolute: 3, season: 1, episode: 3 },
      seasons: [
        { index: 0, name: "Season 1", seasonNumber: 1, episodes: 3, watched: 1 },
        { index: 1, name: "Season 2", seasonNumber: 2, episodes: 4, watched: 0 },
        { index: 2, name: "Season 3", seasonNumber: 3, episodes: 2, watched: 0 },
      ],
    });
  });

  it("ticks an episode by season and episode, through the season offset", async () => {
    const h = await harness();
    const res = await h.call("POST", "/shows/the-wire/episodes", { season: 2, episode: 2, watched: true });
    expect((res.body as { progress: { watchedEpisodes: number } }).progress.watchedEpisodes).toBe(2);
    // S2E2 is absolute 3 + 2 = 5.
    expect(savedTitle(h.lastSave(), "the-wire").watchedEpisodes).toEqual([1, 5]);
  });

  it("ticks and unticks by absolute number", async () => {
    const h = await harness();
    await h.call("POST", "/shows/the-wire/episodes", { absolute: 3 });
    expect(h.store.getTitle("the-wire")?.watchedEpisodes).toEqual([1, 3]);
    await h.call("POST", "/shows/the-wire/episodes", { absolute: 1, watched: false });
    expect(savedTitle(h.lastSave(), "the-wire").watchedEpisodes).toEqual([3]);
  });

  it("refuses a skipped episode instead of pretending to tick it", async () => {
    const h = await harness();
    const err = await failure(h.call("POST", "/shows/the-wire/episodes", { season: 1, episode: 2 }));
    expect(err.status).toBe(409);
    expect(h.store.getTitle("the-wire")?.watchedEpisodes).toEqual([1]);
  });

  it("refuses an episode that has not aired, and says so", async () => {
    const h = await harness();
    const err = await failure(h.call("POST", "/shows/the-wire/episodes", { season: 3, episode: 1 }));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/not aired/);
    expect(h.store.getTitle("the-wire")?.watchedEpisodes).toEqual([1]);
  });

  it("rejects episodes outside the show", async () => {
    const h = await harness();
    expect((await failure(h.call("POST", "/shows/the-wire/episodes", { season: 1, episode: 4 }))).status).toBe(400);
    expect((await failure(h.call("POST", "/shows/the-wire/episodes", { absolute: 10 }))).status).toBe(400);
    expect((await failure(h.call("POST", "/shows/the-wire/episodes", { season: 9, episode: 1 }))).status).toBe(404);
  });

  it("marks a season, skipping its skipped episodes", async () => {
    const h = await harness();
    const res = await h.call("POST", "/shows/the-wire/seasons/1", { watched: true });
    const progress = (res.body as { progress: { watchedEpisodes: number; seasons: { watched: number }[] } }).progress;
    expect(progress.seasons[0]?.watched).toBe(2);
    expect(savedTitle(h.lastSave(), "the-wire").watchedEpisodes).toEqual([1, 3]);

    await h.call("POST", "/shows/the-wire/seasons/2", { watched: true });
    expect(h.store.getTitle("the-wire")?.watchedEpisodes).toEqual([1, 3, 4, 5, 6, 7]);

    await h.call("POST", "/shows/the-wire/seasons/1", { watched: false });
    expect(savedTitle(h.lastSave(), "the-wire").watchedEpisodes).toEqual([4, 5, 6, 7]);
  });

  it("refuses a season nothing of which has aired, and 404s a season that does not exist", async () => {
    const h = await harness();
    expect((await failure(h.call("POST", "/shows/the-wire/seasons/3", { watched: true }))).status).toBe(409);
    expect((await failure(h.call("POST", "/shows/the-wire/seasons/7", { watched: true }))).status).toBe(404);
  });

  it("has no episode routes for films", async () => {
    const h = await harness();
    expect((await failure(h.call("POST", "/films/arrival/episodes", { absolute: 1 }))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Log watched
// ---------------------------------------------------------------------------

describe("titleRoutes: log watched", () => {
  it("writes exactly the wizard's patch, through the wizard's call", async () => {
    const h = await harness();
    const before = structuredClone(h.store.getTitle("arrival")) as TitleV4;
    const spy = vi.spyOn(h.store, "updateTitle");

    await h.call("POST", "/films/arrival/watched", { rating: 4, watchedVia: "cinema" });

    // A rating alone brings its review with it, as the wizard's stars do.
    const expected = watchedPatch(before, { date: "2026-10-26", rating: 4, review: "Awesome", watchedVia: "Cinema" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["arrival", expected, "api-watched"]);
    expect(savedTitle(h.lastSave(), "arrival")).toMatchObject({
      status: "Watched",
      dateStarted: "2026-10-26",
      dateFinished: "2026-10-26",
      rating: 4,
      review: "Awesome",
      watchedVia: "Cinema",
    });
  });

  it("defaults the date to today, local time, and writes nothing else when nothing else was said", async () => {
    const h = await harness();
    const before = structuredClone(h.store.getTitle("the-wire")) as TitleV4;
    const spy = vi.spyOn(h.store, "updateTitle");
    await h.call("POST", "/shows/the-wire/watched");
    const expected = watchedPatch(before, { date: "2026-10-26", rating: 0, review: "", watchedVia: "" });
    expect(spy.mock.calls[0]).toEqual(["the-wire", expected, "api-watched"]);
    // A show keeps the start it already had.
    expect(savedTitle(h.lastSave(), "the-wire")).toMatchObject({
      status: "Watched",
      dateStarted: "2026-09-01",
      dateFinished: "2026-10-26",
    });
  });

  it("takes an explicit date and an explicit review", async () => {
    const h = await harness();
    const res = await h.call("POST", "/films/arrival/watched", { date: "2026-10-01", review: "Marvelous" });
    expect(res.body).toMatchObject({ rating: 5, review: "Marvelous", dates: { started: "2026-10-01", finished: "2026-10-01" } });
  });

  it("rejects an unknown venue, review or date with 400 and writes nothing", async () => {
    const h = await harness();
    const saves = h.saves.length;
    expect((await failure(h.call("POST", "/films/arrival/watched", { watchedVia: "Drive-in" }))).status).toBe(400);
    expect((await failure(h.call("POST", "/films/arrival/watched", { review: "Sublime" }))).status).toBe(400);
    expect((await failure(h.call("POST", "/films/arrival/watched", { date: "26-10-2026" }))).status).toBe(400);
    expect((await failure(h.call("POST", "/films/arrival/watched", { when: "today" }))).status).toBe(400);
    expect(h.store.getTitle("arrival")?.status).toBe("Plan to watch");
    expect(h.saves.length).toBe(saves);
  });
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

describe("titleRoutes: every write is on disk before it answers", () => {
  const writes: [string, string, unknown][] = [
    ["POST", "/films", { title: "Heat" }],
    ["PATCH", "/films/arrival", { notes: "x" }],
    ["POST", "/films/arrival/watched", {}],
    ["POST", "/shows/the-wire/episodes", { absolute: 3 }],
    ["POST", "/shows/the-wire/seasons/2", { watched: true }],
    ["DELETE", "/films/arrival", undefined],
  ];

  for (const [method, path, body] of writes) {
    it(`${method} ${path}`, async () => {
      const h = await harness({ saveDelayMs: 25 });
      const before = h.saves.length;
      await h.call(method, path, body);
      // Without the flush the debounced write would still be 600 ms away.
      expect(h.saves.length).toBeGreaterThan(before);
      expect(h.store.hasUnsavedChanges).toBe(false);
    });
  }

  it("turns a failed write into a 500 rather than a success", async () => {
    const h = await harness();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.plugin.saveData = vi.fn(async () => {
      throw new Error("disk full");
    });
    // The store holds the plugin by reference, so the new saveData is the one used.
    const err = await failure(h.call("PATCH", "/films/arrival", { notes: "x" }));
    expect(err.status).toBe(500);
  });
});
