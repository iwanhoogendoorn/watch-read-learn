/**
 * The "just watched it" wizard, driven for real.
 *
 * The detail modal's copy of this binding was fixed first; this one still had
 * its own, one-directional and gated, which is how a screenshot of one star
 * beside the word "Good" happened. Same lesson as last time: assert what the
 * controls *show*, not what a helper returns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WatchedModal, todayString, type WatchedResult } from "../src/ui/modals/watched";
import { createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { TitleV4 } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

const REVIEWS = [
  { name: "Nah", color: "#a" },
  { name: "Meh", color: "#b" },
  { name: "Good", color: "#c" },
  { name: "Awesome", color: "#d" },
  { name: "Marvelous", color: "#e" },
];

const TIERS = [
  { label: "Poor", color: "#a" },
  { label: "Fair", color: "#b" },
  { label: "Good", color: "#c" },
  { label: "Great", color: "#d" },
  { label: "Masterpiece", color: "#e" },
];

function open(over: Partial<TitleV4> = {}) {
  const title = createTitle({ id: "t", title: "A Film", type: "Movie" });
  Object.assign(title, over);
  let saved: WatchedResult | null = null;

  const modal = new WatchedModal({} as never, {
    title,
    dateFormat: "european",
    ratingTiers: TIERS,
    halfStars: false,
    reviews: REVIEWS,
    now: new Date(2026, 7, 14),
    onConfirm: (result) => {
      saved = result as WatchedResult;
    },
  });
  const contentEl = createHost(900);
  const modalEl = createHost(900);
  Object.assign(modal as unknown as Record<string, unknown>, { contentEl, modalEl });
  modal.onOpen();

  const el = contentEl as unknown as StubEl;
  return {
    el,
    modal,
    result: () => saved,
    select: () => el.querySelectorAll("select")[0] as StubEl,
    stars: () => el.querySelectorAll(".wl-stars")[0] as StubEl,
    save: () =>
      el
        .querySelectorAll("button")
        .find((b) => b.textContent === "Mark watched")
        ?.fire("click"),
  };
}

function press(stars: StubEl, times: number): void {
  for (let i = 0; i < times; i += 1) {
    stars.fire("keydown", {
      key: "ArrowRight",
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  }
}

describe("the wizard's rating and review", () => {
  it("moves the review when the rating moves, on screen", () => {
    const w = open({ rating: 0, review: "" });
    press(w.stars(), 4);
    expect(w.select().value).toBe("Awesome");
  });

  it("moves the rating when the review moves, on screen", () => {
    // The screenshot: one star beside "Good". The stars must follow.
    const w = open({ rating: 1, review: "" });
    const select = w.select();
    select.value = "Good";
    select.fire("change");
    expect(w.stars().getAttribute("aria-valuetext")).toContain("3");
  });

  it("keeps moving after the review has been touched once", () => {
    // The gate that caused this: once a review was chosen by hand, the rating
    // stopped updating it for the rest of the session.
    const w = open({ rating: 0, review: "" });
    const select = w.select();
    select.value = "Good";
    select.fire("change");
    press(w.stars(), 0);
    w.stars().fire("keydown", {
      key: "End",
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    expect(w.select().value).toBe("Marvelous");
  });

  it("saves both, agreeing with each other", () => {
    const w = open({ rating: 0, review: "" });
    const select = w.select();
    select.value = "Nah";
    select.fire("change");
    w.save();
    expect(w.result()).toMatchObject({ rating: 1, review: "Nah" });
  });

  it("defaults the date to today", () => {
    const w = open({ rating: 0, review: "" });
    w.save();
    expect(w.result()?.date).toBe(todayString(new Date(2026, 7, 14)));
  });

  it("changes nothing when cancelled", () => {
    const w = open({ rating: 0, review: "" });
    press(w.stars(), 5);
    w.el
      .querySelectorAll("button")
      .find((b) => b.textContent === "Cancel")
      ?.fire("click");
    expect(w.result()).toBeNull();
  });
});
