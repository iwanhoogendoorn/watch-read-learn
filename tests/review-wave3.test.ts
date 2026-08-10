import { describe, expect, it, vi } from "vitest";
import { sanitizeWatchedEpisodes } from "../src/data/episodes";
import { ensureV3Backup } from "../src/data/backup";
import { createDefaultData, createTitle } from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import { expectedEpisodes } from "../src/services/availability";
import { seasonOnPlex } from "../src/services/requests";
import { plexBadge } from "../src/ui/components/pills";
import { DetailModal } from "../src/ui/modals/detail";
import { fromDrafts } from "../src/ui/modals/seasons";
import { WidgetSystem } from "../src/widgets/render";
import type { TitleV4 } from "../src/types";

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "review-show",
    title: "Review Show",
    type: "TV Show",
    status: "Watching",
    tmdbMediaType: "tv",
    totalEpisodes: 20,
    seasons: [
      { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      { name: "Season 2", episodes: 10, offset: 10, skippedEpisodes: [], seasonNumber: 2 },
    ],
    watchedEpisodes: [],
    ...overrides,
  });
}

describe("Wave 3 review probes", () => {
  it("preserves season-relative watched identity when an earlier season is resized", () => {
    const title = show({ watchedEpisodes: [11] }); // Season 2, episode 1.

    title.seasons = fromDrafts([
      { name: "Season 1", episodes: 12, skipped: "", airDate: "", seasonNumber: 1 },
      { name: "Season 2", episodes: 10, skipped: "", airDate: "", seasonNumber: 2 },
    ]);
    title.totalEpisodes = 22;
    title.watchedEpisodes = sanitizeWatchedEpisodes(title);

    // Season 2 episode 1 moved from absolute 11 to absolute 13.
    expect(title.watchedEpisodes).toEqual([13]);
  });

  it("does not let skipped episodes reduce Plex's full-show expectation", () => {
    const title = show({
      totalEpisodes: 10,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [9, 10], seasonNumber: 1 },
      ],
    });

    expect(expectedEpisodes(title)).toBe(10);
  });

  it("does not call a season present when Plex is missing a non-skipped episode", () => {
    const title = show({
      totalEpisodes: 10,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [9, 10], seasonNumber: 1 },
      ],
      plex: {
        state: "partial",
        // Eight files, but episode 8 is missing and skipped episode 9 is present.
        episodes: [1, 2, 3, 4, 5, 6, 7, 9].map((e) => ({ s: 1, e })),
      },
    });

    expect(seasonOnPlex(title, 0)).toBe(false);
  });

  it("uses the upstream episode total in a partial Plex badge", () => {
    const title = show({
      totalEpisodes: 33,
      airing: { episodeCount: 40 },
      plex: { state: "partial", leafCount: 34 },
    });

    expect(plexBadge(title)?.text).toBe("34/40 eps");
  });

  it("flushes debounced detail edits when the modal closes", () => {
    vi.useFakeTimers();
    try {
      const updateTitle = vi.fn();
      const modal = Object.create(DetailModal.prototype) as any;
      modal.store = { updateTitle };
      modal.titleId = "review-show";
      modal.refreshTimer = null;
      modal.commitTimers = new Map();
      modal.fieldValues = new Map([["notes", "draft note"]]);
      modal.onDataChanged = (): void => {};
      modal.onFocusIn = (): void => {};
      modal.onFocusOut = (): void => {};
      modal.contentEl = {
        ownerDocument: { removeEventListener: (): void => {} },
        removeEventListener: (): void => {},
        empty: (): void => {},
      };

      modal.debouncedPatch("notes", () => ({ notes: "draft note" }));
      modal.onClose();
      vi.advanceTimersByTime(601);

      expect(updateTitle).toHaveBeenCalledWith(
        "review-show",
        { notes: "draft note" },
        "detail-notes",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases poster observers when pruning a disconnected widget", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const fakeDocument = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: fakeDocument,
    });

    try {
      const releaseWithin = vi.fn();
      const plugin = { register: vi.fn() };
      const system = new WidgetSystem(plugin as any, {
        store: {} as any,
        posterLoader: { releaseWithin } as any,
      });
      const el = { isConnected: false } as HTMLElement;
      (system as any).registry.set(el, { el, plan: {}, state: {}, deps: {} });

      system.rerenderAll();
      system.destroy();

      expect(releaseWithin).toHaveBeenCalledWith(el);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("review2-a failed source-existence check still blocks the backup gate", async () => {
    const adapter = {
      exists: vi.fn(async () => {
        throw new Error("EIO while checking data.json");
      }),
      read: vi.fn(async () => "{}"),
      write: vi.fn(async () => undefined),
    };

    const result = await ensureV3Backup(adapter as never, ".obsidian/plugins/watchlog");

    // Unknown is not the same as absent: main.ts only blocks when sourceExists is true.
    expect(result.sourceExists).toBe(true);
    expect(result.error).toContain("EIO");
  });

  it("review2-a partial backup left by a failed write is not accepted on retry", async () => {
    let targetExists = false;
    let failWrite = true;
    const adapter = {
      exists: vi.fn(async (path: string) =>
        path.endsWith("data.json.v3.bak") ? targetExists : true,
      ),
      read: vi.fn(async (path: string) =>
        path.endsWith("data.json.v3.bak") ? "{truncated" : '{"titles":[]}',
      ),
      write: vi.fn(async () => {
        targetExists = true; // The adapter created/truncated the target before failing.
        if (failWrite) {
          failWrite = false;
          throw new Error("EIO during backup write");
        }
      }),
    };

    const first = await ensureV3Backup(adapter as never, ".obsidian/plugins/watchlog");
    const retry = await ensureV3Backup(adapter as never, ".obsidian/plugins/watchlog");

    expect(first.error).toContain("EIO");
    expect(retry.error).toBeDefined();
  });

  it("review2-external writes inside the self-save echo window are still reloaded", async () => {
    vi.useFakeTimers();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
    const dispatchEvent = vi.fn();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent },
    });
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class {
        constructor(
          public type: string,
          public init?: unknown,
        ) {}
      },
    });

    try {
      let disk = createDefaultData();
      let stamp = 100;
      const plugin = {
        loadData: vi.fn(async () => disk),
        saveData: vi.fn(async () => undefined),
      };
      const store = new WatchLogStore(plugin as never);
      const stop = store.startExternalWatch({
        stamp: async () => stamp,
        intervalMs: 10,
      });
      await vi.advanceTimersByTimeAsync(1); // Prime stamp 100.

      store.save("local-write");
      await vi.advanceTimersByTimeAsync(601);
      stamp = 200;
      await vi.advanceTimersByTimeAsync(10); // Consume the local write's stamp.

      // The first bump was our own write: nothing was adopted, nothing repainted.
      expect(store.allTitles()).toHaveLength(0);
      expect(dispatchEvent).not.toHaveBeenCalled();

      disk = createDefaultData();
      disk.titles.push(createTitle({ id: "external", title: "External", type: "Movie" }));
      stamp = 300;
      await vi.advanceTimersByTimeAsync(10); // A real external write, still <2s after ours.
      stop();

      expect(store.getTitle("external")).toBeDefined();
      // Exactly one adoption, and it was the second bump's. (The original
      // `loadData` call-count assertion was an implementation proxy for that:
      // the `final-pending` probe below requires the file to be READ before a
      // pending self-marker may suppress a state, so every observed change now
      // costs one read — the reload reuses it rather than reading twice.)
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalCustomEvent) Object.defineProperty(globalThis, "CustomEvent", originalCustomEvent);
      else Reflect.deleteProperty(globalThis, "CustomEvent");
      vi.useRealTimers();
    }
  });

  it("final-pending self marker verifies contents before suppressing the first changed stamp", async () => {
    vi.useFakeTimers();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { dispatchEvent: vi.fn() },
    });
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      value: class {
        constructor(
          public type: string,
          public init?: unknown,
        ) {}
      },
    });

    try {
      let disk = createDefaultData();
      let stamp = 100;
      const plugin = {
        loadData: vi.fn(async () => disk),
        // Simulate a lagging/coarse adapter: our completed write still reports stamp 100.
        saveData: vi.fn(async () => undefined),
      };
      const store = new WatchLogStore(plugin as never);
      const stop = store.startExternalWatch({
        stamp: async () => stamp,
        intervalMs: 10,
      });
      await vi.advanceTimersByTimeAsync(1);

      store.save("local-write-with-unpublished-stamp");
      await vi.advanceTimersByTimeAsync(601); // Leaves one pending self-write marker.

      disk = createDefaultData();
      disk.titles.push(createTitle({ id: "external-first", title: "External first", type: "Movie" }));
      stamp = 200; // The first visible bump belongs to the external writer, not us.
      await vi.advanceTimersByTimeAsync(10);
      stop();

      expect(store.getTitle("external-first")).toBeDefined();
      expect(plugin.loadData).toHaveBeenCalledTimes(1);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalCustomEvent) Object.defineProperty(globalThis, "CustomEvent", originalCustomEvent);
      else Reflect.deleteProperty(globalThis, "CustomEvent");
      vi.useRealTimers();
    }
  });
});
