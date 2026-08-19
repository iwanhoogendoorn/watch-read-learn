/**
 * Setting a book's cover by hand.
 *
 * THE BOOK THAT MADE THIS NECESSARY
 * ---------------------------------
 * "Traditional vs Generative AI Pentesting" is on a real shelf and has no cover
 * anywhere: Open Library holds the record without an image, and Google's
 * keyless CDN answers its grey "image not available" PNG — which `covers.ts`
 * refuses on magic bytes, correctly, because every real cover is a JPEG. Every
 * automatic route is exhausted and every one of them is right to give up. So
 * the shelf drew a blank tile and there was nothing the user could do about it.
 *
 * What these pin down, in the order it would hurt to lose them:
 *
 *   1. **A hand-set cover wins, everywhere.** Grid, table, both detail
 *      surfaces, the generated note and the artwork cache all read one
 *      function, so none of them can disagree about which picture a book has.
 *   2. **It survives a refresh.** It lives beside `coverUrl`, not in it, so a
 *      catalogue write cannot touch it — the same relationship `manualPosterUrl`
 *      has with `posterUrl`.
 *   3. **It is never an orphan.** A file the user chose deliberately must never
 *      appear in the "remove unreferenced artwork" list. That is the failure
 *      mode with real consequences: it deletes the only copy of a picture that
 *      exists nowhere else.
 *   4. **Rubbish is refused before it is written.** Not an image, or too big,
 *      and nothing reaches the vault.
 *   5. **The cache setting does not own it.** Artwork caching is a convenience
 *      whose absence costs a round trip; this file is the only copy of a
 *      picture there is. It is written and rendered with the setting off.
 *   6. **It can be undone**, and the catalogue picks straight back up.
 *
 * No network: no client is injected anywhere here, and the one adapter is in
 * memory.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  MANUAL_COVER_KEY,
  clearCoverCaches,
  coverSource,
  coverSourceUrl,
  isVaultCoverPath,
  manualCoverUrl,
  readingCacheEntries,
  type CoverCache,
} from "../src/domains/reading/covers";
import { renderReadingCover as renderCardCover } from "../src/domains/reading/card";
import { renderReadingCover as renderDetailCover } from "../src/domains/reading/detail/sections";
import {
  MANUAL_COVER_MAX_BYTES,
  checkCoverBytes,
  checkCoverSize,
  imageKindOf,
  manualCoverSeed,
  saveManualCover,
} from "../src/domains/reading/manualcover";
import { buildReadingFrontmatter } from "../src/domains/reading/notes";
import {
  ImageCache,
  cacheFileName,
  IMAGE_SCOPE,
  type ImageCacheAdapter,
} from "../src/services/imagecache";
import { WatchLogStore } from "../src/data/store";
import { createBook, createReadingData } from "../src/data/schema";
import { createReadingStore, type ReadingStore } from "../src/domains/reading/store";
import { ReadingDetailModal } from "../src/domains/reading/modals/detail";
import { mountBookDetail, type BookDetailController } from "../src/ui/views/book-detail";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import { readExtra, type Book, type PosterLoader } from "../src/types";

// ---------------------------------------------------------------------------
// Bytes, real ones
// ---------------------------------------------------------------------------

const bytesOf = (...header: number[]): ArrayBuffer =>
  new Uint8Array([...header, 1, 2, 3, 4]).buffer;

const JPEG = (): ArrayBuffer => bytesOf(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0);
const PNG = (): ArrayBuffer => bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const GIF = (): ArrayBuffer => bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0);
const WEBP = (): ArrayBuffer =>
  bytesOf(0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
/** `%PDF-1.7` — the thing most likely to be picked by mistake. */
const PDF = (): ArrayBuffer => bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 0, 0, 0);
/** `<svg xmlns` — a document with script in it, not a picture. */
const SVG = (): ArrayBuffer =>
  new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").buffer;

const CACHE_FOLDER = "WRL/images";

// ---------------------------------------------------------------------------
// An in-memory vault
// ---------------------------------------------------------------------------

class FakeAdapter implements ImageCacheAdapter {
  files = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  failWrites = false;

  async exists(path: string): Promise<boolean> {
    // A folder holding files exists whether or not anything called `mkdir` —
    // otherwise a fixture that seeds a file directly is invisible to `prime()`.
    return (
      this.files.has(path) ||
      this.folders.has(path) ||
      [...this.files.keys()].some((p) => p.startsWith(`${path}/`))
    );
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
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
  return new ImageCache({ adapter, enabled, folder: CACHE_FOLDER });
}

/** A book with a manual cover already set, without going through the UI. */
function bookWith(manual: string, over: Partial<Book> = {}): Book {
  const book = createBook({ id: "b1", title: "Traditional vs Generative AI Pentesting" });
  Object.assign(book, over);
  if (manual !== "") Object.assign(book, { [MANUAL_COVER_KEY]: manual });
  return book;
}

/** A poster loader that records what it was asked to draw, and draws nothing. */
function recordingLoader(): PosterLoader & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    observe: (_el: HTMLElement, url: string) => void seen.push(url),
    unobserve: () => undefined,
    destroy: () => undefined,
  } as unknown as PosterLoader & { seen: string[] };
}

const OL_COVER = "https://covers.openlibrary.org/b/isbn/9781484267073-M.jpg?default=false";

// ---------------------------------------------------------------------------

let restore: () => void;

beforeEach(() => {
  clearCoverCaches();
  restore = installDomGlobals(1200);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------

describe("which picture a book has", () => {
  it("prefers the hand-set cover over the catalogue's", () => {
    const book = bookWith("https://example.com/mine.jpg", { coverUrl: OL_COVER });
    expect(coverSourceUrl(book)).toBe("https://example.com/mine.jpg");
  });

  it("falls back to the catalogue when nothing was set by hand", () => {
    expect(coverSourceUrl(bookWith("", { coverUrl: OL_COVER }))).toBe(OL_COVER);
  });

  it("reads v3's `none` sentinel as no cover at all, on either field", () => {
    expect(coverSourceUrl(bookWith("none", { coverUrl: OL_COVER }))).toBe(OL_COVER);
    expect(coverSourceUrl(bookWith("", { coverUrl: "none" }))).toBe("");
  });

  it("ignores a non-string that got into `data.json` somehow", () => {
    const book = createBook({ id: "b1", title: "Dune" });
    Object.assign(book, { [MANUAL_COVER_KEY]: 42 });
    expect(manualCoverUrl(book)).toBe("");
  });

  it("tells a vault path from everything that is fetched or resolved", () => {
    expect(isVaultCoverPath("WRL/images/book-b1-abc.jpg")).toBe(true);
    expect(isVaultCoverPath("https://example.com/a.jpg")).toBe(false);
    expect(isVaultCoverPath("data:image/png;base64,AAA")).toBe(false);
    expect(isVaultCoverPath("app://vault/x.jpg")).toBe(false);
    expect(isVaultCoverPath("//example.com/a.jpg")).toBe(false);
    // A leading slash is the one shape `resolvePosterUrl` reads as a TMDB path.
    expect(isVaultCoverPath("/WRL/images/a.jpg")).toBe(false);
    expect(isVaultCoverPath("C:\\pictures\\a.jpg")).toBe(false);
  });

  it("resolves a hand-set file through the vault adapter, never as a raw path", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const path = `${CACHE_FOLDER}/book-b1-manual.jpg`;
    adapter.files.set(path, JPEG());
    await cache.prime();

    const source = coverSource(bookWith(path), cache);
    expect(source.direct).toBe(true);
    expect(source.url).toBe(`app://vault/${path}?1700000000`);
  });

  it("falls through to the catalogue when the hand-set file has gone", async () => {
    // Deleted in Finder. Drawing a broken `<img>` would be a worse answer than
    // drawing the cover the catalogue still has.
    const cache = realCache(new FakeAdapter());
    await cache.prime();
    const source = coverSource(
      bookWith(`${CACHE_FOLDER}/gone.jpg`, { coverUrl: OL_COVER }),
      cache,
    );
    expect(source).toEqual({ url: OL_COVER, direct: false });
  });

  it("refuses to resolve a path outside the artwork folder", async () => {
    const adapter = new FakeAdapter();
    adapter.files.set("Private/diary.jpg", JPEG());
    const cache = realCache(adapter);
    await cache.prime();
    const source = coverSource(bookWith("Private/diary.jpg"), cache);
    expect(source).toEqual({ url: "", direct: false });
  });
});

// ---------------------------------------------------------------------------

describe("what may be written into the vault", () => {
  it("recognises the four raster formats a cover may be", () => {
    expect(imageKindOf(JPEG())).toBe("jpg");
    expect(imageKindOf(PNG())).toBe("png");
    expect(imageKindOf(GIF())).toBe("gif");
    expect(imageKindOf(WEBP())).toBe("webp");
  });

  it("refuses anything that is not one, by its bytes rather than its name", () => {
    expect(imageKindOf(PDF())).toBe("");
    expect(imageKindOf(SVG())).toBe("");
    expect(imageKindOf(new ArrayBuffer(0))).toBe("");
    const check = checkCoverBytes(PDF());
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.error).toMatch(/not an image/i);
  });

  it("caps the size, and says what the cap is", () => {
    const huge = new ArrayBuffer(MANUAL_COVER_MAX_BYTES + 1);
    new Uint8Array(huge).set([0xff, 0xd8, 0xff]);
    const check = checkCoverBytes(huge);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.error).toMatch(/8\.0 MB/);
  });

  it("refuses an oversized file before reading it, from the size alone", () => {
    expect(checkCoverSize(MANUAL_COVER_MAX_BYTES + 1)?.error).toMatch(/capped at/);
    expect(checkCoverSize(MANUAL_COVER_MAX_BYTES)).toBeNull();
  });

  it("names the file from the bytes, not from what the file claimed to be", () => {
    // A PNG called `cover.jpg` is a PNG.
    expect(manualCoverSeed("b1", "png", 0)).toMatch(/\.png$/);
  });
});

// ---------------------------------------------------------------------------

describe("keeping a picture the user picked", () => {
  it("writes it into the artwork folder under the cache's own naming", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);

    const result = await saveManualCover(cache, "b1", PNG(), () => 1);
    expect("path" in result).toBe(true);
    const path = "path" in result ? result.path : "";

    // Not a new convention: the exact name `cacheFileName` gives the book scope.
    const expected = cacheFileName(
      { scope: IMAGE_SCOPE.book, id: "b1" },
      manualCoverSeed("b1", "png", 1),
    );
    expect(path).toBe(`${CACHE_FOLDER}/${expected}`);
    expect(adapter.files.has(path)).toBe(true);
    // The extension came off the bytes.
    expect(path.endsWith(".png")).toBe(true);
  });

  it("leaves nothing behind when the write fails, and says so", async () => {
    const adapter = new FakeAdapter();
    adapter.failWrites = true;
    const result = await saveManualCover(realCache(adapter), "b1", JPEG(), () => 1);
    expect("error" in result).toBe(true);
    expect(adapter.files.size).toBe(0);
  });

  it("refuses a file that is not an image, without touching the vault", async () => {
    const adapter = new FakeAdapter();
    const result = await saveManualCover(realCache(adapter), "b1", PDF(), () => 1);
    expect("error" in result && result.error).toMatch(/not an image/i);
    expect(adapter.files.size).toBe(0);
  });

  it("refuses an oversized image, without touching the vault", async () => {
    const adapter = new FakeAdapter();
    const huge = new ArrayBuffer(MANUAL_COVER_MAX_BYTES + 1);
    new Uint8Array(huge).set([0xff, 0xd8, 0xff]);
    const result = await saveManualCover(realCache(adapter), "b1", huge, () => 1);
    expect("error" in result && result.error).toMatch(/capped at/);
    expect(adapter.files.size).toBe(0);
  });

  it("gives a second pick its own file rather than colliding with the first", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const first = await saveManualCover(cache, "b1", JPEG(), () => 1);
    const second = await saveManualCover(cache, "b1", PNG(), () => 2);
    expect("path" in first && "path" in second && first.path).not.toBe(
      "path" in second ? second.path : "",
    );
    expect(adapter.files.size).toBe(2);
  });

  it("works with artwork caching switched off — the file is the user's, not a cache entry", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter, false);

    const result = await saveManualCover(cache, "b1", JPEG(), () => 1);
    expect("path" in result).toBe(true);
    const path = "path" in result ? result.path : "";
    expect(adapter.files.has(path)).toBe(true);

    // And it still renders: `resolve()` is off, `resourcePath` is not.
    expect(cache.resolve({ scope: IMAGE_SCOPE.book, id: "b1" }, path)).toBe("");
    expect(coverSource(bookWith(path), cache)).toEqual({
      url: `app://vault/${path}?1700000000`,
      direct: true,
    });
  });
});

// ---------------------------------------------------------------------------

describe("the artwork folder never offers a hand-set cover for deletion", () => {
  async function folderWith(manual: string, over: Partial<Book> = {}) {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const book = bookWith(manual, over);
    return { adapter, cache, book };
  }

  it("counts the file as referenced, so it is not an orphan", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const saved = await saveManualCover(cache, "b1", JPEG(), () => 1);
    const path = "path" in saved ? saved.path : "";
    await cache.prime();

    const book = bookWith(path, { coverUrl: OL_COVER });
    expect(cache.findOrphans(readingCacheEntries({ books: [book], manga: [] }))).toEqual([]);
  });

  it("reports it the moment the book stops pointing at it, and not before", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const saved = await saveManualCover(cache, "b1", JPEG(), () => 1);
    const path = "path" in saved ? saved.path : "";
    await cache.prime();

    // The user reverted to the catalogue cover: now nothing draws the file.
    const reverted = bookWith("", { coverUrl: OL_COVER });
    expect(cache.findOrphans(readingCacheEntries({ books: [reverted], manga: [] }))).toEqual([
      path,
    ]);
  });

  it("makes a hand-set URL the book's one candidate", async () => {
    // `OL_COVER` embeds the ISBN, so without the manual cover this book would
    // carry the Google-by-ISBN fallback as an alternate.
    const { book } = await folderWith("https://example.com/mine.jpg", { coverUrl: OL_COVER });
    const entries = readingCacheEntries({ books: [book], manga: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe("https://example.com/mine.jpg");
    // Not the catalogue's, and not the Google-by-ISBN fallback either: a warm
    // pass should keep the picture the user sees, not the two they rejected.
    expect(entries[0]?.alternates).toBeUndefined();
  });

  it("has nothing to download for a hand-set file", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const saved = await saveManualCover(cache, "b1", JPEG(), () => 1);
    const path = "path" in saved ? saved.path : "";
    const before = adapter.files.size;

    const result = await cache.warm(
      readingCacheEntries({ books: [bookWith(path)], manga: [] }),
    );
    expect(result).toEqual({ downloaded: 0, skipped: 0, failed: 0 });
    expect(adapter.files.size).toBe(before);
  });

  it("still refuses to purge anything outside its own folder", async () => {
    const adapter = new FakeAdapter();
    adapter.files.set("Private/diary.jpg", JPEG());
    const cache = realCache(adapter);
    const result = await cache.purge(["Private/diary.jpg"]);
    expect(result.removed).toEqual([]);
    expect(adapter.files.has("Private/diary.jpg")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("a hand-set cover on the shelves", () => {
  it("is what the grid and the table draw", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const path = `${CACHE_FOLDER}/book-b1-manual.jpg`;
    adapter.files.set(path, JPEG());
    await cache.prime();

    const loader = recordingLoader();
    const poster = createHost(200);
    const handle = renderCardCover(
      poster as unknown as HTMLElement,
      bookWith(path, { coverUrl: OL_COVER }) as never,
      { posterLoader: loader, imageCache: cache },
    );

    // Nothing was fetched, so there is no object URL to release.
    expect(handle).toBeNull();
    expect(loader.seen).toEqual([`app://vault/${path}?1700000000`]);
  });

  it("is what a pasted URL puts on the grid, straight through the lazy loader", () => {
    const loader = recordingLoader();
    const poster = createHost(200);
    renderCardCover(
      poster as unknown as HTMLElement,
      bookWith("https://example.com/mine.jpg", { coverUrl: OL_COVER }) as never,
      { posterLoader: loader },
    );
    // The catalogue's Open Library URL would have gone down the polite path
    // instead; the user's does not need to.
    expect(loader.seen).toEqual(["https://example.com/mine.jpg"]);
  });

  it("is what the detail surfaces draw, with no fetch and no blob", async () => {
    const adapter = new FakeAdapter();
    const cache = realCache(adapter);
    const path = `${CACHE_FOLDER}/book-b1-manual.jpg`;
    adapter.files.set(path, JPEG());
    await cache.prime();

    const host = createHost(600);
    const handle = renderDetailCover(
      host as unknown as HTMLElement,
      bookWith(path, { coverUrl: OL_COVER }) as never,
      { imageCache: cache },
    );
    expect(handle).toBeNull();
    const img = host.querySelector("img");
    expect(img?.src).toBe(`app://vault/${path}?1700000000`);
  });

  it("is what the generated note quotes", () => {
    const book = bookWith("https://example.com/mine.jpg", { coverUrl: OL_COVER });
    const yaml = buildReadingFrontmatter(book, "book", createReadingData(), new Date("2026-08-18"));
    expect(yaml).toContain('cover: "https://example.com/mine.jpg"');
    expect(yaml).not.toContain(OL_COVER);
  });
});

// ---------------------------------------------------------------------------

describe("on both detail surfaces, through the store", () => {
  async function shelf(over: Partial<Book> & Record<string, unknown> = {}) {
    const store = new WatchLogStore({
      loadData: async () => null,
      saveData: async () => undefined,
    } as never);
    await store.load();
    const reading: ReadingStore = createReadingStore(store);
    const book = createBook({ id: "b", title: "Dune", coverUrl: OL_COVER });
    Object.assign(book, over);
    reading.reading.books.push(book);
    return { store, reading, book };
  }

  async function openModal(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const modal = new ReadingDetailModal({} as never, {
      store: reading,
      watch: store as never,
      kind: "book",
      id: "b",
    });
    const contentEl = createHost(1200);
    Object.assign(modal as unknown as Record<string, unknown>, {
      contentEl,
      modalEl: createHost(1200),
      close: () => undefined,
    });
    modal.onOpen();
    return { store, reading, book, el: contentEl as unknown as StubEl };
  }

  async function openView(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: {} as never, store: store as never, reading },
    );
    return { store, reading, book, pane, el: host as unknown as StubEl };
  }

  function coverField(el: StubEl): StubEl {
    const field = el
      .querySelectorAll("input")
      .find((node) => node.getAttribute("aria-label") === "Cover URL");
    if (!field) throw new Error("no Cover URL field");
    return field;
  }

  function buttonLabelled(el: StubEl, text: string): StubEl | undefined {
    return el.querySelectorAll("button").find((node) => node.textContent === text);
  }

  for (const [name, open] of [
    ["the modal", openModal],
    ["the view", openView],
  ] as const) {
    it(`${name}: pasting a URL sets the cover for good, leaving the catalogue's alone`, async () => {
      const { book, el } = await open();
      const field = coverField(el);
      // The field shows the effective cover, which starts as the catalogue's.
      expect(field.value).toBe(OL_COVER);

      field.value = "https://example.com/mine.jpg";
      field.fire("change");

      expect(readExtra(book, MANUAL_COVER_KEY)).toBe("https://example.com/mine.jpg");
      // Untouched, which is what makes reverting a one-field write.
      expect(book.coverUrl).toBe(OL_COVER);
      expect(coverSourceUrl(book)).toBe("https://example.com/mine.jpg");
    });

    it(`${name}: offers a way back to the catalogue, and only when there is one to go back to`, async () => {
      const fresh = await open();
      expect(buttonLabelled(fresh.el, "Use catalogue cover")).toBeUndefined();
      expect(buttonLabelled(fresh.el, "Choose image…")).toBeDefined();

      const set = await open({ [MANUAL_COVER_KEY]: "https://example.com/mine.jpg" });
      const revert = buttonLabelled(set.el, "Use catalogue cover");
      expect(revert).toBeDefined();

      revert?.fire("click");
      expect(readExtra(set.book, MANUAL_COVER_KEY)).toBe("");
      expect(coverSourceUrl(set.book)).toBe(OL_COVER);
    });

    it(`${name}: clearing the field is the same undo`, async () => {
      const { book, el } = await open({ [MANUAL_COVER_KEY]: "https://example.com/mine.jpg" });
      const field = coverField(el);
      expect(field.value).toBe("https://example.com/mine.jpg");

      field.value = "";
      field.fire("change");

      expect(coverSourceUrl(book)).toBe(OL_COVER);
    });
  }

  it("survives a metadata refresh writing the catalogue's cover", async () => {
    const { reading, book } = await shelf({
      [MANUAL_COVER_KEY]: "https://example.com/mine.jpg",
    });
    // Exactly what a refresh does: write `coverUrl` and nothing else.
    reading.update("book", "b", { coverUrl: "https://covers.example/new.jpg" }, "refresh");

    expect(book.coverUrl).toBe("https://covers.example/new.jpg");
    expect(coverSourceUrl(book)).toBe("https://example.com/mine.jpg");
  });

  it("is a preserved key, so `data.json` round-trips it untouched", async () => {
    const { reading, book } = await shelf();
    reading.update("book", "b", { [MANUAL_COVER_KEY]: "WRL/images/x.jpg" } as never, "manual");
    expect(readExtra(book, MANUAL_COVER_KEY)).toBe("WRL/images/x.jpg");
  });
});
