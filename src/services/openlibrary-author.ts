/**
 * Authors — the cache, the name resolver and the service the author screen is
 * built on. The reading-side sibling of `services/tmdb-person.ts`, and it exists
 * for the same reason that file does.
 *
 * A book row stores its author as **text** (`Book.author` is a string, and often
 * `"Frank Herbert, Brian Herbert"`). An author page needs an Open Library author
 * key, so opening one from a book means turning a name back into an identity —
 * and "two authors, one name" is not a corner case here either: `John Williams`
 * is the composer *and* the novelist who wrote *Stoner*, and Open Library holds
 * both.
 *
 * So resolution has an order, cheapest and most certain first, exactly as the
 * person resolver's does:
 *
 *   1. **The name cache.** A name resolved once stays resolved, no request.
 *   2. **The user's own books.** `search.json?title=…&author=…` returns the
 *      `author_key` Open Library itself attached to a book the user owns. That
 *      is an answer, not a guess. Two *different* keys across the library is the
 *      genuinely ambiguous case and is reported as such rather than resolved to
 *      whichever came back first.
 *   3. **`/search/authors.json`.** Only exact name matches count — including
 *      matches on an author's `alternate_names`, which is how one person spelled
 *      two ways across editions is still one person. One hit resolves, several
 *      are handed to the user to pick from.
 *
 * Nothing here ever picks between two candidates. Getting that wrong puts a
 * complete, plausible, wrong bibliography on screen with nothing to say so.
 *
 * Everything fetched is cached in `data.json` under the preserved `bookAuthors`
 * key — see the runtime-preservation contract at the top of `types.ts`; this is
 * what `readExtra`/`writeExtra` are for. A second visit makes no request at all.
 *
 * Pure except for the injected client and store: no obsidian import, no DOM.
 */
import type {
  AuthorCandidate,
  OpenLibraryAuthor,
  OpenLibraryAuthorApi,
} from "./openlibrary";
import {
  readExtra,
  writeExtra,
  type Book,
  type BookSearchResult,
  type IsoTimestamp,
  type WatchLogData,
} from "../types";

// ---------------------------------------------------------------------------
// 1. Names
// ---------------------------------------------------------------------------

/**
 * The comparison key for an author name, and for a book title.
 *
 * Same treatment `personNameKey` gives a credit, and for the same two reasons:
 * the stored string came from whichever provider matched the book first, so
 * `Gabriel Garcia Marquez` must find `Gabriel García Márquez`; and initials are
 * punctuated inconsistently everywhere, so `Samuel R. Delany` must find
 * `Samuel R Delany`.
 *
 * With one addition that side does not need: **an apostrophe joins rather than
 * separates.** `personNameKey` turns every run of punctuation into a space,
 * which is right for `Samuel R. Delany` and wrong for
 * `The Hitchhiker's Guide` — `hitchhiker s guide` would then fail to match the
 * `The Hitchhikers Guide` a catalogue without the apostrophe wrote, and a book
 * already on the user's shelf would be offered back as `+ Add`. This key is
 * applied to titles as well as names, so it drops apostrophes first.
 *
 * It does not transliterate: `ł` is a letter, not an accented `l`, and NFD does
 * not decompose it. `Stanisław` and `Stanislaw` are two keys — a limit shared
 * with the person side, and not one worth a hand-written alphabet to close.
 */
export function authorNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sameAuthorName(a: string, b: string): boolean {
  const left = authorNameKey(a);
  return left !== "" && left === authorNameKey(b);
}

/**
 * The names in one book's author field.
 *
 * `seedFromHit` joins multiple authors with `", "`, so the field is a list as
 * often as it is a name. The whole string is kept as well as the parts: an
 * author who genuinely has a comma in their name is not lost by the split.
 */
export function authorNamesOf(book: { author?: string }): string[] {
  const raw = (book.author ?? "").trim();
  if (raw === "") return [];
  const parts = raw
    .split(/,| and | & /i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.includes(raw) ? parts : [raw, ...parts];
}

/** Books whose author field names this person, most recently touched first. */
export function booksBy(books: readonly Book[], name: string): Book[] {
  return books
    .filter((book) => authorNamesOf(book).some((author) => sameAuthorName(author, name)))
    .slice()
    .sort((a, b) => (b.dateModified ?? "").localeCompare(a.dateModified ?? ""));
}

/**
 * The `/search/authors.json` hits that are actually this author.
 *
 * A search for "Frank Herbert" also returns "Frank Herbert Jr."; only an exact
 * name match is evidence. `alternate_names` counts too — that field is precisely
 * the catalogue telling us these spellings are one person. Sorted by work count
 * so a picker leads with the likely one without ever *choosing* it.
 */
export function exactAuthorHits(
  hits: readonly AuthorCandidate[],
  name: string,
): AuthorCandidate[] {
  return hits
    .filter(
      (hit) =>
        sameAuthorName(hit.name, name) ||
        hit.alternateNames.some((alias) => sameAuthorName(alias, name)),
    )
    .slice()
    .sort((a, b) => b.workCount - a.workCount);
}

// ---------------------------------------------------------------------------
// 2. Resolution
// ---------------------------------------------------------------------------

export type AuthorResolution =
  | {
      state: "resolved";
      key: string;
      name: string;
      /** Where the key came from — `books` is exact, `search` is a name match. */
      source: "cache" | "books" | "search";
    }
  | { state: "ambiguous"; name: string; candidates: AuthorCandidate[] }
  | { state: "unknown"; name: string };

/** How many owned books are asked about before falling back to name search. */
export const RESOLVE_BOOK_BUDGET = 3;

export interface ResolveAuthorDeps {
  client: OpenLibraryAuthorApi;
  books: readonly Book[];
}

export async function resolveAuthorByName(
  name: string,
  deps: ResolveAuthorDeps,
): Promise<AuthorResolution> {
  const trimmed = name.trim();
  if (trimmed === "") return { state: "unknown", name };

  // 2. The user's own books. Each round trip is a real request against a 3 req/s
  // budget, so the budget is three books, not the whole shelf.
  const seen = new Map<string, { name: string; titles: string[] }>();
  for (const book of booksBy(deps.books, trimmed).slice(0, RESOLVE_BOOK_BUDGET)) {
    let refs;
    try {
      refs = await deps.client.authorKeysFor(book.title, trimmed);
    } catch {
      // One book's lookup failing is not the resolution failing.
      continue;
    }
    for (const ref of refs) {
      if (!sameAuthorName(ref.name, trimmed)) continue;
      const entry = seen.get(ref.key) ?? { name: ref.name, titles: [] };
      if (!entry.titles.includes(book.title)) entry.titles.push(book.title);
      seen.set(ref.key, entry);
    }
  }

  if (seen.size === 1) {
    const [key] = [...seen.keys()];
    return {
      state: "resolved",
      key: key as string,
      name: seen.get(key as string)?.name ?? trimmed,
      source: "books",
    };
  }
  if (seen.size > 1) {
    // Two keys, one name, both in this library. Nothing here can pick between
    // them, and picking would put the wrong bibliography on screen.
    return {
      state: "ambiguous",
      name: trimmed,
      candidates: [...seen.entries()].map(([key, entry]) => ({
        key,
        name: entry.name,
        alternateNames: [],
        birthDate: "",
        deathDate: "",
        topWork: entry.titles[0] ?? "",
        workCount: 0,
      })),
    };
  }

  // 3. Name search.
  let hits: AuthorCandidate[];
  try {
    hits = exactAuthorHits(await deps.client.searchAuthors(trimmed), trimmed);
  } catch {
    return { state: "unknown", name: trimmed };
  }
  if (hits.length === 0) return { state: "unknown", name: trimmed };
  if (hits.length === 1) {
    const only = hits[0] as AuthorCandidate;
    return { state: "resolved", key: only.key, name: only.name, source: "search" };
  }
  return { state: "ambiguous", name: trimmed, candidates: hits };
}

// ---------------------------------------------------------------------------
// 3. Bibliography shaping
// ---------------------------------------------------------------------------

/**
 * Newest work first, undated last.
 *
 * A great many Open Library works carry no `first_publish_date` at all; sorting
 * them by an empty string would float the least-known half of a bibliography to
 * the top, which is the opposite of what the page is for.
 */
export function sortWorks(works: readonly BookSearchResult[]): BookSearchResult[] {
  return works.slice().sort((a, b) => {
    const left = a.firstPublishYear ?? 0;
    const right = b.firstPublishYear ?? 0;
    if (left === 0 && right === 0) return a.title.localeCompare(b.title);
    if (left === 0) return 1;
    if (right === 0) return -1;
    return right - left;
  });
}

/**
 * The library row a work already is, if any.
 *
 * By title, because that is the only identity the two sides share: `Book` has no
 * field for an Open Library work key, and `findExistingReading` — the add flow's
 * own duplicate guard — matches on title too. The key is normalised rather than
 * merely lowercased so *The Hitchhiker's Guide* still matches
 * *The Hitchhikers Guide*.
 */
export function ownedBookFor(
  work: BookSearchResult,
  books: readonly Book[],
): Book | undefined {
  const key = authorNameKey(work.title);
  if (key === "") return undefined;
  return books.find((book) => authorNameKey(book.title) === key);
}

// ---------------------------------------------------------------------------
// 4. The cache
// ---------------------------------------------------------------------------

/**
 * The preserved `data.json` key this cache lives under.
 *
 * `bookAuthors` rather than `authors`: v3 wrote keys this plugin still preserves
 * verbatim, and a bare `authors` is exactly the sort of name a future one might
 * want for something else.
 */
export const AUTHOR_CACHE_KEY = "bookAuthors";
export const AUTHOR_CACHE_VERSION = 1;
/** A biography does not change weekly; a bibliography barely does. */
export const AUTHOR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Authors kept before the oldest is evicted. Work lists are not small. */
export const AUTHOR_CACHE_MAX = 40;

export interface AuthorCacheEntry {
  author: OpenLibraryAuthor;
  works: BookSearchResult[];
  fetchedAt: IsoTimestamp;
}

/** What a name resolved to, so the same lookup never runs twice. */
export interface AuthorNameEntry {
  key?: string;
  /** Keys that share this name. Present only for the ambiguous outcome. */
  candidateKeys?: string[];
  checkedAt: IsoTimestamp;
}

export interface AuthorCacheData {
  version: number;
  byKey: Record<string, AuthorCacheEntry>;
  names: Record<string, AuthorNameEntry>;
}

export function emptyAuthorCache(): AuthorCacheData {
  return { version: AUTHOR_CACHE_VERSION, byKey: {}, names: {} };
}

/** The cache object on `data`, created on first use. */
export function authorCacheOf(data: WatchLogData): AuthorCacheData {
  const raw = readExtra<Partial<AuthorCacheData>>(data, AUTHOR_CACHE_KEY);
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.version !== AUTHOR_CACHE_VERSION ||
    typeof raw.byKey !== "object" ||
    raw.byKey === null
  ) {
    const fresh = emptyAuthorCache();
    writeExtra(data, AUTHOR_CACHE_KEY, fresh);
    return fresh;
  }
  if (typeof raw.names !== "object" || raw.names === null) raw.names = {};
  return raw as AuthorCacheData;
}

/** Oldest-first eviction at a hard cap, the same rule the person cache uses. */
export function evictAuthors(cache: AuthorCacheData, max = AUTHOR_CACHE_MAX): void {
  const keys = Object.keys(cache.byKey);
  if (keys.length <= max) return;
  const oldest = keys
    .map((key) => ({ key, at: cache.byKey[key]?.fetchedAt ?? "" }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, keys.length - max);
  for (const entry of oldest) delete cache.byKey[entry.key];
}

// ---------------------------------------------------------------------------
// 5. The service
// ---------------------------------------------------------------------------

/** The slice of the store this service needs. */
export interface AuthorStoreLike {
  readonly data: WatchLogData;
  /** Every book on the shelf, for resolution and the owned/not-owned decision. */
  books(): readonly Book[];
  save(reason?: string): void;
}

export interface AuthorServiceDeps {
  store: AuthorStoreLike;
  client: OpenLibraryAuthorApi;
  /** Whether the provider can be asked at all. Open Library is keyless, so `true`. */
  configured?: () => boolean;
  /** Injected so the TTL is testable without waiting a month. */
  now?: () => number;
  ttlMs?: number;
  worksLimit?: number;
}

export interface AuthorService {
  configured(): boolean;
  /** The cached entry, fresh or stale. Never touches the network. */
  cached(key: string): AuthorCacheEntry | undefined;
  isStale(entry: AuthorCacheEntry): boolean;
  /** A name already resolved, from cache only. */
  cachedResolution(name: string): AuthorResolution | undefined;
  resolve(name: string): Promise<AuthorResolution>;
  /** Cached when possible; fetches only when absent, stale or forced. */
  load(key: string, options?: { force?: boolean }): Promise<AuthorCacheEntry>;
  /** Pin a name to the author the user picked out of an ambiguous list. */
  rememberChoice(name: string, key: string): void;
}

export function createAuthorService(deps: AuthorServiceDeps): AuthorService {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? AUTHOR_CACHE_TTL_MS;
  const cache = (): AuthorCacheData => authorCacheOf(deps.store.data);

  function isStale(entry: AuthorCacheEntry): boolean {
    const at = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(at)) return true;
    return now() - at >= ttlMs;
  }

  function cached(key: string): AuthorCacheEntry | undefined {
    return cache().byKey[key.toUpperCase()];
  }

  function cachedResolution(name: string): AuthorResolution | undefined {
    const nameKey = authorNameKey(name);
    if (nameKey === "") return undefined;
    const entry = cache().names[nameKey];
    if (!entry) return undefined;
    if (entry.key !== undefined) {
      return {
        state: "resolved",
        key: entry.key,
        name: cached(entry.key)?.author.name ?? name.trim(),
        source: "cache",
      };
    }
    if (entry.candidateKeys && entry.candidateKeys.length > 1) {
      // Only the keys were kept; the rest comes back from whatever is cached.
      return {
        state: "ambiguous",
        name: name.trim(),
        candidates: entry.candidateKeys.map((key) => ({
          key,
          name: cached(key)?.author.name ?? name.trim(),
          alternateNames: cached(key)?.author.alternateNames ?? [],
          birthDate: cached(key)?.author.birthDate ?? "",
          deathDate: cached(key)?.author.deathDate ?? "",
          topWork: cached(key)?.works[0]?.title ?? "",
          workCount: cached(key)?.works.length ?? 0,
        })),
      };
    }
    return undefined;
  }

  function writeName(name: string, entry: AuthorNameEntry): void {
    const nameKey = authorNameKey(name);
    if (nameKey === "") return;
    cache().names[nameKey] = entry;
    deps.store.save("author-name-resolved");
  }

  return {
    configured: () => (deps.configured ? deps.configured() : true),
    cached,
    isStale,
    cachedResolution,

    async resolve(name) {
      const hit = cachedResolution(name);
      if (hit) return hit;
      const outcome = await resolveAuthorByName(name, {
        client: deps.client,
        books: deps.store.books(),
      });
      if (outcome.state === "resolved") {
        writeName(name, { key: outcome.key, checkedAt: new Date(now()).toISOString() });
      } else if (outcome.state === "ambiguous") {
        writeName(name, {
          candidateKeys: outcome.candidates.map((c) => c.key),
          checkedAt: new Date(now()).toISOString(),
        });
      }
      return outcome;
    },

    async load(key, options = {}) {
      const id = key.toUpperCase();
      const entry = cached(id);
      if (entry && !options.force && !isStale(entry)) return entry;
      try {
        // Two requests, both through the client's one limiter, and serially —
        // the author first because the works carry no author name of their own.
        const author = await deps.client.author(id);
        const works = await deps.client.authorWorks(id, deps.worksLimit);
        const next: AuthorCacheEntry = {
          author,
          works: sortWorks(
            works.map((work) =>
              author.name === "" ? work : { ...work, authors: [author.name] },
            ),
          ),
          fetchedAt: new Date(now()).toISOString(),
        };
        const store = cache();
        store.byKey[id] = next;
        evictAuthors(store);
        deps.store.save("author-cached");
        return next;
      } catch (err) {
        // Stale beats an error screen: last month's bibliography is very nearly
        // this month's, and the network is not the user's problem.
        if (entry) return entry;
        throw err;
      }
    },

    rememberChoice(name, key) {
      writeName(name, { key: key.toUpperCase(), checkedAt: new Date(now()).toISOString() });
    },
  };
}
