/**
 * One card shape, whatever the card holds.
 *
 * A caption row that disappears when it has nothing to say is what makes a
 * grid ragged: an unrated film's caption was a line shorter than the rated
 * show beside it, so the two posters were cropped on different lines and no
 * two cards agreed on where anything was. Every row is present on every card;
 * CSS reserves each one's height.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTitleCard } from "../src/ui/components/card";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { CardContext, Settings, TitleV4, WatchLogStoreApi } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

function storeOf(settings: Settings = createDefaultSettings()): WatchLogStoreApi {
  return { settings, allTitles: () => [], getTitle: () => undefined } as unknown as WatchLogStoreApi;
}

function cardFor(over: Partial<TitleV4>): StubEl {
  const host = createHost(900);
  const title = createTitle({ id: "t", title: "A Title", type: "Movie", ...over });
  Object.assign(title, over);
  const ctx = {
    store: storeOf(),
    showActions: false,
    showAiringChip: true,
    showRating: true,
    showProgress: true,
    onOpen: () => undefined,
  } as unknown as CardContext;
  buildTitleCard(host as unknown as HTMLElement, title, ctx);
  return host.querySelectorAll(".wl-card")[0] as StubEl;
}

/** The rows a caption is made of, in order. */
const ROWS = [".wl-card-title", ".wl-card-pills", ".wl-card-meta"];

describe("every card has the same caption rows", () => {
  const cases: Array<[string, Partial<TitleV4>]> = [
    ["a rated, finished show", { type: "TV Show", rating: 5, totalEpisodes: 10, status: "Completed" }],
    ["an unrated film with nothing but a year", { type: "Movie", rating: 0, year: 2002 }],
    ["a show part-way through", { type: "TV Show", rating: 0, totalEpisodes: 32, watchedEpisodes: [1, 2] }],
    ["a title with no status at all", { status: "" }],
    ["a title with no year and no episodes", { year: 0, totalEpisodes: 1 }],
  ];

  for (const [name, over] of cases) {
    it(`keeps every row for ${name}`, () => {
      const card = cardFor(over);
      for (const row of ROWS) {
        expect(card.querySelectorAll(row).length, `${name} is missing ${row}`).toBe(1);
      }
      // The rating line is either stars or the gap they would have filled —
      // never nothing, or the card below shifts up by a line.
      const rated = card.querySelectorAll(".wl-stars").length;
      const reserved = card.querySelectorAll(".wl-card-rating-empty").length;
      expect(rated + reserved, `${name} has no rating row`).toBe(1);
    });
  }

  it("shows stars only when there is a rating, and the gap otherwise", () => {
    expect(cardFor({ rating: 4 }).querySelectorAll(".wl-stars")).toHaveLength(1);
    expect(cardFor({ rating: 4 }).querySelectorAll(".wl-card-rating-empty")).toHaveLength(0);
    expect(cardFor({ rating: 0 }).querySelectorAll(".wl-stars")).toHaveLength(0);
    expect(cardFor({ rating: 0 }).querySelectorAll(".wl-card-rating-empty")).toHaveLength(1);
  });

  it("keeps the rows in one order, so the same fact is in the same place", () => {
    const card = cardFor({ type: "TV Show", rating: 3, totalEpisodes: 10 });
    const body = card.querySelector(".wl-card-body") as StubEl;
    const classes = body.children.map((child) => child.className.split(" ")[0]);
    expect(classes.slice(0, 3)).toEqual(["wl-card-title", "wl-card-pills", "wl-card-meta"]);
  });
});
