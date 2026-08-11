/**
 * Watch, Read and Learn v4 — frozen cross-module contract.
 *
 * Everything in this file is the interface surface Wave 1+ builds against. Treat
 * these declarations as immutable: adding an optional field is fine, changing or
 * removing anything is a coordinated breaking change.
 *
 * RUNTIME PRESERVATION CONTRACT (SPEC §3.1)
 * -----------------------------------------
 * `WatchLogData`, `Settings` and `TitleV4` are declared *strictly* (no index
 * signatures) so consumers get real type safety. At runtime, however, migration
 * builds each of these objects by spreading the raw parsed JSON, so unknown keys
 * (`reading`, `games`, `drafts`, `maybe`, `omdbApiKey`, …) survive verbatim even
 * though TypeScript cannot see them.
 *
 * Consequence, and it is not optional: **never reconstruct these objects from a
 * literal.** Always mutate in place or spread the existing object. Writing
 * `const d: WatchLogData = { titles, groups, settings, history, schemaVersion }`
 * silently destroys the user's books, games and drafts. Use `readExtra()` /
 * `writeExtra()` if you genuinely need to touch a preserved key.
 */

// ---------------------------------------------------------------------------
// 0. Small shared shapes
// ---------------------------------------------------------------------------

/** A user-configurable named colour (types, statuses, priorities, reviews). */
export interface NamedColor {
  name: string;
  color: string;
}

/** One of the five rating tiers. `settings.ratingSystem` must hold exactly 5. */
export interface RatingTier {
  label: string;
  color: string;
}

/** ISO-8601 timestamp string, e.g. `2026-08-03T13:53:17.033Z`. */
export type IsoTimestamp = string;

/** Calendar date, `YYYY-MM-DD`. No time component, no timezone. */
export type DateString = string;

export type MediaType = "movie" | "tv";

/** Escape hatch for the preserved-but-untyped keys described in the header. */
export function readExtra<T = unknown>(obj: object, key: string): T | undefined {
  return (obj as Record<string, unknown>)[key] as T | undefined;
}

export function writeExtra(obj: object, key: string, value: unknown): void {
  (obj as Record<string, unknown>)[key] = value;
}

// ---------------------------------------------------------------------------
// 1. Persisted data model
// ---------------------------------------------------------------------------

/** Current schema version written by this plugin. */
export const SCHEMA_VERSION = 4;

/**
 * Root of `data.json`.
 *
 * Only the keys v4 owns are declared. Everything v3 wrote that v4 does not use
 * (`reading`, `games`, `drafts`, `maybe`, `airtime`, `collapsedSeasons`,
 * `recommendedDaily`, `pinnedGroupId`, `savedFilterPreset`,
 * `migratedReadingHistory`, `posterRetryDone`, …) is preserved verbatim at
 * runtime — see the header contract.
 */
export interface WatchLogData {
  /** 4 once migrated. Absent or lower on disk means "needs migration". */
  schemaVersion: number;
  titles: TitleV4[];
  groups: Group[];
  settings: Settings;
  /** Activity log, newest last, capped at `MAX_HISTORY_ENTRIES`. */
  history: HistoryEntry[];

  // --- parity domains (SPEC2-PARITY.md) ----------------------------------
  //
  // These three keys are v3's, and v4 has been preserving them verbatim since
  // it shipped. Declaring them does not change that contract: they are still
  // normalised **in place**, so a key v3 wrote and v4 does not read still
  // round-trips. See §10 and `data/migrate.ts`.
  reading?: ReadingData;
  games?: GamesData;
  drafts?: DraftsState;
}

/**
 * One tracked movie or show.
 *
 * Fields marked (v3) carry identical semantics to WatchLog v3.1.1 — see
 * `docs/research/report-watchlog.md` §1.2. Fields marked (v4) are new.
 *
 * Sentinel policy (v4): the v3 `"none"` / `["none"]` sentinels are gone. An
 * unfetched or failed lookup is `""` / `[]`, with the reason recorded in
 * `fetchFailed`. Nothing downstream may ever render the string "none".
 */
export interface TitleV4 {
  // --- identity -----------------------------------------------------------
  /** (v3) Slug of the title at creation time; collisions get `-2`, `-3`… */
  id: string;
  /** (v3) Display name. */
  title: string;
  /** (v3) Must match a `settings.types[].name`. */
  type: string;
  /** (v3) Must match a `settings.statuses[].name`. */
  status: string;
  /** (v3) `""` (none) or a `settings.priorities[].name`. Forced `""` on Completed. */
  priority: string;
  /** (v3) `""` or a `settings.reviews[].name`. */
  review: string;

  // --- user state ---------------------------------------------------------
  /** (v3) 0–5; `0` means unrated and always sorts/filters as empty. */
  rating: number;
  /** (v3) Mirrored into the note's `## Notes` section. */
  notes: string;
  /** (v3) */
  favorite: boolean;
  /** (v3) ISO; present only while `favorite` is true. */
  dateFavorited?: IsoTimestamp;
  /** (v3) v3 allowed exactly one pinned title; v4 allows many (SPEC §4.9 `now`). */
  pinned?: boolean;
  /** (v4) Free-form user tags. Always an array, never undefined after migration. */
  tags: string[];

  // --- dates --------------------------------------------------------------
  dateStarted: DateString | null;
  dateFinished: DateString | null;
  dateAdded: IsoTimestamp;
  /** Bumped on every mutation. */
  dateModified: IsoTimestamp;
  /** A future value forces status to `To be released`. */
  releaseDate: DateString | null;

  // --- episodes -----------------------------------------------------------
  /** (v3) 1 for movies. */
  totalEpisodes: number;
  /** (v3) Minutes per episode; drives every time statistic. */
  episodeDuration: number;
  seasons: Season[];
  /**
   * (v3) **Absolute** episode numbers (season offset + season-relative index),
   * kept sorted ascending, deduped, and — v4 bug fix — guaranteed to contain no
   * skipped episode. See `report-watchlog.md` §5 item 2.
   */
  watchedEpisodes: number[];

  // --- external ids & metadata -------------------------------------------
  externalLink: string;
  tmdbId?: number;
  tmdbMediaType?: MediaType;
  imdbId?: string;
  tvdbId?: number;
  /** (v3) TMDB collection id; `0` means "no collection". */
  collectionId?: number;
  /** (v3) `0` when unused. Kept for round-trip; v4 does not query MAL/AniList. */
  malId?: number;
  anilistId?: number;

  overview?: string;
  genres?: string[];
  /** Release year, derived from `releaseDate` when absent. */
  year?: number;

  posterUrl: string;
  /** User override; wins over `posterUrl`. */
  manualPosterUrl: string;
  trailerUrl: string;
  /** User override; wins over `trailerUrl`. */
  manualTrailerUrl: string;

  /** (v3) API-sourced. `[]` when unknown — never `["none"]`. */
  director: string[];
  cast: string[];
  studio: string[];
  /** (v3) User additions, deduped against the API list. */
  manualDirector: string[];
  manualCast: string[];
  manualStudio: string[];

  communityRating: number;
  communityVotes: number;
  communitySource: "" | "imdb" | "tmdb" | "jikan" | "anilist";
  communityRatingLastFetched: IsoTimestamp | "";

  /**
   * (v4) Why this title still has no `tmdbId`.
   *
   * v3 identified titles through OMDb, so every migrated row arrives without
   * one — and both upstream engines need it. The backfill (`services/match.ts`)
   * writes `tmdbId` when it is sure and this when it is not, so a title that
   * cannot be matched says so in the UI instead of being skipped in silence.
   * Absent means "matched, or never attempted".
   */
  tmdbMatch?: {
    /** `unmatched`: nothing plausible upstream. `ambiguous`: a human must pick. */
    state: "unmatched" | "ambiguous";
    checkedAt: IsoTimestamp;
    /** What was searched for, so the picker can start from it. */
    query?: string;
    /** Shortlist for the picker; only ever set for `ambiguous`. */
    candidates?: { tmdbId: number; mediaType: MediaType; title: string; year?: number }[];
  };

  /** (v4) Replaces the v3 `"none"` sentinels. Absent means "no failure recorded". */
  fetchFailed?: {
    poster?: boolean;
    trailer?: boolean;
    credits?: boolean;
  };

  /**
   * (v4) The Upcoming row the user has ticked off.
   *
   * An episode that aired or a film that came out stays in the "due" bucket
   * until something says otherwise — for a film that is never on Plex and was
   * never requested, that is forever (QA1 B4). Acknowledging records exactly
   * which row was cleared, so a *newer* air/release date brings the title
   * straight back rather than being swallowed by a blanket "dismissed" flag.
   */
  upcomingAcknowledged?: {
    /** `episode` | `release` | `season`. */
    kind: string;
    /** The acknowledged row's date; `null` for an undated announcement. */
    date: DateString | null;
    at: IsoTimestamp;
  };

  // --- derived caches (never user-edited) ---------------------------------
  plex?: PlexCache;
  request?: RequestCache;
  airing?: AiringCache;
}

export interface Season {
  /** e.g. `Season 1`, or `Movie` for films. */
  name: string;
  episodes: number;
  /** Absolute-number offset = sum of preceding seasons' `episodes`. */
  offset: number;
  /** Season-relative numbers, `1..episodes`. Always an array after migration. */
  skippedEpisodes: number[];
  /** (v4) TMDB season number; lets the season grid line up with upstream data. */
  seasonNumber?: number;
  airDate?: DateString | null;
}

export type PlexState = "available" | "partial" | "none" | "unknown";

/** Derived Plex availability cache. Rebuilt by `services/availability.ts`. */
export interface PlexCache {
  state: PlexState;
  /** Plex item id for the movie or the *show*. */
  ratingKey?: string;
  /** Server `machineIdentifier`, for deep links. */
  machineId?: string;
  /** Episodes present on disk, `{s: parentIndex, e: index}`. TV only. */
  episodes?: { s: number; e: number }[];
  /** Plex's own count of episodes on disk — the availability truth. */
  leafCount?: number;
  checkedAt?: IsoTimestamp;
}

/** Overseerr request feedback cache. */
export interface RequestCache {
  /** Overseerr `MediaRequest.id`. */
  id?: number;
  /** `MediaRequestStatus` (1–5). NOT interchangeable with `mediaStatus`. */
  status?: number;
  /** `MediaStatus` (1–6). NOT interchangeable with `status`. */
  mediaStatus?: number;
  /** Seasons Overseerr actually accepted — never assume it echoes the request. */
  seasons?: number[];
  requestedAt?: IsoTimestamp;
  checkedAt?: IsoTimestamp;
}

/** TMDB/Overseerr airing cache (TV shows and unreleased movies). */
export interface AiringCache {
  /** `Returning Series` | `Ended` | `Canceled` | `In Production` | `Planned` | `Pilot`. */
  showStatus?: string;
  inProduction?: boolean;
  nextEpisode?: { season: number; episode: number; airDate: DateString; name?: string };
  lastEpisode?: { season: number; episode: number; airDate: DateString };
  /** Seasons known upstream, excluding specials (season 0). */
  seasonCount?: number;
  /** Episodes known upstream. */
  episodeCount?: number;
  /** Digital release date for movies (TMDB release_dates type >= 4). */
  digitalReleaseDate?: DateString;
  /** Season number present upstream but missing from `title.seasons`. */
  newSeasonDetected?: number;
  /** Episodes in `newSeasonDetected`, so adding it needs no second fetch. */
  newSeasonEpisodes?: number;
  /**
   * The newest upstream season that has not started airing yet — whether or not
   * the tracker already has it.
   *
   * `newSeasonDetected` answers "is something missing from my tracker", which
   * stops being interesting the moment seasons are adopted automatically. This
   * answers "what is this show doing next", which is what the Upcoming row is
   * actually reporting once a season is no longer homework (QA3).
   */
  pendingSeason?: { number: number; episodes: number; airDate?: DateString };
  checkedAt?: IsoTimestamp;
}

export interface Group {
  /** `group-` + slug, collision-suffixed. */
  id: string;
  name: string;
  titleIds: string[];
  dateAdded: IsoTimestamp;
}

export type HistoryAction =
  | "added"
  | "watched"
  | "season"
  | "completed"
  | "rating"
  | "deleted"
  | "requested"
  | "available"
  | "airing";

/**
 * One activity-log row. v3 entries are carried over untouched, so the shape is
 * deliberately loose about extra keys.
 */
export interface HistoryEntry {
  /** `${Date.now()}-${random}`. */
  id: string;
  timestamp: IsoTimestamp;
  /** Human-readable sentence, rendered as-is. */
  message: string;
  /** v3 wrote `Watchlist` | `Reading` | `Games`. v4 only writes `Watchlist`. */
  source?: string;
  action?: HistoryAction | string;
  titleName?: string;
  titleId?: string;
}

// ---------------------------------------------------------------------------
// 2. Settings
// ---------------------------------------------------------------------------

export type DateFormat = "european" | "american" | "iso";
export type TrailerMode = "embed" | "link-only" | "off";
export type LibraryViewMode = "grid" | "table";

/**
 * v4 settings. Keys v3 wrote that v4 dropped (`omdbApiKey`, `colorTheme`,
 * `rawgApiKey`, `listFilters`, …) are preserved verbatim at runtime — see the
 * header contract.
 *
 * Secrets live here in cleartext, inside `data.json`. The settings tab must say so.
 */
export interface Settings {
  // --- carried from v3 ----------------------------------------------------
  types: NamedColor[];
  statuses: NamedColor[];
  priorities: NamedColor[];
  reviews: NamedColor[];
  /** Exactly 5 tiers; reset wholesale if malformed. */
  ratingSystem: RatingTier[];
  rootFolder: string;
  autoCreateFolders: boolean;
  dateFormat: DateFormat;
  halfStarRatings: boolean;
  autoCompleteOnLastEpisode: boolean;
  /**
   * (v4) Adopt new upstream seasons into a followed show automatically.
   *
   * On (the default) a show is followed as **one** thing: seasons that appear
   * upstream are appended to the title as they are announced, and the Upcoming
   * row is a status line rather than a chore. Off restores the v4.0 behaviour —
   * an announcement with an "add it" button.
   */
  autoSyncSeasons: boolean;
  setFinishDateAutomatically: boolean;
  /** -3..3, mapped to px by `CARD_SIZE_PX`. */
  cardSize: number;
  /** A type name, or the sentinel `__wl_last_used__`. */
  defaultAddType: string;
  lastAddedType: string;

  // --- integrations (v4) --------------------------------------------------
  /** Base URL of the Overseerr/Jellyseerr server, no trailing slash, no `/api/v1`. */
  overseerrUrl: string;
  overseerrApiKey: string;
  plexUrl: string;
  plexToken: string;
  /** Auto-discovered from `GET /identity`; used for deep links. */
  plexMachineId: string;
  /** Optional direct-TMDB fallback. v4 read access token (a JWT starting `eyJ`). */
  tmdbToken: string;

  // --- refresh cadences (v4) ---------------------------------------------
  /** Overseerr request polling while the view is open, minutes. 0 disables. */
  requestPollMinutes: number;
  /** Per-title airing refresh TTL, hours. */
  airingTtlHours: number;
  /** Plex availability refresh TTL, hours. */
  plexTtlHours: number;

  // --- behaviour (v4) -----------------------------------------------------
  /** Generate/maintain a markdown note per title. */
  generateNotes: boolean;
  trailerMode: TrailerMode;
  showUpcomingStatusBar: boolean;
  openLibraryAfterAdd: boolean;
  /** Cap for Top Cast/Directors/Studios on the dashboard. */
  dashboardTopCredits: number;

  // --- view state (v4) ----------------------------------------------------
  libraryViewMode: LibraryViewMode;
  filterState: FilterState;
  sort: SortSpec;
  /** `null` when no tiebreaker is configured. */
  secondarySort: SortSpec | null;
  /** Named list, replacing v3's single unnamed slot. */
  savedPresets: Preset[];

  // --- parity (SPEC2-PARITY.md) -------------------------------------------

  /**
   * Custom type name → which catalogue it belongs to.
   *
   * v3's `typeApiMapping`, kept verbatim: `"anime"` routes a type to
   * AniList/Jikan, `"movie"` forces the video family, `""` means "decide from
   * the title". Only the *type name* is user-facing; the routing it implies is
   * `TypeApiRoute`.
   */
  typeApiMapping: Record<string, "anime" | "movie" | "">;
  /** Which anime provider leads. The other is the fallback. */
  animeApiSource: "anilist" | "jikan";

  /** Books. Open Library needs no key; Google Books is useless without one. */
  googleBooksApiKey: string;
  /** Sent to Open Library — a descriptive UA is what buys 3 req/s over 1. */
  openLibraryUserAgent: string;

  /** Games. IGDB is Twitch-OAuth; Steam import is optional on top. */
  igdbClientId: string;
  igdbClientSecret: string;
  steamApiKey: string;
  steamId: string;

  /** Lists and drafts. */
  customListsFolder: string;
  customListTabOrder: string[];
  defaultCustomColumns: CustomColumn[];
  draftsVaultTag: string;
  /** What happens to a draft once it has been added. */
  draftsAfterAdding: "keep" | "dismiss";

  /** Reading/games note generation, mirroring `generateNotes` for titles. */
  generateReadingNotes: boolean;
  generateGameNotes: boolean;
}

// ---------------------------------------------------------------------------
// 3. Filtering, sorting, presets
// ---------------------------------------------------------------------------

export type RequestFilterState = "requested" | "not-requested";
export type AiringFilterState = "returning" | "upcoming" | "ended";

/**
 * Exclusion model, ported from foodspot: state records what is **hidden**, never
 * what is shown, so newly-appearing values are visible by default.
 *
 * Every string facet uses `""` as the synthetic `(empty)` option. Multi-value
 * fields (genres, tags) hide a title only when **all** of its values are excluded.
 */
export interface FilterState {
  excludedTypes: string[];
  excludedStatuses: string[];
  excludedPriorities: string[];
  excludedGenres: string[];
  excludedTags: string[];
  /** Decade buckets as strings: `"1990"`, `"2020"`, `""` for unknown year. */
  excludedDecades: string[];
  excludedPlexStates: PlexState[];
  excludedRequestStates: RequestFilterState[];
  excludedAiringStates: AiringFilterState[];
  /** 0 = any. Unrated titles (rating 0) **always pass**; the UI must say so. */
  minRating: number;
  favoritesOnly: boolean;
}

export type SortKey =
  | "title"
  | "dateAdded"
  | "dateModified"
  | "rating"
  | "communityRating"
  | "progress"
  | "releaseDate"
  | "nextAirDate"
  | "timeLeft"
  | "year"
  | "status"
  | "priority";

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  direction: SortDirection;
}

/** A saved view: query text + facets + both sort levels. */
export interface Preset {
  id: string;
  name: string;
  query: string;
  filters: FilterState;
  sort: SortSpec;
  secondarySort: SortSpec | null;
}

// ---------------------------------------------------------------------------
// 4. Search query language AST (`search/query.ts`)
// ---------------------------------------------------------------------------

export type QueryTextField =
  | "title"
  | "type"
  | "status"
  | "priority"
  | "genre"
  | "tag"
  | "cast"
  | "director"
  | "studio"
  | "note";

export type QueryNumericField = "rating" | "year" | "eps-left" | "runtime" | "community";

export type QueryEnumField = "plex" | "requested" | "airing" | "favorite";

export type NumericOp = ">" | ">=" | "<" | "<=" | "=";

/** Bare term — fuzzy (Fuse) across the whole haystack. */
export interface FuzzyTerm {
  kind: "fuzzy";
  value: string;
  negated: boolean;
}

/** `"quoted"` — exact, accent-insensitive substring. Never fuzzy. */
export interface ExactTerm {
  kind: "exact";
  value: string;
  negated: boolean;
}

/** `field:value` — substring match scoped to one field. */
export interface FieldTerm {
  kind: "field";
  field: QueryTextField;
  value: string;
  negated: boolean;
}

/** `rating:>=4` — numeric comparison. */
export interface NumericTerm {
  kind: "numeric";
  field: QueryNumericField;
  op: NumericOp;
  value: number;
  negated: boolean;
}

/** `plex:yes` / `airing:soon` — enumerated predicate. */
export interface EnumTerm {
  kind: "enum";
  field: QueryEnumField;
  value: string;
  negated: boolean;
}

export type QueryTerm = FuzzyTerm | ExactTerm | FieldTerm | NumericTerm | EnumTerm;

/**
 * A disjunction of conjunctions: within a group every term must match, and a
 * title matches when **any** group matches. `|` splits groups.
 *
 * An unrecognised `foo:bar` prefix is not an error — it degrades to a fuzzy term
 * for the literal string `foo:bar`, which is correct for a live search box.
 */
export interface ParsedQuery {
  raw: string;
  groups: QueryTerm[][];
  /** True when the query contributes no constraint (empty or whitespace). */
  isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// 5. Widget / code-block DSL AST (`widgets/parser.ts`)
// ---------------------------------------------------------------------------

export type WidgetView =
  | "cards"
  | "list"
  | "table"
  | "stat"
  | "random"
  | "shortlist"
  | "upcoming"
  | "now";

/**
 * Which library a view reads from (SPEC2 §"Surfaces that grow").
 *
 * Every view key accepts `domain:`; omitting it means `watchlist`, so every
 * code block written before parity keeps meaning what it meant.
 */
export type WidgetDomain = "watchlist" | "reading" | "games";

export const WIDGET_DOMAINS: readonly WidgetDomain[] = ["watchlist", "reading", "games"];

/**
 * `stat:` vocabulary. The first four are watchlist-era and unchanged; the rest
 * are the parity domains' equivalents, and each is only meaningful for its own
 * domain — `pages-read` on `domain: games` is a validation error, not a zero.
 */
export type WidgetStat =
  | "time"
  | "completed"
  | "counts"
  | "by-status"
  | "pages-read"
  | "time-played"
  | "reading-completed"
  | "games-completed";

export type WidgetPlexFilter = "available" | "partial" | "missing";
export type WidgetAiringFilter = "returning" | "upcoming" | "ended";

/** Inclusive year range. A bare `year: 2024` parses to `{from: 2024, to: 2024}`. */
export interface YearRange {
  from: number;
  to: number;
}

/** Validated, normalised code-block options. */
export interface WidgetSpec {
  view: WidgetView;
  /** Pinned entries, id-first (stable across renames), else resolved by title. */
  ids: string[];
  titles: string[];
  types: string[];
  statuses: string[];
  priorities: string[];
  genres: string[];
  tags: string[];
  plex?: WidgetPlexFilter;
  requested?: boolean;
  airing?: WidgetAiringFilter;
  favorite?: boolean;
  /** 0–5; unrated titles always pass. */
  minRating?: number;
  year?: YearRange;
  limit: number;
  sort?: SortKey;
  direction?: SortDirection;
  stat?: WidgetStat;
  /** Defaults to `watchlist`; see `WidgetDomain`. */
  domain: WidgetDomain;
  /** Reading only: which sub-library. Absent means both. */
  readingKind?: ReadingKind;
  /** Games only. */
  platforms?: string[];
  authors?: string[];
}

/** One `key: value` line that failed validation. */
export interface WidgetIssue {
  line: number;
  key: string;
  value: string;
  message: string;
}

/**
 * Parse result. `spec` is always present (with defaults applied) so a partially
 * broken block can still render something; `issues` drives the error panel that
 * prints the full vocabulary.
 */
export interface WidgetParseResult {
  spec: WidgetSpec;
  issues: WidgetIssue[];
}

/** Legacy v3 fences kept alive by compat shims (SPEC D8). */
export type LegacyFence =
  | "wl-todo"
  | "wl-stat"
  | "wl-upcoming"
  | "wl-nowwatching"
  | "wl-now-next";

// ---------------------------------------------------------------------------
// 6. Store API surface
// ---------------------------------------------------------------------------

/** Emitted on `document` as the single re-render bus. */
export const DATA_CHANGED_EVENT = "watchlog-data-changed";

export interface DataChangedDetail {
  /** What triggered the change, for debugging and selective refresh. */
  reason: string;
  /** Ids of titles touched, when known. */
  titleIds?: string[];
}

/** Patch applied by `updateTitle`; `dateModified` is stamped by the store. */
export type TitlePatch = Partial<Omit<TitleV4, "id" | "dateAdded" | "dateModified">>;

/**
 * The persistence layer. Implemented by `data/store.ts`.
 *
 * Rules the implementation guarantees, and callers may rely on:
 * - `data` is a live object; mutate through the methods, not by replacing it.
 * - Writes are promise-chained, so no save can overtake or clobber another.
 * - `save()` debounces the disk write by `SAVE_DEBOUNCE_MS`; the UI must
 *   re-render synchronously and never wait on it.
 * - Every mutating method dispatches exactly one `watchlog-data-changed`.
 */
export interface WatchLogStoreApi {
  readonly data: WatchLogData;
  readonly settings: Settings;
  /**
   * The parity domains, guaranteed present.
   *
   * `WatchLogData.reading` is optional because a file on disk may not have it;
   * by the time anything holds a store, migration has created it. Four lanes
   * building against `data.reading?.books` would be four lanes writing `?.` for
   * a case that cannot happen.
   */
  readonly reading: ReadingData;
  readonly games: GamesData;

  load(): Promise<void>;
  /** Queue a debounced write. */
  save(reason?: string): void;
  /** Write now and await it. Called on unload and before destructive ops. */
  flush(): Promise<void>;

  getTitle(id: string): TitleV4 | undefined;
  getTitleByName(name: string): TitleV4 | undefined;
  allTitles(): readonly TitleV4[];
  /** Distinct values of a multi- or single-valued string field, sorted. */
  distinct(field: "type" | "status" | "priority" | "genres" | "tags"): string[];

  addTitle(title: TitleV4): TitleV4;
  /**
   * `options.autoStatus: false` suppresses the complete/un-complete rules — for
   * writes the user did not make, such as a season synced in from upstream.
   *
   * `options.preserveAbsoluteEpisodes: true` says the new season list *corrects*
   * the old one rather than extending it, so watched episode numbers mean the
   * same before and after and must not be rebased through the change.
   */
  updateTitle(
    id: string,
    patch: TitlePatch,
    reason?: string,
    options?: { autoStatus?: boolean; preserveAbsoluteEpisodes?: boolean },
  ): TitleV4 | undefined;
  /**
   * Write a derived cache (`plex`, `airing`, `request`) *without* stamping
   * `dateModified` — a background refresh is not the user editing the title,
   * and the "Last updated" sort must not reshuffle because a poll ran.
   *
   * `silent: true` skips the change event so a bulk sweep can emit once at the
   * end instead of once per title.
   */
  updateCaches(
    id: string,
    patch: Pick<TitlePatch, "plex" | "airing" | "request" | "tmdbMatch">,
    options?: { silent?: boolean; reason?: string },
  ): TitleV4 | undefined;
  deleteTitle(id: string): boolean;

  /** Toggle one absolute episode. No-ops on skipped episodes. */
  markEpisodeWatched(id: string, absoluteEpisode: number, watched: boolean): void;
  /** Toggle a whole season's non-skipped episodes. */
  markSeasonWatched(id: string, seasonIndex: number, watched: boolean): void;

  logActivity(entry: Omit<HistoryEntry, "id" | "timestamp">): void;
  clearActivity(): void;

  /** Dispatch the re-render event without touching data (e.g. after settings edits). */
  emitChanged(detail: DataChangedDetail): void;
}

// ---------------------------------------------------------------------------
// 7. Migration
// ---------------------------------------------------------------------------

export interface MigrationReport {
  /** Version found on disk (`0` when absent). */
  fromVersion: number;
  toVersion: number;
  /** True when anything was rewritten and the result must be persisted. */
  changed: boolean;
  titlesMigrated: number;
  /** Per-title notes: sentinels cleared, skipped episodes unwatched, etc. */
  notes: string[];
  /** True when the file on disk was unusable and defaults were substituted. */
  reset: boolean;
}

export interface MigrationResult {
  data: WatchLogData;
  report: MigrationReport;
}

// ---------------------------------------------------------------------------
// 8. HTTP / service clients
// ---------------------------------------------------------------------------

export type ApiSource = "overseerr" | "plex" | "tmdb";

/**
 * Error taxonomy, ported from v3 (`report-watchlog.md` §3) and extended with
 * `timeout`. Every client maps transport and provider failures onto this set so
 * the UI has exactly one place that turns failures into human sentences.
 */
export type ApiErrorReason =
  | "no-key"
  | "auth"
  | "not-enabled"
  | "rate-limited"
  | "server"
  | "not-found"
  | "parse"
  | "network"
  | "timeout"
  | "http";

export interface ApiErrorInit {
  source: ApiSource;
  reason: ApiErrorReason;
  status?: number;
  /** Internal detail for the console; not shown to the user verbatim. */
  detail?: string;
  /** Message lifted from the provider's own error body, when it had one. */
  providerMessage?: string;
  url?: string;
}

/** Options accepted by the `requestUrl` wrapper in `services/http.ts`. */
export interface HttpRequestOptions {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Serialised body. JSON callers should use `json` instead. */
  body?: string;
  /** Convenience: sets the body and `Content-Type: application/json`. */
  json?: unknown;
  contentType?: string;
  /** Defaults to `HTTP_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Which provider this call belongs to; drives `ApiError.source`. */
  source: ApiSource;
  /**
   * Fetch bytes rather than JSON — cover images.
   *
   * Changes the `Accept` header, skips JSON parsing (a PNG is not a failed
   * parse), and surfaces `HttpResponse.bytes`.
   */
  binary?: boolean;
  /**
   * Statuses to return instead of throwing. Overseerr's 202 ("no seasons
   * available") and 409 ("already requested") are meaningful, not failures.
   */
  allowStatuses?: number[];
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Parsed body, or `undefined` when the body was empty or not JSON. */
  json: T | undefined;
  /**
   * The raw bytes, when the caller asked for them.
   *
   * Obsidian's `requestUrl` always returns these; they are only surfaced for
   * binary fetches (cover images), because carrying a copy of every JSON body
   * around would be waste.
   */
  bytes?: ArrayBuffer;
}

// --- Overseerr --------------------------------------------------------------

/** `MediaRequest.status` — the REQUEST's state. Never mix with `MediaStatus`. */
export enum MediaRequestStatus {
  PENDING = 1,
  APPROVED = 2,
  DECLINED = 3,
  FAILED = 4,
  COMPLETED = 5,
}

/** `MediaInfo.status` — the MEDIA's availability. Never mix with `MediaRequestStatus`. */
export enum MediaStatus {
  UNKNOWN = 1,
  PENDING = 2,
  PROCESSING = 3,
  PARTIALLY_AVAILABLE = 4,
  AVAILABLE = 5,
  /** Newer Overseerr only — handle it, do not require it. */
  DELETED = 6,
}

export interface OverseerrSeasonStatus {
  id: number;
  seasonNumber: number;
  status: MediaStatus | number;
  status4k: MediaStatus | number;
}

/**
 * Overseerr's `mediaInfo`. **Absent means "never tracked"** — do not default a
 * missing object to `UNKNOWN`, the distinction drives the UI.
 *
 * `status4k` is tracked independently and sits at `UNKNOWN` forever on servers
 * without a 4K instance — never render that as "missing".
 */
export interface OverseerrMediaInfo {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  status: MediaStatus | number;
  status4k: MediaStatus | number;
  /** Plex item id — when present, TMDB→Plex matching can be skipped entirely. */
  ratingKey?: string | null;
  plexUrl?: string;
  iOSPlexUrl?: string;
  seasons?: OverseerrSeasonStatus[];
  mediaAddedAt?: IsoTimestamp;
  updatedAt?: IsoTimestamp;
  downloadStatus?: OverseerrDownloadStatus[];
}

export interface OverseerrDownloadStatus {
  size?: number;
  sizeLeft?: number;
  estimatedCompletionTime?: IsoTimestamp;
  status?: string;
  title?: string;
}

/** Normalised search hit. `person` results are filtered out by the client. */
export interface OverseerrSearchResult {
  /** TMDB id — the join key across the whole system. */
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  /** `YYYY-MM-DD` (`releaseDate` for movies, `firstAirDate` for TV). */
  releaseDate: DateString | null;
  overview: string;
  /** Full CDN URL, already prefixed; `""` when TMDB has no poster. */
  posterUrl: string;
  voteAverage: number;
  voteCount: number;
  genreIds: number[];
  mediaInfo?: OverseerrMediaInfo;
}

export interface OverseerrSeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: DateString | null;
}

export interface OverseerrEpisodeStub {
  seasonNumber: number;
  episodeNumber: number;
  airDate: DateString | null;
  name?: string;
}

/** Normalised `/movie/{tmdbId}` or `/tv/{tmdbId}` — TMDB metadata + `mediaInfo`. */
export interface OverseerrDetails {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string;
  posterUrl: string;
  backdropUrl: string;
  releaseDate: DateString | null;
  genres: string[];
  /** Minutes. Movie runtime, or the modal episode runtime for TV. */
  runtime: number;
  voteAverage: number;
  voteCount: number;
  imdbId?: string;
  /** Best YouTube trailer URL, `""` when none. */
  trailerUrl: string;
  director: string[];
  cast: string[];
  studio: string[];
  // TV only
  showStatus?: string;
  inProduction?: boolean;
  seasons?: OverseerrSeasonSummary[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  /** `null` when nothing is scheduled — the reliable "is it returning" signal. */
  nextEpisodeToAir?: OverseerrEpisodeStub | null;
  lastEpisodeToAir?: OverseerrEpisodeStub | null;
  mediaInfo?: OverseerrMediaInfo;
}

export interface OverseerrRequest {
  id: number;
  status: MediaRequestStatus | number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  is4k: boolean;
  /** What Overseerr actually accepted after de-duplication. */
  seasons: number[];
  media?: OverseerrMediaInfo;
}

export type RequestOutcome =
  /** 201 — a request row was created. */
  | { kind: "created"; request: OverseerrRequest }
  /** 409 — already requested; `request` is the pre-existing one when resolvable. */
  | { kind: "duplicate"; request?: OverseerrRequest; message: string }
  /** 202 — nothing left to request (all seasons available or pending). */
  | { kind: "nothing-to-request"; message: string }
  /** 403 — missing permission, or a quota was hit. */
  | { kind: "denied"; message: string };

export interface OverseerrConnectionInfo {
  ok: boolean;
  version?: string;
  /** Display name from `/auth/me`; absent when the key is valid but unscoped. */
  user?: string;
  message: string;
}

/** One entry of TMDB's live genre vocabulary. Never hardcoded — it drifts. */
export interface GenreOption {
  id: number;
  name: string;
}

/** Browse by mood rather than by title. Everything optional but `mediaType`. */
export interface DiscoverOptions {
  mediaType?: MediaType;
  /** TMDB genre ids; several means "all of these", as TMDB reads them. */
  genres?: number[];
  sortBy?: string;
  /**
   * The honesty filter. Sorting by rating with no vote floor surfaces films
   * with a single 10/10 vote, which is how a "best comedies" list fills up
   * with things nobody has seen.
   */
  voteCountGte?: number;
  voteAverageGte?: number;
  /** `YYYY-MM-DD`, inclusive. */
  releasedAfter?: DateString;
  releasedBefore?: DateString;
  withRuntimeLte?: number;
  page?: number;
}

export interface OverseerrClient {
  configured(): boolean;
  testConnection(): Promise<OverseerrConnectionInfo>;
  search(query: string, page?: number): Promise<OverseerrSearchResult[]>;
  details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails>;
  /** "People who liked this also liked" — the good list. */
  recommendations(tmdbId: number, mediaType: MediaType): Promise<OverseerrSearchResult[]>;
  /** Shares-a-genre-tuple; noisier, used to pad a thin recommendation list. */
  similar(tmdbId: number, mediaType: MediaType): Promise<OverseerrSearchResult[]>;
  discover(options: DiscoverOptions): Promise<OverseerrSearchResult[]>;
  genres(mediaType: MediaType): Promise<GenreOption[]>;
  /** `seasons` is ignored for movies; pass `"all"` to let the server expand it. */
  request(
    tmdbId: number,
    mediaType: MediaType,
    seasons?: number[] | "all",
  ): Promise<RequestOutcome>;
  getRequest(requestId: number): Promise<OverseerrRequest | undefined>;
  /** Live counts for the settings status chip. */
  requestCounts(): Promise<{ pending: number; approved: number; processing: number; available: number; total: number }>;
}

// --- Plex -------------------------------------------------------------------

export interface PlexSection {
  /** String even in JSON, e.g. `"1"`. */
  key: string;
  type: "movie" | "show" | "artist" | "photo";
  title: string;
  /** Modern agents start `tv.plex.agents.`; `.none` means home videos — skip. */
  agent: string;
  /** Unix seconds. Cheap cache-invalidation signal. */
  scannedAt?: number;
  updatedAt?: number;
}

export interface PlexIdentity {
  machineIdentifier: string;
  version: string;
  claimed: boolean;
}

/** One entry of the GUID index. */
export interface PlexIndexEntry {
  ratingKey: string;
  librarySectionID: string;
  type: "movie" | "show";
  title: string;
  year?: number;
  leafCount?: number;
}

/**
 * `Map` keyed by external GUID string exactly as Plex reports it —
 * `tmdb://1064213`, `imdb://tt28607951`, `tvdb://355641`.
 */
export type PlexGuidIndex = Map<string, PlexIndexEntry>;

export interface PlexEpisodeRef {
  /** Season number (`parentIndex` on the episode). */
  s: number;
  /** Episode number (`index`). */
  e: number;
  ratingKey: string;
}

export interface PlexConnectionInfo {
  ok: boolean;
  machineId?: string;
  version?: string;
  /**
   * True when the server answered but the token could not be proven valid —
   * `allowedNetworks` makes every LAN request return 200 regardless of token.
   * Never infer a valid token from a bare 200.
   */
  tokenUnverified: boolean;
  message: string;
}

export interface PlexClient {
  configured(): boolean;
  /** Unauthenticated reachability probe (`GET /identity`). */
  identity(): Promise<PlexIdentity>;
  testConnection(): Promise<PlexConnectionInfo>;
  sections(): Promise<PlexSection[]>;
  /** Paginated `/library/sections/{key}/all?includeGuids=1`. */
  sectionItems(section: PlexSection): Promise<PlexIndexEntry[]>;
  /** `/library/metadata/{rk}` — Guid children are included by default here. */
  metadata(ratingKey: string): Promise<PlexIndexEntry | undefined>;
  /** `/library/metadata/{showRatingKey}/allLeaves` — every episode, one call. */
  allLeaves(showRatingKey: string): Promise<PlexEpisodeRef[]>;
  /** `/hubs/search?query=` fallback; results are filtered client-side. */
  search(query: string, limit?: number): Promise<PlexIndexEntry[]>;
  /** Web deep link for an item. Requires `plexMachineId`. */
  deepLink(ratingKey: string): string;
}

// --- TMDB (optional direct fallback) ----------------------------------------

export interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official: boolean;
  size: number;
  publishedAt?: IsoTimestamp;
}

export interface TmdbClient {
  configured(): boolean;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  search(query: string, mediaType: MediaType): Promise<OverseerrSearchResult[]>;
  details(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails>;
  videos(tmdbId: number, mediaType: MediaType): Promise<TmdbVideo[]>;
  /** Earliest release of type >= 4 (Digital) for the given region. */
  digitalReleaseDate(tmdbId: number, region: string): Promise<DateString | undefined>;
}

// ---------------------------------------------------------------------------
// 9. UI contracts
// ---------------------------------------------------------------------------

/**
 * The mount-handle pattern used by every component: build it, refresh it in
 * place, tear it down. `destroy` must release observers, intervals and listeners.
 */
export interface MountHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export type CardVariant = "full" | "compact" | "mini";

/**
 * Everything `buildTitleCard(parent, title, ctx)` needs. One card component is
 * shared by Library, Dashboard, Upcoming and every code block, so the context —
 * not the component — decides what is interactive.
 */
export interface CardContext {
  store: WatchLogStoreApi;
  variant: CardVariant;
  /** Hover actions (+1 episode, trailer, request, favourite, ⋮). */
  showActions: boolean;
  showPlexBadge: boolean;
  showAiringChip: boolean;
  showProgress: boolean;
  showRating: boolean;
  /** Render inside a code block: no navigation away from the note. */
  embedded: boolean;
  /** Open the detail modal. Omit to make the card non-clickable. */
  onOpen?: (title: TitleV4) => void;
  /** Chip → filtered Library handoff (`genre:"Sci-Fi"`). */
  onJumpToQuery?: (query: string) => void;
  onRequest?: (title: TitleV4) => void;
  onPlayTrailer?: (title: TitleV4) => void;
  /** Shared lazy-poster loader; cards must not create their own observers. */
  posterLoader?: PosterLoader;
}

export interface PosterLoader {
  observe(el: HTMLElement, url: string): void;
  unobserve(el: HTMLElement): void;
  /**
   * Unobserve every pending thumb inside `root`. A surface that re-renders into
   * a **shared** loader must call this before emptying itself:
   * `IntersectionObserver` holds strong references to its targets, so stranded
   * thumbs keep detached DOM alive for the lifetime of the loader.
   *
   * Optional so a lane's own stand-in loader stays valid; call it with `?.`.
   */
  releaseWithin?(root: HTMLElement): void;
  destroy(): void;
}

/**
 * The seven tabs (SPEC2 §"Surfaces that grow").
 *
 * v3 had eight: Drafts was its own tab, and v4 makes it a panel inside the
 * Library instead — it is a queue of things to triage, not a place to be.
 */
export type TabId =
  | "dashboard"
  | "library"
  | "reading"
  | "games"
  | "upcoming"
  | "lists"
  | "activity";

export const TAB_IDS: readonly TabId[] = [
  "dashboard",
  "library",
  "reading",
  "games",
  "upcoming",
  "lists",
  "activity",
];

export interface TabController extends MountHandle {
  readonly id: TabId;
}

// ===========================================================================
// 10. PARITY CONTRACT (SPEC2-PARITY.md, Wave 8)
// ===========================================================================
//
// Everything below is the frozen surface the four parity lanes build against.
// The same rule as the rest of this file applies, twice as hard here: adding an
// optional field is fine, changing or removing anything is a coordinated
// breaking change.
//
// **The v3 shapes are transcribed, not designed.** `data.reading` and
// `data.games` already sit in the user's `data.json` — v4 migration has been
// preserving them verbatim since day one — and the field names below are the
// ones v3 wrote (`docs/research/report-watchlog.md` §1.3), verified against the
// live vault file. A real vault must load AS-IS: normalisation back-fills what
// is missing and touches nothing else, exactly as titles are handled.

// ---------------------------------------------------------------------------
// 10.1 Reading (books + manga)
// ---------------------------------------------------------------------------

/**
 * The **fixed** five. Unlike watchlist statuses these are not user-editable
 * (v3 line 214), and `To be released` is derived from `releaseDate` rather than
 * chosen — a reading entry with a future release date reports it regardless of
 * what is stored.
 */
export type ReadingStatus =
  | "Reading"
  | "Completed"
  | "Plan to Read"
  | "To be released"
  | "Dropped";

export const READING_STATUSES: readonly ReadingStatus[] = [
  "Reading",
  "Completed",
  "Plan to Read",
  "To be released",
  "Dropped",
];

/** Books count either pages or words; both counters are kept when the unit flips. */
export type ProgressUnit = "pages" | "words";

/** Words fold into pages at this rate for every statistic (v3 `gn = 250`). */
export const WORDS_PER_PAGE = 250;

export type CustomColumnType = "text" | "number" | "select";

export interface CustomColumn {
  id: string;
  name: string;
  type: CustomColumnType;
  /** Only meaningful for `select`. */
  options: string[];
  color: string;
}

/** v3 `reading.books[]`. Field names are v3's; do not rename. */
export interface Book {
  id: string;
  title: string;
  author: string;
  status: ReadingStatus;
  favorite: boolean;
  dateFavorited?: IsoTimestamp;
  rating: number;
  pagesRead: number;
  totalPages: number;
  progressUnit: ProgressUnit;
  wordsRead: number;
  totalWords: number;
  chaptersRead: number;
  totalChapters: number;
  coverUrl: string;
  googleBooksId: string;
  /** (v4.2) Reader-community rating, 0–5 as Google reports it. */
  communityRating?: number;
  communityVotes?: number;
  /** (v4.2) `"google"`; empty/absent means never fetched. */
  communitySource?: string;
  communityRatingLastFetched?: IsoTimestamp;
  /** (v4.2) Subject categories ("Computers", "Fiction"), Google-style. */
  categories?: string[];
  /** Vault path of the generated note, when notes are on. */
  vaultPage: string;
  /** (v4.2) Vault path of the book itself — an epub/pdf that lives in the vault. */
  filePath?: string;
  /** (v4.2) Last PDF page the user was on; the file reopens there. */
  filePage?: number;
  externalLink: string;
  dateStarted: DateString | null;
  dateFinished: DateString | null;
  releaseDate: DateString | null;
  dateAdded: IsoTimestamp;
  dateModified: IsoTimestamp;
  /** Keyed by `CustomColumn.id`. Values are whatever that column's type holds. */
  customFields: Record<string, unknown>;
}

/** v3 `reading.manga[]`: no page/word counters, plus volumes and a MAL id. */
export interface Manga {
  id: string;
  title: string;
  author: string;
  status: ReadingStatus;
  favorite: boolean;
  dateFavorited?: IsoTimestamp;
  rating: number;
  chaptersRead: number;
  totalChapters: number;
  volumesRead: number;
  totalVolumes: number;
  /** **A string in v3**, not a number — unlike `TitleV4.malId`. Kept as written. */
  malId: string;
  coverUrl: string;
  /** (v4.2) Reader-community rating, 0–5. */
  communityRating?: number;
  communityVotes?: number;
  communitySource?: string;
  communityRatingLastFetched?: IsoTimestamp;
  /** (v4.2) Subject categories, Google-style. */
  categories?: string[];
  vaultPage: string;
  /** (v4.2) Vault path of the volume itself — an epub/pdf/cbz in the vault. */
  filePath?: string;
  /** (v4.2) Last PDF page the user was on; the file reopens there. */
  filePage?: number;
  externalLink: string;
  dateStarted: DateString | null;
  dateFinished: DateString | null;
  releaseDate: DateString | null;
  dateAdded: IsoTimestamp;
  dateModified: IsoTimestamp;
  customFields: Record<string, unknown>;
}

export type ReadingKind = "book" | "manga";

/** How a custom field's colour is painted in the table (v3 keeps both styles). */
export type CustomFieldStyle = "fill" | "text";

export interface ReadingSettings {
  defaultFolder: string;
  defaultStatus: ReadingStatus;
  bookCustomFieldStyle: CustomFieldStyle;
  mangaCustomFieldStyle: CustomFieldStyle;
  statusColors: Record<ReadingStatus, string>;
  /**
   * v3 had exactly one unnamed slot. v4 upgrades this to the named
   * `Preset[]` list the Library uses; the legacy value round-trips untouched.
   */
  savedFilterPreset?: unknown;
  savedPresets?: Preset[];
  /** (v4.2) User-added category names, on top of the built-in defaults. */
  categoryOptions?: string[];
}

export interface ReadingData {
  books: Book[];
  manga: Manga[];
  bookColumns: CustomColumn[];
  mangaColumns: CustomColumn[];
  settings: ReadingSettings;
}

// ---------------------------------------------------------------------------
// 10.2 Games
// ---------------------------------------------------------------------------

/** v3 `games.games[]`. Field names are v3's; do not rename. */
export interface Game {
  id: string;
  title: string;
  developer: string;
  publisher: string;
  /** The **genre** — v3 calls this `type` and colours it like a watchlist type. */
  type: string;
  status: string;
  priority: string;
  favorite: boolean;
  /** v3 migrated a legacy `Wishlist` *status* into this flag. */
  wishlist: boolean;
  rating: number;
  /** 0–100. Games have no episode model, so progress is a plain percentage. */
  progress: number;
  playtimeMinutes: number;
  achievementsEarned: number;
  achievementsTotal: number;
  platforms: string[];
  singleplayer: boolean;
  coop: boolean;
  multiplayer: boolean;
  storeUrl: string;
  coverUrl: string;
  apiSource: "" | "rawg" | "igdb";
  apiId: string;
  steamAppId: string;
  lastPlayed: DateString | null;
  externalLink: string;
  vaultPage: string;
  releaseDate: DateString | null;
  dateStarted: DateString | null;
  dateFinished: DateString | null;
  dateAdded: IsoTimestamp;
  dateModified: IsoTimestamp;
}

export interface GameGroup {
  id: string;
  name: string;
  gameIds: string[];
  dateAdded: IsoTimestamp;
}

export interface GamesSettings {
  defaultFolder: string;
  defaultStatus: string;
  /** Six by default: Playing, Not started, Finished, Dropped, To be released, TBA. */
  statuses: NamedColor[];
  /** Twelve genre buckets by default. */
  types: NamedColor[];
  platforms: NamedColor[];
  savedPresets?: Preset[];
}

export interface GamesData {
  games: Game[];
  groups: GameGroup[];
  settings: GamesSettings;
  /** v3's daily suggestion cache. Preserved, not interpreted. */
  recommendedDaily?: unknown;
}

// ---------------------------------------------------------------------------
// 10.3 Drafts and custom lists
// ---------------------------------------------------------------------------

/**
 * v3 `data.drafts`. Keys are the **lowercased** candidate title; `titleDisplay`
 * remembers the original casing so the panel can show what the note said.
 */
export interface DraftsState {
  dismissed: string[];
  added: string[];
  firstSeen: Record<string, IsoTimestamp>;
  titleDisplay: Record<string, string>;
}

/** What a scan found, before the user acts on it. */
export interface DraftCandidate {
  /** Lowercased key — the identity used by `DraftsState`. */
  key: string;
  display: string;
  /** Vault paths the candidate was seen in. */
  sources: string[];
  firstSeen: IsoTimestamp;
  /** A fuzzy hit in an existing domain, when there is one. */
  existing?: { domain: WidgetDomain; id: string; title: string; score: number };
}

export type CustomListColumnType = "text" | "number" | "select" | "date" | "checkbox";

export interface CustomListColumn {
  id: string;
  name: string;
  type: CustomListColumnType;
  options?: string[];
  color?: string;
  width?: number;
}

/**
 * One custom list, stored as its own file under `settings.customListsFolder`.
 *
 * **Unverified against a real v3 list file** — the research report documents the
 * feature and its folder but not the on-disk format, and the test vault has no
 * `CustomLists` folder to read. The lane that implements this owns confirming
 * the format against a v3 export before shipping; treat the shape below as the
 * v4 target, and make the reader tolerant of what it actually finds.
 */
export interface CustomList {
  id: string;
  name: string;
  color?: string;
  columns: CustomListColumn[];
  /** Row values keyed by `CustomListColumn.id`. */
  rows: Record<string, unknown>[];
  dateAdded: IsoTimestamp;
  dateModified: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 10.4 Domain store APIs
// ---------------------------------------------------------------------------

export type ReadingPatch = Partial<Omit<Book & Manga, "id" | "dateAdded" | "dateModified">>;
export type GamePatch = Partial<Omit<Game, "id" | "dateAdded" | "dateModified">>;

/**
 * The reading half of the store, mirroring `WatchLogStoreApi` for titles.
 *
 * Same guarantees: every mutation persists through the one debounced writer,
 * emits `watchlog-data-changed`, and never rebuilds the underlying object (so
 * unknown v3 keys keep round-tripping).
 */
export interface ReadingStoreApi {
  readonly reading: ReadingData;
  allBooks(): readonly Book[];
  allManga(): readonly Manga[];
  getBook(id: string): Book | undefined;
  getManga(id: string): Manga | undefined;
  addBook(book: Book): void;
  addManga(manga: Manga): void;
  updateBook(id: string, patch: ReadingPatch, reason?: string): Book | undefined;
  updateManga(id: string, patch: ReadingPatch, reason?: string): Manga | undefined;
  deleteBook(id: string): boolean;
  deleteManga(id: string): boolean;
  /** Column definitions are per sub-tab. */
  setColumns(kind: ReadingKind, columns: CustomColumn[]): void;
}

export interface GamesStoreApi {
  readonly games: GamesData;
  allGames(): readonly Game[];
  getGame(id: string): Game | undefined;
  addGame(game: Game): void;
  updateGame(id: string, patch: GamePatch, reason?: string): Game | undefined;
  deleteGame(id: string): boolean;
  addGameGroup(name: string): GameGroup;
  updateGameGroup(id: string, patch: Partial<Omit<GameGroup, "id">>): GameGroup | undefined;
  deleteGameGroup(id: string): boolean;
}

// ---------------------------------------------------------------------------
// 10.5 Anime routing and clients
// ---------------------------------------------------------------------------

/**
 * Which provider family a *type name* routes to.
 *
 * v3 stored `typeApiMapping: { customTypeName -> "anime" | "movie" | "" }`; v4
 * keeps that map and resolves it to this. The routing decision is made **once**,
 * here, because it decides which catalogue an id belongs to — and an id looked
 * up in the wrong catalogue silently returns a different work (QA3 fix 4).
 */
export type ApiFamily = "video" | "anime";

export interface TypeApiRoute {
  family: ApiFamily;
  /** For `video`: Overseerr/TMDB with this media type. */
  mediaType?: MediaType;
  /** For `anime`: which provider leads, per `settings.animeApiSource`. */
  provider?: "anilist" | "jikan";
}

export interface AniListTitle {
  romaji: string;
  english: string;
  native: string;
}

export type AniListStatus =
  | "RELEASING"
  | "FINISHED"
  | "NOT_YET_RELEASED"
  | "CANCELLED"
  | "HIATUS";

export interface AniListMedia {
  id: number;
  /** AniList carries the MAL id, which is how a Jikan enrichment finds the same work. */
  malId?: number;
  title: AniListTitle;
  status: AniListStatus;
  /** `TV | TV_SHORT | MOVIE | OVA | ONA | SPECIAL | MUSIC`. */
  format: string;
  /** Total episodes; absent while a show is still airing without a stated count. */
  episodes?: number;
  seasonYear?: number;
  startDate?: DateString | null;
  endDate?: DateString | null;
  coverUrl: string;
  bannerUrl?: string;
  description: string;
  genres: string[];
  studios: string[];
  /** 0–100 on AniList; convert before writing `communityRating` (0–10). */
  averageScore?: number;
  nextAiring?: AniListAiring;
}

/**
 * One scheduled episode.
 *
 * `airingAt` is a **Unix timestamp in seconds, UTC**, and is the only thing
 * worth caching: AniList's own `timeUntilAiring` is computed server-side and is
 * stale the moment it arrives (report §1.2). Countdowns are derived locally,
 * exactly as the TV airing cache already does with `airDate`.
 */
export interface AniListAiring {
  mediaId: number;
  episode: number;
  airingAt: number;
}

export interface AniListSearchResult {
  id: number;
  malId?: number;
  title: AniListTitle;
  format: string;
  status: AniListStatus;
  seasonYear?: number;
  episodes?: number;
  coverUrl: string;
  description: string;
}

export interface AniListAiringQuery {
  /** Restrict to these media ids (`mediaId_in`). */
  mediaIds?: number[];
  /** Unix seconds, inclusive-ish window (`airingAt_greater` / `airingAt_lesser`). */
  from?: number;
  to?: number;
  perPage?: number;
}

/**
 * AniList GraphQL. Keyless for reads, so `configured()` is about whether the
 * user has *chosen* it, not about credentials.
 *
 * Rate limit is **30/min** and burst-limited (degraded since years, confirmed
 * live 2026-08-03), and a 429 arrives as HTTP 429 **with a GraphQL error body
 * and `data: null`** — an implementation must check `errors[]`, not just status.
 */
export interface AniListClient {
  configured(): boolean;
  search(query: string, perPage?: number): Promise<AniListSearchResult[]>;
  details(anilistId: number): Promise<AniListMedia>;
  /** The whole point of preferring AniList: exact per-episode timestamps. */
  airingSchedules(query: AniListAiringQuery): Promise<AniListAiring[]>;
}

export interface JikanAnime {
  malId: number;
  /** Read `titles[]`; v4 never builds on the deprecated `title_english`. */
  title: string;
  titles: { type: string; title: string }[];
  type: string;
  episodes?: number;
  status: "Currently Airing" | "Finished Airing" | "Not yet aired" | string;
  airing: boolean;
  airedFrom: DateString | null;
  airedTo: DateString | null;
  /** `day` is **plural English** ("Fridays"); `timezone` is IANA. Both null for films. */
  broadcast?: { day: string | null; time: string | null; timezone: string | null };
  /** Jikan reports an unknown score as `0`, not null — never average it blindly. */
  score: number;
  imageUrl: string;
  synopsis: string;
  genres: string[];
  studios: string[];
  season?: string | null;
  year?: number | null;
}

/**
 * Jikan v4 (MyAnimeList scraper). Fallback and MAL-id source.
 *
 * 3 req/s and 60/min, and because it scrapes MAL it inherits MAL's outages — a
 * `504 BadResponse` means "upstream is down", which deserves a long backoff
 * rather than a retry.
 */
export interface JikanClient {
  configured(): boolean;
  search(query: string, limit?: number): Promise<JikanAnime[]>;
  full(malId: number): Promise<JikanAnime>;
  /** `day` is the singular lowercase filter (`friday`), not Jikan's "Fridays". */
  schedules(day?: string): Promise<JikanAnime[]>;
}

// ---------------------------------------------------------------------------
// 10.6 Book and game clients
// ---------------------------------------------------------------------------

export interface BookSearchResult {
  /** Open Library work/edition key (`/works/OL893414W`) or Google volume id. */
  id: string;
  source: "openlibrary" | "googlebooks";
  title: string;
  authors: string[];
  firstPublishYear?: number;
  isbn?: string;
  pageCount?: number;
  coverUrl: string;
  description?: string;
  /** Google's 0–5 reader average, when the volume carries one. */
  averageRating?: number;
  ratingsCount?: number;
  /** Subject categories, when the volume carries them. */
  categories?: string[];
}

/**
 * Open Library. Keyless, but the descriptive `User-Agent` is what buys 3 req/s
 * instead of 1 — send it always.
 *
 * Cover URLs must carry `?default=false`: without it a missing cover returns
 * **HTTP 200 with a 43-byte blank placeholder**, which caches as a real image.
 */
/** A search hit carrying what the book recommender ranks on. */
export interface BookSuggestionHit extends BookSearchResult {
  /** Open Library's own subjects, which are far more specific than a shelf. */
  subjects: string[];
  ratingsAverage: number;
  ratingsCount: number;
}

export interface OpenLibraryClient {
  configured(): boolean;
  /**
   * Fetch a cover's bytes through the same User-Agent and limiter as the API.
   *
   * Covers count against Open Library's rate limit and an unidentified caller
   * gets a third of the allowance — so they cannot be handed to `<img src>`,
   * which is Chromium's request, not ours (W8 review P1-5).
   */
  coverBytes(url: string): Promise<ArrayBuffer | undefined>;
  search(query: string, limit?: number): Promise<BookSearchResult[]>;
  /** `/api/books` — richer and batchable, unlike the redirecting `/isbn/{isbn}.json`. */
  byIsbn(isbn: string): Promise<BookSearchResult | undefined>;
  coverUrl(key: "isbn" | "id" | "olid", value: string, size?: "S" | "M" | "L"): string;
  /** What Open Library thinks a book is about — the seed for a subject search. */
  subjectsFor(title: string, author: string): Promise<string[]>;
  /** Books sharing these subjects, best-rated first. Subjects are ANDed. */
  bySubjects(subjects: readonly string[], limit?: number): Promise<BookSuggestionHit[]>;
  byAuthor(author: string, limit?: number): Promise<BookSuggestionHit[]>;
}

/**
 * Google Books. **A key is mandatory**, not optional: keyless requests are
 * attributed to a shared project whose daily quota is literally `0`, so they
 * fail immediately (report §2.2, proven live).
 */
export interface GoogleBooksClient {
  configured(): boolean;
  search(query: string, limit?: number): Promise<BookSearchResult[]>;
  byIsbn(isbn: string): Promise<BookSearchResult | undefined>;
}

export interface GameSearchResult {
  /** IGDB numeric id as a string, to match `Game.apiId`. */
  id: string;
  source: "igdb";
  title: string;
  summary: string;
  /** Unix **seconds** on IGDB. */
  firstReleaseDate?: number;
  coverUrl: string;
  platforms: string[];
  genres: string[];
  developer?: string;
  publisher?: string;
  rating?: number;
}

/**
 * IGDB v4. Twitch client-credentials OAuth; the token lasts ~60 days and must
 * be cached rather than re-requested per call.
 *
 * Two constraints shape the implementation: queries go in a **POST body** in
 * Apicalypse syntax, and IGDB **rejects browser requests** (CORS) — so every
 * call goes through Obsidian's `requestUrl`, never `fetch`. 4 req/s, 8 concurrent.
 */
export interface IgdbClient {
  configured(): boolean;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  search(query: string, limit?: number): Promise<GameSearchResult[]>;
  details(igdbId: string): Promise<GameSearchResult | undefined>;
}

export interface SteamOwnedGame {
  appId: string;
  title: string;
  playtimeMinutes: number;
  lastPlayed: DateString | null;
}

export interface SteamClient {
  configured(): boolean;
  ownedGames(): Promise<SteamOwnedGame[]>;
  achievements(appId: string): Promise<{ earned: number; total: number } | undefined>;
}

// ---------------------------------------------------------------------------
// 10.7 CSV
// ---------------------------------------------------------------------------

/** v3's fixed 14 watchlist columns, in order. Compat matters more than taste. */
export const CSV_WATCHLIST_COLUMNS = [
  "title",
  "type",
  "status",
  "priority",
  "rating",
  "totalEpisodes",
  "episodeDuration",
  "dateStarted",
  "dateFinished",
  "releaseDate",
  "dateAdded",
  "externalLink",
  "notes",
  "studio",
] as const;

export interface CsvImportRow {
  /** Parsed values keyed by the *mapped* field name. */
  values: Record<string, string>;
  /** Set when an existing entry matches by title (and year, when both have one). */
  duplicateOf?: string;
  /**
   * Whether the earlier copy is already in the library or earlier in this file.
   *
   * The user's next move differs: skip something they already have, or fix a
   * file that lists the same thing twice.
   */
  duplicateSource?: "library" | "file";
}

export interface CsvImportPlan {
  domain: WidgetDomain;
  /** Source column → target field, from the synonym table plus user overrides. */
  mapping: Record<string, string>;
  rows: CsvImportRow[];
  /** Columns the mapper could not place; imported into nothing, reported to the user. */
  unmapped: string[];
}
