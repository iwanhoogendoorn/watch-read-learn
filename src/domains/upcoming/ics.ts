/**
 * The Upcoming feed as an iCalendar file (RFC 5545).
 *
 * "Export upcoming to calendar" writes one `.ics` into the vault, built from
 * the same unified rows the Upcoming tab renders — episodes, announced
 * seasons, movie/book/game releases. Anything that can consume an ics file
 * (Apple/Google Calendar, Thunderbird, a phone) can then show air dates next
 * to real-life appointments, which is where "is anything on tonight?" is
 * actually asked.
 *
 * Three properties of the output matter more than they look:
 *
 *   - **All-day events.** Upstream gives dates, not times; a fake 20:00 would
 *     be wrong in every timezone at once. `VALUE=DATE` start with an exclusive
 *     next-day end is the spec's way to say "this day".
 *   - **Stable UIDs.** The UID is derived from source/id/kind/date, so
 *     re-exporting over the old file *updates* events in a subscribed
 *     calendar instead of duplicating them.
 *   - **Real RFC compliance.** CRLF line endings, octet-aware 75-byte line
 *     folding, and TEXT escaping — the cheap shortcuts each break at least
 *     one mainstream parser.
 *
 * Undated rows (a season announced without a date) are skipped: a calendar
 * cannot show what has no date.
 */
import type { UnifiedRow } from "./unified";

/** RFC 5545 §3.3.11 TEXT escaping: backslash first, then structure characters. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 §3.1 folding: no content line longer than 75 octets, continuation
 * lines start with a space. Folding counts bytes, not characters — a summary
 * full of multibyte titles must not overflow — and never splits inside a
 * UTF-8 sequence, because the fold boundary falls between whole characters.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first line may hold 75 octets, continuations 74 (the space costs one).
  let budget = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > budget) {
      out.push(current);
      current = "";
      currentBytes = 0;
      budget = 74;
    }
    current += char;
    currentBytes += size;
  }
  if (current !== "") out.push(current);
  return out.join("\r\n ");
}

/** `2026-08-14` (or a longer ISO string) → `20260814`; null for anything else. */
function basicDate(date: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/** The day after a `YYYYMMDD`, for the exclusive all-day DTEND. */
function nextDay(basic: string): string {
  const y = Number(basic.slice(0, 4));
  const m = Number(basic.slice(4, 6));
  const d = Number(basic.slice(6, 8));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}${mm}${dd}`;
}

/** UTC basic format for DTSTAMP: `20260810T193000Z`. */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** UIDs must survive any title: strip everything that is not plainly safe. */
function uidToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export interface UpcomingIcsOptions {
  now: Date;
  /** X-WR-CALNAME, the display name calendar apps show for the feed. */
  calendarName?: string;
}

export interface UpcomingIcsResult {
  ics: string;
  /** Dated rows that became events; the command reports it. */
  eventCount: number;
  /** Undated rows left out; the command mentions them when non-zero. */
  skippedUndated: number;
}

export function buildUpcomingIcs(
  rows: readonly UnifiedRow[],
  options: UpcomingIcsOptions,
): UpcomingIcsResult {
  const stamp = utcStamp(options.now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WatchReadLearn//Obsidian Plugin//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName ?? "Watch, Read and Learn Upcoming")}`,
  ];

  let eventCount = 0;
  let skippedUndated = 0;
  for (const row of rows) {
    const start = basicDate(row.date);
    if (start === null) {
      skippedUndated += 1;
      continue;
    }

    const summary = row.label === "" ? row.name : `${row.name} — ${row.label}`;
    const description = [row.detail, "Tracked by Watch, Read and Learn."]
      .filter((part) => part !== "")
      .join("\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:watchlog-${uidToken(row.source)}-${uidToken(row.id)}-${uidToken(row.kind)}-${start}@watchlog`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${nextDay(start)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
    eventCount += 1;
  }

  lines.push("END:VCALENDAR");
  return {
    ics: lines.map(foldIcsLine).join("\r\n") + "\r\n",
    eventCount,
    skippedUndated,
  };
}
