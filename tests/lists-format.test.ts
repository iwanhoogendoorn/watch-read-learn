/**
 * Custom lists: the v3 file format (SPEC2-PARITY.md §D-EXTRAS, item 1).
 *
 * `types.ts` §10.3 shipped `CustomList` with an explicit warning that the
 * on-disk shape was **unverified**, and handed this lane the job of pinning it
 * down against what v3 actually writes. `tests/fixtures/custom-list-v3.md` is
 * that pin: a file in v3's exact layout, carrying the per-column keys v4 has no
 * field for (`optionColors`, `autoTime`, `bold`, `italic`) and a `checked` row
 * flag it also does not model.
 *
 * The load-bearing assertion is the round trip. Parse it, serialize it, and the
 * bytes have to come back identical — because the moment they do not, opening a
 * v3 list in v4 and touching one cell silently rewrites the file into something
 * v3 can no longer read, and the user finds out weeks later.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRow,
  duplicateRow,
  editableColumns,
  filterSortRows,
  generateColumnId,
  generateRowId,
  isLockedColumn,
  nameWidthOf,
  notesOf,
  parseCustomList,
  replaceNotesSection,
  rowName,
  serializeCustomList,
} from "../src/domains/lists/format";
import { buildExportTable, toMarkdownTable, toTsv } from "../src/domains/lists/export";
import { analyseTsv, applyTsv, parseTsv } from "../src/domains/lists/modals";
import { readExtra, type CustomList } from "../src/types";

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/custom-list-v3.md",
);
const TEXT = readFileSync(FIXTURE, "utf8");

function load(): CustomList {
  const result = parseCustomList("Rainy Sunday", TEXT);
  if (!result.ok) throw new Error(`fixture did not parse: ${result.detail}`);
  return result.list;
}

// ---------------------------------------------------------------------------
// Reading what v3 wrote
// ---------------------------------------------------------------------------

describe("parsing a v3 list file", () => {
  it("reads the name, notes, colour and name-column width", () => {
    const list = load();
    expect(list.name).toBe("Rainy Sunday");
    expect(list.id).toBe("rainy-sunday");
    expect(notesOf(list)).toBe(
      "Things to put on when it is grey out. Keep the short ones near the top.",
    );
    expect(list.color).toBe("#8B5CF6");
    expect(nameWidthOf(list)).toBe(240);
  });

  it("maps v3's `label` onto the frozen `name` field", () => {
    const [first, second, third] = load().columns;
    expect(first?.name).toBe("Where");
    expect(second?.name).toBe("Runtime");
    expect(third?.name).toBe("Who suggested it");
  });

  it("keeps the declared column fields", () => {
    const [where, runtime] = load().columns;
    expect(where?.type).toBe("select");
    expect(where?.options).toEqual(["Plex", "Cinema", "Nowhere"]);
    expect(where?.width).toBe(160);
    expect(runtime?.type).toBe("number");
  });

  it("carries per-column keys v4 has never heard of", () => {
    const [where, runtime, who] = load().columns;
    expect(readExtra(where!, "optionColors")).toEqual({ Plex: "#3B82F6", Cinema: "#EC4899" });
    expect(readExtra(runtime!, "autoTime")).toBe(true);
    expect(readExtra(who!, "italic")).toBe(true);
  });

  it("keeps rows verbatim, including the tick flag", () => {
    const rows = load().rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: "row_1",
      name: "Paddington 2",
      col_1: "Plex",
      col_2: 103,
      col_3: "Marta",
      checked: true,
    });
    // A row with no value for a column simply has no key for it.
    expect(rows[2]).toEqual({ id: "row_3", name: "Arrival", col_2: 116 });
  });

  it("treats a file with no data block as an empty list, not an error", () => {
    const result = parseCustomList("Bare", "# Bare\n\n## Notes\nnothing yet\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.columns).toEqual([]);
    expect(result.list.rows).toEqual([]);
    expect(notesOf(result.list)).toBe("nothing yet");
  });

  it("reports a broken JSON block rather than reading it as empty", () => {
    const broken = TEXT.replace('"tabColor": "#8B5CF6",', '"tabColor": ,');
    const result = parseCustomList("Rainy Sunday", broken);
    expect(result.ok).toBe(false);
    // The caller refuses to overwrite it — an empty parse here would look like
    // a list whose rows just vanished.
  });

  it("skips malformed columns and rows instead of failing the whole file", () => {
    const text = [
      "# Odd",
      "",
      "## Notes",
      "",
      "",
      "## Data",
      "```json",
      JSON.stringify({
        columns: [{ id: "col_1", label: "Fine", type: "text" }, { label: "no id" }, 42],
        rows: [{ id: "row_1", name: "kept" }, { name: "no id" }, null],
      }),
      "```",
      "",
    ].join("\n");
    const result = parseCustomList("Odd", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.list.columns).toHaveLength(1);
    expect(result.list.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Writing it back
// ---------------------------------------------------------------------------

describe("round trip", () => {
  it("re-serializes a v3 file byte for byte", () => {
    expect(serializeCustomList(load())).toBe(TEXT);
  });

  it("survives a second pass unchanged", () => {
    const once = serializeCustomList(load());
    const result = parseCustomList("Rainy Sunday", once);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serializeCustomList(result.list)).toBe(once);
  });

  it("writes v4's timestamps only when a list actually has them", () => {
    // A v3 file has none, and inventing them would change its bytes.
    expect(serializeCustomList(load())).not.toContain("dateAdded");

    const list = load();
    list.dateAdded = "2026-08-03T10:00:00.000Z";
    list.dateModified = "2026-08-03T10:00:00.000Z";
    const text = serializeCustomList(list);
    expect(text).toContain('"dateAdded": "2026-08-03T10:00:00.000Z"');

    // …and v3 still ignores them, so the parse comes back the same either way.
    const back = parseCustomList("Rainy Sunday", text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.list.rows).toEqual(list.rows);
    expect(back.list.dateAdded).toBe("2026-08-03T10:00:00.000Z");
  });

  it("keeps an unknown top-level key from a future version", () => {
    const text = TEXT.replace('"tabColor"', '"someFutureKey": {"a":1},\n  "tabColor"');
    const result = parseCustomList("Rainy Sunday", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readExtra(result.list, "someFutureKey")).toEqual({ a: 1 });
    expect(serializeCustomList(result.list)).toContain("someFutureKey");
  });
});

describe("replaceNotesSection", () => {
  it("rewrites only the prose", () => {
    const next = replaceNotesSection(TEXT, "new prose");
    expect(next).not.toBeNull();
    expect(next).toContain("## Notes\nnew prose\n\n## Data");
    expect(next).toContain('"tabColor": "#8B5CF6"');
  });

  it("returns null when there is no Notes section to write into", () => {
    expect(replaceNotesSection("# Bare\n", "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The table's own behaviour
// ---------------------------------------------------------------------------

describe("ids", () => {
  it("fills the first free slot, v3-style", () => {
    expect(generateColumnId(load().columns)).toBe("col_4");
    expect(generateRowId(load().rows)).toBe("row_4");
    expect(generateRowId([{ id: "row_2" }])).toBe("row_1");
  });
});

describe("rows", () => {
  it("duplicates a row below itself with a fresh id", () => {
    const list = load();
    const copy = duplicateRow(list.rows, "row_1");
    expect(copy?.id).toBe("row_4");
    expect(list.rows[1]?.id).toBe("row_4");
    expect(rowName(list.rows[1]!)).toBe("Paddington 2");
    // Everything else is carried over — that is the point of duplicating.
    expect(list.rows[1]?.col_2).toBe(103);
  });

  it("returns null for a row that is not there", () => {
    expect(duplicateRow(load().rows, "row_99")).toBeNull();
  });

  it("creates an empty row with the next id", () => {
    expect(createRow(load().rows)).toEqual({ id: "row_4", name: "" });
  });
});

describe("search and sort", () => {
  it("searches the name column only", () => {
    const list = load();
    expect(filterSortRows(list, "sea", null, "asc").map(rowName)).toEqual(["The Sea Beast"]);
    // "Marta" is in col_3, not the name — v3 did not search cells either.
    expect(filterSortRows(list, "marta", null, "asc")).toHaveLength(0);
  });

  it("sorts a number column numerically, not lexically", () => {
    const list = load();
    list.rows.push({ id: "row_9", name: "Short", col_2: 9 });
    const order = filterSortRows(list, "", "col_2", "asc").map(rowName);
    expect(order[0]).toBe("Short");
  });

  it("sorts text case-insensitively and reverses on desc", () => {
    const list = load();
    const asc = filterSortRows(list, "", "name", "asc").map(rowName);
    expect(asc).toEqual(["Arrival", "Paddington 2", "The Sea Beast"]);
    expect(filterSortRows(list, "", "name", "desc").map(rowName)).toEqual([...asc].reverse());
  });

  it("leaves the file order alone when nothing is sorted", () => {
    expect(filterSortRows(load(), "", null, "asc").map(rowName)).toEqual([
      "Paddington 2",
      "The Sea Beast",
      "Arrival",
    ]);
  });
});

describe("locked columns", () => {
  it("are hidden from the editable set", () => {
    const list = load();
    list.columns.push({ id: "col_9", name: "#", type: "text" });
    Object.assign(list.columns[list.columns.length - 1]!, { locked: true });
    expect(isLockedColumn(list.columns[list.columns.length - 1]!)).toBe(true);
    expect(editableColumns(list).map((column) => column.name)).toEqual([
      "Where",
      "Runtime",
      "Who suggested it",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Copy out, paste in
// ---------------------------------------------------------------------------

describe("export", () => {
  it("exports what is on screen, renumbered from 1", () => {
    const table = buildExportTable(load(), "sea", null, "asc");
    expect(table.headers).toEqual(["#", "Name", "Where", "Runtime", "Who suggested it"]);
    expect(table.rows).toEqual([["1", "The Sea Beast", "Nowhere", "115", "Dad"]]);
  });

  it("renders TSV and markdown from the same table", () => {
    const table = buildExportTable(load(), "arrival", null, "asc");
    expect(toTsv(table).split("\n")[1]).toBe("1\tArrival\t\t116\t");
    expect(toMarkdownTable(table).split("\n")[1]).toBe("| --- | --- | --- | --- | --- |");
  });

  it("escapes a pipe so it cannot split a markdown cell", () => {
    const list = load();
    list.rows[0]!.col_3 = "Marta | Dad";
    const table = buildExportTable(list, "paddington", null, "asc");
    expect(toMarkdownTable(table)).toContain("Marta \\| Dad");
  });
});

describe("import", () => {
  it("appends rows, matching columns left to right", () => {
    const list = load();
    const parsed = parseTsv("Name\tWhere\tRuntime\nDune\tCinema\t155", true);
    expect(parsed).not.toBeNull();
    const analysis = analyseTsv(list, parsed!);
    expect(analysis).not.toBeNull();
    expect(analysis!.rowCount).toBe(1);
    expect(analysis!.newColumns).toBe(0);

    expect(applyTsv(list, analysis!)).toBe(1);
    const added = list.rows[list.rows.length - 1]!;
    expect(added.name).toBe("Dune");
    expect(added.col_2).toBe(155);
    // A number column is stored as a number, not the pasted string.
    expect(typeof added.col_2).toBe("number");
  });

  it("flags a number column receiving text, and refuses to guess", () => {
    const analysis = analyseTsv(load(), parseTsv("Name\tWhere\tRuntime\nDune\tCinema\tages", true)!);
    expect(analysis?.numberConflicts).toEqual(["Runtime"]);
  });

  it("reports the select options a paste would invent", () => {
    const analysis = analyseTsv(load(), parseTsv("Name\tWhere\nDune\tDrive-in", true)!);
    expect(analysis?.selectAdditions).toEqual([{ label: "Where", values: ["Drive-in"] }]);
  });

  it("adds those options rather than dropping the values", () => {
    const list = load();
    const analysis = analyseTsv(list, parseTsv("Name\tWhere\nDune\tDrive-in", true)!);
    applyTsv(list, analysis!);
    expect(list.columns[0]?.options).toContain("Drive-in");
    expect(list.rows[list.rows.length - 1]?.col_1).toBe("Drive-in");
  });

  it("creates text columns for data wider than the table", () => {
    const list = load();
    const analysis = analyseTsv(
      list,
      parseTsv("Name\tWhere\tRuntime\tWho\tMood\nDune\tCinema\t155\tMe\tEpic", true)!,
    );
    expect(analysis?.newColumns).toBe(1);
    applyTsv(list, analysis!);
    const created = list.columns[list.columns.length - 1]!;
    expect(created.name).toBe("Mood");
    expect(created.type).toBe("text");
    expect(list.rows[list.rows.length - 1]?.[created.id]).toBe("Epic");
  });

  it("treats every line as data when the header box is unticked", () => {
    const parsed = parseTsv("Dune\tCinema\nArrival\tPlex", false);
    expect(parsed?.header).toEqual([]);
    expect(parsed?.dataRows).toHaveLength(2);
  });
});
