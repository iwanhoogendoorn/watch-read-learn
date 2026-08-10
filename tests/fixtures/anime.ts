/**
 * AniList and Jikan fixtures.
 *
 * Every payload here is shaped from the live probes recorded in
 * `docs/research/report-media-apis.md` §1 — including the two failure bodies
 * that were reproduced against the real services: Jikan's 429 (whose `status` is
 * the **string** `"429"`) and its `504 BadResponseException` (whose `status` is
 * the **number** `504`), and AniList's 429, which arrives as a GraphQL body with
 * `data: null`.
 */

// ---------------------------------------------------------------------------
// AniList
// ---------------------------------------------------------------------------

/** Frieren, as AniList's media selection returns it. */
export const anilistFrieren = {
  id: 154587,
  idMal: 52991,
  title: {
    romaji: "Sousou no Frieren",
    english: "Frieren: Beyond Journey's End",
    native: "葬送のフリーレン",
  },
  status: "FINISHED",
  format: "TV",
  episodes: 28,
  duration: 24,
  season: "FALL",
  seasonYear: 2023,
  startDate: { year: 2023, month: 9, day: 29 },
  endDate: { year: 2024, month: 3, day: 22 },
  coverImage: {
    large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/154587.jpg",
    extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/xl/154587.jpg",
  },
  bannerImage: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/154587.jpg",
  description: "The adventure is over but life goes on.<br><br>It was a party of four.",
  genres: ["Adventure", "Drama", "Fantasy"],
  averageScore: 89,
  studios: { nodes: [{ name: "Madhouse" }] },
  trailer: { id: "qsRWDkMWfMU", site: "youtube" },
  externalLinks: [
    { site: "Official Site", url: "https://frieren-anime.jp/" },
    { site: "The Movie Database", url: "https://www.themoviedb.org/tv/209867" },
  ],
  nextAiringEpisode: null,
};

/** A currently-airing entry: episode count unknown, next episode scheduled. */
export const anilistAiringShow = {
  id: 201514,
  idMal: 60123,
  title: { romaji: "Saijo no Osewa", english: "Rich Girl Caretaker", native: "最上のおせわ" },
  status: "RELEASING",
  format: "TV",
  episodes: 12,
  duration: 23,
  season: "SUMMER",
  seasonYear: 2026,
  startDate: { year: 2026, month: 7, day: 5 },
  endDate: { year: null, month: null, day: null },
  coverImage: { large: "https://s4.anilist.co/cover/201514.jpg", extraLarge: "" },
  bannerImage: "",
  description: "A caretaker, and a rich girl.",
  genres: ["Comedy", "Romance"],
  averageScore: 72,
  studios: { nodes: [{ name: "Studio Deen" }] },
  trailer: null,
  externalLinks: [],
  nextAiringEpisode: { airingAt: 1_785_016_800, episode: 5 },
};

/** An entry AniList has announced but not dated, and which has no TMDB link. */
export const anilistUpcomingShow = {
  id: 999001,
  idMal: null,
  title: { romaji: "Mirai no Nanika", english: "", native: "未来の何か" },
  status: "NOT_YET_RELEASED",
  format: "TV",
  episodes: null,
  duration: null,
  season: null,
  seasonYear: 2027,
  startDate: { year: 2027, month: null, day: null },
  endDate: null,
  coverImage: { large: "", extraLarge: "" },
  bannerImage: "",
  description: "",
  genres: [],
  averageScore: null,
  studios: { nodes: [] },
  trailer: null,
  externalLinks: [],
  nextAiringEpisode: null,
};

export function anilistSearchResponse(media: unknown[] = [anilistFrieren, anilistAiringShow]) {
  return { data: { Page: { media } } };
}

export function anilistMediaResponse(media: unknown = anilistFrieren) {
  return { data: { Media: media } };
}

/**
 * A schedule window straddling "now".
 *
 * `timeUntilAiring` is present and **negative** on the past entries, exactly as
 * the live probe returned it. Nothing in WatchLog may read it: it is computed
 * server-side and is stale on arrival. These fixtures carry it precisely so a
 * regression that starts trusting it fails loudly.
 */
export function anilistSchedulesResponse(
  schedules: { mediaId: number; episode: number; airingAt: number; timeUntilAiring?: number }[],
) {
  return { data: { Page: { airingSchedules: schedules } } };
}

/** HTTP 429 with a GraphQL-shaped body and `data: null` (report §1.2). */
export const anilistRateLimitBody = {
  data: null,
  errors: [{ message: "Too Many Requests.", status: 429 }],
};

/** AniList also answers 200 with an errors array. Status alone proves nothing. */
export const anilistNotFoundBody = {
  data: null,
  errors: [{ message: "Not Found.", status: 404 }],
};

// ---------------------------------------------------------------------------
// Jikan
// ---------------------------------------------------------------------------

/** `GET /anime/52991/full`, trimmed to the fields the client reads. */
export const jikanFrieren = {
  mal_id: 52991,
  url: "https://myanimelist.net/anime/52991",
  images: {
    jpg: {
      image_url: "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
      large_image_url: "https://cdn.myanimelist.net/images/anime/1015/138006l.jpg",
    },
    webp: { image_url: "", large_image_url: "" },
  },
  trailer: { youtube_id: "qsRWDkMWfMU", url: "https://www.youtube.com/watch?v=qsRWDkMWfMU" },
  titles: [
    { type: "Default", title: "Sousou no Frieren" },
    { type: "English", title: "Frieren: Beyond Journey's End" },
    { type: "Japanese", title: "葬送のフリーレン" },
  ],
  // The deprecated flat fields, kept in the fixture on purpose: the client must
  // read `titles[]` and only fall back to these.
  title: "Sousou no Frieren",
  title_english: "Frieren: Beyond Journey's End",
  type: "TV",
  episodes: 28,
  status: "Finished Airing",
  airing: false,
  aired: {
    from: "2023-09-29T00:00:00+00:00",
    to: "2024-03-22T00:00:00+00:00",
    string: "Sep 29, 2023 to Mar 22, 2024",
  },
  duration: "24 min per ep",
  score: 9.26,
  synopsis: "During their decade-long quest to defeat the Demon King…",
  season: "fall",
  year: 2023,
  broadcast: { day: "Fridays", time: "23:00", timezone: "Asia/Tokyo", string: "Fridays at 23:00 (JST)" },
  genres: [{ name: "Adventure" }, { name: "Drama" }, { name: "Fantasy" }],
  studios: [{ name: "Madhouse" }],
};

/** A currently-airing entry with no end date and an unknown score (`0`). */
export const jikanAiringShow = {
  mal_id: 60123,
  url: "https://myanimelist.net/anime/60123",
  images: { jpg: { image_url: "https://cdn.myanimelist.net/images/anime/1/60123.jpg" } },
  titles: [{ type: "Default", title: "Saijo no Osewa" }],
  type: "TV",
  episodes: 12,
  status: "Currently Airing",
  airing: true,
  aired: { from: "2026-07-05T00:00:00+00:00", to: null },
  duration: "23 min per ep",
  // Report §1.1: an unknown score is `0`, not null. Never average it blindly.
  score: 0,
  synopsis: "A caretaker, and a rich girl.",
  season: "summer",
  year: 2026,
  broadcast: { day: "Sundays", time: "22:00", timezone: "Asia/Tokyo" },
  genres: [{ name: "Comedy" }],
  studios: [{ name: "Studio Deen" }],
};

export function jikanSearchResponse(data: unknown[] = [jikanFrieren, jikanAiringShow]) {
  return {
    pagination: {
      last_visible_page: 1,
      has_next_page: false,
      current_page: 1,
      items: { count: data.length, total: data.length, per_page: 25 },
    },
    data,
  };
}

export function jikanFullResponse(data: unknown = jikanFrieren) {
  return { data };
}

/** Live-reproduced: `status` is the **string** `"429"` here. */
export const jikanRateLimitBody = {
  status: "429",
  type: "RateLimitException",
  message: "You are being rate-limited. Please follow Rate Limiting guidelines",
  error: null,
};

/** Live-reproduced: `status` is the **number** `504` here. MyAnimeList is down. */
export const jikanOutageBody = {
  status: 504,
  type: "BadResponseException",
  message: "Jikan failed to connect to MyAnimeList. MyAnimeList may be down/unavailable or refuses to connect",
  error: null,
};
