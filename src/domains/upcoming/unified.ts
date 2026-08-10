/**
 * One Upcoming list across every library (SPEC2 §"Surfaces that grow":
 * "Status bar + Upcoming: unified across domains (v3 `resolveEntry` pattern:
 * episode/chapter/release nouns)").
 *
 * v3 solved this with `resolveEntry()`, which took an entry from any of the
 * three libraries and returned the nouns to describe it — "episode" for a show,
 * "chapter" for a book, "release" for a game. That is exactly the right shape,
 * because the *rows* are the same everywhere (a thing, a date, a countdown) and
 * only the words change.
 *
 * So this module is a discriminated union plus a resolver. The watchlist lane
 * owns `UpcomingEntry` and the games lane owns `GameUpcomingEntry`; neither is
 * changed. They are wrapped, given nouns, merged and sorted by date — with
 * undated announcements last, where they cannot displace anything real.
 */
import type { Book, DateString, Game, GamesData, Manga, ReadingData } from "../../types";
import { buildGameUpcomingEntries, type GameUpcomingEntry } from "../games/upcoming";
import { buildUpcomingEntries, type UpcomingEntry } from "../../ui/tabs/upcoming";

export type UpcomingSource = "watchlist" | "reading" | "games";

/** How long an arrived row stays on the list. The watchlist's number. */
export const DEFAULT_PAST_WINDOW_DAYS = 7;

/**
 * What kind of event a row reports, across every library.
 *
 * The watchlist's own three (`UpcomingEntry["kind"]`), reused verbatim: a book's
 * publication and a game's launch are both releases, which is exactly what the
 * shared noun table already says. Any facet over this must be derived from the
 * rows in hand, never from a hardcoded list — a kind that stops being produced
 * must stop being offered.
 */
export type UpcomingRowKind = "episode" | "season" | "release";

export const UPCOMING_KIND_LABELS: Record<UpcomingRowKind, string> = {
  episode: "Episode",
  season: "Season announced",
  release: "Release",
};

/**
 * The three disjoint states of a dated row — the header's numbers (QA1 B4).
 *
 * One definition, used by `countEntries` for the header and by the Upcoming
 * filters for the State facet, so the chip counts and the header can never
 * disagree about what "due" means.
 */
export type UpcomingState = "due" | "scheduled" | "announced";

export const UPCOMING_STATE_LABELS: Record<UpcomingState, string> = {
  due: "Due",
  scheduled: "Scheduled",
  announced: "Announced",
};

/** Aired/released (or arriving today) is due; undated is merely announced. */
export function upcomingStateOf(daysUntil: number | null): UpcomingState {
  if (daysUntil === null) return "announced";
  return daysUntil <= 0 ? "due" : "scheduled";
}

export interface UnifiedRow {
  source: UpcomingSource;
  /** Stable within its own library. */
  id: string;
  name: string;
  /** Episode / season announcement / release, whatever the library calls it. */
  kind: UpcomingRowKind;
  /** `null` for an announcement upstream has not dated. */
  date: DateString | null;
  daysUntil: number | null;
  /** Short label: `S02E01`, `Season 2`, `Released`, `Release`. */
  label: string;
  /** The second line. May be empty — several rows say everything in the label. */
  detail: string;
  /** What this library calls the thing that is arriving. */
  noun: UpcomingNouns;
  /** The original, for a renderer that wants the entity itself. */
  entry:
    | { source: "watchlist"; value: UpcomingEntry }
    | { source: "reading"; value: Book | Manga; kind: "book" | "manga" }
    | { source: "games"; value: GameUpcomingEntry };
}

/**
 * v3's per-source nouns.
 *
 * `next` is the header phrase ("Airing next"), `unit` is what one of them is
 * ("episode"), and `verb` is what the date means ("airs"). Getting these from
 * one place is what stops the tab reading like three tabs stapled together.
 */
export interface UpcomingNouns {
  next: string;
  unit: string;
  verb: string;
}

export const UPCOMING_NOUNS: Record<UpcomingSource, UpcomingNouns> = {
  watchlist: { next: "Airing next", unit: "episode", verb: "airs" },
  reading: { next: "Reading next", unit: "chapter", verb: "is published" },
  games: { next: "Releasing next", unit: "release", verb: "is released" },
};

/** Whole days from `now` to a `YYYY-MM-DD`, both at local midnight. */
export function daysUntilDate(now: Date, date: string | null | undefined): number | null {
  if (!date) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  const target = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

export interface UnifiedOptions {
  now?: Date;
  /** Days a released/aired row stays on the list. Matches the watchlist's. */
  pastWindowDays?: number;
  /** Libraries to include. Defaults to all three. */
  sources?: readonly UpcomingSource[];
}

function readingRow(
  entry: Book | Manga,
  kind: "book" | "manga",
  now: Date,
): UnifiedRow {
  const days = daysUntilDate(now, entry.releaseDate);
  const out = days !== null && days < 0;
  return {
    source: "reading",
    id: entry.id,
    name: entry.title,
    kind: "release",
    date: entry.releaseDate,
    daysUntil: days,
    label: out ? "Published" : "Publication",
    // The author is the useful second line here, the way an episode name is for
    // a show. Empty when unknown rather than padded with the word "book".
    detail: entry.author,
    noun: UPCOMING_NOUNS.reading,
    entry: { source: "reading", value: entry, kind },
  };
}

function gameRow(entry: GameUpcomingEntry): UnifiedRow {
  return {
    source: "games",
    id: entry.game.id,
    name: entry.game.title,
    kind: "release",
    date: entry.date,
    daysUntil: entry.daysUntil,
    label: entry.daysUntil !== null && entry.daysUntil < 0 ? "Released" : entry.label,
    detail: entry.detail,
    noun: UPCOMING_NOUNS.games,
    entry: { source: "games", value: entry },
  };
}

function watchlistRow(entry: UpcomingEntry): UnifiedRow {
  return {
    source: "watchlist",
    id: entry.title.id,
    name: entry.title.title,
    kind: entry.kind,
    date: entry.date,
    daysUntil: entry.daysUntil,
    label: entry.label,
    detail: entry.detail,
    noun: UPCOMING_NOUNS.watchlist,
    entry: { source: "watchlist", value: entry },
  };
}

/**
 * Every library's upcoming rows, in one chronological list.
 *
 * Sorted by date ascending with undated rows last: an announcement with no date
 * cannot be counted down and must not sit above something that actually has one.
 */
export function buildUnifiedUpcoming(
  titles: readonly import("../../types").TitleV4[],
  reading: ReadingData | undefined,
  games: GamesData | undefined,
  options: UnifiedOptions = {},
): UnifiedRow[] {
  const now = options.now ?? new Date();
  const sources = options.sources ?? (["watchlist", "reading", "games"] as const);
  const rows: UnifiedRow[] = [];

  if (sources.includes("watchlist")) {
    const opts = options.pastWindowDays === undefined ? {} : { pastWindowDays: options.pastWindowDays };
    for (const entry of buildUpcomingEntries(titles, now, opts)) rows.push(watchlistRow(entry));
  }

  if (sources.includes("reading") && reading) {
    // Deliberately NOT `upcomingReleases`: that answers "is this still to come",
    // where today is already in the past — the right question for deriving a
    // "To be released" status, the wrong one here. This list gives all three
    // libraries the same window, so a book published *today* is due exactly as
    // an episode airing today is, and stays visible for the same week after.
    const past = options.pastWindowDays ?? DEFAULT_PAST_WINDOW_DAYS;
    for (const kind of ["book", "manga"] as const) {
      const entries = kind === "book" ? reading.books : reading.manga;
      for (const entry of entries) {
        const days = daysUntilDate(now, entry.releaseDate);
        if (days === null || days < -past) continue;
        rows.push(readingRow(entry, kind, now));
      }
    }
  }

  if (sources.includes("games") && games) {
    const opts = options.pastWindowDays === undefined ? {} : { pastWindowDays: options.pastWindowDays };
    for (const entry of buildGameUpcomingEntries(games.games, now, opts)) rows.push(gameRow(entry));
  }

  return rows.sort((a, b) => {
    if (a.date === null && b.date === null) return a.name.localeCompare(b.name);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Rows that have arrived (or arrive today) — the status bar's number. */
export function countUnifiedDue(rows: readonly UnifiedRow[]): number {
  return rows.filter((row) => row.daysUntil !== null && row.daysUntil <= 0).length;
}

export interface UnifiedCounts {
  total: number;
  due: number;
  bySource: Record<UpcomingSource, number>;
}

export function countUnified(rows: readonly UnifiedRow[]): UnifiedCounts {
  const bySource: Record<UpcomingSource, number> = { watchlist: 0, reading: 0, games: 0 };
  let due = 0;
  for (const row of rows) {
    bySource[row.source] += 1;
    if (row.daysUntil !== null && row.daysUntil <= 0) due += 1;
  }
  return { total: rows.length, due, bySource };
}

/**
 * The status-bar sentence.
 *
 * One number when everything due comes from one library, and the per-library
 * split when it does not — "3 due today" is fine until two of them are books,
 * at which point the user deserves to know before opening the tab.
 */
export function statusBarText(rows: readonly UnifiedRow[]): string {
  const counts = countUnified(rows.filter((row) => row.daysUntil !== null && row.daysUntil <= 0));
  if (counts.total === 0) return "";

  const parts: string[] = [];
  if (counts.bySource.watchlist > 0) parts.push(`${counts.bySource.watchlist} to watch`);
  if (counts.bySource.reading > 0) parts.push(`${counts.bySource.reading} to read`);
  if (counts.bySource.games > 0) parts.push(`${counts.bySource.games} to play`);

  return parts.length === 1 ? `${counts.total} due today` : `${counts.total} due · ${parts.join(", ")}`;
}
