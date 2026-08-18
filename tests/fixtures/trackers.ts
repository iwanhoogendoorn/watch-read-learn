/**
 * Synthetic tracker exports.
 *
 * Every byte below is invented. Nothing here came out of a real account, and
 * nothing here may: an export file is a complete record of what someone has
 * watched and when, which is not the sort of thing that belongs in a repository.
 *
 * They are small on purpose but not *simple* on purpose — each one carries the
 * awkward case its source is known for, because a fixture that only contains the
 * happy path tests the happy path:
 *
 *   - Letterboxd: a film with no `Year`, and a half-star rating.
 *   - Trakt: an entry with an IMDb id and no TMDB one; a partly-watched show
 *     with `aired_episodes` bigger than the history; a rewatch logged twice.
 *   - Simkl: a show whose progress is a `LastEpWatched` mark mid-season.
 *   - IMDb: a `tvEpisode` row that must not become a title, and 1–10 ratings.
 *   - Ryot: no titles at all, an out-of-100 rating, and a non-TMDB entry.
 */

// ---------------------------------------------------------------------------
// Letterboxd
// ---------------------------------------------------------------------------

/** `watched.csv` — the plain "films I have seen" list. */
export const LETTERBOXD_WATCHED = `Date,Name,Year,Letterboxd URI
2024-01-04,Fixture Rain,2019,https://boxd.it/aaaa
2024-02-11,Nameless Year Film,,https://boxd.it/bbbb
`;

/** `ratings.csv` — half stars, which is the scale this plugin already uses. */
export const LETTERBOXD_RATINGS = `Date,Name,Year,Letterboxd URI,Rating
2024-01-04,Fixture Rain,2019,https://boxd.it/aaaa,3.5
2024-02-11,Nameless Year Film,,https://boxd.it/bbbb,5
`;

/** `watchlist.csv` — the only file that means "not seen yet". */
export const LETTERBOXD_WATCHLIST = `Date,Name,Year,Letterboxd URI
2024-03-01,Unseen Fixture,2023,https://boxd.it/cccc
`;

export function letterboxdFiles(): Map<string, string> {
  return new Map([
    ["watched.csv", LETTERBOXD_WATCHED],
    ["ratings.csv", LETTERBOXD_RATINGS],
    ["watchlist.csv", LETTERBOXD_WATCHLIST],
  ]);
}

// ---------------------------------------------------------------------------
// IMDb
// ---------------------------------------------------------------------------

/** A ratings export, complete with the BOM Excel leaves on the front. */
export const IMDB_RATINGS = `﻿Const,Your Rating,Date Rated,Title,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes
tt1000001,8,2024-05-02,Fixture Rain,movie,7.4,118,2019,Drama,52000
tt1000002,10,2024-06-13,Fixture Signal,tvSeries,8.8,47,2016,"Drama, Sci-Fi",91000
tt1000003,6,2024-06-14,Fixture Signal: Chapter Two,tvEpisode,7.9,47,2016,Drama,4000
`;

/** A watchlist export: no rating column at all, and a `Created` date instead. */
export const IMDB_WATCHLIST = `Position,Const,Created,Modified,Description,Title,Title Type,Year
1,tt1000004,2024-07-01,2024-07-01,,Unseen Fixture,movie,2023
`;

// ---------------------------------------------------------------------------
// Simkl
// ---------------------------------------------------------------------------

/**
 * A backup CSV. `Fixture Signal` is mid-season-three, which is the per-episode
 * case: Simkl states the *last* episode watched and means everything before it.
 */
export const SIMKL_BACKUP = `SIMKL_ID,Title,Type,Year,Watchlist,LastEpWatched,WatchedDate,Rating,Memo,TVDB,TMDB,IMDB
9001,Fixture Signal,tv,2016,watching,S03E04,2024-06-20,9,Best one yet,777001,4242,tt1000002
9002,Fixture Rain,movie,2019,completed,,2024-01-04,7,,,4243,tt1000001
9003,Fixture Silence,anime,2021,plantowatch,,,,,,,
`;

// ---------------------------------------------------------------------------
// Ryot
// ---------------------------------------------------------------------------

/**
 * A `CompleteExport`. No titles anywhere — an entry is a source plus an id — and
 * the rating is out of 100, which is one of the three scales Ryot allows and
 * does not record which of.
 */
export const RYOT_EXPORT = JSON.stringify({
  metadata: [
    {
      lot: "movie",
      source: "tmdb",
      identifier: "4243",
      seen_history: [{ state: "completed", started_on: "2024-01-04", ended_on: "2024-01-04" }],
      reviews: [{ rating: "70", show_season_number: null, show_episode_number: null }],
    },
    {
      lot: "show",
      source: "tmdb",
      identifier: "4242",
      seen_history: [
        { state: "completed", ended_on: "2024-06-01", show_season_number: 1, show_episode_number: 1 },
        { state: "completed", ended_on: "2024-06-02", show_season_number: 1, show_episode_number: 2 },
        { state: "in_progress", show_season_number: 1, show_episode_number: 3 },
      ],
      reviews: [
        { rating: "90", show_season_number: null, show_episode_number: null },
        { rating: "20", show_season_number: 1, show_episode_number: 1 },
      ],
    },
    { lot: "book", source: "openlibrary", identifier: "OL1W", seen_history: [] },
    { lot: "movie", source: "anilist", identifier: "555", seen_history: [] },
  ],
});

// ---------------------------------------------------------------------------
// Trakt
// ---------------------------------------------------------------------------

const traktIds = (
  trakt: number,
  slug: string,
  extra: { imdb?: string; tmdb?: number; tvdb?: number },
): Record<string, unknown> => ({ trakt, slug, ...extra });

export const TRAKT_WATCHED_MOVIES = JSON.stringify([
  {
    last_watched_at: "2024-01-04T21:15:00.000Z",
    movie: {
      title: "Fixture Rain",
      year: 2019,
      ids: traktIds(11, "fixture-rain-2019", { imdb: "tt1000001", tmdb: 4243 }),
    },
  },
  {
    // The awkward one: IMDb id, no TMDB id. Still an exact match.
    last_watched_at: "2023-11-20T18:00:00.000Z",
    movie: {
      title: "Fixture Orphan",
      year: 1974,
      ids: traktIds(12, "fixture-orphan-1974", { imdb: "tt1000009" }),
    },
  },
]);

export const TRAKT_WATCHED_SHOWS = JSON.stringify([
  {
    last_watched_at: "2024-06-20T20:00:00.000Z",
    show: {
      title: "Fixture Signal",
      year: 2016,
      aired_episodes: 12,
      ids: traktIds(21, "fixture-signal", { imdb: "tt1000002", tmdb: 4242, tvdb: 777001 }),
    },
  },
]);

export const TRAKT_HISTORY = JSON.stringify([
  {
    type: "episode",
    watched_at: "2024-06-18T20:00:00.000Z",
    show: { title: "Fixture Signal", year: 2016, ids: traktIds(21, "fixture-signal", { tmdb: 4242 }) },
    episode: { season: 1, number: 1 },
  },
  {
    // A rewatch of the same episode. One episode, not two.
    type: "episode",
    watched_at: "2024-06-19T20:00:00.000Z",
    show: { title: "Fixture Signal", year: 2016, ids: traktIds(21, "fixture-signal", { tmdb: 4242 }) },
    episode: { season: 1, number: 1 },
  },
  {
    type: "episode",
    watched_at: "2024-06-20T20:00:00.000Z",
    show: { title: "Fixture Signal", year: 2016, ids: traktIds(21, "fixture-signal", { tmdb: 4242 }) },
    episode: { season: 1, number: 2 },
  },
  {
    // Season 0 is Trakt's specials bucket, and has no place in absolute numbering.
    type: "episode",
    watched_at: "2024-06-21T20:00:00.000Z",
    show: { title: "Fixture Signal", year: 2016, ids: traktIds(21, "fixture-signal", { tmdb: 4242 }) },
    episode: { season: 0, number: 1 },
  },
  {
    type: "movie",
    watched_at: "2024-01-04T21:15:00.000Z",
    movie: { title: "Fixture Rain", year: 2019, ids: traktIds(11, "fixture-rain-2019", { tmdb: 4243 }) },
  },
]);

/** Trakt rates out of 10; this plugin out of 5. */
export const TRAKT_RATINGS_MOVIES = JSON.stringify([
  { rating: 7, movie: { title: "Fixture Rain", year: 2019, ids: traktIds(11, "fixture-rain-2019", { tmdb: 4243 }) } },
]);

export const TRAKT_RATINGS_SHOWS = JSON.stringify([
  { rating: 9, show: { title: "Fixture Signal", year: 2016, ids: traktIds(21, "fixture-signal", { tmdb: 4242 }) } },
]);

export const TRAKT_WATCHLIST = JSON.stringify([
  {
    movie: {
      title: "Unseen Fixture",
      year: 2023,
      ids: traktIds(31, "unseen-fixture-2023", { tmdb: 4244 }),
    },
  },
]);

/** The whole export, as `entriesByName` would hand it over. */
export function traktFiles(): Map<string, string> {
  return new Map([
    ["watched-movies.json", TRAKT_WATCHED_MOVIES],
    ["watched-shows.json", TRAKT_WATCHED_SHOWS],
    ["watched-history-1.json", TRAKT_HISTORY],
    ["ratings-movies.json", TRAKT_RATINGS_MOVIES],
    ["ratings-shows.json", TRAKT_RATINGS_SHOWS],
    ["lists-watchlist.json", TRAKT_WATCHLIST],
  ]);
}
