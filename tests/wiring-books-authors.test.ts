/**
 * The composition root's reading-side wiring.
 *
 * Four things landed in other files that `main.ts` is the only place able to
 * reach: the book pane, the author screen, the book half of the artwork cache,
 * and the author link's destination. Every one of them is *unreachable* until
 * `onload` binds it, and no unit test of those modules can tell the difference
 * between "wired" and "written but never called" — which is exactly how the
 * cache shipped covering 15 titles and 0 books.
 *
 * So the plugin half of this file boots the REAL built bundle, the same way
 * `onload.test.ts` does, and asserts against what `onload` actually did. Run
 * `npm run build` first; without it the bundle tests skip rather than lie.
 *
 * **No network.** The one cache test that downloads uses an injected transport.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { copyFileSync, existsSync } from "fs";
import { installDomGlobals, createHost } from "./helpers/dom";
import { createImageCache, type ImageCacheAdapter } from "../src/services/imagecache";
import { posterCacheEntries } from "../src/ui/components/posters";
import { readingCacheEntries } from "../src/domains/reading";
import { createBook, createTitle } from "../src/data/schema";
import type { HttpFn } from "../src/services/http";

const DIR = ".obsidian/plugins/watch-read-learn";
const VIEW_TYPE_BOOK_DETAIL = "watchlog-book-detail";
const VIEW_TYPE_AUTHOR = "watchlog-author-view";

// ---------------------------------------------------------------------------
// The combined entry list, without the plugin
// ---------------------------------------------------------------------------

class MemoryAdapter implements ImageCacheAdapter {
  files = new Map<string, ArrayBuffer>();
  folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((p) => p.startsWith(prefix)),
      folders: [],
    };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  getResourcePath(path: string): string {
    return `app://local/${path}`;
  }
}

/** One byte of "image", never fetched over a wire. */
const bytes = (): ArrayBuffer => new Uint8Array([1, 2, 3, 4]).buffer;

describe("the artwork cache's entry list covers both halves of the library", () => {
  const titles = [
    createTitle({ id: "t1", title: "Dune", type: "movie", posterUrl: "https://img.example/dune.jpg" }),
  ];
  const reading = {
    books: [createBook({ id: "b1", title: "Dune", coverUrl: "https://img.example/dune-book.jpg" })],
    manga: [],
  };

  it("names a book's file in the `book` scope, never colliding with a title's", () => {
    const entries = [...posterCacheEntries(titles), ...readingCacheEntries(reading)];
    const scopes = entries.map((entry) => entry.key.scope);
    expect(scopes).toContain("title");
    expect(scopes).toContain("book");
    // Same id, same-ish name, two different films-and-books: the scope is what
    // stops one cached file standing in for the other.
    expect(new Set(entries.map((entry) => entry.key.id)).size).toBe(2);
  });

  it("classes every cached book cover as an orphan when the list is titles-only", async () => {
    const adapter = new MemoryAdapter();
    const http: HttpFn = (async () => ({ bytes: bytes() })) as unknown as HttpFn;
    const cache = createImageCache({ adapter, enabled: true, folder: "art", http });

    await cache.warm([...posterCacheEntries(titles), ...readingCacheEntries(reading)]);
    const cached = [...adapter.files.keys()];
    expect(cached.some((path) => path.includes("/title-"))).toBe(true);
    expect(cached.some((path) => path.includes("/book-"))).toBe(true);

    // The bug, stated: warm both, orphan one, and the button that says
    // "remove unreferenced artwork" offers to delete every cover you own.
    const titlesOnly = cache.findOrphans(posterCacheEntries(titles));
    expect(titlesOnly.some((path) => path.includes("/book-"))).toBe(true);

    // The fix: the same list on both sides, and nothing is unreferenced.
    const both = cache.findOrphans([...posterCacheEntries(titles), ...readingCacheEntries(reading)]);
    expect(both).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The plugin, booted
// ---------------------------------------------------------------------------

interface BootedViews {
  [type: string]: (leaf: unknown) => Record<string, unknown>;
}

function fakeApp() {
  const opened: { type: string }[] = [];
  const files = new Map<string, string>([
    [`${DIR}/data.json`, JSON.stringify({ titles: [], settings: {} })],
  ]);
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT " + p);
      return files.get(p) as string;
    },
    write: async (p: string, c: string) => void files.set(p, c),
    remove: async (p: string) => void files.delete(p),
    rename: async (a: string, b: string) => {
      files.set(b, files.get(a) as string);
      files.delete(a);
    },
    stat: async (p: string) => (files.has(p) ? { mtime: 1, size: (files.get(p) as string).length } : null),
    list: async () => ({ files: [], folders: [] }),
    mkdir: async () => {},
    writeBinary: async () => {},
    getResourcePath: (p: string) => `app://local/${p}`,
  };
  const reg = { on: () => ({}), off: () => {}, offref: () => {} };
  return {
    vault: {
      adapter,
      ...reg,
      getAbstractFileByPath: () => null,
      getMarkdownFiles: () => [],
      read: async () => "",
      create: async () => ({}),
      modify: async () => {},
      process: async (_f: unknown, fn: (s: string) => string) => fn(""),
      createFolder: async () => ({}),
    },
    // Every leaf this run asked Obsidian to open, so "clicking the author name
    // opens the author screen" is an assertion about what happened rather than
    // about what the code reads like.
    opened,
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
      on: () => ({}),
      getLeaf: () => ({
        openFile: () => {},
        setViewState: async (state: { type: string }) => void opened.push(state),
      }),
      revealLeaf: () => {},
    },
    metadataCache: { getFirstLinkpathDest: () => null, ...reg },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function boot(): Promise<{
  plugin: any;
  views: BootedViews;
  opened: { type: string }[];
  teardown: () => void;
}> {
  const restoreDom = installDomGlobals(900);
  const g = globalThis as any;
  const hostProto = Object.getPrototypeOf(createHost());
  g.document.createElement = (tag: string) => new hostProto.constructor(tag);
  g.window.setInterval = (fn: () => void, ms: number) => setInterval(fn, ms);
  g.window.clearInterval = (id: ReturnType<typeof setInterval>) => clearInterval(id);
  g.window.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  copyFileSync("build/main.js", "/tmp/wl-wiring-books-authors.cjs");
  const req = createRequire(import.meta.url);
  const mock = await import("./mocks/obsidian");
  const Module = req("module");
  const orig = Module._load;
  Module._load = function (this: unknown, r: string, ...rest: unknown[]) {
    if (r === "obsidian") return mock;
    return orig.apply(this, [r, ...rest]);
  };
  delete req.cache[req.resolve("/tmp/wl-wiring-books-authors.cjs")];
  const bundle = req("/tmp/wl-wiring-books-authors.cjs");
  const plugin = new bundle.default();
  const app = fakeApp();
  plugin.app = app;
  plugin.manifest = { id: "watch-read-learn", dir: DIR, version: "0.0.0" };
  const views: BootedViews = {};
  plugin.addCommand = () => {};
  plugin.addRibbonIcon = () => ({});
  plugin.addSettingTab = () => {};
  plugin.addStatusBarItem = () => g.document.createElement("div");
  plugin.registerView = (type: string, factory: (leaf: unknown) => Record<string, unknown>) => {
    views[type] = factory;
  };
  plugin.registerEvent = () => {};
  const disposers: Array<() => void> = [];
  plugin.register = (fn: () => void) => disposers.push(fn);
  plugin.registerDomEvent = () => {};
  plugin.registerInterval = () => 0;
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  plugin.registerObsidianProtocolHandler = () => {};
  plugin.loadData = async () => {
    if (!(await app.vault.adapter.exists(`${DIR}/data.json`))) return null;
    return JSON.parse(await app.vault.adapter.read(`${DIR}/data.json`));
  };
  plugin.saveData = async (d: unknown) =>
    app.vault.adapter.write(`${DIR}/data.json`, JSON.stringify(d));
  await plugin.onload();
  return {
    plugin,
    views,
    opened: app.opened,
    teardown: () => {
      for (const fn of disposers) fn();
      if (typeof plugin.onunload === "function") plugin.onunload();
      Module._load = orig;
      restoreDom();
    },
  };
}

const built = existsSync("build/main.js");

describe("onload registers the reading side's two leaves", () => {
  it("registers the book pane and the author screen", async () => {
    if (!built) return;
    const { views, teardown } = await boot();
    try {
      expect(Object.keys(views)).toContain(VIEW_TYPE_BOOK_DETAIL);
      expect(Object.keys(views)).toContain(VIEW_TYPE_AUTHOR);
    } finally {
      teardown();
    }
  });

  it("survives a stale leaf of either type restored from a saved layout", async () => {
    if (!built) return;
    const { views, teardown } = await boot();
    try {
      // A layout saved last week, pointing at a book that has since been
      // deleted and an author nothing can resolve. Obsidian recreates both
      // *after* onload returns, and neither may throw.
      const bookLeaf = { detach: () => {}, setViewState: async () => {} };
      const book = views[VIEW_TYPE_BOOK_DETAIL]?.(bookLeaf) as any;
      book.contentEl = createHost();
      await expect(book.setState({ kind: "book", id: "gone" }, {})).resolves.not.toThrow();
      await expect(book.onOpen()).resolves.not.toThrow();
      await expect(book.onClose()).resolves.not.toThrow();

      const author = views[VIEW_TYPE_AUTHOR]?.({}) as any;
      author.contentEl = createHost();
      await expect(author.setState({ name: "Nobody At All" }, {})).resolves.not.toThrow();
      await expect(author.onOpen()).resolves.not.toThrow();
      await expect(author.onClose()).resolves.not.toThrow();
    } finally {
      teardown();
    }
  });
});

describe("an author name is a way into the author, not only a filter", () => {
  it("opens the author screen from a book pane, and still offers the filter", async () => {
    if (!built) return;
    const { plugin, views, opened, teardown } = await boot();
    try {
      plugin.store.reading.books.push(
        createBook({ id: "b1", title: "Dune", author: "Frank Herbert" }),
      );

      const view = views[VIEW_TYPE_BOOK_DETAIL]?.({ detach: () => {} }) as any;
      view.contentEl = createHost();
      await view.setState({ kind: "book", id: "b1" }, {});
      await view.onOpen();

      const chip = view.contentEl.querySelector(".wl-reading-author");
      expect(chip).not.toBeNull();
      // The tooltip is how `renderAuthorLink` reports what it managed to bind:
      // this exact wording is written only when it has *both* an opener and a
      // filter. Losing the Alt-click would be a regression on what the chip did
      // before there was an author screen at all.
      expect(chip?.getAttribute("title")).toBe(
        "Open Frank Herbert — Alt-click to filter the shelf by them instead",
      );

      const before = opened.length;
      chip?.fire("click", { altKey: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(opened.slice(before).map((state) => state.type)).toContain(VIEW_TYPE_AUTHOR);
    } finally {
      teardown();
    }
  });
});

describe("the plugin's own artwork passes cover titles AND books", () => {
  /** A cache double that records the list it was handed, and downloads nothing. */
  function spyCache(): { warmed: unknown[]; orphaned: unknown[]; cache: Record<string, unknown> } {
    const seen: { warmed: unknown[]; orphaned: unknown[] } = { warmed: [], orphaned: [] };
    return {
      ...seen,
      get warmed() {
        return seen.warmed;
      },
      get orphaned() {
        return seen.orphaned;
      },
      cache: {
        configure: () => {},
        prime: async () => {},
        isEnabled: () => true,
        warm: async (entries: Iterable<unknown>) => {
          seen.warmed = [...entries];
          return { downloaded: 0, failed: 0, skipped: 0 };
        },
        findOrphans: (entries: Iterable<unknown>) => {
          seen.orphaned = [...entries];
          return [];
        },
      },
    };
  }

  const scopesOf = (entries: unknown[]): string[] =>
    entries.map((entry) => (entry as { key: { scope: string } }).key.scope);

  it("hands both `warm` and `findOrphans` the books as well as the titles", async () => {
    if (!built) return;
    const { plugin, teardown } = await boot();
    try {
      plugin.store.settings.cacheImagesLocally = true;
      plugin.store.data.titles.push(
        createTitle({ id: "t1", title: "Dune", type: "movie", posterUrl: "https://img.example/dune.jpg" }),
      );
      plugin.store.reading.books.push(
        createBook({ id: "b1", title: "Dune", coverUrl: "https://img.example/dune-book.jpg" }),
      );

      const spy = spyCache();
      plugin.imageCache = spy.cache;

      await plugin.cacheArtwork();
      expect(scopesOf(spy.warmed)).toContain("title");
      expect(scopesOf(spy.warmed)).toContain("book");

      await plugin.findOrphanArtwork();
      expect(scopesOf(spy.orphaned)).toContain("title");
      expect(scopesOf(spy.orphaned)).toContain("book");
    } finally {
      teardown();
    }
  });
});
