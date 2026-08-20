/**
 * The add-box does not depend on the homelab.
 *
 * History, because the shape of this file is the story: search was handed the
 * Overseerr client bare, and the day the homelab was unreachable every search
 * sat out an 8-second timeout and died. A fallback-with-breaker came first;
 * then the user named the real requirement — "make this not dependent on the
 * home lab server" — and the providers flipped. Overseerr *proxies* TMDB, so
 * TMDB-first costs search nothing and removes the dependency outright; what
 * Overseerr alone knows (Plex state, requests) arrives later from background
 * refreshes that already tolerate the server being away.
 */
import { describe, expect, it, vi } from "vitest";
import { createDetailsSource, createProviderHealth, createSearchSource } from "../src/services/details";
import { ApiError } from "../src/services/http";
import type { OverseerrDetails, OverseerrSearchResult } from "../src/types";

const hit = (id: number, mediaType: "movie" | "tv", title: string) =>
  ({ tmdbId: id, mediaType, title } as unknown as OverseerrSearchResult);

const down = () =>
  new ApiError({ source: "overseerr", reason: "timeout", url: "http://x", detail: "timed out" });

function tmdbWith(movies: OverseerrSearchResult[], shows: OverseerrSearchResult[]) {
  return {
    configured: () => true,
    search: vi.fn(async (_q: string, type: string) => (type === "movie" ? movies : shows)),
  };
}

describe("search with a TMDB token", () => {
  it("never touches Overseerr at all — up, down or on fire", async () => {
    const overseerr = { configured: () => true, search: vi.fn() };
    const source = createSearchSource({
      overseerr,
      tmdb: tmdbWith([hit(1, "movie", "M1"), hit(2, "movie", "M2")], [hit(3, "tv", "S1")]),
    });
    const out = await source.search("neuromancer");
    expect(out.map((h) => (h as { title: string }).title)).toEqual(["M1", "S1", "M2"]);
    expect(overseerr.search).not.toHaveBeenCalled();
  });
});

describe("search with only Overseerr configured", () => {
  it("uses Overseerr and returns its answer untouched", async () => {
    const answer = [hit(1, "movie", "Neuromancer")];
    const source = createSearchSource({
      overseerr: { configured: () => true, search: async () => answer },
      tmdb: { configured: () => false, search: vi.fn() },
    });
    expect(await source.search("neuromancer")).toBe(answer);
  });

  it("surfaces the failure honestly — there is nothing to fall back to", async () => {
    const source = createSearchSource({
      overseerr: { configured: () => true, search: async () => { throw down(); } },
      tmdb: { configured: () => false, search: vi.fn() },
    });
    await expect(source.search("x")).rejects.toBeInstanceOf(ApiError);
  });

  it("answers empty, not throwing, when nothing is configured at all", async () => {
    const source = createSearchSource({
      overseerr: { configured: () => false, search: vi.fn() },
      tmdb: { configured: () => false, search: vi.fn() },
    });
    expect(await source.search("x")).toEqual([]);
  });
});

describe("details with a TMDB token", () => {
  const doc = (t: string) => ({ tmdbId: 9, mediaType: "tv", title: t } as unknown as OverseerrDetails);

  it("comes from TMDB, so a dead homelab cannot hang the click", async () => {
    const overseerr = { configured: () => true, details: vi.fn() };
    const details = createDetailsSource({
      overseerr,
      tmdb: { configured: () => true, details: async () => doc("Neuromancer") },
    });
    expect((await details(9, "tv")).title).toBe("Neuromancer");
    expect(overseerr.details).not.toHaveBeenCalled();
  });

  it("falls back to Overseerr when TMDB itself fails — the homelab is the backup now", async () => {
    const fell = vi.fn();
    const details = createDetailsSource({
      overseerr: { configured: () => true, details: async () => doc("from-overseerr") },
      tmdb: { configured: () => true, details: async () => { throw down(); } },
      onFallback: fell,
    });
    expect((await details(9, "tv")).title).toBe("from-overseerr");
    expect(fell).toHaveBeenCalledOnce();
  });

  it("does not mask our own bugs behind a provider switch", async () => {
    const details = createDetailsSource({
      overseerr: { configured: () => true, details: vi.fn() },
      tmdb: { configured: () => true, details: async () => { throw new TypeError("bug"); } },
    });
    await expect(details(1, "movie")).rejects.toThrow(TypeError);
  });
});

describe("details with only Overseerr configured", () => {
  it("still answers, and still surfaces a transport failure", async () => {
    const doc = { tmdbId: 1, mediaType: "movie", title: "M", runtime: 100 } as unknown as OverseerrDetails;
    const ok = createDetailsSource({
      overseerr: { configured: () => true, details: async () => doc },
      tmdb: { configured: () => false, details: vi.fn() },
    });
    expect(await ok(1, "movie")).toBe(doc);

    const dead = createDetailsSource({
      overseerr: { configured: () => true, details: async () => { throw down(); } },
      tmdb: { configured: () => false, details: vi.fn() },
    });
    await expect(dead(1, "movie")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("the shared health object", () => {
  it("remembers a failure for a minute, forgets on success", () => {
    let clock = 0;
    const health = createProviderHealth(() => clock);
    expect(health.avoid()).toBe(false);
    health.noteFailure();
    expect(health.avoid()).toBe(true);
    clock = 60_001;
    expect(health.avoid()).toBe(false);
    health.noteFailure();
    health.noteSuccess();
    expect(health.avoid()).toBe(false);
  });
});
