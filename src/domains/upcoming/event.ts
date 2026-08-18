/**
 * One Upcoming row, shaped as a calendar event.
 *
 * There are two calendar exits from this tab — the `.ics` file the toolbar
 * writes into the vault, and the per-row "Add to Google Calendar" link — and
 * they must describe the same event. Two copies of "what is this row called and
 * what day is it on" is exactly the kind of duplication that drifts: the `.ics`
 * gains an episode code in its summary, the link does not, and the same evening
 * shows up twice under two names in the same calendar.
 *
 * So the shaping lives here, once, and both exits take it from this module.
 * What each of them does *with* it — RFC 5545 folding, or `URLSearchParams` —
 * is genuinely format-specific and stays where it belongs.
 *
 * Everything here is pure: no DOM, no `window`, no clock.
 */
import type { DateString } from "../../types";
import type { UnifiedRow } from "./unified";

/** A row that can be put in a calendar. */
export interface UpcomingEvent {
  /** `YYYY-MM-DD`. Always present — an undated row produces no event at all. */
  date: DateString;
  /** The event's one-line name. */
  summary: string;
  /** The event's body. Never empty; the provenance line is always there. */
  description: string;
}

/** The line every exported event carries, so its origin is obvious in a calendar. */
export const EVENT_PROVENANCE = "Tracked by Watch, Read and Learn.";

/**
 * A row's date as a plain `YYYY-MM-DD`, or `null`.
 *
 * Accepts a longer ISO string and keeps only the date half — upstream is not
 * consistent about which of the two it hands back, and the time component is
 * never trustworthy anyway (see `ics.ts` on all-day events).
 */
export function calendarDateOf(value: string | null | undefined): DateString | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** `2026-08-14` → `20260814`, the basic format both iCalendar and Google want. */
export function compactDate(date: DateString): string {
  return date.replace(/-/g, "");
}

/**
 * The day after a `YYYYMMDD`.
 *
 * Both formats spell an all-day event as `[start, end)` with an **exclusive**
 * end, so a one-day event ends the following morning. Computed in UTC so no
 * local timezone can roll it backwards over a month boundary.
 */
export function nextCompactDay(basic: string): string {
  const y = Number(basic.slice(0, 4));
  const m = Number(basic.slice(4, 6));
  const d = Number(basic.slice(6, 8));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}${mm}${dd}`;
}

/**
 * The event a row describes, or `null` when it describes none.
 *
 * `null` is the answer for an undated row — a season announced without a date,
 * a game with a "TBA" window. A calendar cannot hold what has no day, and
 * inventing one (today, the epoch, "soon") is worse than leaving it out.
 */
export function upcomingEventFor(row: UnifiedRow): UpcomingEvent | null {
  const date = calendarDateOf(row.date);
  if (date === null) return null;

  const label = row.label ?? "";
  const summary = label === "" ? row.name : `${row.name} — ${label}`;
  const description = [row.detail ?? "", EVENT_PROVENANCE]
    .filter((part) => part !== "")
    .join("\n");

  return { date, summary, description };
}
