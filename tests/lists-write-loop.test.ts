/**
 * The write-reconcile loop (W8 final, P0-2).
 *
 * Three rejected attempts at this all had the same shape: a check protecting one
 * write, and then a corrective write with no check of its own. The loop exists so
 * there is nothing left to protect *separately* — every list write, initial or
 * corrective, is an iteration of it.
 *
 * These tests hold the properties the structure is for: it retries against a
 * moving file, it never advances the baseline on a losing attempt, it is bounded,
 * and when it gives up it parks the user's version rather than dropping it.
 *
 * The merge itself is atomic — it runs inside `Vault.process` — so the retries
 * below are the defence-in-depth layer: a write that lands *after* the atomic
 * operation completes, which no primitive can prevent and this loop absorbs.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { CustomListManager, ListWriteConflictError } from "../src/domains/lists/manager";
import { parseCustomList, serializeCustomList } from "../src/domains/lists/format";
import type { CustomList } from "../src/types";

const FOLDER = "Watch Read Learn/CustomLists";
const PATH = `${FOLDER}/List.md`;

function fixture(): CustomList {
  return {
    id: "list",
    name: "List",
    columns: [],
    rows: [{ id: "r1", name: "Original" }],
    dateAdded: "2026-08-01T00:00:00.000Z",
    dateModified: "2026-08-01T00:00:00.000Z",
  };
}

/**
 * A vault whose file can be rewritten by "another device" on demand.
 *
 * `onWrite` runs inside `modify`, before the bytes land — which is exactly the
 * window every earlier fix left open.
 */
function harness(options: { onWrite?: (writeNumber: number) => void } = {}) {
  const file = Object.assign(new TFile(), {
    path: PATH,
    basename: "List",
    parent: { path: FOLDER },
  });
  let text = serializeCustomList(fixture());
  let writes = 0;

  const vault = {
    getAbstractFileByPath: (path: string) =>
      path === FOLDER ? { path: FOLDER } : path === PATH ? file : null,
    getFiles: () => [file],
    read: vi.fn(async () => text),
    modify: vi.fn(async (_file: TFile, next: string) => {
      writes += 1;
      options.onWrite?.(writes);
      text = next;
    }),
    create: vi.fn(async (_path: string, next: string) => {
      writes += 1;
      text = next;
      return file;
    }),
    /**
     * Obsidian's atomic read-modify-write, modelled honestly: the callback sees
     * the file as it is when `process` runs, not a snapshot the caller took
     * earlier. Routed through `modify` so a harness that interposes on the write
     * still does.
     */
    process: vi.fn(async (target: TFile, fn: (data: string) => string) => {
      const next = fn(text);
      await vault.modify(target, next);
      return next;
    }),
    createFolder: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  };

  const manager = new CustomListManager(
    { vault, fileManager: { trashFile: vi.fn() } } as never,
    () => FOLDER,
  );
  return {
    manager,
    vault,
    writes: () => writes,
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    /** Add a row to the file as another device would. */
    externalAdd: (id: string) => {
      const parsed = parseCustomList("List", text);
      if (!parsed.ok) throw new Error(parsed.detail);
      parsed.list.rows.push({ id, name: id });
      text = serializeCustomList(parsed.list);
      return text;
    },
  };
}

const rowIds = (text: string): string[] => {
  const parsed = parseCustomList("List", text);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.list.rows.map((row) => String(row["id"]));
};

describe("the loop retries against a file that keeps moving", () => {
  it("keeps a row that raced the first write, and one that raced the correction", async () => {
    // Two consecutive races. The second is the one every previous fix lost,
    // because the corrective write had no protection of its own.
    let raced = 0;
    const h = harness({
      onWrite: (n) => {
        if (n <= 2) {
          const next = h.externalAdd(`remote-${n}`);
          h.manager.noteExternalContent("List", next);
          raced += 1;
        }
      },
    });

    const list = await h.manager.loadList("List");
    list?.rows.push({ id: "local", name: "Mine" });
    await h.manager.saveList(list as CustomList);

    expect(raced).toBe(2);
    const ids = rowIds(h.getText());
    expect(ids).toContain("local");
    expect(ids).toContain("remote-1");
    expect(ids).toContain("remote-2");
  });

  it("does not advance the baseline on a losing attempt", async () => {
    // If it did, the row merged in during attempt 1 would look like "in the
    // baseline, absent remotely" on attempt 2 — a deletion — and vanish.
    const h = harness({
      onWrite: (n) => {
        if (n === 1) {
          const next = h.externalAdd("remote-1");
          h.manager.noteExternalContent("List", next);
        }
      },
    });
    const list = await h.manager.loadList("List");
    list?.rows.push({ id: "local", name: "Mine" });
    await h.manager.saveList(list as CustomList);

    expect(rowIds(h.getText()).sort()).toEqual(["local", "r1", "remote-1"]);
  });

  it("settles in one write when nothing races it", async () => {
    const h = harness();
    const list = await h.manager.loadList("List");
    list?.rows.push({ id: "local", name: "Mine" });
    await h.manager.saveList(list as CustomList);
    expect(h.writes()).toBe(1);
  });

  it("hands the merged result back to the caller's object", async () => {
    // The open tab renders this object; it must not show a version that lost.
    const h = harness({
      onWrite: (n) => {
        if (n === 1) {
          const next = h.externalAdd("remote-1");
          h.manager.noteExternalContent("List", next);
        }
      },
    });
    const list = (await h.manager.loadList("List")) as CustomList;
    list.rows.push({ id: "local", name: "Mine" });
    await h.manager.saveList(list);
    expect(list.rows.map((row) => String(row["id"])).sort()).toEqual(["local", "r1", "remote-1"]);
  });
});

describe("the loop is bounded, and gives up honestly", () => {
  it("stops after the attempt budget and parks both versions", async () => {
    // A device writing continuously: the loop must report rather than spin.
    const h = harness({
      onWrite: (n) => {
        const next = h.externalAdd(`remote-${n}`);
        h.manager.noteExternalContent("List", next);
      },
    });
    const list = await h.manager.loadList("List");
    list?.rows.push({ id: "local", name: "Mine" });

    await expect(h.manager.saveList(list as CustomList)).rejects.toBeInstanceOf(
      ListWriteConflictError,
    );

    // Bounded — not one write per race, forever.
    expect(h.writes()).toBeLessThanOrEqual(5);

    // The other device's version is what is on disk, and every other device
    // will agree with it.
    expect(rowIds(h.getText())).toContain("remote-1");

    // The user's edit is kept, not dropped.
    const record = h.manager.conflictFor("List");
    expect(record).toBeDefined();
    expect(rowIds(record?.localText ?? "")).toContain("local");
    expect(record?.externalText).not.toBe("");
  });

  it("clears the conflict once it has been resolved", async () => {
    const h = harness({
      onWrite: (n) => {
        const next = h.externalAdd(`remote-${n}`);
        h.manager.noteExternalContent("List", next);
      },
    });
    const list = await h.manager.loadList("List");
    list?.rows.push({ id: "local", name: "Mine" });
    await expect(h.manager.saveList(list as CustomList)).rejects.toThrow();

    expect(h.manager.conflicts()).toHaveLength(1);
    h.manager.clearConflict("List");
    expect(h.manager.conflicts()).toHaveLength(0);
  });
});

describe("every write goes through the loop", () => {
  it("creates a new list through it", async () => {
    const h = harness();
    h.vault.getAbstractFileByPath = ((path: string) =>
      path === FOLDER ? { path: FOLDER } : null) as never;
    const created = await h.manager.createList("Fresh");
    expect(created).not.toBeNull();
    expect(h.vault.create).toHaveBeenCalledTimes(1);
  });

  it("splices notes into whatever the file currently holds", async () => {
    const h = harness();
    const list = (await h.manager.loadList("List")) as CustomList;
    // Another device adds a row before the notes are saved.
    h.externalAdd("remote-1");

    await h.manager.saveNotes(list, "my notes");

    const after = parseCustomList("List", h.getText());
    if (!after.ok) throw new Error(after.detail);
    // The prose landed AND the row survived — the notes write does not
    // serialize a stale object over the file.
    expect(h.getText()).toContain("my notes");
    expect(after.list.rows.map((row) => String(row["id"]))).toContain("remote-1");
  });
});
