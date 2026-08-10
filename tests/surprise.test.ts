/**
 * "Surprise me" picker — the pure pool/roll logic behind the modal.
 *
 * The modal itself is a thin shell; what has to be right is *which* titles are
 * ever eligible, and that a re-roll visibly rolls. Both are pinned here with a
 * deterministic RNG.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import type { TitleV4 } from "../src/types";
import { pickSurprise, surprisePool, surpriseTypes } from "../src/ui/modals/surprise";

function title(id: string, status: string, type = "Movie"): TitleV4 {
  return createTitle({ id, title: id, type, status });
}

/** An rng that returns the given values in order, then repeats the last. */
function rngOf(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("surprisePool", () => {
  it("keeps only Plan to watch and Watching", () => {
    const pool = surprisePool([
      title("planned", "Plan to watch"),
      title("watching", "Watching"),
      title("done", "Completed"),
      title("dropped", "Dropped"),
      title("future", "To be released"),
    ]);
    expect(pool.map((t) => t.id)).toEqual(["planned", "watching"]);
  });

  it("is empty for an empty library", () => {
    expect(surprisePool([])).toEqual([]);
  });
});

describe("surpriseTypes", () => {
  it("lists each type once, in first-seen order", () => {
    const pool = [
      title("a", "Watching", "TV Show"),
      title("b", "Watching", "Movie"),
      title("c", "Watching", "TV Show"),
    ];
    expect(surpriseTypes(pool)).toEqual(["TV Show", "Movie"]);
  });
});

describe("pickSurprise", () => {
  const pool = [
    title("m1", "Plan to watch", "Movie"),
    title("m2", "Plan to watch", "Movie"),
    title("t1", "Watching", "TV Show"),
  ];

  it("returns null for an empty pool", () => {
    expect(pickSurprise([], "", rngOf(0))).toBeNull();
  });

  it("picks by rng position", () => {
    expect(pickSurprise(pool, "", rngOf(0))?.id).toBe("m1");
    expect(pickSurprise(pool, "", rngOf(0.999))?.id).toBe("t1");
  });

  it("narrows to the type filter", () => {
    expect(pickSurprise(pool, "TV Show", rngOf(0))?.id).toBe("t1");
    expect(pickSurprise(pool, "Anime", rngOf(0))).toBeNull();
  });

  it("never repeats the avoided title while an alternative exists", () => {
    // rng always says "first candidate": with m1 avoided, first is m2.
    expect(pickSurprise(pool, "Movie", rngOf(0), "m1")?.id).toBe("m2");
  });

  it("repeats the avoided title when it is the only candidate", () => {
    expect(pickSurprise(pool, "TV Show", rngOf(0), "t1")?.id).toBe("t1");
  });

  it("clamps an rng that returns 1 exactly", () => {
    expect(pickSurprise(pool, "", rngOf(1))?.id).toBe("t1");
  });
});
