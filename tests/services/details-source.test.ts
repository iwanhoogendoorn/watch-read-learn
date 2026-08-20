/**
 * The composed details lookup, after the provider flip.
 *
 * This file used to test the runtime top-up — Overseerr-primary asking TMDB
 * for the one field Overseerr strips. The user's "make this not dependent on
 * the home lab server" flipped the providers, which made the top-up's case
 * impossible: a TMDB-primary document carries the runtime natively, and the
 * only Overseerr-primary vault left is one with no TMDB token, which has no
 * TMDB to top up from either. What is worth pinning now is the flip itself.
 */
import { describe, expect, it, vi } from "vitest";
import { createDetailsSource } from "../../src/services/details";
import { ApiError } from "../../src/services/http";
import type { OverseerrDetails } from "../../src/types";

const doc = (over: Partial<OverseerrDetails>) =>
  ({ tmdbId: 108978, mediaType: "tv", title: "Reacher", runtime: 44, ...over } as OverseerrDetails);

describe("with a TMDB token", () => {
  it("answers from TMDB with the runtime already on board — the Reacher case, natively", async () => {
    const overseerr = { configured: () => true, details: vi.fn() };
    const details = createDetailsSource({
      overseerr,
      tmdb: { configured: () => true, details: async () => doc({ runtime: 44 }) },
    });
    expect((await details(108978, "tv")).runtime).toBe(44);
    expect(overseerr.details).not.toHaveBeenCalled();
  });

  it("keeps everything Overseerr alone knows when the FALLBACK answers", async () => {
    // The one path where Overseerr still speaks: TMDB itself failed. Its
    // document must come through whole — mediaInfo included, nothing rebuilt.
    const full = doc({ runtime: 0 });
    (full as { mediaInfo?: unknown }).mediaInfo = { status: 5, ratingKey: "r1" };
    const details = createDetailsSource({
      overseerr: { configured: () => true, details: async () => full },
      tmdb: {
        configured: () => true,
        details: async () => {
          throw new ApiError({ source: "tmdb", reason: "timeout", url: "x", detail: "t" });
        },
      },
    });
    expect(await details(108978, "tv")).toBe(full);
  });
});

describe("with only Overseerr", () => {
  it("answers whole, and fails honestly", async () => {
    const full = doc({});
    const ok = createDetailsSource({
      overseerr: { configured: () => true, details: async () => full },
      tmdb: { configured: () => false, details: vi.fn() },
    });
    expect(await ok(108978, "tv")).toBe(full);

    const dead = createDetailsSource({
      overseerr: {
        configured: () => true,
        details: async () => {
          throw new ApiError({ source: "overseerr", reason: "timeout", url: "x", detail: "t" });
        },
      },
      tmdb: { configured: () => false, details: vi.fn() },
    });
    await expect(dead(108978, "tv")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("with nothing configured", () => {
  it("throws an ApiError rather than pretending", async () => {
    const details = createDetailsSource({
      overseerr: { configured: () => false, details: vi.fn() },
      tmdb: { configured: () => false, details: vi.fn() },
    });
    await expect(details(1, "movie")).rejects.toBeInstanceOf(ApiError);
  });
});
