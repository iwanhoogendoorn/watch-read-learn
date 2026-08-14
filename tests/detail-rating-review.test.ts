/**
 * Rating and review, driven through the real modal.
 *
 * The mapping functions have been unit-tested and correct for three releases
 * while the user kept reporting the two fields were not connected — which
 * means the tests were pointed at the wrong thing. These drive the actual
 * `DetailModal` against a real store: pick a review in the select, and assert
 * both the stored title *and* what is on screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetailModal } from "../src/ui/modals/detail";
import { WatchLogStore } from "../src/data/store";
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

async function open(over: Partial<TitleV4> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();

  const title = createTitle({ id: "t", title: "A Film", type: "Movie" });
  Object.assign(title, over);
  store.data.titles.push(title);

  const modal = new DetailModal({} as never, { store: store as never, titleId: "t" });
  // The Modal base class supplies these in Obsidian; the harness supplies them
  // here so the real onOpen/render path runs unchanged.
  const contentEl = createHost(900);
  const modalEl = createHost(900);
  Object.assign(modal as unknown as Record<string, unknown>, { contentEl, modalEl });
  modal.onOpen();

  return { store, title, el: contentEl as unknown as StubEl };
}

/** The Review dropdown, by its label — the same way a person finds it. */
function reviewSelect(el: StubEl): StubEl {
  const select = el.querySelectorAll("select").find((s) => s.getAttribute("aria-label") === "Review");
  if (!select) throw new Error("no Review select");
  return select;
}

function shownRating(el: StubEl): string {
  return el.querySelectorAll(".wl-stars")[0]?.getAttribute("aria-valuetext") ?? "";
}

describe("picking a review", () => {
  it("moves the rating with it, in the store", async () => {
    const { store, el } = await open({ rating: 0, review: "" });
    const select = reviewSelect(el);
    select.value = "Marvelous";
    select.fire("change");

    expect(store.getTitle("t")?.review).toBe("Marvelous");
    expect(store.getTitle("t")?.rating).toBe(5);
  });

  it("moves the rating on screen too, not only in the data", async () => {
    // The complaint was about what the modal *shows*: a write nobody can see
    // is indistinguishable from no write at all.
    const { el } = await open({ rating: 0, review: "" });
    const select = reviewSelect(el);
    select.value = "Nah";
    select.fire("change");

    expect(shownRating(el)).toContain("1");
  });

  it("clears the rating when the review is cleared", async () => {
    const { store, el } = await open({ rating: 4, review: "Awesome" });
    const select = reviewSelect(el);
    select.value = "";
    select.fire("change");

    expect(store.getTitle("t")?.rating).toBe(0);
    expect(store.getTitle("t")?.review).toBe("");
  });

  it("overwrites a review the user set by hand", async () => {
    const { store, el } = await open({ rating: 5, review: "Marvelous" });
    const select = reviewSelect(el);
    select.value = "Meh";
    select.fire("change");

    expect(store.getTitle("t")?.review).toBe("Meh");
    expect(store.getTitle("t")?.rating).toBe(2);
  });
});

describe("setting a rating", () => {
  it("moves the review with it, in the store and in the select", async () => {
    const { store, el } = await open({ rating: 0, review: "" });
    const stars = el.querySelectorAll(".wl-stars")[0];
    if (!stars) throw new Error("no stars widget");
    // Keyboard is the deterministic path: one press per step from zero.
    for (let i = 0; i < 4; i += 1) {
      stars.fire("keydown", {
        key: "ArrowRight",
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    }

    expect(store.getTitle("t")?.rating).toBe(4);
    expect(store.getTitle("t")?.review).toBe("Awesome");
    expect(reviewSelect(el).value).toBe("Awesome");
  });
});
