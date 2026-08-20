/**
 * Regression tests for the Wave-3 review findings that shipped without a probe.
 *
 * The six probes in `review-wave3.test.ts` cover P0-1, P0-2, P1-1, P1-2 and
 * P1-3. Everything else the review found is pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureV3Backup, readV3Backup } from "../src/data/backup";
import { WatchLogStore } from "../src/data/store";
import { createDefaultData, createDefaultSettings, createTitle } from "../src/data/schema";
import { AddTitleModal } from "../src/ui/modals/add";
import {
  getNextUnwatchedEpisode,
  rememberSeasonGeometry,
  sanitizeWatchedEpisodes,
  toSeasonEpisode,
  withAddedSeason,
} from "../src/data/episodes";
import { episodeCode, sanitizeColor } from "../src/ui/components/pills";
import { tierFor } from "../src/ui/components/stars";
import { renderTrailerEmbed, safeExternalUrl, youtubeKey } from "../src/ui/modals/trailer";
import type { TitleV4 } from "../src/types";

// ---------------------------------------------------------------------------
// A DOM stub: the store dispatches its change event on `document`.
// ---------------------------------------------------------------------------

let dispatched: string[] = [];

beforeEach(() => {
  dispatched = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      dispatchEvent: (event: { type: string }) => {
        dispatched.push(event.type);
        return true;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
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
  vi.useRealTimers();
});

/** A `Plugin` stand-in with controllable persistence. */
function fakePlugin(options: { data?: unknown; save?: (data: unknown) => Promise<void> } = {}) {
  const saved: unknown[] = [];
  return {
    saved,
    data: options.data ?? null,
    loadData: vi.fn(async function (this: { data: unknown }) {
      return options.data ?? null;
    }),
    saveData: vi.fn(async (data: unknown) => {
      if (options.save) await options.save(data);
      saved.push(JSON.parse(JSON.stringify(data)));
    }),
  };
}

// ---------------------------------------------------------------------------
// P0-2 extras — identities the rebase must drop rather than reinterpret
// ---------------------------------------------------------------------------

describe("P0-2 — season geometry rebase", () => {
  function show(overrides: Partial<TitleV4> = {}): TitleV4 {
    return createTitle({
      id: "s",
      title: "Show",
      type: "TV Show",
      totalEpisodes: 20,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 10, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
      watchedEpisodes: [],
      ...overrides,
    });
  }

  it("drops only the identities whose season was removed", () => {
    const title = show({ watchedEpisodes: [1, 11] }); // S01E01 and S02E01.
    title.seasons = [
      { name: "Season 2", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 2 },
    ];
    title.totalEpisodes = 10;

    // S02E01 survives as absolute 1; S01E01's season is gone.
    expect(sanitizeWatchedEpisodes(title)).toEqual([1]);
  });

  it("drops an episode that a shrunk season no longer has", () => {
    const title = show({ watchedEpisodes: [10, 11] }); // S01E10, S02E01.
    title.seasons = [
      { name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 10, offset: 8, skippedEpisodes: [], seasonNumber: 2 },
    ];
    title.totalEpisodes = 18;

    // S01E10 no longer exists; S02E01 moves from 11 to 9.
    expect(sanitizeWatchedEpisodes(title)).toEqual([9]);
  });

  it("is idempotent once the new geometry has been remembered", () => {
    const title = show({ watchedEpisodes: [11] });
    title.seasons = [
      { name: "Season 1", episodes: 12, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 10, offset: 12, skippedEpisodes: [], seasonNumber: 2 },
    ];
    title.totalEpisodes = 22;
    title.watchedEpisodes = sanitizeWatchedEpisodes(title);
    rememberSeasonGeometry(title);

    expect(title.watchedEpisodes).toEqual([13]);
    expect(sanitizeWatchedEpisodes(title)).toEqual([13]);
  });

  it("re-runs auto-complete after a geometry change", () => {
    const plugin = fakePlugin();
    const store = new WatchLogStore(plugin as never);
    const title = show({ watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], status: "Watching" });
    store.data.titles.push(title);

    // Trim the show to the season the user has finished.
    store.updateTitle(title.id, {
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      ],
      totalEpisodes: 10,
    });

    expect(store.getTitle("s")?.status).toBe("Watched");
  });
});

// ---------------------------------------------------------------------------
// P0-3 — a failed backup is distinguishable from "nothing to back up"
// ---------------------------------------------------------------------------

describe("P0-3 — v3 backup gate", () => {
  it("reports the failure and that there was a file to lose", async () => {
    const adapter = {
      exists: vi.fn(async (path: string) => path.endsWith("data.json")),
      read: vi.fn(async () => "{}"),
      write: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    };

    const result = await ensureV3Backup(adapter as never, ".obsidian/plugins/watchlog");

    expect(result.created).toBe(false);
    expect(result.sourceExists).toBe(true);
    expect(result.error).toContain("EACCES");
  });

  it("does not claim a fresh install had something to lose", async () => {
    const adapter = {
      exists: vi.fn(async () => false),
      read: vi.fn(async () => ""),
      write: vi.fn(async () => undefined),
    };

    const result = await ensureV3Backup(adapter as never, ".obsidian/plugins/watchlog");

    expect(result.sourceExists).toBe(false);
    expect(result.error).toBeUndefined();
    expect(adapter.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P0-A — the backup gate is fail-closed and atomic (re-check)
// ---------------------------------------------------------------------------

describe("P0-A — fail-closed, atomic backup", () => {
  /** A tiny in-memory adapter with the parts `ensureV3Backup` uses. */
  function fakeAdapter(files: Record<string, string> = {}) {
    const disk = new Map(Object.entries(files));
    return {
      disk,
      exists: vi.fn(async (path: string) => disk.has(path)),
      read: vi.fn(async (path: string) => {
        const contents = disk.get(path);
        if (contents === undefined) throw new Error(`ENOENT ${path}`);
        return contents;
      }),
      write: vi.fn(async (path: string, contents: string) => {
        disk.set(path, contents);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        disk.set(to, disk.get(from) ?? "");
        disk.delete(from);
      }),
      remove: vi.fn(async (path: string) => {
        disk.delete(path);
      }),
    };
  }

  const dir = ".obsidian/plugins/watchlog";
  const source = `${dir}/data.json`;
  const target = `${dir}/data.json.v3.bak`;

  it("stages the copy and leaves no temporary file behind", async () => {
    const adapter = fakeAdapter({ [source]: '{"titles":[{"id":"a"}]}' });

    const result = await ensureV3Backup(adapter as never, dir);

    expect(result.created).toBe(true);
    expect(result.sourceState).toBe("present");
    expect(adapter.disk.get(target)).toBe('{"titles":[{"id":"a"}]}');
    expect([...adapter.disk.keys()].some((p) => p.includes(".tmp"))).toBe(false);
  });

  it("never overwrites a complete backup, even once data.json has moved on", async () => {
    const adapter = fakeAdapter({
      [source]: '{"titles":[],"schemaVersion":4}', // v4 has been saving for weeks
      [target]: '{"titles":[{"id":"v3"}]}', // the original v3 snapshot
    });

    const result = await ensureV3Backup(adapter as never, dir);

    expect(result.created).toBe(false);
    expect(result.error).toBeUndefined();
    expect(adapter.disk.get(target)).toBe('{"titles":[{"id":"v3"}]}');
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("replaces a truncated file sitting at the backup path", async () => {
    const adapter = fakeAdapter({
      [source]: '{"titles":[{"id":"a"}]}',
      [target]: "{trunca",
    });

    const result = await ensureV3Backup(adapter as never, dir);

    expect(result.created).toBe(true);
    expect(adapter.disk.get(target)).toBe('{"titles":[{"id":"a"}]}');
  });

  it("leaves the backup path untouched when the staged write fails", async () => {
    const adapter = fakeAdapter({ [source]: '{"titles":[]}' });
    adapter.write = vi.fn(async () => {
      throw new Error("ENOSPC");
    });

    const result = await ensureV3Backup(adapter as never, dir);

    expect(result.error).toContain("ENOSPC");
    expect(result.sourceExists).toBe(true);
    expect(adapter.disk.has(target)).toBe(false);
  });

  it("blocks when the source's existence cannot be established", async () => {
    const adapter = fakeAdapter();
    adapter.exists = vi.fn(async () => {
      throw new Error("EIO");
    });

    const result = await ensureV3Backup(adapter as never, dir);

    expect(result.sourceState).toBe("unknown");
    expect(result.sourceExists).toBe(true); // unknown blocks, absent does not
    expect(result.error).toContain("EIO");
  });

  it("refuses to hand a truncated backup to the restore action", async () => {
    const adapter = fakeAdapter({ [target]: "{trunca" });
    expect(await readV3Backup(adapter as never, dir)).toBeUndefined();

    const good = fakeAdapter({ [target]: '{"titles":[]}' });
    expect(await readV3Backup(good as never, dir)).toBe('{"titles":[]}');
  });
});

// ---------------------------------------------------------------------------
// P0-B — echo suppression by identity, not by clock (re-check)
// ---------------------------------------------------------------------------

describe("P0-B — self-write identification", () => {
  /** Drives the watcher off a mutable stamp the test controls. */
  function watched(store: WatchLogStore, read: () => number) {
    return store.startExternalWatch({ stamp: async () => read(), intervalMs: 1 });
  }

  it("suppresses the exact stamp its own write produced, and nothing else", async () => {
    vi.useFakeTimers();
    let stamp = 100;
    const disk = createDefaultData();
    const plugin = fakePlugin({ data: disk });
    const store = new WatchLogStore(plugin as never);

    const stop = watched(store, () => stamp);
    await vi.advanceTimersByTimeAsync(2); // prime at 100

    // A well-behaved adapter publishes the new stamp before the write resolves.
    plugin.saveData.mockImplementation(async () => {
      stamp = 200;
    });
    store.save("mine");
    await vi.advanceTimersByTimeAsync(605);
    await vi.advanceTimersByTimeAsync(5); // the watcher sees 200 — ours, exactly
    expect(plugin.loadData).not.toHaveBeenCalled();

    // Someone else writes one millisecond later. No time window to hide behind.
    disk.titles.push(createTitle({ id: "theirs", title: "Theirs", type: "Movie" }));
    stamp = 201;
    await vi.advanceTimersByTimeAsync(5);
    stop();

    expect(store.getTitle("theirs")).toBeDefined();
    expect(plugin.loadData).toHaveBeenCalledTimes(1);
  });

  it("does not let collapsed local writes eat a later external change", async () => {
    vi.useFakeTimers();
    let stamp = 100;
    const disk = createDefaultData();
    const plugin = fakePlugin({ data: disk });
    const store = new WatchLogStore(plugin as never);

    const stop = watched(store, () => stamp);
    await vi.advanceTimersByTimeAsync(2);

    // Two writes land between polls; the stamp only ever shows one change.
    store.save("one");
    await vi.advanceTimersByTimeAsync(605);
    store.save("two");
    await vi.advanceTimersByTimeAsync(605);
    expect(plugin.saveData).toHaveBeenCalledTimes(2);

    stamp = 200;
    await vi.advanceTimersByTimeAsync(5); // verified as ours; both markers go
    expect(plugin.loadData).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]); // recognised, so nothing repainted

    disk.titles.push(createTitle({ id: "theirs", title: "Theirs", type: "Movie" }));
    stamp = 300;
    await vi.advanceTimersByTimeAsync(5);
    stop();

    // No leftover marker ate the external change.
    expect(store.getTitle("theirs")).toBeDefined();
    expect(dispatched).toEqual(["watchlog-data-changed"]);
  });

  it("does not repaint when the file turns out to hold our own bytes", async () => {
    vi.useFakeTimers();
    let stamp = 100;
    const plugin = fakePlugin({ data: createDefaultData() });
    const store = new WatchLogStore(plugin as never);
    // The disk copy is exactly what this store would write.
    plugin.loadData.mockImplementation(async () => JSON.parse(JSON.stringify(store.data)));

    const stop = watched(store, () => stamp);
    await vi.advanceTimersByTimeAsync(2);
    store.save("mine");
    await vi.advanceTimersByTimeAsync(605);
    dispatched.length = 0;

    stamp = 200;
    await vi.advanceTimersByTimeAsync(5); // read, recognised, claims the marker
    stamp = 300;
    await vi.advanceTimersByTimeAsync(5); // a second bump: read, recognised again
    stop();

    // One read per observed change, and not a single repaint: the file only ever
    // held our own bytes.
    expect(plugin.loadData).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P0-4 — a file migration had to reset is never written over
// ---------------------------------------------------------------------------

describe("P0-4 — unrecognised data.json", () => {
  it("reports reset and never auto-saves defaults over it", async () => {
    const plugin = fakePlugin({ data: { somethingElse: true } });
    const store = new WatchLogStore(plugin as never);

    await store.load();

    expect(store.migrationReport?.reset).toBe(true);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });

  it("holds every write while the store is blocked, then flushes on resume", async () => {
    vi.useFakeTimers();
    const plugin = fakePlugin();
    const store = new WatchLogStore(plugin as never);
    store.blockWrites("unreadable data.json");

    store.save("while-blocked");
    await vi.advanceTimersByTimeAsync(2000);
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(store.hasUnsavedChanges).toBe(true);

    store.allowWrites();
    await vi.advanceTimersByTimeAsync(50);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(store.hasUnsavedChanges).toBe(false);
  });

  it("keeps live data when a reload finds an unreadable file", async () => {
    const plugin = fakePlugin({ data: { notOurs: 1 } });
    const store = new WatchLogStore(plugin as never);
    store.data.titles.push(createTitle({ id: "keep", title: "Keep me", type: "Movie" }));

    const adopted = await store.reloadFromDisk();

    expect(adopted).toBe(false);
    expect(store.getTitle("keep")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// P0-5 — external data.json changes are watched, echoes are not
// ---------------------------------------------------------------------------

describe("P0-5 — external change watcher", () => {
  /** Drive the watcher by hand rather than by wall clock. */
  async function watch(store: WatchLogStore, stamps: (number | null)[], extra = {}) {
    let index = 0;
    const onReloaded = vi.fn();
    const stop = store.startExternalWatch({
      stamp: async () => stamps[Math.min(index++, stamps.length - 1)] ?? null,
      intervalMs: 1,
      onReloaded,
      ...extra,
    });
    return { stop, onReloaded };
  }

  it("reloads and emits exactly one event when someone else writes the file", async () => {
    const external = { ...createDefaultData(), titles: [] as TitleV4[] };
    external.titles.push(
      createTitle({ id: "from-disk", title: "Written elsewhere", type: "Movie" }),
    );
    const plugin = fakePlugin({ data: external });
    const store = new WatchLogStore(plugin as never);

    const { stop } = await watch(store, [100, 200]);
    await vi.waitFor(() => expect(store.getTitle("from-disk")).toBeDefined());
    stop();

    expect(dispatched).toEqual(["watchlog-data-changed"]);
  });

  it("ignores the stamp change caused by its own write", async () => {
    vi.useFakeTimers();
    const plugin = fakePlugin({ data: createDefaultData() });
    const store = new WatchLogStore(plugin as never);

    // One completed write of our own, then a bump the watcher must attribute to it.
    store.save("mine");
    await vi.advanceTimersByTimeAsync(1000);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);

    const { stop } = await watch(store, [100, 200]);
    await vi.advanceTimersByTimeAsync(20);
    stop();

    // The bump is read once to confirm the file holds our own bytes (a pending
    // marker is never trusted on its own), then ignored: nothing is adopted and
    // nothing repaints.
    expect(plugin.loadData).toHaveBeenCalledTimes(1);
    expect(store.allTitles()).toHaveLength(0);
    expect(dispatched).toEqual([]);
  });

  it("asks before discarding unsaved local changes, and can keep them", async () => {
    vi.useFakeTimers();
    const plugin = fakePlugin({ data: createDefaultData() });
    const store = new WatchLogStore(plugin as never);
    // Dirty, with the debounced write still 600 ms away.
    store.save("local-edit");

    const stamps = [100, 200];
    let index = 0;
    const onConflict = vi.fn(async () => "mine" as const);
    const stop = store.startExternalWatch({
      stamp: async () => stamps[Math.min(index++, stamps.length - 1)] ?? null,
      intervalMs: 1,
      onConflict,
    });

    await vi.advanceTimersByTimeAsync(5);
    stop();

    expect(onConflict).toHaveBeenCalledTimes(1);
    // "mine" wins: memory is written out, the external file is not adopted.
    await vi.advanceTimersByTimeAsync(5);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.loadData).not.toHaveBeenCalled();
  });

  it("cancels the stale queued write and reloads when the file wins", async () => {
    vi.useFakeTimers();
    const external = { ...createDefaultData(), titles: [] as TitleV4[] };
    external.titles.push(createTitle({ id: "theirs", title: "Theirs", type: "Movie" }));
    const plugin = fakePlugin({ data: external });
    const store = new WatchLogStore(plugin as never);
    store.save("local-edit");

    const stamps = [100, 200];
    let index = 0;
    const stop = store.startExternalWatch({
      stamp: async () => stamps[Math.min(index++, stamps.length - 1)] ?? null,
      intervalMs: 1,
      onConflict: async () => "theirs",
    });

    await vi.advanceTimersByTimeAsync(5);
    stop();
    // Well past the debounce the local edit had queued.
    await vi.advanceTimersByTimeAsync(2000);

    expect(store.getTitle("theirs")).toBeDefined();
    expect(plugin.saveData).not.toHaveBeenCalled();
    expect(dispatched).toEqual(["watchlog-data-changed"]);
  });
});

// ---------------------------------------------------------------------------
// P1-5 — the add flow carries Overseerr's mediaInfo out of the modal
// ---------------------------------------------------------------------------

describe("P1-5 — mediaInfo survives the add", () => {
  const details = {
    tmdbId: 1399,
    mediaType: "tv" as const,
    title: "Game of Thrones",
    overview: "",
    posterUrl: "",
    backdropUrl: "",
    releaseDate: "2011-04-17",
    genres: [],
    runtime: 60,
    voteAverage: 8.4,
    voteCount: 20,
    trailerUrl: "",
    director: [],
    cast: [],
    studio: [],
    seasons: [{ seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2011-04-17" }],
    numberOfSeasons: 1,
    numberOfEpisodes: 10,
    mediaInfo: { id: 42, mediaType: "tv" as const, tmdbId: 1399, status: 5, status4k: 1, ratingKey: "3846" },
  };

  function modalStub(onAdded: (result: unknown) => void) {
    const added: TitleV4[] = [];
    const modal = Object.create(AddTitleModal.prototype) as Record<string, unknown>;
    modal.store = {
      settings: { ...createDefaultSettings() },
      allTitles: () => added,
      addTitle: (title: TitleV4) => {
        added.push(title);
        return title;
      },
      save: () => undefined,
    };
    modal.client = { details: async () => details };
    modal.onAdded = onAdded;
    modal.statusEl = null; // `setStatus` no-ops without one
    modal.close = () => undefined;
    return modal;
  }

  it("hands the Plex ratingKey to the caller instead of dropping it", async () => {
    const onAdded = vi.fn();
    const modal = modalStub(onAdded);

    await (modal as { addFromHit: (hit: unknown) => Promise<void> }).addFromHit({
      tmdbId: 1399,
      mediaType: "tv",
      title: "Game of Thrones",
    });

    expect(onAdded).toHaveBeenCalledTimes(1);
    const result = onAdded.mock.calls[0]?.[0] as { title: TitleV4; mediaInfo?: { ratingKey?: string } };
    expect(result.title.tmdbId).toBe(1399);
    expect(result.mediaInfo?.ratingKey).toBe("3846");
  });

  it("omits mediaInfo when the provider had none", async () => {
    const onAdded = vi.fn();
    const modal = modalStub(onAdded);
    (modal.client as { details: () => Promise<unknown> }).details = async () => ({
      ...details,
      mediaInfo: undefined,
    });

    await (modal as { addFromHit: (hit: unknown) => Promise<void> }).addFromHit({
      tmdbId: 1399,
      mediaType: "tv",
      title: "Game of Thrones",
    });

    expect(onAdded.mock.calls[0]?.[0]).not.toHaveProperty("mediaInfo");
  });
});

// ---------------------------------------------------------------------------
// P1-6 / P1-7 — external URLs are allowlisted; the player can go fullscreen
// ---------------------------------------------------------------------------

describe("P1-6 — http(s)-only external URLs", () => {
  it("rejects every scheme that is not http or https", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBe("");
    expect(safeExternalUrl("file:///etc/passwd")).toBe("");
    expect(safeExternalUrl("data:text/html,<script>")).toBe("");
    expect(safeExternalUrl("obsidian://open?vault=x")).toBe("");
    expect(safeExternalUrl("not a url at all")).toBe("");
    expect(safeExternalUrl("")).toBe("");
  });

  it("passes ordinary web links through", () => {
    expect(safeExternalUrl("https://vimeo.com/12345")).toBe("https://vimeo.com/12345");
    expect(safeExternalUrl("  http://example.com/t.mp4 ")).toBe("http://example.com/t.mp4");
  });

  it("still recognises YouTube keys, which never reach the allowlist", () => {
    expect(youtubeKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});

describe("P1-7 — iframe permissions", () => {
  it("asks for fullscreen in the permissions-policy list", () => {
    const attrs: Record<string, string> = {};
    const host = {
      createEl: (_tag: string, options: { attr: Record<string, string> }) => {
        Object.assign(attrs, options.attr);
        return {} as HTMLIFrameElement;
      },
    } as unknown as HTMLElement;

    renderTrailerEmbed(host, "dQw4w9WgXcQ", "A trailer");

    expect(attrs.allow).toContain("fullscreen");
    // The legacy attribute stays: older WebViews only understand that one.
    expect(attrs.allowfullscreen).toBe("true");
    expect(attrs.src).toContain("youtube-nocookie.com");
    expect(attrs).not.toHaveProperty("sandbox");
  });
});

// ---------------------------------------------------------------------------
// P1-8 — adding an announced season keeps watched identities put
// ---------------------------------------------------------------------------

describe("P1-8 — add an announced season", () => {
  it("appends in season-number order and recomputes offsets", () => {
    const seasons = withAddedSeason(
      [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 3", episodes: 8, offset: 10, skippedEpisodes: [], seasonNumber: 3 },
      ],
      2,
      12,
    );

    expect(seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
    expect(seasons.map((s) => s.offset)).toEqual([0, 10, 22]);
    expect(seasons[1]?.episodes).toBe(12);
  });

  it("is a no-op when the season is already tracked", () => {
    const existing = [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
    ];
    expect(withAddedSeason(existing, 1, 99)).toEqual(existing);
  });

  it("does not renumber what has already been watched", () => {
    const plugin = fakePlugin();
    const store = new WatchLogStore(plugin as never);
    const title = createTitle({
      id: "show",
      title: "Show",
      type: "TV Show",
      totalEpisodes: 20,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 10, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
      ],
      watchedEpisodes: [11],
      airing: { newSeasonDetected: 3, newSeasonEpisodes: 8 },
    });
    store.data.titles.push(title);

    const seasons = withAddedSeason(title.seasons, 3, 8);
    const airing = { ...title.airing };
    delete airing.newSeasonDetected;
    delete airing.newSeasonEpisodes;
    store.updateTitle(title.id, { seasons, totalEpisodes: 28, airing }, "season-added");

    const after = store.getTitle("show");
    expect(after?.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
    expect(after?.watchedEpisodes).toEqual([11]); // still S02E01
    expect(after?.airing?.newSeasonDetected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P2-2 / P2-3 — colours are sanitised, labels name the real season
// ---------------------------------------------------------------------------

describe("P2-2 — rating tier colours", () => {
  /** The star widget's own paint path, with a minimal element stand-in. */
  function paintWith(color: string) {
    const set: Record<string, string> = {};
    const removed: string[] = [];
    const el = {
      style: {
        setProperty: (name: string, value: string) => {
          set[name] = value;
        },
        removeProperty: (name: string) => {
          removed.push(name);
        },
      },
    };
    const tier = tierFor(4, [
      { label: "Bad", color: "#111111" },
      { label: "Meh", color: "#222222" },
      { label: "Fine", color: "#333333" },
      { label: "Good", color },
      { label: "Great", color: "#555555" },
    ]);
    const safe = tier ? sanitizeColor(tier.color) : "";
    if (safe) el.style.setProperty("--wl-rating", safe);
    else el.style.removeProperty("--wl-rating");
    return { set, removed };
  }

  it("writes a well-formed hex through", () => {
    expect(paintWith("#4488ff").set["--wl-rating"]).toBe("#4488ff");
  });

  it("drops anything that is not a hex colour", () => {
    for (const bad of ["red; background: url(x)", "javascript:1", "var(--evil)", ""]) {
      const result = paintWith(bad);
      expect(result.set["--wl-rating"]).toBeUndefined();
      expect(result.removed).toContain("--wl-rating");
    }
  });
});

describe("P2-3 — the +1 action names the real season", () => {
  it("uses seasonNumber, not the array index", () => {
    const title = createTitle({
      id: "s2-only",
      title: "Only season two",
      type: "TV Show",
      totalEpisodes: 10,
      seasons: [
        { name: "Season 2", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });

    const next = getNextUnwatchedEpisode(title);
    const pair = next === null ? null : toSeasonEpisode(title, next);
    expect(pair).not.toBeNull();
    expect(episodeCode(pair?.season.seasonNumber ?? 0, pair?.episode ?? 0)).toBe("S02E01");
  });
});

// ---------------------------------------------------------------------------
// P0-6 — a failed save is loud, and recoverable
// ---------------------------------------------------------------------------

describe("P0-6 — save failure propagation", () => {
  it("rejects flush() and keeps the store dirty when the write fails", async () => {
    const plugin = fakePlugin({
      save: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    const store = new WatchLogStore(plugin as never);
    store.save("doomed");

    await expect(store.flush()).rejects.toThrow("ENOSPC");
    expect(store.hasUnsavedChanges).toBe(true);
    expect(store.saveError?.message).toContain("ENOSPC");
  });

  it("clears the error and the dirty flag once a write lands", async () => {
    let failNext = true;
    const plugin = fakePlugin({
      save: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("locked");
        }
      },
    });
    const store = new WatchLogStore(plugin as never);
    store.save("first");

    await expect(store.flush()).rejects.toThrow("locked");
    await store.flush();

    expect(store.saveError).toBeNull();
    expect(store.hasUnsavedChanges).toBe(false);
  });
});
