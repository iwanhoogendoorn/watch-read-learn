/**
 * Community ratings for books — foodspot's "public rating", from Google Books.
 *
 * Why only Google: Amazon has no public ratings API and shut Goodreads' down
 * in 2020; scraping either is against their terms and breaks without notice.
 * Google's reader average (0–5, with a count) is the one book-ratings source
 * with a real API, and the plugin already holds a key slot for it.
 *
 * The fetch chain per book: the stored volume id when the book came from a
 * Google search, else the ISBN (including one recovered from an Open Library
 * cover URL), else a title+author search. The first result that actually
 * carries ratings wins — Google lists the same book as several editions and
 * only some carry the review pool.
 */
import type { BookSearchResult, GoogleBooksClient, ReadingPatch } from "../../types";
import { coverIsbn } from "./covers";

export interface CommunityRating {
  rating: number;
  votes: number;
}

/**
 * The result to trust out of a search: the first that carries ratings, or
 * null when none does. Pure, so the edition-picking rule is pinned by tests.
 */
export function pickRatedResult(results: readonly BookSearchResult[]): CommunityRating | null {
  for (const result of results) {
    if (result.averageRating !== undefined && result.averageRating > 0) {
      return { rating: result.averageRating, votes: result.ratingsCount ?? 0 };
    }
  }
  return null;
}

/** The slice of a Book the fetcher needs. Structural, for tests. */
export interface RatableBook {
  title: string;
  author: string;
  isbn?: string | null;
  coverUrl?: string;
  googleBooksId?: string;
}

/** The search Google is asked when no id or ISBN pins the exact volume. */
export function communityQuery(book: RatableBook): string {
  const title = book.title.trim();
  const author = book.author.trim();
  return author === "" ? `intitle:"${title}"` : `intitle:"${title}" inauthor:"${author}"`;
}

/** What one Google pass knows about a book beyond its metadata. */
export interface BookCommunityInfo {
  /** Null means "Google has no rated edition" — a real, stampable answer. */
  rated: CommunityRating | null;
  /** Subject categories from the first edition that carries any. */
  categories: string[];
  /**
   * The blurb, from the first edition that carries one.
   *
   * Omitted rather than empty when no edition has one: this is the same pass
   * the rating and the categories come out of, and a caller that only wanted a
   * rating must not be handed a key that says "Google has no description" when
   * what happened is that nobody looked.
   */
  description?: string;
}

/** The first non-empty category list across the editions seen. */
export function pickCategories(results: readonly BookSearchResult[]): string[] {
  for (const result of results) {
    if ((result.categories ?? []).length > 0) return [...(result.categories ?? [])];
  }
  return [];
}

/** The first non-empty description across the editions seen. */
export function pickDescription(results: readonly BookSearchResult[]): string {
  for (const result of results) {
    const text = (result.description ?? "").trim();
    if (text !== "") return text;
  }
  return "";
}

/** `{rated, categories}` plus the blurb, only when there is one. */
function communityInfo(seen: readonly BookSearchResult[]): BookCommunityInfo {
  const info: BookCommunityInfo = {
    rated: pickRatedResult(seen),
    categories: pickCategories(seen),
  };
  const description = pickDescription(seen);
  if (description !== "") info.description = description;
  return info;
}

/**
 * One Google pass per book: the exact edition by ISBN first, a title+author
 * search when that edition is missing or unrated. Rating, categories and the
 * blurb all come from the same responses — one button, one quota hit, three
 * fields fed.
 */
export async function fetchBookRating(
  client: GoogleBooksClient,
  book: RatableBook,
): Promise<BookCommunityInfo> {
  const seen: BookSearchResult[] = [];
  const isbn = coverIsbn(book);
  if (isbn !== "") {
    const hit = await client.byIsbn(isbn);
    if (hit) seen.push(hit);
    if (pickRatedResult(seen)) return communityInfo(seen);
  }
  seen.push(...(await client.search(communityQuery(book), 10)));
  return communityInfo(seen);
}

/**
 * The patch a fetch becomes — the honest "none found" included. Categories
 * only ever fill a blank: a list the user curated is never overwritten by
 * whatever Google calls the book this year.
 */
export function communityRatingPatch(
  info: BookCommunityInfo,
  entry: { categories?: string[] },
  now: Date,
): ReadingPatch {
  const patch: ReadingPatch = {
    communitySource: "google",
    communityRatingLastFetched: now.toISOString(),
  };
  patch.communityRating = info.rated?.rating ?? 0;
  patch.communityVotes = info.rated?.votes ?? 0;
  if ((entry.categories ?? []).length === 0 && info.categories.length > 0) {
    patch.categories = info.categories;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Category options — what the picker offers.
// ---------------------------------------------------------------------------

/**
 * The starter set. Google's own vocabulary where it overlaps, plus the shelf
 * this library actually holds (the hacking corner earned its own names).
 */
export const DEFAULT_CATEGORY_OPTIONS: readonly string[] = [
  "Biography",
  "Business",
  "Computers",
  "Fantasy",
  "Fiction",
  "Hacking",
  "History",
  "Mobile Hacking",
  "Networking",
  "Non-fiction",
  "Science",
  "Science Fiction",
  "Security",
];

/**
 * Everything the picker can offer: the defaults, the user's own additions,
 * and every category already on a shelf — a value in use is always offerable,
 * or it could never be re-applied after a removal. Sorted, deduped
 * case-insensitively with first-seen casing kept.
 */
export function availableCategories(
  settingsOptions: readonly string[] | undefined,
  entries: readonly { categories?: string[] }[],
): string[] {
  const seen = new Map<string, string>();
  const put = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };
  for (const name of DEFAULT_CATEGORY_OPTIONS) put(name);
  for (const name of settingsOptions ?? []) put(name);
  for (const entry of entries) for (const name of entry.categories ?? []) put(name);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Outbound links — the reviews themselves are a click away even where no API
// exists. Amazon has none; a link is the honest integration.
// ---------------------------------------------------------------------------

/** ISBN-13 (978-prefixed) → ISBN-10, or "" when not derivable. */
export function isbn13To10(isbn13: string): string {
  const digits = isbn13.replace(/-/g, "");
  if (!/^978\d{10}$/.test(digits)) return "";
  const core = digits.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? "X" : String(check));
}

/** The book on Google Books: exact volume, exact edition, or a book search. */
export function googleBooksUrl(book: RatableBook): string {
  if ((book.googleBooksId ?? "").trim() !== "") {
    return `https://books.google.com/books?id=${encodeURIComponent((book.googleBooksId ?? "").trim())}`;
  }
  const isbn = coverIsbn(book);
  if (isbn !== "") return `https://books.google.com/books?vid=ISBN${encodeURIComponent(isbn)}`;
  return `https://www.google.com/search?udm=36&q=${encodeURIComponent(`${book.title} ${book.author}`.trim())}`;
}

/**
 * The book on Amazon: `/dp/{isbn10}` is a product page and wants ISBN-10
 * specifically; anything else becomes a books-department search.
 */
export function amazonUrl(book: RatableBook): string {
  const isbn = coverIsbn(book);
  const isbn10 = isbn.length === 10 ? isbn : isbn13To10(isbn);
  if (isbn10 !== "") return `https://www.amazon.com/dp/${encodeURIComponent(isbn10)}`;
  return `https://www.amazon.com/s?i=stripbooks&k=${encodeURIComponent(`${book.title} ${book.author}`.trim())}`;
}

/** `4.2 · 1,234 ratings` — one formatter for the modal and the table. */
export function formatCommunityRating(rating: number, votes: number): string {
  const value = Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
  if (votes <= 0) return value;
  return `${value} · ${votes.toLocaleString()} rating${votes === 1 ? "" : "s"}`;
}
