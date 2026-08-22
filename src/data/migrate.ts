/**
 * v3 → v4 migration (SPEC §3.1).
 *
 * Pure — no obsidian imports — so `tests/migrate.test.ts` can run it against a
 * fixture of the real `data.json`.
 *
 * THE PRESERVATION RULE
 * ---------------------
 * Migration works **in place**: it mutates the object `loadData()` returned and
 * hands the same reference back, typed as `WatchLogData`. Every key v4 does not
 * know about — `reading`, `games`, `drafts`, `maybe`, `airtime`,
 * `collapsedSeasons`, `posterRetryDone`, `settings.omdbApiKey`, … — survives
 * untouched because we never rebuild these objects from a literal. Titles are
 * rebuilt, but by spreading the original, so per-title unknown keys survive too.
 *
 * That is what makes a rollback to v3 possible and what keeps the user's books
 * and games intact even though v4 has no code that reads them.
 */
import {
  DEFAULT_ADD_TYPE_LAST_USED,
  STATUS_COMPLETED,
  STATUS_PLAN_TO_WATCH,
  STATUS_TO_BE_RELEASED,
  TYPE_MOVIE,
} from "../constants";
import { VISIBLE_SHELVES_KEY, statusShelfId } from "../domains/shelves";
import {
  READING_STATUSES,
  SCHEMA_VERSION,
  readExtra,
  writeExtra,
  type CustomColumn,
  type FilterState,
  type Group,
  type ReadingStatus,
  type MigrationReport,
  type MigrationResult,
  type NamedColor,
  type Season,
  type Settings,
  type SortKey,
  type Preset,
  type SortSpec,
  type TitleV4,
  type WatchLogData,
} from "../types";
import {
  DEFAULT_GAME_PLATFORMS,
  DEFAULT_GAME_STATUSES,
  DEFAULT_GAME_TYPES,
  DEFAULT_PRIORITIES,
  DEFAULT_RATING_SYSTEM,
  DEFAULT_READING_STATUS_COLORS,
  DEFAULT_REVIEWS,
  DEFAULT_STATUSES,
  DEFAULT_TYPES,
  DEFAULT_WATCHED_VIA,
  FULL_VIEW_DEFAULT_MARKER,
  WATCHED_STATUS_RENAME_MARKER,
  createDefaultData,
  createDefaultSettings,
  createDraftsState,
  createFilterState,
  createGamesData,
  createGamesSettings,
  createReadingData,
  createReadingSettings,
  createTitle,
  slugify,
} from "./schema";
import {
  LEGACY_IMAGE_CACHE_FOLDERS,
  defaultImageCacheFolder,
} from "../services/imagecache";
import {
  recomputeOffsets,
  rememberSeasonGeometry,
  sanitizeWatchedEpisodes,
  skippedAbsolute,
} from "./episodes";

const MAX_REPORT_NOTES = 200;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** `""` and `null` both mean "no date". */
function dateOrNull(value: unknown): string | null {
  const s = str(value).trim();
  return s.length > 0 ? s : null;
}

/** v3's "API returned nothing" sentinel. */
function isNoneSentinel(value: string): boolean {
  return value.trim().toLowerCase() === "none";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** True when the file on disk predates v4 and must be rewritten. */
export function needsMigration(raw: unknown): boolean {
  if (!isRecord(raw)) return true;
  return num(raw.schemaVersion, 0) < SCHEMA_VERSION;
}

/**
 * Migrate whatever `loadData()` returned into v4 shape.
 *
 * `null`/`undefined` (fresh install) yields defaults with `reset: false`.
 * A file that is not an object with an array `titles` is unusable; v3 reset in
 * that case and so do we, but `report.reset` is set so the caller can refuse to
 * overwrite the user's file without asking.
 */
export function migrate(raw: unknown): MigrationResult {
  const report: MigrationReport = {
    fromVersion: isRecord(raw) ? num(raw.schemaVersion, 0) : 0,
    toVersion: SCHEMA_VERSION,
    changed: false,
    titlesMigrated: 0,
    notes: [],
    reset: false,
  };

  const note = (message: string): void => {
    if (report.notes.length < MAX_REPORT_NOTES) report.notes.push(message);
  };

  if (raw === null || raw === undefined) {
    return { data: createDefaultData(), report: { ...report, changed: true } };
  }

  if (!isRecord(raw) || !Array.isArray(raw.titles)) {
    note("data.json was not one of ours (no titles array); starting from defaults");
    return { data: createDefaultData(), report: { ...report, changed: true, reset: true } };
  }

  // From here on `raw` IS the data object. Mutate, never rebuild.
  const data = raw as unknown as WatchLogData;
  const rawRec = raw;

  const settings = migrateSettings(isRecord(rawRec.settings) ? rawRec.settings : {}, note);
  rawRec.settings = settings;

  const rawTitles = rawRec.titles as unknown[];
  const seenIds = new Set<string>();
  const titles: TitleV4[] = [];
  for (const rawTitle of rawTitles) {
    if (!isRecord(rawTitle)) {
      note("dropped a titles[] entry that was not an object");
      continue;
    }
    titles.push(migrateTitle(rawTitle, seenIds, note));
  }
  rawRec.titles = titles;
  report.titlesMigrated = titles.length;

  // Needs both halves in hand — the settings list is what decides whether the
  // rename happens at all, and the titles are what must not be left pointing at
  // a name that list no longer has.
  renameCompletedStatus(settings, titles, note);

  rawRec.groups = migrateGroups(rawRec.groups);
  if (!Array.isArray(rawRec.history)) rawRec.history = [];

  // The parity domains (SPEC2-PARITY.md). Same discipline as titles: normalise
  // **in place** so every key v3 wrote and v4 does not read keeps round-tripping.
  migrateReading(rawRec, note);
  migrateGames(rawRec, note);
  migrateDrafts(rawRec);

  rawRec.schemaVersion = SCHEMA_VERSION;
  report.changed = true;

  return { data, report };
}

// ---------------------------------------------------------------------------
// Parity domains: reading, games, drafts
//
// Every function here mutates the object it was given rather than returning a
// fresh one. That is not a style choice — `data.reading` in a real vault carries
// v3 keys this version has never heard of, and rebuilding the object from a
// literal is how they would disappear (see the header contract in `types.ts`).
// ---------------------------------------------------------------------------

/** Back-fill missing keys on `target` from `defaults`, touching nothing else. */
function fillMissing(target: Rec, defaults: Rec): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) target[key] = value;
  }
}

function migrateCustomColumns(value: unknown): CustomColumn[] {
  if (!Array.isArray(value)) return [];
  const out: CustomColumn[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const type = str(raw.type, "text");
    raw.id = str(raw.id) || `col-${index + 1}`;
    raw.name = str(raw.name, `Column ${index + 1}`);
    raw.type = type === "number" || type === "select" ? type : "text";
    raw.options = strArray(raw.options);
    raw.color = str(raw.color);
    out.push(raw as unknown as CustomColumn);
  });
  return out;
}

function readingStatusOf(value: unknown): ReadingStatus {
  const raw = str(value, "Plan to Read");
  return (READING_STATUSES as readonly string[]).includes(raw)
    ? (raw as ReadingStatus)
    : "Plan to Read";
}

/** One book or manga row, normalised in place. */
function migrateReadingEntry(raw: Rec, kind: "book" | "manga", index: number): void {
  const now = new Date().toISOString();
  raw.id = str(raw.id) || `${kind}-${index + 1}`;
  raw.title = str(raw.title, "Untitled");
  raw.author = str(raw.author);
  raw.status = readingStatusOf(raw.status);
  raw.favorite = bool(raw.favorite);
  raw.rating = num(raw.rating, 0);
  raw.chaptersRead = num(raw.chaptersRead, 0);
  raw.totalChapters = num(raw.totalChapters, 0);
  raw.coverUrl = isNoneSentinel(str(raw.coverUrl)) ? "" : str(raw.coverUrl);
  raw.vaultPage = str(raw.vaultPage);
  raw.externalLink = str(raw.externalLink);
  raw.dateStarted = dateOrNull(raw.dateStarted);
  raw.dateFinished = dateOrNull(raw.dateFinished);
  raw.releaseDate = dateOrNull(raw.releaseDate);
  raw.dateAdded = str(raw.dateAdded) || now;
  raw.dateModified = str(raw.dateModified) || raw.dateAdded;
  if (!isRecord(raw.customFields)) raw.customFields = {};

  if (kind === "book") {
    const unit = str(raw.progressUnit, "pages");
    raw.progressUnit = unit === "words" ? "words" : "pages";
    raw.pagesRead = num(raw.pagesRead, 0);
    raw.totalPages = num(raw.totalPages, 0);
    raw.wordsRead = num(raw.wordsRead, 0);
    raw.totalWords = num(raw.totalWords, 0);
    raw.googleBooksId = str(raw.googleBooksId);
  } else {
    raw.volumesRead = num(raw.volumesRead, 0);
    raw.totalVolumes = num(raw.totalVolumes, 0);
    // v3 stored the MAL id as a **string** here (unlike `TitleV4.malId`).
    raw.malId = typeof raw.malId === "number" ? String(raw.malId) : str(raw.malId);
  }
}

function migrateReading(rawRec: Rec, note: (m: string) => void): void {
  if (rawRec.reading !== undefined && !isRecord(rawRec.reading)) {
    note("data.reading was not an object; replaced with an empty reading library");
    rawRec.reading = createReadingData();
    return;
  }
  const reading = (rawRec.reading ??= createReadingData() as unknown as Rec) as Rec;

  const books = Array.isArray(reading.books) ? reading.books : [];
  const manga = Array.isArray(reading.manga) ? reading.manga : [];
  reading.books = books.filter(isRecord);
  reading.manga = manga.filter(isRecord);
  (reading.books as Rec[]).forEach((entry, i) => migrateReadingEntry(entry, "book", i));
  (reading.manga as Rec[]).forEach((entry, i) => migrateReadingEntry(entry, "manga", i));
  if (books.length !== (reading.books as unknown[]).length) {
    note("dropped a reading entry that was not an object");
  }

  reading.bookColumns = migrateCustomColumns(reading.bookColumns);
  reading.mangaColumns = migrateCustomColumns(reading.mangaColumns);

  if (!isRecord(reading.settings)) reading.settings = {};
  const settings = reading.settings as Rec;
  const defaults = createReadingSettings() as unknown as Rec;
  fillMissing(settings, defaults);
  settings.defaultStatus = readingStatusOf(settings.defaultStatus);
  if (!isRecord(settings.statusColors)) settings.statusColors = {};
  fillMissing(settings.statusColors as Rec, { ...DEFAULT_READING_STATUS_COLORS });
  if (!Array.isArray(settings.savedPresets)) settings.savedPresets = [];
}

function migrateGame(raw: Rec, index: number, statuses: string[]): void {
  const now = new Date().toISOString();
  raw.id = str(raw.id) || `game-${index + 1}`;
  raw.title = str(raw.title, "Untitled");
  raw.developer = str(raw.developer);
  raw.publisher = str(raw.publisher);
  raw.type = str(raw.type);
  raw.priority = str(raw.priority);

  // v3 carried a legacy `Wishlist` *status*; it became a boolean flag.
  const status = str(raw.status, "Not started");
  if (status.toLowerCase() === "wishlist") {
    raw.wishlist = true;
    raw.status = statuses.includes("Not started") ? "Not started" : (statuses[0] ?? "Not started");
  } else {
    raw.status = status;
    raw.wishlist = bool(raw.wishlist);
  }

  raw.favorite = bool(raw.favorite);
  raw.rating = num(raw.rating, 0);
  raw.progress = Math.max(0, Math.min(100, num(raw.progress, 0)));
  raw.playtimeMinutes = Math.max(0, num(raw.playtimeMinutes, 0));
  raw.achievementsEarned = Math.max(0, num(raw.achievementsEarned, 0));
  raw.achievementsTotal = Math.max(0, num(raw.achievementsTotal, 0));
  raw.platforms = strArray(raw.platforms);
  raw.singleplayer = bool(raw.singleplayer);
  raw.coop = bool(raw.coop);
  raw.multiplayer = bool(raw.multiplayer);
  raw.storeUrl = str(raw.storeUrl);
  raw.coverUrl = isNoneSentinel(str(raw.coverUrl)) ? "" : str(raw.coverUrl);
  const source = str(raw.apiSource);
  raw.apiSource = source === "rawg" || source === "igdb" ? source : "";
  raw.apiId = typeof raw.apiId === "number" ? String(raw.apiId) : str(raw.apiId);
  raw.steamAppId = typeof raw.steamAppId === "number" ? String(raw.steamAppId) : str(raw.steamAppId);
  raw.lastPlayed = dateOrNull(raw.lastPlayed);
  raw.externalLink = str(raw.externalLink);
  raw.vaultPage = str(raw.vaultPage);
  raw.releaseDate = dateOrNull(raw.releaseDate);
  raw.dateStarted = dateOrNull(raw.dateStarted);
  raw.dateFinished = dateOrNull(raw.dateFinished);
  raw.dateAdded = str(raw.dateAdded) || now;
  raw.dateModified = str(raw.dateModified) || raw.dateAdded;
}

function migrateGames(rawRec: Rec, note: (m: string) => void): void {
  if (rawRec.games !== undefined && !isRecord(rawRec.games)) {
    note("data.games was not an object; replaced with an empty games library");
    rawRec.games = createGamesData();
    return;
  }
  const games = (rawRec.games ??= createGamesData() as unknown as Rec) as Rec;

  if (!isRecord(games.settings)) games.settings = {};
  const settings = games.settings as Rec;
  fillMissing(settings, createGamesSettings() as unknown as Rec);
  settings.statuses = migrateNamedColors(settings.statuses, DEFAULT_GAME_STATUSES);
  settings.types = migrateNamedColors(settings.types, DEFAULT_GAME_TYPES);
  settings.platforms = migrateNamedColors(settings.platforms, DEFAULT_GAME_PLATFORMS);
  if (!Array.isArray(settings.savedPresets)) settings.savedPresets = [];

  const statusNames = (settings.statuses as NamedColor[]).map((s) => s.name);
  const list = Array.isArray(games.games) ? games.games : [];
  games.games = list.filter(isRecord);
  (games.games as Rec[]).forEach((entry, i) => migrateGame(entry, i, statusNames));
  if (list.length !== (games.games as unknown[]).length) {
    note("dropped a games entry that was not an object");
  }

  const groups = Array.isArray(games.groups) ? games.groups : [];
  games.groups = groups.filter(isRecord).map((group, index) => {
    const raw = group;
    raw.id = str(raw.id) || `game-group-${index + 1}`;
    raw.name = str(raw.name, `Group ${index + 1}`);
    raw.gameIds = strArray(raw.gameIds);
    raw.dateAdded = str(raw.dateAdded) || new Date().toISOString();
    return raw;
  });
}

function migrateDrafts(rawRec: Rec): void {
  if (rawRec.drafts === undefined) return; // absent is fine; the scanner creates it
  if (!isRecord(rawRec.drafts)) {
    rawRec.drafts = createDraftsState();
    return;
  }
  const drafts = rawRec.drafts;
  drafts.dismissed = strArray(drafts.dismissed);
  drafts.added = strArray(drafts.added);
  if (!isRecord(drafts.firstSeen)) drafts.firstSeen = {};
  if (!isRecord(drafts.titleDisplay)) drafts.titleDisplay = {};
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function migrateNamedColors(value: unknown, fallback: NamedColor[]): NamedColor[] {
  if (!Array.isArray(value)) return fallback.map((n) => ({ ...n }));
  const out: NamedColor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name).trim();
    if (!name) continue;
    out.push({ ...(entry as object), name, color: str(entry.color, "#888780") } as NamedColor);
  }
  return out.length > 0 ? out : fallback.map((n) => ({ ...n }));
}

/** v3 sort keys that still mean something in v4. Anything else falls back. */
const V3_SORT_KEY_MAP: Record<string, SortKey> = {
  title: "title",
  dateAdded: "dateAdded",
  dateWatched: "dateModified",
  progress: "progress",
  rating: "rating",
  priority: "priority",
  status: "status",
  timeLeft: "timeLeft",
};

function migrateSortFromListFilters(listFilters: unknown): {
  sort: SortSpec | null;
  filters: Partial<FilterState>;
} {
  if (!isRecord(listFilters)) return { sort: null, filters: {} };

  const key = V3_SORT_KEY_MAP[str(listFilters.sort)];
  const dir = str(listFilters.sortDir) === "asc" ? "asc" : "desc";
  const sort: SortSpec | null = key ? { key, direction: dir } : null;

  const filters: Partial<FilterState> = {};
  const typeExclude = strArray(listFilters.typeExclude);
  const statusExclude = strArray(listFilters.statusExclude);
  const priorityExclude = strArray(listFilters.priorityExclude);
  if (typeExclude.length) filters.excludedTypes = typeExclude;
  if (statusExclude.length) filters.excludedStatuses = statusExclude;
  if (priorityExclude.length) filters.excludedPriorities = priorityExclude;
  if (bool(listFilters.favoritesOnly)) filters.favoritesOnly = true;

  return { sort, filters };
}

/**
 * Fill in v4 settings keys, repair the v3 ones we still use, and leave every
 * other key exactly where it was.
 */
function migrateSettings(raw: Rec, note: (m: string) => void): Settings {
  const defaults = createDefaultSettings();
  // Spread first: unknown v3 keys (omdbApiKey, colorTheme, listFilters, …) ride along.
  const s = raw as Rec & Partial<Settings>;

  s.types = migrateNamedColors(s.types, DEFAULT_TYPES);
  s.statuses = migrateNamedColors(s.statuses, DEFAULT_STATUSES);
  s.priorities = migrateNamedColors(s.priorities, DEFAULT_PRIORITIES);
  s.reviews = migrateNamedColors(s.reviews, DEFAULT_REVIEWS);
  // A file written before venues existed has no key at all and gets the eight
  // defaults; a file that has the key keeps every entry, colour and position.
  s.watchedViaOptions = migrateNamedColors(s.watchedViaOptions, DEFAULT_WATCHED_VIA);

  // v3 load-time repairs worth keeping.
  if (!s.statuses.some((x) => x.name === STATUS_TO_BE_RELEASED)) {
    s.statuses.push({ name: STATUS_TO_BE_RELEASED, color: "#E8873A" });
    note(`re-inserted the "${STATUS_TO_BE_RELEASED}" status`);
  }
  for (const status of s.statuses) {
    if (status.name === STATUS_PLAN_TO_WATCH && status.color.toLowerCase() === "#888780") {
      status.color = "#00A9A5";
      note(`recoloured the legacy grey "${STATUS_PLAN_TO_WATCH}" status`);
    }
  }

  // ratingSystem must be exactly five well-formed tiers, or it is reset wholesale.
  const tiers = Array.isArray(s.ratingSystem) ? s.ratingSystem : [];
  const tiersOk =
    tiers.length === 5 &&
    tiers.every((t) => isRecord(t) && str(t.label).length > 0 && str(t.color).length > 0);
  if (!tiersOk) {
    if (tiers.length > 0) note("rating system was malformed; reset to the five defaults");
    s.ratingSystem = DEFAULT_RATING_SYSTEM.map((t) => ({ ...t }));
  }

  s.rootFolder = str(s.rootFolder, defaults.rootFolder) || defaults.rootFolder;
  s.autoCreateFolders = bool(s.autoCreateFolders, defaults.autoCreateFolders);
  s.dateFormat =
    s.dateFormat === "american" || s.dateFormat === "iso" || s.dateFormat === "european"
      ? s.dateFormat
      : defaults.dateFormat;
  s.halfStarRatings = bool(s.halfStarRatings, defaults.halfStarRatings);
  s.autoCompleteOnLastEpisode = bool(s.autoCompleteOnLastEpisode, defaults.autoCompleteOnLastEpisode);
  s.autoSyncSeasons = bool(s.autoSyncSeasons, defaults.autoSyncSeasons);
  s.setFinishDateAutomatically = bool(s.setFinishDateAutomatically, defaults.setFinishDateAutomatically);
  s.cardSize = Math.max(-3, Math.min(3, Math.round(num(s.cardSize, defaults.cardSize))));
  s.defaultAddType = str(s.defaultAddType, DEFAULT_ADD_TYPE_LAST_USED) || DEFAULT_ADD_TYPE_LAST_USED;
  s.lastAddedType = str(s.lastAddedType, "");

  // v4 integrations — never overwrite a value the user already has.
  s.overseerrUrl = str(s.overseerrUrl, "");
  s.overseerrApiKey = str(s.overseerrApiKey, "");
  s.plexUrl = str(s.plexUrl, "");
  s.plexToken = str(s.plexToken, "");
  s.plexMachineId = str(s.plexMachineId, "");
  // v3 stored a v3-style 32-char TMDB key under `tmdbApiKey`; v4 wants a v4 read
  // token (a JWT starting `eyJ`). Only carry it over when it looks like one.
  if (typeof s.tmdbToken !== "string") {
    const legacy = str(raw.tmdbApiKey);
    s.tmdbToken = legacy.startsWith("eyJ") ? legacy : "";
    if (legacy && !legacy.startsWith("eyJ")) {
      note("legacy tmdbApiKey is a v3 key, not a v4 read token; left it unset");
    }
  }

  s.requestPollMinutes = num(s.requestPollMinutes, defaults.requestPollMinutes);
  s.airingTtlHours = num(s.airingTtlHours, defaults.airingTtlHours);
  s.plexTtlHours = num(s.plexTtlHours, defaults.plexTtlHours);
  // A file written before the sweep existed has no key at all, so it defaults to
  // weekly — the documented cadence, not "off". An explicit `0` the user typed
  // is a real value and survives, because `num` only falls back on non-numbers.
  s.metadataSweepTtlHours = Math.max(
    0,
    num(s.metadataSweepTtlHours, defaults.metadataSweepTtlHours),
  );

  s.generateNotes = bool(s.generateNotes, defaults.generateNotes);
  s.trailerMode =
    s.trailerMode === "link-only" || s.trailerMode === "off" || s.trailerMode === "embed"
      ? s.trailerMode
      : defaults.trailerMode;
  s.showUpcomingStatusBar = bool(s.showUpcomingStatusBar, defaults.showUpcomingStatusBar);
  s.openLibraryAfterAdd = bool(
    s.openLibraryAfterAdd,
    bool(raw.openWatchlistAfterAdd, defaults.openLibraryAfterAdd),
  );
  s.dashboardTopCredits = num(s.dashboardTopCredits, defaults.dashboardTopCredits);
  s.openTitlesInFullView = bool(s.openTitlesInFullView, defaults.openTitlesInFullView);

  // --- the full-view default, moved across exactly once --------------------
  //
  // 1.25.0 shipped `openTitlesInFullView: false` and wrote it into every
  // `data.json` that loaded it, so raising the default alone would be invisible
  // to everybody who already has the plugin: the line above would keep reading
  // their stored `false` forever. This flips that stored `false` to the new
  // default **once** and leaves `FULL_VIEW_DEFAULT_MARKER` behind.
  //
  // The marker, not the version number, is the guard — `migrate()` runs on
  // every load, not only on a version bump (`data/store.ts`), so "already at
  // v4" proves nothing about whether this has run. Once the marker is on disk,
  // `openTitlesInFullView` is the user's own answer and this block never
  // touches it again, including when that answer is `false`.
  if (readExtra<unknown>(s, FULL_VIEW_DEFAULT_MARKER) !== true) {
    if (!s.openTitlesInFullView) {
      s.openTitlesInFullView = true;
      note("titles now open in a full tab by default; the modal is one toggle away in settings");
    }
    writeExtra(s, FULL_VIEW_DEFAULT_MARKER, true);
  }

  // Artwork cache. Both keys default to "off, in the default folder" for a file
  // that predates them, which is exactly the behaviour that file already had.
  s.cacheImagesLocally = bool(s.cacheImagesLocally, defaults.cacheImagesLocally);
  // Derived from THIS file's root folder (settled at line ~489 above), not from
  // the stock one: a vault whose material lives in `Media/Watching` should get
  // `Media/Watching/images`, and taking the shipped default here is what put a
  // `WRL/` at somebody's vault root while their library sat elsewhere.
  const derivedCacheFolder = defaultImageCacheFolder(s);
  s.imageCacheFolder = str(s.imageCacheFolder, derivedCacheFolder) || derivedCacheFolder;
  // The cache's first default shipped as `WatchLog/images` — the old brand,
  // gone from everything else since the rename. A stored value that IS that
  // default (and only that: a folder the user chose is theirs, even one they
  // named WatchLog) follows the default to `WRL/images`. The plugin moves the
  // folder's contents on load when the old path exists — see
  // `relocateImageCache` in `main.ts` — so the setting and the files change
  // together rather than the cache silently going cold.
  // Every folder this plugin ever shipped as the stock default: `WatchLog/`
  // from before the rename, then `WRL/` — which sat at the VAULT root while a
  // reader's material lived under their own root folder, so artwork landed
  // nowhere near the notes it belongs to. A stored value that IS one of those
  // follows the default to `<rootFolder>/images`; a folder the reader chose,
  // even one spelled the same as a default they never had, is theirs and stays.
  // `relocateImageCache` moves the files, so the setting and the folder change
  // together rather than the cache silently going cold.
  if (LEGACY_IMAGE_CACHE_FOLDERS.includes(s.imageCacheFolder)) {
    s.imageCacheFolder = derivedCacheFolder;
  }

  s.libraryViewMode = s.libraryViewMode === "table" ? "table" : defaults.libraryViewMode;

  const carried = migrateSortFromListFilters(raw.listFilters);
  if (!isRecord(s.filterState)) {
    s.filterState = { ...createFilterState(), ...carried.filters };
  } else {
    s.filterState = { ...createFilterState(), ...(s.filterState as object) } as FilterState;
  }
  if (!isRecord(s.sort)) {
    s.sort = carried.sort ?? { ...defaults.sort };
  }
  if (s.secondarySort === undefined) s.secondarySort = null;
  if (!Array.isArray(s.savedPresets)) s.savedPresets = [];

  // --- parity settings (SPEC2-PARITY.md) ----------------------------------
  //
  // v3 wrote most of these already, so they are *carried*, not defaulted: a
  // user who set a Google Books key or a drafts tag in v3 keeps it.
  if (!isRecord(s.typeApiMapping)) s.typeApiMapping = {};
  s.animeApiSource = s.animeApiSource === "jikan" ? "jikan" : defaults.animeApiSource;
  s.googleBooksApiKey = str(s.googleBooksApiKey, defaults.googleBooksApiKey);
  s.openLibraryUserAgent = str(s.openLibraryUserAgent, defaults.openLibraryUserAgent);
  s.igdbClientId = str(s.igdbClientId, defaults.igdbClientId);
  s.igdbClientSecret = str(s.igdbClientSecret, defaults.igdbClientSecret);
  s.steamApiKey = str(s.steamApiKey, defaults.steamApiKey);
  s.steamId = str(s.steamId, defaults.steamId);
  s.customListsFolder = str(s.customListsFolder, defaults.customListsFolder);
  s.customListTabOrder = strArray(s.customListTabOrder);
  s.defaultCustomColumns = migrateCustomColumns(s.defaultCustomColumns);
  s.draftsVaultTag = str(s.draftsVaultTag, defaults.draftsVaultTag);
  s.draftsAfterAdding = s.draftsAfterAdding === "dismiss" ? "dismiss" : "keep";
  s.generateReadingNotes = bool(s.generateReadingNotes, defaults.generateReadingNotes);
  s.generateGameNotes = bool(s.generateGameNotes, defaults.generateGameNotes);

  // v3's `gamesApiSource` is deliberately NOT read: RAWG is out of scope (it
  // has been down for the duration of the research), so IGDB is the only games
  // provider and there is nothing to choose between. The key round-trips.

  return s as Settings;
}

// ---------------------------------------------------------------------------
// The Completed → Watched rename
// ---------------------------------------------------------------------------

/** What the stock "you have finished this" status was called before v1.22. */
const LEGACY_COMPLETED_STATUS = "Completed";

/**
 * Rename `"Completed"` to `"Watched"` in a status list — and everywhere the old
 * name is *stored* — exactly once per install.
 *
 * The problem this solves is the one `FULL_VIEW_DEFAULT_MARKER` solves, with a
 * sharper edge: `settings.statuses` is the user's own list, saved into their
 * `data.json`, so changing a default changes nothing for anyone who already has
 * the plugin. Their vault would keep saying "Completed" for ever while every
 * semantic check in the codebase compares against `STATUS_COMPLETED`, which now
 * reads "Watched" — auto-status would stop recognising the status it just set,
 * the Watched shelf would empty, the sweep would stop skipping finished films.
 * So the list has to be moved across, and with it every title standing on it.
 *
 * Three rules, and all three are about not taking something that is the user's:
 *
 *   - **Only the stock entry moves.** The entry has to still be *named*
 *     `Completed`. Someone who renamed it to "Seen" years ago has already
 *     answered this question; nothing here has an opinion about their answer.
 *     The colour is not part of the test — a recoloured Completed is still the
 *     stock status, it is just not blue any more.
 *   - **A vault holding both names is left entirely alone.** If `Watched`
 *     already exists beside `Completed` they are two statuses the user
 *     distinguishes, and merging them under one name is a data-loss edit
 *     dressed as a rename.
 *   - **The marker is stamped whatever happens**, including on the no-op
 *     paths. `migrate()` runs on every load, not only on a version bump, so a
 *     user who creates a status called "Completed" next month must not find it
 *     silently renamed on the load after that.
 *
 * Titles then follow the list rather than the rename: they move whenever the
 * finished list has a `Watched` and no `Completed` for them to stand on. That
 * covers the rename itself and the one case it does not reach — a
 * `settings.statuses` too broken to read, which `migrateSettings` replaces with
 * the defaults, leaving titles pointing at a name no list ever had. The state
 * that must never exist is a title standing on a name the list dropped, and
 * this is the only pass that can still see both halves at once.
 */
function renameCompletedStatus(
  settings: Settings,
  titles: readonly TitleV4[],
  note: (message: string) => void,
): void {
  if (readExtra<unknown>(settings, WATCHED_STATUS_RENAME_MARKER) === true) return;
  // Before the early returns, not after: "we looked and there was nothing to do"
  // is an answer, and it is the answer that must survive to the next load.
  writeExtra(settings, WATCHED_STATUS_RENAME_MARKER, true);

  const statuses = Array.isArray(settings.statuses) ? settings.statuses : [];
  const named = (name: string): NamedColor | undefined =>
    statuses.find((entry): entry is NamedColor => isRecord(entry) && entry.name === name);

  const stock = named(LEGACY_COMPLETED_STATUS);
  const already = named(STATUS_COMPLETED);
  if (stock !== undefined && already !== undefined) {
    note(
      `"${LEGACY_COMPLETED_STATUS}" is now called "${STATUS_COMPLETED}", but this vault already has both — left the status list alone`,
    );
    return;
  }

  let renamed = false;
  if (stock !== undefined) {
    // In place. `stock` is the live object inside `settings.statuses`; replacing
    // the array (or the entry) would drop any key a future version added to it.
    stock.name = STATUS_COMPLETED;
    renamed = true;
  } else if (already === undefined) {
    // Neither name is in the list, so there is no watched status here to move
    // anything onto. A vault that renamed the stock entry to something of its
    // own keeps every title exactly where the user put it.
    return;
  }

  let moved = 0;
  for (const title of titles) {
    if (title.status === LEGACY_COMPLETED_STATUS) {
      title.status = STATUS_COMPLETED;
      moved += 1;
    }
  }

  if (renamed) renameStoredStatusReferences(settings);
  else if (moved === 0) return;

  const what = renamed
    ? `renamed the "${LEGACY_COMPLETED_STATUS}" status to "${STATUS_COMPLETED}"`
    : `moved ${moved} title(s) off "${LEGACY_COMPLETED_STATUS}", which this vault's status list does not have, onto "${STATUS_COMPLETED}"`;
  note(renamed && moved > 0 ? `${what} (${moved} title(s) moved with it)` : what);
}

/** Swap the old status name for the new one in a filter's exclusion list. */
function renameExcludedStatus(filters: unknown): void {
  if (!isRecord(filters)) return;
  const excluded = (filters as unknown as FilterState).excludedStatuses;
  if (!Array.isArray(excluded)) return;
  // In place, and only the one entry: an exclusion list is an answer per status
  // name, so the answer has to follow its name rather than be rebuilt around it.
  const at = excluded.indexOf(LEGACY_COMPLETED_STATUS);
  if (at < 0) return;
  if (excluded.includes(STATUS_COMPLETED)) excluded.splice(at, 1);
  else excluded[at] = STATUS_COMPLETED;
}

/**
 * Everywhere else the old name is *written down* rather than derived.
 *
 * Three places, and each one is a question the user already answered:
 *
 *   - the live filter and every saved preset's copy of it, where the name is an
 *     entry in `excludedStatuses` ("do not show me these");
 *   - the shelf visibility map, keyed `status:<name>` ("show me this shelf").
 *
 * A key left behind is not inert — it is a stored answer pointing at a status
 * that no longer exists, so the shelf the user switched on comes back off, and
 * the status they hid comes back into view.
 *
 * What is deliberately **not** rewritten is `preset.query`: free text the user
 * typed, where `Completed` may be a facet, a phrase, or part of a title, and
 * where editing it means a lossy parse-and-reserialise of someone's own words.
 */
function renameStoredStatusReferences(settings: Settings): void {
  renameExcludedStatus(settings.filterState);
  if (Array.isArray(settings.savedPresets)) {
    for (const preset of settings.savedPresets as unknown[]) {
      if (isRecord(preset)) renameExcludedStatus((preset as unknown as Preset).filters);
    }
  }

  const shelves = readExtra<unknown>(settings, VISIBLE_SHELVES_KEY);
  if (!isRecord(shelves)) return;
  const from = statusShelfId(LEGACY_COMPLETED_STATUS);
  const to = statusShelfId(STATUS_COMPLETED);
  if (!(from in shelves)) return;
  // The new key wins if it somehow already exists: it is the more recent answer.
  if (!(to in shelves)) shelves[to] = shelves[from];
  delete shelves[from];
  writeExtra(settings, VISIBLE_SHELVES_KEY, shelves);
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

function migrateSeasons(raw: unknown, type: string, totalEpisodes: number): Season[] {
  const seasons: Season[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const episodes = Math.max(0, Math.round(num(entry.episodes, 0)));
      seasons.push({
        // Spread keeps unknown per-season keys (v3 wrote none, but be safe).
        ...(entry as object),
        name: str(entry.name, `Season ${seasons.length + 1}`),
        episodes,
        offset: Math.max(0, Math.round(num(entry.offset, 0))),
        skippedEpisodes: Array.isArray(entry.skippedEpisodes)
          ? (entry.skippedEpisodes as unknown[])
              .map((v) => Math.trunc(num(v, 0)))
              .filter((v) => v >= 1 && v <= episodes)
          : [],
      } as Season);
    }
  }

  if (seasons.length === 0 && totalEpisodes > 0) {
    seasons.push({
      name: type === TYPE_MOVIE ? "Movie" : "Season 1",
      episodes: totalEpisodes,
      offset: 0,
      skippedEpisodes: [],
    });
  }

  // v3 wrote correct offsets, so only rebuild them when they are plainly wrong —
  // recomputing good offsets would silently reassign stored absolute episodes.
  const offsetsBroken = seasons.some((s, i) => {
    if (i === 0) return s.offset !== 0;
    const prev = seasons[i - 1];
    return !prev || s.offset < prev.offset;
  });
  if (offsetsBroken) recomputeOffsets(seasons);

  return seasons;
}

/** `["none"]` → `[]`; a stray `"none"` inside a real list is dropped too. */
function cleanCreditList(value: unknown): { list: string[]; failed: boolean } {
  const raw = strArray(value);
  const list = raw.filter((v) => v.trim().length > 0 && !isNoneSentinel(v));
  const failed = raw.length > 0 && list.length === 0;
  return { list, failed };
}

function migrateTitle(raw: Rec, seenIds: Set<string>, note: (m: string) => void): TitleV4 {
  const name = str(raw.title, "Untitled");
  const type = str(raw.type, TYPE_MOVIE);

  // Spread-based construction: unknown v3 title keys (malId, collectionId,
  // lastInteracted, …) ride along into the v4 object untouched.
  const t = createTitle({
    ...(raw as object),
    id: str(raw.id) || slugify(name) || "title",
    title: name,
    type,
  } as Parameters<typeof createTitle>[0]);

  // Ids must be unique; v3 could produce duplicates through renames.
  if (seenIds.has(t.id)) {
    let n = 2;
    while (seenIds.has(`${t.id}-${n}`)) n += 1;
    note(`duplicate id "${t.id}" renamed to "${t.id}-${n}"`);
    t.id = `${t.id}-${n}`;
  }
  seenIds.add(t.id);

  t.status = str(raw.status, "Plan to watch") || "Plan to watch";
  t.priority = str(raw.priority, "");
  t.review = str(raw.review, "");
  // Every existing title arrives with `""`. Migration never guesses a venue —
  // not from Plex, not from anything — because only the user was there.
  t.watchedVia = str(raw.watchedVia, "");
  t.rating = Math.max(0, Math.min(5, num(raw.rating, 0)));
  t.notes = str(raw.notes, "");
  t.favorite = bool(raw.favorite, false);
  if (!t.favorite) delete t.dateFavorited;

  t.tags = strArray(raw.tags);

  t.dateStarted = dateOrNull(raw.dateStarted);
  t.dateFinished = dateOrNull(raw.dateFinished);
  t.releaseDate = dateOrNull(raw.releaseDate);
  t.dateAdded = str(raw.dateAdded) || new Date().toISOString();
  // v3 migrated `lastInteracted` into `dateModified`; do it again for old files.
  t.dateModified = str(raw.dateModified) || str(raw.lastInteracted) || t.dateAdded;

  t.totalEpisodes = Math.max(0, Math.round(num(raw.totalEpisodes, 1)));
  t.episodeDuration = Math.max(0, num(raw.episodeDuration, 0));
  t.seasons = migrateSeasons(raw.seasons, t.type, t.totalEpisodes);
  // The file's absolute episode numbers were written against the seasons the
  // file itself holds, so those normalised seasons — not whatever `createTitle`
  // was seeded with — are the basis. Anchoring here keeps migration from
  // "rebasing" numbers that were never out of date.
  rememberSeasonGeometry(t);

  t.externalLink = str(raw.externalLink, "");

  // --- sentinel cleanup (SPEC §3.1) ----------------------------------------
  // Seeded from any existing flags: once the sentinel has been cleared, a second
  // migration pass can no longer detect it, so the record has to be sticky.
  const previous = isRecord(raw.fetchFailed) ? raw.fetchFailed : {};
  const failed: { poster?: boolean; trailer?: boolean; credits?: boolean } = {};
  if (bool(previous.poster)) failed.poster = true;
  if (bool(previous.trailer)) failed.trailer = true;
  if (bool(previous.credits)) failed.credits = true;

  const poster = str(raw.posterUrl, "");
  if (isNoneSentinel(poster)) {
    t.posterUrl = "";
    failed.poster = true;
    note(`${t.title}: cleared the "none" posterUrl sentinel`);
  } else {
    t.posterUrl = poster;
  }
  t.manualPosterUrl = str(raw.manualPosterUrl, "");

  const trailer = str(raw.trailerUrl, "");
  if (isNoneSentinel(trailer)) {
    t.trailerUrl = "";
    failed.trailer = true;
    note(`${t.title}: cleared the "none" trailerUrl sentinel`);
  } else {
    t.trailerUrl = trailer;
  }
  t.manualTrailerUrl = str(raw.manualTrailerUrl, "");

  const director = cleanCreditList(raw.director);
  const cast = cleanCreditList(raw.cast);
  const studio = cleanCreditList(raw.studio);
  t.director = director.list;
  t.cast = cast.list;
  t.studio = studio.list;
  if (director.failed || cast.failed || studio.failed) {
    failed.credits = true;
    note(`${t.title}: cleared ["none"] credit sentinels`);
  }
  t.manualDirector = cleanCreditList(raw.manualDirector).list;
  t.manualCast = cleanCreditList(raw.manualCast).list;
  t.manualStudio = cleanCreditList(raw.manualStudio).list;

  if (Object.keys(failed).length > 0) t.fetchFailed = failed;
  else delete t.fetchFailed;

  t.communityRating = num(raw.communityRating, 0);
  t.communityVotes = num(raw.communityVotes, 0);
  const source = str(raw.communitySource, "");
  t.communitySource = (["imdb", "tmdb", "jikan", "anilist"].includes(source)
    ? source
    : "") as TitleV4["communitySource"];
  t.communityRatingLastFetched = str(raw.communityRatingLastFetched, "");

  // v3 back-filled a missing media type to "movie" unconditionally, which is
  // wrong for every show. Infer from the title's own type instead.
  if (typeof raw.tmdbId === "number" && raw.tmdbId > 0) {
    t.tmdbId = raw.tmdbId;
    const mediaType = str(raw.tmdbMediaType);
    if (mediaType === "tv" || mediaType === "movie") t.tmdbMediaType = mediaType;
    else t.tmdbMediaType = t.type === TYPE_MOVIE ? "movie" : "tv";
  }

  if (t.year === undefined && t.releaseDate) {
    const year = Number.parseInt(t.releaseDate.slice(0, 4), 10);
    if (Number.isFinite(year)) t.year = year;
  }

  // --- bug fix 2: skipped episodes can never be "watched" -------------------
  const before = Array.isArray(raw.watchedEpisodes) ? raw.watchedEpisodes.length : 0;
  t.watchedEpisodes = sanitizeWatchedEpisodes(t);
  if (t.watchedEpisodes.length !== before) {
    const skipped = skippedAbsolute(t);
    note(
      skipped.size > 0
        ? `${t.title}: normalised watchedEpisodes (dropped skipped/out-of-range entries)`
        : `${t.title}: normalised watchedEpisodes (deduped/sorted)`,
    );
  }

  return t;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function migrateGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return [];
  const out: Group[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name).trim();
    if (!name) continue;
    out.push({
      ...(entry as object),
      id: str(entry.id) || `group-${slugify(name)}`,
      name,
      titleIds: strArray(entry.titleIds),
      dateAdded: str(entry.dateAdded) || new Date().toISOString(),
    } as Group);
  }
  return out;
}
