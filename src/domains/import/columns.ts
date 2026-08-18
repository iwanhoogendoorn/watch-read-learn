/**
 * The small shared vocabulary the CSV-shaped sources need.
 *
 * `data/csv.ts` owns reading a CSV (`parseCsv`) and reading a date
 * (`parseLooseDate`), and both are reused verbatim — a tracker export is still
 * RFC-4180 and its dates are still whatever a spreadsheet emitted. What it does
 * *not* own is looking a column up by name, because its own importer maps
 * columns the other way round (source column → field, edited by the user in a
 * dropdown). A tracker export needs the opposite: the parser knows exactly which
 * column it wants and has to find it, whatever case IMDb shipped it in this year.
 */
import { parseLooseDate } from "../../data/csv";
import type { DateString } from "../../types";

/**
 * Find the index of the first header matching any of `names`.
 *
 * Exact (case- and space-insensitive) across *all* candidates first, then
 * substring. The two passes matter: Simkl ships both `Rating` and
 * `IMDb Rating`-ish columns in places, and a substring pass that ran per
 * candidate would let `"rating"` claim the wrong one before `"your rating"`
 * ever got a turn.
 */
export function findColumn(headers: readonly string[], ...names: string[]): number {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  for (const name of names) {
    const needle = name.trim().toLowerCase();
    const exact = normalized.indexOf(needle);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const needle = name.trim().toLowerCase();
    const loose = normalized.findIndex((header) => header.includes(needle));
    if (loose >= 0) return loose;
  }
  return -1;
}

/** A cell by column index, trimmed. `""` when the column is absent or short. */
export function cell(row: readonly string[], index: number): string {
  if (index < 0) return "";
  return (row[index] ?? "").trim();
}

/**
 * A UTF-8 BOM in front of the header row makes the first column's name start
 * with an invisible character, and every lookup for it then misses. IMDb's
 * export has one; so does anything that has been through Excel.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A four-digit year, or `undefined`. Anything else is not a year. */
export function parseYear(value: string): number | undefined {
  const match = /(\d{4})/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  if (!Number.isFinite(year) || year < 1800 || year > 2200) return undefined;
  return year;
}

/**
 * `YYYY-MM-DD` from anything, including an ISO timestamp.
 *
 * The timestamp case is split out rather than handed to `parseLooseDate`,
 * because `new Date("2024-03-01T23:30:00.000Z").getDate()` is *local* — an
 * evening watch in a positive timezone would come back as the next day, and a
 * watch date that drifts by a day per import is worse than none.
 */
export function parseDateOnly(value: string): DateString | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(text);
  if (iso) return iso[1];
  return parseLooseDate(text) ?? undefined;
}

/** The later of two dates, either of which may be missing. */
export function laterDate(a: DateString | undefined, b: DateString | undefined): DateString | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a >= b ? a : b;
}

/** The earlier of two dates, either of which may be missing. */
export function earlierDate(a: DateString | undefined, b: DateString | undefined): DateString | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

/** An IMDb id (`tt0111161`) or `undefined`; anything else is not one. */
export function parseImdbId(value: string): string | undefined {
  const match = /^(tt\d{5,})$/i.exec(value.trim());
  return match ? (match[1] as string).toLowerCase() : undefined;
}

/** A positive integer id, or `undefined`. `0` is "no id" in every tracker's JSON. */
export function parseNumericId(value: unknown): number | undefined {
  const id = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(id) || id <= 0) return undefined;
  return Math.trunc(id);
}
