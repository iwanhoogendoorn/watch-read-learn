/**
 * Jikan client (report §1.1).
 *
 * Jikan's failure modes are the interesting part. It is a MyAnimeList scraper,
 * so it has two completely different kinds of "no": a 429 that means *we* asked
 * too fast, and a `504 BadResponseException` that means MyAnimeList is down and
 * asking again in a second is pointless. Telling those apart — from bodies whose
 * `status` field is a string in one case and a number in the other — is what
 * this file pins.
 */
import { describe, expect, it } from "vitest";
import {
  createJikanClient,
  errorStatusOf,
  isUpstreamOutage,
  JIKAN_BASE,
  JIKAN_OUTAGE_BACKOFF_MS,
  JIKAN_WINDOW_MAX,
  normalizeJikanAnime,
  parseJikanDuration,
  preferredJikanTitle,
  scheduleFilterFor,
  type JikanConfig,
} from "../../src/services/jikan";
import { createRateLimiter } from "../../src/services/ratelimit";
import { createFakeHttp, createTestClock, type FakeRoute } from "../mocks/http";
import * as fx from "../fixtures/anime";

const ENABLED: JikanConfig = { enabled: true };

function client(routes: Record<string, FakeRoute>, config: JikanConfig = ENABLED) {
  const fake = createFakeHttp(routes);
  const test = createTestClock();
  const api = createJikanClient(() => config, {
    http: fake.http,
    clock: test.clock,
    limiter: createRateLimiter(0, test.clock),
  });
  return { fake, api, ...test };
}

describe("transport", () => {
  it("is keyless and hits the documented base", async () => {
    const { api, fake } = client({ "/anime": { body: fx.jikanSearchResponse() } });
    await api.search("frieren");
    expect(fake.calls[0]?.url.startsWith(`${JIKAN_BASE}/anime?`)).toBe(true);
    expect(fake.calls[0]?.url).not.toContain("key");
    expect(fake.calls[0]?.headers?.["Authorization"]).toBeUndefined();
  });

  it("refuses to call out when Jikan is not in play", async () => {
    const { api, fake } = client({ "/anime": { body: {} } }, { enabled: false });
    await expect(api.search("frieren")).rejects.toMatchObject({ reason: "not-enabled" });
    expect(fake.calls).toHaveLength(0);
  });

  it("passes /schedules its string booleans, not real ones", async () => {
    // `sfw` is a boolean on /anime and a string on /schedules. Report §1.1.4.
    const { api, fake } = client({ "/schedules": { body: fx.jikanSearchResponse([]) } });
    await api.schedules("Fridays");
    expect(fake.calls[0]?.url).toContain("filter=friday");
    expect(fake.calls[0]?.url).toContain("sfw=false");
  });
});

describe("error bodies", () => {
  it("coerces a status that is a string in one body and a number in another", () => {
    expect(errorStatusOf(fx.jikanRateLimitBody)).toBe(429);
    expect(errorStatusOf(fx.jikanOutageBody)).toBe(504);
  });

  it("treats a 504 BadResponseException as an upstream outage, not a rate limit", async () => {
    const { api } = client({ "/anime/1/full": { status: 504, body: fx.jikanOutageBody } });
    await expect(api.full(1)).rejects.toMatchObject({
      reason: "server",
      status: 504,
      retryAfterMs: JIKAN_OUTAGE_BACKOFF_MS,
    });
    expect(api.inOutage()).toBe(true);
  });

  it("recognises the outage from the body alone, whatever the status line says", () => {
    expect(isUpstreamOutage(200, "BadResponseException")).toBe(true);
    expect(isUpstreamOutage(504, "")).toBe(true);
    expect(isUpstreamOutage(429, "RateLimitException")).toBe(false);
  });

  it("stops calling during an outage instead of hammering a downed MyAnimeList", async () => {
    let calls = 0;
    const { api } = client({
      "/anime": () => {
        calls += 1;
        return { status: 504, body: fx.jikanOutageBody };
      },
    });

    await expect(api.full(52991)).rejects.toMatchObject({ status: 504 });
    await expect(api.full(60123)).rejects.toMatchObject({ status: 504 });
    await expect(api.search("frieren")).rejects.toMatchObject({ status: 504 });
    expect(calls).toBe(1);
  });

  it("serves stale cache through an outage rather than an error", async () => {
    let outage = false;
    const { api, advance } = client({
      "/anime/52991/full": () =>
        outage ? { status: 504, body: fx.jikanOutageBody } : { body: fx.jikanFullResponse() },
    });

    const fresh = await api.full(52991);
    expect(fresh.title).toBe("Frieren: Beyond Journey's End");

    // Past the details TTL, with MyAnimeList now down: the user asked about a
    // show, not about Jikan's upstream.
    outage = true;
    advance(7 * 60 * 60_000);
    const stale = await api.full(52991);
    expect(stale.title).toBe("Frieren: Beyond Journey's End");
  });

  it("backs off on a 429 whose status is the string '429'", async () => {
    let calls = 0;
    const { api } = client({
      "/anime": () => {
        calls += 1;
        return { status: 429, body: fx.jikanRateLimitBody };
      },
    });

    await expect(api.search("frieren")).rejects.toMatchObject({ reason: "rate-limited", status: 429 });
    await expect(api.search("bleach")).rejects.toMatchObject({ reason: "rate-limited" });
    // Jikan sends no Retry-After, so the client waits out a window on its own.
    expect(calls).toBe(1);
  });

  it("reports a missing entry as not-found, not as a server failure", async () => {
    const { api } = client({
      "/anime/99999/full": { status: 404, body: { status: 404, type: "BadRequestException", message: "Resource does not exist" } },
    });
    await expect(api.full(99999)).rejects.toMatchObject({ reason: "not-found", status: 404 });
  });
});

describe("rate limits", () => {
  it("never fits more than sixty requests into one minute", async () => {
    let calls = 0;
    const { api, clock, advance } = client({
      "/anime/": () => {
        calls += 1;
        return { body: fx.jikanFullResponse({ ...fx.jikanFrieren, mal_id: calls }) };
      },
    });

    const started = clock.now();
    for (let i = 1; i <= JIKAN_WINDOW_MAX; i += 1) {
      await api.full(i);
      advance(1); // distinct cache keys, no real time spent
    }
    expect(calls).toBe(JIKAN_WINDOW_MAX);
    expect(clock.now() - started).toBeLessThan(60_000);

    // The 61st has to wait for the window to roll.
    await api.full(JIKAN_WINDOW_MAX + 1);
    expect(clock.now() - started).toBeGreaterThanOrEqual(60_000);
  });

  it("caches, because there is no ETag to revalidate with", async () => {
    let calls = 0;
    const { api } = client({
      "/anime/52991/full": () => {
        calls += 1;
        return { body: fx.jikanFullResponse() };
      },
    });

    await api.full(52991);
    await api.full(52991);
    expect(calls).toBe(1);
  });
});

describe("normalisation", () => {
  it("reads titles[] and not the deprecated flat fields", () => {
    const raw = { titles: [{ type: "Default", title: "Sousou no Frieren" }, { type: "English", title: "Frieren" }], title: "WRONG", title_english: "ALSO WRONG" };
    expect(preferredJikanTitle(raw)).toBe("Frieren");

    // Falls back only when `titles[]` is missing entirely.
    expect(preferredJikanTitle({ title: "Only this" })).toBe("Only this");
  });

  it("maps the anime object onto the contract", () => {
    const anime = normalizeJikanAnime(fx.jikanFrieren as unknown as Record<string, unknown>);
    expect(anime).toMatchObject({
      malId: 52991,
      type: "TV",
      episodes: 28,
      status: "Finished Airing",
      airing: false,
      airedFrom: "2023-09-29",
      airedTo: "2024-03-22",
      score: 9.26,
      season: "fall",
      year: 2023,
      durationMinutes: 24,
      studios: ["Madhouse"],
    });
    // Plural English day and an IANA zone, exactly as reported — the conversion
    // is the caller's problem, and the client does not pretend otherwise.
    expect(anime.broadcast).toEqual({ day: "Fridays", time: "23:00", timezone: "Asia/Tokyo" });
  });

  it("keeps an unknown score as the zero Jikan reports, and dates it null", () => {
    const anime = normalizeJikanAnime(fx.jikanAiringShow as unknown as Record<string, unknown>);
    expect(anime.score).toBe(0);
    expect(anime.airedTo).toBeNull();
    expect(anime.airing).toBe(true);
  });

  it("parses the runtime out of Jikan's prose", () => {
    expect(parseJikanDuration("24 min per ep")).toBe(24);
    expect(parseJikanDuration("1 hr 41 min")).toBe(101);
    expect(parseJikanDuration("Unknown")).toBeUndefined();
  });

  it("turns a plural broadcast day into the singular schedule filter", () => {
    expect(scheduleFilterFor("Fridays")).toBe("friday");
    expect(scheduleFilterFor("Mondays")).toBe("monday");
    // Not a weekday: /schedules would 400 on it, so nothing is sent.
    expect(scheduleFilterFor("Unknown")).toBeUndefined();
    expect(scheduleFilterFor(null)).toBeUndefined();
  });
});
