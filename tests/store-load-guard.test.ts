/**
 * The torn-read guard (data/store.ts `load`).
 *
 * The incident it pins: a reload while the old instance's flush was still
 * writing handed the new instance a `loadData()` of null; that read as "fresh
 * install", the v0→v4 migration ran, and its auto-save wrote an empty library
 * over the real file. `loadData()` returning null must never be believed
 * while a data.json with content sits on disk.
 */
import { describe, expect, it } from "vitest";
import { WatchLogStore } from "../src/data/store";
import { createTitle } from "../src/data/schema";

function fakePlugin(options: {
  loadData: unknown;
  fileText?: string | null;
  readThrows?: boolean;
}) {
  return {
    manifest: { id: "watchlog", dir: ".obsidian/plugins/watchlog" },
    app: {
      vault: {
        adapter: {
          exists: async () => options.fileText !== undefined && options.fileText !== null,
          read: async () => {
            if (options.readThrows) throw new Error("EBUSY");
            return options.fileText ?? "";
          },
        },
      },
    },
    loadData: async () => options.loadData,
    saveData: async () => undefined,
  } as never;
}

function realFileText(): string {
  return JSON.stringify({
    schemaVersion: 4,
    titles: [createTitle({ id: "kept", title: "Kept", type: "Movie" })],
    settings: {},
    history: [],
  });
}

describe("load: loadData() null with a real file on disk", () => {
  it("recovers the actual data by reading the file itself", async () => {
    const store = new WatchLogStore(
      fakePlugin({ loadData: null, fileText: realFileText() }),
    );
    await store.load();
    expect(store.allTitles().length).toBe(1);
    expect(store.migrationReport?.reset).toBe(false);
  });

  it("gates instead of wiping when the file exists but cannot be parsed", async () => {
    const store = new WatchLogStore(fakePlugin({ loadData: null, fileText: '{"titles": [tru' }));
    await store.load();
    expect(store.allTitles().length).toBe(0);
    // reset=true is what makes onload refuse to write and open the gate.
    expect(store.migrationReport?.reset).toBe(true);
  });

  it("gates when the file exists but cannot even be read", async () => {
    const store = new WatchLogStore(
      fakePlugin({ loadData: null, fileText: "anything", readThrows: true }),
    );
    await store.load();
    expect(store.migrationReport?.reset).toBe(true);
  });

  it("still treats a genuinely fresh install as fresh", async () => {
    const store = new WatchLogStore(fakePlugin({ loadData: null, fileText: null }));
    await store.load();
    expect(store.migrationReport?.reset).toBe(false);
    expect(store.migrationReport?.fromVersion).toBe(0);
  });

  it("an empty-object file is a fresh install too, not a gate", async () => {
    const store = new WatchLogStore(fakePlugin({ loadData: null, fileText: "{}" }));
    await store.load();
    expect(store.migrationReport?.reset).toBe(false);
  });
});
