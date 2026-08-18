/**
 * Local image cache.
 *
 * **No network, ever.** Every test hands the cache an `HttpFn` it controls, and
 * the cache-hit tests hand it one that throws on sight — if a lookup that should
 * be answered from the index ever reaches the transport, the test fails loudly
 * rather than quietly passing on a real download.
 *
 * The vault is a plain in-memory adapter. It records every call, so "wrote once"
 * and "left no partial file" are assertions about what actually happened rather
 * than about what the code looks like it does.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMAGE_CACHE_FOLDER,
  ImageCache,
  cacheFileName,
  createImageCache,
  extensionForUrl,
  normalizeCacheFolder,
  type ImageCacheAdapter,
  type ImageKey,
} from "../src/services/imagecache";
import type { HttpFn } from "../src/services/http";
import { posterCacheEntries, posterSourceUrl, posterUrlFor } from "../src/ui/components/posters";
import { createTitle } from "../src/data/schema";
import type { HttpRequestOptions, TitleV4 } from "../src/types";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface AdapterCall {
  op: string;
  path: string;
}

class FakeAdapter implements ImageCacheAdapter {
  files = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  calls: AdapterCall[] = [];

  /** Paths whose `writeBinary` should blow up, simulating a full or locked disk. */
  failWrites = new Set<string>();
  async exists(path: string): Promise<boolean> {
    this.calls.push({ op: "exists", path });
    return this.files.has(path) || this.folders.has(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.calls.push({ op: "writeBinary", path });
    if (this.failWrites.has(path)) throw new Error(`disk is full: ${path}`);
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push({ op: "mkdir", path });
    this.folders.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.calls.push({ op: "list", path });
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((p) => p.startsWith(prefix)),
      folders: [...this.folders].filter((p) => p.startsWith(prefix)),
    };
  }

  async remove(path: string): Promise<void> {
    this.calls.push({ op: "remove", path });
    this.files.delete(path);
  }

  getResourcePath(path: string): string {
    return `app://vault/${path}?1700000000`;
  }

  rename = async (from: string, to: string): Promise<void> => {
    this.calls.push({ op: "rename", path: `${from} -> ${to}` });
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  };

  countOf(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /** Anything left over from a failed write — a `.writing.tmp` sibling. */
  strayTempFiles(): string[] {
    return [...this.files.keys()].filter((p) => p.endsWith(".writing.tmp"));
  }
}

/** The same fake with `rename` withheld, exercising the write-plus-cleanup path. */
function adapterWithoutRename(): ImageCacheAdapter {
  const adapter = new FakeAdapter();
  return {
    exists: (p) => adapter.exists(p),
    writeBinary: (p, d) => adapter.writeBinary(p, d),
    mkdir: (p) => adapter.mkdir(p),
    list: (p) => adapter.list(p),
    remove: (p) => adapter.remove(p),
    getResourcePath: (p) => adapter.getResourcePath(p),
  };
}

function bytes(size: number, fill = 0x41): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).fill(fill);
  return buf;
}

interface FakeHttp {
  http: HttpFn;
  urls: string[];
}

/** A transport that answers every request with `size` bytes. */
function okHttp(size = 64): FakeHttp {
  const urls: string[] = [];
  const http = (async (options: HttpRequestOptions) => {
    urls.push(options.url);
    return { status: 200, headers: {}, text: "", json: undefined, bytes: bytes(size) };
  }) as HttpFn;
  return { http, urls };
}

/** A transport that always fails, the way a dead CDN does. */
function failingHttp(): FakeHttp {
  const urls: string[] = [];
  const http = (async (options: HttpRequestOptions) => {
    urls.push(options.url);
    throw new Error("404 from the CDN");
  }) as HttpFn;
  return { http, urls };
}

/**
 * A transport that fails the test the moment it is touched.
 *
 * This is the assertion for "a cache hit costs no network": if the index is
 * consulted correctly, nothing ever calls this.
 */
const forbiddenHttp: HttpFn = (() => {
  throw new Error("the cache made a network request when it should not have");
}) as HttpFn;

const REMOTE = "https://image.tmdb.org/t/p/w342/abc.jpg";

/** A title-scoped key. Ids are only unique within a domain, never across them. */
const TITLE = (id: string): ImageKey => ({ scope: "title", id });

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "Movie",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe("cache file names", () => {
  it("is deterministic for the same key and url", () => {
    expect(cacheFileName(TITLE("t1"), REMOTE)).toBe(cacheFileName(TITLE("t1"), REMOTE));
    expect(cacheFileName(TITLE("t1"), REMOTE)).toMatch(/^title-t1-[0-9a-z]+\.jpg$/);
  });

  it("gives two different titles two different files", () => {
    expect(cacheFileName(TITLE("t1"), REMOTE)).not.toBe(cacheFileName(TITLE("t2"), REMOTE));
  });

  it("separates keys that slug to the same readable half", () => {
    // Both slug to `the-thing`; only the fingerprint keeps them apart.
    const a = cacheFileName(TITLE("The Thing"), REMOTE);
    const b = cacheFileName(TITLE("the/thing"), REMOTE);
    const c = cacheFileName(TITLE("the_thing"), REMOTE);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const name of [a, b, c]) expect(name.startsWith("title-the-thing-")).toBe(true);
  });

  it("changes when the url changes, so a new poster is not served from the old file", () => {
    const before = cacheFileName(TITLE("t1"), REMOTE);
    const after = cacheFileName(TITLE("t1"), "https://example.com/other.jpg");
    expect(after).not.toBe(before);
  });

  it("cannot be talked into a path separator", () => {
    for (const key of ["../../evil", "..\\..\\evil", "/etc/passwd", "a/../../b", "....//x"]) {
      const name = cacheFileName(TITLE(key), REMOTE);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });

  it("survives a key made entirely of punctuation", () => {
    const name = cacheFileName(TITLE("../.."), REMOTE);
    expect(name.startsWith("title-img-")).toBe(true);
    expect(name).not.toContain("..");
  });

  it("never collides across providers that share an id space", () => {
    // The whole reason the key is scoped: Open Library id 12345 and TMDB id
    // 12345 are different things, and a bare id would serve one as the other.
    const scopes = ["title", "book", "game", "person"];
    const names = scopes.map((scope) => cacheFileName({ scope, id: "12345" }, REMOTE));
    expect(new Set(names).size).toBe(scopes.length);
    for (const [i, name] of names.entries()) {
      expect(name.startsWith(`${scopes[i] as string}-12345-`)).toBe(true);
    }
  });

  it("keeps a book and a film with the same id in separate files end to end", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const film = await cache.ensure({ scope: "title", id: "12345" }, REMOTE);
    const book = await cache.ensure({ scope: "book", id: "12345" }, REMOTE);

    expect(film).not.toBe(book);
    expect(adapter.files.size).toBe(2);
    expect(cache.resolve({ scope: "title", id: "12345" }, REMOTE)).toContain("title-12345-");
    expect(cache.resolve({ scope: "book", id: "12345" }, REMOTE)).toContain("book-12345-");
  });

  it("returns nothing without a scope", () => {
    expect(cacheFileName({ scope: "", id: "t1" }, REMOTE)).toBe("");
    expect(cacheFileName({ scope: "  ", id: "t1" }, REMOTE)).toBe("");
  });

  it("returns nothing for an empty key or url", () => {
    expect(cacheFileName({ scope: "title", id: "" }, REMOTE)).toBe("");
    expect(cacheFileName(TITLE("t1"), "   ")).toBe("");
  });

  it("takes only known extensions from the provider's url", () => {
    expect(extensionForUrl("https://x/y.png")).toBe("png");
    expect(extensionForUrl("https://x/y.WEBP")).toBe("webp");
    expect(extensionForUrl("https://x/y.jpg?size=w342")).toBe("jpg");
    // Not an image extension, and not a shell we want to hand to the vault.
    expect(extensionForUrl("https://x/y.sh")).toBe("jpg");
    expect(extensionForUrl("https://x/y.jpg/../../boom.exe")).toBe("jpg");
    expect(extensionForUrl("https://books.google.com/books/content?vid=ISBN1")).toBe("jpg");
  });
});

describe("folder normalisation", () => {
  it("strips every way out of the vault", () => {
    // The climb out is removed; the name itself is not the plugin's business —
    // a leading dot is a legal vault folder and the user typed it.
    expect(normalizeCacheFolder("../../../.ssh")).toBe(".ssh");
    expect(normalizeCacheFolder("/etc/passwd")).toBe("etc/passwd");
    expect(normalizeCacheFolder("a/../b")).toBe("a/b");
    expect(normalizeCacheFolder("a\\..\\b")).toBe("a/b");
  });

  it("keeps ordinary folder names intact", () => {
    expect(normalizeCacheFolder("Media/Poster Art")).toBe("Media/Poster Art");
    expect(normalizeCacheFolder("WatchLog/images")).toBe("WatchLog/images");
  });

  it("falls back to the default when nothing usable is left", () => {
    expect(normalizeCacheFolder("")).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
    expect(normalizeCacheFolder("../..")).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
    expect(normalizeCacheFolder("///")).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
  });
});

describe("off by default", () => {
  it("does nothing at all until it is switched on", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: forbiddenHttp });

    expect(cache.isEnabled()).toBe(false);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
    expect(await cache.ensure(TITLE("t1"), REMOTE)).toBe("");
    await cache.prime();
    expect(await cache.warm([{ key: TITLE("t1"), url: REMOTE }])).toEqual({
      downloaded: 0,
      skipped: 0,
      failed: 0,
    });
    expect(adapter.countOf("writeBinary")).toBe(0);
  });
});

describe("downloading", () => {
  it("fetches once, writes once, and never asks the network again", async () => {
    const adapter = new FakeAdapter();
    const net = okHttp();
    const cache = createImageCache({
      adapter,
      http: net.http,
      enabled: true,
      folder: "Media/Posters",
    });

    const path = await cache.ensure(TITLE("t1"), REMOTE);
    expect(path).toBe(`Media/Posters/${cacheFileName(TITLE("t1"), REMOTE)}`);
    expect(net.urls).toEqual([REMOTE]);
    expect(adapter.files.has(path)).toBe(true);
    expect(adapter.strayTempFiles()).toEqual([]);

    // Second call: the index answers, so the forbidden transport is never
    // reached — swap it in to prove the point rather than only counting.
    const second = createImageCache({ adapter, http: forbiddenHttp, enabled: true, folder: "Media/Posters" });
    await second.prime();
    expect(second.resolve(TITLE("t1"), REMOTE)).toBe(`app://vault/${path}?1700000000`);
    expect(await second.ensure(TITLE("t1"), REMOTE)).toBe(path);
    expect(await cache.ensure(TITLE("t1"), REMOTE)).toBe(path);
    expect(net.urls).toEqual([REMOTE]);
  });

  it("stages through a temp file and moves it into place", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const path = await cache.ensure(TITLE("t1"), REMOTE);

    const writes = adapter.calls.filter((c) => c.op === "writeBinary").map((c) => c.path);
    expect(writes).toEqual([`${path}.writing.tmp`]);
    expect(adapter.countOf("rename")).toBe(1);
    expect(adapter.files.has(path)).toBe(true);
    expect(adapter.strayTempFiles()).toEqual([]);
  });

  it("creates the folder chain before writing", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "a/b/c" });
    await cache.ensure(TITLE("t1"), REMOTE);
    expect(adapter.calls.filter((c) => c.op === "mkdir").map((c) => c.path)).toEqual([
      "a",
      "a/b",
      "a/b/c",
    ]);
  });

  it("collapses a burst of concurrent requests into one download", async () => {
    const adapter = new FakeAdapter();
    const net = okHttp();
    const cache = createImageCache({ adapter, http: net.http, enabled: true, folder: "Img" });

    const results = await Promise.all([
      cache.ensure(TITLE("t1"), REMOTE),
      cache.ensure(TITLE("t1"), REMOTE),
      cache.ensure(TITLE("t1"), REMOTE),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(net.urls).toEqual([REMOTE]);
    expect(adapter.countOf("writeBinary")).toBe(1);
  });

  it("adopts a file a previous session already wrote, without downloading", async () => {
    const adapter = new FakeAdapter();
    const path = `Img/${cacheFileName(TITLE("t1"), REMOTE)}`;
    adapter.files.set(path, bytes(10));

    const cache = createImageCache({ adapter, http: forbiddenHttp, enabled: true, folder: "Img" });
    expect(await cache.ensure(TITLE("t1"), REMOTE)).toBe(path);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe(`app://vault/${path}?1700000000`);
  });

  it("refuses anything that is not an http(s) url", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: forbiddenHttp, enabled: true, folder: "Img" });
    for (const url of ["file:///etc/passwd", "data:image/png;base64,AAAA", "app://vault/x.jpg", ""]) {
      expect(await cache.ensure(TITLE("t1"), url)).toBe("");
    }
    expect(adapter.countOf("writeBinary")).toBe(0);
  });

  it("works on an adapter with no rename, and still leaves no temp file", async () => {
    const adapter = adapterWithoutRename();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const path = await cache.ensure(TITLE("t1"), REMOTE);
    expect(path).toBe(`Img/${cacheFileName(TITLE("t1"), REMOTE)}`);
    expect(await adapter.exists(path)).toBe(true);
    expect(await adapter.exists(`${path}.writing.tmp`)).toBe(false);
  });
});

describe("failure leaves nothing behind", () => {
  it("a dead download writes no file and reports no path", async () => {
    const adapter = new FakeAdapter();
    const net = failingHttp();
    const cache = createImageCache({ adapter, http: net.http, enabled: true, folder: "Img" });

    expect(await cache.ensure(TITLE("t1"), REMOTE)).toBe("");
    expect(net.urls).toEqual([REMOTE]);
    expect(adapter.files.size).toBe(0);
    expect(adapter.countOf("writeBinary")).toBe(0);
    // And rendering carries on with the remote URL.
    expect(posterUrlFor(title({ posterUrl: REMOTE }), cache)).toBe(REMOTE);
  });

  it("a write that dies halfway leaves no partial file at the real path", async () => {
    const adapter = new FakeAdapter();
    const path = `Img/${cacheFileName(TITLE("t1"), REMOTE)}`;
    adapter.failWrites.add(`${path}.writing.tmp`);
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });

    expect(await cache.ensure(TITLE("t1"), REMOTE)).toBe("");
    expect(adapter.files.has(path)).toBe(false);
    expect(adapter.strayTempFiles()).toEqual([]);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
  });

  it("does not re-fetch a url that already failed this session", async () => {
    const adapter = new FakeAdapter();
    const net = failingHttp();
    const cache = createImageCache({ adapter, http: net.http, enabled: true, folder: "Img" });

    await cache.ensure(TITLE("t1"), REMOTE);
    await cache.ensure(TITLE("t1"), REMOTE);
    await cache.ensure(TITLE("t1"), REMOTE);
    expect(net.urls).toEqual([REMOTE]);

    // …until the user changes something and asks for a retry.
    cache.clearFailures();
    await cache.ensure(TITLE("t1"), REMOTE);
    expect(net.urls).toEqual([REMOTE, REMOTE]);
  });

  it("rejects an empty or absurdly large body rather than writing it", async () => {
    const empty = new FakeAdapter();
    const emptyHttp = (async () => ({
      status: 200,
      headers: {},
      text: "",
      json: undefined,
      bytes: bytes(0),
    })) as HttpFn;
    const a = createImageCache({ adapter: empty, http: emptyHttp, enabled: true, folder: "Img" });
    expect(await a.ensure(TITLE("t1"), REMOTE)).toBe("");
    expect(empty.files.size).toBe(0);

    const huge = new FakeAdapter();
    const b = createImageCache({
      adapter: huge,
      http: okHttp(4096).http,
      enabled: true,
      folder: "Img",
      maxBytes: 1024,
    });
    expect(await b.ensure(TITLE("t1"), REMOTE)).toBe("");
    expect(huge.files.size).toBe(0);
  });

  it("an unreadable folder is an empty cache, not a crash", async () => {
    const adapter = new FakeAdapter();
    adapter.list = async () => {
      throw new Error("permission denied");
    };
    adapter.folders.add("Img");
    const cache = createImageCache({ adapter, http: forbiddenHttp, enabled: true, folder: "Img" });
    await cache.prime();
    expect(cache.stats().primed).toBe(false);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
  });
});

describe("priming the index", () => {
  it("reads the folder and ignores staging leftovers", async () => {
    const adapter = new FakeAdapter();
    const name = cacheFileName(TITLE("t1"), REMOTE);
    adapter.folders.add("Img");
    adapter.files.set(`Img/${name}`, bytes(4));
    adapter.files.set(`Img/${name}.writing.tmp`, bytes(2));

    const cache = createImageCache({ adapter, http: forbiddenHttp, enabled: true, folder: "Img" });
    await cache.prime();
    expect(cache.stats()).toEqual({ enabled: true, folder: "Img", files: 1, primed: true });
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe(`app://vault/Img/${name}?1700000000`);
  });

  it("a missing folder primes to an empty cache", async () => {
    const cache = createImageCache({
      adapter: new FakeAdapter(),
      http: forbiddenHttp,
      enabled: true,
      folder: "Img",
    });
    await cache.prime();
    expect(cache.stats().files).toBe(0);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
  });

  it("forgets what it knew when the folder setting changes", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    await cache.ensure(TITLE("t1"), REMOTE);
    expect(cache.stats().files).toBe(1);

    cache.configure({ folder: "Other" });
    expect(cache.getFolder()).toBe("Other");
    expect(cache.stats().files).toBe(0);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
  });

  it("switching the feature off leaves every file where it is", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const path = await cache.ensure(TITLE("t1"), REMOTE);

    cache.configure({ enabled: false });
    expect(adapter.files.has(path)).toBe(true);
    expect(adapter.countOf("remove")).toBe(0);
    expect(cache.resolve(TITLE("t1"), REMOTE)).toBe("");
  });
});

describe("warming a batch", () => {
  it("downloads the misses, counts the hits, and dedupes", async () => {
    const adapter = new FakeAdapter();
    const net = okHttp();
    const cache = createImageCache({ adapter, http: net.http, enabled: true, folder: "Img" });
    await cache.ensure(TITLE("t1"), REMOTE);

    const result = await cache.warm([
      { key: TITLE("t1"), url: REMOTE },
      { key: TITLE("t2"), url: "https://example.com/b.jpg" },
      { key: TITLE("t2"), url: "https://example.com/b.jpg" },
      { key: TITLE("t3"), url: "" },
      { key: TITLE("t4"), url: "data:image/png;base64,AA" },
    ]);
    expect(result).toEqual({ downloaded: 1, skipped: 1, failed: 0 });
    expect(net.urls).toEqual([REMOTE, "https://example.com/b.jpg"]);
  });

  it("never runs more than the concurrency limit at once", async () => {
    const adapter = new FakeAdapter();
    let inFlight = 0;
    let peak = 0;
    const http = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { status: 200, headers: {}, text: "", json: undefined, bytes: bytes(8) };
    }) as HttpFn;

    const cache = createImageCache({ adapter, http, enabled: true, folder: "Img" });
    const entries = Array.from({ length: 12 }, (_, i) => ({
      key: TITLE(`t${i}`),
      url: `https://example.com/${i}.jpg`,
    }));
    const result = await cache.warm(entries, { concurrency: 3 });
    expect(result).toEqual({ downloaded: 12, skipped: 0, failed: 0 });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("counts a dead CDN as failed and keeps going", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: failingHttp().http, enabled: true, folder: "Img" });
    const result = await cache.warm([
      { key: TITLE("t1"), url: REMOTE },
      { key: TITLE("t2"), url: "https://example.com/b.jpg" },
    ]);
    expect(result).toEqual({ downloaded: 0, skipped: 0, failed: 2 });
    expect(adapter.files.size).toBe(0);
  });
});

describe("orphans and purging", () => {
  async function seeded(): Promise<{ adapter: FakeAdapter; cache: ImageCache }> {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    await cache.ensure(TITLE("t1"), REMOTE);
    await cache.ensure(TITLE("t2"), "https://example.com/b.jpg");
    return { adapter, cache };
  }

  it("reports what nothing references, and deletes nothing on its own", async () => {
    const { adapter, cache } = await seeded();
    const orphans = cache.findOrphans([{ key: TITLE("t1"), url: REMOTE }]);
    expect(orphans).toEqual([`Img/${cacheFileName(TITLE("t2"), "https://example.com/b.jpg")}`]);
    // Reporting is not deleting.
    expect(adapter.countOf("remove")).toBe(0);
    expect(adapter.files.size).toBe(2);
  });

  it("counts a replaced poster url as an orphan", async () => {
    const { cache } = await seeded();
    // `t1` now points somewhere else; its old file is no longer referenced.
    const orphans = cache.findOrphans([
      { key: TITLE("t1"), url: "https://example.com/new.jpg" },
      { key: TITLE("t2"), url: "https://example.com/b.jpg" },
    ]);
    expect(orphans).toEqual([`Img/${cacheFileName(TITLE("t1"), REMOTE)}`]);
  });

  it("removes exactly the paths it is handed", async () => {
    const { adapter, cache } = await seeded();
    const target = `Img/${cacheFileName(TITLE("t2"), "https://example.com/b.jpg")}`;
    const result = await cache.purge([target]);

    expect(result.removed).toEqual([target]);
    expect(result.failed).toEqual([]);
    expect(adapter.files.has(target)).toBe(false);
    expect(adapter.files.has(`Img/${cacheFileName(TITLE("t1"), REMOTE)}`)).toBe(true);
    expect(cache.stats().files).toBe(1);
    expect(cache.resolve(TITLE("t2"), "https://example.com/b.jpg")).toBe("");
  });

  it("refuses to delete anything outside its own folder", async () => {
    const { adapter, cache } = await seeded();
    const bad = ["Notes/important.md", "../../data.json", "Img/../Notes/x.md", "Img/sub/x.jpg", "Img/"];
    adapter.files.set("Notes/important.md", bytes(1));

    const result = await cache.purge(bad);
    expect(result.removed).toEqual([]);
    expect(result.failed.map((f) => f.path)).toEqual(bad);
    expect(adapter.countOf("remove")).toBe(0);
    expect(adapter.files.has("Notes/important.md")).toBe(true);
  });

  it("an adapter that refuses the delete is reported, not swallowed", async () => {
    const { adapter, cache } = await seeded();
    const target = `Img/${cacheFileName(TITLE("t1"), REMOTE)}`;
    adapter.remove = async () => {
      throw new Error("read-only vault");
    };
    const result = await cache.purge([target]);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ path: target, error: "read-only vault" }]);
  });
});

describe("the polite-fetch seam", () => {
  it("uses the injected fetcher and never touches the raw transport", async () => {
    // Stands in for the reading domain's rate-limited Open Library client.
    const asked: string[] = [];
    const polite = async (url: string): Promise<ArrayBuffer | null> => {
      asked.push(url);
      return bytes(32);
    };
    const adapter = new FakeAdapter();
    const cache = createImageCache({
      adapter,
      http: forbiddenHttp,
      fetchBytes: polite,
      enabled: true,
      folder: "Img",
    });

    const cover = "https://covers.openlibrary.org/b/isbn/9780141036144-L.jpg";
    const path = await cache.ensure({ scope: "book", id: "OL123M" }, cover);
    expect(path).toBe(`Img/${cacheFileName({ scope: "book", id: "OL123M" }, cover)}`);
    expect(asked).toEqual([cover]);
    expect(adapter.files.has(path)).toBe(true);
  });

  it("treats a null from the fetcher as a miss, not a file", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({
      adapter,
      http: forbiddenHttp,
      fetchBytes: async () => null,
      enabled: true,
      folder: "Img",
    });
    expect(await cache.ensure({ scope: "book", id: "OL123M" }, REMOTE)).toBe("");
    expect(adapter.files.size).toBe(0);
    expect(adapter.strayTempFiles()).toEqual([]);
  });

  it("a throwing fetcher leaves nothing behind", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({
      adapter,
      http: forbiddenHttp,
      fetchBytes: async () => {
        throw new Error("rate limiter said no");
      },
      enabled: true,
      folder: "Img",
    });
    expect(await cache.ensure({ scope: "book", id: "OL123M" }, REMOTE)).toBe("");
    expect(adapter.files.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The render seam
// ---------------------------------------------------------------------------

describe("posterUrlFor with a cache", () => {
  it("is unchanged when no cache is passed", () => {
    expect(posterUrlFor(title({ posterUrl: "a.jpg", manualPosterUrl: "b.jpg" }))).toBe("b.jpg");
    expect(posterUrlFor(title({ posterUrl: "a.jpg" }))).toBe("a.jpg");
    expect(posterUrlFor(title({ posterUrl: "none", manualPosterUrl: "none" }))).toBe("");
    expect(posterUrlFor(title())).toBe("");
    expect(posterSourceUrl(title({ posterUrl: "a.jpg", manualPosterUrl: "b.jpg" }))).toBe("b.jpg");
  });

  it("prefers the cached file once it exists", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const entry = title({ id: "t1", posterUrl: "/abc.jpg" });

    // Before caching: the remote URL, exactly as today.
    expect(posterUrlFor(entry, cache)).toBe("/abc.jpg");

    await cache.warm(posterCacheEntries([entry]));
    expect(posterUrlFor(entry, cache)).toBe(
      `app://vault/Img/${cacheFileName(TITLE("t1"), REMOTE)}?1700000000`,
    );
  });

  it("keeps the manual override winning, and caches that url rather than the api one", async () => {
    const adapter = new FakeAdapter();
    const net = okHttp();
    const cache = createImageCache({ adapter, http: net.http, enabled: true, folder: "Img" });
    const entry = title({ id: "t1", posterUrl: "/abc.jpg", manualPosterUrl: "https://mine/x.png" });

    await cache.warm(posterCacheEntries([entry]));
    expect(net.urls).toEqual(["https://mine/x.png"]);
    expect(posterUrlFor(entry, cache)).toBe(
      `app://vault/Img/${cacheFileName(TITLE("t1"), "https://mine/x.png")}?1700000000`,
    );
  });

  it("serves the new art after the user changes the override", async () => {
    const adapter = new FakeAdapter();
    const cache = createImageCache({ adapter, http: okHttp().http, enabled: true, folder: "Img" });
    const entry = title({ id: "t1", manualPosterUrl: "https://mine/old.png" });
    await cache.warm(posterCacheEntries([entry]));

    entry.manualPosterUrl = "https://mine/new.png";
    // The old file is no longer what this title resolves to.
    expect(posterUrlFor(entry, cache)).toBe("https://mine/new.png");
    await cache.warm(posterCacheEntries([entry]));
    expect(posterUrlFor(entry, cache)).toBe(
      `app://vault/Img/${cacheFileName(TITLE("t1"), "https://mine/new.png")}?1700000000`,
    );
    expect(cache.findOrphans(posterCacheEntries([entry]))).toEqual([
      `Img/${cacheFileName(TITLE("t1"), "https://mine/old.png")}`,
    ]);
  });

  it("falls back to the remote url when the cache throws", () => {
    const entry = title({ id: "t1", posterUrl: "/abc.jpg" });
    const broken = {
      resolve(): string {
        throw new Error("index is on fire");
      },
    };
    expect(posterUrlFor(entry, broken)).toBe("/abc.jpg");
  });

  it("discards a cached answer that looks like a bare vault path", () => {
    const entry = title({ id: "t1", posterUrl: "/abc.jpg" });
    // A leading `/` would be read as a TMDB poster path downstream.
    expect(posterUrlFor(entry, { resolve: () => "/Img/t1-abc.jpg" })).toBe("/abc.jpg");
    expect(posterUrlFor(entry, { resolve: () => "" })).toBe("/abc.jpg");
  });

  it("skips posterless titles when building warm entries", () => {
    const entries = posterCacheEntries([
      title({ id: "a", posterUrl: "/abc.jpg" }),
      title({ id: "b" }),
      title({ id: "c", posterUrl: "none" }),
      title({ id: "d", manualPosterUrl: "https://mine/x.png" }),
    ]);
    expect(entries).toEqual([
      { key: TITLE("a"), url: REMOTE },
      { key: TITLE("d"), url: "https://mine/x.png" },
    ]);
  });
});
