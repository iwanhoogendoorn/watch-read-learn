/**
 * Custom columns — v3's `bookColumns` / `mangaColumns` (`report-watchlog.md` §1.3).
 *
 * Three types only: `text`, `number` and `select`. A column carries a colour,
 * and `reading.settings.{book,manga}CustomFieldStyle` decides whether that
 * colour fills a chip or just tints the text — both styles are kept because a
 * real vault has both settings written into it.
 *
 * Values live on the row under `customFields[column.id]`, and the id is the
 * identity: renaming a column must not orphan a single cell, which is why
 * nothing in the reading domain ever keys a value by column *name*.
 *
 * Pure: no obsidian, no DOM.
 */
import type { CustomColumn, CustomColumnType } from "../../types";
import type { ReadingEntry } from "./progress";
import { yearOf } from "./viewstate";

export const CUSTOM_COLUMN_TYPES: readonly CustomColumnType[] = ["text", "number", "select"];

// ---------------------------------------------------------------------------
// Built-in columns
// ---------------------------------------------------------------------------

/**
 * A column over a fact the row already carries.
 *
 * **Not** a `CustomColumn`, and deliberately not. A custom column is a field
 * the *user* invented, stored per row under `customFields[id]`. A publication
 * year is neither invented nor stored: it is read off `releaseDate`, the same
 * value the detail screen prints, the decade facet buckets by and
 * `derivedStatus` reads to decide "To be released". Giving it a `customFields`
 * entry would be a second copy of a fact that already exists, free to drift the
 * first time somebody edits the release date — and it would arrive as a column
 * the user could rename, retype and delete, which is not what a year is.
 *
 * What it *does* share with a custom column is being the reader's to switch
 * off, which is why it is declared here and edited in the same modal.
 */
export interface BuiltInColumn {
  id: string;
  name: string;
  /** The cell's text, or `""` when this row cannot answer. */
  value(entry: ReadingEntry): string;
}

/**
 * Every built-in column, in the order they appear after Author.
 *
 * One so far. The list exists rather than a single special case because the
 * next one (page count, date finished) must not need the table rewritten.
 */
export const BUILT_IN_COLUMNS: readonly BuiltInColumn[] = [
  {
    id: "year",
    name: "Year",
    value: (entry) => {
      // `yearOf` is the domain's one answer to "when was this published", and
      // returns `null` for a row with no release date or an unparseable one.
      const year = yearOf(entry);
      return year === null ? "" : String(year);
    },
  },
];

/**
 * The built-ins to draw, given what the reader has switched off.
 *
 * **Exclusion, not inclusion** — the same convention every facet in this domain
 * follows, and the reason it is the right one here too: a built-in added in a
 * later version is visible the moment it exists, instead of being invisible to
 * everybody whose stored list of "columns I want" predates it. It also makes
 * "on by default" fall out for free, since an absent key hides nothing.
 */
export function visibleBuiltInColumns(hidden: readonly string[] = []): BuiltInColumn[] {
  return BUILT_IN_COLUMNS.filter((column) => !hidden.includes(column.id));
}

/** Flip one built-in, returning the new hidden list. Never mutates. */
export function toggleBuiltInColumn(hidden: readonly string[], id: string): string[] {
  return hidden.includes(id) ? hidden.filter((value) => value !== id) : [...hidden, id];
}

/** v3's id shape (`col-1`), continued rather than replaced. */
export function nextColumnId(existing: readonly CustomColumn[]): string {
  let index = existing.length + 1;
  const taken = new Set(existing.map((column) => column.id));
  while (taken.has(`col-${index}`)) index += 1;
  return `col-${index}`;
}

export function createColumn(
  name: string,
  type: CustomColumnType,
  existing: readonly CustomColumn[],
  color = "#7F77DD",
): CustomColumn {
  return { id: nextColumnId(existing), name: name.trim(), type, options: [], color };
}

/**
 * The stored value, coerced to what its column type means.
 *
 * A column that changes type keeps its values — `"12"` under a column that
 * became `number` reads as 12, and a select value that is no longer an option
 * still shows. Dropping data because a type changed is the kind of quiet loss
 * this whole domain is written to avoid.
 */
export function readColumnValue(entry: ReadingEntry, column: CustomColumn): string | number | "" {
  const raw = entry.customFields?.[column.id];
  if (raw === undefined || raw === null) return "";
  if (column.type === "number") {
    const parsed = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    return Number.isFinite(parsed) ? parsed : "";
  }
  return String(raw);
}

/** What the cell shows. Numbers keep their own formatting, text is trimmed. */
export function columnDisplay(entry: ReadingEntry, column: CustomColumn): string {
  const value = readColumnValue(entry, column);
  if (value === "") return "";
  return typeof value === "number" ? String(value) : value.trim();
}

/**
 * The patch for one cell edit.
 *
 * An emptied cell **deletes** the key rather than writing `""`: a row whose
 * `customFields` accumulates empty strings for every column it ever had is how
 * a small library turns into a large file.
 */
export function writeColumnValue(
  entry: ReadingEntry,
  column: CustomColumn,
  raw: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(entry.customFields ?? {}) };
  const text = raw.trim();
  if (text === "") {
    delete next[column.id];
    return next;
  }
  if (column.type === "number") {
    const parsed = Number(text.replace(",", "."));
    next[column.id] = Number.isFinite(parsed) ? parsed : text;
    return next;
  }
  next[column.id] = text;
  return next;
}

/**
 * Every select option that exists — the declared ones plus anything already on
 * a row. A value typed in before an option was removed stays selectable, so the
 * dropdown can never silently rewrite a row it was only meant to display.
 */
export function selectOptions(
  column: CustomColumn,
  entries: readonly ReadingEntry[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of column.options ?? []) {
    const value = option.trim();
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  for (const entry of entries) {
    const value = columnDisplay(entry, column);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** `fill` paints the chip, `text` tints the label. One class either way. */
export function columnStyleClass(style: string): string {
  return style === "text" ? "is-text" : "is-fill";
}

/** Remove a column definition, leaving the values on the rows untouched. */
export function withoutColumn(
  columns: readonly CustomColumn[],
  id: string,
): CustomColumn[] {
  return columns.filter((column) => column.id !== id);
}

export function replaceColumn(
  columns: readonly CustomColumn[],
  next: CustomColumn,
): CustomColumn[] {
  return columns.map((column) => (column.id === next.id ? next : column));
}
