/**
 * Copying a list out — as TSV for a spreadsheet, or as a markdown table for a
 * note. Pure, so the export modal's preview counts and the copied text come from
 * the same call.
 *
 * What gets exported is **what is on screen**: the filtered, sorted rows, with
 * the `#` column renumbered from 1. v3 did the same, and it is the behaviour
 * that makes "search, then copy the result" work.
 */
import type { CustomList } from "../../types";
import { editableColumns, filterSortRows, rowName, type SortDir } from "./format";

export interface ExportTable {
  headers: string[];
  rows: string[][];
}

export function buildExportTable(
  list: CustomList,
  query: string,
  sortColumn: string | null,
  direction: SortDir,
): ExportTable {
  const columns = editableColumns(list);
  const headers = ["#", "Name", ...columns.map((column) => column.name)];
  const rows = filterSortRows(list, query, sortColumn, direction).map((row, index) => [
    String(index + 1),
    rowName(row),
    ...columns.map((column) => {
      const value = row[column.id];
      if (value === undefined || value === null) return "";
      if (typeof value === "boolean") return value ? "yes" : "";
      return String(value);
    }),
  ]);
  return { headers, rows };
}

export function toTsv(table: ExportTable): string {
  return [table.headers, ...table.rows].map((row) => row.join("\t")).join("\n");
}

/** A pipe in a cell would split it into two columns; escape it. */
function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

export function toMarkdownTable(table: ExportTable): string {
  const header = `| ${table.headers.map(markdownCell).join(" | ")} |`;
  const rule = `| ${table.headers.map(() => "---").join(" | ")} |`;
  const body = table.rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, rule, ...body].join("\n");
}
