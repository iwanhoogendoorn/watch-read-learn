/** Watch, Read and Learn — shared constants. No behaviour, no imports from src/. */

export const PLUGIN_ID = "watch-read-learn";
export const VIEW_DISPLAY_NAME = "Watch, Read and Learn";
export const VIEW_ICON = "tv";

/**
 * Identifiers that predate the rename and are deliberately NOT renamed:
 * changing any of them would break something a user already has on disk.
 *
 * - the view type is written into saved workspace layouts
 * - the fence language is typed into every `watchlog` code block in their notes
 * - the URI action appears in links they may have saved outside Obsidian
 *
 * New spellings are registered *alongside* these, never instead of them.
 */
export const VIEW_TYPE_WATCHLOG = "watchlog-view";

/** CSS class prefix. Every class this plugin creates starts with it. */
export const CSS_PREFIX = "wl-";

// --- persistence ------------------------------------------------------------

/** Debounce for disk writes. The UI re-renders synchronously; only IO waits. */
export const SAVE_DEBOUNCE_MS = 600;

/** How long a write of our own suppresses the external-change reload. */
export const SELF_SAVE_ECHO_WINDOW_MS = 2000;

/** How long after a failed write before it is tried again. */
export const SAVE_RETRY_DELAY_MS = 5000;

/** Consecutive automatic retries before a failed write waits for the next edit. */
export const MAX_SAVE_RETRIES = 3;

/** How often the external-change watcher re-reads `data.json`'s mtime. */
export const EXTERNAL_WATCH_INTERVAL_MS = 5000;

/** Activity log cap; oldest entries are dropped from the head. */
export const MAX_HISTORY_ENTRIES = 500;

export const DATA_FILE = "data.json";
export const V3_BACKUP_FILE = "data.json.v3.bak";

// --- http -------------------------------------------------------------------

export const HTTP_TIMEOUT_MS = 8000;

/** Minimum gap between requests to the same provider, milliseconds. */
export const RATE_LIMIT_MS = {
  overseerr: 0,
  plex: 0,
  tmdb: 100,
} as const;

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
/** Poster width for grids; `w500` for the detail pane. */
export const TMDB_POSTER_SIZE = "w342";
export const TMDB_BACKDROP_SIZE = "w780";

export const YOUTUBE_EMBED_BASE = "https://www.youtube-nocookie.com/embed";
export const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch?v=";

// --- status names -----------------------------------------------------------
//
// These five ship as defaults and v3 force-inserted "To be released", so the
// names are safe to key behaviour off. Everything user-facing still reads the
// configured list; only these semantic checks use the literals.

export const STATUS_WATCHING = "Watching";
export const STATUS_PLAN_TO_WATCH = "Plan to watch";
export const STATUS_COMPLETED = "Completed";
export const STATUS_TO_BE_RELEASED = "To be released";
export const STATUS_DROPPED = "Dropped";

/**
 * Statuses that contribute **zero** to "time remaining".
 *
 * v3 had two divergent formulas (`calcTimeRemaining` excluded Dropped, the modal
 * included it). v4 has exactly one, and this is the set it uses.
 * See `report-watchlog.md` §5 item 3.
 */
export const NO_TIME_REMAINING_STATUSES: readonly string[] = [
  STATUS_COMPLETED,
  STATUS_DROPPED,
  STATUS_TO_BE_RELEASED,
];

/** Statuses excluded from dashboard completion ratios (matches v3). */
export const NON_COUNTING_STATUSES: readonly string[] = [STATUS_DROPPED, STATUS_TO_BE_RELEASED];

export const TYPE_MOVIE = "Movie";

/** `settings.defaultAddType` sentinel meaning "reuse the last type I picked". */
export const DEFAULT_ADD_TYPE_LAST_USED = "__wl_last_used__";

// --- widgets ----------------------------------------------------------------

export const FENCE_WATCHLOG = "watchlog";

/**
 * The same grammar under the plugin's own name. Registered alongside
 * `watchlog` — which keeps working forever, because it is already typed into
 * people's notes — so new blocks can be written with the new spelling.
 */
export const FENCE_ALIAS = "watch-read-learn";

/** v3 fences kept alive by compat shims (SPEC D8). */
export const LEGACY_FENCES = [
  "wl-todo",
  "wl-stat",
  "wl-upcoming",
  "wl-nowwatching",
  "wl-now-next",
] as const;

export const WIDGET_DEFAULT_LIMIT_CARDS = 12;
export const WIDGET_DEFAULT_LIMIT_OTHER = 25;

// --- cards ------------------------------------------------------------------

/** `settings.cardSize` (-3..3) → minimum card width in px. */
export const CARD_SIZE_PX = [100, 120, 140, 160, 185, 215, 250] as const;
export const CARD_SIZE_OFFSET = 3;
