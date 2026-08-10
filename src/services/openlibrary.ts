/**
 * Open Library — the **keyless** book source (SPEC2 §D-READING).
 *
 * Everything the Reading tab needs works with no account, no key and no setup,
 * which is why this is the primary and Google Books is the optional extra.
 * Four facts from `docs/research/report-media-apis.md` §2.1 shape the whole
 * file, and each one is a bug if it is forgotten:
 *
 *   1. **The User-Agent is worth 3x.** An unidentified caller is rate-limited to
 *      1 req/s; one that names the app and a contact address gets 3 req/s, and
 *      Open Library's own docs threaten "aggressive rate limiting or blocking"
 *      for anonymous hammering. So the header is always sent, and the limiter
 *      below is set to the *identified* rate.
 *   2. **`?default=false` on every cover URL.** A missing cover otherwise
 *      answers `200` with a 43-byte blank placeholder, which caches like a real
 *      image and leaves a grey rectangle nobody can explain. With the parameter
 *      it is an honest 404 and the shared poster pipeline falls back to the
 *      tinted initial.
 *   3. **`/api/books` beats `/isbn/{isbn}.json`.** The latter 302-redirects and
 *      then hands back author/work *references* that need two more round trips —
 *      and it resolved to a different edition (544 pp) than `/api/books` did
 *      (528 pp) for the same ISBN. One call, richer body, no redirect.
 *   4. **Always pass `fields`.** Without it a single `docs[]` entry carries 60+
 *      ISBNs and everything else Solr knows.
 *
 * `ApiSource` in `types.ts` is frozen at `overseerr | plex | tmdb` and the
 * parity contract did not widen it. Rather than mislabel which server answered,
 * the true provider name is cast in at the transport boundary (one place, below)
 * so logs and `ApiError.source` stay truthful, and `describeBookError` — not
 * `describeApiError` — is what turns a failure into a sentence for the user.
 *
 * Pure except for the injected `http`: no obsidian import, no DOM. Tests hand it
 * a fixture router; no test in this repo reaches the network.
 */
import type { ApiSource, BookSearchResult, OpenLibraryClient } from "../types";
import { defaultHttp, isApiError, queryString, type HttpFn } from "./http";
import { isRaw, num, optNum, str, type Raw } from "./normalize";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";

export const OPEN_LIBRARY_BASE = "https://openlibrary.org";
export const OPEN_LIBRARY_COVERS = "https://covers.openlibrary.org";

/**
 * The transport tag for the book providers.
 *
 * See the header: the union is frozen, the string is real. Everything that
 * *reads* `source` in this domain goes through `describeBookError`.
 */
export const OPENLIBRARY_SOURCE = "openlibrary" as unknown as ApiSource;
export const GOOGLEBOOKS_SOURCE = "googlebooks" as unknown as ApiSource;

/** 3 req/s for an identified caller — 334 ms is the gap that stays under it. */
export const OPEN_LIBRARY_GAP_MS = 334;

/** What the settings field defaults to; the contact address is the point of it. */
export const DEFAULT_OPEN_LIBRARY_UA = "WatchReadLearn/1.0 (+https://github.com/iwanhoogendoorn/watch-read-learn)";

/** The fields worth asking Solr for. Anything else is payload we throw away. */
const SEARCH_FIELDS = [
  "key",
  "title",
  "author_name",
  "first_publish_year",
  "isbn",
  "cover_i",
  "number_of_pages_median",
].join(",");

export interface OpenLibraryConfig {
  /**
   * Sent as `User-Agent`. An empty string falls back to the default above rather
   * than going out anonymous — a blank settings field must not silently cost the
   * user two thirds of their rate limit.
   */
  userAgent: string;
}

export interface OpenLibraryDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
}

// ---------------------------------------------------------------------------
// Pure: response → BookSearchResult
// ---------------------------------------------------------------------------

/**
 * `covers.openlibrary.org/b/{key}/{value}-{size}.jpg?default=false`.
 *
 * Exported and used by both clients: a Google Books hit with an ISBN but no
 * thumbnail still gets a cover this way.
 */
export function openLibraryCoverUrl(
  key: "isbn" | "id" | "olid",
  value: string,
  size: "S" | "M" | "L" = "M",
): string {
  const clean = value.trim();
  if (clean === "") return "";
  return `${OPEN_LIBRARY_COVERS}/b/${key}/${encodeURIComponent(clean)}-${size}.jpg?default=false`;
}

/** The first ISBN-13 if there is one, else the first ISBN of any length. */
export function pickIsbn(isbns: readonly string[]): string | undefined {
  const cleaned = isbns.map((value) => value.replace(/[^0-9Xx]/g, "")).filter((v) => v !== "");
  return cleaned.find((value) => value.length === 13) ?? cleaned[0];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** One `search.json` doc. `cover_i` is an id, not an ISBN — the key differs. */
export function normalizeSearchDoc(raw: Raw): BookSearchResult {
  const isbn = pickIsbn(stringList(raw["isbn"]));
  const coverId = optNum(raw, "cover_i");
  const coverUrl =
    coverId !== undefined && coverId > 0
      ? openLibraryCoverUrl("id", String(coverId))
      : isbn
        ? openLibraryCoverUrl("isbn", isbn)
        : "";

  const result: BookSearchResult = {
    id: str(raw, "key"),
    source: "openlibrary",
    title: str(raw, "title"),
    authors: stringList(raw["author_name"]),
    coverUrl,
  };
  const year = optNum(raw, "first_publish_year");
  if (year !== undefined && year > 0) result.firstPublishYear = year;
  if (isbn !== undefined) result.isbn = isbn;
  const pages = optNum(raw, "number_of_pages_median");
  if (pages !== undefined && pages > 0) result.pageCount = pages;
  return result;
}

/**
 * One `/api/books?jscmd=data` record.
 *
 * The response is keyed by the bibkey that was *sent* (`"ISBN:978…"`), and a
 * miss is `{}` rather than a 404 — both handled by the caller below.
 */
export function normalizeBookRecord(raw: Raw, isbn: string): BookSearchResult {
  const authors = rawList(raw["authors"]).map((author) => str(author, "name")).filter(Boolean);
  const identifiers = isRaw(raw["identifiers"]) ? raw["identifiers"] : {};
  const olid = stringList(identifiers["openlibrary"])[0] ?? "";

  const result: BookSearchResult = {
    id: str(raw, "key"),
    source: "openlibrary",
    title: str(raw, "title"),
    authors,
    coverUrl: olid ? openLibraryCoverUrl("olid", olid) : openLibraryCoverUrl("isbn", isbn),
    isbn,
  };

  const pages = num(raw, "number_of_pages");
  if (pages > 0) result.pageCount = pages;

  // `publish_date` is free text ("August 2, 2005", "2005"), so only the year is
  // trustworthy — and only when it looks like one.
  const year = Number.parseInt(/(\d{4})/.exec(str(raw, "publish_date"))?.[1] ?? "", 10);
  if (Number.isFinite(year) && year > 0) result.firstPublishYear = year;

  const excerpt = rawList(raw["excerpts"])[0];
  const description = excerpt ? str(excerpt, "text") : "";
  if (description) result.description = description;

  return result;
}

function rawList(value: unknown): Raw[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRaw);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createOpenLibraryClient(
  getConfig: () => OpenLibraryConfig,
  deps: OpenLibraryDeps = {},
): OpenLibraryClient {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(OPEN_LIBRARY_GAP_MS, clock);

  function headers(): Record<string, string> {
    const configured = getConfig().userAgent.trim();
    return { "User-Agent": configured === "" ? DEFAULT_OPEN_LIBRARY_UA : configured };
  }

  async function getJsonAt<T>(url: string): Promise<T | undefined> {
    const response = await limiter.run(() =>
      http<T>({ url, method: "GET", headers: headers(), source: OPENLIBRARY_SOURCE }),
    );
    return response.json;
  }

  return {
    /** Keyless: there is nothing to configure, so it is always available. */
    configured(): boolean {
      return true;
    },

    /**
     * Cover bytes, through the same door as everything else (W8 review P1-5).
     *
     * Covers share the API's rate limit and the identified allowance is three
     * times the anonymous one, so they cannot be left to `<img src>` — that
     * request is Chromium's, carries no User-Agent of ours, and ignores the
     * limiter entirely. A search showing ten results would fire ten unidentified
     * requests at once against a 1/s budget.
     *
     * `undefined` rather than a throw when a cover is simply missing: the caller
     * draws the placeholder either way, and a missing cover is not an error.
     */
    async coverBytes(url: string): Promise<ArrayBuffer | undefined> {
      if (!url.startsWith(OPEN_LIBRARY_COVERS)) return undefined;
      try {
        const response = await limiter.run(() =>
          http({
            url,
            method: "GET",
            headers: headers(),
            source: OPENLIBRARY_SOURCE,
            binary: true,
            // `?default=false` turns a miss into a 404 rather than a 43-byte
            // blank JPEG; allowing it here keeps that a quiet "no cover".
            allowStatuses: [404],
          }),
        );
        if (response.status === 404) return undefined;
        return response.bytes;
      } catch {
        return undefined;
      }
    },

    async search(query: string, limit = 10): Promise<BookSearchResult[]> {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const url = `${OPEN_LIBRARY_BASE}/search.json${queryString({
        q: trimmed,
        limit: Math.max(1, Math.min(50, Math.trunc(limit))),
        fields: SEARCH_FIELDS,
      })}`;
      const body = await getJsonAt<Raw>(url);
      if (!isRaw(body)) return [];
      return rawList(body["docs"])
        .map(normalizeSearchDoc)
        .filter((hit) => hit.title !== "");
    },

    async byIsbn(isbn: string): Promise<BookSearchResult | undefined> {
      const clean = isbn.replace(/[^0-9Xx]/g, "");
      if (clean === "") return undefined;
      const bibkey = `ISBN:${clean}`;
      const url = `${OPEN_LIBRARY_BASE}/api/books${queryString({
        bibkeys: bibkey,
        format: "json",
        jscmd: "data",
      })}`;
      const body = await getJsonAt<Raw>(url);
      // A miss is an empty object with a 200, not a 404.
      if (!isRaw(body)) return undefined;
      const record = body[bibkey];
      if (!isRaw(record)) return undefined;
      return normalizeBookRecord(record, clean);
    },

    coverUrl: openLibraryCoverUrl,
  };
}

// ---------------------------------------------------------------------------
// Failure sentences
// ---------------------------------------------------------------------------

/**
 * One place that turns a book-provider failure into something a person can act
 * on. `describeApiError` cannot do it — its provider names are the frozen three.
 */
export function describeBookError(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof Error ? error.message : "The search failed.";
  }
  const provider =
    (error.source as unknown as string) === "googlebooks" ? "Google Books" : "Open Library";
  switch (error.reason) {
    case "no-key":
      return `${provider} needs an API key — add one in Settings → Reading. Open Library needs none, so search still works without it.`;
    case "auth":
      return `${provider} rejected the API key. Check it in Settings → Reading.`;
    case "rate-limited":
      return provider === "Open Library"
        ? "Open Library is rate-limiting us. Give it a moment — a contact address in Settings → Reading buys three times the allowance."
        : "Google Books says the daily quota is used up. It resets at midnight Pacific time.";
    case "not-found":
      return `${provider} has no record of that.`;
    case "timeout":
      return `${provider} did not answer in time.`;
    case "network":
      return `Could not reach ${provider}. Check this machine's connection.`;
    case "server":
      return `${provider} returned a server error${error.status ? ` (${error.status})` : ""}.`;
    case "parse":
      return `${provider} sent a response the plugin could not read.`;
    default:
      return error.providerMessage || `${provider} request failed${error.status ? ` (${error.status})` : ""}.`;
  }
}
