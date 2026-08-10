/**
 * Boots the REAL built bundle through Plugin.onload with a minimal fake app.
 *
 * Exists because an initialization-order bug in onload (setupGames reading
 * `integrations` before it was constructed) shipped in 4.1.0 while 1393 unit
 * tests stayed green: nothing ever ran the composed onload sequence. This test
 * is deliberately coupled to build output — run `npm run build` first (the npm
 * test script does).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { installDomGlobals, createHost } from "./helpers/dom";
import { copyFileSync, existsSync } from "fs";

const DIR = ".obsidian/plugins/watch-read-learn";
const EMPTY_DB = JSON.stringify({ titles: [], settings: {} });

function fakeApp(seed: Record<string, string> = { [`${DIR}/data.json`]: EMPTY_DB }) {
  const files = new Map<string, string>(Object.entries(seed));
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => { if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p)!; },
    write: async (p: string, c: string) => void files.set(p, c),
    remove: async (p: string) => void files.delete(p),
    rename: async (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a); },
    stat: async (p: string) => (files.has(p) ? { mtime: 1, size: files.get(p)!.length } : null),
  };
  // Exposed so a test can assert what the run did — and did not — write.
  (adapter as unknown as { files: Map<string, string> }).files = files;
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
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
      on: () => ({}),
      getLeaf: () => ({ openFile: () => {} }),
      revealLeaf: () => {},
    },
    metadataCache: { getFirstLinkpathDest: () => null, ...reg },
  };
}

/** Boot the built bundle against a given fake app; returns it plus a teardown. */
async function boot(app: ReturnType<typeof fakeApp>) {
  const restoreDom = installDomGlobals(900);
  // The shared harness covers what components need; onload touches a little
  // more of the platform (status bar element, polling timers). Extend it.
  const g = globalThis as any;
  const hostProto = Object.getPrototypeOf(createHost());
  g.document.createElement = (tag: string) => new hostProto.constructor(tag);
  g.window.setInterval = (fn: () => void, ms: number) => setInterval(fn, ms);
  g.window.clearInterval = (id: ReturnType<typeof setInterval>) => clearInterval(id);
  g.window.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  copyFileSync("build/main.js", "/tmp/wl-onload-regression.cjs");
  const req = createRequire(import.meta.url);
  const mock = await import("./mocks/obsidian");
  const Module = req("module");
  const orig = Module._load;
  Module._load = function (r: string, ...rest: unknown[]) {
    if (r === "obsidian") return mock;
    return orig.apply(this, [r, ...rest]);
  };
  delete req.cache[req.resolve("/tmp/wl-onload-regression.cjs")];
  const bundle = req("/tmp/wl-onload-regression.cjs");
  const plugin = new bundle.default();
  plugin.app = app;
  plugin.manifest = { id: "watch-read-learn", dir: DIR, version: "0.0.0" };
  plugin.addCommand = () => {};
  plugin.addRibbonIcon = () => ({});
  plugin.addSettingTab = () => {};
  plugin.addStatusBarItem = () => (globalThis as any).document.createElement("div");
  plugin.registerView = () => {};
  plugin.registerEvent = () => {};
  const disposers: Array<() => void> = [];
  plugin.register = (fn: () => void) => disposers.push(fn);
  plugin.registerDomEvent = () => {};
  plugin.registerInterval = () => 0;
  plugin.registerMarkdownCodeBlockProcessor = () => {};
  plugin.registerObsidianProtocolHandler = () => {};
  // Obsidian answers null for a plugin that has never saved, rather than throwing.
  plugin.loadData = async () => {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(`${DIR}/data.json`))) return null;
    return JSON.parse(await adapter.read(`${DIR}/data.json`));
  };
  plugin.saveData = async (d: unknown) =>
    app.vault.adapter.write(`${DIR}/data.json`, JSON.stringify(d));
  return {
    plugin,
    teardown: () => {
      for (const fn of disposers) fn();
      if (typeof plugin.onunload === "function") plugin.onunload();
      Module._load = orig;
      restoreDom();
    },
  };
}

describe("plugin lifecycle", () => {
  it("the built bundle survives onload and onunload against an empty vault", async () => {
    if (!existsSync("build/main.js")) return; // build runs before tests in CI path
    const { plugin, teardown } = await boot(fakeApp());
    try {
      await expect(plugin.onload()).resolves.not.toThrow();
    } finally {
      teardown();
    }
  });

  it("loads into an empty folder beside an old install without touching it", async () => {
    if (!existsSync("build/main.js")) return;
    // The rename case: our folder has no data.json, the pre-rename one does.
    const previous = JSON.stringify({ schemaVersion: 6, titles: [{ id: "a" }, { id: "b" }] });
    const app = fakeApp({ ".obsidian/plugins/watchlog-v4/data.json": previous });
    const { plugin, teardown } = await boot(app);
    try {
      // Must not hang waiting on a human, and must not throw when the prompt
      // cannot render (the mock Modal draws nothing).
      await expect(plugin.onload()).resolves.not.toThrow();
      const files = (app.vault.adapter as any).files as Map<string, string>;
      expect(files.get(".obsidian/plugins/watchlog-v4/data.json")).toBe(previous);
    } finally {
      teardown();
    }
  });
});
