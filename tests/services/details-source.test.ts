/**
 * The composed details lookup and its episode-runtime top-up.
 *
 * Overseerr strips `runtime` off the episode stub when it proxies TMDB — the
 * key is simply not in the response, so the fallback in `normalize.ts` has
 * nothing to read on a vault that has Overseerr configured. Measured live
 * against the real server: `overseerr.details(108978,'tv').runtime` is 0 while
 * `tmdb.details(108978,'tv').runtime` is 44.
 *
 * These tests count calls as well as checking values, because the whole risk in
 * a provider-preference change is spending requests you did not mean to spend.
 * No network: both clients are counting fakes.
 */
import { describe, expect, it, vi } from "vitest";
import { createDetailsSource, needsRuntimeTopUp } from "../../src/services/details";
import type { MediaType, OverseerrDetails } from "../../src/types";

function details(over: Partial<OverseerrDetails> = {}): OverseerrDetails {
  const base: OverseerrDetails = {
    tmdbId: 108978,
    mediaType: "tv",
    title: "Reacher",
    overview: "An ex-military policeman drifts into town.",
    posterUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
    backdropUrl: "",
    releaseDate: "2022-02-04",
    genres: ["Action"],
    runtime: 0,
    voteAverage: 8.1,
    voteCount: 3079,
    trailerUrl: "https://www.youtube.com/watch?v=GSycMV-_Csw",
    director: [],
    cast: ["Alan Ritchson"],
    studio: ["Prime Video"],
  };
  return { ...base, ...over };
}

/** A client that records what it was asked for. */
function fake(configured: boolean, answer: OverseerrDetails | Error) {
  const calls: { tmdbId: number; mediaType: MediaType }[] = [];
  return {
    calls,
    client: {
      configured: () => configured,
      details: async (tmdbId: number, mediaType: MediaType) => {
        calls.push({ tmdbId, mediaType });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

describe("needsRuntimeTopUp", () => {
  it("is true only for TV with nothing usable", () => {
    expect(needsRuntimeTopUp(details({ runtime: 0 }), "tv")).toBe(true);
    expect(needsRuntimeTopUp(details({ runtime: 44 }), "tv")).toBe(false);
    // A film's runtime is a top-level field Overseerr passes through untouched.
    expect(needsRuntimeTopUp(details({ runtime: 0, mediaType: "movie" }), "movie")).toBe(false);
    expect(needsRuntimeTopUp(details({ runtime: 139, mediaType: "movie" }), "movie")).toBe(false);
  });

  it("treats a NaN runtime as missing rather than storing it", () => {
    expect(needsRuntimeTopUp(details({ runtime: Number.NaN }), "tv")).toBe(true);
  });
});

describe("the runtime top-up", () => {
  it("fills a zero TV runtime from TMDB — the Reacher case", async () => {
    const ov = fake(true, details({ runtime: 0 }));
    const tm = fake(true, details({ runtime: 44 }));
    const source = createDetailsSource({ overseerr: ov.client, tmdb: tm.client });

    expect((await source(108978, "tv")).runtime).toBe(44);
    expect(ov.calls).toHaveLength(1);
    expect(tm.calls).toEqual([{ tmdbId: 108978, mediaType: "tv" }]);
  });

  it("keeps everything Overseerr alone knows — it tops up one field, not the payload", async () => {
    const mediaInfo = { id: 244, mediaType: "tv" as const, tmdbId: 108978, status: 4, status4k: 1 };
    const ov = fake(true, details({ runtime: 0, mediaInfo, cast: ["Alan Ritchson", "Maria Sten"] }));
    // TMDB's raw TV credits answer with the latest season's guests, not the
    // series regulars, so adopting its cast would be a downgrade.
    const tm = fake(true, details({ runtime: 44, cast: ["Alan Ritchson", "Agnez Mo"] }));

    const result = await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(108978, "tv");
    expect(result.runtime).toBe(44);
    expect(result.mediaInfo).toEqual(mediaInfo);
    expect(result.cast).toEqual(["Alan Ritchson", "Maria Sten"]);
    expect(result.voteCount).toBe(3079);
  });

  it("never overwrites a runtime the primary provider actually had", async () => {
    const ov = fake(true, details({ runtime: 30 }));
    const tm = fake(true, details({ runtime: 99 }));

    expect((await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(1, "tv")).runtime).toBe(30);
    expect(tm.calls).toHaveLength(0); // and it does not even ask
  });

  it("never fires for a film", async () => {
    const ov = fake(true, details({ runtime: 0, mediaType: "movie" }));
    const tm = fake(true, details({ runtime: 139 }));

    expect((await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(1064213, "movie")).runtime).toBe(0);
    expect(tm.calls).toHaveLength(0);
  });

  it("makes at most one extra request, and only to the other provider", async () => {
    const ov = fake(true, details({ runtime: 0 }));
    const tm = fake(true, details({ runtime: 0 }));
    const source = createDetailsSource({ overseerr: ov.client, tmdb: tm.client });

    // Even when TMDB also answers 0 — no retry, no second opinion on the second
    // opinion. One call each, then give up.
    expect((await source(213375, "tv")).runtime).toBe(0);
    expect(ov.calls).toHaveLength(1);
    expect(tm.calls).toHaveLength(1);
  });
});

describe("the top-up degrades silently", () => {
  it("does nothing when no TMDB token is configured", async () => {
    const ov = fake(true, details({ runtime: 0 }));
    const tm = fake(false, details({ runtime: 44 }));

    expect((await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(1, "tv")).runtime).toBe(0);
    expect(tm.calls).toHaveLength(0);
  });

  it("keeps the primary answer when the top-up throws, and never rethrows", async () => {
    const ov = fake(true, details({ runtime: 0, cast: ["Alan Ritchson"] }));
    const tm = fake(true, new Error("TMDB said 404"));
    const onTopUpFailed = vi.fn();

    const result = await createDetailsSource({
      overseerr: ov.client,
      tmdb: tm.client,
      onTopUpFailed,
    })(108978, "tv");

    // The refresh of this title still succeeds with everything else intact.
    expect(result.runtime).toBe(0);
    expect(result.cast).toEqual(["Alan Ritchson"]);
    expect(onTopUpFailed).toHaveBeenCalledTimes(1);
  });

  it("survives having no error handler at all", async () => {
    const ov = fake(true, details({ runtime: 0 }));
    const tm = fake(true, new Error("network down"));

    await expect(
      createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(1, "tv"),
    ).resolves.toMatchObject({ runtime: 0 });
  });

  it("still propagates a failure of the *primary* — that is a real refresh failure", async () => {
    const ov = fake(true, new Error("Overseerr unreachable"));
    const tm = fake(true, details({ runtime: 44 }));

    await expect(
      createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(1, "tv"),
    ).rejects.toThrow("Overseerr unreachable");
    expect(tm.calls).toHaveLength(0);
  });
});

describe("when TMDB is the primary", () => {
  it("asks TMDB once and does not top up its own answer", async () => {
    const ov = fake(false, details({ runtime: 99 }));
    // The fallback in normalize.ts already ran on this payload, so a 0 here
    // means TMDB genuinely has nothing — VisionQuest. Asking twice is pointless.
    const tm = fake(true, details({ runtime: 0 }));

    expect((await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(213375, "tv")).runtime).toBe(0);
    expect(ov.calls).toHaveLength(0);
    expect(tm.calls).toHaveLength(1);
  });

  it("passes a healthy TMDB runtime straight through", async () => {
    const ov = fake(false, details());
    const tm = fake(true, details({ runtime: 57 }));

    expect((await createDetailsSource({ overseerr: ov.client, tmdb: tm.client })(219971, "tv")).runtime).toBe(57);
    expect(tm.calls).toHaveLength(1);
  });
});
