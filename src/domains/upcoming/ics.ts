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
 *
 * What an event *says* — its day, its summary, its body — is not decided here.
 * That lives in `event.ts` and is shared with the per-row Google Calendar link,
 * so the two calendar exits from this tab can never describe the same evening
 * under two different names.
 */
import { compactDate, nextCompactDay, upcomingEventFor } from "./event";
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
    const event = upcomingEventFor(row);
    if (event === null) {
      skippedUndated += 1;
      continue;
    }
    const start = compactDate(event.date);
    const { summary, description } = event;

    lines.push(
      "BEGIN:VEVENT",
      `UID:watchlog-${uidToken(row.source)}-${uidToken(row.id)}-${uidToken(row.kind)}-${start}@watchlog`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${nextCompactDay(start)}`,
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
