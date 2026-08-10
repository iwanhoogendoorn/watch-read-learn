/**
 * Code-block rendering — SPEC §4.9.
 *
 * One fence (```` ```watchlog ````) whose `view:` key selects the renderer, plus
 * the five legacy fences that `widgets/legacy.ts` translates into the same
 * plans. Everything lands in one registry so a single `watchlog-data-changed`
 * event re-renders every live block in every open note.
 *
 * Structure, ported from foodspot:
 *   - a module-scoped `Map<HTMLElement, entry>` registry;
 *   - a `MarkdownRenderChild` per block whose `onunload` drops the entry and
 *     releases poster observers (no stranded IntersectionObservers);
 *   - per-block `state`, which is what lets `view: random` keep its pick across
 *     a re-render instead of reshuffling on every keystroke elsewhere;
 *   - an error panel that prints the **entire** valid vocabulary, so the user
 *     never has to leave the note to find out what is legal.
 *
 * Dependency injection: the card component (`ui/components/card.ts`) and the
 * real DSL parser (`widgets/parser.ts`) belong to other lanes. Both are injected
 * and both have an interim local fallback, so this module renders correctly on
 * its own and swaps to the real implementations at merge with a one-line change
 * in `main.ts`.
 */
import { MarkdownRenderChild, setIcon, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import {
  FENCE_ALIAS,
  FENCE_WATCHLOG,
  WIDGET_DEFAULT_LIMIT_CARDS,
  WIDGET_DEFAULT_LIMIT_OTHER,
} from "../constants";
import {
  calcTimeRemaining,
  calcTimeWatched,
  episodesRemaining,
  formatMinutes,
  getNextUnwatchedEpisode,
  getProgress,
  isFullyWatched,
  toSeasonEpisode,
} from "../data/episodes";
import {
  DATA_CHANGED_EVENT,
  type CardVariant,
  type Settings,
  type SortDirection,
  type SortKey,
  type TitleV4,
  type WidgetAiringFilter,
  type WidgetIssue,
  type WidgetParseResult,
  type WidgetPlexFilter,
  type WidgetSpec,
  type WidgetStat,
  type WidgetView,
} from "../types";
import { renderDomainBlock } from "./domains";
import {
  buildUpcomingEntries,
  cardContext,
  cardRenderer,
  formatCountdown,
  formatEpisodeCode,
  parseDateOnly,
  plexPill,
  renderPill,
  renderPosterThumb,
  requestPill,
  type TabDeps,
} from "../ui/tabs/upcoming";

// ---------------------------------------------------------------------------
// Vocabulary (the error panel prints all of it)
// ---------------------------------------------------------------------------

export const WIDGET_VIEWS: WidgetView[] = [
  "cards",
  "list",
  "table",
  "stat",
  "random",
  "shortlist",
  "upcoming",
  "now",
];

export const WIDGET_STATS: WidgetStat[] = ["time", "completed", "counts", "by-status"];

export const WIDGET_SORT_KEYS: SortKey[] = [
  "title",
  "dateAdded",
  "dateModified",
  "rating",
  "progress",
  "releaseDate",
  "nextAirDate",
  "timeLeft",
  "year",
  "status",
  "priority",
];

export const WIDGET_PLEX_VALUES: WidgetPlexFilter[] = ["available", "partial", "missing"];
export const WIDGET_AIRING_VALUES: WidgetAiringFilter[] = ["returning", "upcoming", "ended"];

/** Every legal key, with the human description the error panel prints. */
export const WIDGET_KEYS: { key: string; values: string }[] = [
  { key: "view", values: WIDGET_VIEWS.join(" | ") },
  { key: "id", values: "a title id — stable across renames" },
  { key: "title", values: "a title name (exact, case-insensitive)" },
  { key: "type", values: "one of your configured types" },
  { key: "status", values: "one of your configured statuses" },
  { key: "priority", values: "one of your configured priorities" },
  { key: "genre", values: "a genre; repeat the key or comma-separate for any-of" },
  { key: "tag", values: "a tag; repeat the key or comma-separate for any-of" },
  { key: "plex", values: WIDGET_PLEX_VALUES.join(" | ") },
  { key: "requested", values: "true | false" },
  { key: "airing", values: WIDGET_AIRING_VALUES.join(" | ") },
  { key: "favorite", values: "true | false" },
  { key: "minRating", values: "0–5 — unrated titles always pass" },
  { key: "year", values: "2024 or 2020-2025" },
  { key: "limit", values: `positive integer (default ${WIDGET_DEFAULT_LIMIT_CARDS} for cards, ${WIDGET_DEFAULT_LIMIT_OTHER} otherwise)` },
  { key: "sort", values: WIDGET_SORT_KEYS.join(" | ") },
  { key: "direction", values: "asc | desc" },
  { key: "stat", values: `${WIDGET_STATS.join(" | ")} (with view: stat)` },
];

const VALID_KEYS = new Set(WIDGET_KEYS.map((k) => k.key));

// ---------------------------------------------------------------------------
// Interim parser
// ---------------------------------------------------------------------------

/** Defaults before any line is read; `limit`/`sort` are finalised per view. */
export function emptySpec(): WidgetSpec {
  return {
    view: "cards",
    // Parity default: a block that says nothing about its domain is a
    // watchlist block, exactly as every existing one already is.
    domain: "watchlist",
    ids: [],
    titles: [],
    types: [],
    statuses: [],
    priorities: [],
    genres: [],
    tags: [],
    limit: WIDGET_DEFAULT_LIMIT_CARDS,
  };
}

function splitValues(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseBool(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Computed defaults, foodspot-style: a two-line block behaves sensibly without
 * spelling out sort, direction and limit.
 */
export function applyViewDefaults(spec: WidgetSpec, explicit: Set<string>): WidgetSpec {
  if (!explicit.has("limit")) {
    spec.limit = spec.view === "cards" ? WIDGET_DEFAULT_LIMIT_CARDS : WIDGET_DEFAULT_LIMIT_OTHER;
  }
  if (!explicit.has("sort")) {
    spec.sort =
      spec.view === "list" || spec.view === "table" || spec.view === "shortlist"
        ? "title"
        : spec.view === "upcoming"
          ? "nextAirDate"
          : "dateAdded";
  }
  if (!explicit.has("direction")) {
    spec.direction = spec.sort === "title" || spec.sort === "nextAirDate" ? "asc" : "desc";
  }
  if (spec.view === "stat" && !spec.stat) spec.stat = "time";
  // `shortlist` reads as a to-do list, so it implies the planning status.
  if (spec.view === "shortlist" && !explicit.has("status") && spec.statuses.length === 0) {
    spec.statuses = ["Plan to watch"];
  }
  return spec;
}

/**
 * Interim `key: value` parser.
 *
 * Replaced at merge by `widgets/parser.ts` (the corelib lane owns the canonical
 * one); the render side only ever consumes `WidgetParseResult`, so swapping it
 * is a one-line change where the system is constructed.
 */
export function defaultWidgetParse(source: string): WidgetParseResult {
  const spec = emptySpec();
  const issues: WidgetIssue[] = [];
  const explicit = new Set<string>();
  const lines = source.split("\n");

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const colon = line.indexOf(":");
    if (colon < 0) {
      issues.push({
        line: index + 1,
        key: line,
        value: "",
        message: `"${line}" is not a "key: value" pair.`,
      });
      return;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const issue = (message: string): void => {
      issues.push({ line: index + 1, key, value, message });
    };

    if (!VALID_KEYS.has(key)) {
      issue(`Unknown key "${key}".`);
      return;
    }
    if (!value) {
      issue(`${key}: needs a value.`);
      return;
    }
    explicit.add(key);

    switch (key) {
      case "view": {
        const v = value.toLowerCase() as WidgetView;
        if (!WIDGET_VIEWS.includes(v)) issue(`view: "${value}" — must be one of ${WIDGET_VIEWS.join(", ")}.`);
        else spec.view = v;
        break;
      }
      case "id":
        spec.ids.push(...splitValues(value));
        break;
      case "title":
        spec.titles.push(...splitValues(value));
        break;
      case "type":
        spec.types.push(...splitValues(value));
        break;
      case "status":
        spec.statuses.push(...splitValues(value));
        break;
      case "priority":
        spec.priorities.push(...splitValues(value));
        break;
      case "genre":
        spec.genres.push(...splitValues(value));
        break;
      case "tag":
        spec.tags.push(...splitValues(value));
        break;
      case "plex": {
        const v = value.toLowerCase() as WidgetPlexFilter;
        if (!WIDGET_PLEX_VALUES.includes(v)) issue(`plex: "${value}" — must be ${WIDGET_PLEX_VALUES.join(", ")}.`);
        else spec.plex = v;
        break;
      }
      case "airing": {
        const v = value.toLowerCase() as WidgetAiringFilter;
        if (!WIDGET_AIRING_VALUES.includes(v)) issue(`airing: "${value}" — must be ${WIDGET_AIRING_VALUES.join(", ")}.`);
        else spec.airing = v;
        break;
      }
      case "requested": {
        const v = parseBool(value);
        if (v === undefined) issue(`requested: "${value}" — must be true or false.`);
        else spec.requested = v;
        break;
      }
      case "favorite": {
        const v = parseBool(value);
        if (v === undefined) issue(`favorite: "${value}" — must be true or false.`);
        else spec.favorite = v;
        break;
      }
      case "minRating": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 5) issue(`minRating: "${value}" — must be a number 0–5.`);
        else spec.minRating = n;
        break;
      }
      case "year": {
        const range = /^(\d{4})\s*-\s*(\d{4})$/.exec(value);
        const single = /^(\d{4})$/.exec(value);
        if (range) {
          const from = Number(range[1]);
          const to = Number(range[2]);
          spec.year = from <= to ? { from, to } : { from: to, to: from };
        } else if (single) {
          const y = Number(single[1]);
          spec.year = { from: y, to: y };
        } else {
          issue(`year: "${value}" — must be a year like 2024 or a range like 2020-2025.`);
        }
        break;
      }
      case "limit": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) issue(`limit: "${value}" — must be a positive whole number.`);
        else spec.limit = n;
        break;
      }
      case "sort": {
        const v = value as SortKey;
        if (!WIDGET_SORT_KEYS.includes(v)) issue(`sort: "${value}" — must be one of ${WIDGET_SORT_KEYS.join(", ")}.`);
        else spec.sort = v;
        break;
      }
      case "direction": {
        const v = value.toLowerCase() as SortDirection;
        if (v !== "asc" && v !== "desc") issue(`direction: "${value}" — must be asc or desc.`);
        else spec.direction = v;
        break;
      }
      case "stat": {
        const v = value.toLowerCase() as WidgetStat;
        if (!WIDGET_STATS.includes(v)) issue(`stat: "${value}" — must be one of ${WIDGET_STATS.join(", ")}.`);
        else spec.stat = v;
        break;
      }
      default:
        break;
    }
  });

  return { spec: applyViewDefaults(spec, explicit), issues };
}

// ---------------------------------------------------------------------------
// Selection: filter → sort → limit
// ---------------------------------------------------------------------------

function eqAny(values: readonly string[], candidate: string): boolean {
  const needle = candidate.trim().toLowerCase();
  return values.some((v) => v.trim().toLowerCase() === needle);
}

function anyOf(values: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((c) => eqAny(values, c));
}

export function titleYearOf(title: TitleV4): number | null {
  if (typeof title.year === "number" && Number.isFinite(title.year) && title.year > 0) return title.year;
  const date = parseDateOnly(title.releaseDate);
  return date ? date.getFullYear() : null;
}

export function isRequested(title: TitleV4): boolean {
  const request = title.request;
  return Boolean(request && (request.id !== undefined || request.mediaStatus !== undefined));
}

export function airingStateOf(title: TitleV4, now: Date): WidgetAiringFilter | null {
  const airing = title.airing;
  const status = (airing?.showStatus ?? "").toLowerCase();
  if (status === "ended" || status === "canceled" || status === "cancelled") return "ended";

  const release = parseDateOnly(title.releaseDate);
  if (release && release.getTime() > now.getTime()) return "upcoming";
  const next = parseDateOnly(airing?.nextEpisode?.airDate);
  if (next && next.getTime() >= now.getTime()) return "returning";
  if (status === "returning series" || status === "in production" || airing?.inProduction) {
    return "returning";
  }
  return null;
}

/** `plex: missing` deliberately covers "never checked" — the user means "not on Plex". */
export function matchesSpec(title: TitleV4, spec: WidgetSpec, now: Date): boolean {
  if (spec.ids.length > 0 || spec.titles.length > 0) {
    const byId = spec.ids.some((id) => id === title.id);
    const byName = eqAny(spec.titles, title.title);
    if (!byId && !byName) return false;
  }
  if (spec.types.length > 0 && !eqAny(spec.types, title.type)) return false;
  if (spec.statuses.length > 0 && !eqAny(spec.statuses, title.status)) return false;
  if (spec.priorities.length > 0 && !eqAny(spec.priorities, title.priority)) return false;
  if (spec.genres.length > 0 && !anyOf(spec.genres, title.genres ?? [])) return false;
  if (spec.tags.length > 0 && !anyOf(spec.tags, title.tags)) return false;

  if (spec.plex) {
    const state = title.plex?.state ?? "unknown";
    if (spec.plex === "available" && state !== "available") return false;
    if (spec.plex === "partial" && state !== "partial") return false;
    if (spec.plex === "missing" && (state === "available" || state === "partial")) return false;
  }
  if (spec.requested !== undefined && isRequested(title) !== spec.requested) return false;
  if (spec.airing && airingStateOf(title, now) !== spec.airing) return false;
  if (spec.favorite !== undefined && title.favorite !== spec.favorite) return false;
  if (spec.minRating !== undefined && title.rating > 0 && title.rating < spec.minRating) return false;
  if (spec.year) {
    const year = titleYearOf(title);
    if (year === null || year < spec.year.from || year > spec.year.to) return false;
  }
  return true;
}

interface SortValue {
  /** Empty values always sort last, whatever the direction. */
  empty: boolean;
  num?: number;
  text?: string;
}

function sortValue(title: TitleV4, key: SortKey, settings: Settings): SortValue {
  switch (key) {
    case "title":
      return { empty: !title.title, text: title.title.toLowerCase() };
    case "dateAdded": {
      const ms = Date.parse(title.dateAdded);
      return { empty: !Number.isFinite(ms), num: ms };
    }
    case "dateModified": {
      const ms = Date.parse(title.dateModified);
      return { empty: !Number.isFinite(ms), num: ms };
    }
    case "rating":
      return { empty: title.rating <= 0, num: title.rating };
    case "progress":
      return { empty: false, num: getProgress(title) };
    case "releaseDate": {
      const date = parseDateOnly(title.releaseDate);
      return { empty: date === null, num: date?.getTime() };
    }
    case "nextAirDate": {
      const date = parseDateOnly(title.airing?.nextEpisode?.airDate);
      return { empty: date === null, num: date?.getTime() };
    }
    case "timeLeft": {
      const left = calcTimeRemaining(title);
      return { empty: left <= 0, num: left };
    }
    case "year": {
      const year = titleYearOf(title);
      return { empty: year === null, num: year ?? undefined };
    }
    case "status": {
      const index = settings.statuses.findIndex((s) => s.name === title.status);
      return { empty: !title.status, num: index < 0 ? Number.MAX_SAFE_INTEGER : index };
    }
    case "priority": {
      const index = settings.priorities.findIndex((p) => p.name === title.priority);
      return { empty: !title.priority, num: index < 0 ? Number.MAX_SAFE_INTEGER : index };
    }
    default:
      return { empty: true };
  }
}

/**
 * Sort a widget's result set.
 *
 * Status and priority follow the **user's configured list order**, not the
 * alphabet and not a hardcoded list — that was one of v3's papercuts.
 */
export function sortForWidget(
  titles: readonly TitleV4[],
  key: SortKey,
  direction: SortDirection,
  settings: Settings,
): TitleV4[] {
  const sign = direction === "desc" ? -1 : 1;
  return titles.slice().sort((a, b) => {
    const va = sortValue(a, key, settings);
    const vb = sortValue(b, key, settings);
    if (va.empty && vb.empty) return a.title.localeCompare(b.title);
    if (va.empty) return 1;
    if (vb.empty) return -1;
    let cmp = 0;
    if (va.text !== undefined && vb.text !== undefined) cmp = va.text.localeCompare(vb.text);
    else cmp = (va.num ?? 0) - (vb.num ?? 0);
    if (cmp === 0) return a.title.localeCompare(b.title);
    return cmp * sign;
  });
}

export interface SelectOptions {
  settings: Settings;
  now: Date;
  /** Ignore `spec.limit`; the `upcoming` view caps entries, not titles. */
  unlimited?: boolean;
}

export function selectTitles(
  titles: readonly TitleV4[],
  spec: WidgetSpec,
  options: SelectOptions,
): TitleV4[] {
  const matched = titles.filter((t) => matchesSpec(t, spec, options.now));
  const sorted = sortForWidget(
    matched,
    spec.sort ?? "dateAdded",
    spec.direction ?? "desc",
    options.settings,
  );
  return options.unlimited ? sorted : sorted.slice(0, Math.max(1, spec.limit));
}

// ---------------------------------------------------------------------------
// Render plans
// ---------------------------------------------------------------------------

export interface WidgetRenderOptions {
  /** Card variant override — legacy `wl-todo` with a `mini` line. */
  variant?: CardVariant;
  /** Additional stat blocks stacked below the main one (legacy `time completed full`). */
  extraStats?: WidgetStat[];
  /** Legacy `wl-now-next`: NOW WATCHING | UPCOMING NEXT side by side. */
  twoColumn?: boolean;
  /** Names the fence in the error panel heading. */
  errorHeading?: string;
}

export interface WidgetPlan {
  spec: WidgetSpec;
  issues: WidgetIssue[];
  options?: WidgetRenderOptions;
}

export type WidgetTranslator = (source: string) => WidgetPlan;

export interface WidgetDeps extends TabDeps {
  /** `widgets/parser.ts`. Falls back to `defaultWidgetParse` until it lands. */
  parse?: (source: string) => WidgetParseResult;
  /** Open a reading or games entry from a `domain:` block's row. */
  openDomainEntry?: (domain: "reading" | "games", id: string) => void;
}

// ---------------------------------------------------------------------------
// The error panel
// ---------------------------------------------------------------------------

export function renderWidgetError(
  parent: HTMLElement,
  issues: readonly WidgetIssue[],
  heading = "Watch, Read and Learn widget — invalid block",
): HTMLElement {
  const panel = parent.createDiv({ cls: "wl-widget-error" });
  const head = panel.createDiv({ cls: "wl-widget-error-head" });
  setIcon(head.createSpan({ cls: "wl-widget-error-icon" }), "alert-triangle");
  head.createSpan({ text: heading });

  const list = panel.createEl("ul", { cls: "wl-widget-error-list" });
  for (const issue of issues) {
    list.createEl("li", {
      text: issue.line > 0 ? `Line ${issue.line}: ${issue.message}` : issue.message,
    });
  }

  const help = panel.createDiv({ cls: "wl-widget-error-help" });
  help.createDiv({ cls: "wl-widget-error-help-title", text: "Valid keys" });
  const table = help.createDiv({ cls: "wl-widget-vocab" });
  for (const entry of WIDGET_KEYS) {
    const row = table.createDiv({ cls: "wl-widget-vocab-row" });
    row.createEl("code", { text: entry.key });
    row.createSpan({ text: entry.values });
  }
  help.createDiv({
    cls: "wl-widget-error-help-note",
    text: "Lines are `key: value`; `#` starts a comment. Repeat a key (or comma-separate) for any-of matching.",
  });
  return panel;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface BlockState {
  randomId?: string;
}

function emptyNote(parent: HTMLElement, text: string): void {
  parent.createDiv({ cls: "wl-widget-empty", text });
}

function ratingText(title: TitleV4): string {
  return title.rating > 0 ? `★ ${title.rating}` : "—";
}

function metaLine(title: TitleV4): string {
  const bits = [title.type, title.status];
  if (title.totalEpisodes > 1) bits.push(`${getProgress(title)}%`);
  if (title.rating > 0) bits.push(`★ ${title.rating}`);
  return bits.filter(Boolean).join(" · ");
}

function renderCardsView(el: HTMLElement, titles: TitleV4[], deps: WidgetDeps, variant: CardVariant): void {
  if (titles.length === 0) {
    emptyNote(el, "No titles match this block — loosen a filter or add something that does.");
    return;
  }
  const grid = el.createDiv({ cls: `wl-widget-cards is-${variant}` });
  const build = cardRenderer(deps);
  const ctx = cardContext(deps, variant, { embedded: true, showActions: false });
  for (const title of titles) build(grid, title, ctx);
}

function renderListView(el: HTMLElement, titles: TitleV4[], deps: WidgetDeps): void {
  if (titles.length === 0) {
    emptyNote(el, "No titles match this block.");
    return;
  }
  const list = el.createDiv({ cls: "wl-widget-list" });
  for (const title of titles) {
    const row = list.createDiv({ cls: "wl-widget-list-row" });
    renderPosterThumb(row, title, deps, "wl-thumb is-small");
    const body = row.createDiv({ cls: "wl-widget-list-body" });
    body.createDiv({ cls: "wl-widget-list-name", text: title.title });
    body.createDiv({ cls: "wl-widget-list-meta", text: metaLine(title) });
    const pill = plexPill(title) ?? requestPill(title);
    if (pill) renderPill(row, pill);
    attachOpen(row, title, deps);
  }
}

function renderTableView(el: HTMLElement, titles: TitleV4[], deps: WidgetDeps): void {
  if (titles.length === 0) {
    emptyNote(el, "No titles match this block.");
    return;
  }
  const wrap = el.createDiv({ cls: "wl-widget-tablewrap" });
  const table = wrap.createEl("table", { cls: "wl-widget-table" });
  const head = table.createEl("thead").createEl("tr");
  for (const label of ["Title", "Type", "Status", "Progress", "Rating"]) {
    head.createEl("th", { text: label });
  }
  const body = table.createEl("tbody");
  for (const title of titles) {
    const row = body.createEl("tr");
    row.createEl("td", { text: title.title });
    row.createEl("td", { text: title.type });
    row.createEl("td", { text: title.status });
    row.createEl("td", {
      text: title.totalEpisodes > 1 ? `${getProgress(title)}%` : isFullyWatched(title) ? "Watched" : "—",
    });
    row.createEl("td", { text: ratingText(title) });
    attachOpen(row, title, deps);
  }
}

function renderShortlistView(el: HTMLElement, titles: TitleV4[], deps: WidgetDeps): void {
  if (titles.length === 0) {
    emptyNote(el, "Nothing on this shortlist yet — add matching “Plan to watch” titles.");
    return;
  }
  const list = el.createDiv({ cls: "wl-widget-shortlist" });
  for (const title of titles) {
    const row = list.createDiv({ cls: "wl-widget-shortlist-row" });
    const done = isFullyWatched(title);
    row.toggleClass("is-done", done);
    setIcon(row.createSpan({ cls: "wl-widget-shortlist-icon" }), done ? "check-circle-2" : "circle");
    row.createSpan({ cls: "wl-widget-shortlist-name", text: title.title });
    const meta = [title.type, titleYearOf(title) ? String(titleYearOf(title)) : ""]
      .filter(Boolean)
      .join(" · ");
    if (meta) row.createSpan({ cls: "wl-widget-shortlist-meta", text: meta });
    attachOpen(row, title, deps);
  }
}

function renderRandomView(
  el: HTMLElement,
  titles: TitleV4[],
  deps: WidgetDeps,
  state: BlockState,
  rerender: () => void,
): void {
  if (titles.length === 0) {
    emptyNote(el, "Nothing to pick from — this block's filters match no titles.");
    return;
  }
  const current = titles.find((t) => t.id === state.randomId) ?? titles[0];
  if (!current) return;
  state.randomId = current.id;

  const head = el.createDiv({ cls: "wl-widget-random-head" });
  head.createSpan({ cls: "wl-widget-random-label", text: "Tonight?" });
  const shuffle = head.createEl("button", {
    cls: "wl-mini-btn",
    text: "Shuffle",
    attr: { type: "button" },
  });
  shuffle.addEventListener("click", () => {
    if (titles.length > 1) {
      // Guarantee a different pick rather than trusting the die.
      let index = Math.floor(Math.random() * titles.length);
      if (titles[index]?.id === state.randomId) index = (index + 1) % titles.length;
      state.randomId = titles[index]?.id;
    }
    rerender();
  });

  const build = cardRenderer(deps);
  build(el.createDiv({ cls: "wl-widget-random-body" }), current, cardContext(deps, "compact", {
    embedded: true,
    showActions: false,
  }));
}

function renderUpcomingView(el: HTMLElement, titles: TitleV4[], spec: WidgetSpec, deps: WidgetDeps, now: Date): void {
  const entries = buildUpcomingEntries(titles, now).slice(0, Math.max(1, spec.limit));
  if (entries.length === 0) {
    emptyNote(el, "Nothing scheduled for the titles this block matches.");
    return;
  }
  const list = el.createDiv({ cls: "wl-widget-upcoming" });
  for (const entry of entries) {
    const row = list.createDiv({ cls: `wl-widget-upcoming-row is-${entry.kind}` });
    renderPosterThumb(row, entry.title, deps, "wl-thumb is-small");
    const body = row.createDiv({ cls: "wl-widget-upcoming-body" });
    body.createDiv({ cls: "wl-widget-upcoming-name", text: entry.title.title });
    // A released row carries everything in its label, so it has no detail line
    // — joining an empty one leaves a trailing separator (QA1 B4).
    body.createDiv({
      cls: "wl-widget-upcoming-meta",
      text: entry.detail ? `${entry.label} · ${entry.detail}` : entry.label,
    });
    row.createSpan({ cls: "wl-countdown", text: formatCountdown(entry.daysUntil) });
    attachOpen(row, entry.title, deps);
  }
}

/**
 * `now` — pinned titles (or the ones the block pins) with a next-episode
 * checkbox that writes straight through to the store. v3 allowed exactly one
 * pin; v4 allows many, so this renders a list.
 */
function renderNowView(el: HTMLElement, titles: TitleV4[], deps: WidgetDeps): void {
  if (titles.length === 0) {
    emptyNote(el, "Nothing pinned. Pin a title, or add `id:` / `title:` to this block.");
    return;
  }
  const list = el.createDiv({ cls: "wl-widget-now" });
  for (const title of titles) {
    const card = list.createDiv({ cls: "wl-widget-now-card" });
    renderPosterThumb(card, title, deps, "wl-thumb");
    const body = card.createDiv({ cls: "wl-widget-now-body" });
    body.createDiv({ cls: "wl-widget-now-name", text: title.title });
    body.createDiv({ cls: "wl-widget-now-meta", text: metaLine(title) });

    const percent = getProgress(title);
    const track = body.createDiv({ cls: "wl-progress" });
    track.createDiv({ cls: "wl-progress-fill" }).style.setProperty("--wl-progress", `${percent}%`);
    track.setAttr("aria-label", `${percent}% watched`);

    const next = getNextUnwatchedEpisode(title);
    const row = body.createDiv({ cls: "wl-widget-now-next" });
    if (next === null) {
      row.createSpan({ cls: "wl-widget-now-done", text: "Everything watched" });
      continue;
    }
    const pair = toSeasonEpisode(title, next);
    const label =
      title.totalEpisodes <= 1
        ? "Mark as watched"
        : `Next up ${pair ? formatEpisodeCode(pair.season.seasonNumber ?? pair.seasonIndex + 1, pair.episode) : `E${next}`}`;
    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    checkbox.addEventListener("change", () => {
      deps.store.markEpisodeWatched(title.id, next, checkbox.checked);
    });
    row.createSpan({ cls: "wl-widget-now-label", text: label });
    if (title.totalEpisodes > 1) {
      row.createSpan({ cls: "wl-widget-now-left", text: `${episodesRemaining(title)} left` });
    }
  }
}

function renderStatBlock(el: HTMLElement, titles: TitleV4[], stat: WidgetStat, settings: Settings): void {
  const block = el.createDiv({ cls: `wl-widget-stat is-${stat}` });
  switch (stat) {
    case "time": {
      const watched = titles.reduce((sum, t) => sum + calcTimeWatched(t), 0);
      const remaining = titles.reduce((sum, t) => sum + calcTimeRemaining(t), 0);
      const strip = block.createDiv({ cls: "wl-widget-strip" });
      statCell(strip, formatMinutes(watched), "Watched");
      statCell(strip, formatMinutes(remaining), "Remaining");
      break;
    }
    case "completed": {
      const counting = titles.filter((t) => t.status !== "Dropped" && t.status !== "To be released");
      const done = counting.filter((t) => isFullyWatched(t) || t.status === "Completed").length;
      const pct = counting.length === 0 ? 0 : Math.round((done / counting.length) * 100);
      const strip = block.createDiv({ cls: "wl-widget-strip" });
      statCell(strip, String(done), "Completed");
      statCell(strip, `${pct}%`, `of ${counting.length}`);
      break;
    }
    case "counts": {
      const strip = block.createDiv({ cls: "wl-widget-strip" });
      statCell(strip, String(titles.length), "Titles");
      statCell(strip, String(new Set(titles.map((t) => t.type)).size), "Types");
      statCell(strip, String(new Set(titles.flatMap((t) => t.genres ?? [])).size), "Genres");
      statCell(strip, String(titles.filter((t) => t.favorite).length), "Favourites");
      break;
    }
    case "by-status": {
      const tally = new Map<string, number>();
      for (const title of titles) tally.set(title.status, (tally.get(title.status) ?? 0) + 1);
      const order = settings.statuses.map((s) => s.name);
      const rows = [...tally.entries()].sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      if (rows.length === 0) {
        emptyNote(block, "No titles match this block.");
        break;
      }
      const max = rows.reduce((m, r) => Math.max(m, r[1]), 0) || 1;
      const bars = block.createDiv({ cls: "wl-bars" });
      for (const [name, count] of rows) {
        const row = bars.createDiv({ cls: "wl-bar-row" });
        row.createSpan({ cls: "wl-bar-label", text: name || "(no status)" });
        const fill = row.createDiv({ cls: "wl-bar-track" }).createDiv({ cls: "wl-bar-fill" });
        fill.style.setProperty("--wl-bar-pct", `${Math.round((count / max) * 100)}%`);
        row.createSpan({ cls: "wl-bar-count", text: String(count) });
      }
      break;
    }
    default:
      break;
  }
}

function statCell(parent: HTMLElement, value: string, label: string): void {
  const cell = parent.createDiv({ cls: "wl-widget-stat-cell" });
  cell.createDiv({ cls: "wl-widget-stat-value", text: value });
  cell.createDiv({ cls: "wl-widget-stat-label", text: label });
}

function attachOpen(el: HTMLElement, title: TitleV4, deps: WidgetDeps): void {
  if (!deps.onOpenTitle) return;
  el.addClass("is-clickable");
  el.setAttr("role", "button");
  el.tabIndex = 0;
  const open = (): void => deps.onOpenTitle?.(title);
  el.addEventListener("click", open);
  el.addEventListener("keydown", (evt: KeyboardEvent) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      open();
    }
  });
}

/**
 * Paint one block. Exported so tests and the legacy shims can drive it without
 * going through Obsidian's markdown pipeline.
 */
export function renderWidget(
  el: HTMLElement,
  plan: WidgetPlan,
  deps: WidgetDeps,
  state: BlockState,
  rerender: () => void,
): void {
  el.empty();
  el.addClass("wl-widget");
  el.removeClass("is-mini", "is-compact", "is-full");
  if (plan.options?.variant) el.addClass(`is-${plan.options.variant}`);

  if (plan.issues.length > 0) {
    renderWidgetError(el, plan.issues, plan.options?.errorHeading);
  }

  const settings = deps.store.settings;
  const now = deps.now ? deps.now() : new Date();
  const spec = plan.spec;
  const all = deps.store.allTitles();

  // A block that names another library is dispatched whole: the three libraries
  // share a vocabulary, not a shape, and each lane owns its own search, sort and
  // row (see `widgets/domains.ts`). Legacy fences never set `domain`, so they
  // cannot reach this branch.
  if (spec.domain !== "watchlist") {
    renderDomainBlock(
      el,
      spec,
      deps.store.reading,
      deps.store.games,
      { ...(deps.openDomainEntry ? { onOpen: deps.openDomainEntry } : {}) },
      now,
    );
    return;
  }

  if (plan.options?.twoColumn) {
    // Legacy `wl-now-next`: pinned on the left, soonest airing on the right.
    const grid = el.createDiv({ cls: "wl-widget-nownext" });
    const left = grid.createDiv({ cls: "wl-widget-nownext-col" });
    left.createDiv({ cls: "wl-widget-nownext-head", text: "Now watching" });
    renderNowView(left, pinnedFor(spec, all, settings, now), deps);
    const right = grid.createDiv({ cls: "wl-widget-nownext-col" });
    right.createDiv({ cls: "wl-widget-nownext-head", text: "Upcoming next" });
    renderUpcomingView(right, all.slice(), { ...spec, limit: 1 }, deps, now);
    return;
  }

  switch (spec.view) {
    case "cards":
      renderCardsView(el, selectTitles(all, spec, { settings, now }), deps, plan.options?.variant ?? "full");
      break;
    case "list":
      renderListView(el, selectTitles(all, spec, { settings, now }), deps);
      break;
    case "table":
      renderTableView(el, selectTitles(all, spec, { settings, now }), deps);
      break;
    case "shortlist":
      renderShortlistView(el, selectTitles(all, spec, { settings, now }), deps);
      break;
    case "random":
      renderRandomView(el, selectTitles(all, spec, { settings, now, unlimited: true }), deps, state, rerender);
      break;
    case "upcoming":
      renderUpcomingView(el, selectTitles(all, spec, { settings, now, unlimited: true }), spec, deps, now);
      break;
    case "now":
      renderNowView(el, pinnedFor(spec, all, settings, now), deps);
      break;
    case "stat": {
      const scoped = selectTitles(all, spec, { settings, now, unlimited: true });
      renderStatBlock(el, scoped, spec.stat ?? "time", settings);
      for (const extra of plan.options?.extraStats ?? []) renderStatBlock(el, scoped, extra, settings);
      break;
    }
    default:
      renderCardsView(el, selectTitles(all, spec, { settings, now }), deps, "full");
      break;
  }
}

/** `now` falls back to the pinned titles when the block pins nothing itself. */
function pinnedFor(
  spec: WidgetSpec,
  all: readonly TitleV4[],
  settings: Settings,
  now: Date,
): TitleV4[] {
  if (spec.ids.length > 0 || spec.titles.length > 0) {
    return selectTitles(all, spec, { settings, now });
  }
  const pinned = all.filter((t) => t.pinned);
  const pool = pinned.length > 0 ? pinned : all.filter((t) => t.status === "Watching");
  return pool.slice(0, Math.max(1, spec.limit));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegistryEntry {
  el: HTMLElement;
  plan: WidgetPlan;
  state: BlockState;
  deps: WidgetDeps;
}

class WidgetChild extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private readonly onUnload: () => void,
  ) {
    super(containerEl);
  }

  override onunload(): void {
    this.onUnload();
  }
}

/**
 * Owns every live code block. Created once in `main.ts`; `legacy.ts` adds its
 * five fences to the same instance so they share the re-render pass.
 */
export class WidgetSystem {
  private readonly registry = new Map<HTMLElement, RegistryEntry>();
  private readonly cleanups: (() => void)[] = [];
  /** Documents we already listen on — a pop-out window has its own. */
  private readonly listening = new Set<Document>();
  /** Per-document listener removal, so a closed pop-out can be released early. */
  private readonly docCleanups = new Map<Document, () => void>();

  constructor(
    private readonly plugin: Plugin,
    private readonly deps: WidgetDeps,
  ) {
    this.listen(document);
    this.plugin.register(() => this.destroy());
  }

  /**
   * The data bus is a CustomEvent, which `registerDomEvent` cannot type, so it
   * is wired by hand. The store dispatches on `activeDocument`, which in a
   * pop-out window is not the main `document` — so every document that hosts a
   * block gets its own listener, and all of them are released on unload.
   */
  private listen(doc: Document): void {
    if (this.listening.has(doc)) return;
    this.listening.add(doc);
    const listener = (): void => this.rerenderAll();
    doc.addEventListener(DATA_CHANGED_EVENT, listener);
    const cleanup = (): void => doc.removeEventListener(DATA_CHANGED_EVENT, listener);
    this.docCleanups.set(doc, cleanup);
    this.cleanups.push(cleanup);
  }

  /** The canonical fence. */
  registerDefaultFence(): void {
    const parse = this.deps.parse ?? defaultWidgetParse;
    const translate = (source: string) => {
      const result = parse(source);
      return { spec: result.spec, issues: result.issues };
    };
    this.registerFence(FENCE_WATCHLOG, translate);
    // Same grammar, current name. Old blocks keep their old language tag.
    this.registerFence(FENCE_ALIAS, translate);
  }

  registerFence(lang: string, translate: WidgetTranslator): void {
    this.plugin.registerMarkdownCodeBlockProcessor(
      lang,
      (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        this.mount(el, source, translate);
        ctx.addChild(new WidgetChild(el, () => this.release(el)));
      },
    );
  }

  /** Mount (or re-mount) one block. Exposed for tests and legacy shims. */
  mount(el: HTMLElement, source: string, translate: WidgetTranslator): void {
    this.listen(el.ownerDocument);
    let plan: WidgetPlan;
    try {
      plan = translate(source);
    } catch (err) {
      plan = {
        spec: emptySpec(),
        issues: [
          {
            line: 0,
            key: "",
            value: "",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
    const existing = this.registry.get(el);
    const entry: RegistryEntry = {
      el,
      plan,
      state: existing?.state ?? {},
      deps: this.deps,
    };
    this.registry.set(el, entry);
    this.paint(entry);
  }

  private paint(entry: RegistryEntry): void {
    // A repaint empties the container, so the old thumbs must be released first
    // or their observer entries are stranded.
    this.releaseThumbs(entry.el);
    try {
      renderWidget(entry.el, entry.plan, entry.deps, entry.state, () => this.paint(entry));
    } catch (err) {
      entry.el.empty();
      renderWidgetError(entry.el, [
        { line: 0, key: "", value: "", message: err instanceof Error ? err.message : String(err) },
      ]);
      console.error("[wrl] widget render failed", err);
    }
  }

  /**
   * Drop a block. The poster loader observes the *thumbs*, not the container,
   * so every one of them has to be released — that is the leak foodspot's
   * `releaseLazyPhotos` exists to prevent.
   *
   * The **only** way an entry leaves the registry: deleting the entry directly
   * strands the observer's references to its posters until plugin unload.
   */
  private release(el: HTMLElement): void {
    this.releaseThumbs(el);
    this.registry.delete(el);
    this.releaseDocument(el.ownerDocument ?? null);
  }

  /**
   * Stop listening on a pop-out window's document once the last block in it is
   * gone. The main document keeps its listener for the plugin's lifetime — new
   * blocks appear there constantly, and `destroy()` releases it.
   */
  private releaseDocument(doc: Document | null): void {
    if (!doc || doc === document) return;
    if (!this.listening.has(doc)) return;
    for (const el of this.registry.keys()) {
      if (el.ownerDocument === doc) return;
    }
    this.listening.delete(doc);
    const cleanup = this.docCleanups.get(doc);
    if (!cleanup) return;
    this.docCleanups.delete(doc);
    const index = this.cleanups.indexOf(cleanup);
    if (index >= 0) this.cleanups.splice(index, 1);
    cleanup();
  }

  private releaseThumbs(el: HTMLElement): void {
    const loader = this.deps.posterLoader;
    if (!loader) return;
    if (loader.releaseWithin) {
      // Covers card posters (`.wl-poster`) as well as row thumbs — the loader
      // knows what it is observing, this class does not.
      loader.releaseWithin(el);
      return;
    }
    for (const thumb of Array.from(el.querySelectorAll<HTMLElement>(".wl-thumb"))) {
      loader.unobserve(thumb);
    }
  }

  /** Re-render every live block; disconnected ones are collected in the pass. */
  rerenderAll(): void {
    for (const [el, entry] of [...this.registry.entries()]) {
      if (!el.isConnected) {
        // Through `release`, never `registry.delete`: a widget can lose its
        // element without `MarkdownRenderChild.onunload()` ever firing, and the
        // shared observer would keep its posters alive until plugin unload.
        this.release(el);
        continue;
      }
      this.paint(entry);
    }
  }

  get size(): number {
    return this.registry.size;
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listening.clear();
    this.docCleanups.clear();
    for (const el of this.registry.keys()) this.releaseThumbs(el);
    this.registry.clear();
  }
}
