/**
 * Book covers through the local artwork cache.
 *
 * **No network, ever** — and the warm-path tests go further: they hand
 * `loadCover` a client and an `HttpFn` that *throw on sight*, so a render that
 * should have been answered from the vault fails the test loudly rather than
 * quietly passing on a real Open Library request.
 *
 * The contract being pinned down, in order of how much it would hurt to lose it:
 *
 *   1. A warm Reading tab makes no requests at all.
 *   2. A cold one still goes through `OpenLibraryClient.coverBytes` — the
 *      limiter and the User-Agent — and the cache is only ever *told* about
 *      bytes that path already paid for. It never fetches a cover itself.
 *   3. With the setting off, every cover takes exactly the path it takes today.
 *   4. No cache failure — a throwing `resolve`, a rejecting `store`, a full
 *      disk — can leave a cover blank.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COVER_CACHE_SCOPE,
  clearCoverCaches,
  keepCover,
  loadCover,
  localCoverUrl,
  readingCacheEntries,
  type CoverCache,
} from "../src/domains/reading/covers";
import { ImageCache, cacheFileName, type ImageCacheAdapter } from "../src/services/imagecache";
import { posterCacheEntries } from "../src/ui/components/posters";
import { createBook, createManga, createTitle } from "../src/data/schema";
import type { HttpFn } from "../src/services/http";
import type { HttpRequestOptions, OpenLibraryClient, ReadingData } from "../src/types";

/**
 * `npx tsc --noEmit` fails the day `readingCacheEntries(this.store.reading)`
 * stops compiling in `main.ts` — the exact call the warm and orphan passes make.
 */
type MainCallFits = ReadingData extends Parameters<typeof readingCacheEntries>[0] ? true : false;
const MAIN_CALL_FITS: MainCallFits = true;

const OL_URL = "https://covers.openlibrary.org/b/isbn/9781484267073-M.jpg?default=false";
const OL_OTHER = "https://covers.openlibrary.org/b/isbn/9780134685991-M.jpg?default=false";
const GOOGLE_THUMB = "https://books.google.com/books/content?id=abc&printsec=frontcover";

/** The Google-by-ISBN fallback for the ISBN embedded in `OL_URL`. */
const googleFallbackUrl = (): string =>
  "https://books.google.com/books/content?vid=ISBN9781484267073&printsec=frontcover&img=1&zoom=1";

const JPEG = (): ArrayBuffer => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
const PNG = (): ArrayBuffer => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer;

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function img(): { src: string; classes: string[]; addClass(c: string): void } {
  return {
    src: "",
    classes: [],
    addClass(c: string) {
      this.classes.push(c);
    },
  };
}

/** The bits of `URL`/`Blob` the module touches, without a DOM. */
function stubUrlGlobals(): void {
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:test-${(n += 1)}`,
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal("Blob", class {});
}

/** Flush the promise chain inside `loadCover`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A client that hands over bytes, and counts how often it was asked. */
function countingClient(bytes: ArrayBuffer | null): OpenLibraryClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async coverBytes(url: string) {
      calls.push(url);
      return bytes ?? undefined;
    },
  } as unknown as OpenLibraryClient & { calls: string[] };
}

/** The mock that fails the test if the network is touched at all. */
function forbiddenClient(): OpenLibraryClient {
  return {
    coverBytes(url: string): Promise<ArrayBuffer | undefined> {
      throw new Error(`the network was asked for ${url} — it should have come from the cache`);
    },
  } as unknown as OpenLibraryClient;
}

const forbiddenHttp: HttpFn = (() => {
  throw new Error("the raw transport was used — covers must go through the client");
}) as unknown as HttpFn;

const forbiddenFetch = async (url: string): Promise<ArrayBuffer | null> => {
  throw new Error(`bytes were fetched for ${url} — it should have come from the cache`);
};

/** An in-memory vault. Only what `ImageCache` asks of an adapter. */
class FakeAdapter implements ImageCacheAdapter {
  files = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  failWrites = false;
  /** Every path ever written, in order — including the ones renamed away. */
  writes: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.writes.push(path);
    if (this.failWrites) throw new Error(`disk is full: ${path}`);
    this.files.set(path, data);
  }
  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return { files: [...this.files.keys()].filter((p) => p.startsWith(prefix)), folders: [] };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  getResourcePath(path: string): string {
    return `app://vault/${path}?1700000000`;
  }
  rename = async (from: string, to: string): Promise<void> => {
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`no such file: ${from}`);
    this.files.set(to, bytes);
    this.files.delete(from);
  };
}

function realCache(adapter: FakeAdapter, enabled = true): ImageCache {
  return new ImageCache({ adapter, enabled, folder: "WatchLog/images", http: forbiddenHttp });
}

/** A cache stub with exactly the behaviour a test wants to provoke. */
function stubCache(over: Partial<CoverCache> = {}): CoverCache {
  return { resolve: () => "", ...over };
}

beforeEach(() => {
  clearCoverCaches();
  stubUrlGlobals();
});

// ---------------------------------------------------------------------------

describe("a warm Reading tab makes no requests", () => {
  it("renders an Open Library cover from the vault without touching the client", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    // Cold once, through a client that is allowed to answer.
    const client = countingClient(JPEG());
    loadCover(img(), OL_URL, { client, cache, cacheId: "book-1" });
    await settle();
    expect(client.calls).toEqual([OL_URL]);
    expect(adapter.files.size).toBe(1);

    // Warm: the same book, a client that throws if it is so much as looked at.
    const el = img();
    loadCover(el, OL_URL, {
      client: forbiddenClient(),
      cache,
      cacheId: "book-1",
      fetchBytes: forbiddenFetch,
      fallbackIsbn: "9781484267073",
    });
    await settle();
    expect(el.src).toBe(`app://vault/${[...adapter.files.keys()][0] ?? ""}?1700000000`);
    expect(el.classes).toContain("is-loaded");
  });

  it("survives a restart: a primed index serves the file the last session wrote", async () => {
    const adapter = new FakeAdapter();
    const first = realCache(adapter);
    loadCover(img(), OL_URL, { client: countingClient(JPEG()), cache: first, cacheId: "book-1" });
    await settle();

    // New session, new cache object, same vault.
    const second = realCache(adapter);
    await second.prime();
    clearCoverCaches();

    const el = img();
    loadCover(el, OL_URL, { client: forbiddenClient(), cache: second, cacheId: "book-1" });
    await settle();
    expect(el.src).toContain("app://vault/WatchLog/images/book-book-1-");
  });

  it("serves the Google-by-ISBN fallback from the vault with no fetcher at all", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    // Open Library has no image for this book — the user's real ones — so the
    // cover comes from Google. One cold pass to bank it.
    loadCover(img(), OL_URL, {
      client: countingClient(null),
      cache,
      cacheId: "book-2",
      fallbackIsbn: "9781484267073",
      fetchBytes: async () => JPEG(),
    });
    await settle();
    expect(adapter.files.size).toBe(1);

    const el = img();
    const onMissing = vi.fn();
    loadCover(el, OL_URL, {
      client: forbiddenClient(),
      cache,
      cacheId: "book-2",
      fallbackIsbn: "9781484267073",
      onMissing,
      // No `fetchBytes` at all: the local copy must be enough.
    });
    await settle();
    expect(el.src).toContain("app://vault/WatchLog/images/book-book-2-");
    expect(onMissing).not.toHaveBeenCalled();
  });

  /**
   * The one cost the cache cannot remove, written down so it is a decision
   * rather than a surprise.
   *
   * A book Open Library has *no* cover for leaves nothing on disk to point at —
   * the only thing cached is the Google fallback, under a different URL. So
   * after a restart the primary is asked exactly once more, and the in-session
   * negative cache absorbs every render after that. Persisting "there is no
   * cover here" would mean an index on disk, which `imagecache.ts` deliberately
   * does not have, and would freeze a cover Open Library later adds.
   */
  it("re-asks a coverless book once per session, then never again", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const first = countingClient(null);
    loadCover(img(), OL_URL, {
      client: first,
      cache,
      cacheId: "book-2",
      fallbackIsbn: "9781484267073",
      fetchBytes: async () => JPEG(),
    });
    await settle();

    // A new session: the folder is still there, this session's memory is not.
    clearCoverCaches();
    const next = countingClient(null);
    const el = img();
    loadCover(el, OL_URL, { client: next, cache, cacheId: "book-2", fallbackIsbn: "9781484267073" });
    await settle();
    expect(next.calls).toEqual([OL_URL]);
    expect(el.src).toContain("app://vault/WatchLog/images/book-book-2-");

    // …and every render after it is free.
    const again = img();
    loadCover(again, OL_URL, {
      client: forbiddenClient(),
      cache,
      cacheId: "book-2",
      fallbackIsbn: "9781484267073",
    });
    await settle();
    expect(again.src).toContain("app://vault/WatchLog/images/book-book-2-");
  });

  it("prefers the local copy for a directly assignable cover too", () => {
    const cache = stubCache({ resolve: () => "app://vault/WatchLog/images/book-book-3-x.jpg" });
    expect(localCoverUrl(cache, "book-3", GOOGLE_THUMB)).toBe(
      "app://vault/WatchLog/images/book-book-3-x.jpg",
    );
    const el = img();
    loadCover(el, GOOGLE_THUMB, { cache, cacheId: "book-3" });
    expect(el.src).toBe("app://vault/WatchLog/images/book-book-3-x.jpg");
  });
});

describe("a cold load stays polite", () => {
  it("fetches through the client and hands the cache the bytes it already has", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const client = countingClient(JPEG());
    const el = img();

    loadCover(el, OL_URL, { client, cache, cacheId: "book-1" });
    await settle();

    // One request, through the limiter, and the transport never used: `store`
    // writes bytes, it does not fetch them.
    expect(client.calls).toEqual([OL_URL]);
    expect(el.src).toBe("blob:test-1");
    expect([...adapter.files.keys()]).toEqual([
      expect.stringMatching(/^WatchLog\/images\/book-book-1-[a-z0-9]+\.jpg$/) as unknown as string,
    ]);
  });

  it("never asks the cache to download an Open Library url itself", async () => {
    const ensure = vi.fn(async () => "");
    const store = vi.fn(async () => "WatchLog/images/x.jpg");
    const el = img();
    loadCover(el, OL_URL, {
      client: countingClient(JPEG()),
      cache: stubCache({ ensure, store }),
      cacheId: "book-1",
    });
    await settle();
    expect(ensure).not.toHaveBeenCalled();
    expect(store).toHaveBeenCalledWith(
      { scope: COVER_CACHE_SCOPE, id: "book-1" },
      OL_URL,
      expect.anything(),
    );
  });

  it("caches a directly assignable cover through the cache's own fetch, once", () => {
    const ensure = vi.fn(async () => "WatchLog/images/x.jpg");
    const el = img();
    loadCover(el, GOOGLE_THUMB, { cache: stubCache({ ensure }), cacheId: "book-3" });
    // Shown immediately from the remote url — the copy is for next time.
    expect(el.src).toBe(GOOGLE_THUMB);
    expect(ensure).toHaveBeenCalledWith({ scope: COVER_CACHE_SCOPE, id: "book-3" }, GOOGLE_THUMB);
  });

  it("only keeps a Google fallback that is a real cover, never the grey placeholder", async () => {
    const store = vi.fn(async () => "");
    const onMissing = vi.fn();
    loadCover(img(), "", {
      cache: stubCache({ store }),
      cacheId: "book-4",
      fallbackIsbn: "9780134685991",
      fetchBytes: async () => PNG(),
      onMissing,
    });
    await settle();
    expect(store).not.toHaveBeenCalled();
    expect(onMissing).toHaveBeenCalled();
  });

  it("writes nothing for a search hit, which has no id to key on", async () => {
    const store = vi.fn(async () => "");
    const ensure = vi.fn(async () => "");
    const cache = stubCache({ store, ensure });
    loadCover(img(), OL_URL, { client: countingClient(JPEG()), cache });
    loadCover(img(), GOOGLE_THUMB, { cache });
    await settle();
    expect(store).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("with the setting off, nothing changes", () => {
  it("draws the blob and writes no file", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter, false);
    const client = countingClient(JPEG());
    const el = img();

    loadCover(el, OL_URL, { client, cache, cacheId: "book-1" });
    await settle();

    expect(client.calls).toEqual([OL_URL]);
    expect(el.src).toBe("blob:test-1");
    expect(el.classes).toContain("is-loaded");
    expect(adapter.files.size).toBe(0);
  });

  it("assigns a directly assignable cover straight through, as it always has", () => {
    const el = img();
    loadCover(el, GOOGLE_THUMB, { cache: realCache(new FakeAdapter(), false), cacheId: "book-3" });
    expect(el.src).toBe(GOOGLE_THUMB);
  });

  it("is byte-identical with no cache passed at all", async () => {
    const el = img();
    loadCover(el, OL_URL, { client: countingClient(JPEG()) });
    await settle();
    expect(el.src).toBe("blob:test-1");
  });
});

describe("a cache failure never blanks a cover", () => {
  it("falls back to the client when resolve throws", async () => {
    const cache = stubCache({
      resolve: () => {
        throw new Error("the index exploded");
      },
    });
    const client = countingClient(JPEG());
    const el = img();
    loadCover(el, OL_URL, { client, cache, cacheId: "book-1" });
    await settle();
    expect(client.calls).toEqual([OL_URL]);
    expect(el.src).toBe("blob:test-1");
  });

  it("shows the cover even when the write rejects", async () => {
    const cache = stubCache({ store: async () => Promise.reject(new Error("read-only vault")) });
    const el = img();
    loadCover(el, OL_URL, { client: countingClient(JPEG()), cache, cacheId: "book-1" });
    await settle();
    expect(el.src).toBe("blob:test-1");
  });

  it("shows the cover when the write throws synchronously", async () => {
    const cache = stubCache({
      store: () => {
        throw new Error("no such method, really");
      },
    });
    const el = img();
    loadCover(el, OL_URL, { client: countingClient(JPEG()), cache, cacheId: "book-1" });
    await settle();
    expect(el.src).toBe("blob:test-1");
  });

  it("draws the remote url when ensure throws", () => {
    const cache = stubCache({
      ensure: () => {
        throw new Error("nope");
      },
    });
    const el = img();
    loadCover(el, GOOGLE_THUMB, { cache, cacheId: "book-3" });
    expect(el.src).toBe(GOOGLE_THUMB);
  });

  it("a full disk costs a file, not a picture", async () => {
    const adapter = new FakeAdapter();
    adapter.failWrites = true;
    const cache = realCache(adapter);
    const el = img();
    loadCover(el, OL_URL, { client: countingClient(JPEG()), cache, cacheId: "book-1" });
    await settle();
    expect(el.src).toBe("blob:test-1");
    expect(adapter.files.size).toBe(0);
  });

  it("discards a cached answer that looks like a bare vault path", () => {
    // `posterLoader` reads a leading `/` as a TMDB poster path.
    expect(localCoverUrl(stubCache({ resolve: () => "/WatchLog/x.jpg" }), "book-1", OL_URL)).toBe("");
  });
});

describe("this session's bytes", () => {
  it("repaints a re-render without asking the network again", async () => {
    const client = countingClient(JPEG());
    loadCover(img(), OL_URL, { client });
    await settle();

    const el = img();
    loadCover(el, OL_URL, { client: forbiddenClient() });
    expect(el.src).toBe("blob:test-2");
    expect(client.calls).toEqual([OL_URL]);
  });

  it("does not re-ask for a cover Open Library has already said it has none of", async () => {
    const client = countingClient(null);
    const onMissing = vi.fn();
    loadCover(img(), OL_URL, { client, onMissing });
    await settle();
    expect(client.calls).toEqual([OL_URL]);

    loadCover(img(), OL_URL, { client: forbiddenClient(), onMissing });
    await settle();
    expect(onMissing).toHaveBeenCalledTimes(2);
  });

  it("still retries after a transient failure — a thrown request is not an answer", async () => {
    let attempts = 0;
    const flaky = {
      async coverBytes(): Promise<ArrayBuffer | undefined> {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return JPEG();
      },
    } as unknown as OpenLibraryClient;

    const first = img();
    loadCover(first, OL_URL, { client: flaky });
    await settle();
    expect(first.src).toBe("");

    const second = img();
    loadCover(second, OL_URL, { client: flaky });
    await settle();
    expect(attempts).toBe(2);
    expect(second.src).toBe("blob:test-1");
  });

  it("is bounded — the oldest cover is evicted rather than held forever", async () => {
    const client = countingClient(JPEG());
    // 64 is the limit; 65 distinct covers must push the first one out.
    for (let i = 0; i < 65; i += 1) {
      loadCover(img(), `${OL_URL}&n=${i}`, { client });
      await settle();
    }
    expect(client.calls).toHaveLength(65);
    loadCover(img(), `${OL_URL}&n=0`, { client });
    await settle();
    expect(client.calls).toHaveLength(66);
    // …while a recent one is still in memory.
    loadCover(img(), `${OL_URL}&n=64`, { client: forbiddenClient() });
    expect(client.calls).toHaveLength(66);
  });

  it("forgets everything when the caches are cleared", async () => {
    const client = countingClient(JPEG());
    loadCover(img(), OL_URL, { client });
    await settle();
    clearCoverCaches();
    loadCover(img(), OL_URL, { client });
    await settle();
    expect(client.calls).toEqual([OL_URL, OL_URL]);
  });
});

describe("the entry list the warm and orphan passes are given", () => {
  /** What `main.ts` holds: `store.reading`, books and manga side by side. */
  const shelves = () => ({
    books: [
      createBook({ id: "book-1", title: "The Odyssey", coverUrl: OL_URL }),
      createBook({ id: "book-2", title: "Refactoring", coverUrl: GOOGLE_THUMB }),
      createBook({ id: "book-3", title: "No Cover At All" }),
    ],
    manga: [createManga({ id: "manga-1", title: "Berserk", coverUrl: GOOGLE_THUMB })],
    bookColumns: [],
    mangaColumns: [],
  });

  it("accepts the store's reading data as main.ts holds it", () => {
    expect(MAIN_CALL_FITS).toBe(true);
  });

  it("takes the whole reading store, so manga cannot be left out by accident", () => {
    const ids = readingCacheEntries(shelves()).map((e) => e.key.id);
    expect(ids).toContain("book-1");
    expect(ids).toContain("book-2");
    expect(ids).toContain("manga-1");
    // A book with no cover url and no ISBN references no file.
    expect(ids).not.toContain("book-3");
  });

  it("concatenates with posterCacheEntries — the exact expression main.ts uses", () => {
    const titles = [
      createTitle({ id: "t1", title: "Dune", type: "Movie", posterUrl: "/dune.jpg" }),
      createTitle({ id: "t2", title: "Arrival", type: "Movie", posterUrl: "/arrival.jpg" }),
    ];
    const entries = [...posterCacheEntries(titles), ...readingCacheEntries(shelves())];
    const scopes = new Set(entries.map((e) => e.key.scope));
    expect(scopes).toEqual(new Set(["title", "book"]));
    // Two titles, and **one entry per book that has a cover** — not one per
    // candidate URL. `book-1` carries its Google-by-ISBN fallback as an
    // alternate rather than as a second entry; `book-3` has no cover at all.
    expect(entries.filter((e) => e.key.scope === "title")).toHaveLength(2);
    expect(entries.filter((e) => e.key.scope === "book")).toHaveLength(3);

    const books = readingCacheEntries(shelves());
    expect(books.find((e) => e.key.id === "book-1")?.alternates).toEqual([
      expect.stringContaining("vid=ISBN9781484267073") as unknown as string,
    ]);
    expect(books.find((e) => e.key.id === "book-2")?.alternates).toBeUndefined();
  });

  it("a titles-only orphan scan condemns every book cover — the bug, pinned", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const titles = [createTitle({ id: "t1", title: "Dune", type: "Movie", posterUrl: "/d.jpg" })];
    await cache.store({ scope: COVER_CACHE_SCOPE, id: "book-1" }, OL_URL, JPEG());

    // What main.ts did: titles only. The book's cover is "unreferenced".
    expect(cache.findOrphans(posterCacheEntries(titles))).toEqual([...adapter.files.keys()]);
    // What it must do: both halves. Nothing is condemned.
    expect(
      cache.findOrphans([...posterCacheEntries(titles), ...readingCacheEntries(shelves())]),
    ).toEqual([]);
  });

  it("warms a book cover into the book scope, with a name no title can collide with", async () => {
    const adapter = new FakeAdapter();
    const urls: string[] = [];
    const http = (async (options: HttpRequestOptions) => {
      urls.push(options.url);
      return { status: 200, headers: {}, text: "", json: undefined, bytes: JPEG() };
    }) as HttpFn;
    // `source: "tmdb"` is what main.ts passes — it is error attribution only and
    // has no say in the filename, which comes from the key and the url.
    const cache = new ImageCache({
      adapter,
      enabled: true,
      folder: "WatchLog/images",
      http,
      source: "tmdb",
    });
    const client = countingClient(JPEG());

    const result = await cache.warm(readingCacheEntries(shelves(), client));
    // Three books with a cover, three images — and no phantom failure for the
    // fallback of a book whose primary was perfectly fine.
    expect(result).toEqual({ downloaded: 3, skipped: 0, failed: 0 });
    expect(adapter.files.size).toBe(3);

    // The one Open Library cover went through the client; the two keyless
    // thumbnails went through the ordinary transport; the Google fallback for
    // `book-1` was never fetched, because `book-1` never fell back.
    expect(client.calls).toEqual([OL_URL]);
    expect(urls).toEqual([GOOGLE_THUMB, GOOGLE_THUMB]);
    expect(urls.some((u) => u.startsWith("https://covers.openlibrary.org"))).toBe(false);

    const files = [...adapter.files.keys()].sort();
    expect(files.every((p) => p.startsWith("WatchLog/images/book-"))).toBe(true);
    expect(cache.resolve({ scope: COVER_CACHE_SCOPE, id: "book-2" }, GOOGLE_THUMB)).toContain(
      "app://vault/WatchLog/images/book-book-2-",
    );

    // A book and a title that share an id share nothing else.
    expect(cacheFileName({ scope: "book", id: "1" }, OL_URL)).not.toBe(
      cacheFileName({ scope: "title", id: "1" }, OL_URL),
    );
    expect(new Set(files).size).toBe(files.length);
  });

  /**
   * The case the fallback exists for, and the one least likely to have been
   * exercised: Open Library has no image, Google does.
   */
  it("takes the fallback when the primary has no image, and counts it as the success it is", async () => {
    const adapter = new FakeAdapter();
    const urls: string[] = [];
    const http = (async (options: HttpRequestOptions) => {
      urls.push(options.url);
      return { status: 200, headers: {}, text: "", json: undefined, bytes: JPEG() };
    }) as HttpFn;
    const cache = new ImageCache({ adapter, enabled: true, folder: "WatchLog/images", http });
    const client = countingClient(null); // Open Library: "no cover for that book"

    const book = { id: "book-1", coverUrl: OL_URL };
    const result = await cache.warm(readingCacheEntries([book], client));

    // One image obtained, no failure reported — the user got their cover.
    expect(result).toEqual({ downloaded: 1, skipped: 0, failed: 0 });
    expect(client.calls).toEqual([OL_URL]);
    expect(urls).toEqual([expect.stringContaining("vid=ISBN9781484267073") as unknown as string]);

    // It landed under the book's own key, at the name the render path looks up
    // when the primary comes back empty.
    const fallbackUrl = urls[0] ?? "";
    expect([...adapter.files.keys()]).toEqual([
      `WatchLog/images/${cacheFileName({ scope: COVER_CACHE_SCOPE, id: "book-1" }, fallbackUrl)}`,
    ]);
    expect(localCoverUrl(cache, "book-1", fallbackUrl)).toContain(
      "app://vault/WatchLog/images/book-book-1-",
    );
    // And nothing condemns it, because the alternate counts as referenced.
    expect(cache.findOrphans(readingCacheEntries([book]))).toEqual([]);
  });

  it("reports a real failure as a failure — no candidate worked", async () => {
    const adapter = new FakeAdapter();
    const http = (async () => {
      throw new Error("404 from the CDN");
    }) as unknown as HttpFn;
    const cache = new ImageCache({ adapter, enabled: true, folder: "WatchLog/images", http });

    const result = await cache.warm(
      readingCacheEntries([{ id: "book-1", coverUrl: OL_URL }], countingClient(null)),
    );
    expect(result).toEqual({ downloaded: 0, skipped: 0, failed: 1 });
    expect(adapter.files.size).toBe(0);
  });

  it("counts a book already on disk as skipped, whichever candidate it took", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const google = googleFallbackUrl();
    // Only the fallback is cached — the shape a coverless book ends up in.
    await cache.store({ scope: COVER_CACHE_SCOPE, id: "book-1" }, google, JPEG());

    const result = await cache.warm(
      readingCacheEntries([{ id: "book-1", coverUrl: OL_URL }], countingClient(JPEG())),
    );
    expect(result).toEqual({ downloaded: 0, skipped: 1, failed: 0 });
    expect(adapter.files.size).toBe(1);
  });

  it("will not fetch an Open Library cover impolitely when there is no client", async () => {
    const adapter = new FakeAdapter();
    const urls: string[] = [];
    const http = (async (options: HttpRequestOptions) => {
      urls.push(options.url);
      return { status: 200, headers: {}, text: "", json: undefined, bytes: JPEG() };
    }) as HttpFn;
    const cache = new ImageCache({ adapter, enabled: true, folder: "WatchLog/images", http });

    const result = await cache.warm(readingCacheEntries(shelves()));
    // Nothing went round the limiter, and the book whose primary could not be
    // fetched politely was picked up by its Google fallback instead.
    expect(urls.some((u) => u.startsWith("https://covers.openlibrary.org"))).toBe(false);
    expect(result).toEqual({ downloaded: 3, skipped: 0, failed: 0 });
  });

  it("still names every file a book references, client or not", () => {
    const shape = (e: { url: string; alternates?: readonly string[] }) => [
      e.url,
      ...(e.alternates ?? []),
    ];
    expect(readingCacheEntries(shelves()).map(shape)).toEqual(
      readingCacheEntries(shelves(), countingClient(JPEG())).map(shape),
    );
  });
});

describe("what books reference", () => {
  it("lists the stored cover and the ISBN fallback, so neither is an orphan", () => {
    expect(
      readingCacheEntries([
        { id: "book-1", coverUrl: OL_URL, isbn: "978-1-4842-6707-3" },
        { id: "book-2", coverUrl: GOOGLE_THUMB },
        { id: "book-3", coverUrl: "none" },
        { id: "", coverUrl: OL_URL },
      ]).map(({ key, url, alternates }) => ({ key, url, alternates })),
    ).toEqual([
      {
        key: { scope: "book", id: "book-1" },
        url: OL_URL,
        // The fallback, in its place: behind the primary, not beside it.
        alternates: [expect.stringContaining("vid=ISBN9781484267073") as unknown as string],
      },
      { key: { scope: "book", id: "book-2" }, url: GOOGLE_THUMB, alternates: undefined },
    ]);
  });

  it("names the file a cached cover actually lives at", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    loadCover(img(), OL_URL, { client: countingClient(JPEG()), cache, cacheId: "book-1" });
    await settle();
    const [entry] = readingCacheEntries([{ id: "book-1", coverUrl: OL_URL }]);
    expect(entry).toBeDefined();
    // The orphan scan compares exactly these names against the folder listing.
    expect(cache.findOrphans(readingCacheEntries([{ id: "book-1", coverUrl: OL_URL }]))).toEqual([]);
    expect(cache.findOrphans([])).toEqual([...adapter.files.keys()]);
  });
});

describe("ImageCache.store", () => {
  const KEY = { scope: COVER_CACHE_SCOPE, id: "book-1" };

  it("writes once and then answers from the index", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const path = await cache.store(KEY, OL_URL, JPEG());
    expect(path).toMatch(/^WatchLog\/images\/book-book-1-/);
    expect(cache.resolve(KEY, OL_URL)).toBe(`app://vault/${path}?1700000000`);

    adapter.failWrites = true; // a second write would now blow up
    expect(await cache.store(KEY, OL_URL, JPEG())).toBe(path);
  });

  it("leaves no staging file behind when the write dies", async () => {
    const adapter = new FakeAdapter();
    adapter.failWrites = true;
    const cache = realCache(adapter);
    expect(await cache.store(KEY, OL_URL, JPEG())).toBe("");
    expect([...adapter.files.keys()]).toEqual([]);
    expect(cache.resolve(KEY, OL_URL)).toBe("");
  });

  it("refuses an empty body, an absurd one, a non-http url, and a cache that is off", async () => {
    const adapter = new FakeAdapter();
    const cache = new ImageCache({ adapter, enabled: true, folder: "WatchLog/images", maxBytes: 8 });
    expect(await cache.store(KEY, OL_URL, new ArrayBuffer(0))).toBe("");
    expect(await cache.store(KEY, OL_URL, new ArrayBuffer(9))).toBe("");
    expect(await cache.store(KEY, "app://vault/x.jpg", JPEG())).toBe("");
    expect(await realCache(adapter, false).store(KEY, OL_URL, JPEG())).toBe("");
    expect(adapter.files.size).toBe(0);
  });

  it("collapses a burst into one write", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const paths = await Promise.all([
      cache.store(KEY, OL_URL, JPEG()),
      cache.store(KEY, OL_URL, JPEG()),
      cache.store(KEY, OL_URL, JPEG()),
    ]);
    expect(new Set(paths).size).toBe(1);
    expect(adapter.files.size).toBe(1);
  });
});

/**
 * Obsidian Sync raised this on the first real download, once per image:
 *
 *     Sync Error! {"errno":-2,"code":"ENOENT","syscall":"open",
 *      "path":".../WatchLog/images/title-the-odyssey-124gttg1yxhgr4.jpg.writing.tmp"}
 *
 * Sync saw the staging file appear, queued it, and by the time it opened it the
 * rename had moved it away. The staging step is not the bug and is not removed —
 * it is the only thing that stops a killed process leaving a truncated JPEG at a
 * path `prime()` would trust forever. The fix is that the staging file is hidden,
 * so Sync never sees it in the first place.
 */
describe("the staging file is invisible to Obsidian Sync", () => {
  const KEY = { scope: COVER_CACHE_SCOPE, id: "book-1" };

  it("writes nothing Sync will pick up, and leaves the final file visible", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const path = await cache.store(KEY, OL_URL, JPEG());

    const staged = adapter.writes.filter((p) => p !== path);
    expect(staged).toHaveLength(1);
    const [temp] = staged;
    // Hidden: a dot-prefixed segment is not a vault file, so nothing indexes it.
    expect(temp).toMatch(/^WatchLog\/images\/\.book-book-1-[a-z0-9]+\.jpg\.writing\.tmp$/);
    // No write anywhere is a *visible* temp — that is the one Sync opened.
    expect(adapter.writes.filter((p) => /\/[^./][^/]*\.writing\.tmp$/.test(p))).toEqual([]);
    // …and the file that survives is an ordinary, syncable image.
    expect(path).toMatch(/^WatchLog\/images\/book-book-1-[a-z0-9]+\.jpg$/);
    expect([...adapter.files.keys()]).toEqual([path]);
  });

  it("still leaves no partial file when the staged write dies", async () => {
    const adapter = new FakeAdapter();
    adapter.failWrites = true;
    const cache = realCache(adapter);
    expect(await cache.store(KEY, OL_URL, JPEG())).toBe("");
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("never adopts a leftover staging file as a cached image", async () => {
    const adapter = new FakeAdapter();
    const name = cacheFileName(KEY, OL_URL);
    // What a process killed mid-write leaves behind — under either scheme.
    adapter.files.set(`WatchLog/images/.${name}.writing.tmp`, new ArrayBuffer(3));
    adapter.files.set(`WatchLog/images/${name}.writing.tmp`, new ArrayBuffer(3));
    adapter.folders.add("WatchLog/images");

    const cache = realCache(adapter);
    await cache.prime();

    // Half a JPEG must never read as a cache hit.
    expect(cache.resolve(KEY, OL_URL)).toBe("");
    expect(cache.stats().files).toBe(0);
    // It is reported for the user to clear — never removed on their behalf.
    expect(cache.findOrphans(readingCacheEntries([{ id: "book-1", coverUrl: OL_URL }]))).toEqual([
      `WatchLog/images/.${name}.writing.tmp`,
      `WatchLog/images/${name}.writing.tmp`,
    ]);
    expect([...adapter.files.keys()]).toHaveLength(2);
  });

  it("a purge of that leftover is honoured and not re-reported", async () => {
    const adapter = new FakeAdapter();
    const name = cacheFileName(KEY, OL_URL);
    const temp = `WatchLog/images/.${name}.writing.tmp`;
    adapter.files.set(temp, new ArrayBuffer(3));
    adapter.folders.add("WatchLog/images");
    const cache = realCache(adapter);
    await cache.prime();

    expect((await cache.purge([temp])).removed).toEqual([temp]);
    expect(cache.findOrphans([])).toEqual([]);
    expect(adapter.files.size).toBe(0);
  });

  it("a re-render while a download is in flight does not condemn its staging file", async () => {
    const adapter = new FakeAdapter();
    const name = cacheFileName(KEY, OL_URL);
    adapter.files.set(`WatchLog/images/.${name}.writing.tmp`, new ArrayBuffer(3));
    adapter.folders.add("WatchLog/images");
    const cache = realCache(adapter);
    await cache.prime();

    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = new ImageCache({
      adapter,
      enabled: true,
      folder: "WatchLog/images",
      fetchBytes: async () => {
        await gate;
        return JPEG();
      },
    });
    // Same folder, so the in-flight name is the one the leftover belongs to.
    await slow.prime();
    const job = slow.ensure(KEY, OL_URL);
    expect(slow.findOrphans([])).toEqual([]);
    release();
    await job;
  });
});

describe("keepCover", () => {
  it("does nothing without a cache, an id or a url", () => {
    const ensure = vi.fn(async () => "");
    keepCover(undefined, "book-1", GOOGLE_THUMB);
    keepCover(stubCache({ ensure }), "", GOOGLE_THUMB);
    keepCover(stubCache({ ensure }), "book-1", "");
    keepCover(stubCache({}), "book-1", GOOGLE_THUMB);
    expect(ensure).not.toHaveBeenCalled();
  });
});
