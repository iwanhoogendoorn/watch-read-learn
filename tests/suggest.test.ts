/**
 * The suggestion engine.
 *
 * The failures that matter here are not "the ranking is slightly off" — they
 * are suggesting something the user already owns, something they explicitly
 * said no to, or something a show they *dropped* voted for. Most of this file
 * is about refusing.
 */
import { describe, expect, it } from "vitest";
import { pickSeeds, rankSuggestions, seedWeightFor, type Candidate } from "../src/services/suggest";
import { createTitle } from "../src/data/schema";
import type { OverseerrSearchResult, TitleV4 } from "../src/types";

function result(over: Partial<OverseerrSearchResult> = {}): OverseerrSearchResult {
  return {
    tmdbId: 1,
    mediaType: "movie",
    title: "A Film",
    year: 2020,
    releaseDate: "2020-01-01",
    overview: "",
    posterUrl: "p.jpg",
    voteAverage: 7,
    voteCount: 1000,
    genreIds: [35],
    ...over,
  };
}

const from = (
  tmdbId: number,
  seedName: string,
  over: Partial<Candidate> = {},
): Candidate => ({
  result: result({ tmdbId, title: `Film ${tmdbId}` }),
  source: "recommendation",
  seedName,
  seedWeight: 1,
  ...over,
});

function title(over: Partial<TitleV4>): TitleV4 {
  const t = createTitle({ id: "x", title: "X", type: "Movie" });
  Object.assign(t, over);
  return t;
}

describe("how much a seed's opinion is worth", () => {
  it("lets a rating speak loudest", () => {
    expect(seedWeightFor(title({ rating: 5 }))).toBe(1);
    expect(seedWeightFor(title({ rating: 3 }))).toBeCloseTo(0.6);
  });

  it("treats finishing something as a quieter yes", () => {
    expect(seedWeightFor(title({ rating: 0, status: "Completed" }))).toBe(0.7);
  });

  it("gives a dropped show no vote at all", () => {
    // A show you abandoned recommending more of the same is exactly what makes
    // people switch recommendations off.
    expect(seedWeightFor(title({ rating: 0, status: "Dropped" }))).toBe(0);
    expect(seedWeightFor(title({ rating: 4, status: "Dropped" }))).toBe(0);
  });
});

describe("choosing what to ask about", () => {
  it("prefers the titles you rated highest", () => {
    const seeds = pickSeeds([
      title({ id: "a", title: "Loved", tmdbId: 1, rating: 5 }),
      title({ id: "b", title: "Fine", tmdbId: 2, rating: 3 }),
      title({ id: "c", title: "Finished", tmdbId: 3, status: "Completed" }),
    ]);
    expect(seeds[0]?.title).toBe("Loved");
  });

  it("never seeds from something with no provider link", () => {
    const seeds = pickSeeds([title({ id: "a", title: "Unlinked", rating: 5 })]);
    expect(seeds).toHaveLength(0);
  });

  it("never seeds from a dropped show", () => {
    const seeds = pickSeeds([title({ id: "a", title: "Abandoned", tmdbId: 9, status: "Dropped" })]);
    expect(seeds).toHaveLength(0);
  });

  it("stops at the limit, so a big library is not a big bill", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      title({ id: `t${i}`, title: `T${i}`, tmdbId: i + 1, rating: 5 }),
    );
    expect(pickSeeds(many, 8)).toHaveLength(8);
  });
});

describe("ranking what came back", () => {
  it("puts what several seeds agree on first", () => {
    const ranked = rankSuggestions([
      from(10, "Reacher"),
      from(10, "Jack Ryan"),
      from(10, "The Terminal List"),
      from(11, "Reacher"),
    ]);
    expect(ranked[0]?.result.tmdbId).toBe(10);
    expect(ranked[0]?.seedCount).toBe(3);
    expect(ranked[0]?.reasons[0]).toBe("Because you watched Reacher and 2 others");
  });

  it("names one seed plainly", () => {
    const ranked = rankSuggestions([from(10, "Reacher")]);
    expect(ranked[0]?.reasons[0]).toBe("Because you watched Reacher");
  });

  it("counts a recommendation for more than a genre browse", () => {
    const ranked = rankSuggestions([
      { result: result({ tmdbId: 20 }), source: "discover" },
      from(21, "Reacher"),
    ]);
    expect(ranked[0]?.result.tmdbId).toBe(21);
  });

  it("does not let one seed vote twice for the same film", () => {
    const once = rankSuggestions([from(30, "Reacher")]);
    const twice = rankSuggestions([
      from(30, "Reacher"),
      from(30, "Reacher", { source: "similar" }),
    ]);
    expect(twice[0]?.seedCount).toBe(1);
    expect(twice[0]?.score).toBeCloseTo(once[0]?.score ?? 0);
  });

  it("never suggests something already in the library", () => {
    const ranked = rankSuggestions([from(40, "Reacher")], { owned: new Set([40]) });
    expect(ranked).toHaveLength(0);
  });

  it("never suggests something the user dismissed", () => {
    const ranked = rankSuggestions([from(41, "Reacher")], { dismissed: new Set([41]) });
    expect(ranked).toHaveLength(0);
  });

  it("drops the unverifiable rather than calling it undiscovered", () => {
    const obscure = { ...from(50, "Reacher"), result: result({ tmdbId: 50, voteCount: 3 }) };
    expect(rankSuggestions([obscure])).toHaveLength(0);
  });

  it("honours a rating floor without punishing an unrated title", () => {
    const weak = { ...from(60, "S"), result: result({ tmdbId: 60, voteAverage: 4 }) };
    const unrated = { ...from(61, "S"), result: result({ tmdbId: 61, voteAverage: 0 }) };
    const ranked = rankSuggestions([weak, unrated], { minRating: 6 });
    expect(ranked.map((s) => s.result.tmdbId)).toEqual([61]);
  });

  it("honours an era", () => {
    const old = { ...from(70, "S"), result: result({ tmdbId: 70, year: 1994, releaseDate: "1994-02-04" }) };
    const recent = { ...from(71, "S"), result: result({ tmdbId: 71, year: 2024, releaseDate: "2024-01-01" }) };
    expect(
      rankSuggestions([old, recent], { fromYear: 2000 }).map((s) => s.result.tmdbId),
    ).toEqual([71]);
    expect(
      rankSuggestions([old, recent], { toYear: 1999 }).map((s) => s.result.tmdbId),
    ).toEqual([70]);
  });

  it("caps the list when asked", () => {
    const many = Array.from({ length: 30 }, (_, i) => from(100 + i, "S"));
    expect(rankSuggestions(many, { limit: 5 })).toHaveLength(5);
  });

  it("explains a wizard result even with no seed to name", () => {
    const ranked = rankSuggestions([{ result: result({ tmdbId: 80 }), source: "discover" }]);
    expect(ranked[0]?.reasons).toEqual(["Matches what you asked for"]);
  });
});

describe("more like this, for one title", () => {
  it("names the title it came from", () => {
    const ranked = rankSuggestions([from(90, "Ace Ventura: Pet Detective")]);
    expect(ranked[0]?.reasons[0]).toBe("Because you watched Ace Ventura: Pet Detective");
  });

  it("still refuses what is already owned, with only one seed to go on", () => {
    // A single seed means no consensus to lean on, so the owned/vote filters
    // are the only thing between the user and a list of noise.
    const ranked = rankSuggestions([from(91, "Reacher"), from(92, "Reacher")], {
      owned: new Set([91]),
    });
    expect(ranked.map((s) => s.result.tmdbId)).toEqual([92]);
  });
});
