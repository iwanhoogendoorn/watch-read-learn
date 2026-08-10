/**
 * AniList client (report §1.2).
 *
 * The three behaviours that are not obvious from the docs, and are therefore the
 * ones worth pinning: a 429 that arrives as a **GraphQL body** (sometimes on an
 * HTTP 200), a `timeUntilAiring` that must never be trusted, and a per-minute
 * budget that only survives because one request answers for fifty titles.
 */
import { describe, expect, it } from "vitest";
import {
  ANILIST_ENDPOINT,
  ANILIST_MIN_GAP_MS,
  createAniListClient,
  fuzzyDate,
  normalizeAniListMedia,
  stripHtml,
  type AniListConfig,
} from "../../src/services/anilist";
import { createRateLimiter } from "../../src/services/ratelimit";
import { createFakeHttp, createTestClock, type FakeResponse } from "../mocks/http";
import type { HttpRequestOptions } from "../../src/types";
import * as fx from "../fixtures/anime";

const ENABLED: AniListConfig = { enabled: true };

/** The GraphQL operation a request carries, so one route can serve them all. */
function operationOf(request: HttpRequestOptions): string {
  const query = String((request.json as { query?: string } | undefined)?.query ?? "");
  if (query.includes("airingSchedules")) return "airing";
  if (query.includes("id_in")) return "batch";
  if (query.includes("Media(id")) return "details";
  return "search";
}

function variablesOf(request: HttpRequestOptions): Record<string, unknown> {
  return ((request.json as { variables?: Record<string, unknown> } | undefined)?.variables ?? {});
}

function client(
  responder: (op: string, request: HttpRequestOptions) => FakeResponse,
  config: AniListConfig = ENABLED,
) {
  const fake = createFakeHttp({
    "graphql.anilist.co": (request) => responder(operationOf(request), request),
  });
  const { clock } = createTestClock();
  // A zero-gap limiter in tests: the gap is asserted separately, and every other
  // test would otherwise pay two seconds a call.
  const api = createAniListClient(() => config, {
    http: fake.http,
    clock,
    limiter: createRateLimiter(0, clock),
  });
  return { fake, api, clock };
}

describe("transport", () => {
  it("posts GraphQL to the single endpoint and needs no key", async () => {
    const { api, fake } = client(() => ({ body: fx.anilistSearchResponse() }));
    await api.search("frieren");
    expect(fake.calls[0]?.url).toBe(ANILIST_ENDPOINT);
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls[0]?.headers?.["Authorization"]).toBeUndefined();
    expect(api.configured()).toBe(true);
  });

  it("refuses to call out when anime routing is off", async () => {
    const { api, fake } = client(() => ({ body: {} }), { enabled: false });
    await expect(api.search("frieren")).rejects.toMatchObject({ reason: "not-enabled" });
    expect(fake.calls).toHaveLength(0);
  });

  it("paces itself at 30/min — one request every two seconds", () => {
    expect(ANILIST_MIN_GAP_MS).toBe(2000);
    expect(60_000 / ANILIST_MIN_GAP_MS).toBe(30);
  });
});

describe("rate limiting", () => {
  it("reads the 429 out of the GraphQL body, not only the status line", async () => {
    // Report §1.2: the body is `{data: null, errors: [{status: 429}]}` and it can
    // arrive on a 200. Checking `response.status` alone misses it entirely.
    const { api } = client(() => ({ status: 200, body: fx.anilistRateLimitBody }));
    await expect(api.search("frieren")).rejects.toMatchObject({
      reason: "rate-limited",
      status: 429,
    });
  });

  it("honours Retry-After and refuses to spend the wait sending more requests", async () => {
    let calls = 0;
    const { api, fake } = client(() => {
      calls += 1;
      return { status: 429, body: fx.anilistRateLimitBody, headers: { "retry-after": "45" } };
    });

    await expect(api.search("frieren")).rejects.toMatchObject({ retryAfterMs: 45_000 });
    // The second attempt never reaches the network: AniList said stop.
    await expect(api.details(154587)).rejects.toMatchObject({ reason: "rate-limited" });
    expect(calls).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("falls back to X-RateLimit-Reset when Retry-After is absent", async () => {
    const { api, clock } = client(() => ({
      status: 429,
      body: fx.anilistRateLimitBody,
      headers: { "x-ratelimit-reset": String(Math.floor(clock.now() / 1000) + 30) },
    }));
    await expect(api.search("frieren")).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("surfaces a non-429 GraphQL error with its own status", async () => {
    const { api } = client(() => ({ status: 200, body: fx.anilistNotFoundBody }));
    await expect(api.details(1)).rejects.toMatchObject({ reason: "not-found", status: 404 });
  });
});

describe("normalisation", () => {
  it("maps a media payload onto the contract", async () => {
    const { api } = client(() => ({ body: fx.anilistMediaResponse() }));
    const media = await api.detailsFull(154587);

    expect(media).toMatchObject({
      id: 154587,
      malId: 52991,
      status: "FINISHED",
      format: "TV",
      episodes: 28,
      duration: 24,
      seasonYear: 2023,
      startDate: "2023-09-29",
      endDate: "2024-03-22",
      studios: ["Madhouse"],
      genres: ["Adventure", "Drama", "Fantasy"],
      averageScore: 89,
    });
    expect(media.title.english).toBe("Frieren: Beyond Journey's End");
    expect(media.coverUrl).toContain("/xl/");
    expect(media.trailerUrl).toBe("https://www.youtube.com/watch?v=qsRWDkMWfMU");
    // The description arrives with `<br>` even at `asHtml: false`.
    expect(media.description).not.toContain("<br>");
    expect(media.description).toContain("The adventure is over");
  });

  it("keeps a partial fuzzy date and drops a yearless one", () => {
    expect(fuzzyDate({ year: 2027, month: null, day: null })).toBe("2027-01-01");
    expect(fuzzyDate({ year: null, month: 3, day: 2 })).toBeNull();
    expect(fuzzyDate(null)).toBeNull();
  });

  it("leaves unknown numbers absent rather than writing zeros", () => {
    const media = normalizeAniListMedia(fx.anilistUpcomingShow as unknown as Record<string, unknown>);
    expect(media.episodes).toBeUndefined();
    expect(media.duration).toBeUndefined();
    expect(media.averageScore).toBeUndefined();
    expect(media.malId).toBeUndefined();
    expect(media.nextAiring).toBeUndefined();
    expect(media.status).toBe("NOT_YET_RELEASED");
  });

  it("strips the markup AniList leaves in a plain-text description", () => {
    expect(stripHtml("a<br><br>b<i>c</i>")).toBe("a\n\nbc");
  });

  it("carries nextAiringEpisode through as an airing entry", async () => {
    const { api } = client(() => ({ body: fx.anilistMediaResponse(fx.anilistAiringShow) }));
    const media = await api.detailsFull(201514);
    expect(media.nextAiring).toEqual({ mediaId: 201514, episode: 5, airingAt: 1_785_016_800 });
  });
});

describe("airing schedules", () => {
  const NOW = 1_785_000_000;

  it("asks for airingAt and never for timeUntilAiring", async () => {
    const { api, fake } = client(() => ({ body: fx.anilistSchedulesResponse([]) }));
    await api.airingSchedules({ mediaIds: [201514], from: NOW, to: NOW + 86_400 });

    const query = String((fake.calls[0]?.json as { query: string }).query);
    expect(query).toContain("airingAt");
    // The whole reason: it is computed server-side and stale on arrival, so
    // caching it would cache a lie.
    expect(query).not.toContain("timeUntilAiring");
  });

  it("keeps past episodes — a negative countdown is data, not an error", async () => {
    const { api } = client(() => ({
      body: fx.anilistSchedulesResponse([
        { mediaId: 201514, episode: 4, airingAt: NOW - 765_340, timeUntilAiring: -765_340 },
        { mediaId: 201514, episode: 5, airingAt: NOW + 16_800, timeUntilAiring: 16_800 },
      ]),
    }));

    const schedules = await api.airingSchedules({ mediaIds: [201514] });
    expect(schedules).toEqual([
      { mediaId: 201514, episode: 4, airingAt: NOW - 765_340 },
      { mediaId: 201514, episode: 5, airingAt: NOW + 16_800 },
    ]);
    // `timeUntilAiring` was in the payload and is not in the result.
    expect(Object.keys(schedules[0] as object)).toEqual(["mediaId", "episode", "airingAt"]);
  });

  it("does not query at all when the id list is empty", async () => {
    const { api, fake } = client(() => ({ body: fx.anilistSchedulesResponse([]) }));
    expect(await api.airingSchedules({ mediaIds: [] })).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("drops a schedule row with no usable timestamp", async () => {
    const { api } = client(() => ({
      body: {
        data: {
          Page: {
            airingSchedules: [
              { mediaId: 201514, episode: 1, airingAt: null },
              { mediaId: 201514, episode: 2, airingAt: NOW },
            ],
          },
        },
      },
    }));
    expect(await api.airingSchedules({ mediaIds: [201514] })).toHaveLength(1);
  });
});

describe("batching and caching", () => {
  it("answers for fifty titles in one request", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => 1000 + i);
    const { api, fake } = client((op, request) => {
      expect(op).toBe("batch");
      const wanted = variablesOf(request)["ids"] as number[];
      return {
        body: {
          data: { Page: { media: wanted.map((id) => ({ ...fx.anilistFrieren, id, idMal: null })) } },
        },
      };
    });

    const media = await api.mediaBatch(ids);
    expect(media).toHaveLength(50);
    expect(fake.calls).toHaveLength(1);
  });

  it("splits past AniList's 50-per-page cap instead of silently truncating", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 1000 + i);
    const { api, fake } = client((_op, request) => {
      const wanted = variablesOf(request)["ids"] as number[];
      expect(wanted.length).toBeLessThanOrEqual(50);
      return {
        body: { data: { Page: { media: wanted.map((id) => ({ ...fx.anilistFrieren, id })) } } },
      };
    });

    expect(await api.mediaBatch(ids)).toHaveLength(120);
    expect(fake.calls).toHaveLength(3);
  });

  it("caches a repeated search — the budget is 30 requests a minute", async () => {
    let calls = 0;
    const { api } = client(() => {
      calls += 1;
      return { body: fx.anilistSearchResponse() };
    });

    await api.search("frieren");
    await api.search("Frieren");
    expect(calls).toBe(1);

    api.invalidate();
    await api.search("frieren");
    expect(calls).toBe(2);
  });

  it("never sends an empty search", async () => {
    const { api, fake } = client(() => ({ body: fx.anilistSearchResponse() }));
    expect(await api.search("   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
