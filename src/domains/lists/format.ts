/**
 * The custom-list file format (SPEC2-PARITY.md §D-EXTRAS; report §2.2).
 *
 * A list is **a note**, not a row in `data.json`. v3 stored one markdown file per
 * list under `settings.customListsFolder`, shaped like this:
 *
 *     # Watched with Dad
 *
 *     ## Notes
 *     free text the user owns
 *
 *     ## Data
 *     ```json
 *     { "columns": [...], "rows": [...], "tabColor": "#8B5CF6", "nameWidth": 220 }
 *     ```
 *
 * That format is the contract, verified against v3's `Jt` class (parse at
 * pretty:16600, serialize at pretty:16667) rather than guessed: `types.ts` §10.3
 * flagged the shape as unverified and handed this lane the job of pinning it
 * down. `tests/fixtures/custom-list-v3.md` is the frozen sample and
 * `tests/lists-format.test.ts` asserts a byte-identical round-trip, so a future
 * edit that would stop v3 (or a hand-written file) from loading fails a test
 * rather than a user's vault.
 *
 * Two naming mismatches are bridged here and nowhere else:
 *
 *   - v3 columns carry `label`, the frozen `CustomListColumn` carries `name`;
 *   - v3 lists carry `tabColor`/`nameWidth`, `CustomList` carries `color` and
 *     nothing for the name column's width.
 *
 * Everything else v3 wrote — `locked`, `autoTime`, `bold`, `italic`,
 * `optionColors`, and any key a later version invents — rides along untouched on
 * the parsed objects and is written back verbatim. Same rule as `data.json`:
 * a version that does not understand a field does not get to delete it.
 *
 * Pure. No vault, no Obsidian — `manager.ts` owns the I/O.
 */
import {
  readExtra,
  writeExtra,
  type CustomList,
  type CustomListColumn,
  type CustomListColumnType,
} from "../../types";

/** The heading the user's own prose lives under. Read back, never rewritten. */
const NOTES_RE = /## Notes\n([\s\S]*?)(?=\n## |\s*$)/;
const DATA_RE = /## Data\n```json\n([\s\S]*?)\n```/;

const COLUMN_TYPES: readonly CustomListColumnType[] = [
  "text",
  "number",
  "select",
  "date",
  "checkbox",
];

/** Keys `CustomListColumn` declares; everything else is a preserved extra. */
const KNOWN_COLUMN_KEYS = new Set(["id", "name", "label", "type", "options", "color", "width"]);

/** Keys the `## Data` object declares; everything else is a preserved extra. */
const KNOWN_LIST_KEYS = new Set([
  "columns",
  "rows",
  "tabColor",
  "nameWidth",
  "dateAdded",
  "dateModified",
]);

export type ParseResult =
  | { ok: true; list: CustomList }
  | /** The JSON block is unreadable. v3 refuses to *save* such a list rather
     * than overwriting it, and so do we: a truncated sync is not permission to
     * throw the file away. */
  { ok: false; reason: "corrupt"; detail: string };

// ---------------------------------------------------------------------------
// Extras
// ---------------------------------------------------------------------------

/** The width of the built-in Name column. v3's `nameWidth`, no v4 field. */
export function nameWidthOf(list: CustomList): number | undefined {
  const value = readExtra<unknown>(list, "nameWidth");
  return typeof value === "number" ? value : undefined;
}

export function setNameWidth(list: CustomList, width: number | undefined): void {
  writeExtra(list, "nameWidth", width);
}

/** The `## Notes` prose. Owned by the user; the plugin only carries it. */
export function notesOf(list: CustomList): string {
  const value = readExtra<unknown>(list, "notes");
  return typeof value === "string" ? value : "";
}

export function setNotes(list: CustomList, notes: string): void {
  writeExtra(list, "notes", notes);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** v3's `col_1`, `col_2`… — the first free slot, so ids stay short and stable. */
export function generateColumnId(columns: readonly CustomListColumn[]): string {
  const taken = new Set(columns.map((c) => c.id));
  let n = 1;
  while (taken.has(`col_${n}`)) n += 1;
  return `col_${n}`;
}

export function generateRowId(rows: readonly Record<string, unknown>[]): string {
  const taken = new Set(rows.map((r) => String(r.id)));
  let n = 1;
  while (taken.has(`row_${n}`)) n += 1;
  return `row_${n}`;
}

/** File name → list id. The file *is* the identity; this is just a handle. */
export function listIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "list" : slug;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function normalizeType(value: unknown): CustomListColumnType {
  return COLUMN_TYPES.includes(value as CustomListColumnType)
    ? (value as CustomListColumnType)
    : "text";
}

/**
 * Key order is preserved on purpose.
 *
 * `label` becomes `name` **in place** rather than being hoisted to the front,
 * because the round-trip test asserts byte equality — and a reordered JSON
 * block is a whole-file diff in the user's vault every time they tick a box.
 */
function toColumn(raw: Record<string, unknown>): CustomListColumn {
  const column = {} as CustomListColumn;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "id") column.id = String(value);
    else if (key === "label" || key === "name") column.name = typeof value === "string" ? value : "";
    else if (key === "type") column.type = normalizeType(value);
    else if (key === "options") {
      if (Array.isArray(value)) column.options = value.map((option) => String(option));
    } else if (key === "color") {
      if (typeof value === "string") column.color = value;
    } else if (key === "width") {
      if (typeof value === "number") column.width = value;
    } else writeExtra(column, key, value);
  }
  if (typeof column.name !== "string") column.name = "";
  if (column.type === undefined) column.type = "text";
  return column;
}

function fromColumn(column: CustomListColumn): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(column as unknown as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (key === "name") out.label = value;
    else out[key] = value;
  }
  if (out.id === undefined) out.id = column.id;
  if (out.label === undefined) out.label = column.name;
  if (out.type === undefined) out.type = column.type;
  return out;
}

/**
 * A column v3 renders but does not let you edit (`#`, `Name`).
 *
 * v3 filtered these out of the editable column list everywhere; the flag is not
 * a v4 concept, so it is read from the preserved extras rather than declared.
 */
export function isLockedColumn(column: CustomListColumn): boolean {
  return readExtra<unknown>(column, "locked") === true;
}

/** The columns the table actually renders and the exporter emits. */
export function editableColumns(list: CustomList): CustomListColumn[] {
  return list.columns.filter((column) => !isLockedColumn(column));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Read one list file.
 *
 * `name` comes from the file's basename — v3 never stored the name inside the
 * file, and the `# Heading` is cosmetic, so renaming is a file rename and
 * nothing else.
 *
 * A file with no `## Data` block is an empty list, not an error: that is what a
 * user gets if they create the note by hand before adding a row.
 */
export function parseCustomList(name: string, text: string): ParseResult {
  const notes = (NOTES_RE.exec(text)?.[1] ?? "").trim();
  const dataText = DATA_RE.exec(text)?.[1];

  const list: CustomList = {
    id: listIdFor(name),
    name,
    columns: [],
    rows: [],
    dateAdded: "",
    dateModified: "",
  };
  setNotes(list, notes);

  if (dataText === undefined) return { ok: true, list };

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch (error) {
    return { ok: false, reason: "corrupt", detail: String(error) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "corrupt", detail: "the data block is not an object" };
  }

  const data = parsed as Record<string, unknown>;

  if (Array.isArray(data.columns)) {
    list.columns = data.columns
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null && "id" in c)
      .map(toColumn);
  }
  if (Array.isArray(data.rows)) {
    list.rows = data.rows.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null && "id" in r,
    );
  }
  if (typeof data.tabColor === "string") list.color = data.tabColor;
  if (typeof data.nameWidth === "number") setNameWidth(list, data.nameWidth);
  if (typeof data.dateAdded === "string") list.dateAdded = data.dateAdded;
  if (typeof data.dateModified === "string") list.dateModified = data.dateModified;
  for (const [key, value] of Object.entries(data)) {
    if (KNOWN_LIST_KEYS.has(key)) continue;
    writeExtra(list, key, value);
  }

  return { ok: true, list };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Write one list file, in v3's byte layout.
 *
 * `dateAdded`/`dateModified` are v4's and are written only when set, so a list
 * that came from v3 round-trips byte-for-byte and v3 can still open it — the
 * keys are additive and its parser ignores what it does not know.
 */
export function serializeCustomList(list: CustomList): string {
  const data: Record<string, unknown> = {
    columns: list.columns.map(fromColumn),
    rows: list.rows,
  };
  if (list.color !== undefined) data.tabColor = list.color;
  const nameWidth = nameWidthOf(list);
  if (nameWidth !== undefined) data.nameWidth = nameWidth;
  if (list.dateAdded !== "") data.dateAdded = list.dateAdded;
  if (list.dateModified !== "") data.dateModified = list.dateModified;
  for (const [key, value] of Object.entries(list as unknown as Record<string, unknown>)) {
    if (KNOWN_LIST_KEYS.has(key)) continue;
    if (key === "id" || key === "name" || key === "color" || key === "notes") continue;
    if (value === undefined) continue;
    data[key] = value;
  }

  const json = JSON.stringify(data, null, 2);
  return `# ${list.name}\n\n## Notes\n${notesOf(list)}\n\n## Data\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/**
 * Replace only the `## Notes` body, leaving the rest of the file byte-identical.
 *
 * The prose is the one part of the file the user writes directly, and a full
 * re-serialize would reformat their JSON block on every keystroke. Returns
 * `null` when the file has no Notes section to write into.
 */
export function replaceNotesSection(text: string, notes: string): string | null {
  const head = "## Notes\n";
  const start = text.indexOf(head);
  if (start === -1) return null;
  const bodyStart = start + head.length;
  const nextHeading = text.indexOf("\n## ", bodyStart);
  // The extra `\n` reproduces the blank line `serializeCustomList` writes, so
  // editing the prose and saving the whole list produce identical files.
  return nextHeading === -1
    ? `${text.slice(0, bodyStart)}${notes}\n`
    : `${text.slice(0, bodyStart)}${notes}\n${text.slice(nextHeading)}`;
}

// ---------------------------------------------------------------------------
// Row helpers (pure; the table and the importer share them)
// ---------------------------------------------------------------------------

/** The Name column's value. v3 keyed it off the bare `name` property. */
export function rowName(row: Record<string, unknown>): string {
  const value = row.name;
  return typeof value === "string" ? value.trim() : "";
}

export function createRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id: generateRowId(rows), name: "" };
}

/** v3's duplicate: a full copy that only differs by id, inserted right below. */
export function duplicateRow(
  rows: Record<string, unknown>[],
  id: string,
): Record<string, unknown> | null {
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return null;
  const copy = { ...rows[index], id: generateRowId(rows) };
  rows.splice(index + 1, 0, copy);
  return copy;
}

export type SortDir = "asc" | "desc";

/**
 * Search then sort, exactly as the table renders it — so the exporter and the
 * table cannot disagree about what "the rows" means.
 *
 * Search matches the Name column only (v3's behaviour). Sorting is a
 * locale-aware string compare on the raw cell, with numbers compared as numbers
 * so `10` does not sort before `9`.
 */
export function filterSortRows(
  list: CustomList,
  query: string,
  sortColumn: string | null,
  direction: SortDir,
): Record<string, unknown>[] {
  let rows = [...list.rows];

  const needle = query.trim().toLowerCase();
  if (needle !== "") {
    rows = rows.filter((row) => rowName(row).toLowerCase().includes(needle));
  }

  if (sortColumn !== null) {
    const numeric =
      sortColumn !== "name" &&
      list.columns.find((c) => c.id === sortColumn)?.type === "number";
    rows.sort((a, b) => {
      const left = a[sortColumn];
      const right = b[sortColumn];
      let cmp: number;
      if (numeric) {
        cmp = (Number(left) || 0) - (Number(right) || 0);
      } else {
        cmp = String(left ?? "")
          .toLowerCase()
          .localeCompare(String(right ?? "").toLowerCase());
      }
      return direction === "asc" ? cmp : -cmp;
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Three-way merge (W8 review P0-2)
// ---------------------------------------------------------------------------

/**
 * Reconcile a local list against a file that changed underneath it.
 *
 * The situation: Watch, Read and Learn loaded a list, the user edited a cell, and between
 * those two moments something else rewrote the file — Obsidian Sync, another
 * device, the user in a markdown pane. Two easy answers are both wrong. Writing
 * ours deletes their rows; refusing loses the edit the user just made and can
 * still be looking at.
 *
 * So this is a real three-way merge, with the baseline — the bytes we loaded
 * from — as the arbiter. That baseline is what makes "row missing locally"
 * distinguishable from "row added remotely", which is the whole difficulty:
 * without it, a deletion and an addition look identical.
 *
 * Rules, per row and per column, keyed by id:
 *   - in baseline, gone locally  → the user deleted it here; drop it
 *   - not in baseline, present locally → a local addition; keep it
 *   - not in baseline, present remotely → a remote addition; keep it
 *   - in both, changed locally → local wins (it is the newer intent)
 *   - in both, unchanged locally → remote wins (they may have edited it)
 */
export interface ListMergeResult {
  list: CustomList;
  /**
   * Fields where both sides changed the *same* key to different values.
   *
   * Each reads `row 2 · where` — enough for the Notice to name what it
   * overrode, because a silent pick is how the user finds out a week later.
   */
  conflicts: string[];
}

export function mergeCustomLists(
  baseline: CustomList | null,
  mine: CustomList,
  theirs: CustomList,
): ListMergeResult {
  const conflicts: string[] = [];
  const merged: CustomList = {
    ...theirs,
    // Columns carry v3 keys this version does not model, so they get the same
    // per-property treatment as rows rather than being replaced wholesale.
    columns: mergeById(
      (baseline?.columns ?? null) as unknown as Record<string, unknown>[] | null,
      mine.columns as unknown as Record<string, unknown>[],
      theirs.columns as unknown as Record<string, unknown>[],
      (c) => String(c["id"] ?? ""),
      conflicts,
      "column",
    ) as unknown as CustomListColumn[],
    rows: mergeById(
      baseline?.rows ?? null,
      mine.rows,
      theirs.rows,
      (r) => String(r["id"] ?? ""),
      conflicts,
      "row",
    ),
  };

  // Scalars follow the same rule: a local change beats the remote value, an
  // untouched local value yields to it.
  const changedLocally = <T>(pick: (list: CustomList) => T): boolean =>
    baseline !== null && pick(mine) !== pick(baseline);
  if (changedLocally((l) => l.name)) merged.name = mine.name;
  if (changedLocally((l) => l.color)) merged.color = mine.color;
  if (changedLocally((l) => notesOf(l))) setNotes(merged, notesOf(mine));
  merged.dateModified = new Date().toISOString();
  return { list: merged, conflicts };
}

/**
 * Merge one object **per property**.
 *
 * Treating a row as an indivisible blob was the bug the re-check found: the user
 * renames a row while sync adds a `where` field to it, both sides "changed the
 * row", and picking either whole object deletes the other's work. Rows and
 * columns are bags of user-defined keys — v3 columns this version does not model
 * included — so the unit of merge has to be the key.
 *
 * Per key, with the baseline as arbiter:
 *
 *   - **unchanged locally** → take the remote value (they may have edited it),
 *     including its *absence*: a key they deleted stays deleted;
 *   - **unchanged remotely** → take the local value, absence included;
 *   - **changed on one side only** (a key neither side had, or one side added) →
 *     that side's value survives;
 *   - **changed on both sides to the same thing** → no conflict, that value;
 *   - **changed on both sides differently** → a true conflict. **Remote wins**,
 *     and the field is reported so the Notice can name it.
 *
 * Remote-wins is chosen deliberately over local-wins: the remote value is
 * already on disk and may be on another device too, whereas the local value is
 * still in front of the user, who can retype it. Losing the copy that is only in
 * one place is the worse failure.
 */
function mergeObjects<T extends Record<string, unknown>>(
  base: T | undefined,
  mine: T,
  theirs: T,
  conflicts: string[],
  label: string,
): T {
  const keys = new Set<string>([
    ...Object.keys(base ?? {}),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ]);
  const out: Record<string, unknown> = {};

  for (const key of keys) {
    const inBase = base !== undefined && key in base;
    const baseValue = inBase ? base[key] : undefined;
    const mineHas = key in mine;
    const theirsHas = key in theirs;
    const mineValue = mine[key];
    const theirsValue = theirs[key];

    const mineChanged = inBase ? !sameJson(mineValue, baseValue) || !mineHas : mineHas;
    const theirsChanged = inBase ? !sameJson(theirsValue, baseValue) || !theirsHas : theirsHas;

    if (!mineChanged) {
      // Untouched locally: whatever they have, including nothing.
      if (theirsHas) out[key] = theirsValue;
      continue;
    }
    if (!theirsChanged) {
      if (mineHas) out[key] = mineValue;
      continue;
    }
    if (sameJson(mineValue, theirsValue)) {
      if (mineHas) out[key] = mineValue;
      continue;
    }
    // Both moved, and to different places.
    conflicts.push(`${label} ${String(mine["id"] ?? theirs["id"] ?? "?")} · ${key}`);
    if (theirsHas) out[key] = theirsValue;
  }

  return out as T;
}

function mergeById<T extends Record<string, unknown>>(
  baseline: readonly T[] | null,
  mine: readonly T[],
  theirs: readonly T[],
  idOf: (item: T) => string,
  conflicts: string[],
  label: string,
): T[] {
  const baseIds = new Set((baseline ?? []).map(idOf));
  const baseById = new Map((baseline ?? []).map((item) => [idOf(item), item]));
  const mineById = new Map(mine.map((item) => [idOf(item), item]));
  const theirsById = new Map(theirs.map((item) => [idOf(item), item]));

  const out: T[] = [];
  const taken = new Set<string>();

  // Remote order first: it is the file's current shape, and a merge that
  // reshuffles somebody's list is its own kind of damage.
  for (const item of theirs) {
    const id = idOf(item);
    // Present in the baseline but gone locally: deleted here, so it goes.
    if (baseIds.has(id) && !mineById.has(id)) {
      taken.add(id);
      continue;
    }
    const local = mineById.get(id);
    if (local === undefined) {
      out.push(item); // a remote addition
    } else {
      // Both sides have this row: merge its fields rather than picking a winner.
      out.push(mergeObjects(baseById.get(id), local, item, conflicts, label));
    }
    taken.add(id);
  }

  // Anything local the remote file has never seen — the edit that started this.
  for (const item of mine) {
    const id = idOf(item);
    if (taken.has(id)) continue;
    if (baseIds.has(id) && !theirsById.has(id)) continue; // deleted remotely
    out.push(item);
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
