/**
 * Direct TMDB v3 fixtures — snake_case, unlike Overseerr's camelCase proxy.
 * Bodies from `docs/research/report-overseerr-tmdb.md` §3.
 */

/** §3.7 — trailer selection input. */
export const videosResponse = {
  id: 550,
  results: [
    {
      iso_639_1: "en",
      iso_3166_1: "US",
      name: "Fight Club | Behind the Scenes",
      key: "BTSKEY",
      site: "YouTube",
      size: 2160,
      type: "Behind the Scenes",
      official: true,
      published_at: "2018-01-01T00:00:00.000Z",
      id: "639d5326be6d88007f170f01",
    },
    {
      iso_639_1: "en",
      iso_3166_1: "US",
      name: "Fight Club | Teaser",
      key: "TEASER",
      site: "YouTube",
      size: 1080,
      type: "Teaser",
      official: true,
      published_at: "2016-01-05T02:03:14.000Z",
      id: "639d5326be6d88007f170f02",
    },
    {
      iso_639_1: "en",
      iso_3166_1: "US",
      name: "Fight Club | Fan Trailer",
      key: "FANMADE",
      site: "YouTube",
      size: 2160,
      type: "Trailer",
      official: false,
      published_at: "2020-01-05T02:03:14.000Z",
      id: "639d5326be6d88007f170f03",
    },
    {
      iso_639_1: "en",
      iso_3166_1: "US",
      name: "Fight Club | #TBT Trailer | 20th Century FOX",
      key: "BdJKm16Co6M",
      site: "YouTube",
      size: 1080,
      type: "Trailer",
      official: true,
      published_at: "2016-03-05T02:03:14.000Z",
      id: "639d5326be6d88007f170f44",
    },
    {
      iso_639_1: "en",
      iso_3166_1: "US",
      name: "Fight Club | 4K Trailer",
      key: "VIMEOONLY",
      site: "Vimeo",
      size: 2160,
      type: "Trailer",
      official: true,
      published_at: "2021-03-05T02:03:14.000Z",
      id: "639d5326be6d88007f170f45",
    },
  ],
};

/** §3.6 — `type: 4` is Digital; 3 is Theatrical, 5 is Physical. */
export const releaseDatesResponse = {
  id: 550,
  results: [
    {
      iso_3166_1: "US",
      release_dates: [
        { certification: "R", iso_639_1: "", note: "", release_date: "1999-10-15T00:00:00.000Z", type: 3 },
        { certification: "", iso_639_1: "", note: "DVD", release_date: "2000-06-06T00:00:00.000Z", type: 5 },
      ],
    },
    {
      iso_3166_1: "NL",
      release_dates: [
        { certification: "16", iso_639_1: "", note: "", release_date: "1999-11-11T00:00:00.000Z", type: 3 },
        { certification: "", iso_639_1: "", note: "", release_date: "2000-05-01T00:00:00.000Z", type: 4 },
        { certification: "", iso_639_1: "", note: "", release_date: "2000-04-01T00:00:00.000Z", type: 6 },
      ],
    },
  ],
};

/** §3.5 — TV details, with season 0 present and `next_episode_to_air: null`. */
export const tvDetailsResponse = {
  id: 1399,
  name: "Game of Thrones",
  overview: "Seven noble families fight for control of the mythical land of Westeros.",
  poster_path: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
  backdrop_path: "/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg",
  status: "Ended",
  in_production: false,
  first_air_date: "2011-04-17",
  last_air_date: "2019-05-19",
  number_of_episodes: 73,
  number_of_seasons: 8,
  episode_run_time: [60],
  vote_average: 8.4,
  vote_count: 21000,
  genres: [{ id: 10765, name: "Sci-Fi & Fantasy" }],
  networks: [{ id: 49, name: "HBO" }],
  last_episode_to_air: {
    id: 1551830,
    name: "The Iron Throne",
    air_date: "2019-05-19",
    episode_number: 6,
    season_number: 8,
    runtime: 80,
  },
  next_episode_to_air: null,
  seasons: [
    { id: 3627, name: "Specials", season_number: 0, air_date: null, episode_count: 14 },
    { id: 3624, name: "Season 1", season_number: 1, air_date: "2011-04-17", episode_count: 10 },
    { id: 3625, name: "Season 2", season_number: 2, air_date: "2012-04-01", episode_count: 10 },
  ],
  credits: {
    cast: [{ id: 22970, name: "Peter Dinklage" }],
    crew: [{ id: 1, name: "David Nutter", job: "Director" }],
  },
  external_ids: { imdb_id: "tt0944947", tvdb_id: 121361 },
  videos: { results: videosResponse.results },
};

export const searchMovieResponse = {
  page: 1,
  results: [
    {
      id: 1064213,
      title: "Anora",
      original_title: "Anora",
      release_date: "2024-10-17",
      poster_path: "/qh0FZUEbtpDL5F3bEjFm4nHUsHo.jpg",
      overview: "A young sex worker from Brooklyn meets the son of an oligarch.",
      vote_average: 7.1,
      vote_count: 2400,
      genre_ids: [35, 18],
      adult: false,
    },
  ],
  total_pages: 1,
  total_results: 1,
};
