/**
 * TMDB id backfill (QA2 report 1a).
 *
 * The bar these tests defend: writing the *wrong* id is worse than writing
 * none, so anything short of a clear exact-name winner must come back
 * `ambiguous` and reach a human.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../../src/data/schema";
import {
  createMatchService,
  matchStateFor,
  needsMatchAttempt,
  needsTmdbBackfill,
  pickMatch,
  scoreHit,
  yearOfTitle,
} from "../../src/services/match";
import type { OverseerrClient, OverseerrSearchResult, TitleV4 } from "../../src/types";

const NOW = new Date(2026, 7, 3);

function show(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "dexter-resurrection",
    title: overrides.title ?? "Dexter: Resurrection",
    type: overrides.type ?? "TV Show",
    totalEpisodes: 10,
    ...overrides,
  });
}

function hit(overrides: Partial<OverseerrSearchResult> = {}): OverseerrSearchResult {
  return {
    tmdbId: 259909,
    mediaType: "tv",
    title: "Dexter: Resurrection",
    year: 2025,
    releaseDate: "2025-07-13",
    overview: "",
    posterUrl: "",
    voteAverage: 0,
    voteCount: 0,
    genreIds: [],
    ...overrides,
  };
}

/** An Overseerr client that answers `search` from a fixed list. */
function fakeClient(byQuery: Record<string, OverseerrSearchResult[]>, calls: string[] = []) {
  return {
    calls,
    client: {
      configured: () => true,
      search: async (query: string) => {
        calls.push(query);
        return byQuery[query] ?? [];
      },
    } as unknown as OverseerrClient,
  };
}

describe("scoring a provider hit", () => {
  it("takes the year from the title, then from its release date", () => {
    expect(yearOfTitle(show({ year: 2025 }))).toBe(2025);
    expect(yearOfTitle(show({ releaseDate: "2025-07-11" }))).toBe(2025);
    expect(yearOfTitle(show())).toBeUndefined();
  });

  it("ranks an exact name with the same year highest", () => {
    const title = show({ releaseDate: "2025-07-11" });
    expect(scoreHit(title, hit(), "tv")).toBe(100);
    // Same name, no year on either side: still an exact-name match.
    expect(scoreHit(show(), hit({ year: null }), "tv")).toBe(90);
  });

  it("disqualifies the wrong media type and a contradicting year", () => {
    const title = show({ releaseDate: "2025-07-11" });
    expect(scoreHit(title, hit({ mediaType: "movie" }), "tv")).toBe(-1);
    expect(scoreHit(title, hit({ year: 2013 }), "tv")).toBe(-1);
    // One year out is tolerated — providers disagree about release years.
    expect(scoreHit(title, hit({ year: 2026 }), "tv")).toBeGreaterThan(0);
  });

  it("treats a containment match as a candidate, never a verdict", () => {
    const title = show({ title: "Dexter", releaseDate: "2006-10-01" });
    const score = scoreHit(title, hit({ title: "Dexter: Original Sin", year: 2006 }), "tv");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(90);
  });
});

describe("picking a match", () => {
  it("adopts a single exact-name hit", () => {
    const outcome = pickMatch(show({ releaseDate: "2025-07-11" }), [
      hit({ tmdbId: 1405, title: "Dexter", year: 2006 }),
      hit(),
      hit({ tmdbId: 131927, title: "Dexter: New Blood", year: 2021 }),
    ]);
    expect(outcome).toEqual({ kind: "match", hit: expect.objectContaining({ tmdbId: 259909 }) });
  });

  it("refuses to guess between two hits of the same name and no year", () => {
    const outcome = pickMatch(show({ title: "The Office" }), [
      hit({ tmdbId: 2316, title: "The Office", year: null }),
      hit({ tmdbId: 2996, title: "The Office", year: null }),
    ]);
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.candidates.map((c) => c.tmdbId)).toEqual([2316, 2996]);
  });

  it("separates same-name hits by year when it has one", () => {
    const outcome = pickMatch(show({ title: "The Office", releaseDate: "2005-03-24" }), [
      hit({ tmdbId: 2316, title: "The Office", year: 2005 }),
      hit({ tmdbId: 2996, title: "The Office", year: 2001 }),
    ]);
    expect(outcome).toEqual({ kind: "match", hit: expect.objectContaining({ tmdbId: 2316 }) });
  });

  it("never turns a containment-only hit into a verdict", () => {
    const outcome = pickMatch(show({ title: "Dexter", releaseDate: "2006-10-01" }), [
      hit({ tmdbId: 219937, title: "Dexter: Original Sin", year: 2006 }),
    ]);
    expect(outcome.kind).toBe("ambiguous");
  });

  it("says nothing rather than something when the provider has no candidate", () => {
    expect(pickMatch(show(), []).kind).toBe("none");
    expect(pickMatch(show(), [hit({ mediaType: "movie" })]).kind).toBe("none");
  });

  it("keeps a movie a movie", () => {
    const movie = createTitle({ id: "spider-man", title: "Spider-Man", type: "Movie", releaseDate: "2002-05-01" });
    const outcome = pickMatch(movie, [
      hit({ tmdbId: 1, title: "Spider-Man", mediaType: "tv", year: 2003 }),
      hit({ tmdbId: 557, title: "Spider-Man", mediaType: "movie", year: 2002 }),
    ]);
    expect(outcome).toEqual({ kind: "match", hit: expect.objectContaining({ tmdbId: 557 }) });
  });
});

describe("the backfill pass", () => {
  it("only visits titles that have no id", async () => {
    const { client, calls } = fakeClient({ "Dexter: Resurrection 2025": [hit()] });
    const service = createMatchService({ overseerr: client, now: () => NOW });
    const results = await service.matchAll([
      show({ releaseDate: "2025-07-11" }),
      show({ id: "shrinking", title: "Shrinking", tmdbId: 136311 }),
    ]);

    expect(calls).toEqual(["Dexter: Resurrection 2025"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toEqual({
      kind: "match",
      hit: expect.objectContaining({ tmdbId: 259909 }),
    });
  });

  it("retries the bare name when the year-qualified query finds nothing", async () => {
    const { client, calls } = fakeClient({ "Dexter: Resurrection": [hit()] });
    const service = createMatchService({ overseerr: client, now: () => NOW });
    const [result] = await service.matchAll([show({ releaseDate: "2025-07-11" })]);

    expect(calls).toEqual(["Dexter: Resurrection 2025", "Dexter: Resurrection"]);
    expect(result?.outcome.kind).toBe("match");
  });

  it("respects the retry window, and `force` overrides it", async () => {
    const recent = show({
      tmdbMatch: { state: "unmatched", checkedAt: new Date(NOW.getTime() - 3600_000).toISOString() },
    });
    const stale = show({
      id: "stale",
      tmdbMatch: { state: "unmatched", checkedAt: new Date(NOW.getTime() - 48 * 3600_000).toISOString() },
    });

    expect(needsMatchAttempt(recent, NOW)).toBe(false);
    expect(needsMatchAttempt(stale, NOW)).toBe(true);
    expect(needsTmdbBackfill(recent)).toBe(true);

    const { client, calls } = fakeClient({});
    const service = createMatchService({ overseerr: client, now: () => NOW });
    await service.matchAll([recent, stale]);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    await service.matchAll([recent, stale], { force: true });
    expect(calls).toHaveLength(2);
  });

  it("reports a search failure as an error, not as 'unmatched'", async () => {
    const client = {
      configured: () => true,
      search: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as unknown as OverseerrClient;
    const service = createMatchService({ overseerr: client, now: () => NOW });
    const [result] = await service.matchAll([show()]);
    expect(result?.error).toBe("ECONNREFUSED");
  });

  it("records the shortlist an ambiguous outcome leaves behind", () => {
    const state = matchStateFor(
      { kind: "ambiguous", candidates: [hit({ tmdbId: 2316, title: "The Office", year: 2005 })] },
      "The Office",
      NOW.toISOString(),
    );
    expect(state).toEqual({
      state: "ambiguous",
      checkedAt: NOW.toISOString(),
      query: "The Office",
      candidates: [{ tmdbId: 2316, mediaType: "tv", title: "The Office", year: 2005 }],
    });
    expect(matchStateFor({ kind: "none" }, "Nope", NOW.toISOString()).state).toBe("unmatched");
  });
});
