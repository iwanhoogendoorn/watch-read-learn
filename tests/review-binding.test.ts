/**
 * Binding the star rating to the review label.
 *
 * Both fields mean "what did you think of it", and the lists are configurable
 * and need not be the same length — three reviews across five stars is the
 * shipped default. The mapping has to be proportional, stable in both
 * directions, and above all it has to be a *proposal*: the caller only ever
 * applies it where the user has not already answered.
 */
import { describe, expect, it } from "vitest";
import {
  imdbIdFromUrl,
  imdbUrl,
  isSingleSitting,
  ratingForReview,
  reviewForRating,
  syncedRatingPatch,
  syncedReviewPatch,
} from "../src/data/review";
import { createTitle } from "../src/data/schema";
import type { TitleV4 } from "../src/types";

const REVIEWS = [{ name: "Nah" }, { name: "Awesome" }, { name: "Marvelous" }];

describe("the review a rating proposes", () => {
  it("spreads three labels across five stars", () => {
    expect(reviewForRating(1, REVIEWS)).toBe("Nah");
    expect(reviewForRating(2, REVIEWS)).toBe("Awesome");
    expect(reviewForRating(3, REVIEWS)).toBe("Awesome");
    expect(reviewForRating(4, REVIEWS)).toBe("Marvelous");
    expect(reviewForRating(5, REVIEWS)).toBe("Marvelous");
  });

  it("matches one-to-one when the lists are the same length", () => {
    const five = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }];
    expect(five.map((_, i) => reviewForRating(i + 1, five))).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("proposes nothing for an unrated title", () => {
    expect(reviewForRating(0, REVIEWS)).toBe("");
    expect(reviewForRating(Number.NaN, REVIEWS)).toBe("");
  });

  it("survives a rating outside the scale rather than indexing past the end", () => {
    expect(reviewForRating(9, REVIEWS)).toBe("Marvelous");
    expect(reviewForRating(-2, REVIEWS)).toBe("");
  });

  it("proposes nothing when the user has no review labels configured", () => {
    expect(reviewForRating(4, [])).toBe("");
  });

  it("handles half stars", () => {
    expect(reviewForRating(3.5, REVIEWS)).toBe("Marvelous");
    expect(reviewForRating(1.5, REVIEWS)).toBe("Nah");
  });
});

describe("the rating a review implies", () => {
  it("lands in the middle of that label's band, not at an edge", () => {
    // Three labels across five stars: bands of 1.67, so midpoints 0.8/2.5/4.2.
    expect(ratingForReview("Nah", REVIEWS)).toBeCloseTo(0.8, 1);
    expect(ratingForReview("Awesome", REVIEWS)).toBeCloseTo(2.5, 1);
    expect(ratingForReview("Marvelous", REVIEWS)).toBeCloseTo(4.2, 1);
  });

  it("round-trips back to the same label", () => {
    for (const review of REVIEWS) {
      const rating = ratingForReview(review.name, REVIEWS);
      expect(reviewForRating(rating, REVIEWS), review.name).toBe(review.name);
    }
  });

  it("ignores case and stray spacing, because these are user-typed labels", () => {
    expect(ratingForReview("  awesome ", REVIEWS)).toBeCloseTo(2.5, 1);
  });

  it("says nothing about a label that is not in the list", () => {
    expect(ratingForReview("Sublime", REVIEWS)).toBe(0);
    expect(ratingForReview("", REVIEWS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The two small facts the modal asks about a title
// ---------------------------------------------------------------------------

describe("what counts as one sitting", () => {
  const title = (over: Partial<TitleV4>): TitleV4 => {
    const t = createTitle({ id: "t", title: "T", type: "Movie" });
    Object.assign(t, over);
    return t;
  };

  it("trusts the provider's media type first", () => {
    expect(isSingleSitting(title({ tmdbMediaType: "movie", type: "TV Show" }))).toBe(true);
    // A show wrongly typed as Movie locally is still a show; two dates stand.
    expect(isSingleSitting(title({ tmdbMediaType: "tv", type: "Movie" }))).toBe(false);
  });

  it("falls back to the local type when nothing upstream says", () => {
    expect(isSingleSitting(title({ type: "Movie", totalEpisodes: 1 }))).toBe(true);
    expect(isSingleSitting(title({ type: "TV Show", totalEpisodes: 32 }))).toBe(false);
  });

  it("treats a one-episode entry as a sitting whatever it is called", () => {
    expect(isSingleSitting(title({ type: "Documentary", totalEpisodes: 1 }))).toBe(true);
  });
});

describe("the IMDb link", () => {
  it("builds a page URL from a real id", () => {
    expect(imdbUrl({ imdbId: "tt9288030" })).toBe("https://www.imdb.com/title/tt9288030/");
  });

  it("offers nothing rather than a guess when there is no id", () => {
    // A search URL built from the title would look identical and be wrong
    // often enough to matter.
    expect(imdbUrl({})).toBe("");
    expect(imdbUrl({ imdbId: "" })).toBe("");
    expect(imdbUrl({ imdbId: "   " })).toBe("");
  });

  it("refuses anything that is not an IMDb id", () => {
    expect(imdbUrl({ imdbId: "219971" })).toBe("");
    expect(imdbUrl({ imdbId: "https://example.com/evil" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Harvesting an id from a link someone pasted by hand
// ---------------------------------------------------------------------------

describe("an IMDb id out of a pasted link", () => {
  it("reads the id out of a page URL", () => {
    expect(imdbIdFromUrl("https://www.imdb.com/title/tt33764258")).toBe("tt33764258");
    expect(imdbIdFromUrl("https://www.imdb.com/title/tt22084616/?ref_=nv_sr_1")).toBe("tt22084616");
    expect(imdbIdFromUrl("http://imdb.com/title/tt0145487/")).toBe("tt0145487");
  });

  it("takes nothing from a link to somewhere else", () => {
    expect(imdbIdFromUrl("https://www.themoviedb.org/movie/557")).toBe("");
    expect(imdbIdFromUrl("https://example.com/imdb.com/title/tt1")).toBe("tt1");
    expect(imdbIdFromUrl("")).toBe("");
  });

  it("round-trips into a link the plugin will render", () => {
    const id = imdbIdFromUrl("https://www.imdb.com/title/tt33043892/");
    expect(imdbUrl({ imdbId: id })).toBe("https://www.imdb.com/title/tt33043892/");
  });
});

// ---------------------------------------------------------------------------
// Keeping the two in step — the rules that shipped wrong twice
// ---------------------------------------------------------------------------

describe("changing the rating", () => {
  it("always moves the review with it", () => {
    expect(syncedRatingPatch({ rating: 1, review: "Nah" }, 5, REVIEWS)).toEqual({
      rating: 5,
      review: "Marvelous",
    });
  });

  it("moves a review the user set by hand", () => {
    // The bug: an earlier rule only synced "while they agree", so a review
    // chosen by hand froze the link and the pair looked disconnected.
    expect(syncedRatingPatch({ rating: 0, review: "Marvelous" }, 1, REVIEWS)).toEqual({
      rating: 1,
      review: "Nah",
    });
  });

  it("writes no review when it is already right", () => {
    expect(syncedRatingPatch({ rating: 4, review: "Marvelous" }, 5, REVIEWS)).toEqual({ rating: 5 });
  });

  it("clears the review when the rating is cleared", () => {
    expect(syncedRatingPatch({ rating: 4, review: "Marvelous" }, 0, REVIEWS)).toEqual({
      rating: 0,
      review: "",
    });
  });
});

describe("changing the review", () => {
  it("moves the rating with it", () => {
    const patch = syncedReviewPatch({ rating: 0, review: "" }, "Marvelous", REVIEWS);
    expect(patch.review).toBe("Marvelous");
    expect(patch.rating).toBeCloseTo(4.2, 1);
  });

  it("leaves a rating that already means this review alone", () => {
    // 4.5 already reads as Marvelous; rewriting it as the band's midpoint
    // would lose half a star for no change in meaning.
    expect(syncedReviewPatch({ rating: 4.5, review: "Marvelous" }, "Marvelous", REVIEWS)).toEqual({
      review: "Marvelous",
    });
  });

  it("overwrites a rating that means something else", () => {
    const patch = syncedReviewPatch({ rating: 5, review: "Marvelous" }, "Nah", REVIEWS);
    expect(patch.rating).toBeCloseTo(0.8, 1);
  });

  it("clearing the review clears the rating", () => {
    expect(syncedReviewPatch({ rating: 4, review: "Marvelous" }, "", REVIEWS)).toEqual({
      review: "",
      rating: 0,
    });
  });

  it("survives a vault with no review labels configured", () => {
    expect(syncedReviewPatch({ rating: 3, review: "" }, "Anything", [])).toEqual({
      review: "Anything",
    });
  });
});

// ---------------------------------------------------------------------------
// Five labels against five stars: the same scale, spelled twice
// ---------------------------------------------------------------------------

describe("a review list the same length as the rating scale", () => {
  const FIVE = [
    { name: "Nah" },
    { name: "Meh" },
    { name: "Good" },
    { name: "Awesome" },
    { name: "Marvelous" },
  ];

  it("maps one star to one label", () => {
    expect([1, 2, 3, 4, 5].map((r) => reviewForRating(r, FIVE))).toEqual([
      "Nah",
      "Meh",
      "Good",
      "Awesome",
      "Marvelous",
    ]);
  });

  it("maps a label back to a whole star, not to half of one", () => {
    // With three labels a review lands mid-band (0.8, 2.5, 4.2). With five it
    // is the same scale twice over, so it must land exactly.
    expect(FIVE.map((r) => ratingForReview(r.name, FIVE))).toEqual([1, 2, 3, 4, 5]);
  });

  it("round-trips in both directions", () => {
    for (let stars = 1; stars <= 5; stars += 1) {
      expect(ratingForReview(reviewForRating(stars, FIVE), FIVE), `${stars}★`).toBe(stars);
    }
  });

  it("still keeps a half-star rating that already means the right label", () => {
    // 3.5 rounds up into the Awesome band, so re-picking Awesome must not
    // flatten it to a round 4 and lose the half star.
    expect(reviewForRating(3.5, FIVE)).toBe("Awesome");
    expect(syncedReviewPatch({ rating: 3.5, review: "Awesome" }, "Awesome", FIVE)).toEqual({
      review: "Awesome",
    });
  });
});
