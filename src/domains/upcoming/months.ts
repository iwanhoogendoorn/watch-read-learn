/**
 * The compact Upcoming layout's model — month grouping, a split countdown, and
 * a *derived* cadence phrase.
 *
 * The default layout groups by relative time ("Today", "This week", "Later"),
 * which answers "what do I do tonight". This one groups by calendar month, which
 * answers a different question — "what does the rest of the year look like" —
 * and that is the only reason it exists as a second grouping rather than a
 * restyle of the first. Both are pure functions over the same unified rows, so
 * neither can drift from what the tab actually renders.
 *
 * Three rules the whole module is built on:
 *
 *   - **No locale calls.** `toLocaleDateString` gives a different string per
 *     host, which makes a heading untestable and a screenshot unreproducible.
 *     The month and weekday names are tables, exactly as the rest of the plugin
 *     formats dates (`components/dates.ts`).
 *   - **Undated rows are a group, not a gap.** A season announced without a date
 *     has no month; it gets its own trailing group rather than being dropped or
 *     filed under whatever month is convenient.
 *   - **Cadence is evidence, never a guess.** See `cadenceFor`.
 */
import type { TitleV4 } from "../../types";
import type { UnifiedRow } from "./unified";

export const MONTH_NAMES: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const WEEKDAY_NAMES: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The trailing group's heading. The same words the `tba` bucket uses. */
export const UNDATED_MONTH_LABEL = "Announced — no date yet";

/** `YYYY-MM-DD` → `{ y, m, d }`, or `null` for anything that is not one. */
function parts(date: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y: Number(y), m: month, d: day };
}

/** The group key, `YYYY-MM`. `null` when the row has no date to file under. */
export function monthKeyOf(date: string | null | undefined): string | null {
  const p = parts(date);
  return p === null ? null : `${p.y}-${String(p.m).padStart(2, "0")}`;
}

/** `2026-08` → `August 2026`; a key that is not one falls back to itself. */
export function monthLabelFor(key: string | null): string {
  if (key === null) return UNDATED_MONTH_LABEL;
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name === undefined ? key : `${name} ${match[1]}`;
}

export interface UpcomingMonthGroup {
  /** `YYYY-MM`, or `null` for the undated group. */
  key: string | null;
  /** `August 2026`, or `UNDATED_MONTH_LABEL`. */
  label: string;
  rows: UnifiedRow[];
}

/**
 * Group rows under calendar-month headings, oldest month first, undated last.
 *
 * Bucketed rather than run-length encoded over a pre-sorted list: the caller's
 * sort is the user's, and a list that is not in date order must still produce
 * one heading per month instead of the same month three times. Rows keep their
 * incoming order *within* a group, so the sort still shows through.
 */
export function groupByMonth(rows: readonly UnifiedRow[]): UpcomingMonthGroup[] {
  const dated = new Map<string, UnifiedRow[]>();
  const undated: UnifiedRow[] = [];

  for (const row of rows) {
    const key = monthKeyOf(row.date);
    if (key === null) {
      undated.push(row);
      continue;
    }
    const list = dated.get(key);
    if (list) list.push(row);
    else dated.set(key, [row]);
  }

  const out: UpcomingMonthGroup[] = [...dated.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => ({ key, label: monthLabelFor(key), rows: dated.get(key) as UnifiedRow[] }));

  if (undated.length > 0) out.push({ key: null, label: UNDATED_MONTH_LABEL, rows: undated });
  return out;
}

/**
 * The countdown as a big number and a small unit, e.g. `6` + `days`.
 *
 * Split rather than formatted into one sentence because the layout sets them at
 * two different sizes: the number is the thing you scan for down the right-hand
 * edge, the unit is the footnote that makes it mean something. The one-word
 * answers ("Today", "TBA") carry no unit — "1 tomorrow" is not a phrase.
 */
export interface CompactCountdown {
  value: string;
  unit: string;
}

export function compactCountdown(daysUntil: number | null): CompactCountdown {
  if (daysUntil === null) return { value: "TBA", unit: "" };
  if (daysUntil === 0) return { value: "Today", unit: "" };
  if (daysUntil === 1) return { value: "Tomorrow", unit: "" };
  if (daysUntil === -1) return { value: "Yesterday", unit: "" };
  if (daysUntil > 1) return { value: String(daysUntil), unit: "days" };
  return { value: String(Math.abs(daysUntil)), unit: "days ago" };
}

/**
 * What kind of thing this row is, in one word, for the row's type chip.
 *
 * The watchlist's own `type` string (user-configurable — "TV Show", "Anime",
 * whatever they renamed it to), and the other two libraries' nouns. Never
 * derived from `kind`: "Release" is what is happening, not what the thing is.
 */
export function compactTypeLabel(row: UnifiedRow): string {
  switch (row.entry.source) {
    case "watchlist":
      return row.entry.value.title.type || "Title";
    case "reading":
      return row.entry.kind === "manga" ? "Manga" : "Book";
    default:
      return "Game";
  }
}

/**
 * "Every Thursday" — but only when the data says so.
 *
 * The reference plugin prints the weekday of the *next* episode and calls it a
 * cadence, which is a guess dressed as a fact: one dated episode is evidence of
 * one date and nothing else. A schedule needs two points, and we have exactly
 * two — `airing.lastEpisode` and `airing.nextEpisode` — so this states a cadence
 * only when they are **consecutive episodes of the same season** a whole number
 * of days apart that a broadcaster actually uses.
 *
 * Everything else returns `null` and the row simply does not claim a rhythm: a
 * book publication and a game launch have none, a season announcement has none
 * yet, and a show whose last two episodes were 4 days apart has one nobody can
 * name. Omitting the phrase costs a reader nothing; inventing it costs them the
 * evening they show up on the wrong day.
 */
export function cadenceFor(row: UnifiedRow): string | null {
  if (row.entry.source !== "watchlist") return null;
  if (row.kind !== "episode") return null;
  return titleCadence(row.entry.value.title);
}

export function titleCadence(title: TitleV4): string | null {
  const airing = title.airing;
  const next = airing?.nextEpisode;
  const last = airing?.lastEpisode;
  if (!next || !last) return null;
  if (next.season !== last.season) return null;
  if (next.episode !== last.episode + 1) return null;

  const from = parts(last.airDate);
  const to = parts(next.airDate);
  if (from === null || to === null) return null;

  const gap = Math.round(
    (new Date(to.y, to.m - 1, to.d).getTime() - new Date(from.y, from.m - 1, from.d).getTime()) /
      86_400_000,
  );

  const weekday = WEEKDAY_NAMES[new Date(to.y, to.m - 1, to.d).getDay()] ?? "";
  if (gap === 1) return "Daily";
  if (gap === 7) return weekday === "" ? null : `Every ${weekday}`;
  if (gap === 14) return weekday === "" ? null : `Every other ${weekday}`;
  return null;
}
