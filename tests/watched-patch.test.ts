/**
 * `watchedPatch` — the one copy of what "I watched it" writes.
 *
 * The wizard and the HTTP API both call it, so these are the wizard's rules
 * pinned at the source: blanks write nothing, a film's two dates are one, and a
 * series keeps the start it already had.
 */
import { describe, expect, it } from "vitest";
import { STATUS_COMPLETED } from "../src/constants";
import { createTitle } from "../src/data/schema";
import { watchedPatch } from "../src/data/watched";
import type { TitleV4 } from "../src/types";

function film(over: Partial<TitleV4> = {}): TitleV4 {
  return Object.assign(createTitle({ id: "f", title: "A Film", type: "Movie" }), over);
}

function show(over: Partial<TitleV4> = {}): TitleV4 {
  return Object.assign(
    createTitle({
      id: "s",
      title: "A Show",
      type: "TV Show",
      totalEpisodes: 8,
      seasons: [{ name: "Season 1", episodes: 8, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    }),
    over,
  );
}

const BLANK = { date: null, rating: 0, review: "", watchedVia: "" };

describe("watchedPatch", () => {
  it("writes only the status when nothing else was answered", () => {
    const patch = watchedPatch(film({ rating: 3, review: "Good", watchedVia: "Plex" }), BLANK);
    expect(patch).toEqual({ status: STATUS_COMPLETED });
    // Rating 0, a blank review and a blank venue are "did not say", not "clear".
    expect("rating" in patch).toBe(false);
    expect("review" in patch).toBe(false);
    expect("watchedVia" in patch).toBe(false);
    expect("dateStarted" in patch).toBe(false);
    expect("dateFinished" in patch).toBe(false);
  });

  it("sets both dates on a film, overwriting an old start", () => {
    const patch = watchedPatch(film({ dateStarted: "2020-01-01" }), { ...BLANK, date: "2026-10-26" });
    expect(patch.dateStarted).toBe("2026-10-26");
    expect(patch.dateFinished).toBe("2026-10-26");
  });

  it("keeps a show's existing start date", () => {
    const patch = watchedPatch(show({ dateStarted: "2026-09-01" }), { ...BLANK, date: "2026-10-26" });
    expect(patch.dateFinished).toBe("2026-10-26");
    expect("dateStarted" in patch).toBe(false);
  });

  it("gives a show with no start date the finish date as its start", () => {
    const patch = watchedPatch(show(), { ...BLANK, date: "2026-10-26" });
    expect(patch.dateStarted).toBe("2026-10-26");
    expect(patch.dateFinished).toBe("2026-10-26");
  });

  it("writes rating, review and venue when they were given", () => {
    const patch = watchedPatch(film(), {
      date: "2026-10-26",
      rating: 4,
      review: "Awesome",
      watchedVia: "Cinema",
    });
    expect(patch).toEqual({
      status: STATUS_COMPLETED,
      dateStarted: "2026-10-26",
      dateFinished: "2026-10-26",
      rating: 4,
      review: "Awesome",
      watchedVia: "Cinema",
    });
  });
});
