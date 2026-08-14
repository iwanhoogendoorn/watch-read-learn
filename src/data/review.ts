import { TYPE_MOVIE } from "../constants";
import type { TitleV4 } from "../types";

/**
 * Rating and review say the same thing twice.
 *
 * A title carries a star rating (five tiers: Poor … Masterpiece) *and* a review
 * label (v3's own list: Nah, Awesome, Marvelous). Both are "what did you think
 * of it", entered in different places, which is what makes filling in one and
 * forgetting the other so easy — and what makes the pair feel redundant.
 *
 * They are bound rather than merged. Merging would mean throwing away one of
 * two fields people already have data in, and the two lists are configurable
 * and need not be the same length. So: a rating proposes the review that sits
 * at the same point in its list, and the caller decides whether to accept it.
 *
 * **A proposal never overwrites a choice.** `reviewForRating` is only ever
 * applied where the review is still empty, because "I rated it 4 and separately
 * decided it was Marvelous" is a thing a person is allowed to mean.
 */

/** The review label that sits at the same point in its list as `rating` does. */
export function reviewForRating(
  rating: number,
  reviews: readonly { name: string }[],
  tiers = 5,
): string {
  if (reviews.length === 0) return "";
  if (!Number.isFinite(rating) || rating <= 0) return "";
  const clamped = Math.min(tiers, Math.max(1, rating));
  // Proportional, so three reviews across five stars still lands sensibly:
  // 1–1.67 → first, 1.68–3.33 → second, 3.34–5 → third.
  const index = Math.ceil((clamped / tiers) * reviews.length) - 1;
  return reviews[Math.min(reviews.length - 1, Math.max(0, index))]?.name ?? "";
}

/** The rating a review label implies — the same map, read backwards. */
export function ratingForReview(
  review: string,
  reviews: readonly { name: string }[],
  tiers = 5,
): number {
  const name = review.trim().toLowerCase();
  if (name === "" || reviews.length === 0) return 0;
  const index = reviews.findIndex((entry) => entry.name.trim().toLowerCase() === name);
  if (index < 0) return 0;
  // Lists of equal length are the same scale twice, so a label names an exact
  // star. Anything else has to land somewhere inside a band, and the middle is
  // the only choice that round-trips back to the label it came from.
  if (reviews.length === tiers) return index + 1;
  const band = tiers / reviews.length;
  return Math.round((index + 0.5) * band * 10) / 10;
}

// ---------------------------------------------------------------------------
// Two small facts about a title that several surfaces need
// ---------------------------------------------------------------------------

/**
 * Is this watched in one sitting?
 *
 * A film has a start date and an end date that are the same evening, so it is
 * asked for one date rather than two. Anything with more than one episode is
 * not — a series genuinely has a beginning and an end weeks apart.
 */
export function isSingleSitting(title: TitleV4): boolean {
  if (title.tmdbMediaType === "movie") return true;
  if (title.tmdbMediaType === "tv") return false;
  return title.type === TYPE_MOVIE || title.totalEpisodes <= 1;
}

/**
 * An IMDb id out of a URL someone pasted by hand.
 *
 * Before there was a button, the way to keep an IMDb link was to paste it into
 * the free-text Link field — so that field is where the ids already are, on
 * exactly the titles a provider lookup cannot help with.
 */
export function imdbIdFromUrl(url: string): string {
  const match = /imdb\.com\/title\/(tt\d+)/i.exec(url ?? "");
  return match?.[1] ?? "";
}

/** The IMDb page for a title, or "" when nothing links it to one. */
export function imdbUrl(title: { imdbId?: string }): string {
  const id = (title.imdbId ?? "").trim();
  return /^tt\d+$/.test(id) ? `https://www.imdb.com/title/${id}/` : "";
}

// ---------------------------------------------------------------------------
// The two patches that keep them in step
// ---------------------------------------------------------------------------

/** The subset of a title these two rules read. */
interface Judged {
  rating: number;
  review: string;
}

/**
 * Changing the rating changes the review to match. Unconditionally: an earlier
 * version only synced "while they still agree", which meant a review set by
 * hand silently froze the link and looked broken.
 */
export function syncedRatingPatch(
  title: Judged,
  rating: number,
  reviews: readonly { name: string }[],
): { rating: number; review?: string } {
  const review = reviewForRating(rating, reviews);
  return review === title.review ? { rating } : { rating, review };
}

/**
 * Changing the review changes the rating to match, with one exception: a
 * rating that already *means* this review is left alone. Rewriting 4.5 stars
 * as "the middle of the Marvelous band" would throw away precision the user
 * entered, and would not change what the review says.
 */
export function syncedReviewPatch(
  title: Judged,
  review: string,
  reviews: readonly { name: string }[],
): { review: string; rating?: number } {
  if (review.trim() === "") {
    // Clearing the review clears the judgement.
    return title.rating > 0 ? { review, rating: 0 } : { review };
  }
  if (reviewForRating(title.rating, reviews) === review) return { review };
  const rating = ratingForReview(review, reviews);
  return rating > 0 ? { review, rating } : { review };
}
