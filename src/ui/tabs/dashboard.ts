/**
 * Dashboard tab — SPEC §4.7.
 *
 * Trimmed to what the user actually looks at: one unified stats card, per-type
 * cards, three mini-charts, top credits, a "continue watching" shelf, the three
 * soonest airing items, and the two recency lists.
 *
 * Two disciplines matter here and are enforced by construction:
 *
 *   1. **One time formula.** Every minute rendered on this tab comes from
 *      `data/episodes.ts` (`calcTimeWatched` / `calcTimeRemaining`). v3 had two
 *      contradictory implementations and the dashboard disagreed with the modal.
 *   2. **Error isolation.** Every section goes through `section()`; a section
 *      that throws prints an inline panel instead of blanking the tab.
 *
 * `computeDashboard` is pure and unit-tested; the mount function only paints it.
 */
import { Notice, setIcon } from "obsidian";
import { NON_COUNTING_STATUSES } from "../../constants";
import { renderPosterPlaceholder } from "../components/posters";
import {
  calcTimeRemaining,
  calcTimeWatched,
  formatMinutes,
  getProgress,
  isFullyWatched,
} from "../../data/episodes";
import {
  READING_STATUSES,
  type GamesData,
  type ReadingData,
  type Settings,
  type TabController,
  type TitleV4,
} from "../../types";
import { bookStats, mangaStats } from "../../domains/reading/stats";
import { derivedStatus, progressLabel, readingProgress } from "../../domains/reading/progress";
import { daysUntil, toDateString } from "../../services/airing";
import { formatPlaytime, gamesCompletedStat, timePlayedStat } from "../../domains/games/stats";
import {
  buildUpcomingEntries,
  cardContext,
  cardRenderer,
  depsNow,
  formatCountdown,
  formatDate,
  parseDateOnly,
  plexPill,
  progressSentence,
  renderEmptyState,
  renderPill,
  renderPosterThumb,
  renderUpcomingRow,
  requestPill,
  section,
  sectionHeader,
  type SuggestionLite,
  type TabDeps,
  type UpcomingEntry,
} from "./upcoming";

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

export interface CountBucket {
  label: string;
  count: number;
}

export interface TypeStats {
  type: string;
  total: number;
  completed: number;
  /** 0–100, over the counting titles only. */
  percent: number;
  timeWatched: number;
  timeRemaining: number;
}

export interface DashboardModel {
  total: number;
  /** Titles that count towards the completion ratio (Dropped/To be released excluded). */
  counting: number;
  completed: number;
  percent: number;
  timeWatched: number;
  timeRemaining: number;
  favorites: number;
  byType: TypeStats[];
  byStatus: CountBucket[];
  byYear: CountBucket[];
  addedOverTime: CountBucket[];
  topCast: CountBucket[];
  topDirectors: CountBucket[];
  topStudios: CountBucket[];
  continueWatching: TitleV4[];
  upNext: UpcomingEntry[];
  recentlyWatched: TitleV4[];
  recentlyAdded: TitleV4[];
}

/** 90 000 → "90 000": a wall of digits is not a statistic either. */
function formatCount(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

export const DASHBOARD_SHELF_LIMIT = 8;
export const DASHBOARD_UP_NEXT_LIMIT = 3;
export const DASHBOARD_MONTHS = 12;

function counts(title: TitleV4): boolean {
  return !NON_COUNTING_STATUSES.includes(title.status);
}

/** API values plus the user's manual additions, deduped case-insensitively. */
function mergedCredits(api: readonly string[], manual: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const value of [...api, ...manual]) {
    const name = value.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

function topCounts(
  titles: readonly TitleV4[],
  pick: (title: TitleV4) => string[],
  limit: number,
): CountBucket[] {
  const tally = new Map<string, { label: string; count: number }>();
  for (const title of titles) {
    for (const value of pick(title)) {
      const key = value.toLowerCase();
      const entry = tally.get(key);
      if (entry) entry.count += 1;
      else tally.set(key, { label: value, count: 1 });
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, limit));
}

export function titleYear(title: TitleV4): number | null {
  if (typeof title.year === "number" && Number.isFinite(title.year) && title.year > 0) {
    return title.year;
  }
  const date = parseDateOnly(title.releaseDate);
  return date ? date.getFullYear() : null;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Timestamp used for "most recent activity" ordering. */
function activityTime(title: TitleV4): number {
  const finished = parseDateOnly(title.dateFinished);
  const modified = Date.parse(title.dateModified ?? "");
  const finishedMs = finished ? finished.getTime() : 0;
  const modifiedMs = Number.isFinite(modified) ? modified : 0;
  return Math.max(finishedMs, modifiedMs);
}

/**
 * `dateAdded` as a sortable number and as a calendar day.
 *
 * Migration guarantees the field, and every title created since has it — but a
 * hand-edited or half-migrated row does not, and `title.dateAdded.slice(0, 10)`
 * on `undefined` throws hard enough to take the whole Recently-added section
 * down with it (QA4). One missing field must cost one missing date, not a
 * section.
 */
export function addedDay(title: TitleV4): string {
  const raw = typeof title.dateAdded === "string" ? title.dateAdded : "";
  return raw.slice(0, 10);
}

export function addedTime(title: TitleV4): number {
  const parsed = Date.parse(typeof title.dateAdded === "string" ? title.dateAdded : "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeDashboard(
  titles: readonly TitleV4[],
  settings: Settings,
  now: Date = new Date(),
): DashboardModel {
  const counting = titles.filter(counts);
  const completed = counting.filter((t) => isFullyWatched(t) || t.status === "Completed");

  let timeWatched = 0;
  let timeRemaining = 0;
  for (const title of titles) {
    timeWatched += calcTimeWatched(title);
    timeRemaining += calcTimeRemaining(title);
  }

  // --- per type ------------------------------------------------------------
  const typeOrder = settings.types.map((t) => t.name);
  const typeMap = new Map<string, TitleV4[]>();
  for (const title of titles) {
    const list = typeMap.get(title.type);
    if (list) list.push(title);
    else typeMap.set(title.type, [title]);
  }
  const byType: TypeStats[] = [...typeMap.entries()]
    .sort((a, b) => {
      const ia = typeOrder.indexOf(a[0]);
      const ib = typeOrder.indexOf(b[0]);
      if (ia !== ib) return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
      return a[0].localeCompare(b[0]);
    })
    .map(([type, list]) => {
      const countingList = list.filter(counts);
      const done = countingList.filter((t) => isFullyWatched(t) || t.status === "Completed").length;
      return {
        type,
        total: list.length,
        completed: done,
        percent: countingList.length === 0 ? 0 : Math.round((done / countingList.length) * 100),
        timeWatched: list.reduce((sum, t) => sum + calcTimeWatched(t), 0),
        timeRemaining: list.reduce((sum, t) => sum + calcTimeRemaining(t), 0),
      };
    });

  // --- by status, in the user's configured order (v3 hardcoded it) ---------
  const statusTally = new Map<string, number>();
  for (const title of titles) statusTally.set(title.status, (statusTally.get(title.status) ?? 0) + 1);
  const configured = settings.statuses.map((s) => s.name);
  const byStatus: CountBucket[] = [];
  for (const name of configured) {
    const count = statusTally.get(name);
    if (count) byStatus.push({ label: name, count });
    statusTally.delete(name);
  }
  for (const [label, count] of [...statusTally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byStatus.push({ label: label || "(no status)", count });
  }

  // --- by year -------------------------------------------------------------
  const yearTally = new Map<number, number>();
  let unknownYear = 0;
  for (const title of titles) {
    const year = titleYear(title);
    if (year === null) unknownYear += 1;
    else yearTally.set(year, (yearTally.get(year) ?? 0) + 1);
  }
  const byYear: CountBucket[] = [...yearTally.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, count]) => ({ label: String(year), count }));
  if (unknownYear > 0) byYear.push({ label: "(unknown)", count: unknownYear });

  // --- added over time, last 12 months ------------------------------------
  const addedTally = new Map<string, number>();
  for (const title of titles) {
    const at = addedTime(title);
    if (at === 0) continue;
    const key = monthKey(new Date(at));
    addedTally.set(key, (addedTally.get(key) ?? 0) + 1);
  }
  const addedOverTime: CountBucket[] = [];
  for (let i = DASHBOARD_MONTHS - 1; i >= 0; i -= 1) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(cursor);
    addedOverTime.push({ label: key, count: addedTally.get(key) ?? 0 });
  }

  // --- credits -------------------------------------------------------------
  const cap = Math.max(1, settings.dashboardTopCredits || 5);
  const topCast = topCounts(titles, (t) => mergedCredits(t.cast, t.manualCast), cap);
  const topDirectors = topCounts(titles, (t) => mergedCredits(t.director, t.manualDirector), cap);
  const topStudios = topCounts(titles, (t) => mergedCredits(t.studio, t.manualStudio), cap);

  // --- shelves -------------------------------------------------------------
  const continueWatching = titles
    .filter((t) => {
      if (!counts(t)) return false;
      if (isFullyWatched(t)) return false;
      return getProgress(t) > 0 || t.status === "Watching";
    })
    .slice()
    .sort((a, b) => activityTime(b) - activityTime(a))
    .slice(0, DASHBOARD_SHELF_LIMIT);

  const upNext = buildUpcomingEntries(titles, now, { pastWindowDays: 0 })
    .filter((entry) => entry.daysUntil !== null)
    .slice(0, DASHBOARD_UP_NEXT_LIMIT);

  const recentlyWatched = titles
    .filter((t) => getProgress(t) > 0 || t.status === "Completed")
    .slice()
    .sort((a, b) => activityTime(b) - activityTime(a))
    .slice(0, DASHBOARD_SHELF_LIMIT);

  const recentlyAdded = titles
    .slice()
    .sort((a, b) => addedTime(b) - addedTime(a))
    .slice(0, DASHBOARD_SHELF_LIMIT);

  return {
    total: titles.length,
    counting: counting.length,
    completed: completed.length,
    percent: counting.length === 0 ? 0 : Math.round((completed.length / counting.length) * 100),
    timeWatched,
    timeRemaining,
    favorites: titles.filter((t) => t.favorite).length,
    byType,
    byStatus,
    byYear,
    addedOverTime,
    topCast,
    topDirectors,
    topStudios,
    continueWatching,
    upNext,
    recentlyWatched,
    recentlyAdded,
  };
}

/**
 * The three charts the source filter switches between.
 *
 * Each library answers "by status", "by year" and "added over time" in its own
 * vocabulary — a book has no episodes and a game has no cast — so rather than
 * bending one model to fit three shapes, each source builds the same three
 * bucket lists from its own entries. Pure, and tested directly.
 */
export interface SourceCharts {
  byStatus: CountBucket[];
  byYear: CountBucket[];
  addedOverTime: CountBucket[];
}

function bucketsByKey(
  rows: readonly { key: string | null }[],
  unknownLabel: string,
  order?: readonly string[],
): CountBucket[] {
  const tally = new Map<string, number>();
  let unknown = 0;
  for (const row of rows) {
    if (row.key === null || row.key === "") unknown += 1;
    else tally.set(row.key, (tally.get(row.key) ?? 0) + 1);
  }
  const out: CountBucket[] = [];
  if (order) {
    for (const name of order) {
      const count = tally.get(name);
      if (count) out.push({ label: name, count });
      tally.delete(name);
    }
  }
  for (const [label, count] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ label, count });
  }
  if (unknown > 0) out.push({ label: unknownLabel, count: unknown });
  return out;
}

function addedBuckets(dates: readonly string[], now: Date): CountBucket[] {
  const tally = new Map<string, number>();
  for (const raw of dates) {
    const at = Date.parse(raw ?? "");
    if (!Number.isFinite(at)) continue;
    const key = monthKey(new Date(at));
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const out: CountBucket[] = [];
  for (let i = DASHBOARD_MONTHS - 1; i >= 0; i -= 1) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(cursor);
    out.push({ label: key, count: tally.get(key) ?? 0 });
  }
  return out;
}

export function sourceCharts(
  source: DashboardSource,
  model: DashboardModel,
  reading: ReadingData,
  games: GamesData,
  now: Date = new Date(),
): SourceCharts {
  if (source === "watchlist") {
    return {
      byStatus: model.byStatus,
      byYear: model.byYear,
      addedOverTime: model.addedOverTime,
    };
  }

  if (source === "reading") {
    const entries = [...reading.books, ...reading.manga];
    return {
      // The derived status, not the stored one: "To be released" is computed
      // from the release date and is what every other reading surface shows.
      byStatus: bucketsByKey(
        entries.map((entry) => ({ key: derivedStatus(entry, now) })),
        "(no status)",
        READING_STATUSES,
      ),
      byYear: bucketsByKey(
        entries.map((entry) => ({ key: yearOfDate(entry.releaseDate) })),
        "(unknown)",
      ),
      addedOverTime: addedBuckets(
        entries.map((entry) => entry.dateAdded),
        now,
      ),
    };
  }

  return {
    byStatus: bucketsByKey(
      games.games.map((game) => ({ key: game.status })),
      "(no status)",
      games.settings.statuses.map((status) => status.name),
    ),
    byYear: bucketsByKey(
      games.games.map((game) => ({ key: yearOfDate(game.releaseDate) })),
      "(unknown)",
    ),
    addedOverTime: addedBuckets(
      games.games.map((game) => game.dateAdded),
      now,
    ),
  };
}

/** `2024-05-01` → `"2024"`; anything unparseable → `null`. */
function yearOfDate(date: string | null | undefined): string | null {
  const parsed = parseDateOnly(date);
  return parsed ? String(parsed.getFullYear()) : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RING_RADIUS = 38;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Donut progress ring. Colour comes from the theme; no hardcoded values. */
function renderRing(parent: HTMLElement, percent: number, caption: string): HTMLElement {
  const wrap = parent.createDiv({ cls: "wl-ring" });
  const svg = wrap.createSvg("svg", { attr: { viewBox: "0 0 100 100", role: "img" } });
  svg.createSvg("circle", {
    cls: "wl-ring-track",
    attr: { cx: "50", cy: "50", r: String(RING_RADIUS), fill: "none" },
  });
  const value = svg.createSvg("circle", {
    cls: "wl-ring-value",
    attr: {
      cx: "50",
      cy: "50",
      r: String(RING_RADIUS),
      fill: "none",
      "stroke-linecap": "round",
      "stroke-dasharray": String(RING_CIRCUMFERENCE),
      "stroke-dashoffset": String(RING_CIRCUMFERENCE),
      transform: "rotate(-90 50 50)",
    },
  });
  const clamped = Math.max(0, Math.min(100, percent));
  const target = RING_CIRCUMFERENCE * (1 - clamped / 100);
  // Double rAF so the transition from "empty" actually plays (foodspot trick).
  requestAnimationFrame(() => {
    requestAnimationFrame(() => value.setAttribute("stroke-dashoffset", String(target)));
  });
  wrap.createDiv({ cls: "wl-ring-value-label", text: `${clamped}%` });
  // "" means the numbers live next to the ring, not under it (compact cards).
  if (caption !== "") wrap.createDiv({ cls: "wl-ring-caption", text: caption });
  wrap.setAttr("aria-label", caption === "" ? `${clamped}%` : `${caption}: ${clamped}%`);
  return wrap;
}

function renderStat(parent: HTMLElement, value: string, label: string): HTMLElement {
  const el = parent.createDiv({ cls: "wl-stat" });
  el.createDiv({ cls: "wl-stat-value", text: value });
  el.createDiv({ cls: "wl-stat-label", text: label });
  return el;
}

function renderBars(parent: HTMLElement, buckets: readonly CountBucket[], emptyText: string): void {
  if (buckets.length === 0) {
    parent.createDiv({ cls: "wl-chart-empty", text: emptyText });
    return;
  }
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0) || 1;
  const chart = parent.createDiv({ cls: "wl-bars" });
  for (const bucket of buckets) {
    const row = chart.createDiv({ cls: "wl-bar-row" });
    row.createSpan({ cls: "wl-bar-label", text: bucket.label });
    const track = row.createDiv({ cls: "wl-bar-track" });
    const fill = track.createDiv({ cls: "wl-bar-fill" });
    fill.style.setProperty("--wl-bar-pct", `${Math.round((bucket.count / max) * 100)}%`);
    row.createSpan({ cls: "wl-bar-count", text: String(bucket.count) });
    row.setAttr("aria-label", `${bucket.label}: ${bucket.count}`);
  }
}

/** Vertical columns, used for the 12-month "added over time" strip. */
function renderColumns(parent: HTMLElement, buckets: readonly CountBucket[]): void {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0) || 1;
  const chart = parent.createDiv({ cls: "wl-columns" });
  for (const bucket of buckets) {
    const col = chart.createDiv({ cls: "wl-column" });
    const bar = col.createDiv({ cls: "wl-column-bar" });
    bar.style.setProperty("--wl-col-pct", `${Math.round((bucket.count / max) * 100)}%`);
    col.createDiv({ cls: "wl-column-label", text: bucket.label.slice(5) });
    col.setAttr("aria-label", `${bucket.label}: ${bucket.count} added`);
  }
}

function renderCreditList(
  parent: HTMLElement,
  heading: string,
  buckets: readonly CountBucket[],
  deps: TabDeps,
  queryField: "cast" | "director" | "studio" | null,
): void {
  const card = parent.createDiv({ cls: "wl-credit-card" });
  card.createDiv({ cls: "wl-credit-heading", text: heading });
  if (buckets.length === 0) {
    card.createDiv({
      cls: "wl-chart-empty",
      text: `No ${heading.toLowerCase()} recorded yet — refresh a title's metadata to fill this in.`,
    });
    return;
  }
  const list = card.createDiv({ cls: "wl-credit-list" });
  for (const bucket of buckets) {
    const row = list.createDiv({ cls: "wl-credit-row" });
    if (deps.onJumpToQuery && queryField) {
      const chip = row.createEl("button", {
        cls: "wl-chip is-clickable",
        text: bucket.label,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () =>
        deps.onJumpToQuery?.(`${queryField}:"${bucket.label}"`),
      );
    } else {
      row.createSpan({ cls: "wl-chip", text: bucket.label });
    }
    row.createSpan({ cls: "wl-credit-count", text: String(bucket.count) });
  }
}

function renderShelf(
  parent: HTMLElement,
  titles: readonly TitleV4[],
  deps: TabDeps,
  emptyText: string,
): void {
  if (titles.length === 0) {
    parent.createDiv({ cls: "wl-chart-empty", text: emptyText });
    return;
  }
  const shelf = parent.createDiv({ cls: "wl-shelf" });
  const build = cardRenderer(deps);
  const ctx = cardContext(deps, "compact", { showActions: false });
  for (const title of titles) build(shelf, title, ctx);
}

/** Compact row used by the two recency lists — cheaper than a full card. */
/**
 * The suggestions panel.
 *
 * Loads on mount rather than on a button, because a panel that says "click to
 * find out" is a panel nobody clicks — and the request is cached upstream, so
 * opening the tab twice costs one round trip. Failure is a sentence, never an
 * empty box: "nothing came back" and "your server is not answering" are
 * different problems and the user can only act on one of them.
 */
function renderSuggestions(
  parent: HTMLElement,
  deps: TabDeps,
  fetch: NonNullable<TabDeps["onSuggest"]>,
): void {
  const host = parent.createDiv({ cls: "wl-suggest-panel" });
  host.createDiv({ cls: "wl-suggest-empty", text: "Looking for something you might like…" });

  void fetch()
    .then((outcome) => {
      host.empty();
      if (outcome.note) host.createDiv({ cls: "wl-suggest-note", text: outcome.note });
      if (outcome.suggestions.length === 0) {
        if (!outcome.note) {
          host.createDiv({
            cls: "wl-suggest-empty",
            text: "Nothing to suggest yet — rate a few things you liked.",
          });
        }
        return;
      }
      const list = host.createDiv({ cls: "wl-suggest-mini-list" });
      for (const suggestion of outcome.suggestions.slice(0, 6)) {
        renderSuggestionMini(list, suggestion);
      }
    })
    .catch((err) => {
      host.empty();
      host.createDiv({
        cls: "wl-suggest-empty",
        text: `Could not reach the server for suggestions — ${err instanceof Error ? err.message : String(err)}`,
      });
    });
}

/** One suggestion, in the dashboard's row rhythm rather than the wizard's. */
function renderSuggestionMini(parent: HTMLElement, suggestion: SuggestionLite): void {
  const row = parent.createDiv({ cls: "wl-recent-row wl-suggest-mini" });

  const poster = row.createDiv({ cls: "wl-thumb" });
  if (suggestion.posterUrl) {
    const img = poster.createEl("img", { cls: "wl-thumb-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.addEventListener("error", () => {
      img.remove();
      renderPosterPlaceholder(poster, suggestion.title);
    });
    img.src = suggestion.posterUrl;
  } else {
    renderPosterPlaceholder(poster, suggestion.title);
  }

  const body = row.createDiv({ cls: "wl-recent-body" });
  body.createDiv({
    cls: "wl-recent-name",
    text: suggestion.year ? `${suggestion.title} (${suggestion.year})` : suggestion.title,
  });
  // Always rendered, so every row in this list is the same height as every row
  // in the list beside it.
  body.createDiv({ cls: "wl-recent-meta", text: suggestion.reasons[0] ?? "" });

  const actions = row.createDiv({ cls: "wl-suggest-mini-actions" });
  if (suggestion.add) {
    const add = actions.createEl("button", {
      cls: "wl-mini-btn",
      text: "Add",
      attr: { type: "button", title: `Add ${suggestion.title} to your library` },
    });
    add.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      add.disabled = true;
      void suggestion.add?.().then((ok) => {
        if (ok) {
          new Notice(`Added «${suggestion.title}».`);
          row.remove();
        } else {
          add.disabled = false;
        }
      });
    });
  }
  if (suggestion.dismiss) {
    const no = actions.createEl("button", {
      cls: "wl-icon-btn",
      attr: { type: "button", "aria-label": "Not interested", title: "Not interested" },
    });
    setIcon(no, "x");
    no.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      suggestion.dismiss?.();
      row.remove();
    });
  }
}

/**
 * One row for something that is not a film.
 *
 * Books and games are not `TitleV4`, so they cannot go through the card
 * factory or `renderRecentRow` — but they should *look* identical, or the tab
 * reads as two products stapled together. Same classes, same rhythm, same
 * thumbnail size as everything else on this tab.
 */
/** Count occurrences and keep the top few — the credit list's own shape. */
function tally(values: readonly string[], limit: number): CountBucket[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const label = raw.trim();
    if (label === "") continue;
    const key = label.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { label, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** One "by type" card: a ring, a name, and what it counts. */
function renderTypeCard(grid: HTMLElement, type: TypeStats): void {
  const card = grid.createDiv({ cls: "wl-panel wl-type-card" });
  renderRing(card, type.percent, "");
  const body = card.createDiv({ cls: "wl-type-body" });
  body.createDiv({ cls: "wl-type-name", text: type.type });
  body.createDiv({ cls: "wl-type-meta", text: `${type.completed} of ${type.total} completed` });
  // "0m watched · 0m left" says nothing; time appears once there is some.
  if (type.timeWatched > 0 || type.timeRemaining > 0) {
    body.createDiv({
      cls: "wl-type-meta",
      text:
        `${formatMinutes(type.timeWatched)} watched` +
        (type.timeRemaining > 0 ? ` · ${formatMinutes(type.timeRemaining)} left` : ""),
    });
  }
}

function renderSimpleRow(
  parent: HTMLElement,
  entry: { title: string; coverUrl?: string; meta: string },
  onOpen?: () => void,
): void {
  const row = parent.createDiv({ cls: "wl-recent-row" });
  const cover = row.createDiv({ cls: "wl-thumb" });
  const url = (entry.coverUrl ?? "").trim();
  if (url !== "" && url !== "none") {
    const img = cover.createEl("img", { cls: "wl-thumb-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.addEventListener("error", () => {
      img.remove();
      renderPosterPlaceholder(cover, entry.title);
    });
    img.src = url;
  } else {
    renderPosterPlaceholder(cover, entry.title);
  }
  const body = row.createDiv({ cls: "wl-recent-body" });
  body.createDiv({ cls: "wl-recent-name", text: entry.title });
  // Always rendered, so a row with nothing to say is still the same height.
  body.createDiv({ cls: "wl-recent-meta", text: entry.meta });
  if (onOpen) {
    row.addClass("is-clickable");
    row.setAttr("role", "button");
    row.tabIndex = 0;
    row.addEventListener("click", onOpen);
    row.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
      }
    });
  }
}

function renderRecentRow(parent: HTMLElement, title: TitleV4, deps: TabDeps, meta: string): void {
  const row = parent.createDiv({ cls: "wl-recent-row" });
  // One thumbnail size across every dashboard panel: a 32px poster in
  // "Recently watched" beside a 44px one in "Up next" is the first thing
  // the eye catches, and neither is more important than the other.
  renderPosterThumb(row, title, deps, "wl-thumb");
  const body = row.createDiv({ cls: "wl-recent-body" });
  body.createDiv({ cls: "wl-recent-name", text: title.title });
  body.createDiv({ cls: "wl-recent-meta", text: meta });
  const pill = plexPill(title) ?? requestPill(title);
  if (pill) renderPill(row, pill);
  if (deps.onOpenTitle) {
    row.addClass("is-clickable");
    row.setAttr("role", "button");
    row.tabIndex = 0;
    const open = (): void => deps.onOpenTitle?.(title);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        open();
      }
    });
  }
}

/**
 * Which library the "More statistics" block is describing (v3 §2.2).
 *
 * v3 put a Watchlist/Reading/Games switch above those charts, and it earns its
 * place: "by status" means something different in each library, and stacking
 * three sets of the same four charts would triple the page for no gain.
 */
export type DashboardSource = "watchlist" | "reading" | "games";

/** Stand-ins for a store that predates the parity contract. Never mutated. */
const EMPTY_READING: ReadingData = {
  books: [],
  manga: [],
  bookColumns: [],
  mangaColumns: [],
  settings: {
    defaultFolder: "",
    defaultStatus: "Plan to Read",
    bookCustomFieldStyle: "fill",
    mangaCustomFieldStyle: "fill",
    statusColors: {} as ReadingData["settings"]["statusColors"],
  },
};

const EMPTY_GAMES: GamesData = {
  games: [],
  groups: [],
  settings: { defaultFolder: "", defaultStatus: "", statuses: [], types: [], platforms: [] },
};

export const DASHBOARD_SOURCES: readonly DashboardSource[] = ["watchlist", "reading", "games"];

/** Panel titles that change with the library, so no panel lies about itself. */
const CONTINUE_LABEL: Record<DashboardSource, string> = {
  watchlist: "Continue watching",
  reading: "Continue reading",
  games: "Continue playing",
};

const FINISHED_LABEL: Record<DashboardSource, string> = {
  watchlist: "Recently watched",
  reading: "Recently finished",
  games: "Recently played",
};

const ADDED_LABEL: Record<DashboardSource, string> = {
  watchlist: "Recently added",
  reading: "Recently shelved",
  games: "Recently added",
};

const SOURCE_LABELS: Record<DashboardSource, string> = {
  watchlist: "Watchlist",
  reading: "Reading",
  games: "Games",
};

export function mountDashboardTab(host: HTMLElement, deps: TabDeps): TabController {
  const el = host.createDiv({ cls: "wl-tab-panel wl-tab-panel-dashboard" });
  /** Survives a data-changed repaint; resets only when the tab is rebuilt. */
  let source: DashboardSource = "watchlist";

  const render = (): void => {
    // Emptying detaches the thumbs while the shared observer still holds
    // them, so hand them back first — otherwise every data-changed event
    // strands another batch of detached DOM.
    deps.posterLoader?.releaseWithin?.(el);
    el.empty();
    const settings = deps.store.settings;
    const titles = deps.store.allTitles();

    // Read through a guard rather than directly. The store contract guarantees
    // both domains, but this line sits OUTSIDE every `section()` wrapper, so a
    // partial store in a harness or an embedded host would take the whole tab
    // down rather than one panel — the exact failure shape QA4 was about.
    const reading = deps.store.reading ?? EMPTY_READING;
    const games = deps.store.games ?? EMPTY_GAMES;
    const readingCount = reading.books.length + reading.manga.length;
    const gamesCount = games.games.length;

    // "Nothing at all" now means nothing in *any* library — a user with only
    // books used to get the first-run panel on a dashboard that had plenty to say.
    if (titles.length === 0 && readingCount === 0 && gamesCount === 0) {
      renderEmptyState(el, {
        icon: "layout-dashboard",
        title: "No statistics yet",
        body: "Add a film, a show, a book or a game and this dashboard fills itself in.",
      });
      return;
    }

    const model = computeDashboard(titles, settings, depsNow(deps));

    // A library with nothing in it cannot be shown; fall back rather than
    // rendering an empty dashboard for a source that was remembered.
    const available = DASHBOARD_SOURCES.filter((option) =>
      option === "reading" ? readingCount > 0 : option === "games" ? gamesCount > 0 : titles.length > 0,
    );
    if (!available.includes(source)) source = available[0] ?? "watchlist";

    // --- which library is this? --------------------------------------------
    //
    // The switch used to sit inside "More statistics" and govern three charts,
    // which meant clicking Reading changed almost nothing on a page still full
    // of films. It governs the whole tab now: every panel below asks the same
    // question of whichever library is selected.
    if (available.length > 1) {
      const bar = el.createDiv({ cls: "wl-section wl-source-bar" });
      const chips = bar.createDiv({ cls: "wl-source-chips" });
      for (const option of available) {
        const chip = chips.createDiv({ cls: "wl-chip is-clickable" });
        chip.setText(SOURCE_LABELS[option]);
        chip.toggleClass("is-active", option === source);
        chip.setAttr("role", "button");
        chip.setAttr("tabindex", "0");
        const pick = (): void => {
          source = option;
          render();
        };
        chip.addEventListener("click", pick);
        chip.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick();
          }
        });
      }
    }

    // --- unified card ------------------------------------------------------
    section(el, "Overview", (s) => {
      s.addClass("wl-panel");
      const grid = s.createDiv({ cls: "wl-overview" });
      if (source === "reading") {
        const books = bookStats(reading.books, depsNow(deps));
        const manga = mangaStats(reading.manga, depsNow(deps));
        const counting = books.counting + manga.counting;
        const completed = books.completed + manga.completed;
        renderRing(
          grid,
          counting === 0 ? 0 : Math.round((completed / counting) * 100),
          `${completed} of ${counting} finished`,
        );
        const stats = grid.createDiv({ cls: "wl-stat-grid" });
        renderStat(stats, String(reading.books.length), "Books");
        if (reading.manga.length > 0) renderStat(stats, String(reading.manga.length), "Manga");
        renderStat(stats, formatCount(books.pagesRead), "Pages read");
        if (books.pagesTotal > books.pagesRead) {
          renderStat(stats, formatCount(books.pagesTotal - books.pagesRead), "Pages to go");
        }
        if (manga.chaptersRead > 0) renderStat(stats, formatCount(manga.chaptersRead), "Chapters read");
        const favourites = books.favorites + manga.favorites;
        if (favourites > 0) renderStat(stats, String(favourites), "Favourites");
      } else if (source === "games") {
        const completion = gamesCompletedStat(games.games);
        const played = timePlayedStat(games.games);
        renderRing(
          grid,
          completion.percent,
          `${completion.finished} of ${completion.counted} finished`,
        );
        const stats = grid.createDiv({ cls: "wl-stat-grid" });
        renderStat(stats, String(games.games.length), "Games");
        renderStat(stats, played.label, "Time played");
        const wishlist = games.games.filter((game) => game.wishlist).length;
        if (wishlist > 0) renderStat(stats, String(wishlist), "On the wishlist");
      } else {
        renderRing(grid, model.percent, `${model.completed} of ${model.counting} completed`);
        const stats = grid.createDiv({ cls: "wl-stat-grid" });
        renderStat(stats, formatMinutes(model.timeWatched), "Time watched");
        // A zero is not a statistic — it is furniture. Only stats with something
        // to say get a slot (the two that are always meaningful stay).
        if (model.timeRemaining > 0)
          renderStat(stats, formatMinutes(model.timeRemaining), "Time remaining");
        renderStat(stats, String(model.total), "Titles tracked");
        if (model.favorites > 0) renderStat(stats, String(model.favorites), "Favourites");
      }
    });

    // --- per type ----------------------------------------------------------
    const typeSection = section(el, "By type", (s) => {
      if (source === "reading") {
        s.addClass("wl-panel");
        sectionHeader(s, "By shelf");
        const grid = s.createDiv({ cls: "wl-type-grid" });
        for (const [label, entries] of [
          ["Books", reading.books],
          ["Manga", reading.manga],
        ] as const) {
          if (entries.length === 0) continue;
          const done = entries.filter((e) => derivedStatus(e) === "Completed").length;
          renderTypeCard(grid, {
            type: label,
            total: entries.length,
            completed: done,
            percent: entries.length === 0 ? 0 : Math.round((done / entries.length) * 100),
            timeWatched: 0,
            timeRemaining: 0,
          });
        }
        return;
      }
      if (source === "games") {
        s.addClass("wl-panel");
        sectionHeader(s, "By status");
        const grid = s.createDiv({ cls: "wl-type-grid" });
        const byStatus = new Map<string, number>();
        for (const game of games.games) {
          byStatus.set(game.status, (byStatus.get(game.status) ?? 0) + 1);
        }
        for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
          renderTypeCard(grid, {
            type: status,
            total: count,
            completed: status === "Finished" ? count : 0,
            percent: status === "Finished" ? 100 : 0,
            timeWatched: 0,
            timeRemaining: 0,
          });
        }
        return;
      }
      sectionHeader(s, "By type");
      const grid = s.createDiv({ cls: "wl-type-grid" });
      for (const type of model.byType) {
        renderTypeCard(grid, type);
      }
    });
    // --- per domain --------------------------------------------------------
    //
    // One card per library, beside the per-type cards, so the dashboard answers
    // "how am I doing" for everything the plugin tracks rather than only for
    // what it started as (SPEC2 §"Surfaces that grow").
    if (readingCount > 0 || gamesCount > 0) {
      const librariesSection = section(el, "Libraries", (s) => {
        sectionHeader(s, "Libraries");
        const grid = s.createDiv({ cls: "wl-type-grid" });

        /** Ring + name + up to two meta lines, the same card the types use. */
        const card = (name: string, percent: number, metas: string[]): void => {
          const host = grid.createDiv({ cls: "wl-panel wl-type-card" });
          renderRing(host, percent, "");
          const body = host.createDiv({ cls: "wl-type-body" });
          body.createDiv({ cls: "wl-type-name", text: name });
          for (const meta of metas.filter((m) => m !== "")) {
            body.createDiv({ cls: "wl-type-meta", text: meta });
          }
        };

        if (reading.books.length > 0) {
          const stats = bookStats(reading.books, depsNow(deps));
          card("Books", stats.percent, [
            `${stats.completed} of ${stats.counting} finished`,
            // "0 of 0 pages" is what an untracked page count looks like — say
            // what is actually known instead.
            stats.pagesTotal > 0
              ? `${stats.pagesRead.toLocaleString()} of ${stats.pagesTotal.toLocaleString()} pages`
              : `${reading.books.length} book${reading.books.length === 1 ? "" : "s"} tracked`,
          ]);
        }

        if (reading.manga.length > 0) {
          const stats = mangaStats(reading.manga, depsNow(deps));
          card("Manga", stats.percent, [
            `${stats.completed} of ${stats.counting} finished`,
            stats.chaptersRead > 0 || stats.volumesRead > 0
              ? `${stats.chaptersRead} chapters · ${stats.volumesRead} volumes`
              : `${reading.manga.length} tracked`,
          ]);
        }

        if (gamesCount > 0) {
          const completion = gamesCompletedStat(games.games);
          const played = timePlayedStat(games.games);
          card("Games", completion.percent, [
            `${completion.finished} of ${completion.counted} finished`,
            // Time played is the games equivalent of time watched, and the one
            // number a games library is actually judged by.
            `${played.label} played across ${played.games} game${played.games === 1 ? "" : "s"}`,
          ]);
        }
      });
      // Two half-width neighbours: the types and the other libraries share a
      // row instead of each claiming a screen-wide stripe.
      typeSection.addClass("is-half");
      librariesSection.addClass("is-half");
    }

    // --- charts ------------------------------------------------------------
    //
    // Everything below describes ONE library at a time; the chips pick which.
    section(el, "More statistics", (s) => {
      // The chips ride in the header row itself — a switch is not content and
      // does not deserve a stripe of its own.
      const head = sectionHeader(s, "More statistics");
      const chips = head.createDiv({ cls: "wl-source-chips" });
      for (const option of DASHBOARD_SOURCES) {
        // A source with nothing in it would chart an empty page; don't offer it.
        if (option === "reading" && readingCount === 0) continue;
        if (option === "games" && gamesCount === 0) continue;
        if (option === "watchlist" && titles.length === 0) continue;
        const chip = chips.createDiv({ cls: "wl-chip is-clickable" });
        chip.setText(SOURCE_LABELS[option]);
        chip.toggleClass("is-active", option === source);
        chip.setAttr("role", "button");
        chip.setAttr("tabindex", "0");
        chip.addEventListener("click", () => {
          source = option;
          render();
        });
      }
    });

    const charts = sourceCharts(source, model, reading, games, depsNow(deps));

    section(el, "By status", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "By status", SOURCE_LABELS[source]);
      renderBars(s, charts.byStatus, "No statuses in use yet.");
    });

    section(el, "By year", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "By year", SOURCE_LABELS[source]);
      renderBars(s, charts.byYear, "No release years known — refresh metadata to fill this in.");
    });

    section(el, "Added over time", (s) => {
      s.addClass("wl-panel");
      sectionHeader(s, "Added over time", `${SOURCE_LABELS[source]} · last 12 months`);
      renderColumns(s, charts.addedOverTime);
    });

    // --- credits -----------------------------------------------------------
    section(el, "Top credits", (s) => {
      const limit = Math.max(1, settings.dashboardTopCredits || 5);
      s.addClass("wl-panel");
      if (source === "reading") {
        // Books have no cast and no studio. The equivalent question is whose
        // work is on the shelf.
        sectionHeader(s, "Top authors", `top ${limit}`);
        const grid = s.createDiv({ cls: "wl-credit-grid" });
        renderCreditList(
          grid,
          "Authors",
          tally([...reading.books, ...reading.manga].map((entry) => entry.author), limit),
          deps,
          // The Library's `author:` query would land on the wrong tab, so these
          // are counts rather than chips.
          null,
        );
        return;
      }
      if (source === "games") {
        sectionHeader(s, "Top platforms", `top ${limit}`);
        const grid = s.createDiv({ cls: "wl-credit-grid" });
        renderCreditList(
          grid,
          "Platforms",
          tally(games.games.flatMap((game) => game.platforms ?? []), limit),
          deps,
          null,
        );
        renderCreditList(
          grid,
          "Genres",
          tally(games.games.map((game) => game.type), limit),
          deps,
          null,
        );
        return;
      }
      sectionHeader(s, "Top credits", `top ${limit}`);
      const grid = s.createDiv({ cls: "wl-credit-grid" });
      renderCreditList(grid, "Cast", model.topCast, deps, "cast");
      renderCreditList(grid, "Directors", model.topDirectors, deps, "director");
      renderCreditList(grid, "Studios", model.topStudios, deps, "studio");
    });

    // --- shelves -----------------------------------------------------------
    section(el, CONTINUE_LABEL[source], (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, CONTINUE_LABEL[source]);
      if (source === "reading") {
        const inProgress = [...reading.books, ...reading.manga]
          .filter((entry) => readingProgress(entry) > 0 && readingProgress(entry) < 100)
          .sort((a, b) => (b.dateModified ?? "").localeCompare(a.dateModified ?? ""))
          .slice(0, DASHBOARD_SHELF_LIMIT);
        if (inProgress.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "Nothing part-read — open a book and tick a page." });
          return;
        }
        const list = s.createDiv({ cls: "wl-recent-list" });
        for (const entry of inProgress) {
          renderSimpleRow(list, {
            title: entry.title,
            coverUrl: entry.coverUrl,
            meta: `${readingProgress(entry)}% · ${progressLabel(entry) || derivedStatus(entry)}`,
          });
        }
        return;
      }
      if (source === "games") {
        const playing = games.games
          .filter((game) => game.status === "Playing")
          .sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""))
          .slice(0, DASHBOARD_SHELF_LIMIT);
        if (playing.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "Nothing in progress — mark a game as Playing." });
          return;
        }
        const list = s.createDiv({ cls: "wl-recent-list" });
        for (const game of playing) {
          renderSimpleRow(list, {
            title: game.title,
            coverUrl: game.coverUrl,
            meta: game.playtimeMinutes > 0 ? formatPlaytime(game.playtimeMinutes) : game.status,
          });
        }
        return;
      }
      renderShelf(
        s,
        model.continueWatching,
        deps,
        "Nothing in progress — start a show and it shows up here.",
      );
    });

    section(el, "Up next", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "Up next");
      if (source === "reading" || source === "games") {
        // Books and games have no episodes; what is "next" for them is a
        // publication or a launch date that has not happened yet.
        const today = toDateString(depsNow(deps));
        const pending =
          source === "reading"
            ? [...reading.books, ...reading.manga]
                .filter((entry) => (entry.releaseDate ?? "") >= today)
                .map((entry) => ({
                  title: entry.title,
                  coverUrl: entry.coverUrl,
                  date: entry.releaseDate as string,
                  detail: entry.author || "Publication",
                }))
            : games.games
                .filter((game) => (game.releaseDate ?? "") >= today)
                .map((game) => ({
                  title: game.title,
                  coverUrl: game.coverUrl,
                  date: game.releaseDate as string,
                  detail: game.platforms?.[0] ?? "Release",
                }));
        pending.sort((a, b) => a.date.localeCompare(b.date));
        if (pending.length === 0) {
          s.createDiv({
            cls: "wl-chart-empty",
            text:
              source === "reading"
                ? "Nothing on the shelf is waiting to be published."
                : "Nothing tracked has a release date still to come.",
          });
          return;
        }
        const list = s.createDiv({ cls: "wl-recent-list" });
        for (const entry of pending.slice(0, DASHBOARD_UP_NEXT_LIMIT)) {
          const days = daysUntil(entry.date, depsNow(deps));
          renderSimpleRow(list, {
            title: entry.title,
            coverUrl: entry.coverUrl,
            meta: [
              entry.detail,
              formatDate(entry.date, settings.dateFormat),
              days === undefined ? "" : formatCountdown(days),
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
        return;
      }
      if (model.upNext.length === 0) {
        s.createDiv({
          cls: "wl-chart-empty",
          text: "Nothing scheduled. Run “Refresh airing data” to check for new episodes.",
        });
        return;
      }
      const list = s.createDiv({ cls: "wl-upcoming-list" });
      for (const entry of model.upNext) renderUpcomingRow(list, entry, deps);
      if (deps.onGoToTab) {
        const more = s.createEl("button", {
          cls: "wl-mini-btn",
          text: "See all upcoming",
          attr: { type: "button" },
        });
        more.addEventListener("click", () => deps.onGoToTab?.("upcoming"));
      }
    });

    // Suggestions sit next to "Continue watching" on purpose: the two answer
    // the same question ten seconds apart — what now, and what next.
    const suggestSource =
      source === "reading" ? deps.onSuggestBooks : source === "games" ? undefined : deps.onSuggest;
    if (suggestSource) {
      section(el, "Suggested for you", (s) => {
        s.addClass("wl-panel", "is-half");
        const head = sectionHeader(s, "Suggested for you");
        if (deps.onOpenSuggestWizard) {
          const wizard = head.createEl("button", {
            cls: "wl-mini-btn",
            text: "Refine…",
            attr: { type: "button", title: "Pick a mood, or something to be like" },
          });
          wizard.addEventListener("click", () => deps.onOpenSuggestWizard?.(false));
        }
        renderSuggestions(s, deps, suggestSource);
      });
    }

    section(el, FINISHED_LABEL[source], (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, FINISHED_LABEL[source]);
      if (source === "reading") {
        const finished = [...reading.books, ...reading.manga]
          .filter((entry) => derivedStatus(entry) === "Completed")
          .sort((a, b) => (b.dateFinished ?? b.dateModified ?? "").localeCompare(a.dateFinished ?? a.dateModified ?? ""))
          .slice(0, 5);
        if (finished.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "Finish a book and it lands here." });
          return;
        }
        const list = s.createDiv({ cls: "wl-recent-list" });
        for (const entry of finished) {
          renderSimpleRow(list, {
            title: entry.title,
            coverUrl: entry.coverUrl,
            meta: entry.author || progressLabel(entry) || "Finished",
          });
        }
        return;
      }
      if (source === "games") {
        const finished = games.games
          .filter((game) => game.status === "Finished")
          .sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""))
          .slice(0, 5);
        if (finished.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "Finish a game and it lands here." });
          return;
        }
        const list = s.createDiv({ cls: "wl-recent-list" });
        for (const game of finished) {
          renderSimpleRow(list, {
            title: game.title,
            coverUrl: game.coverUrl,
            meta: game.playtimeMinutes > 0 ? formatPlaytime(game.playtimeMinutes) : "Finished",
          });
        }
        return;
      }
      if (model.recentlyWatched.length === 0) {
        s.createDiv({ cls: "wl-chart-empty", text: "Tick off an episode and it lands here." });
        return;
      }
      const list = s.createDiv({ cls: "wl-recent-list" });
      for (const title of model.recentlyWatched) {
        renderRecentRow(list, title, deps, progressSentence(title) || title.status);
      }
    });

    section(el, ADDED_LABEL[source], (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, ADDED_LABEL[source]);
      if (source === "reading") {
        const added = [...reading.books, ...reading.manga]
          .slice()
          .sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""))
          .slice(0, 5);
        if (added.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "Nothing on the shelf yet." });
          return;
        }
        const shelf = s.createDiv({ cls: "wl-recent-list" });
        for (const entry of added) {
          const when = formatDate((entry.dateAdded ?? "").slice(0, 10), settings.dateFormat);
          renderSimpleRow(shelf, {
            title: entry.title,
            coverUrl: entry.coverUrl,
            meta: [entry.author, when ? `Added ${when}` : ""].filter(Boolean).join(" · "),
          });
        }
        return;
      }
      if (source === "games") {
        const added = games.games
          .slice()
          .sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""))
          .slice(0, 5);
        if (added.length === 0) {
          s.createDiv({ cls: "wl-chart-empty", text: "No games tracked yet." });
          return;
        }
        const shelf = s.createDiv({ cls: "wl-recent-list" });
        for (const game of added) {
          const when = formatDate((game.dateAdded ?? "").slice(0, 10), settings.dateFormat);
          renderSimpleRow(shelf, {
            title: game.title,
            coverUrl: game.coverUrl,
            meta: [game.platforms?.[0] ?? "", when ? `Added ${when}` : ""].filter(Boolean).join(" · "),
          });
        }
        return;
      }
      const list = s.createDiv({ cls: "wl-recent-list" });
      for (const title of model.recentlyAdded) {
        const added = formatDate(addedDay(title), settings.dateFormat);
        const entry = model.upNext.find((e) => e.title.id === title.id);
        const meta = entry
          ? `${entry.label} · ${formatCountdown(entry.daysUntil)}`
          : added
            ? `Added ${added}`
            : title.type;
        renderRecentRow(list, title, deps, meta);
      }
    });
  };

  render();

  return {
    id: "dashboard",
    el,
    refresh: render,
    destroy: () => {
      // The loader is shared with every other surface, so this tab has to hand
      // its own thumbs back before the DOM goes away.
      deps.posterLoader?.releaseWithin?.(el);
      el.remove();
    },
  };
}
