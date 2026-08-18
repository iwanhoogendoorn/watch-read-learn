/**
 * "Add to Google Calendar" — one Upcoming row as a pre-filled create-event URL.
 *
 * This is convenience, not capability. The `.ics` export already covers the
 * whole unified feed and covers it better: it is a file a calendar can
 * *subscribe* to, so it keeps updating. What it cannot do is answer "put this
 * one thing in my calendar, now, without a download and a re-import" — and that
 * is the entire job of this module.
 *
 * Three deliberate properties:
 *
 *   - **No auth, no API, no network.** Google's `action=TEMPLATE` endpoint is a
 *     plain GET that opens the create-event form with the fields filled in. The
 *     user is already signed in or is not; either way nothing here holds a
 *     credential.
 *   - **Same event as the `.ics`.** Day, summary and body all come from
 *     `upcomingEventFor`, so the two exits cannot drift apart.
 *   - **Pure.** No DOM, no `window`, no clock — it takes a row and returns a
 *     string, which is what makes the encoding testable. The tab does the
 *     opening.
 *
 * Undated rows get `null`, and the caller renders no button. A link to a
 * create-event form with no date in it is worse than no link: it looks like it
 * worked.
 */
import { compactDate, nextCompactDay, upcomingEventFor } from "./event";
import type { UnifiedRow } from "./unified";

/** Google's create-event endpoint. `action=TEMPLATE` is what pre-fills the form. */
export const GOOGLE_CALENDAR_BASE = "https://calendar.google.com/calendar/render";

/**
 * The URL that opens Google Calendar's create-event form for this row, or
 * `null` when the row has no date.
 *
 * All-day, expressed the way Google's template endpoint wants it: two basic
 * dates separated by a slash, with the end **exclusive** — `20260814/20260815`
 * is Friday the 14th and nothing else. Giving both the same value produces an
 * event Google renders as zero-length, which is the bug this comment exists to
 * stop someone "fixing" the form back into.
 */
export function googleCalendarUrl(row: UnifiedRow): string | null {
  const event = upcomingEventFor(row);
  if (event === null) return null;

  const start = compactDate(event.date);
  // `URLSearchParams` is the whole encoder: `&`, `#`, `+` and spaces in a title
  // are its problem, not ours, and hand-rolled `encodeURIComponent` calls are
  // how a title with an ampersand silently truncates the summary.
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.summary,
    dates: `${start}/${nextCompactDay(start)}`,
    details: event.description,
  });
  return `${GOOGLE_CALENDAR_BASE}?${params.toString()}`;
}

/** The link's accessible name. One place, so the button and its aria agree. */
export function googleCalendarLabel(row: UnifiedRow): string {
  const event = upcomingEventFor(row);
  return event === null
    ? `Add ${row.name} to Google Calendar`
    : `Add ${event.summary} to Google Calendar`;
}
