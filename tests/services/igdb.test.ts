/**
 * The IGDB client — fixtures only, never the network.
 *
 * Four things about IGDB decide whether this client works at all
 * (`docs/research/report-media-apis.md` §3.1), and each of them is a test here:
 * the Twitch client-credentials token and its ~60-day cache, the Apicalypse
 * query travelling in the POST **body**, the exact header capitalisation, and
 * the 4 req/s limit that answers 429.
 */
import { describe, expect, it } from "vitest";
import { createFakeHttp, createTestClock } from "../mocks/http";
import {
  createIgdbClient,
  escapeApicalypse,
  igdbCoverUrl,
  mapIgdbGame,
  unixSecondsToDate,
  type IgdbTokenCache,
} from "../../src/services/igdb";
import { createRateLimiter } from "../../src/services/ratelimit";

const TOKEN = { access_token: "access12345token", expires_in: 5_587_808, token_type: "bearer" };

const HADES = {
  id: 113112,
  name: "Hades",
  summary: "A rogue-like dungeon crawler.",
  first_release_date: 1600300800,
  total_rating: 89.4,
  cover: { image_id: "co2i0i" },
  platforms: [{ name: "PC (Microsoft Windows)" }, { name: "Nintendo Switch" }],
  genres: [{ name: "Role-playing (RPG)" }, { name: "Indie" }],
  involved_companies: [
    { developer: true, publisher: false, company: { name: "Supergiant Games" } },
    { developer: false, publisher: true, company: { name: "Supergiant Publishing" } },
  ],
};

interface ClientOptions {
  routes: Parameters<typeof createFakeHttp>[0];
  credentials?: { clientId: string; clientSecret: string };
  token?: IgdbTokenCache;
  now?: number;
}

function build(options: ClientOptions) {
  const fake = createFakeHttp(options.routes);
  const clock = createTestClock(options.now ?? 1_000_000);
  const sleeps: number[] = [];
  let stored: IgdbTokenCache | null = options.token ?? null;
  const client = createIgdbClient({
    credentials: () =>
      options.credentials ?? { clientId: "client-id", clientSecret: "client-secret" },
    http: fake.http,
    // No gap: the tests are about behaviour, not about waiting.
    limiter: createRateLimiter(0),
    now: () => clock.clock.now(),
    readToken: () => stored ?? undefined,
    writeToken: (token) => {
      stored = token;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, fake, sleeps, token: (): IgdbTokenCache | null => stored, clock };
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe("mapping an IGDB row", () => {
  it("reads the fields the add flow needs", () => {
    const mapped = mapIgdbGame(HADES);
    expect(mapped).toMatchObject({
      id: "113112",
      source: "igdb",
      title: "Hades",
      platforms: ["PC (Microsoft Windows)", "Nintendo Switch"],
      genres: ["Role-playing (RPG)", "Indie"],
      developer: "Supergiant Games",
      publisher: "Supergiant Publishing",
      firstReleaseDate: 1600300800,
    });
    // IGDB rates out of 100; a game record stores 0–10.
    expect(mapped.rating).toBeCloseTo(8.9, 5);
  });

  it("composes the cover URL from the image id, not the thumbnail URL", () => {
    expect(mapIgdbGame(HADES).coverUrl).toBe(
      "https://images.igdb.com/igdb/image/upload/t_cover_big/co2i0i.jpg",
    );
    expect(igdbCoverUrl("")).toBe("");
  });

  it("survives a row with nothing but an id", () => {
    const mapped = mapIgdbGame({ id: 7 });
    expect(mapped).toEqual({
      id: "7",
      source: "igdb",
      title: "",
      summary: "",
      coverUrl: "",
      platforms: [],
      genres: [],
    });
  });

  it("converts IGDB's Unix seconds to a calendar date", () => {
    expect(unixSecondsToDate(1600300800)).toBe("2020-09-17");
    expect(unixSecondsToDate(undefined)).toBeNull();
  });

  it("escapes a search term so a quote cannot end the clause", () => {
    expect(escapeApicalypse('Sam & Max "Hit the Road"')).toBe('Sam & Max \\"Hit the Road\\"');
    expect(escapeApicalypse("line\nbreak")).toBe("line break");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("the Twitch token", () => {
  it("is minted once and reused for every later call", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [HADES] } },
    });

    await client.search("hades");
    await client.search("hades again");

    const tokenCalls = fake.urls.filter((url) => url.includes("id.twitch.tv"));
    expect(tokenCalls).toHaveLength(1);
    // …and the grant is the client-credentials one, in the query string.
    expect(tokenCalls[0]).toContain("grant_type=client_credentials");
    expect(tokenCalls[0]).toContain("client_id=client-id");
    expect(fake.calls[0]?.method).toBe("POST");
  });

  it("persists the token with a safety margin, not the raw expiry", async () => {
    const { client, token } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [] } },
      now: 1_000_000,
    });
    await client.search("hades");
    const cached = token();
    // 5,587,808 s minus the 60 s margin, in ms, from the injected clock.
    expect(cached?.accessToken).toBe("access12345token");
    expect(cached?.expiresAt).toBe(1_000_000 + 5_587_808_000 - 60_000);
  });

  it("reuses a token another session persisted, without asking Twitch", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [HADES] } },
      token: { accessToken: "from-last-week", expiresAt: 9_000_000 },
      now: 1_000_000,
    });
    await client.search("hades");
    expect(fake.urls.some((url) => url.includes("id.twitch.tv"))).toBe(false);
    expect(fake.calls[0]?.headers?.["Authorization"]).toBe("Bearer from-last-week");
  });

  it("re-mints an expired token", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [] } },
      token: { accessToken: "stale", expiresAt: 500 },
      now: 1_000_000,
    });
    await client.search("hades");
    expect(fake.urls.some((url) => url.includes("id.twitch.tv"))).toBe(true);
  });

  it("refreshes once on a 401 and retries the query", async () => {
    // The case a clock-based cache alone cannot handle: the token was revoked,
    // or minted by another machine, and IGDB says so mid-session.
    let igdbCalls = 0;
    const { client, fake } = build({
      routes: {
        "id.twitch.tv": { body: TOKEN },
        "api.igdb.com": () => {
          igdbCalls += 1;
          return igdbCalls === 1 ? { status: 401, body: { message: "Unauthorized" } } : { body: [HADES] };
        },
      },
      token: { accessToken: "revoked", expiresAt: 9_000_000 },
      now: 1_000_000,
    });

    const results = await client.search("hades");
    expect(results).toHaveLength(1);
    expect(igdbCalls).toBe(2);
    expect(fake.urls.filter((url) => url.includes("id.twitch.tv"))).toHaveLength(1);
  });

  it("gives up after one refresh rather than looping on a bad secret", async () => {
    const { client } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { status: 401, body: {} } },
    });
    await expect(client.search("hades")).rejects.toMatchObject({ reason: "auth" });
  });

  it("refuses to call anything without credentials", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN } },
      credentials: { clientId: "", clientSecret: "" },
    });
    expect(client.configured()).toBe(false);
    await expect(client.search("hades")).rejects.toMatchObject({ reason: "no-key" });
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("searching", () => {
  it("sends Apicalypse in the body with the exact headers IGDB documents", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [HADES] } },
    });
    await client.search("halo", 5);

    const call = fake.calls.find((entry) => entry.url.includes("api.igdb.com"));
    expect(call?.url).toBe("https://api.igdb.com/v4/games");
    expect(call?.method).toBe("POST");
    // Capitalisation is load-bearing, and "Bearer " is hard-coded in front.
    expect(call?.headers?.["Client-ID"]).toBe("client-id");
    expect(call?.headers?.["Authorization"]).toBe("Bearer access12345token");
    // The query is the body, not the URL.
    expect(call?.body).toContain('search "halo";');
    expect(call?.body).toContain("limit 5;");
    expect(call?.body).toContain("cover.image_id");
    // Deluxe/GOTY re-releases would otherwise fill the first page.
    expect(call?.body).toContain("where version_parent = null;");
  });

  it("clamps a silly limit and skips an empty term", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [] } },
    });
    expect(await client.search("   ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    await client.search("halo", 5000);
    expect(fake.calls.find((entry) => entry.url.includes("igdb"))?.body).toContain("limit 50;");
  });

  it("looks a game up by id", async () => {
    const { client, fake } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [HADES] } },
    });
    const details = await client.details("113112");
    expect(details?.title).toBe("Hades");
    expect(fake.calls.find((entry) => entry.url.includes("igdb"))?.body).toContain("where id = 113112;");

    // A non-numeric id is a bug upstream, not a request to make.
    expect(await client.details("not-a-number")).toBeUndefined();
  });

  it("survives a payload that is not the array IGDB promised", async () => {
    const { client } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: { message: "oops" } } },
    });
    expect(await client.search("hades")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("429 handling", () => {
  it("waits once and retries, because one pause beats an error message", async () => {
    let calls = 0;
    const { client, sleeps } = build({
      routes: {
        "id.twitch.tv": { body: TOKEN },
        "api.igdb.com": () => {
          calls += 1;
          return calls === 1 ? { status: 429, body: { message: "Too Many Requests" } } : { body: [HADES] };
        },
      },
    });

    const results = await client.search("hades");
    expect(results).toHaveLength(1);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1100]);
  });

  it("reports a persistent 429 as rate-limited rather than retrying forever", async () => {
    const { client, sleeps } = build({
      routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { status: 429, body: {} } },
    });
    await expect(client.search("hades")).rejects.toMatchObject({
      reason: "rate-limited",
      source: "igdb",
    });
    expect(sleeps).toHaveLength(1);
  });

  it("keeps requests at least 250 ms apart, which is IGDB's 4 req/s", async () => {
    const { clock, sleeps } = createTestClock(0);
    const fake = createFakeHttp({ "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [] } });
    const client = createIgdbClient({
      credentials: () => ({ clientId: "a", clientSecret: "b" }),
      http: fake.http,
      limiter: createRateLimiter(250, clock),
      sleep: async () => undefined,
    });

    await client.search("a");
    await client.search("b");
    await client.search("c");

    // The token call plus three searches: every gap the limiter waited out is
    // the documented one, and it waited for each of them.
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sleeps.every((ms) => ms <= 250)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

describe("the settings Test button", () => {
  it("says what happened, in a sentence", async () => {
    const ok = build({ routes: { "id.twitch.tv": { body: TOKEN }, "api.igdb.com": { body: [] } } });
    expect(await ok.client.testConnection()).toEqual({
      ok: true,
      message: "IGDB answered. Search is live.",
    });

    const bad = build({
      routes: { "id.twitch.tv": { status: 403, body: { message: "invalid client" } }, "api.igdb.com": { body: [] } },
    });
    const result = await bad.client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Twitch rejected");

    const unset = build({
      routes: { "id.twitch.tv": { body: TOKEN } },
      credentials: { clientId: "", clientSecret: "" },
    });
    expect(await unset.client.testConnection()).toEqual({
      ok: false,
      message: "Add a Twitch client ID and secret first.",
    });
  });
});
