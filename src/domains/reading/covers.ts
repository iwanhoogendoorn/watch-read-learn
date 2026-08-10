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

/** Settings changed / manual refresh — forget the misses along with the hits. */
export function clearGoogleCoverCache(): void {
  googleCoverCache.clear();
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
}

/**
 * Point `img` at `url`, politely.
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

  const show = (bytes: ArrayBuffer): void => {
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    img.src = objectUrl;
    img.addClass?.("is-loaded");
  };

  /** The primary came up empty — Google by ISBN before giving up. */
  const missing = (): void => {
    const isbn = options.fallbackIsbn ?? "";
    const fetchBytes = options.fetchBytes;
    if (isbn === "" || !fetchBytes) {
      options.onMissing?.();
      return;
    }
    const cached = googleCoverCache.get(isbn);
    if (cached === "none") {
      options.onMissing?.();
      return;
    }
    if (cached) {
      show(cached);
      return;
    }
    void fetchBytes(googleCoverUrl(isbn))
      .then((bytes) => {
        // A Google miss is a 200 with a PNG placeholder, not a 404 — only a
        // JPEG is a real cover. Either way the answer is cached: misses would
        // otherwise be re-fetched on every re-render of a live search.
        if (bytes && looksLikeJpeg(bytes)) {
          googleCoverCache.set(isbn, bytes);
          show(bytes);
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

  if (!needsProxy(url)) {
    img.src = url;
    img.addClass?.("is-loaded");
    return { release };
  }

  const client = options.client;
  if (!client) {
    missing();
    return { release };
  }

  void client
    .coverBytes(url)
    .then((bytes) => {
      if (!bytes || bytes.byteLength === 0) {
        missing();
        return;
      }
      show(bytes);
    })
    .catch(() => {
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
