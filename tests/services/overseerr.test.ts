import { describe, expect, it } from "vitest";
import {
  createOverseerrClient,
  describeMediaStatus,
  describeRequestStatus,
  has4kSignal,
  isRequestInFlight,
  type OverseerrConfig,
} from "../../src/services/overseerr";
import { MediaRequestStatus, MediaStatus, type OverseerrClient } from "../../src/types";
import { createFakeHttp, type FakeRoute } from "../mocks/http";
import * as fx from "../fixtures/overseerr";

const CONFIG: OverseerrConfig = { url: "http://192.168.1.10:5055", apiKey: "test-key" };

function client(routes: Record<string, FakeRoute>, config: OverseerrConfig = CONFIG) {
  const fake = createFakeHttp(routes);
  return { fake, api: createOverseerrClient(() => config, { http: fake.http }) as OverseerrClient };
}

describe("the two status enums", () => {
  it("never shares a formatter — status 5 means two different things", () => {
    expect(describeRequestStatus(5)).toBe("Completed");
    expect(describeMediaStatus(5)).toBe("Available");
    expect(describeRequestStatus(MediaRequestStatus.PENDING)).toBe("Pending approval");
    expect(describeMediaStatus(MediaStatus.PENDING)).toBe("Requested");
    expect(describeRequestStatus(4)).toBe("Failed");
    expect(describeMediaStatus(4)).toBe("Partially available");
  });

  it("handles MediaStatus.DELETED without requiring it", () => {
    expect(describeMediaStatus(6)).toBe("Removed");
    expect(describeMediaStatus(99)).toBe("Unknown");
  });

  it("knows which requests are still moving", () => {
    expect(isRequestInFlight(MediaRequestStatus.PENDING)).toBe(true);
    expect(isRequestInFlight(MediaRequestStatus.APPROVED)).toBe(true);
    expect(isRequestInFlight(MediaRequestStatus.COMPLETED)).toBe(false);
    expect(isRequestInFlight(undefined)).toBe(false);
  });

  it("treats status4k: UNKNOWN as noise, not as 'missing in 4K'", () => {
    expect(has4kSignal({ id: 1, mediaType: "tv", tmdbId: 1, status: 5, status4k: 1 })).toBe(false);
    expect(has4kSignal({ id: 1, mediaType: "tv", tmdbId: 1, status: 5, status4k: 5 })).toBe(true);
    expect(has4kSignal(undefined)).toBe(false);
  });
});

describe("configured / auth", () => {
  it("needs both a URL and a key", () => {
    const { api } = client({}, { url: "http://x:5055", apiKey: "" });
    expect(api.configured()).toBe(false);
  });

  it("refuses to call out when unconfigured, with a `no-key` reason", async () => {
    const { api, fake } = client({}, { url: "", apiKey: "" });
    await expect(api.search("anything")).rejects.toMatchObject({ reason: "no-key" });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the key as an X-Api-Key header on the /api/v1 base", async () => {
    const { api, fake } = client({ "/search": { body: fx.searchResponse } });
    await api.search("mulan");
    expect(fake.calls[0]?.headers).toMatchObject({ "X-Api-Key": "test-key" });
    expect(fake.calls[0]?.url).toContain("/api/v1/search?query=mulan");
  });

  it("reports the version and user on a good connection", async () => {
    const { api } = client({
      "/status": { body: fx.statusResponse },
      "/auth/me": { body: fx.authMeResponse },
    });
    const info = await api.testConnection();
    expect(info).toMatchObject({ ok: true, version: "1.33.2", user: "iwan" });
  });

  it("fails the connection test when the key is rejected, even though /status was fine", async () => {
    const { api } = client({
      "/status": { body: fx.statusResponse },
      "/auth/me": { status: 403, body: { message: "forbidden" } },
    });
    const info = await api.testConnection();
    expect(info.ok).toBe(false);
    expect(info.message).toContain("API key");
  });
});

describe("search", () => {
  it("drops person results and normalises movie and tv into one shape", async () => {
    const { api } = client({ "/search": { body: fx.searchResponse } });
    const results = await api.search("mulan");

    expect(results.map((r) => r.tmdbId)).toEqual([337401, 1399]);

    const movie = results[0];
    expect(movie).toMatchObject({
      mediaType: "movie",
      title: "Mulan",
      year: 2020,
      releaseDate: "2020-09-04",
      voteAverage: 7,
    });
    expect(movie?.posterUrl).toBe("https://image.tmdb.org/t/p/w342/aKx1ARwG55zZ0GpRvU2WrGrCG9o.jpg");

    // TV carries `name`/`firstAirDate` instead — same normalised fields out.
    expect(results[1]).toMatchObject({ mediaType: "tv", title: "Game of Thrones", year: 2011 });
  });

  it("keeps an absent mediaInfo absent — that is not UNKNOWN", async () => {
    const { api } = client({ "/search": { body: fx.searchResponse } });
    const [movie, tv] = await api.search("mulan");
    expect(movie?.mediaInfo).toBeUndefined();
    expect(tv?.mediaInfo).toMatchObject({ status: 4, ratingKey: "3846", tvdbId: 121361 });
  });

  it("short-circuits an empty query without a request", async () => {
    const { api, fake } = client({});
    expect(await api.search("   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("details", () => {
  it("normalises a TV payload including seasons, credits and the next episode", async () => {
    const { api, fake } = client({ "/tv/136311": { body: fx.tvDetailsShrinking } });
    const details = await api.details(136311, "tv");

    expect(fake.calls[0]?.url).toContain("/api/v1/tv/136311");
    expect(details).toMatchObject({
      tmdbId: 136311,
      mediaType: "tv",
      title: "Shrinking",
      showStatus: "Returning Series",
      inProduction: true,
      numberOfSeasons: 3,
      numberOfEpisodes: 34,
      imdbId: "tt15677150",
      genres: ["Comedy", "Drama"],
      director: ["James Ponsoldt"],
      studio: ["Apple TV+"],
    });
    expect(details.cast).toEqual(["Jason Segel", "Harrison Ford", "Jessica Williams"]);
    expect(details.nextEpisodeToAir).toEqual({
      seasonNumber: 3,
      episodeNumber: 8,
      airDate: "2026-08-10",
      name: "The Last Session",
    });
  });

  it("drops season 0 from the season list", async () => {
    const { api } = client({ "/tv/136311": { body: fx.tvDetailsShrinking } });
    const details = await api.details(136311, "tv");
    expect(details.seasons?.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
  });

  it("uses the modal episode runtime for TV and the plain runtime for film", async () => {
    const tv = client({ "/tv/136311": { body: fx.tvDetailsShrinking } });
    // episodeRunTime [30, 30, 38] → 30
    expect((await tv.api.details(136311, "tv")).runtime).toBe(30);

    const movie = client({ "/movie/1064213": { body: fx.movieDetailsAnora } });
    expect((await movie.api.details(1064213, "movie")).runtime).toBe(139);
  });

  it("nextEpisodeToAir stays null for an ended show — the 'is it returning' signal", async () => {
    const { api } = client({ "/tv/1399": { body: fx.tvDetailsEnded } });
    const details = await api.details(1399, "tv");
    expect(details.nextEpisodeToAir).toBeNull();
    expect(details.lastEpisodeToAir).toMatchObject({ seasonNumber: 8, episodeNumber: 6 });
    expect(details.showStatus).toBe("Ended");
  });

  it("picks the official YouTube trailer over the teaser and over a Vimeo upload", async () => {
    const { api } = client({ "/tv/136311": { body: fx.tvDetailsShrinking } });
    expect((await api.details(136311, "tv")).trailerUrl).toBe(
      "https://www.youtube.com/watch?v=TRAILERKEY",
    );
  });

  it("dedupes a crew member credited twice and reads production companies", async () => {
    const { api } = client({ "/movie/1064213": { body: fx.movieDetailsAnora } });
    const details = await api.details(1064213, "movie");
    expect(details.director).toEqual(["Sean Baker"]);
    expect(details.studio).toEqual(["FilmNation Entertainment", "Cre Film"]);
    expect(details.mediaInfo).toBeUndefined();
    // Movies have no TV-only fields at all.
    expect(details.showStatus).toBeUndefined();
    expect(details.nextEpisodeToAir).toBeUndefined();
  });

  it("carries the download queue through for the progress bar", async () => {
    const { api } = client({ "/tv/136311": { body: fx.tvDetailsShrinking } });
    const details = await api.details(136311, "tv");
    expect(details.mediaInfo?.downloadStatus?.[0]).toMatchObject({
      sizeLeft: 500_000_000,
      status: "downloading",
    });
  });
});

describe("request", () => {
  it("posts a movie by TMDB id and reports what was created", async () => {
    const { api, fake } = client({ "/request": { status: 201, body: fx.requestCreatedMovie } });
    const outcome = await api.request(550, "movie");

    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      json: { mediaType: "movie", mediaId: 550 },
    });
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") {
      expect(outcome.request).toMatchObject({ id: 123, status: 1, is4k: false, seasons: [] });
    }
  });

  it("never assumes the accepted seasons echo the request", async () => {
    const { api, fake } = client({ "/request": { status: 201, body: fx.requestCreatedTv } });
    const outcome = await api.request(136311, "tv", [1, 2, 3]);

    expect(fake.calls[0]?.json).toMatchObject({ mediaType: "tv", mediaId: 136311, seasons: [1, 2, 3] });
    // The server de-duplicated S1 away; we report what it actually took.
    if (outcome.kind === "created") expect(outcome.request.seasons).toEqual([2, 3]);
    else throw new Error(`expected created, got ${outcome.kind}`);
  });

  it("passes 'all' through for the server to expand", async () => {
    const { api, fake } = client({ "/request": { status: 201, body: fx.requestCreatedTv } });
    await api.request(136311, "tv", "all");
    expect(fake.calls[0]?.json).toMatchObject({ seasons: "all" });
  });

  it("ignores seasons for a movie", async () => {
    const { api, fake } = client({ "/request": { status: 201, body: fx.requestCreatedMovie } });
    await api.request(550, "movie", [1, 2]);
    expect(fake.calls[0]?.json).not.toHaveProperty("seasons");
  });

  it("treats 202 as 'nothing to request', not as success", async () => {
    const { api } = client({ "/request": { status: 202, body: fx.noSeasonsAvailable } });
    const outcome = await api.request(136311, "tv", [1]);
    expect(outcome.kind).toBe("nothing-to-request");
    if (outcome.kind === "nothing-to-request") {
      expect(outcome.message).toBe("No seasons available to request");
    }
  });

  it("adopts the pre-existing request behind a 409", async () => {
    const { api } = client({
      "/request": { status: 409, body: fx.duplicateRequest },
      "/tv/1399": { body: { id: 1399, mediaInfo: fx.mediaInfoGameOfThrones } },
    });
    const outcome = await api.request(1399, "tv", [2]);
    expect(outcome.kind).toBe("duplicate");
    if (outcome.kind === "duplicate") {
      expect(outcome.request).toMatchObject({ id: 77, status: 2, seasons: [2] });
      expect(outcome.message).toBe("Request for this media already exists");
    }
  });

  it("still reports a duplicate when the existing request cannot be resolved", async () => {
    const { api } = client({
      "/request": { status: 409, body: fx.duplicateRequest },
      "/tv/1399": { status: 500, body: { message: "boom" } },
    });
    const outcome = await api.request(1399, "tv");
    expect(outcome.kind).toBe("duplicate");
    if (outcome.kind === "duplicate") expect(outcome.request).toBeUndefined();
  });

  it("maps 403 to a denial with the server's own wording", async () => {
    const { api } = client({ "/request": { status: 403, body: fx.permissionDenied } });
    const outcome = await api.request(550, "movie");
    expect(outcome).toMatchObject({
      kind: "denied",
      message: "You do not have permission to make this request",
    });
  });

  it("throws when a 2xx comes back without a MediaRequest", async () => {
    const { api } = client({ "/request": { status: 201, body: { nothing: true } } });
    await expect(api.request(550, "movie")).rejects.toMatchObject({ reason: "parse" });
  });

  it("lets a 500 surface as a server error", async () => {
    const { api } = client({ "/request": { status: 500, body: { message: "kaboom" } } });
    await expect(api.request(550, "movie")).rejects.toMatchObject({ reason: "server" });
  });
});

describe("request status", () => {
  it("reads one request", async () => {
    const { api } = client({ "/request/123": { body: fx.requestCreatedMovie } });
    expect(await api.getRequest(123)).toMatchObject({ id: 123, status: 1 });
  });

  it("returns undefined for a request that no longer exists", async () => {
    const { api } = client({ "/request/999": { status: 404, body: { message: "Not found" } } });
    expect(await api.getRequest(999)).toBeUndefined();
  });

  it("reads the live counts for the settings chip", async () => {
    const { api } = client({ "/request/count": { body: fx.requestCountResponse } });
    expect(await api.requestCounts()).toEqual({
      pending: 2,
      approved: 1,
      processing: 1,
      available: 40,
      total: 44,
    });
  });
});
