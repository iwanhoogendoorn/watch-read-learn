/**
 * Completing half-judged titles — the wreckage the 1.19–1.22 sync bugs left.
 *
 * The plan is built by the SAME two mapping functions the live binding uses,
 * so what it writes is exactly what the sync would have written at the time.
 * These pin the boundaries: both-present is never touched (even disagreeing),
 * both-absent is never touched, and a label outside the configured list
 * implies nothing.
 */
import { describe, expect, it } from "vitest";
import { reconcileJudgements } from "../src/data/review";

const REVIEWS = [
  { name: "Nah" },
  { name: "Meh" },
  { name: "Good" },
  { name: "Awesome" },
  { name: "Marvelous" },
];

const t = (id: string, rating: number, review: string) => ({ id, title: id, rating, review });

describe("reconcileJudgements", () => {
  it("gives a rated title the review its stars imply", () => {
    const plan = reconcileJudgements([t("agency", 5, "")], REVIEWS);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.patch).toEqual({ review: "Marvelous" });
  });

  it("gives a reviewed title the stars its label implies", () => {
    const plan = reconcileJudgements([t("goodluck", 0, "Awesome")], REVIEWS);
    expect(plan[0]?.patch).toEqual({ rating: 4 });
  });

  it("matches the real library's five orphans, and nothing else", () => {
    const titles = [
      t("the-agency", 5, ""),
      t("dont-say-good-luck", 0, "Awesome"),
      t("spider-man-bnd", 5, ""),
      t("the-odyssey", 5, ""),
      t("jackal", 5, ""),
      t("voicemails", 4, "Awesome"), // both halves present — untouched
      t("reacher", 0, ""), // unjudged — untouched
    ];
    const plan = reconcileJudgements(titles, REVIEWS);
    expect(plan.map((p) => p.id).sort()).toEqual(
      ["dont-say-good-luck", "jackal", "spider-man-bnd", "the-agency", "the-odyssey"].sort(),
    );
  });

  it("never touches a disagreement between two halves the user typed", () => {
    // 1★ beside "Marvelous" is odd, but both are theirs.
    expect(reconcileJudgements([t("odd", 1, "Marvelous")], REVIEWS)).toHaveLength(0);
  });

  it("implies nothing from a label outside the configured list", () => {
    expect(reconcileJudgements([t("stray", 0, "Bangers")], REVIEWS)).toHaveLength(0);
  });

  it("says what it will do, per title, in words", () => {
    const plan = reconcileJudgements([t("The Agency", 5, "")], REVIEWS);
    expect(plan[0]?.describe).toContain("The Agency");
    expect(plan[0]?.describe).toContain("Marvelous");
  });

  it("is proportional when the lists are unequal", () => {
    const three = [{ name: "Bad" }, { name: "Fine" }, { name: "Great" }];
    const plan = reconcileJudgements([t("x", 5, "")], three);
    expect(plan[0]?.patch).toEqual({ review: "Great" });
  });
});
