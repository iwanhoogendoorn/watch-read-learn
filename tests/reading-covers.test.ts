/**
 * Cover fallback chain — Open Library first, Google's keyless CDN by ISBN
 * second, placeholder last.
 *
 * The scenario that motivated it: both of the user's real books are indexed by
 * Open Library *without* a cover, so the stored `b/isbn/…?default=false` URL
 * 404s forever, while Google has both covers. A Google miss is a 200 with a
 * PNG placeholder — only a JPEG answer counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGoogleCoverCache,
  coverIsbn,
  googleCoverUrl,
  loadCover,
  looksLikeJpeg,
} from "../src/domains/reading/covers";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer;

/** The bits of URL the module touches, without a DOM. */
function stubUrlGlobals(): void {
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:test-${(n += 1)}`,
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal("Blob", class {});
}

function img(): { src: string; classes: string[]; addClass(c: string): void } {
  return {
    src: "",
    classes: [],
    addClass(c: string) {
      this.classes.push(c);
    },
  };
}

/** Flush the promise chain inside loadCover. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clearGoogleCoverCache();
  stubUrlGlobals();
});

describe("coverIsbn", () => {
  it("prefers the entry's own isbn, dashes stripped", () => {
    expect(coverIsbn({ isbn: "978-1-4842-6707-3" })).toBe("9781484267073");
  });

  it("recovers the isbn embedded in a stored Open Library cover URL", () => {
    expect(
      coverIsbn({
        isbn: null,
        coverUrl: "https://covers.openlibrary.org/b/isbn/9781484267073-M.jpg?default=false",
      }),
    ).toBe("9781484267073");
  });

  it("handles ISBN-10 with a check X", () => {
    expect(coverIsbn({ coverUrl: "https://covers.openlibrary.org/b/isbn/043942089X-M.jpg" })).toBe(
      "043942089X",
    );
  });

  it("returns empty when there is nothing to recover", () => {
    expect(coverIsbn({})).toBe("");
    expect(coverIsbn({ coverUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg" })).toBe("");
  });
});

describe("looksLikeJpeg", () => {
  it("accepts JPEG magic and rejects PNG and empty", () => {
    expect(looksLikeJpeg(JPEG)).toBe(true);
    expect(looksLikeJpeg(PNG)).toBe(false);
    expect(looksLikeJpeg(new ArrayBuffer(0))).toBe(false);
  });
});

describe("loadCover fallback", () => {
  const OL_URL = "https://covers.openlibrary.org/b/isbn/9781484267073-M.jpg?default=false";
  const client = (bytes: ArrayBuffer | null) =>
    ({ coverBytes: async () => bytes }) as never;

  it("uses Google when Open Library has no image", async () => {
    const el = img();
    const fetchBytes = vi.fn(async () => JPEG);
    const onMissing = vi.fn();
    loadCover(el, OL_URL, {
      client: client(null),
      fallbackIsbn: "9781484267073",
      fetchBytes,
      onMissing,
    });
    await settle();
    expect(fetchBytes).toHaveBeenCalledWith(googleCoverUrl("9781484267073"));
    expect(el.src).toMatch(/^blob:/);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("treats Google's PNG placeholder as a miss", async () => {
    const el = img();
    const onMissing = vi.fn();
    loadCover(el, OL_URL, {
      client: client(null),
      fallbackIsbn: "9781484267073",
      fetchBytes: async () => PNG,
      onMissing,
    });
    await settle();
    expect(el.src).toBe("");
    expect(onMissing).toHaveBeenCalledOnce();
  });

  it("caches a miss — the second render never re-fetches", async () => {
    const fetchBytes = vi.fn(async () => PNG);
    const opts = { client: client(null), fallbackIsbn: "111", fetchBytes };
    loadCover(img(), OL_URL, opts);
    await settle();
    loadCover(img(), OL_URL, opts);
    await settle();
    expect(fetchBytes).toHaveBeenCalledOnce();
  });

  it("caches a hit — the second render is served from memory", async () => {
    const fetchBytes = vi.fn(async () => JPEG);
    const opts = { client: client(null), fallbackIsbn: "222", fetchBytes };
    loadCover(img(), OL_URL, opts);
    await settle();
    const second = img();
    loadCover(second, OL_URL, opts);
    await settle();
    expect(fetchBytes).toHaveBeenCalledOnce();
    expect(second.src).toMatch(/^blob:/);
  });

  it("falls back for an entry with no cover URL at all, by its isbn field", async () => {
    const el = img();
    loadCover(el, "", { fallbackIsbn: "9781484270820", fetchBytes: async () => JPEG });
    await settle();
    expect(el.src).toMatch(/^blob:/);
  });

  it("keeps the plain placeholder when there is no isbn or no fetcher", async () => {
    const missA = vi.fn();
    loadCover(img(), "", { onMissing: missA, fetchBytes: async () => JPEG });
    const missB = vi.fn();
    loadCover(img(), "", { onMissing: missB, fallbackIsbn: "333" });
    await settle();
    expect(missA).toHaveBeenCalledOnce();
    expect(missB).toHaveBeenCalledOnce();
  });

  it("does not cache a transient fetch failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    const onMissing = vi.fn();
    loadCover(img(), "", { fallbackIsbn: "444", fetchBytes: failing, onMissing });
    await settle();
    expect(onMissing).toHaveBeenCalledOnce();
    const recovering = vi.fn(async () => JPEG);
    const el = img();
    loadCover(el, "", { fallbackIsbn: "444", fetchBytes: recovering });
    await settle();
    expect(recovering).toHaveBeenCalledOnce();
    expect(el.src).toMatch(/^blob:/);
  });
});
