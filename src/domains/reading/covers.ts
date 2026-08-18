/**
 * Cover images that respect Open Library's terms (W8 review P1-5).
 *
 * The rule from `docs/research/report-media-apis.md` §2.1: covers count against
 * the same rate limit as the API, an identified caller gets 3 req/s and an
 * unidentified one gets 1. Assigning `covers.openlibrary.org/...` to an
 * `<img src>` breaks both halves of that — the request is Chromium's, so it
 * carries none of our headers and passes through none of our limiter — and a
 * search showing ten results fires ten of them at once.
 *
 * So Open Library covers are fetched as bytes through the client and rendered
 * from an object URL. Everything else (Google Books thumbnails, a user's own
 * pasted link) is assigned directly, because nothing about those asks otherwise.
 *
 * Object URLs are revoked: an unrevoked one pins its blob for the lifetime of
 * the window, and a reading list scrolled for a while would accumulate them.
 *
 * THE COST THAT BUYS, AND HOW IT IS PAID BACK
 * -------------------------------------------
 * That polite path is *serial*: five Open Library covers are ~1.7s of queue
 * before any bytes move, shared with search and metadata, and the revoke means
 * every re-render pays it again. Two caches sit in front of it, and neither one
 * makes the network path any less polite — a miss still goes through the client.
 *
 *   - **The local artwork cache** (`services/imagecache.ts`, `book` scope), when
 *     the user has turned it on. A cover kept there is a file in their vault:
 *     instant, no limiter, no object URL, and available on a plane. It is also
 *     the *politest* outcome available — each cover is fetched exactly once
 *     ever, instead of once per render, forever.
 *   - **This session's bytes**, always. A bounded LRU of `ArrayBuffer`s (not
 *     blobs — nothing here pins an object URL) so a live search re-rendering on
 *     every keystroke repaints from memory instead of re-queueing.
 *
 * Neither cache is ever *fetched from* by this module: the local one is asked
 * synchronously and told about bytes we already paid for.
 */
import { OPEN_LIBRARY_COVERS } from "../../services/openlibrary";
import type { OpenLibraryClient } from "../../types";

/** Does this URL need the polite path? */
export function needsProxy(url: string): boolean {
  return url.startsWith(OPEN_LIBRARY_COVERS);
}

// ---------------------------------------------------------------------------
// Google cover fallback
//
// Open Library's coverage has real holes — niche technical books are indexed
// with no cover at all, and the `b/isbn/…?default=false` URL the add flow
// stores comes back 404. Google's *content* CDN
// (`books.google.com/books/content?vid=ISBN…`) is keyless and does not share
// the Books API's anonymous quota, so it is a polite second try, not a
// workaround. Its one quirk: a miss is not a 404 but a 200 with a grey
// "image not available" placeholder — which is a PNG, where every real cover
// is a JPEG. The magic bytes are the discriminator.
// ---------------------------------------------------------------------------

/** The keyless Google Books cover for an ISBN. */
export function googleCoverUrl(isbn: string): string {
  return `https://books.google.com/books/content?vid=ISBN${encodeURIComponent(isbn)}&printsec=frontcover&img=1&zoom=1`;
}

const OL_ISBN_COVER = /\/b\/isbn\/(\d{9,12}[\dXx])[.-]/;

/**
 * The ISBN a fallback lookup can use: the entry's own field when present,
 * else the one embedded in a stored Open Library ISBN-cover URL — the add
 * flow never wrote `isbn` as its own field, so for existing rows the URL is
 * the only place it survives.
 */
export function coverIsbn(entry: { isbn?: string | null; coverUrl?: string }): string {
  const own = (entry.isbn ?? "").trim();
  if (own !== "") return own.replace(/-/g, "");
  const match = OL_ISBN_COVER.exec(entry.coverUrl ?? "");
  return match?.[1] ?? "";
}

/** Real Google covers are JPEGs; the "image not available" placeholder is a PNG. */
export function looksLikeJpeg(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 3) return false;
  const view = new Uint8Array(bytes, 0, 3);
  return view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
}

/**
 * Fetched Google covers by ISBN, misses included — a book Google has never
 * heard of must not be re-asked on every keystroke of a live search.
 * Module-level for the same reason the poster failure cache is.
 */
const googleCoverCache = new Map<string, ArrayBuffer | "none">();

// ---------------------------------------------------------------------------
// The local artwork cache, as this module sees it
// ---------------------------------------------------------------------------

/**
 * The slice of `services/imagecache.ts` a cover needs.
 *
 * Declared structurally rather than imported, the same way `PosterCacheLookup`
 * is: this module stays free of the service, and a lane with a stand-in cache
 * satisfies it in four lines.
 *
 * `resolve` is synchronous and must never throw — it is called inside the paint.
 * The two writers are optional and always fire-and-forget: a cache that cannot
 * write is a cache that is not there, which is today's behaviour.
 */
export interface CoverCache {
  /** Vault resource URL for a cached image, or `""`. Must not await or throw. */
  resolve(key: { scope: string; id: string }, remoteUrl: string): string;
  /** Fetch and keep a URL we are not fetching ourselves. */
  ensure?(key: { scope: string; id: string }, remoteUrl: string): Promise<string>;
  /** Keep bytes we already have — no second request. */
  store?(key: { scope: string; id: string }, remoteUrl: string, bytes: ArrayBuffer): Promise<string>;
}

/**
 * The cache scope books live in (`IMAGE_SCOPE.book`).
 *
 * Not decoration: this plugin also holds films and games, and an Open Library
 * id can equal a TMDB id. Without the scope a book cover would eventually be
 * served as a film poster.
 */
export const COVER_CACHE_SCOPE = "book";

function cacheKeyFor(id: string | undefined): { scope: string; id: string } | null {
  const trimmed = (id ?? "").trim();
  return trimmed === "" ? null : { scope: COVER_CACHE_SCOPE, id: trimmed };
}

/**
 * The local copy of a cover, or `""`. Never throws and never awaits — a broken
 * cache falls back to the network path rather than blanking the cover.
 *
 * A bare vault path is discarded for the same reason `posterUrlFor` discards
 * one: the lazy poster loader reads a leading `/` as a TMDB poster path and
 * would rewrite it into a CDN URL.
 */
export function localCoverUrl(cache: CoverCache | undefined, id: string, url: string): string {
  const key = cacheKeyFor(id);
  if (!cache || !key || url === "") return "";
  try {
    const local = cache.resolve(key, url);
    return typeof local === "string" && local !== "" && !local.startsWith("/") ? local : "";
  } catch {
    return "";
  }
}

/**
 * Ask the cache to keep a URL the *browser* is fetching (a Google Books
 * thumbnail, a pasted link). We have no bytes for those — the `<img>` request
 * is Chromium's — so the cache fetches its own copy, once.
 *
 * Worth the one extra request: the setting is "keep local copies of artwork",
 * and a book whose cover is a Google thumbnail would otherwise be the one blank
 * card on a plane. Nothing waits on it, and it is a no-op when the cache is off.
 */
export function keepCover(cache: CoverCache | undefined, id: string, url: string): void {
  const key = cacheKeyFor(id);
  if (!cache?.ensure || !key || url === "") return;
  try {
    void cache.ensure(key, url).catch(() => undefined);
  } catch {
    // A cache that throws on sight is a cache that is not there.
  }
}

/** The bit of a book or manga row this module needs. Structural, so `Book | Manga` fits. */
export interface CoverRef {
  id: string;
  coverUrl?: string;
  isbn?: string | null;
}

/**
 * How one entry's bytes are obtained: bytes, `null` for "no image — try the next
 * candidate", or `undefined` for "not mine, use the ordinary transport".
 */
export type CoverFetcher = (url: string) => Promise<ArrayBuffer | null | undefined>;

/**
 * `(key, url)` pairs for the reading shelves, for `ImageCache.warm()` and
 * `ImageCache.findOrphans()` — the shape `posterCacheEntries` returns for
 * titles, so the two concatenate:
 *
 *     [...posterCacheEntries(this.store.allTitles()), ...readingCacheEntries(this.store.reading)]
 *
 * **Both call sites need both halves.** Warming with titles only means the
 * `book` scope is never populated and every cover stays on the slow path; but
 * *orphaning* with titles only is worse — every cached book cover is then
 * reported as unreferenced and offered for deletion. Fixing one without the
 * other is a downgrade.
 *
 * Takes the whole `ReadingData` (or any `{ books, manga }`) rather than a
 * flattened list, so a caller cannot accidentally pass the books and forget the
 * manga. Both URLs a book can be drawn from are listed: the stored cover and
 * the Google-by-ISBN fallback.
 *
 * **One entry per book, not one per URL.** The Google-by-ISBN URL is a
 * *fallback* — "Open Library has real holes, Google is a polite second try" —
 * so it rides along as an `alternate`, tried only if the stored cover fails.
 * Queueing it as an equal candidate meant a book whose cover downloaded fine
 * still fetched a second image nobody would look at, and then reported a
 * failure for it: six books produced ten entries and four phantom failures.
 *
 * **Pass the client.** A warm pass downloads through the cache's own transport,
 * which for `covers.openlibrary.org` would be an unidentified request outside
 * the limiter — the one thing this whole module exists to prevent. Every entry
 * therefore carries a router: Open Library through `coverBytes`, everything
 * else (Google's keyless CDN, a pasted link) through the default transport.
 * With no client the Open Library candidate answers "no image" rather than
 * going around the limiter, and the Google fallback picks the book up.
 */
export function readingCacheEntries(
  source: Iterable<CoverRef> | { books?: readonly CoverRef[]; manga?: readonly CoverRef[] },
  client?: Pick<OpenLibraryClient, "coverBytes"> | undefined,
): {
  key: { scope: string; id: string };
  url: string;
  alternates?: readonly string[];
  fetch: CoverFetcher;
}[] {
  const entries: Iterable<CoverRef> =
    Symbol.iterator in Object(source)
      ? (source as Iterable<CoverRef>)
      : [
          ...((source as { books?: readonly CoverRef[] }).books ?? []),
          ...((source as { manga?: readonly CoverRef[] }).manga ?? []),
        ];
  // `undefined` means "not mine, use the ordinary transport" — the answer for
  // every URL that is not Open Library's rate-limited cover CDN.
  const route: CoverFetcher = async (url) =>
    needsProxy(url) ? ((await client?.coverBytes(url)) ?? null) : undefined;

  const out: {
    key: { scope: string; id: string };
    url: string;
    alternates?: readonly string[];
    fetch: CoverFetcher;
  }[] = [];
  for (const entry of entries) {
    const key = cacheKeyFor(entry.id);
    if (!key) continue;
    const candidates: string[] = [];
    const cover = (entry.coverUrl ?? "").trim();
    if (cover !== "" && cover !== "none") candidates.push(cover);
    const isbn = coverIsbn(entry);
    if (isbn !== "") candidates.push(googleCoverUrl(isbn));
    const [primary, ...alternates] = candidates;
    if (primary === undefined) continue;
    out.push(
      alternates.length === 0
        ? { key, url: primary, fetch: route }
        : { key, url: primary, alternates, fetch: route },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// This session's bytes
// ---------------------------------------------------------------------------

/**
 * How many covers stay in memory. Bounded on purpose: an unbounded map of image
 * bytes is a worse bug than a slow load, and the whole reason object URLs are
 * revoked is that pinned images are what hurt this plugin before.
 *
 * `ArrayBuffer`s, not blobs — these hold no object URL, so nothing here changes
 * the release discipline `CoverPool` enforces.
 */
const SESSION_COVER_LIMIT = 64;

/** Fetched cover bytes, most-recently-used last. */
const sessionCovers = new Map<string, ArrayBuffer>();

/** Open Library URLs that answered "no image" this session. Never re-asked. */
const emptyCovers = new Set<string>();

function recallCover(url: string): ArrayBuffer | undefined {
  const bytes = sessionCovers.get(url);
  if (!bytes) return undefined;
  // Re-insert: `Map` iterates in insertion order, which is what makes the
  // eviction below least-recently-used rather than arbitrary.
  sessionCovers.delete(url);
  sessionCovers.set(url, bytes);
  return bytes;
}

function rememberCover(url: string, bytes: ArrayBuffer): void {
  sessionCovers.delete(url);
  sessionCovers.set(url, bytes);
  while (sessionCovers.size > SESSION_COVER_LIMIT) {
    const oldest = sessionCovers.keys().next().value;
    if (oldest === undefined) break;
    sessionCovers.delete(oldest);
  }
}

/** Settings changed / manual refresh — forget every cover this session learned. */
export function clearCoverCaches(): void {
  googleCoverCache.clear();
  sessionCovers.clear();
  emptyCovers.clear();
}

/** The name this had before there was more than one cache behind it. */
export function clearGoogleCoverCache(): void {
  clearCoverCaches();
}

export interface CoverHandle {
  /** Release the object URL, if one was made. Safe to call twice. */
  release(): void;
}

export interface CoverOptions {
  /** Absent means Open Library covers are not fetched at all — see below. */
  client?: OpenLibraryClient | undefined;
  /** Called when there is no image to show, so the caller can draw a placeholder. */
  onMissing?: () => void;
  /** When the primary is missing, try Google's cover CDN for this ISBN. */
  fallbackIsbn?: string;
  /**
   * How fallback bytes are fetched — Obsidian's `requestUrl` in the app,
   * injected so this module stays obsidian-free and tests stay offline.
   * No fetcher, no fallback.
   */
  fetchBytes?: (url: string) => Promise<ArrayBuffer | null>;
  /**
   * The user's local artwork cache, read through and written behind. Absent —
   * which is the default, because the setting is off — is exactly today's
   * behaviour: fetch politely, draw a blob, revoke it.
   */
  cache?: CoverCache | undefined;
  /**
   * The book's stable id, for the cache key. **Absent means nothing is cached
   * to the vault**, which is deliberate for search results: a book the user has
   * only typed at is not a book they have asked us to keep files for. Those
   * still get the in-memory bytes, which is what a live search actually needs.
   */
  cacheId?: string | undefined;
}

/**
 * Point `img` at `url`, politely.
 *
 * In order: the local copy in the user's vault, this session's bytes, the
 * rate-limited client, Google by ISBN, placeholder. Every step before the
 * client is a step the network is not asked — and none of them is a way *around*
 * the client, because the only thing that ever fetches an Open Library cover is
 * still `coverBytes`.
 *
 * With no client and an Open Library URL the image is **left blank** and
 * `onMissing` fires: fetching it impolitely is not a better answer than not
 * showing it, and the placeholder is a perfectly good cover.
 */
export function loadCover(
  img: { src: string; addClass?: (cls: string) => void },
  url: string,
  options: CoverOptions = {},
): CoverHandle {
  let objectUrl: string | null = null;
  const release = (): void => {
    if (objectUrl === null) return;
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };

  const cache = options.cache;
  const cacheId = options.cacheId ?? "";

  const paint = (src: string): void => {
    img.src = src;
    img.addClass?.("is-loaded");
  };

  /**
   * Draw bytes, and keep them.
   *
   * Both caches are told at the point the bytes exist, which is the only place
   * that can promise the network was asked exactly once for them.
   */
  const show = (bytes: ArrayBuffer, from: string): void => {
    rememberCover(from, bytes);
    const key = cacheKeyFor(cacheId);
    if (cache?.store && key) {
      try {
        void cache.store(key, from, bytes).catch(() => undefined);
      } catch {
        // A cache that throws is a cache that is not there. The cover is
        // already on screen either way.
      }
    }
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    paint(objectUrl);
  };

  /** The primary came up empty — Google by ISBN before giving up. */
  const missing = (): void => {
    const isbn = options.fallbackIsbn ?? "";
    if (isbn === "") {
      options.onMissing?.();
      return;
    }
    const target = googleCoverUrl(isbn);

    // A local copy answers with no fetcher and no network at all — which is the
    // whole point, because this is the path the user's real books take.
    const local = localCoverUrl(cache, cacheId, target);
    if (local !== "") {
      paint(local);
      return;
    }

    const fetchBytes = options.fetchBytes;
    if (!fetchBytes) {
      options.onMissing?.();
      return;
    }
    const cached = googleCoverCache.get(isbn);
    if (cached === "none") {
      options.onMissing?.();
      return;
    }
    if (cached) {
      show(cached, target);
      return;
    }
    void fetchBytes(target)
      .then((bytes) => {
        // A Google miss is a 200 with a PNG placeholder, not a 404 — only a
        // JPEG is a real cover. Either way the answer is cached: misses would
        // otherwise be re-fetched on every re-render of a live search.
        if (bytes && looksLikeJpeg(bytes)) {
          googleCoverCache.set(isbn, bytes);
          show(bytes, target);
        } else {
          googleCoverCache.set(isbn, "none");
          options.onMissing?.();
        }
      })
      .catch(() => {
        // Transient failure — no cache entry, so the next render retries.
        options.onMissing?.();
      });
  };

  if (url === "") {
    missing();
    return { release };
  }

  // A file in the user's vault: instant, no limiter, no object URL to revoke,
  // and no request at all. This is checked before anything else because it is
  // the answer for every cover after the first time it was ever fetched.
  const local = localCoverUrl(cache, cacheId, url);
  if (local !== "") {
    paint(local);
    return { release };
  }

  if (!needsProxy(url)) {
    paint(url);
    // The browser is fetching this one, so there are no bytes to hand over —
    // the cache gets its own copy for next time, or does nothing when it is off.
    keepCover(cache, cacheId, url);
    return { release };
  }

  const client = options.client;
  if (!client) {
    missing();
    return { release };
  }

  // Bytes from earlier in this session. A shelf re-rendering on every keystroke
  // must not re-queue behind the 334ms gap for covers it has already fetched.
  const remembered = recallCover(url);
  if (remembered) {
    show(remembered, url);
    return { release };
  }

  // Open Library has already said it has no image for this book. Asking again
  // on every render spends the same rate limit on the same answer.
  if (emptyCovers.has(url)) {
    missing();
    return { release };
  }

  void client
    .coverBytes(url)
    .then((bytes) => {
      if (!bytes || bytes.byteLength === 0) {
        emptyCovers.add(url);
        missing();
        return;
      }
      show(bytes, url);
    })
    .catch(() => {
      // Transient — no negative entry, so the next render tries again.
      missing();
    });

  return { release };
}

/**
 * A set of handles to release together.
 *
 * A list re-renders on every keystroke; without this the blobs from the last
 * render would outlive it.
 */
export class CoverPool {
  private handles: CoverHandle[] = [];

  add(handle: CoverHandle): CoverHandle {
    this.handles.push(handle);
    return handle;
  }

  releaseAll(): void {
    for (const handle of this.handles) handle.release();
    this.handles = [];
  }
}
