/**
 * The anime domain (SPEC2 D-ANIME) end to end.
 *
 * The claim being tested is not "anime works" but "anime is not special": an
 * AniList schedule becomes the same `AiringCache` a TMDB show produces, lands in
 * the same Upcoming list through the same builder, and is found on Plex by the
 * same matcher — while the two things that genuinely *are* different are held
 * to their own rules. Those two are per-cour seasons (AniList's "Season 2" is a
 * different work, so nothing may announce one) and Overseerr requests (which
 * need a TMDB id that anime frequently do not have).
 */
import { describe, expect, it } from "vitest";
import {
  airDateFromUnix,
  animeSeasonNumber,
  animeSeasonSyncPlan,
  computeAnimeAiring,
  computeAnimeAiringFromJikan,
  createAnimeAiringService,
  shouldTrackAnimeAiring,
  showStatusForAniList,
  showStatusForJikan,
} from "../src/domains/anime/airing";
import {
  animeRequestBlockedReason,
  animeRequestTarget,
  canRequestAnime,
  tmdbTargetFromLinks,
  tmdbTargetFromUrl,
} from "../src/domains/anime/request";
import {
  buildTitleFromAnime,
  createAnimeSearchService,
  entryFromAniList,
  entryFromAniListSearch,
  entryFromJikan,
  findExistingAnime,
  preferredAnimeTitle,
  statusFromJikan,
} from "../src/domains/anime/search";
import { animeTypeFor, metaLineFor, resultViewFor } from "../src/domains/anime/modal";
import { createTtlCache } from "../src/domains/anime/cache";
import { createAniListClient } from "../src/services/anilist";
import { createJikanClient, normalizeJikanAnime } from "../src/services/jikan";
import { createRateLimiter } from "../src/services/ratelimit";
import { isTerminalShowStatus } from "../src/services/airing";
import { confirmsMatch, normalizeTitle } from "../src/services/availability";
import { buildUpcomingEntries } from "../src/ui/tabs/upcoming";
import { createTitle } from "../src/data/schema";
import type { RoutingSettings } from "../src/services/typeroute";
import type { AniListMediaFull } from "../src/services/anilist";
import type { TitleV4 } from "../src/types";
import { createFakeHttp, createTestClock, type FakeRoute } from "./mocks/http";
import * as fx from "./fixtures/anime";

const DAY = 86_400;

function settings(over: Partial<RoutingSettings> = {}): RoutingSettings {
  return { typeApiMapping: {}, animeApiSource: "anilist", ...over };
}

function title(over: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({ id: "frieren", title: "Frieren", type: "Anime", ...over });
}

/** A media object shaped like the client's own output, without the transport. */
function media(over: Partial<AniListMediaFull> = {}): AniListMediaFull {
  return {
    id: 201514,
    title: { romaji: "Saijo no Osewa", english: "Rich Girl Caretaker", native: "" },
    status: "RELEASING",
    format: "TV",
    episodes: 12,
    coverUrl: "",
    description: "",
    genres: [],
    studios: [],
    trailerUrl: "",
    externalLinks: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

describe("status mapping", () => {
  it("speaks the airing cache's vocabulary, not AniList's", () => {
    expect(showStatusForAniList("RELEASING")).toBe("Returning Series");
    expect(showStatusForAniList("FINISHED")).toBe("Ended");
    expect(showStatusForAniList("NOT_YET_RELEASED")).toBe("Planned");
    // TMDB's one-L spelling, so chips and filters read the same everywhere.
    expect(showStatusForAniList("CANCELLED")).toBe("Canceled");
  });

  it("maps every status onto the terminal/non-terminal split the queue uses", () => {
    expect(isTerminalShowStatus(showStatusForAniList("FINISHED"))).toBe(true);
    expect(isTerminalShowStatus(showStatusForAniList("CANCELLED"))).toBe(true);
    expect(isTerminalShowStatus(showStatusForAniList("RELEASING"))).toBe(false);
    // A show on hiatus is paused, not over: marking it terminal would drop it
    // out of the refresh queue permanently.
    expect(isTerminalShowStatus(showStatusForAniList("HIATUS"))).toBe(false);
    expect(isTerminalShowStatus(showStatusForAniList("NOT_YET_RELEASED"))).toBe(false);
  });

  it("maps Jikan's three statuses onto the same words", () => {
    expect(showStatusForJikan("Currently Airing")).toBe("Returning Series");
    expect(showStatusForJikan("Finished Airing")).toBe("Ended");
    expect(showStatusForJikan("Not yet aired")).toBe("Planned");
    expect(statusFromJikan("Currently Airing")).toBe("RELEASING");
  });
});

// ---------------------------------------------------------------------------
// Airing cache
// ---------------------------------------------------------------------------

describe("airing cache", () => {
  const now = new Date("2026-08-03T12:00:00Z");
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it("turns exact timestamps into the calendar days the cache stores", () => {
    const airing = computeAnimeAiring(title(), media(), {
      now,
      schedules: [
        { mediaId: 201514, episode: 4, airingAt: nowSeconds - 2 * DAY },
        { mediaId: 201514, episode: 5, airingAt: nowSeconds + 3 * DAY },
        { mediaId: 201514, episode: 6, airingAt: nowSeconds + 10 * DAY },
      ],
    });

    expect(airing.nextEpisode).toEqual({
      season: 1,
      episode: 5,
      airDate: airDateFromUnix(nowSeconds + 3 * DAY),
    });
    expect(airing.lastEpisode?.episode).toBe(4);
    expect(airing.showStatus).toBe("Returning Series");
    expect(airing.episodeCount).toBe(12);
    expect(airing.checkedAt).toBe(now.toISOString());
  });

  it("never stores a countdown — only the date it counts to", () => {
    const airing = computeAnimeAiring(title(), media(), {
      now,
      schedules: [{ mediaId: 201514, episode: 5, airingAt: nowSeconds + 3 * DAY }],
    });
    expect(JSON.stringify(airing)).not.toContain("timeUntil");
    expect(Object.keys(airing.nextEpisode as object).sort()).toEqual(["airDate", "episode", "season"]);
  });

  it("ignores schedules belonging to another media id", () => {
    const airing = computeAnimeAiring(title(), media(), {
      now,
      schedules: [{ mediaId: 999, episode: 3, airingAt: nowSeconds + DAY }],
    });
    expect(airing.nextEpisode).toBeUndefined();
  });

  it("falls back to nextAiringEpisode when no schedule window was fetched", () => {
    const airing = computeAnimeAiring(
      title(),
      media({ nextAiring: { mediaId: 201514, episode: 5, airingAt: nowSeconds + DAY } }),
      { now },
    );
    expect(airing.nextEpisode?.episode).toBe(5);
  });

  it("never announces a season — an AniList entry is one cour", () => {
    const airing = computeAnimeAiring(title(), media({ episodes: 12 }), {
      now,
      schedules: [{ mediaId: 201514, episode: 5, airingAt: nowSeconds + DAY }],
    });
    // A sequel cour is a different mediaId, so there is nothing here that could
    // honestly answer "is there a new season" — and guessing would fight the
    // catalogue the data came from.
    expect(airing.pendingSeason).toBeUndefined();
    expect(airing.newSeasonDetected).toBeUndefined();
    expect(airing.seasonCount).toBeUndefined();
  });

  it("numbers episodes against the newest season a split title tracks", () => {
    const split = title({
      seasons: [
        { name: "Season 1", episodes: 28, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
        { name: "Season 2", episodes: 0, offset: 28, skippedEpisodes: [], seasonNumber: 2 },
      ],
    });
    expect(animeSeasonNumber(split)).toBe(2);

    const airing = computeAnimeAiring(split, media(), {
      now,
      schedules: [{ mediaId: 201514, episode: 3, airingAt: nowSeconds + DAY }],
    });
    expect(airing.nextEpisode?.season).toBe(2);
  });

  it("gives Jikan status and counts, and refuses to invent an episode date", () => {
    const anime = normalizeJikanAnime(fx.jikanAiringShow as unknown as Record<string, unknown>);
    const airing = computeAnimeAiringFromJikan(anime, { now });
    expect(airing).toMatchObject({ showStatus: "Returning Series", inProduction: true, episodeCount: 12 });
    // Jikan publishes a weekly slot with no episode number. Turning that into
    // "episode 7 airs Friday" means inventing the 7.
    expect(airing.nextEpisode).toBeUndefined();
  });
});

describe("season sync, per cour", () => {
  it("fills in a season the user left empty", () => {
    const pending = title({
      seasons: [{ name: "Season 1", episodes: 0, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    });
    expect(animeSeasonSyncPlan(pending, media({ episodes: 12 }))).toEqual({
      added: [],
      grown: [{ seasonNumber: 1, episodes: 12 }],
    });
  });

  it("leaves a season the user has sized alone", () => {
    const trimmed = title({
      seasons: [{ name: "Season 1", episodes: 6, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    });
    expect(animeSeasonSyncPlan(trimmed, media({ episodes: 12 })).grown).toEqual([]);
  });

  it("never appends a season", () => {
    const single = title({
      seasons: [{ name: "Season 1", episodes: 28, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    });
    expect(animeSeasonSyncPlan(single, media({ episodes: 12 })).added).toEqual([]);
  });

  it("does nothing when upstream does not know the episode count yet", () => {
    const pending = title({
      seasons: [{ name: "Season 1", episodes: 0, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    });
    expect(animeSeasonSyncPlan(pending, media({ episodes: undefined })).grown).toEqual([]);
  });
});

describe("what stays in the refresh queue", () => {
  it("skips a title with no anime id at all", () => {
    expect(shouldTrackAnimeAiring(title())).toBe(false);
  });

  it("drops a finished show and keeps an airing one", () => {
    expect(shouldTrackAnimeAiring(title({ anilistId: 1, airing: { showStatus: "Ended" } }))).toBe(false);
    expect(
      shouldTrackAnimeAiring(title({ anilistId: 1, airing: { showStatus: "Returning Series" } })),
    ).toBe(true);
  });

  it("keeps a show whose schedule contradicts its status", () => {
    const revived = title({
      anilistId: 1,
      airing: { showStatus: "Ended", nextEpisode: { season: 1, episode: 2, airDate: "2026-09-01" } },
    });
    expect(shouldTrackAnimeAiring(revived)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Upcoming list
// ---------------------------------------------------------------------------

describe("Upcoming rows", () => {
  it("produces the same episode row a TV show would", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const nowSeconds = Math.floor(now.getTime() / 1000);

    const tracked = title({ anilistId: 201514, title: "Rich Girl Caretaker" });
    const airing = computeAnimeAiring(tracked, media(), {
      now,
      schedules: [
        { mediaId: 201514, episode: 4, airingAt: nowSeconds - 2 * DAY },
        { mediaId: 201514, episode: 5, airingAt: nowSeconds + 3 * DAY },
      ],
    });

    // The cache goes onto the title untouched — there is no anime-shaped cache.
    const entries = buildUpcomingEntries([{ ...tracked, airing }], now);
    const episode = entries.find((entry) => entry.kind === "episode");

    expect(episode).toBeDefined();
    expect(episode?.label).toBe("S01E05");
    expect(episode?.daysUntil).toBe(3);
    expect(entries.some((entry) => entry.kind === "season")).toBe(false);
  });

  it("puts an undated announced anime on the list through its release date", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const announced = title({
      anilistId: 999001,
      title: "Mirai no Nanika",
      releaseDate: "2026-10-01",
      airing: { showStatus: "Planned", checkedAt: now.toISOString() },
    });
    const entries = buildUpcomingEntries([announced], now);
    expect(entries.map((entry) => entry.kind)).toEqual(["release"]);
  });
});

// ---------------------------------------------------------------------------
// Search and the add flow
// ---------------------------------------------------------------------------

describe("entry normalisation", () => {
  it("prefers English, then romaji, then native", () => {
    expect(preferredAnimeTitle({ romaji: "R", english: "E", native: "N" })).toBe("E");
    expect(preferredAnimeTitle({ romaji: "R", english: "", native: "N" })).toBe("R");
    expect(preferredAnimeTitle({ romaji: "", english: "", native: "N" })).toBe("N");
  });

  it("converts AniList's 0–100 score onto the 0–10 scale the plugin uses", () => {
    const entry = entryFromAniList(media({ averageScore: 89 }));
    expect(entry.score).toBe(8.9);
    // Jikan already scores 0–10, and its "unknown" zero carries through as zero.
    const jikan = entryFromJikan(normalizeJikanAnime(fx.jikanAiringShow as never));
    expect(jikan.score).toBe(0);
  });

  it("reads a TMDB id out of AniList's own external links", () => {
    const entry = entryFromAniList(
      media({
        externalLinks: [
          { site: "Official Site", url: "https://frieren-anime.jp/" },
          { site: "The Movie Database", url: "https://www.themoviedb.org/tv/209867" },
        ],
      }),
    );
    expect(entry.tmdb).toEqual({ tmdbId: 209867, mediaType: "tv" });
  });

  it("carries the ids and the runtime across from Jikan", () => {
    const entry = entryFromJikan(normalizeJikanAnime(fx.jikanFrieren as never));
    expect(entry).toMatchObject({
      provider: "jikan",
      malId: 52991,
      title: "Frieren: Beyond Journey's End",
      episodes: 28,
      duration: 24,
      status: "FINISHED",
      showStatus: "Ended",
      seasonYear: 2023,
      season: "fall",
    });
    expect(entry.anilistId).toBeUndefined();
  });
});

describe("building a title", () => {
  const now = new Date("2026-08-03T12:00:00Z");

  it("stores the catalogue id the entry came from, in the field that already exists", () => {
    const entry = entryFromAniList(media({ id: 154587, malId: 52991, episodes: 28 }));
    const built = buildTitleFromAnime(entry, { type: "Anime", takenIds: [], now });

    expect(built.anilistId).toBe(154587);
    expect(built.malId).toBe(52991);
    expect(built.communitySource).toBe("anilist");
    expect(built.totalEpisodes).toBe(28);
    expect(built.seasons).toHaveLength(1);
    expect(built.airing?.showStatus).toBe("Returning Series");
  });

  it("gives a film one episode and no season grid", () => {
    const film = entryFromAniList(media({ format: "MOVIE", episodes: 1 }));
    const built = buildTitleFromAnime(film, { type: "Anime", takenIds: [], now });
    expect(built.totalEpisodes).toBe(1);
    expect(built.seasons).toEqual([]);
  });

  it("gives a show three weeks into its run an empty season to fill later", () => {
    const airingNow = entryFromAniList(media({ episodes: undefined }));
    const built = buildTitleFromAnime(airingNow, { type: "Anime", takenIds: [], now });
    expect(built.seasons[0]?.episodes).toBe(0);
    expect(built.totalEpisodes).toBe(1);
    // Which is exactly what the season sync fills in on the next refresh.
    expect(animeSeasonSyncPlan(built, media({ episodes: 12 })).grown).toEqual([
      { seasonNumber: 1, episodes: 12 },
    ]);
  });

  it("only writes a TMDB id when the catalogue published one", () => {
    const linked = entryFromAniList(
      media({ externalLinks: [{ site: "TMDB", url: "https://www.themoviedb.org/tv/209867" }] }),
    );
    expect(buildTitleFromAnime(linked, { type: "Anime", takenIds: [], now }).tmdbId).toBe(209867);

    const unlinked = entryFromAniList(media());
    expect(buildTitleFromAnime(unlinked, { type: "Anime", takenIds: [], now }).tmdbId).toBeUndefined();
  });

  it("spots a title already tracked, by id first and title second", () => {
    const existing = title({ anilistId: 154587, title: "Sousou no Frieren" });
    const entry = entryFromAniList(media({ id: 154587 }));
    expect(findExistingAnime([existing], entry)?.id).toBe("frieren");

    const byName = title({ title: "Rich Girl Caretaker" });
    expect(findExistingAnime([byName], entryFromAniList(media()))?.id).toBe("frieren");
    expect(findExistingAnime([], entry)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider fallback
// ---------------------------------------------------------------------------

describe("search falls back", () => {
  function service(routes: Record<string, FakeRoute>, over: Partial<RoutingSettings> = {}) {
    const fake = createFakeHttp(routes);
    const { clock } = createTestClock();
    const anilist = createAniListClient(() => ({ enabled: true }), {
      http: fake.http,
      clock,
      limiter: createRateLimiter(0, clock),
      cache: createTtlCache<unknown>(60_000, clock),
    });
    const jikan = createJikanClient(() => ({ enabled: true }), {
      http: fake.http,
      clock,
      limiter: createRateLimiter(0, clock),
      cache: createTtlCache<unknown>(60_000, clock),
    });
    return {
      fake,
      search: createAnimeSearchService({ anilist, jikan, settings: () => settings(over) }),
    };
  }

  it("asks AniList first and stops there", async () => {
    const { search, fake } = service({
      "graphql.anilist.co": { body: fx.anilistSearchResponse() },
      "api.jikan.moe": { body: fx.jikanSearchResponse() },
    });
    const outcome = await search.search("frieren");
    expect(outcome.provider).toBe("anilist");
    expect(outcome.entries).toHaveLength(2);
    expect(fake.urls.some((url) => url.includes("jikan"))).toBe(false);
  });

  it("falls through to Jikan when AniList is rate-limited", async () => {
    const { search } = service({
      "graphql.anilist.co": { status: 429, body: fx.anilistRateLimitBody },
      "api.jikan.moe": { body: fx.jikanSearchResponse() },
    });
    const outcome = await search.search("frieren");
    expect(outcome.provider).toBe("jikan");
    expect(outcome.fellBackFrom?.provider).toBe("anilist");
    expect(outcome.entries[0]?.malId).toBe(52991);
  });

  it("falls back the other way when the preference is Jikan and MyAnimeList is down", async () => {
    const { search } = service(
      {
        "graphql.anilist.co": { body: fx.anilistSearchResponse() },
        "api.jikan.moe": { status: 504, body: fx.jikanOutageBody },
      },
      { animeApiSource: "jikan" },
    );
    const outcome = await search.search("frieren");
    expect(outcome.provider).toBe("anilist");
    expect(outcome.fellBackFrom?.provider).toBe("jikan");
  });

  it("reports the primary's failure when neither catalogue answers", async () => {
    const { search } = service({
      "graphql.anilist.co": { status: 429, body: fx.anilistRateLimitBody },
      "api.jikan.moe": { status: 504, body: fx.jikanOutageBody },
    });
    await expect(search.search("frieren")).rejects.toMatchObject({ provider: "anilist" });
  });

  it("does not retry an honest zero-result search on the other provider", async () => {
    const { search, fake } = service({
      "graphql.anilist.co": { body: fx.anilistSearchResponse([]) },
      "api.jikan.moe": { body: fx.jikanSearchResponse() },
    });
    const outcome = await search.search("qwertyuiop");
    expect(outcome.entries).toEqual([]);
    expect(fake.urls.some((url) => url.includes("jikan"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The refresh service
// ---------------------------------------------------------------------------

describe("refreshing a library", () => {
  function service(routes: Record<string, FakeRoute>, now: Date, over: Partial<RoutingSettings> = {}) {
    const fake = createFakeHttp(routes);
    const { clock } = createTestClock();
    const anilist = createAniListClient(() => ({ enabled: true }), {
      http: fake.http,
      clock,
      limiter: createRateLimiter(0, clock),
      cache: createTtlCache<unknown>(60_000, clock),
    });
    const jikan = createJikanClient(() => ({ enabled: true }), {
      http: fake.http,
      clock,
      limiter: createRateLimiter(0, clock),
      cache: createTtlCache<unknown>(60_000, clock),
    });
    return {
      fake,
      airing: createAnimeAiringService({
        anilist,
        jikan,
        settings: () => settings(over),
        now: () => now,
        limiter: createRateLimiter(0, clock),
      }),
    };
  }

  const now = new Date("2026-08-03T12:00:00Z");
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it("refreshes a whole library in two requests, not two per title", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => 200_000 + i);
    const titles = ids.map((id, i) =>
      createTitle({ id: `t${i}`, title: `Show ${i}`, type: "Anime", anilistId: id }),
    );

    const { airing, fake } = service(
      {
        "graphql.anilist.co": (request) => {
          const query = String((request.json as { query: string }).query);
          if (query.includes("airingSchedules")) {
            return {
              body: fx.anilistSchedulesResponse(
                ids.map((id, i) => ({ mediaId: id, episode: 5, airingAt: nowSeconds + (i + 1) * DAY })),
              ),
            };
          }
          return {
            body: { data: { Page: { media: ids.map((id) => ({ ...fx.anilistAiringShow, id })) } } },
          };
        },
      },
      now,
    );

    const results = await airing.refreshAll(titles);
    expect(results).toHaveLength(20);
    expect(results.every((result) => result.airing?.nextEpisode !== undefined)).toBe(true);
    // Twenty titles, two requests. At 30/min the naive shape would not fit.
    expect(fake.calls).toHaveLength(2);
  });

  it("reports a per-episode change for the activity log", async () => {
    const tracked = createTitle({
      id: "t",
      title: "Rich Girl Caretaker",
      type: "Anime",
      anilistId: 201514,
      airing: { showStatus: "Returning Series", nextEpisode: { season: 1, episode: 4, airDate: "2026-07-30" } },
    });

    const { airing } = service(
      {
        "graphql.anilist.co": (request) => {
          const query = String((request.json as { query: string }).query);
          return query.includes("airingSchedules")
            ? {
                body: fx.anilistSchedulesResponse([
                  { mediaId: 201514, episode: 5, airingAt: nowSeconds + DAY },
                ]),
              }
            : { body: { data: { Page: { media: [fx.anilistAiringShow] } } } };
        },
      },
      now,
    );

    const [result] = await airing.refreshAll([tracked]);
    expect(result?.change).toContain("S01E05");
    expect(result?.airing?.nextEpisode?.episode).toBe(5);
  });

  it("falls back to Jikan for a title AniList cannot answer for", async () => {
    const malOnly = createTitle({ id: "t", title: "Frieren", type: "Anime", malId: 52991 });
    const { airing } = service(
      {
        "graphql.anilist.co": { status: 429, body: fx.anilistRateLimitBody },
        "api.jikan.moe": { body: fx.jikanFullResponse() },
      },
      now,
    );

    const [result] = await airing.refreshAll([malOnly]);
    expect(result?.error).toBeUndefined();
    expect(result?.airing?.showStatus).toBe("Ended");
    expect(result?.airing?.episodeCount).toBe(28);
  });

  it("skips a title with no anime id and says why", async () => {
    const orphan = createTitle({ id: "t", title: "Nothing", type: "Anime" });
    const { airing, fake } = service({ "graphql.anilist.co": { body: {} } }, now);
    expect(await airing.refreshAll([orphan])).toEqual([]);
    const single = await airing.refreshTitle(orphan);
    expect(single.error).toContain("no AniList or MAL id");
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Requests and availability
// ---------------------------------------------------------------------------

describe("Overseerr requests", () => {
  it("reads a TMDB id out of a URL and refuses to invent one", () => {
    expect(tmdbTargetFromUrl("https://www.themoviedb.org/tv/209867")).toEqual({
      tmdbId: 209867,
      mediaType: "tv",
    });
    expect(tmdbTargetFromUrl("https://www.themoviedb.org/movie/550-fight-club")).toEqual({
      tmdbId: 550,
      mediaType: "movie",
    });
    expect(tmdbTargetFromUrl("https://myanimelist.net/anime/52991")).toBeUndefined();
    expect(tmdbTargetFromLinks([{ site: "MAL", url: "https://myanimelist.net/anime/52991" }])).toBeUndefined();
    expect(tmdbTargetFromLinks(undefined)).toBeUndefined();
  });

  it("hides the action for an anime with no TMDB id", () => {
    const anilistOnly = title({ anilistId: 154587 });
    expect(canRequestAnime(anilistOnly)).toBe(false);
    expect(animeRequestTarget(anilistOnly)).toBeUndefined();
    expect(animeRequestBlockedReason(anilistOnly)).toContain("TMDB id");
  });

  it("requests an anime as a tv request once a TMDB id is known", () => {
    const matched = title({ anilistId: 154587, tmdbId: 209867, tmdbMediaType: "tv", totalEpisodes: 28 });
    expect(animeRequestTarget(matched)).toEqual({ tmdbId: 209867, mediaType: "tv" });
    expect(animeRequestBlockedReason(matched)).toBeUndefined();
  });

  it("keeps an anime film a movie request", () => {
    const film = title({ tmdbId: 12345, tmdbMediaType: "movie", totalEpisodes: 1, seasons: [] });
    expect(animeRequestTarget(film)).toEqual({ tmdbId: 12345, mediaType: "movie" });
  });
});

describe("Plex availability is unchanged", () => {
  it("matches an anime with no TMDB id on title and year, as it always did", () => {
    const anime = title({ title: "Frieren: Beyond Journey's End", anilistId: 154587, year: 2023 });
    expect(
      confirmsMatch(anime, {
        ratingKey: "1",
        librarySectionID: "2",
        title: "Frieren – Beyond Journey's End",
        year: 2023,
        type: "show",
        guids: ["tvdb://424536"],
      }),
    ).toBe(true);
    expect(normalizeTitle("Frieren – Beyond Journey's End")).toBe(
      normalizeTitle("Frieren: Beyond Journey's End"),
    );
  });

  it("still rejects a Plex item that names a different TMDB id", () => {
    const matched = title({ title: "Frieren", tmdbId: 209867 });
    expect(
      confirmsMatch(matched, {
        ratingKey: "2",
        librarySectionID: "2",
        title: "Frieren",
        year: 2023,
        type: "show",
        guids: ["tmdb://11111"],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The modal's pure parts
// ---------------------------------------------------------------------------

describe("add-flow presentation", () => {
  it("picks an anime type, preferring one the user made", () => {
    const base = { ...settings({ typeApiMapping: { Donghua: "anime" } }), lastAddedType: "" };
    const types = [{ name: "Movie" }, { name: "Anime" }, { name: "Donghua" }];
    expect(animeTypeFor({ ...base, types })).toBe("Anime");
    expect(animeTypeFor({ ...base, types, lastAddedType: "Donghua" })).toBe("Donghua");
    // The last-used type is only honoured when it is an anime type at all.
    expect(animeTypeFor({ ...base, types, lastAddedType: "Movie" })).toBe("Anime");
    // No anime type configured: a title still has to be something.
    expect(animeTypeFor({ ...settings(), lastAddedType: "", types: [{ name: "Movie" }] })).toBe("Movie");
  });

  it("describes a row by format and cour, not by movie-or-TV", () => {
    const entry = entryFromAniListSearch({
      id: 154587,
      title: { romaji: "Sousou no Frieren", english: "Frieren", native: "" },
      format: "TV",
      status: "FINISHED",
      seasonYear: 2023,
      episodes: 28,
      coverUrl: "",
      description: "",
      genres: [],
      averageScore: 89,
    });
    expect(metaLineFor({ ...entry, season: "fall" })).toBe("TV · Fall 2023 · 28 eps · ★ 8.9");
    expect(metaLineFor({ ...entry, status: "RELEASING", season: undefined })).toContain("airing");
  });

  it("hands the shared renderer a result it understands", () => {
    const entry = entryFromAniList(media({ id: 201514, seasonYear: 2026 }));
    const view = resultViewFor(entry);
    expect(view).toMatchObject({ tmdbId: 0, mediaType: "tv", title: "Rich Girl Caretaker", year: 2026 });
  });
});
