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
  // The middle of that label's band, so round-tripping a rating through a
  // review does not drift to an edge.
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

/** The IMDb page for a title, or "" when nothing links it to one. */
export function imdbUrl(title: { imdbId?: string }): string {
  const id = (title.imdbId ?? "").trim();
  return /^tt\d+$/.test(id) ? `https://www.imdb.com/title/${id}/` : "";
}
