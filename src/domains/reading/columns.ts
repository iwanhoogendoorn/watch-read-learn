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

export const CUSTOM_COLUMN_TYPES: readonly CustomColumnType[] = ["text", "number", "select"];

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
