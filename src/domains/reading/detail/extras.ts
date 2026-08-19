/**
 * The four things a book detail screen says that v3's `Book` has no column for.
 *
 * A film's detail shows a review label, a synopsis, a studio and a notes box.
 * `Book` and `Manga` are v3's shapes and carry none of those — and `types.ts` is
 * frozen, so they do not gain columns here either. They do not need to:
 *
 *   **RUNTIME PRESERVATION CONTRACT (`types.ts` header).** A reading row is
 *   normalised *in place* by `data/migrate.ts` and edited *in place* by
 *   `domains/reading/store.ts` — neither ever rebuilds it from a literal. A key
 *   nothing declares therefore round-trips through `data.json` untouched, which
 *   is precisely how `shelfLocation` and `lentTo` survive in a real vault.
 *
 * So these four live as preserved extra keys, and this module is the only place
 * that knows their names. Everything else asks for them by function, which is
 * what stops the next surface from spelling `description` as `synopsis`.
 *
 * `review` is the load-bearing one: it is the book's half of the rating/review
 * binding, and it is deliberately **the same string vocabulary** as a title's
 * (`settings.reviews`), read and written through `data/review.ts` like every
 * other surface. There is no book-specific mapping anywhere in this codebase.
 */
import { readExtra, type ReadingPatch } from "../../../types";
import { MANUAL_COVER_KEY } from "../covers";
import type { ReadingEntry } from "../progress";

/**
 * The preserved keys a reading row carries beyond its declared shape.
 *
 * `manualCoverUrl` is the fifth and it is spelled in `covers.ts`, not here:
 * that module both reads it during the paint and reports it to the artwork
 * cache, and a second spelling of a key is a cover that renders but is offered
 * for deletion as an orphan.
 */
export type ReadingExtraKey =
  | "review"
  | "description"
  | "publisher"
  | "notes"
  | typeof MANUAL_COVER_KEY;

/** One extra, always as a string — an absent key and a blank one are the same. */
export function readingExtra(entry: ReadingEntry, key: ReadingExtraKey): string {
  const value = readExtra<unknown>(entry, key);
  return typeof value === "string" ? value : "";
}

/**
 * The patch that writes one.
 *
 * The cast is the whole trick and it is confined to this line: `ReadingPatch` is
 * `Partial<Book & Manga>` and these keys are deliberately not on either, while
 * the store's `applyPatch` walks `Object.entries(patch)` and writes whatever it
 * is handed. So the value lands on the live row and is persisted by the same
 * debounced writer as every declared field — no second write path, no literal.
 */
export function extraPatch(key: ReadingExtraKey, value: string): ReadingPatch {
  return { [key]: value } as ReadingPatch;
}

/**
 * The pair `data/review.ts` reasons about, taken off a reading row.
 *
 * Structural on purpose: `syncedRatingPatch` and `syncedReviewPatch` are written
 * against `{ rating, review }` and know nothing about titles, so a book gets the
 * mapping verbatim rather than a copy of it.
 */
export function readingJudgement(entry: ReadingEntry): { rating: number; review: string } {
  return { rating: entry.rating, review: readingExtra(entry, "review") };
}
