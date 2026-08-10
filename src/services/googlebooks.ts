/**
 * Google Books — the **optional, key-only** book source (SPEC2 §D-READING).
 *
 * The research report settles the question this file exists to answer: a
 * keyless request is not "low quota", it is **zero**. Anonymous traffic is
 * attributed to a shared Google project whose `quota_limit_value` is literally
 * `"0"`, so the very first call comes back 429 (`report-media-apis.md` §2.2,
 * proven live). There is no degraded keyless mode worth shipping, so
 * `configured()` is false without a key and the Reading tab simply searches Open
 * Library instead — which needs no key at all.
 *
 * What a key buys, when the user has one: `intitle:`/`inauthor:`/`isbn:` search
 * operators, publisher metadata, descriptions and Google's own thumbnails. Worth
 * having, never required.
 *
 * Two response quirks are handled here rather than at the call site:
 *   - `totalItems` is an estimate and routinely disagrees with `items.length`,
 *     so it is ignored entirely;
 *   - `imageLinks.thumbnail` comes back over `http://` with a `zoom` parameter;
 *     it is upgraded to `https` (Obsidian blocks mixed content in a rendered
 *     note) and the curl-page edge is trimmed.
 */
import type { BookSearchResult, GoogleBooksClient } from "../types";
import { ApiError, defaultHttp, queryString, type HttpFn } from "./http";
import { isRaw, num, str, type Raw } from "./normalize";
import { GOOGLEBOOKS_SOURCE, openLibraryCoverUrl, pickIsbn } from "./openlibrary";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";

export const GOOGLE_BOOKS_BASE = "https://www.googleapis.com/books/v1";

/** No published per-second rule; this is politeness, not a documented limit. */
export const GOOGLE_BOOKS_GAP_MS = 250;

/** The API's own ceiling. Asking for more is a 400, not a truncation. */
export const GOOGLE_BOOKS_MAX_RESULTS = 40;

export interface GoogleBooksConfig {
  /** `settings.googleBooksApiKey`. Empty means the client is off. */
  apiKey: string;
}

export interface GoogleBooksDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
}

// ---------------------------------------------------------------------------
// Pure: volume → BookSearchResult
// ---------------------------------------------------------------------------

/**
 * `http://…&edge=curl` → a usable https thumbnail.
 *
 * The parameter is dropped by rebuilding the query rather than by deleting the
 * substring: `?edge=curl&a=1` would otherwise leave `?`-less garbage behind.
 */
export function cleanThumbnail(raw: string): string {
  const url = raw.trim();
  if (url === "") return "";
  const https = url.replace(/^http:\/\//, "https://");
  const at = https.indexOf("?");
  if (at < 0) return https;
  const params = https
    .slice(at + 1)
    .split("&")
    .filter((param) => param !== "" && param !== "edge=curl");
  return params.length > 0 ? `${https.slice(0, at)}?${params.join("&")}` : https.slice(0, at);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** `industryIdentifiers: [{type: "ISBN_13", identifier}]` → the best ISBN. */
export function isbnFromVolume(info: Raw): string | undefined {
  const entries = Array.isArray(info["industryIdentifiers"])
    ? info["industryIdentifiers"].filter(isRaw)
    : [];
  const thirteen = entries.find((entry) => str(entry, "type") === "ISBN_13");
  const ten = entries.find((entry) => str(entry, "type") === "ISBN_10");
  const chosen = thirteen ?? ten ?? entries[0];
  if (!chosen) return undefined;
  return pickIsbn([str(chosen, "identifier")]);
}

export function normalizeVolume(raw: Raw): BookSearchResult {
  const info = isRaw(raw["volumeInfo"]) ? raw["volumeInfo"] : {};
  const images = isRaw(info["imageLinks"]) ? info["imageLinks"] : {};
  const isbn = isbnFromVolume(info);

  const thumbnail = cleanThumbnail(str(images, "thumbnail", "smallThumbnail"));
  const result: BookSearchResult = {
    id: str(raw, "id"),
    source: "googlebooks",
    title: str(info, "title"),
    authors: stringList(info["authors"]),
    // Google's thumbnail first; an ISBN still earns an Open Library cover when
    // Google has no image, which is common for older editions.
    coverUrl: thumbnail || (isbn ? openLibraryCoverUrl("isbn", isbn) : ""),
  };

  const subtitle = str(info, "subtitle");
  if (subtitle && result.title) result.title = `${result.title}: ${subtitle}`;

  // `publishedDate` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
  const year = Number.parseInt(str(info, "publishedDate").slice(0, 4), 10);
  if (Number.isFinite(year) && year > 0) result.firstPublishYear = year;
  if (isbn !== undefined) result.isbn = isbn;
  const pages = num(info, "pageCount");
  if (pages > 0) result.pageCount = pages;
  const description = str(info, "description");
  if (description) result.description = description;

  // Reader ratings, 0–5. Both or neither: an average without its count reads
  // as more certain than it is.
  const average = num(info, "averageRating");
  const votes = num(info, "ratingsCount");
  if (average > 0) {
    result.averageRating = average;
    result.ratingsCount = Math.max(0, votes);
  }

  const categories = stringList(info["categories"]);
  if (categories.length > 0) result.categories = categories;

  return result;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createGoogleBooksClient(
  getConfig: () => GoogleBooksConfig,
  deps: GoogleBooksDeps = {},
): GoogleBooksClient {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(GOOGLE_BOOKS_GAP_MS, clock);

  function apiKey(): string {
    return getConfig().apiKey.trim();
  }

  function configured(): boolean {
    return apiKey() !== "";
  }

  /**
   * Refusing without a key is the correct behaviour, not a limitation: the
   * keyless quota is zero, so the alternative is a guaranteed 429 dressed up as
   * an outage.
   */
  function requireKey(): string {
    const key = apiKey();
    if (key === "") {
      throw new ApiError({
        source: GOOGLEBOOKS_SOURCE,
        reason: "no-key",
        detail: "googleBooksApiKey is empty; the anonymous quota is zero",
      });
    }
    return key;
  }

  async function volumes(query: string, limit: number): Promise<BookSearchResult[]> {
    const key = requireKey();
    const url = `${GOOGLE_BOOKS_BASE}/volumes${queryString({
      q: query,
      maxResults: Math.max(1, Math.min(GOOGLE_BOOKS_MAX_RESULTS, Math.trunc(limit))),
      key,
    })}`;
    const response = await limiter.run(() =>
      http<Raw>({ url, method: "GET", source: GOOGLEBOOKS_SOURCE }),
    );
    const body = response.json;
    if (!isRaw(body)) return [];
    const items = Array.isArray(body["items"]) ? body["items"].filter(isRaw) : [];
    return items.map(normalizeVolume).filter((hit) => hit.title !== "");
  }

  return {
    configured,

    async search(query: string, limit = 10): Promise<BookSearchResult[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      return volumes(trimmed, limit);
    },

    async byIsbn(isbn: string): Promise<BookSearchResult | undefined> {
      const clean = isbn.replace(/[^0-9Xx]/g, "");
      if (clean === "") return undefined;
      const hits = await volumes(`isbn:${clean}`, 1);
      return hits[0];
    },
  };
}
