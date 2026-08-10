import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import {
  autoDetectMapping,
  buildImportPlan,
  coerceRow,
  exportGamesCsv,
  exportReadingCsv,
  indexExisting,
  parseCsv,
} from "../src/data/csv";
import {
  createBook,
  createDraftsState,
  createGame,
  createManga,
} from "../src/data/schema";
import { DraftsService } from "../src/domains/drafts/panel";
import { renderBookResult } from "../src/domains/reading/modals/add";
import { statusPatch } from "../src/domains/reading/progress";
import {
  parseCustomList,
  serializeCustomList,
} from "../src/domains/lists/format";
import { CustomListManager } from "../src/domains/lists/manager";
import { ANILIST_MIN_GAP_MS, createAniListClient } from "../src/services/anilist";
import type { HttpFn } from "../src/services/http";
import { openLibraryCoverUrl } from "../src/services/openlibrary";
import { createPassthroughLimiter, createRateLimiter } from "../src/services/ratelimit";
import { createHost, installDomGlobals } from "./helpers/dom";
import type {
  CustomList,
  WatchLogStoreApi,
} from "../src/types";

const LIST_FOLDER = "Watch Read Learn/CustomLists";
const LIST_PATH = `${LIST_FOLDER}/Rainy Sunday.md`;

function listFixture(): CustomList {
  return {
    id: "rainy-sunday",
    name: "Rainy Sunday",
    columns: [],
    rows: [{ id: "row-1", name: "Arrival" }],
    dateAdded: "2026-08-01T00:00:00.000Z",
    dateModified: "2026-08-01T00:00:00.000Z",
  };
}

function listHarness(options: { failWrites?: boolean } = {}) {
  const file = Object.assign(new TFile(), {
    basename: "Rainy Sunday",
    parent: { path: LIST_FOLDER },
  });
  let text = serializeCustomList(listFixture());

  const vault = {
    getAbstractFileByPath(path: string) {
      if (path === LIST_FOLDER) return { path: LIST_FOLDER };
      if (path === LIST_PATH) return file;
      return null;
    },
    getFiles: () => [file],
    read: vi.fn(async () => text),
    modify: vi.fn(async (_file: TFile, next: string) => {
      if (options.failWrites) throw new Error("disk full");
      text = next;
    }),
    createFolder: vi.fn(async () => undefined),
    create: vi.fn(async (_path: string, next: string) => {
      text = next;
      return file;
    }),
    rename: vi.fn(async () => undefined),
    // Obsidian's atomic read-modify-write. Routed through `modify` so a harness
    // that gates the write still gates it, and so the callback sees whatever
    // the file holds at the moment `process` is entered.
    process: vi.fn(async (target: TFile, fn: (data: string) => string) => {
      const next = fn(text);
      await vault.modify(target, next);
      return next;
    }),
  };

  const app = {
    vault,
    fileManager: { trashFile: vi.fn(async () => undefined) },
  };
  const manager = new CustomListManager(app as never, () => LIST_FOLDER);
  return { manager, vault, getText: () => text, setText: (next: string) => { text = next; } };
}

function firstImportedRow(csv: string, domain: "reading" | "games") {
  const rows = parseCsv(csv);
  const headers = rows[0] ?? [];
  const mapping = autoDetectMapping(headers, domain);
  const plan = buildImportPlan(domain, rows, mapping, indexExisting([]));
  return coerceRow(domain, plan.rows[0]?.values ?? {});
}

describe("Wave 8 adversarial review probes", () => {
  it("propagates a custom-list write failure instead of reporting success", async () => {
    const { manager } = listHarness({ failWrites: true });
    const list = await manager.loadList("Rainy Sunday");
    expect(list).not.toBeNull();
    (list as CustomList).rows.push({ id: "row-local", name: "Dune" });

    await expect(manager.saveList(list as CustomList)).rejects.toThrow("disk full");
  });

  it("does not overwrite an externally changed custom-list file with stale state", async () => {
    const { manager, getText, setText } = listHarness();
    const stale = await manager.loadList("Rainy Sunday");
    expect(stale).not.toBeNull();

    const external = parseCustomList("Rainy Sunday", getText());
    if (!external.ok) throw new Error(external.detail);
    external.list.rows.push({ id: "row-external", name: "Externally added" });
    setText(serializeCustomList(external.list));

    (stale as CustomList).rows.push({ id: "row-local", name: "Locally added" });
    await manager.saveList(stale as CustomList);

    const saved = parseCustomList("Rainy Sunday", getText());
    if (!saved.ok) throw new Error(saved.detail);
    expect(saved.list.rows.some((row) => row.id === "row-external")).toBe(true);
  });

  it("recheck preserves disjoint local and external edits to the same list row", async () => {
    const { manager, getText, setText } = listHarness();
    const local = await manager.loadList("Rainy Sunday");
    expect(local).not.toBeNull();

    const localRow = (local as CustomList).rows[0];
    if (!localRow) throw new Error("missing fixture row");
    localRow.name = "Arrival — local title";

    const external = parseCustomList("Rainy Sunday", getText());
    if (!external.ok) throw new Error(external.detail);
    const externalRow = external.list.rows[0];
    if (!externalRow) throw new Error("missing external fixture row");
    externalRow.where = "Cinema";
    setText(serializeCustomList(external.list));

    await manager.saveList(local as CustomList);

    const saved = parseCustomList("Rainy Sunday", getText());
    if (!saved.ok) throw new Error(saved.detail);
    expect(saved.list.rows[0]).toMatchObject({
      name: "Arrival — local title",
      where: "Cinema",
    });
  });

  it("recheck propagates saveList and flush failures from the same failed modify", async () => {
    const { manager } = listHarness({ failWrites: true });
    const list = await manager.loadList("Rainy Sunday");
    expect(list).not.toBeNull();
    (list as CustomList).rows.push({ id: "row-local", name: "Dune" });

    const save = manager.saveList(list as CustomList);
    const flush = manager.flush();
    await expect(save).rejects.toThrow("disk full");
    await expect(flush).rejects.toThrow("disk full");
  });

  it("recheck propagates saveNotes and flush failures from the same failed modify", async () => {
    const { manager } = listHarness({ failWrites: true });
    const list = await manager.loadList("Rainy Sunday");
    expect(list).not.toBeNull();

    const save = manager.saveNotes(list as CustomList, "changed notes");
    const flush = manager.flush();
    await expect(save).rejects.toThrow("disk full");
    await expect(flush).rejects.toThrow("disk full");
  });

  it("recheck does not suppress and clobber an external write during vault.modify", async () => {
    const file = Object.assign(new TFile(), {
      path: LIST_PATH,
      basename: "Rainy Sunday",
      parent: { path: LIST_FOLDER },
    });
    let text = serializeCustomList(listFixture());
    let releaseWrite!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });

    const app = {
      vault: {
        getAbstractFileByPath(path: string) {
          if (path === LIST_FOLDER) return { path: LIST_FOLDER };
          if (path === LIST_PATH) return file;
          return null;
        },
        getFiles: () => [file],
        read: vi.fn(async () => text),
        modify: vi.fn(async (_file: TFile, next: string) => {
          markStarted();
          await writeGate;
          text = next;
        }),
        createFolder: vi.fn(async () => undefined),
        create: vi.fn(),
        process: vi.fn(async (target: TFile, fn: (data: string) => string) => {
          const next = fn(text);
          await app.vault.modify(target, next);
          return next;
        }),
      },
      fileManager: { trashFile: vi.fn() },
    };
    const manager = new CustomListManager(app as never, () => LIST_FOLDER);
    const local = await manager.loadList("Rainy Sunday");
    expect(local).not.toBeNull();
    (local as CustomList).rows.push({ id: "row-local", name: "Locally added" });

    const save = manager.saveList(local as CustomList);
    await started;
    expect(manager.isWriting("Rainy Sunday")).toBe(true);

    const external = parseCustomList("Rainy Sunday", text);
    if (!external.ok) throw new Error(external.detail);
    external.list.rows.push({ id: "row-racing", name: "Added during write" });
    text = serializeCustomList(external.list);

    // The Lists tab drops every watcher callback while `isWriting()` is true.
    // Letting the local modify finish last must not erase that racing version.
    releaseWrite();
    await save;

    const saved = parseCustomList("Rainy Sunday", text);
    if (!saved.ok) throw new Error(saved.detail);
    expect(saved.list.rows.some((row) => row.id === "row-racing")).toBe(true);
  });

  it("final recheck protects the corrective merge write from a second external race", async () => {
    const file = Object.assign(new TFile(), {
      path: LIST_PATH,
      basename: "Rainy Sunday",
      parent: { path: LIST_FOLDER },
    });
    let text = serializeCustomList(listFixture());
    let writeNumber = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

    const app = {
      vault: {
        getAbstractFileByPath(path: string) {
          if (path === LIST_FOLDER) return { path: LIST_FOLDER };
          if (path === LIST_PATH) return file;
          return null;
        },
        getFiles: () => [file],
        read: vi.fn(async () => text),
        modify: vi.fn(async (_file: TFile, next: string) => {
          writeNumber += 1;
          if (writeNumber === 1) {
            markFirstStarted();
            await firstGate;
          } else if (writeNumber === 2) {
            markSecondStarted();
            await secondGate;
          }
          text = next;
        }),
        createFolder: vi.fn(async () => undefined),
        create: vi.fn(),
        process: vi.fn(async (target: TFile, fn: (data: string) => string) => {
          const next = fn(text);
          await app.vault.modify(target, next);
          return next;
        }),
      },
      fileManager: { trashFile: vi.fn() },
    };
    const manager = new CustomListManager(app as never, () => LIST_FOLDER);
    const local = await manager.loadList("Rainy Sunday");
    expect(local).not.toBeNull();
    (local as CustomList).rows.push({ id: "row-local", name: "Locally added" });

    const save = manager.saveList(local as CustomList);
    await firstStarted;

    const firstExternal = parseCustomList("Rainy Sunday", text);
    if (!firstExternal.ok) throw new Error(firstExternal.detail);
    firstExternal.list.rows.push({ id: "row-remote-1", name: "First racing row" });
    text = serializeCustomList(firstExternal.list);
    manager.noteExternalContent("Rainy Sunday", text);
    releaseFirst();

    // The first race is detected and causes the corrective merged write.
    await secondStarted;
    const secondExternal = parseCustomList("Rainy Sunday", text);
    if (!secondExternal.ok) throw new Error(secondExternal.detail);
    secondExternal.list.rows.push({ id: "row-remote-2", name: "Second racing row" });
    text = serializeCustomList(secondExternal.list);
    manager.noteExternalContent("Rainy Sunday", text);
    releaseSecond();
    await save;

    const saved = parseCustomList("Rainy Sunday", text);
    if (!saved.ok) throw new Error(saved.detail);
    expect(saved.list.rows.some((row) => row.id === "row-remote-1")).toBe(true);
    expect(saved.list.rows.some((row) => row.id === "row-remote-2")).toBe(true);
  });

  it("final2 corrective loop merges content that changed between snapshot and write", async () => {
    // The window no check can close: between the caller computing its merge
    // input and the write landing, somebody else writes. `Vault.process` is
    // Obsidian's answer — the callback receives the file's content inside the
    // per-file operation queue, so the merge input IS the write's baseline.
    //
    // The mock models exactly that: the caller's snapshot goes stale (an
    // external row lands after `loadList`), and `process` hands the manager the
    // fresh content rather than anything it read earlier.
    const file = Object.assign(new TFile(), {
      path: LIST_PATH,
      basename: "Rainy Sunday",
      parent: { path: LIST_FOLDER },
    });
    let text = serializeCustomList(listFixture());
    /** Content the manager saw before the interleaved write. */
    let snapshotAtRead = "";
    const seenByProcess: string[] = [];

    const app = {
      vault: {
        getAbstractFileByPath(path: string) {
          if (path === LIST_FOLDER) return { path: LIST_FOLDER };
          if (path === LIST_PATH) return file;
          return null;
        },
        getFiles: () => [file],
        read: vi.fn(async () => {
          snapshotAtRead = text;
          return text;
        }),
        modify: vi.fn(async (_file: TFile, next: string) => {
          text = next;
        }),
        createFolder: vi.fn(async () => undefined),
        create: vi.fn(),
        process: vi.fn(async (_file: TFile, fn: (data: string) => string) => {
          // Whatever the manager may have read earlier, the callback gets the
          // file as it is now — that is the whole guarantee.
          seenByProcess.push(text);
          const next = fn(text);
          text = next;
          return next;
        }),
      },
      fileManager: { trashFile: vi.fn() },
    };

    const manager = new CustomListManager(app as never, () => LIST_FOLDER);
    const local = await manager.loadList("Rainy Sunday");
    expect(local).not.toBeNull();
    const staleSnapshot = snapshotAtRead;
    (local as CustomList).rows.push({ id: "row-local", name: "Locally added" });

    // Another device writes AFTER the manager's snapshot and BEFORE the write.
    const interleaved = parseCustomList("Rainy Sunday", text);
    if (!interleaved.ok) throw new Error(interleaved.detail);
    interleaved.list.rows.push({ id: "row-interleaved", name: "Landed in between" });
    text = serializeCustomList(interleaved.list);
    expect(text).not.toBe(staleSnapshot);

    await manager.saveList(local as CustomList);

    // The merge ran against the interleaved content, not the stale snapshot.
    expect(seenByProcess[0]).not.toBe(staleSnapshot);
    expect(seenByProcess[0]).toContain("row-interleaved");

    const saved = parseCustomList("Rainy Sunday", text);
    if (!saved.ok) throw new Error(saved.detail);
    const ids = saved.list.rows.map((row) => row.id);
    expect(ids).toContain("row-interleaved");
    expect(ids).toContain("row-local");
    expect(ids).toContain("row-1");
  });

  it("flags duplicate titles inside the same CSV, not only against the library", () => {
    const rows = [
      ["title"],
      ["Dune"],
      [" dune "],
    ];
    const plan = buildImportPlan(
      "watchlist",
      rows,
      { title: "title" },
      indexExisting([]),
    );

    expect(plan.rows[1]?.duplicateOf).toBeDefined();
  });

  it("round-trips word-based reading progress through the reading CSV", () => {
    const book = createBook({
      id: "words",
      title: "A Long Book",
      progressUnit: "words",
      wordsRead: 50_000,
      totalWords: 100_000,
      favorite: true,
    });

    const imported = firstImportedRow(exportReadingCsv([book]), "reading");
    expect(imported).toMatchObject({
      progressUnit: "words",
      wordsRead: 50_000,
      totalWords: 100_000,
      favorite: true,
    });
  });

  it("round-trips game progress and identity through the games CSV", () => {
    const game = createGame({
      id: "hades",
      title: "Hades",
      progress: 70,
      wishlist: true,
      steamAppId: "1145360",
      singleplayer: true,
    });

    const imported = firstImportedRow(exportGamesCsv([game]), "games");
    expect(imported).toMatchObject({
      progress: 70,
      wishlist: true,
      steamAppId: "1145360",
      singleplayer: true,
    });
  });

  it("fills a volume-tracked manga when it is marked Completed", () => {
    const manga = createManga({
      id: "manga",
      title: "Volume-only series",
      chaptersRead: 0,
      totalChapters: 0,
      volumesRead: 3,
      totalVolumes: 10,
    });

    expect(statusPatch(manga, "Completed")).toMatchObject({
      status: "Completed",
      volumesRead: 10,
    });
  });

  it("queues a fresh drafts sweep when the 500 ms debounce fires mid-scan", async () => {
    const restoreDom = installDomGlobals();
    vi.useFakeTimers();
    try {
      const file = Object.assign(new TFile(), { path: "Ideas.md", basename: "Ideas" });
      let resolveFirst!: (text: string) => void;
      const cachedRead = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
        )
        .mockResolvedValue("#watchlog Arrival");

      const store = {
        data: { drafts: createDraftsState() },
        settings: { draftsVaultTag: "#watchlog" },
        allTitles: () => [],
        reading: { books: [], manga: [] },
        games: { games: [] },
        save: vi.fn(),
        emitChanged: vi.fn(),
      } as unknown as WatchLogStoreApi;
      const service = new DraftsService({
        app: {
          vault: { getMarkdownFiles: () => [file], cachedRead },
          metadataCache: {
            getFileCache: () => ({ tags: [{ tag: "#watchlog" }] }),
            on: vi.fn(),
            offref: vi.fn(),
          },
        } as never,
        store,
      });

      const first = service.scan();
      service.scheduleScan();
      await vi.advanceTimersByTimeAsync(500);
      resolveFirst("#watchlog Dune");
      await first;
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(cachedRead).toHaveBeenCalledTimes(2);
      expect(service.current().map((entry) => entry.display)).toContain("Arrival");
    } finally {
      vi.useRealTimers();
      restoreDom();
    }
  });

  it("does not register the vault-wide drafts listener after destruction", () => {
    const on = vi.fn(() => ({ id: "changed" }));
    const service = new DraftsService({
      app: {
        vault: { getMarkdownFiles: () => [] },
        metadataCache: {
          getFileCache: vi.fn(),
          on,
          offref: vi.fn(),
        },
      } as never,
      store: {
        data: { drafts: createDraftsState() },
        settings: { draftsVaultTag: "#watchlog" },
        allTitles: () => [],
        reading: { books: [], manga: [] },
        games: { games: [] },
        save: vi.fn(),
        emitChanged: vi.fn(),
      } as unknown as WatchLogStoreApi,
    });

    service.destroy();
    service.start();
    expect(on).not.toHaveBeenCalled();
  });

  it("does not send Open Library covers directly through an unthrottled browser img", () => {
    const restore = installDomGlobals();
    try {
      const coverUrl = openLibraryCoverUrl("id", "6976407");
      const row = renderBookResult(
        createHost() as unknown as HTMLElement,
        {
          id: "/works/OL893415W",
          source: "openlibrary",
          title: "Dune",
          authors: ["Frank Herbert"],
          coverUrl,
        },
        { tracked: false, onPick: vi.fn() },
      );
      const img = row.querySelector("img") as (HTMLImageElement & { src: string }) | null;

      // A remote assignment is made by Chromium, outside the Open Library client:
      // no Watch, Read and Learn User-Agent and no 3 req/s limiter can be attached to it.
      expect(img?.src).not.toBe(coverUrl);
    } finally {
      restore();
    }
  });

  it("paginates AniList airing schedules beyond the first 50 rows", async () => {
    let calls = 0;
    const http = vi.fn(async () => {
      calls += 1;
      const mediaId = calls === 1 ? 1 : 2;
      return {
        status: 200,
        headers: {},
        text: "",
        json: {
          data: {
            Page: {
              pageInfo: { currentPage: calls, hasNextPage: calls === 1 },
              airingSchedules: [{ mediaId, episode: 1, airingAt: 1_800_000_000 + calls }],
            },
          },
        },
      };
    }) as unknown as HttpFn;
    const client = createAniListClient(
      () => ({ enabled: true }),
      { http, limiter: createPassthroughLimiter() },
    );

    const schedules = await client.airingSchedules({ mediaIds: [1, 2], perPage: 50 });
    expect(schedules.map((entry) => entry.mediaId)).toEqual([1, 2]);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("recheck paginates a 200-row AniList window without starving the next call", async () => {
    let calls = 0;
    let now = 0;
    const clock = {
      now: () => now,
      sleep: vi.fn(async (ms: number) => { now += ms; }),
    };
    const http = vi.fn(async (request: { json?: unknown }) => {
      calls += 1;
      const variables = ((request.json as { variables?: Record<string, unknown> } | undefined)?.variables ?? {});
      const ids = Array.isArray(variables.ids) ? variables.ids : [];
      const page = Number(variables.page ?? 1);
      const finalProbe = ids.includes(999);
      const count = finalProbe ? 1 : 50;
      const start = finalProbe ? 999 : (page - 1) * 50 + 1;
      return {
        status: 200,
        headers: {},
        text: "",
        json: {
          data: {
            Page: {
              pageInfo: { currentPage: page, hasNextPage: !finalProbe && page < 4 },
              airingSchedules: Array.from({ length: count }, (_, index) => ({
                mediaId: start + index,
                episode: 1,
                airingAt: 1_800_000_000 + start + index,
              })),
            },
          },
        },
      };
    }) as unknown as HttpFn;
    const client = createAniListClient(
      () => ({ enabled: true }),
      { http, clock, limiter: createRateLimiter(ANILIST_MIN_GAP_MS, clock) },
    );

    const week = await client.airingSchedules({ mediaIds: [1], perPage: 50 });
    expect(week).toHaveLength(200);
    expect(calls).toBe(4);

    const next = await client.airingSchedules({ mediaIds: [999], perPage: 50 });
    expect(next).toHaveLength(1);
    expect(calls).toBe(5);
    expect(now).toBe(8_000);
  });
});
