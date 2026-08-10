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
import { NON_COUNTING_STATUSES } from "../../constants";
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
import { derivedStatus } from "../../domains/reading/progress";
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
  queryField: "cast" | "director" | "studio",
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
    if (deps.onJumpToQuery) {
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
function renderRecentRow(parent: HTMLElement, title: TitleV4, deps: TabDeps, meta: string): void {
  const row = parent.createDiv({ cls: "wl-recent-row" });
  renderPosterThumb(row, title, deps, "wl-thumb is-small");
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

    // --- unified card ------------------------------------------------------
    section(el, "Overview", (s) => {
      s.addClass("wl-panel");
      const grid = s.createDiv({ cls: "wl-overview" });
      renderRing(grid, model.percent, `${model.completed} of ${model.counting} completed`);
      const stats = grid.createDiv({ cls: "wl-stat-grid" });
      renderStat(stats, formatMinutes(model.timeWatched), "Time watched");
      // A zero is not a statistic — it is furniture. Only stats with something
      // to say get a slot (the two that are always meaningful stay).
      if (model.timeRemaining > 0)
        renderStat(stats, formatMinutes(model.timeRemaining), "Time remaining");
      renderStat(stats, String(model.total), "Titles tracked");
      if (model.favorites > 0) renderStat(stats, String(model.favorites), "Favourites");
    });

    // --- per type ----------------------------------------------------------
    const typeSection = section(el, "By type", (s) => {
      sectionHeader(s, "By type");
      const grid = s.createDiv({ cls: "wl-type-grid" });
      for (const type of model.byType) {
        const card = grid.createDiv({ cls: "wl-panel wl-type-card" });
        renderRing(card, type.percent, "");
        const body = card.createDiv({ cls: "wl-type-body" });
        body.createDiv({ cls: "wl-type-name", text: type.type });
        body.createDiv({
          cls: "wl-type-meta",
          text: `${type.completed} of ${type.total} completed`,
        });
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
      s.addClass("wl-panel");
      sectionHeader(s, "Top credits", `top ${Math.max(1, settings.dashboardTopCredits || 5)}`);
      const grid = s.createDiv({ cls: "wl-credit-grid" });
      renderCreditList(grid, "Cast", model.topCast, deps, "cast");
      renderCreditList(grid, "Directors", model.topDirectors, deps, "director");
      renderCreditList(grid, "Studios", model.topStudios, deps, "studio");
    });

    // --- shelves -----------------------------------------------------------
    section(el, "Continue watching", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "Continue watching");
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

    section(el, "Recently watched", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "Recently watched");
      if (model.recentlyWatched.length === 0) {
        s.createDiv({ cls: "wl-chart-empty", text: "Tick off an episode and it lands here." });
        return;
      }
      const list = s.createDiv({ cls: "wl-recent-list" });
      for (const title of model.recentlyWatched) {
        renderRecentRow(list, title, deps, progressSentence(title) || title.status);
      }
    });

    section(el, "Recently added", (s) => {
      s.addClass("wl-panel", "is-half");
      sectionHeader(s, "Recently added");
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
