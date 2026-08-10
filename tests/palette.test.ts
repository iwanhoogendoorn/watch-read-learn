/**
 * Insert-widget palette — SPEC §4.9.
 *
 * The point of the palette is that it inserts *real* values from the user's own
 * data. A preset that would need a placeholder is not offered at all.
 */
import { describe, expect, it } from "vitest";
import { createDefaultData, createTitle } from "../src/data/schema";
import { buildWidgetPresets, mostCommon, pinCandidate } from "../src/widgets/palette";
import { defaultWidgetParse } from "../src/widgets/render";
import type { TitleV4, WatchLogData, WatchLogStoreApi } from "../src/types";

/** The read-only slice of the store the palette actually touches. */
function storeWith(titles: TitleV4[], data: WatchLogData = createDefaultData()): WatchLogStoreApi {
  data.titles = titles;
  return {
    data,
    settings: data.settings,
    allTitles: () => data.titles,
  } as unknown as WatchLogStoreApi;
}

function title(overrides: Partial<TitleV4> & { id: string }): TitleV4 {
  return createTitle({ title: overrides.id, type: "TV Show", ...overrides });
}

describe("mostCommon", () => {
  it("returns the most frequent value", () => {
    expect(mostCommon(["a", "b", "a"])).toBe("a");
  });

  it("counts case-insensitively but keeps the first spelling seen", () => {
    expect(mostCommon(["Sci-Fi", "sci-fi", "Drama"])).toBe("Sci-Fi");
  });

  it("breaks ties alphabetically so the palette is stable between opens", () => {
    expect(mostCommon(["b", "a"])).toBe("a");
  });

  it("ignores blanks and returns null for nothing", () => {
    expect(mostCommon([])).toBeNull();
    expect(mostCommon(["", "  "])).toBeNull();
  });
});

describe("pinCandidate", () => {
  it("prefers an explicit pin, then something in progress, then anything", () => {
    const pinned = title({ id: "pinned", pinned: true, status: "Completed" });
    const watching = title({ id: "watching", status: "Watching" });
    const other = title({ id: "other", status: "Completed" });
    expect(pinCandidate([other, watching, pinned], "Watching")?.id).toBe("pinned");
    expect(pinCandidate([other, watching], "Watching")?.id).toBe("watching");
    expect(pinCandidate([other], "Watching")?.id).toBe("other");
    expect(pinCandidate([], "Watching")).toBeNull();
  });
});

describe("buildWidgetPresets", () => {
  it("always offers the data-independent presets", () => {
    const presets = buildWidgetPresets(storeWith([]));
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("cards-watching");
    expect(ids).toContain("upcoming-next");
    expect(ids).toContain("stat-time");
    expect(ids).toContain("random-tonight");
  });

  it("omits presets it cannot personalise", () => {
    const ids = buildWidgetPresets(storeWith([])).map((p) => p.id);
    expect(ids).not.toContain("cards-genre");
    expect(ids).not.toContain("now-pinned");
    expect(ids).not.toContain("table-top-rated");
    expect(ids).not.toContain("cards-missing");
  });

  it("interpolates the user's own genre, type and title id", () => {
    const presets = buildWidgetPresets(
      storeWith([
        title({ id: "dexter", title: "Dexter", genres: ["Crime", "Drama"], pinned: true }),
        title({ id: "severance", title: "Severance", genres: ["Drama"], rating: 5 }),
        title({ id: "dune", title: "Dune", type: "Movie", plex: { state: "available" } }),
      ]),
    );
    const byId = new Map(presets.map((p) => [p.id, p]));

    expect(byId.get("cards-genre")?.snippet).toContain("genre: Drama");
    expect(byId.get("now-pinned")?.snippet).toContain("id: dexter");
    expect(byId.get("now-pinned")?.name).toContain("Dexter");
    expect(byId.get("table-top-rated")).toBeDefined();
    expect(byId.get("cards-missing")).toBeDefined();
    // Most common type wins the list preset — two TV Shows against one Movie.
    expect(byId.get("list-type")?.snippet).toContain("type: TV Show");
  });

  it("uses the user's renamed statuses rather than the shipped defaults", () => {
    const data = createDefaultData();
    data.settings.statuses = [
      { name: "In flight", color: "#000000" },
      { name: "Queued", color: "#000000" },
    ];
    const presets = buildWidgetPresets(storeWith([], data));
    // Neither default name exists any more, so the first configured status stands in.
    expect(presets[0]?.snippet).toContain("status: In flight");
    expect(presets.find((p) => p.id === "random-tonight")?.snippet).toContain("status: In flight");
  });

  it("emits complete, fenced snippets that parse without a single issue", () => {
    const presets = buildWidgetPresets(
      storeWith([title({ id: "a", genres: ["Drama"], rating: 4, pinned: true, plex: { state: "none" } })]),
    );
    expect(presets.length).toBeGreaterThan(8);
    for (const preset of presets) {
      expect(preset.snippet.startsWith("```watch-read-learn\n")).toBe(true);
      expect(preset.snippet.trimEnd().endsWith("```")).toBe(true);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);

      const body = preset.snippet.trim().split("\n").slice(1, -1).join("\n");
      expect(defaultWidgetParse(body).issues).toEqual([]);
    }
  });
});
