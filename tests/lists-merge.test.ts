/**
 * The custom-list three-way merge (W8 re-check, P0-2).
 *
 * Two rewrites of this got rejected, and both for the same reason: the unit of
 * merge was too coarse. Picking a whole file loses a row; picking a whole row
 * loses a field. Rows and columns are bags of user-defined keys — including v3
 * keys this version does not model — so the unit is the key, and these tests
 * hold it there.
 */
import { describe, expect, it } from "vitest";
import { mergeCustomLists, notesOf, setNotes } from "../src/domains/lists/format";
import type { CustomList } from "../src/types";

function list(rows: Record<string, unknown>[], extra: Partial<CustomList> = {}): CustomList {
  return {
    id: "l",
    name: "List",
    columns: [],
    rows,
    dateAdded: "2026-08-01T00:00:00.000Z",
    dateModified: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

const merge = (
  base: CustomList | null,
  mine: CustomList,
  theirs: CustomList,
): { rows: Record<string, unknown>[]; conflicts: string[]; list: CustomList } => {
  const result = mergeCustomLists(base, mine, theirs);
  return { rows: result.list.rows, conflicts: result.conflicts, list: result.list };
};

describe("merging one row, field by field", () => {
  it("keeps edits both sides made to different fields", () => {
    // The case the re-check rejected: whole-object selection deleted `where`.
    const base = list([{ id: "r1", name: "Arrival" }]);
    const mine = list([{ id: "r1", name: "Arrival — local" }]);
    const theirs = list([{ id: "r1", name: "Arrival", where: "Cinema" }]);

    const { rows, conflicts } = merge(base, mine, theirs);
    expect(rows[0]).toEqual({ id: "r1", name: "Arrival — local", where: "Cinema" });
    expect(conflicts).toEqual([]);
  });

  it("takes the remote value for a field the user did not touch", () => {
    const base = list([{ id: "r1", name: "A", note: "old" }]);
    const mine = list([{ id: "r1", name: "A local", note: "old" }]);
    const theirs = list([{ id: "r1", name: "A", note: "theirs" }]);
    expect(merge(base, mine, theirs).rows[0]).toEqual({
      id: "r1",
      name: "A local",
      note: "theirs",
    });
  });

  it("honours a deletion on either side", () => {
    const base = list([{ id: "r1", name: "A", note: "gone soon", other: "x" }]);
    const mine = list([{ id: "r1", name: "A", other: "x" }]); // dropped `note`
    const theirs = list([{ id: "r1", name: "A", note: "gone soon" }]); // dropped `other`

    const row = merge(base, mine, theirs).rows[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("note"); // deleted locally
    expect(row).not.toHaveProperty("other"); // deleted remotely
  });

  it("is silent when both sides made the same edit", () => {
    const base = list([{ id: "r1", name: "A" }]);
    const same = list([{ id: "r1", name: "B" }]);
    const { rows, conflicts } = merge(base, same, list([{ id: "r1", name: "B" }]));
    expect(rows[0]).toEqual({ id: "r1", name: "B" });
    expect(conflicts).toEqual([]);
  });

  it("resolves a true conflict remotely, and names the field", () => {
    // Remote wins deliberately: their value is already on disk and may be on
    // another device, while the local one is still in front of the user.
    const base = list([{ id: "r1", name: "A" }]);
    const { rows, conflicts } = merge(
      base,
      list([{ id: "r1", name: "mine" }]),
      list([{ id: "r1", name: "theirs" }]),
    );
    expect(rows[0]).toEqual({ id: "r1", name: "theirs" });
    expect(conflicts).toEqual(["row r1 · name"]);
  });

  it("keeps a field only one side ever had", () => {
    const base = list([{ id: "r1", name: "A" }]);
    const { rows } = merge(
      base,
      list([{ id: "r1", name: "A", mineOnly: 1 }]),
      list([{ id: "r1", name: "A", theirsOnly: 2 }]),
    );
    expect(rows[0]).toEqual({ id: "r1", name: "A", mineOnly: 1, theirsOnly: 2 });
  });
});

describe("merging the rows of a list", () => {
  it("keeps additions from both sides", () => {
    const base = list([{ id: "r1", name: "A" }]);
    const { rows } = merge(
      base,
      list([{ id: "r1", name: "A" }, { id: "local", name: "L" }]),
      list([{ id: "r1", name: "A" }, { id: "remote", name: "R" }]),
    );
    expect(rows.map((r) => r["id"])).toEqual(["r1", "remote", "local"]);
  });

  it("honours a row deleted on either side", () => {
    const base = list([{ id: "r1" }, { id: "r2" }]);
    expect(
      merge(base, list([{ id: "r1" }]), list([{ id: "r1" }, { id: "r2" }])).rows.map((r) => r["id"]),
    ).toEqual(["r1"]);
    expect(
      merge(base, list([{ id: "r1" }, { id: "r2" }]), list([{ id: "r1" }])).rows.map((r) => r["id"]),
    ).toEqual(["r1"]);
  });

  it("keeps the file's row order, not the local one", () => {
    // A merge that reshuffles somebody's list is its own kind of damage.
    const base = list([{ id: "a" }, { id: "b" }]);
    const { rows } = merge(base, list([{ id: "b" }, { id: "a" }]), list([{ id: "a" }, { id: "b" }]));
    expect(rows.map((r) => r["id"])).toEqual(["a", "b"]);
  });

  it("treats columns the same way, including keys v4 does not model", () => {
    const base = list([], {
      columns: [{ id: "c1", name: "Where", type: "text", label: "v3 label" } as never],
    });
    const mine = list([], {
      columns: [{ id: "c1", name: "Where to", type: "text", label: "v3 label" } as never],
    });
    const theirs = list([], {
      columns: [{ id: "c1", name: "Where", type: "text", label: "v3 label", width: 200 } as never],
    });

    const merged = mergeCustomLists(base, mine, theirs);
    expect(merged.list.columns[0]).toMatchObject({
      name: "Where to", // local rename
      label: "v3 label", // untouched v3 key survives
      width: 200, // remote addition
    });
  });
});

describe("merging the list's own fields", () => {
  it("keeps a local rename and a remote colour", () => {
    const base = list([], { name: "Old", color: "#111111" });
    const mine = list([], { name: "New", color: "#111111" });
    const theirs = list([], { name: "Old", color: "#222222" });
    const merged = mergeCustomLists(base, mine, theirs).list;
    expect(merged.name).toBe("New");
    expect(merged.color).toBe("#222222");
  });

  it("keeps locally edited notes over untouched remote ones", () => {
    const base = list([]);
    setNotes(base, "before");
    const mine = list([]);
    setNotes(mine, "after");
    const theirs = list([]);
    setNotes(theirs, "before");
    expect(notesOf(mergeCustomLists(base, mine, theirs).list)).toBe("after");
  });

  it("survives having no baseline at all", () => {
    // A list loaded before this version started remembering bytes: nothing to
    // arbitrate with, so the merge keeps everything from both sides.
    const { rows } = merge(
      null,
      list([{ id: "r1", name: "mine" }]),
      list([{ id: "r2", name: "theirs" }]),
    );
    expect(rows.map((r) => r["id"]).sort()).toEqual(["r1", "r2"]);
  });
});
