/**
 * First-run adoption after the rename.
 *
 * The dangerous direction is a false positive: adopting something that is not
 * ours, or adopting when we already hold data, either way overwrites a real
 * library. Most of what follows is about refusing.
 */
import { describe, expect, it } from "vitest";
import {
  countAdoptable,
  describeCounts,
  pluginsDirOf,
  scanForAdoptable,
  totalItems,
  type AdoptionCounts,
} from "../src/data/adopt";

const DIR = ".obsidian/plugins/watch-read-learn";

/** Adapter over an in-memory file map; `null` contents make reads throw. */
function adapter(files: Record<string, string | null>) {
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    api: {
      exists: async (p: string) => Object.prototype.hasOwnProperty.call(files, p),
      read: async (p: string) => {
        reads.push(p);
        const v = files[p];
        if (v === null || v === undefined) throw new Error("unreadable");
        return v;
      },
      write: async (p: string) => {
        writes.push(p);
      },
    } as never,
  };
}

const LIBRARY = JSON.stringify({
  schemaVersion: 6,
  titles: [{ id: "a" }, { id: "b" }],
  reading: { books: [{ id: "c" }], manga: [] },
  games: { games: [] },
});

describe("recognising a file worth adopting", () => {
  it("counts every domain it finds", () => {
    const counts = countAdoptable(LIBRARY);
    expect(counts).toEqual({ titles: 2, books: 1, manga: 0, games: 0, lists: 0 });
    expect(totalItems(counts as AdoptionCounts)).toBe(3);
  });

  it("accepts a v3 file, which has titles but no schema version", () => {
    expect(countAdoptable(JSON.stringify({ titles: [{ id: "a" }] }))).not.toBeNull();
  });

  it("refuses another plugin's data rather than offering to import it", () => {
    expect(countAdoptable(JSON.stringify({ folder: "x", theme: "dark" }))).toBeNull();
  });

  it("refuses anything that is not a JSON object", () => {
    expect(countAdoptable("not json")).toBeNull();
    expect(countAdoptable("[1,2,3]")).toBeNull();
    expect(countAdoptable("null")).toBeNull();
  });

  it("survives fields that are the wrong type instead of trusting them", () => {
    const counts = countAdoptable(JSON.stringify({ titles: "lots", reading: 7, schemaVersion: 6 }));
    expect(counts).toEqual({ titles: 0, books: 0, manga: 0, games: 0, lists: 0 });
  });
});

describe("locating the previous install", () => {
  it("derives the plugins directory from our own folder", () => {
    expect(pluginsDirOf(DIR)).toBe(".obsidian/plugins");
    expect(pluginsDirOf(".obsidian/plugins/watch-read-learn/")).toBe(".obsidian/plugins");
    expect(pluginsDirOf("watch-read-learn")).toBeNull();
  });

  it("finds the old folder and reads it once", async () => {
    const a = adapter({ ".obsidian/plugins/watchlog-v4/data.json": LIBRARY });
    const { candidate } = await scanForAdoptable(a.api, DIR, "watch-read-learn");
    expect(candidate?.folder).toBe("watchlog-v4");
    expect(candidate?.raw).toBe(LIBRARY);
    expect(a.reads).toEqual([".obsidian/plugins/watchlog-v4/data.json"]);
  });

  it("prefers the install that actually has entries over an empty one", async () => {
    const a = adapter({
      ".obsidian/plugins/watchlog-v4/data.json": JSON.stringify({ titles: [] }),
      ".obsidian/plugins/watchlog/data.json": LIBRARY,
    });
    const { candidate, all } = await scanForAdoptable(a.api, DIR, "watch-read-learn");
    expect(all).toHaveLength(2);
    expect(candidate?.folder).toBe("watchlog");
  });

  it("never adopts from itself", async () => {
    const a = adapter({ ".obsidian/plugins/watchlog/data.json": LIBRARY });
    const { candidate } = await scanForAdoptable(a.api, ".obsidian/plugins/watchlog", "watchlog");
    expect(candidate).toBeNull();
  });

  it("skips a folder it cannot read instead of failing the whole scan", async () => {
    const a = adapter({
      ".obsidian/plugins/watchlog-v4/data.json": null,
      ".obsidian/plugins/watchlog/data.json": LIBRARY,
    });
    const { candidate } = await scanForAdoptable(a.api, DIR, "watch-read-learn");
    expect(candidate?.folder).toBe("watchlog");
  });

  it("reports nothing when no old folder exists", async () => {
    const a = adapter({});
    const { candidate } = await scanForAdoptable(a.api, DIR, "watch-read-learn");
    expect(candidate).toBeNull();
  });

  it("writes nothing, ever", async () => {
    const a = adapter({ ".obsidian/plugins/watchlog-v4/data.json": LIBRARY });
    await scanForAdoptable(a.api, DIR, "watch-read-learn");
    expect(a.writes).toEqual([]);
  });
});

describe("what the prompt says", () => {
  const counts = (over: Partial<AdoptionCounts>): AdoptionCounts => ({
    titles: 0,
    books: 0,
    manga: 0,
    games: 0,
    lists: 0,
    ...over,
  });

  it("names only the domains that have something", () => {
    expect(describeCounts(counts({ titles: 8, books: 6 }))).toBe("8 films and TV shows and 6 books");
  });

  it("uses commas for three or more", () => {
    expect(describeCounts(counts({ titles: 2, books: 1, games: 3 }))).toBe(
      "2 films and TV shows, 1 book and 3 games",
    );
  });

  it("gets singulars right", () => {
    expect(describeCounts(counts({ books: 1 }))).toBe("1 book");
  });

  it("says so when there is nothing", () => {
    expect(describeCounts(counts({}))).toBe("no entries");
  });
});
