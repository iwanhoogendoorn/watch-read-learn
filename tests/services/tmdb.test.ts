import { describe, expect, it } from "vitest";
import { createTmdbClient, TMDB_API_BASE, type TmdbConfig } from "../../src/services/tmdb";
import { selectTrailer, normalizeVideos } from "../../src/services/normalize";
import { createFakeHttp, createTestClock, type FakeRoute } from "../mocks/http";
import * as fx from "../fixtures/tmdb";

const CONFIG: TmdbConfig = { token: "eyJhbGciOiJIUzI1NiJ9.fake" };

function client(routes: Record<string, FakeRoute>, config: TmdbConfig = CONFIG) {
  const fake = createFakeHttp(routes);
  const { clock } = createTestClock();
  return { fake, api: createTmdbClient(() => config, { http: fake.http, clock }) };
}

describe("configuration and auth", () => {
  it("is optional — no token means not configured", () => {
    expect(client({}, { token: "" }).api.configured()).toBe(false);
    expect(client({}).api.configured()).toBe(true);
  });

  it("refuses to call out without a token", async () => {
    const { api, fake } = client({}, { token: "" });
    await expect(api.details(550, "movie")).rejects.toMatchObject({ reason: "no-key" });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the v4 token as a Bearer header, never in the URL", async () => {
    const { api, fake } = client({ "/search/movie": { body: fx.searchMovieResponse } });
    await api.search("anora", "movie");
    expect(fake.calls[0]?.headers).toMatchObject({ Authorization: `Bearer ${CONFIG.token}` });
    expect(fake.calls[0]?.url).toContain(TMDB_API_BASE);
    expect(fake.calls[0]?.url).not.toContain("api_key");
  });

  it("reports a rejected token distinctly from an unreachable host", async () => {
    const rejected = client({ "/authentication": { status: 401, body: { status_message: "Invalid" } } });
    expect(await rejected.api.testConnection()).toMatchObject({ ok: false });
    expect((await rejected.api.testConnection()).message).toContain("v4 read access token");

    const ok = client({ "/authentication": { body: { success: true } } });
    expect(await ok.api.testConnection()).toMatchObject({ ok: true });
  });

  it("retries once after a 429 rather than giving up", async () => {
    let call = 0;
    const { api, fake } = client({
      "/search/movie": () => {
        call += 1;
        return call === 1 ? { status: 429, body: { status_message: "slow down" } } : { body: fx.searchMovieResponse };
      },
    });
    const results = await api.search("anora", "movie");
    expect(fake.calls).toHaveLength(2);
    expect(results[0]?.tmdbId).toBe(1064213);
  });
});

describe("search and details", () => {
  it("normalises snake_case into the same shape Overseerr produces", async () => {
    const { api } = client({ "/search/movie": { body: fx.searchMovieResponse } });
    const [result] = await api.search("anora", "movie");
    expect(result).toMatchObject({
      tmdbId: 1064213,
      mediaType: "movie",
      title: "Anora",
      year: 2024,
      releaseDate: "2024-10-17",
      voteAverage: 7.1,
      genreIds: [35, 18],
    });
    expect(result?.posterUrl).toBe("https://image.tmdb.org/t/p/w342/qh0FZUEbtpDL5F3bEjFm4nHUsHo.jpg");
  });

  it("collapses four round trips into one with append_to_response", async () => {
    const { api, fake } = client({ "/tv/1399": { body: fx.tvDetailsResponse } });
    await api.details(1399, "tv");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toContain("append_to_response=videos%2Cexternal_ids%2Ccredits");
  });

  it("reads TV airing fields, dropping specials and keeping a null next episode", async () => {
    const { api } = client({ "/tv/1399": { body: fx.tvDetailsResponse } });
    const details = await api.details(1399, "tv");
    expect(details).toMatchObject({
      title: "Game of Thrones",
      showStatus: "Ended",
      inProduction: false,
      numberOfSeasons: 8,
      numberOfEpisodes: 73,
      runtime: 60,
      imdbId: "tt0944947",
      studio: ["HBO"],
      director: ["David Nutter"],
    });
    expect(details.seasons?.map((s) => s.seasonNumber)).toEqual([1, 2]);
    expect(details.nextEpisodeToAir).toBeNull();
    expect(details.lastEpisodeToAir).toMatchObject({ seasonNumber: 8, episodeNumber: 6, airDate: "2019-05-19" });
  });

  it("asks for release_dates only on movies", async () => {
    const { api, fake } = client({ "/movie/550": { body: { id: 550, title: "Fight Club" } } });
    await api.details(550, "movie");
    expect(fake.calls[0]?.url).toContain("release_dates");
  });
});

describe("trailer selection (report §3.7)", () => {
  const videos = normalizeVideos(fx.videosResponse.results);

  it("prefers the official YouTube trailer over a bigger unofficial one", () => {
    expect(selectTrailer(videos)?.key).toBe("BdJKm16Co6M");
  });

  it("never picks a non-YouTube video, however good it looks", () => {
    expect(selectTrailer(videos)?.site).toBe("YouTube");
  });

  it("falls back to a teaser when no trailer exists", () => {
    const teasersOnly = videos.filter((v) => v.type === "Teaser");
    expect(selectTrailer(teasersOnly)?.key).toBe("TEASER");
  });

  it("rejects featurettes and behind-the-scenes outright", () => {
    const bts = videos.filter((v) => v.type === "Behind the Scenes");
    expect(selectTrailer(bts)).toBeUndefined();
  });

  it("breaks ties on resolution, then recency", () => {
    const sameRank = normalizeVideos([
      { key: "small", site: "YouTube", type: "Trailer", official: true, size: 720, published_at: "2024-01-01" },
      { key: "big", site: "YouTube", type: "Trailer", official: true, size: 2160, published_at: "2020-01-01" },
    ]);
    expect(selectTrailer(sameRank)?.key).toBe("big");

    const sameSize = normalizeVideos([
      { key: "old", site: "YouTube", type: "Trailer", official: true, size: 1080, published_at: "2020-01-01" },
      { key: "new", site: "YouTube", type: "Trailer", official: true, size: 1080, published_at: "2024-01-01" },
    ]);
    expect(selectTrailer(sameSize)?.key).toBe("new");
  });

  it("returns nothing rather than a sentinel when there is nothing to play", () => {
    expect(selectTrailer([])).toBeUndefined();
  });

  it("fetches /videos with the widened language filter", async () => {
    const { api, fake } = client({ "/videos": { body: fx.videosResponse } });
    const result = await api.videos(550, "movie");
    expect(fake.calls[0]?.url).toContain("include_video_language=en%2Cnull");
    expect(result).toHaveLength(5);
  });
});

describe("digital release dates (report §3.6)", () => {
  it("takes the earliest type >= 4 in the requested region", async () => {
    const { api } = client({ "/release_dates": { body: fx.releaseDatesResponse } });
    // NL has a TV date (type 6, 2000-04-01) and a Digital date (type 4,
    // 2000-05-01); the earliest of the gettable ones wins.
    expect(await api.digitalReleaseDate(550, "NL")).toBe("2000-04-01");
  });

  it("ignores theatrical dates entirely", async () => {
    const { api } = client({ "/release_dates": { body: fx.releaseDatesResponse } });
    // US has only theatrical (3) and physical (5) — physical still counts.
    expect(await api.digitalReleaseDate(550, "US")).toBe("2000-06-06");
  });

  it("returns undefined for a region TMDB has no data for", async () => {
    const { api } = client({ "/release_dates": { body: fx.releaseDatesResponse } });
    expect(await api.digitalReleaseDate(550, "JP")).toBeUndefined();
  });

  it("strips the meaningless time component off the ISO timestamp", async () => {
    const { api } = client({
      "/release_dates": {
        body: {
          id: 1,
          results: [
            {
              iso_3166_1: "NL",
              release_dates: [{ release_date: "2026-12-24T00:00:00.000Z", type: 4 }],
            },
          ],
        },
      },
    });
    expect(await api.digitalReleaseDate(1, "NL")).toBe("2026-12-24");
  });
});
