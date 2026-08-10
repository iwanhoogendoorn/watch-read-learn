/**
 * The ```watchlog``` fence DSL (SPEC §4.9), ported from foodspot's `parseSource`
 * (`docs/research/report-foodspot.md` §1) — plus translators for every v3 fence
 * (`docs/research/report-watchlog.md` §2.6).
 *
 * The grammar is deliberately trivial: one `key: value` per line, `#` starts a
 * comment, the split is on the **first** colon so values may contain colons
 * (`title: Dexter: Resurrection`). No YAML, no nesting.
 *
 * Every unknown key and every invalid value produces a human-readable issue that
 * quotes the offending input. `spec` is always returned with defaults applied, so
 * a partially broken block can still render something while the error panel —
 * fed by `vocabulary()` — prints the complete legal vocabulary underneath it.
 *
 * Pure module: no obsidian imports, no DOM, no network.
 */
import {
  STATUS_PLAN_TO_WATCH,
  WIDGET_DEFAULT_LIMIT_CARDS,
  WIDGET_DEFAULT_LIMIT_OTHER,
} from "../constants";
import { SORT_KEYS } from "../data/presets";
import { WIDGET_DOMAINS } from "../types";
import type {
  LegacyFence,
  SortDirection,
  SortKey,
  WidgetAiringFilter,
  WidgetIssue,
  WidgetParseResult,
  WidgetPlexFilter,
  WidgetSpec,
  WidgetDomain,
  WidgetStat,
  WidgetView,
} from "../types";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const WIDGET_VIEWS: readonly WidgetView[] = [
  "cards",
  "list",
  "table",
  "stat",
  "random",
  "shortlist",
  "upcoming",
  "now",
];

export const WIDGET_STATS: readonly WidgetStat[] = [
  "time",
  "completed",
  "counts",
  "by-status",
  "pages-read",
  "time-played",
  "reading-completed",
  "games-completed",
];

/**
 * Which library each statistic can be computed from.
 *
 * A stat is only meaningful for its own domain: `pages-read` on
 * `domain: games` is a mistake worth reporting, not a zero worth rendering —
 * a silent 0 looks like an answer.
 */
export const STAT_DOMAINS: Record<WidgetStat, WidgetDomain[]> = {
  time: ["watchlist"],
  completed: ["watchlist", "reading", "games"],
  counts: ["watchlist", "reading", "games"],
  "by-status": ["watchlist", "reading", "games"],
  "pages-read": ["reading"],
  "reading-completed": ["reading"],
  "time-played": ["games"],
  "games-completed": ["games"],
};

export const WIDGET_PLEX_VALUES: readonly WidgetPlexFilter[] = ["available", "partial", "missing"];

export const WIDGET_AIRING_VALUES: readonly WidgetAiringFilter[] = [
  "returning",
  "upcoming",
  "ended",
];

export const WIDGET_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Keys that accumulate across repeated lines instead of overwriting. */
const LIST_KEYS = [
  "id",
  "title",
  "type",
  "status",
  "priority",
  "genre",
  "tag",
  // Parity: the two fields the other libraries are actually browsed by.
  "author",
  "platform",
] as const;

export const WIDGET_KEYS = [
  "view",
  ...LIST_KEYS,
  "plex",
  "requested",
  "airing",
  "favorite",
  "minRating",
  "year",
  "limit",
  "sort",
  "direction",
  "stat",
  "domain",
] as const;

export type WidgetKey = (typeof WIDGET_KEYS)[number];

/** Alternative spellings accepted for a key; the DSL itself is case-insensitive. */
const KEY_ALIASES: Record<string, WidgetKey> = {
  view: "view",
  id: "id",
  ids: "id",
  title: "title",
  titles: "title",
  name: "title",
  type: "type",
  types: "type",
  status: "status",
  statuses: "status",
  priority: "priority",
  priorities: "priority",
  genre: "genre",
  genres: "genre",
  tag: "tag",
  tags: "tag",
  plex: "plex",
  requested: "requested",
  request: "requested",
  airing: "airing",
  favorite: "favorite",
  favourite: "favorite",
  minrating: "minRating",
  "min-rating": "minRating",
  year: "year",
  years: "year",
  limit: "limit",
  sort: "sort",
  direction: "direction",
  dir: "direction",
  stat: "stat",
  domain: "domain",
  library: "domain",
  author: "author",
  authors: "author",
  platform: "platform",
  platforms: "platform",
};

export interface VocabularyEntry {
  key: WidgetKey;
  /** Human summary of the accepted values, ready to print in the error panel. */
  values: string;
  description: string;
}

export interface WidgetVocabulary {
  keys: VocabularyEntry[];
  views: readonly WidgetView[];
  stats: readonly WidgetStat[];
  domains: readonly WidgetDomain[];
  sortKeys: readonly SortKey[];
  directions: readonly SortDirection[];
  plex: readonly WidgetPlexFilter[];
  airing: readonly WidgetAiringFilter[];
  booleans: readonly string[];
  legacyFences: readonly LegacyFence[];
}

const BOOLEAN_VALUES = ["true", "false"] as const;

const LEGACY_FENCE_LIST: readonly LegacyFence[] = [
  "wl-todo",
  "wl-stat",
  "wl-upcoming",
  "wl-nowwatching",
  "wl-now-next",
];

/**
 * Everything legal, in one object. The error panel prints this verbatim so the
 * user never has to leave the note to find out what a block accepts.
 */
export function vocabulary(): WidgetVocabulary {
  return {
    keys: [
      { key: "view", values: WIDGET_VIEWS.join(" | "), description: "Which renderer to use." },
      { key: "id", values: "a title id", description: "Pin one entry; survives renames. Repeatable." },
      { key: "title", values: "a title name", description: "Pin one entry by name. Repeatable." },
      { key: "type", values: "a type name", description: "Case-insensitive match. Repeatable." },
      { key: "status", values: "a status name", description: "Case-insensitive match. Repeatable." },
      { key: "priority", values: "a priority name", description: "Case-insensitive match. Repeatable." },
      { key: "genre", values: "a genre", description: "Matches any of the title's genres. Repeatable." },
      { key: "tag", values: "a tag", description: "Matches any of the title's tags. Repeatable." },
      { key: "author", values: "an author name", description: "Reading blocks: filter by author." },
      { key: "platform", values: "a platform name", description: "Games blocks: filter by platform." },
      { key: "plex", values: WIDGET_PLEX_VALUES.join(" | "), description: "Plex availability." },
      { key: "requested", values: BOOLEAN_VALUES.join(" | "), description: "Overseerr request state." },
      { key: "airing", values: WIDGET_AIRING_VALUES.join(" | "), description: "Airing state." },
      { key: "favorite", values: BOOLEAN_VALUES.join(" | "), description: "Favourites only, or never." },
      { key: "minRating", values: "0–5", description: "Rating floor; unrated titles always pass." },
      { key: "year", values: "2024 or 2020-2025", description: "Release year, or an inclusive range." },
      { key: "limit", values: "a positive whole number", description: "Result cap." },
      { key: "sort", values: SORT_KEYS.join(" | "), description: "Sort key. Defaults per view." },
      { key: "direction", values: WIDGET_DIRECTIONS.join(" | "), description: "Sort direction." },
      { key: "stat", values: WIDGET_STATS.join(" | "), description: "Which statistic `view: stat` shows." },
      {
        key: "domain",
        values: WIDGET_DOMAINS.join(" | "),
        description: "Which library to read. Defaults to the watchlist.",
      },
    ],
    views: WIDGET_VIEWS,
    stats: WIDGET_STATS,
    domains: WIDGET_DOMAINS,
    sortKeys: SORT_KEYS,
    directions: WIDGET_DIRECTIONS,
    plex: WIDGET_PLEX_VALUES,
    airing: WIDGET_AIRING_VALUES,
    booleans: BOOLEAN_VALUES,
    legacyFences: LEGACY_FENCE_LIST,
  };
}

// ---------------------------------------------------------------------------
// Computed defaults
// ---------------------------------------------------------------------------

/** Default sort key per view — short blocks should still order sensibly. */
export function defaultSortForView(view: WidgetView): SortKey {
  switch (view) {
    case "list":
    case "table":
    case "shortlist":
      return "title";
    case "upcoming":
      return "nextAirDate";
    case "now":
      return "dateModified";
    default:
      return "dateAdded";
  }
}

/** Default direction per key: ascending only where ascending reads naturally. */
export function defaultDirectionForKey(key: SortKey): SortDirection {
  switch (key) {
    case "title":
    case "status":
    case "priority":
    case "nextAirDate":
      return "asc";
    default:
      return "desc";
  }
}

export function defaultLimitForView(view: WidgetView): number {
  return view === "cards" ? WIDGET_DEFAULT_LIMIT_CARDS : WIDGET_DEFAULT_LIMIT_OTHER;
}

/** A spec with nothing selected and every default in place. */
export function createWidgetSpec(view: WidgetView = "cards"): WidgetSpec {
  const sort = defaultSortForView(view);
  return {
    view,
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
    limit: defaultLimitForView(view),
    sort,
    direction: defaultDirectionForKey(sort),
  };
}

// ---------------------------------------------------------------------------
// Value parsing helpers
// ---------------------------------------------------------------------------

function issue(line: number, key: string, value: string, message: string): WidgetIssue {
  return { line, key, value, message };
}

/** `key: "value" — reason` — foodspot's error style, quoting the input. */
function valueIssue(line: number, key: string, value: string, reason: string): WidgetIssue {
  return issue(line, key, value, `${key}: "${value}" — ${reason}`);
}

function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
      return true;
    case "false":
    case "no":
      return false;
    default:
      return undefined;
  }
}

const YEAR_RE = /^(\d{4})\s*(?:-\s*(\d{4}))?$/;

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Parse a ```watchlog``` block body.
 *
 * v3 compatibility: a block that pins entries (`id:` / `title:`) and names no
 * `view:` resolves to `view: now` — the tracker card v3's `watchlog` fence drew.
 */
export function parseWidgetSource(source: string): WidgetParseResult {
  const issues: WidgetIssue[] = [];
  const lines = source.split(/\r?\n/);

  // Raw collection first; defaults depend on the view, which may appear last.
  let view: WidgetView | undefined;
  const lists: Record<(typeof LIST_KEYS)[number], string[]> = {
    id: [],
    title: [],
    type: [],
    status: [],
    priority: [],
    genre: [],
    tag: [],
    author: [],
    platform: [],
  };
  let plex: WidgetPlexFilter | undefined;
  let requested: boolean | undefined;
  let airing: WidgetAiringFilter | undefined;
  let favorite: boolean | undefined;
  let minRating: number | undefined;
  let year: { from: number; to: number } | undefined;
  let limit: number | undefined;
  let sort: SortKey | undefined;
  let direction: SortDirection | undefined;
  let stat: WidgetStat | undefined;
  let domain: WidgetDomain | undefined;
  let sawStatus = false;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const colon = line.indexOf(":");
    if (colon === -1) {
      issues.push(issue(lineNo, "", line, `"${line}" is not a "key: value" pair.`));
      return;
    }

    const rawKey = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const key = KEY_ALIASES[rawKey.toLowerCase()];

    if (!key) {
      issues.push(issue(lineNo, rawKey, value, `Unknown key "${rawKey}".`));
      return;
    }

    if (value === "") {
      issues.push(issue(lineNo, key, value, `${key}: value is empty.`));
      return;
    }

    switch (key) {
      case "view": {
        const candidate = value.toLowerCase() as WidgetView;
        if (!WIDGET_VIEWS.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `not a valid view. Use ${WIDGET_VIEWS.join(", ")}.`),
          );
          return;
        }
        view = candidate;
        return;
      }
      case "id":
      case "title":
      case "type":
      case "priority":
      case "genre":
      case "author":
      case "platform":
      case "tag": {
        // Quotes are how a value with a space is written; they are not part of
        // the value ("Frank Herbert" must match the author, not `"Frank`).
        lists[key].push(unquote(value));
        return;
      }
      case "status": {
        sawStatus = true;
        lists.status.push(value);
        return;
      }
      case "plex": {
        const candidate = value.toLowerCase() as WidgetPlexFilter;
        if (!WIDGET_PLEX_VALUES.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `use ${WIDGET_PLEX_VALUES.join(", ")}.`),
          );
          return;
        }
        plex = candidate;
        return;
      }
      case "airing": {
        const candidate = value.toLowerCase() as WidgetAiringFilter;
        if (!WIDGET_AIRING_VALUES.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `use ${WIDGET_AIRING_VALUES.join(", ")}.`),
          );
          return;
        }
        airing = candidate;
        return;
      }
      case "requested": {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          issues.push(valueIssue(lineNo, key, value, "use true or false."));
          return;
        }
        requested = parsed;
        return;
      }
      case "favorite": {
        const parsed = parseBoolean(value);
        if (parsed === undefined) {
          issues.push(valueIssue(lineNo, key, value, "use true or false."));
          return;
        }
        favorite = parsed;
        return;
      }
      case "minRating": {
        const parsed = Number(value.replace(",", "."));
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
          issues.push(valueIssue(lineNo, key, value, "must be a number between 0 and 5."));
          return;
        }
        minRating = parsed;
        return;
      }
      case "year": {
        const match = YEAR_RE.exec(value);
        const from = match?.[1];
        if (!match || from === undefined) {
          issues.push(
            valueIssue(lineNo, key, value, "must be a year (2024) or a range (2020-2025)."),
          );
          return;
        }
        const to = match[2] ?? from;
        const lo = Number(from);
        const hi = Number(to);
        year = { from: Math.min(lo, hi), to: Math.max(lo, hi) };
        return;
      }
      case "limit": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          issues.push(valueIssue(lineNo, key, value, "must be a positive whole number."));
          return;
        }
        limit = parsed;
        return;
      }
      case "sort": {
        const candidate = value as SortKey;
        if (!SORT_KEYS.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `not a valid sort key. Use ${SORT_KEYS.join(", ")}.`),
          );
          return;
        }
        sort = candidate;
        return;
      }
      case "direction": {
        const candidate = value.toLowerCase() as SortDirection;
        if (!WIDGET_DIRECTIONS.includes(candidate)) {
          issues.push(valueIssue(lineNo, key, value, "use asc or desc."));
          return;
        }
        direction = candidate;
        return;
      }
      case "stat": {
        const candidate = value.toLowerCase() as WidgetStat;
        if (!WIDGET_STATS.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `not a valid stat. Use ${WIDGET_STATS.join(", ")}.`),
          );
          return;
        }
        stat = candidate;
        return;
      }
      case "domain": {
        const candidate = value.toLowerCase() as WidgetDomain;
        if (!WIDGET_DOMAINS.includes(candidate)) {
          issues.push(
            valueIssue(lineNo, key, value, `not a library. Use ${WIDGET_DOMAINS.join(", ")}.`),
          );
          return;
        }
        domain = candidate;
        return;
      }
      default:
        return;
    }
  });

  const pinned = lists.id.length > 0 || lists.title.length > 0;
  // v3's `watchlog` fence carried nothing but `id:` and drew a tracker card.
  const resolvedView: WidgetView = view ?? (pinned ? "now" : "cards");

  const spec = createWidgetSpec(resolvedView);
  spec.ids = lists.id;
  spec.titles = lists.title;
  spec.types = lists.type;
  spec.statuses = lists.status;
  spec.priorities = lists.priority;
  spec.genres = lists.genre;
  spec.tags = lists.tag;
  if (lists.author.length > 0) spec.authors = lists.author;
  if (lists.platform.length > 0) spec.platforms = lists.platform;
  if (plex !== undefined) spec.plex = plex;
  if (requested !== undefined) spec.requested = requested;
  if (airing !== undefined) spec.airing = airing;
  if (favorite !== undefined) spec.favorite = favorite;
  if (minRating !== undefined) spec.minRating = minRating;
  if (year !== undefined) spec.year = year;
  if (limit !== undefined) spec.limit = limit;

  // Sort and direction are computed together: an explicit key picks up its own
  // default direction, an explicit direction applies to the view's default key.
  if (sort !== undefined) spec.sort = sort;
  spec.direction = direction ?? defaultDirectionForKey(spec.sort ?? defaultSortForView(resolvedView));

  // The library this block reads. Absent means the watchlist, so every block
  // written before parity keeps meaning exactly what it meant.
  if (domain !== undefined) spec.domain = domain;

  if (stat !== undefined) spec.stat = stat;
  else if (resolvedView === "stat") {
    // A `view: stat` block that names no statistic gets its library's headline
    // one, rather than a watchlist stat that would read as zero everywhere else.
    spec.stat =
      spec.domain === "reading" ? "pages-read" : spec.domain === "games" ? "time-played" : "time";
  }

  // A stat and a library that cannot answer it is a mistake worth reporting:
  // rendering 0 would look like an answer.
  if (spec.stat && !STAT_DOMAINS[spec.stat].includes(spec.domain)) {
    issues.push(
      issue(
        0,
        "stat",
        spec.stat,
        `“${spec.stat}” is not a ${spec.domain} statistic. It works with: ${STAT_DOMAINS[spec.stat].join(", ")}.`,
      ),
    );
  }

  // A shortlist is a to-do list: nothing else makes sense as its default.
  if (resolvedView === "shortlist" && !sawStatus) spec.statuses = [STATUS_PLAN_TO_WATCH];

  return { spec, issues };
}

// ---------------------------------------------------------------------------
// Legacy fences (SPEC D8 · report-watchlog.md §2.6)
// ---------------------------------------------------------------------------

/**
 * A translated v3 block.
 *
 * `spec`/`issues` keep it interchangeable with `parseWidgetSource`, while the
 * extra fields carry the v3-only nuances the frozen `WidgetSpec` has no room
 * for: `compact` is v3's mini/full split, `body` is the normalised legacy body
 * (so `wl-stat: watched` and `wl-stat: remaining` stay distinguishable even
 * though both map to `stat: time`), and `specs` holds every panel — only
 * `wl-now-next` has more than one.
 */
export interface LegacyParseResult extends WidgetParseResult {
  fence: LegacyFence | "watchlog";
  body: string;
  compact: boolean;
  specs: WidgetSpec[];
}

/** Strip one layer of matching quotes, if the user wrote any. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function legacyResult(
  fence: LegacyFence | "watchlog",
  body: string,
  compact: boolean,
  specs: WidgetSpec[],
  issues: WidgetIssue[] = [],
): LegacyParseResult {
  const first = specs[0] ?? createWidgetSpec();
  return { fence, body, compact, specs, spec: first, issues };
}

/** Non-empty, trimmed lines — every legacy grammar is line-oriented. */
function legacyLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * ```wl-todo``` — first non-`mini` line is the title (matched case-insensitively
 * against title names); a line reading exactly `mini` switches to the compact
 * card. Translated to the `now` view, which is the v4 renderer with the same
 * "Next up: Ep N" write-through checkbox.
 */
export function parseWlTodo(source: string): LegacyParseResult {
  const lines = legacyLines(source);
  const compact = lines.some((line) => line.toLowerCase() === "mini");
  const name = lines.find((line) => line.toLowerCase() !== "mini");

  const spec = createWidgetSpec("now");
  spec.limit = 1;
  const issues: WidgetIssue[] = [];
  if (name === undefined) {
    issues.push(issue(1, "title", "", "wl-todo: the block needs a title on its own line."));
  } else {
    spec.titles = [name];
  }
  return legacyResult("wl-todo", name ?? "", compact, [spec], issues);
}

/** The seven exact `wl-stat` bodies, and what v4 renders for each. */
const WL_STAT_BODIES: Record<string, { stat: WidgetStat; compact: boolean }> = {
  watched: { stat: "time", compact: true },
  completed: { stat: "completed", compact: true },
  remaining: { stat: "time", compact: true },
  time: { stat: "time", compact: true },
  "time full": { stat: "time", compact: false },
  "completed full": { stat: "completed", compact: false },
  "time completed full": { stat: "counts", compact: false },
};

/** v3's exact wording, kept so the message a user has seen for years is unchanged. */
export function wlStatUnknownMessage(body: string): string {
  return `wl-stat: unknown stat "${body}". Use watched, completed, remaining, time, time full, completed full, or time completed full.`;
}

/** ```wl-stat``` — body is one of seven exact strings, lower-cased and trimmed. */
export function parseWlStat(source: string): LegacyParseResult {
  const body = legacyLines(source).join(" ").toLowerCase();
  const known = WL_STAT_BODIES[body];
  const spec = createWidgetSpec("stat");
  if (!known) {
    spec.stat = "time";
    return legacyResult("wl-stat", body, true, [spec], [
      issue(1, "stat", body, wlStatUnknownMessage(body)),
    ]);
  }
  spec.stat = known.stat;
  return legacyResult("wl-stat", body, known.compact, [spec]);
}

/**
 * ```wl-upcoming``` — body must be exactly `next` or `next full`; renders the
 * soonest upcoming item. v4 scopes it through the normal `upcoming` view, which
 * fixes v3's once-only bug (recurring/weekly items now appear).
 */
export function parseWlUpcoming(source: string): LegacyParseResult {
  const body = legacyLines(source).join(" ").toLowerCase();
  const spec = createWidgetSpec("upcoming");
  spec.limit = 1;
  if (body !== "next" && body !== "next full") {
    return legacyResult("wl-upcoming", body, true, [spec], [
      issue(1, "body", body, `wl-upcoming: body must be "next" or "next full".`),
    ]);
  }
  return legacyResult("wl-upcoming", body, body === "next", [spec]);
}

/** ```wl-nowwatching``` — empty body, or `full`. Renders the pinned title. */
export function parseWlNowWatching(source: string): LegacyParseResult {
  const body = legacyLines(source).join(" ").toLowerCase();
  const spec = createWidgetSpec("now");
  spec.limit = 1;
  if (body !== "" && body !== "full") {
    return legacyResult("wl-nowwatching", body, true, [spec], [
      issue(1, "body", body, `wl-nowwatching: body must be empty or "full".`),
    ]);
  }
  return legacyResult("wl-nowwatching", body, body === "", [spec]);
}

/**
 * ```wl-now-next``` — no body. A two-column card, so it translates to *two*
 * panels: NOW WATCHING (`now`) and UPCOMING NEXT (`upcoming`).
 */
export function parseWlNowNext(source: string): LegacyParseResult {
  const body = legacyLines(source).join(" ").toLowerCase();
  const now = createWidgetSpec("now");
  now.limit = 1;
  const next = createWidgetSpec("upcoming");
  next.limit = 1;
  const issues: WidgetIssue[] = [];
  if (body !== "") {
    issues.push(issue(1, "body", body, "wl-now-next: this block takes no body."));
  }
  return legacyResult("wl-now-next", body, false, [now, next], issues);
}

/**
 * A v3 ```watchlog``` body: v3 only looked for `/id:\s*(.+)/` and ignored every
 * other line. `parseWidgetSource` already handles a clean `id:` body natively —
 * this is the junk-tolerant fallback for bodies it flags.
 */
export function parseLegacyWatchlog(source: string): LegacyParseResult {
  const match = /^\s*id:\s*(.+)$/im.exec(source);
  const id = match?.[1]?.trim() ?? "";
  const spec = createWidgetSpec("now");
  spec.limit = 1;
  const issues: WidgetIssue[] = [];
  if (id === "") {
    issues.push(issue(1, "id", "", "watchlog: the block needs an `id:` line."));
  } else {
    spec.ids = [id];
  }
  return legacyResult("watchlog", id, false, [spec], issues);
}

/** Dispatch by fence name. */
export function parseLegacyBlock(fence: LegacyFence, source: string): LegacyParseResult {
  switch (fence) {
    case "wl-todo":
      return parseWlTodo(source);
    case "wl-stat":
      return parseWlStat(source);
    case "wl-upcoming":
      return parseWlUpcoming(source);
    case "wl-nowwatching":
      return parseWlNowWatching(source);
    case "wl-now-next":
      return parseWlNowNext(source);
    default:
      return parseLegacyWatchlog(source);
  }
}
