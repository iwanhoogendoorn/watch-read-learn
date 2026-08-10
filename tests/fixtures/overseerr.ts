/**
 * Overseerr response fixtures.
 *
 * Every body below is the shape quoted in `docs/research/report-overseerr-tmdb.md`
 * §1 (read from the `develop` source and the OpenAPI spec, not invented), trimmed
 * only where a field plays no part in a test.
 */

export const statusResponse = {
  version: "1.33.2",
  commitTag: "v1.33.2",
  updateAvailable: false,
};

export const authMeResponse = {
  id: 1,
  email: "iw@nhoogendoorn.nl",
  username: "iwan",
  displayName: "iwan",
  permissions: 2,
};

/** §1.3 — the availability object, verbatim. */
export const mediaInfoGameOfThrones = {
  id: 42,
  mediaType: "tv",
  tmdbId: 1399,
  tvdbId: 121361,
  imdbId: "tt0944947",
  status: 4,
  status4k: 1,
  createdAt: "2020-09-12T10:00:27.000Z",
  updatedAt: "2020-09-12T10:00:27.000Z",
  lastSeasonChange: "2020-09-12T10:00:27.000Z",
  mediaAddedAt: "2020-09-13T02:11:04.000Z",
  ratingKey: "3846",
  serviceId: 0,
  externalServiceId: 17,
  externalServiceSlug: "game-of-thrones",
  seasons: [
    { id: 1, seasonNumber: 1, status: 5, status4k: 1 },
    { id: 2, seasonNumber: 2, status: 4, status4k: 1 },
  ],
  requests: [
    {
      id: 77,
      status: 2,
      createdAt: "2020-09-12T10:00:27.000Z",
      updatedAt: "2020-09-12T10:05:00.000Z",
      is4k: false,
      seasons: [{ id: 9, seasonNumber: 2 }],
    },
  ],
  plexUrl:
    "https://app.plex.tv/desktop#!/server/51d31168cdbab4f2f238cac328b3d979b1f3d706/details?key=%2Flibrary%2Fmetadata%2F3846",
  iOSPlexUrl: "plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F3846",
  serviceUrl: "http://sonarr:8989/series/game-of-thrones",
  downloadStatus: [],
};

/** §1.2 — mixed result types, discriminated by `mediaType`. */
export const searchResponse = {
  page: 1,
  totalPages: 20,
  totalResults: 200,
  results: [
    {
      id: 337401,
      mediaType: "movie",
      title: "Mulan",
      originalTitle: "Mulan",
      releaseDate: "2020-09-04",
      posterPath: "/aKx1ARwG55zZ0GpRvU2WrGrCG9o.jpg",
      backdropPath: "/zzWGRw277MNoCs3zhyG3YmYQsXv.jpg",
      overview: "A young Chinese maiden disguises herself as a male warrior.",
      originalLanguage: "en",
      popularity: 10,
      voteAverage: 7.0,
      voteCount: 1234,
      genreIds: [28, 12, 18],
      adult: false,
      video: false,
    },
    {
      id: 1399,
      mediaType: "tv",
      name: "Game of Thrones",
      originalName: "Game of Thrones",
      firstAirDate: "2011-04-17",
      posterPath: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
      overview: "Seven noble families fight for control of the mythical land of Westeros.",
      originCountry: ["US"],
      voteAverage: 8.4,
      voteCount: 21000,
      genreIds: [10765, 18, 10759],
      mediaInfo: mediaInfoGameOfThrones,
    },
    {
      id: 287,
      mediaType: "person",
      name: "Brad Pitt",
      profilePath: "/cckcYc2v0yh1tc9QjRelptcOBko.jpg",
      knownFor: [],
    },
  ],
};

/** §1.8 — `/tv/{tmdbId}`: TMDB metadata + `mediaInfo`, one call. */
export const tvDetailsShrinking = {
  id: 136311,
  name: "Shrinking",
  overview: "A grieving therapist starts telling his clients exactly what he thinks.",
  posterPath: "/l6DmZfz2XLcnjVFTLZFTGpj1SPJ.jpg",
  backdropPath: "/vLDufOKUmpGh1lstRlNJHOsPGEC.jpg",
  firstAirDate: "2023-01-27",
  lastAirDate: "2026-01-28",
  status: "Returning Series",
  inProduction: true,
  numberOfSeasons: 3,
  numberOfEpisodes: 34,
  episodeRunTime: [30, 30, 38],
  voteAverage: 8.2,
  voteCount: 512,
  genres: [
    { id: 35, name: "Comedy" },
    { id: 18, name: "Drama" },
  ],
  networks: [{ id: 2552, name: "Apple TV+" }],
  seasons: [
    { id: 1, seasonNumber: 0, name: "Specials", episodeCount: 2, airDate: null },
    { id: 2, seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2023-01-27" },
    { id: 3, seasonNumber: 2, name: "Season 2", episodeCount: 12, airDate: "2024-10-16" },
    { id: 4, seasonNumber: 3, name: "Season 3", episodeCount: 12, airDate: "2026-01-14" },
  ],
  nextEpisodeToAir: {
    id: 5551830,
    name: "The Last Session",
    airDate: "2026-08-10",
    episodeNumber: 8,
    seasonNumber: 3,
    runtime: 32,
  },
  lastEpisodeToAir: {
    id: 5551829,
    name: "Kiss Me",
    airDate: "2026-08-03",
    episodeNumber: 7,
    seasonNumber: 3,
    runtime: 31,
  },
  credits: {
    cast: [
      { id: 1, name: "Jason Segel", character: "Jimmy" },
      { id: 2, name: "Harrison Ford", character: "Paul" },
      { id: 3, name: "Jessica Williams", character: "Gaby" },
    ],
    crew: [
      { id: 9, name: "Bill Lawrence", job: "Executive Producer" },
      { id: 10, name: "James Ponsoldt", job: "Director" },
      { id: 11, name: "Randall Winston", job: "Producer" },
    ],
  },
  externalIds: { imdbId: "tt15677150", tvdbId: 411364 },
  relatedVideos: [
    {
      site: "YouTube",
      key: "TEASERKEY",
      name: "Season 3 Teaser",
      size: 1080,
      type: "Teaser",
      url: "https://www.youtube.com/watch?v=TEASERKEY",
      official: true,
    },
    {
      site: "YouTube",
      key: "TRAILERKEY",
      name: "Season 3 Official Trailer",
      size: 1080,
      type: "Trailer",
      url: "https://www.youtube.com/watch?v=TRAILERKEY",
      official: true,
    },
    {
      site: "Vimeo",
      key: "VIMEOKEY",
      name: "Better Trailer",
      size: 2160,
      type: "Trailer",
      url: "https://vimeo.com/VIMEOKEY",
      official: true,
    },
  ],
  mediaInfo: {
    id: 12,
    mediaType: "tv",
    tmdbId: 136311,
    tvdbId: 411364,
    imdbId: "tt15677150",
    status: 4,
    status4k: 1,
    ratingKey: "3846",
    plexUrl:
      "https://app.plex.tv/desktop#!/server/51d31168cdbab4f2f238cac328b3d979b1f3d706/details?key=%2Flibrary%2Fmetadata%2F3846",
    seasons: [
      { id: 1, seasonNumber: 1, status: 5, status4k: 1 },
      { id: 2, seasonNumber: 2, status: 5, status4k: 1 },
      { id: 3, seasonNumber: 3, status: 4, status4k: 1 },
    ],
    downloadStatus: [
      {
        size: 2_000_000_000,
        sizeLeft: 500_000_000,
        estimatedCompletionTime: "2026-08-03T18:00:00.000Z",
        status: "downloading",
        title: "Shrinking S03E07",
      },
    ],
  },
};

/** A show TMDB considers finished — the terminal path. */
export const tvDetailsEnded = {
  id: 1399,
  name: "Game of Thrones",
  overview: "Seven noble families fight for control of Westeros.",
  posterPath: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
  firstAirDate: "2011-04-17",
  status: "Ended",
  inProduction: false,
  numberOfSeasons: 8,
  numberOfEpisodes: 73,
  episodeRunTime: [60],
  genres: [{ id: 10765, name: "Sci-Fi & Fantasy" }],
  seasons: [
    { id: 3624, seasonNumber: 1, name: "Season 1", episodeCount: 10, airDate: "2011-04-17" },
    { id: 3625, seasonNumber: 2, name: "Season 2", episodeCount: 10, airDate: "2012-04-01" },
  ],
  // The reliable "nothing scheduled" signal (report §3.5).
  nextEpisodeToAir: null,
  lastEpisodeToAir: {
    id: 1551830,
    name: "The Iron Throne",
    airDate: "2019-05-19",
    episodeNumber: 6,
    seasonNumber: 8,
  },
  mediaInfo: mediaInfoGameOfThrones,
};

export const movieDetailsAnora = {
  id: 1064213,
  title: "Anora",
  overview: "A young sex worker from Brooklyn meets and impulsively marries the son of an oligarch.",
  posterPath: "/qh0FZUEbtpDL5F3bEjFm4nHUsHo.jpg",
  backdropPath: "/dnJHnQjJcSGiJJPFC3kOZQqRlSt.jpg",
  releaseDate: "2024-10-17",
  runtime: 139,
  voteAverage: 7.1,
  voteCount: 2400,
  imdbId: "tt28607951",
  genres: [
    { id: 35, name: "Comedy" },
    { id: 18, name: "Drama" },
  ],
  productionCompanies: [{ id: 1, name: "FilmNation Entertainment" }, { id: 2, name: "Cre Film" }],
  credits: {
    cast: [
      { id: 20, name: "Mikey Madison" },
      { id: 21, name: "Mark Eydelshteyn" },
    ],
    crew: [
      { id: 30, name: "Sean Baker", job: "Director" },
      { id: 30, name: "Sean Baker", job: "Writer" },
      { id: 31, name: "Drew Daniels", job: "Director of Photography" },
    ],
  },
  relatedVideos: [
    {
      site: "YouTube",
      key: "ANORAOFFICIAL",
      name: "Official Trailer",
      size: 1080,
      type: "Trailer",
      url: "https://www.youtube.com/watch?v=ANORAOFFICIAL",
      official: true,
    },
  ],
  // No `mediaInfo` — Overseerr has never tracked this title. Absent means
  // "not requested, not in Plex", which is NOT `MediaStatus.UNKNOWN`.
};

/** §1.4 — `201 Created` returns a `MediaRequest`. */
export const requestCreatedMovie = {
  id: 123,
  status: 1,
  createdAt: "2020-09-12T10:00:27.000Z",
  updatedAt: "2020-09-12T10:00:27.000Z",
  is4k: false,
  serverId: 0,
  profileId: 1,
  rootFolder: "/movies",
  media: {
    id: 55,
    mediaType: "movie",
    tmdbId: 550,
    status: 2,
    status4k: 1,
  },
  requestedBy: { id: 1, displayName: "iwan", email: "iw@nhoogendoorn.nl" },
  modifiedBy: null,
  seasons: [],
};

/**
 * §1.5 — the server de-duplicates against already-available seasons, so asking
 * for [1,2,3] when S1 exists creates a request for [2,3] only.
 */
export const requestCreatedTv = {
  id: 124,
  status: 1,
  createdAt: "2026-08-03T10:00:27.000Z",
  updatedAt: "2026-08-03T10:00:27.000Z",
  is4k: false,
  media: { id: 12, mediaType: "tv", tmdbId: 136311, status: 3, status4k: 1 },
  seasons: [
    { id: 8, seasonNumber: 2, status: 1 },
    { id: 9, seasonNumber: 3, status: 1 },
  ],
};

/** §1.6 — the 202 trap: a 2xx that created nothing. */
export const noSeasonsAvailable = { message: "No seasons available to request" };

export const duplicateRequest = { message: "Request for this media already exists" };

export const permissionDenied = { message: "You do not have permission to make this request" };

export const requestCountResponse = {
  pending: 2,
  approved: 1,
  processing: 1,
  available: 40,
  total: 44,
};
