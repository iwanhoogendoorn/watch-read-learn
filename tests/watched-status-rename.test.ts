/**
 * The one-shot `Completed` → `Watched` status rename (`data/migrate.ts`).
 *
 * The status is not a label — it is a string sitting in `settings.statuses`, on
 * every finished title, in the shelf-visibility map and in every saved filter,
 * inside a `data.json` the user already has. So the interesting cases are not
 * "does the word change" but the four this file is built around:
 *
 *   1. a real vault's shape goes across whole, list and titles together;
 *   2. loading again changes nothing, for ever;
 *   3. a status list the user curated is theirs and is not touched;
 *   4. nothing that *stores* the old name is left pointing at it.
 */
import { describe, expect, it } from "vitest";
import { migrate } from "../src/data/migrate";
import {
  DEFAULT_STATUSES,
  WATCHED_STATUS_RENAME_MARKER,
  createDefaultData,
  createDefaultSettings,
} from "../src/data/schema";
import { STATUS_COMPLETED } from "../src/constants";
import { VISIBLE_SHELVES_KEY, statusShelfId } from "../src/domains/shelves";
import { readExtra, type NamedColor, type WatchLogData } from "../src/types";

/** The name the stock status carried up to 1.21, spelled out on purpose. */
const OLD = "Completed";

type Rec = Record<string, unknown>;

/** The list every vault that predates the rename has. */
function legacyStatuses(): NamedColor[] {
  return [
    { name: "Watching", color: "#1D9E75" },
    { name: "Plan to watch", color: "#00A9A5" },
    { name: OLD, color: "#378ADD" },
    { name: "To be released", color: "#E8873A" },
    { name: "Dropped", color: "#E24B4A" },
  ];
}

/**
 * Iwan's vault, in the shape that matters: 17 titles, 7 of them finished, on
 * the stock status list. Everything else about a real file is irrelevant here
 * and deliberately absent — `migrate` back-fills it.
 */
function realVault(overrides: Rec = {}): Rec {
  const titles = Array.from({ length: 17 }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Title ${i + 1}`,
    type: i % 2 === 0 ? "Movie" : "TV Show",
    status: i < 7 ? OLD : i < 12 ? "Watching" : "Plan to watch",
  }));
  return { schemaVersion: 3, titles, settings: { statuses: legacyStatuses() }, ...overrides };
}

function statusNames(data: WatchLogData): string[] {
  return data.settings.statuses.map((s) => s.name);
}

function countStatus(data: WatchLogData, name: string): number {
  return data.titles.filter((t) => t.status === name).length;
}

describe("the rename, on a real vault's shape", () => {
  const { data, report } = migrate(realVault());

  it("renames the stock status in place, keeping its colour and its position", () => {
    expect(statusNames(data)).toEqual([
      "Watching",
      "Plan to watch",
      STATUS_COMPLETED,
      "To be released",
      "Dropped",
    ]);
    const watched = data.settings.statuses.find((s) => s.name === STATUS_COMPLETED);
    expect(watched?.color).toBe("#378ADD");
  });

  it("moves every title that stood on the old name, and only those", () => {
    expect(countStatus(data, STATUS_COMPLETED)).toBe(7);
    expect(countStatus(data, OLD)).toBe(0);
    expect(countStatus(data, "Watching")).toBe(5);
    expect(countStatus(data, "Plan to watch")).toBe(5);
    expect(data.titles).toHaveLength(17);
  });

  it("leaves no title standing on a name the status list does not have", () => {
    const names = new Set(statusNames(data));
    expect(data.titles.filter((t) => !names.has(t.status))).toEqual([]);
  });

  it("stamps the marker and says what it did", () => {
    expect(readExtra<unknown>(data.settings, WATCHED_STATUS_RENAME_MARKER)).toBe(true);
    expect(report.notes.join(" ")).toContain(STATUS_COMPLETED);
    expect(report.notes.join(" ")).toContain("7 title(s)");
  });

  it("matches the list a fresh install ships", () => {
    expect(statusNames(data)).toEqual(DEFAULT_STATUSES.map((s) => s.name));
  });
});

describe("idempotence — the marker, not the version, is the guard", () => {
  it("changes nothing on a second migrate of its own output", () => {
    const { data: once } = migrate(realVault());
    const snapshot = JSON.stringify(once);
    const { data: twice } = migrate(JSON.parse(snapshot) as Rec);
    expect(JSON.stringify(twice)).toBe(snapshot);
  });

  it("never re-renames a status the user creates after the fact", () => {
    // The exact regression the marker exists for: `migrate()` runs on every
    // load, so "already at v4" proves nothing.
    const { data } = migrate(realVault());
    data.settings.statuses.push({ name: OLD, color: "#123456" });
    data.titles[0]!.status = OLD;

    const { data: again } = migrate(data as unknown as Rec);
    expect(statusNames(again)).toContain(OLD);
    expect(statusNames(again)).toContain(STATUS_COMPLETED);
    expect(again.titles[0]?.status).toBe(OLD);
    expect(countStatus(again, STATUS_COMPLETED)).toBe(6);
  });

  it("stamps the marker even when there was nothing to rename", () => {
    const custom = [
      { name: "Watching", color: "#111111" },
      { name: "Seen", color: "#222222" },
    ];
    const { data } = migrate(realVault({ settings: { statuses: custom } }));
    expect(readExtra<unknown>(data.settings, WATCHED_STATUS_RENAME_MARKER)).toBe(true);
  });

  it("ships the marker already stamped on a fresh install", () => {
    expect(readExtra<unknown>(createDefaultSettings(), WATCHED_STATUS_RENAME_MARKER)).toBe(true);
    expect(createDefaultData().settings.statuses.map((s) => s.name)).toContain(STATUS_COMPLETED);
    expect(createDefaultData().settings.statuses.map((s) => s.name)).not.toContain(OLD);
  });
});

describe("a status list the user curated is theirs", () => {
  it("leaves both alone when the vault already distinguishes them", () => {
    const both = [
      { name: "Watching", color: "#111111" },
      { name: OLD, color: "#222222" },
      { name: STATUS_COMPLETED, color: "#333333" },
    ];
    const raw = realVault({ settings: { statuses: both } });
    (raw.titles as Rec[])[0]!.status = STATUS_COMPLETED;
    const { data, report } = migrate(raw);

    expect(statusNames(data)).toContain(OLD);
    expect(statusNames(data)).toContain(STATUS_COMPLETED);
    // The six other finished titles keep the name they were saved with.
    expect(countStatus(data, OLD)).toBe(6);
    expect(countStatus(data, STATUS_COMPLETED)).toBe(1);
    expect(report.notes.join(" ")).toContain("already has both");
  });

  it("does not invent a rename for a list that renamed the stock entry itself", () => {
    const mine = [
      { name: "Watching", color: "#111111" },
      { name: "Seen", color: "#222222" },
    ];
    const { data } = migrate(realVault({ settings: { statuses: mine } }));
    expect(statusNames(data)).toEqual(["Watching", "Seen", "To be released"]);
    // Their titles are left exactly where the user put them, orphan or not.
    expect(countStatus(data, OLD)).toBe(7);
  });

  it("rehomes titles when the status list itself was unreadable", () => {
    // `migrateSettings` replaces a broken list with the defaults, which now say
    // Watched — so the titles have to follow it or they are stranded on a name
    // no list in this vault has ever had.
    const { data } = migrate(realVault({ settings: { statuses: "not a list" } }));
    expect(statusNames(data)).toEqual(DEFAULT_STATUSES.map((s) => s.name));
    expect(countStatus(data, STATUS_COMPLETED)).toBe(7);
    expect(countStatus(data, OLD)).toBe(0);
  });
});

describe("everywhere the old name was written down", () => {
  it("carries the shelf-visibility answer across to the new key", () => {
    const raw = realVault();
    (raw.settings as Rec)[VISIBLE_SHELVES_KEY] = {
      [statusShelfId(OLD)]: true,
      [statusShelfId("Watching")]: false,
    };
    const { data } = migrate(raw);

    const shelves = readExtra<Record<string, boolean>>(data.settings, VISIBLE_SHELVES_KEY) ?? {};
    expect(shelves[statusShelfId(STATUS_COMPLETED)]).toBe(true);
    expect(statusShelfId(OLD) in shelves).toBe(false);
    // The untouched half of the map is exactly as the user left it.
    expect(shelves[statusShelfId("Watching")]).toBe(false);
  });

  it("carries a hidden status across in the live filter and in saved presets", () => {
    const raw = realVault();
    (raw.settings as Rec).filterState = { excludedStatuses: [OLD, "Dropped"] };
    (raw.settings as Rec).savedPresets = [
      { id: "p1", name: "Unfinished", query: "", filters: { excludedStatuses: [OLD] } },
      { id: "p2", name: "All", query: "", filters: { excludedStatuses: [] } },
    ];
    const { data } = migrate(raw);

    expect(data.settings.filterState.excludedStatuses).toEqual([STATUS_COMPLETED, "Dropped"]);
    expect(data.settings.savedPresets[0]?.filters.excludedStatuses).toEqual([STATUS_COMPLETED]);
    expect(data.settings.savedPresets[1]?.filters.excludedStatuses).toEqual([]);
  });

  it("survives stored answers that are not the shape they should be", () => {
    const raw = realVault();
    (raw.settings as Rec)[VISIBLE_SHELVES_KEY] = "not a map";
    (raw.settings as Rec).savedPresets = [null, 7, { id: "p", name: "P" }];
    expect(() => migrate(raw)).not.toThrow();
  });
});
