/**
 * Default shapes for a fresh install, and the factories migration uses to fill
 * gaps. Pure — no obsidian imports, so tests can use it directly.
 *
 * The colour values are v3's shipped defaults, kept so an existing user's
 * `data.json` migrates without their badges changing colour.
 */
import {
  SCHEMA_VERSION,
  writeExtra,
  type Book,
  type DraftsState,
  type FilterState,
  type Game,
  type GamesData,
  type GamesSettings,
  type Manga,
  type NamedColor,
  type Preset,
  type RatingTier,
  type ReadingData,
  type ReadingSettings,
  type ReadingStatus,
  type Settings,
  type SortSpec,
  type TitleV4,
  type WatchLogData,
} from "../types";
import { DEFAULT_ADD_TYPE_LAST_USED } from "../constants";
import { rememberSeasonGeometry } from "./episodes";

export const DEFAULT_TYPES: NamedColor[] = [
  { name: "Anime", color: "#1D9E75" },
  { name: "Movie", color: "#378ADD" },
  { name: "TV Show", color: "#BA7517" },
  { name: "Korean TV Show", color: "#7F77DD" },
  { name: "Animation", color: "#D85A30" },
];

export const DEFAULT_STATUSES: NamedColor[] = [
  { name: "Watching", color: "#1D9E75" },
  { name: "Plan to watch", color: "#00A9A5" },
  { name: "Completed", color: "#378ADD" },
  { name: "To be released", color: "#E8873A" },
  { name: "Dropped", color: "#E24B4A" },
];

export const DEFAULT_PRIORITIES: NamedColor[] = [
  { name: "Low", color: "#888780" },
  { name: "Medium", color: "#3b82f6" },
  { name: "High", color: "#E24B4A" },
];

/**
 * Five, to line up one-for-one with the five rating tiers below — same order,
 * same colours, so "4 stars" and "Awesome" are visibly the same statement.
 * v3 shipped three, which made the mapping lossy in both directions: two star
 * ratings shared a label and a label could not name a star.
 */
export const DEFAULT_REVIEWS: NamedColor[] = [
  { name: "Nah", color: "#E24B4A" },
  { name: "Meh", color: "#E28C3C" },
  { name: "Good", color: "#378ADD" },
  { name: "Awesome", color: "#1D9E75" },
  { name: "Marvelous", color: "#7F77DD" },
];

/** Must be exactly five entries; anything else is reset wholesale on load. */
export const DEFAULT_RATING_SYSTEM: RatingTier[] = [
  { label: "Poor", color: "#E24B4A" },
  { label: "Fair", color: "#E28C3C" },
  { label: "Good", color: "#378ADD" },
  { label: "Great", color: "#1D9E75" },
  { label: "Masterpiece", color: "#7F77DD" },
];

export const DEFAULT_SORT: SortSpec = { key: "dateAdded", direction: "desc" };

/** A fresh "nothing hidden" filter state. Always call it — never share one instance. */
export function createFilterState(): FilterState {
  return {
    excludedTypes: [],
    excludedStatuses: [],
    excludedPriorities: [],
    excludedGenres: [],
    excludedTags: [],
    excludedDecades: [],
    excludedPlexStates: [],
    excludedRequestStates: [],
    excludedAiringStates: [],
    minRating: 0,
    favoritesOnly: false,
  };
}

/**
 * Marker for the one-shot full-view default flip (`data/migrate.ts`).
 *
 * Undeclared on `Settings` because `types.ts` is a frozen contract, so it is
 * read and written through `readExtra`/`writeExtra` — the same escape hatch
 * `activeTab` and the dashboard layout use. `true` means "this install has
 * already been given the new default"; from then on `openTitlesInFullView` is
 * whatever the user last said and is never second-guessed again.
 */
export const FULL_VIEW_DEFAULT_MARKER = "fullViewDefaultApplied";

export function createDefaultSettings(): Settings {
  const settings: Settings = {
    types: DEFAULT_TYPES.map((t) => ({ ...t })),
    statuses: DEFAULT_STATUSES.map((t) => ({ ...t })),
    priorities: DEFAULT_PRIORITIES.map((t) => ({ ...t })),
    reviews: DEFAULT_REVIEWS.map((t) => ({ ...t })),
    ratingSystem: DEFAULT_RATING_SYSTEM.map((t) => ({ ...t })),
    rootFolder: "Watch Read Learn",
    autoCreateFolders: true,
    dateFormat: "european",
    halfStarRatings: false,
    autoCompleteOnLastEpisode: true,
    autoSyncSeasons: true,
    setFinishDateAutomatically: false,
    cardSize: 0,
    defaultAddType: DEFAULT_ADD_TYPE_LAST_USED,
    lastAddedType: "",

    overseerrUrl: "",
    overseerrApiKey: "",
    plexUrl: "",
    plexToken: "",
    plexMachineId: "",
    tmdbToken: "",

    requestPollMinutes: 5,
    airingTtlHours: 12,
    plexTtlHours: 6,
    // Weekly, from `SWEEP_TTL_HOURS_DEFAULT`. Spelled out rather than imported:
    // this module is the defaults table and importing a service into it would
    // point the dependency the wrong way. `0` here would mean "off".
    metadataSweepTtlHours: 24 * 7,

    generateNotes: true,
    trailerMode: "embed",
    showUpcomingStatusBar: true,
    openLibraryAfterAdd: true,
    dashboardTopCredits: 5,
    // The full tab is the default surface. It is the one that fits a show with
    // a full cast and a season grid, and it is where a cast name is a link to
    // the person rather than a chip that can only filter. The modal stays one
    // toggle away; `FULL_VIEW_DEFAULT_MARKER` is how an existing install gets
    // moved across exactly once without ever overruling a later choice.
    openTitlesInFullView: true,

    // Off, because turning it on writes binary files into the user's vault.
    cacheImagesLocally: false,
    // Mirrors `DEFAULT_IMAGE_CACHE_FOLDER`; normalised again before any write.
    imageCacheFolder: "WatchLog/images",

    libraryViewMode: "grid",
    filterState: createFilterState(),
    sort: { ...DEFAULT_SORT },
    secondarySort: null,
    savedPresets: [] as Preset[],

    // --- parity (SPEC2-PARITY.md) -----------------------------------------
    typeApiMapping: {},
    // AniList leads: one query returns a whole week of exact per-episode
    // timestamps, and Jikan scrapes MAL so it inherits MAL's outages.
    animeApiSource: "anilist",

    googleBooksApiKey: "",
    // Open Library asks for app name + contact, and gives 3 req/s instead of 1
    // to anyone who sends it.
    openLibraryUserAgent: "WatchReadLearn/1.0 (+https://github.com/iwanhoogendoorn/watch-read-learn)",

    igdbClientId: "",
    igdbClientSecret: "",
    steamApiKey: "",
    steamId: "",

    customListsFolder: "Watch Read Learn/CustomLists",
    customListTabOrder: [],
    defaultCustomColumns: [],
    draftsVaultTag: "#watch-read-learn",
    draftsAfterAdding: "keep",

    generateReadingNotes: true,
    generateGameNotes: true,
  };

  // A fresh install already ships the full view on, so the one-shot flip has
  // nothing to do here — stamp its marker anyway. Without it, a user who turns
  // the full view *off* on their first day would be overruled by the flip on
  // the next load, which is the one thing the marker exists to prevent.
  writeExtra(settings, FULL_VIEW_DEFAULT_MARKER, true);
  return settings;
}

// ---------------------------------------------------------------------------
// Parity domains (SPEC2-PARITY.md)
//
// These defaults are transcribed from a real v3 vault, not invented: the colours
// and the exact status/genre/platform lists below are what `data.games.settings`
// and `data.reading.settings` already contain in the test vault. That matters —
// normalising a real file has to be a no-op, not a re-theming.
// ---------------------------------------------------------------------------

export const DEFAULT_READING_STATUS_COLORS: Record<ReadingStatus, string> = {
  Reading: "#1D9E75",
  Completed: "#7F77DD",
  "Plan to Read": "#E8873A",
  "To be released": "#3A86C8",
  Dropped: "#E24B4A",
};

export function createReadingSettings(): ReadingSettings {
  return {
    defaultFolder: "Watch Read Learn/Reading",
    defaultStatus: "Plan to Read",
    bookCustomFieldStyle: "fill",
    mangaCustomFieldStyle: "fill",
    statusColors: { ...DEFAULT_READING_STATUS_COLORS },
    // The named list the Library uses. v3's single unnamed `savedFilterPreset`
    // is left alone beside it and round-trips.
    savedPresets: [],
  };
}

export function createReadingData(): ReadingData {
  return {
    books: [],
    manga: [],
    bookColumns: [],
    mangaColumns: [],
    settings: createReadingSettings(),
  };
}

export const DEFAULT_GAME_STATUSES: NamedColor[] = [
  { name: "Playing", color: "#3B82F6" },
  { name: "Not started", color: "#6B7280" },
  { name: "Finished", color: "#22C55E" },
  { name: "Dropped", color: "#EF4444" },
  { name: "To be released", color: "#F59E0B" },
  { name: "TBA", color: "#EAB308" },
];

export const DEFAULT_GAME_TYPES: NamedColor[] = [
  { name: "Adventure", color: "#8B5CF6" },
  { name: "RPG", color: "#3B82F6" },
  { name: "Shooter", color: "#EF4444" },
  { name: "Strategy", color: "#F59E0B" },
  { name: "Platformer", color: "#22C55E" },
  { name: "Racing", color: "#D85A30" },
  { name: "Simulation", color: "#1D9E75" },
  { name: "Sports", color: "#639922" },
  { name: "Puzzle", color: "#378ADD" },
  { name: "Fighting", color: "#993556" },
  { name: "Horror", color: "#5F5E5A" },
  { name: "Indie", color: "#D4537E" },
];

export const DEFAULT_GAME_PLATFORMS: NamedColor[] = [
  { name: "Windows PC", color: "#378ADD" },
  { name: "PlayStation 5", color: "#1D4ED8" },
  { name: "Xbox Series X|S", color: "#22C55E" },
  { name: "Nintendo Switch 2", color: "#E24B4A" },
];

export function createGamesSettings(): GamesSettings {
  return {
    defaultFolder: "Watch Read Learn/Games",
    defaultStatus: "Not started",
    statuses: DEFAULT_GAME_STATUSES.map((s) => ({ ...s })),
    types: DEFAULT_GAME_TYPES.map((t) => ({ ...t })),
    platforms: DEFAULT_GAME_PLATFORMS.map((p) => ({ ...p })),
    savedPresets: [],
  };
}

export function createGamesData(): GamesData {
  return { games: [], groups: [], settings: createGamesSettings() };
}

export function createDraftsState(): DraftsState {
  return { dismissed: [], added: [], firstSeen: {}, titleDisplay: {} };
}

/** A complete book with every required field present, for the add flow. */
export function createBook(seed: Partial<Book> & Pick<Book, "id" | "title">): Book {
  const now = new Date().toISOString();
  return {
    author: "",
    status: "Plan to Read",
    favorite: false,
    rating: 0,
    pagesRead: 0,
    totalPages: 0,
    progressUnit: "pages",
    wordsRead: 0,
    totalWords: 0,
    chaptersRead: 0,
    totalChapters: 0,
    coverUrl: "",
    googleBooksId: "",
    vaultPage: "",
    externalLink: "",
    dateStarted: null,
    dateFinished: null,
    releaseDate: null,
    dateAdded: now,
    dateModified: now,
    customFields: {},
    ...seed,
  };
}

export function createManga(seed: Partial<Manga> & Pick<Manga, "id" | "title">): Manga {
  const now = new Date().toISOString();
  return {
    author: "",
    status: "Plan to Read",
    favorite: false,
    rating: 0,
    chaptersRead: 0,
    totalChapters: 0,
    volumesRead: 0,
    totalVolumes: 0,
    malId: "",
    coverUrl: "",
    vaultPage: "",
    externalLink: "",
    dateStarted: null,
    dateFinished: null,
    releaseDate: null,
    dateAdded: now,
    dateModified: now,
    customFields: {},
    ...seed,
  };
}

export function createGame(seed: Partial<Game> & Pick<Game, "id" | "title">): Game {
  const now = new Date().toISOString();
  return {
    developer: "",
    publisher: "",
    type: "",
    status: "Not started",
    priority: "",
    favorite: false,
    wishlist: false,
    rating: 0,
    progress: 0,
    playtimeMinutes: 0,
    achievementsEarned: 0,
    achievementsTotal: 0,
    platforms: [],
    singleplayer: false,
    coop: false,
    multiplayer: false,
    storeUrl: "",
    coverUrl: "",
    apiSource: "",
    apiId: "",
    steamAppId: "",
    lastPlayed: null,
    externalLink: "",
    vaultPage: "",
    releaseDate: null,
    dateStarted: null,
    dateFinished: null,
    dateAdded: now,
    dateModified: now,
    ...seed,
  };
}

export function createDefaultData(): WatchLogData {
  return {
    schemaVersion: SCHEMA_VERSION,
    titles: [],
    groups: [],
    settings: createDefaultSettings(),
    history: [],
  };
}

/**
 * A complete, valid title with every required field present. Used by the Add
 * modal and by migration to backfill missing v3 keys.
 */
export function createTitle(seed: Partial<TitleV4> & Pick<TitleV4, "id" | "title" | "type">): TitleV4 {
  const now = new Date().toISOString();
  const title: TitleV4 = {
    status: "Plan to watch",
    priority: "",
    review: "",
    rating: 0,
    notes: "",
    favorite: false,
    tags: [],
    dateStarted: null,
    dateFinished: null,
    dateAdded: now,
    dateModified: now,
    releaseDate: null,
    totalEpisodes: 1,
    episodeDuration: 0,
    seasons: [],
    watchedEpisodes: [],
    externalLink: "",
    posterUrl: "",
    manualPosterUrl: "",
    trailerUrl: "",
    manualTrailerUrl: "",
    director: [],
    cast: [],
    studio: [],
    manualDirector: [],
    manualCast: [],
    manualStudio: [],
    communityRating: 0,
    communityVotes: 0,
    communitySource: "",
    communityRatingLastFetched: "",
    ...seed,
  };
  // The seasons this title was built with are the basis its `watchedEpisodes`
  // absolute numbers mean something against; a later season edit rebases from it.
  rememberSeasonGeometry(title);
  return title;
}

/** Slugify a display name into an id, v3-compatible. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug with a `-2`, `-3`… suffix when it collides with an existing id. */
export function uniqueId(name: string, taken: Iterable<string>): string {
  const base = slugify(name) || "title";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
