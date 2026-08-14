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
import { imdbUrl, isSingleSitting, ratingForReview, reviewForRating } from "../src/data/review";
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
