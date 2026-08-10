/**
 * The named-preset model (SPEC §4.5): capture, apply, CRUD and load-time
 * hardening. The round-trip tests are the point — a preset that aliases the live
 * view is a data-loss bug waiting to happen.
 */
import { describe, expect, it } from "vitest";
import {
  SORT_DIRECTIONS,
  SORT_KEYS,
  UNTITLED_PRESET_NAME,
  addPreset,
  applyPreset,
  captureView,
  cloneFilterState,
  createPreset,
  deletePreset,
  filterStatesEqual,
  findPreset,
  findPresetByName,
  overwritePreset,
  presetId,
  presetMatchesView,
  renamePreset,
  sanitizePresets,
  viewsEqual,
  type PresetView,
} from "../src/data/presets";
import { createFilterState } from "../src/data/schema";
import type { Preset } from "../src/types";

function makeView(overrides: Partial<PresetView> = {}): PresetView {
  const filters = createFilterState();
  filters.excludedStatuses = ["Dropped"];
  filters.excludedGenres = ["Horror", "Western"];
  filters.excludedPlexStates = ["none"];
  filters.minRating = 3;
  filters.favoritesOnly = true;
  return {
    query: "genre:crime rating:>=4",
    filters,
    sort: { key: "rating", direction: "desc" },
    secondarySort: { key: "title", direction: "asc" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("sort vocabulary", () => {
  it("lists every SortKey from the contract", () => {
    expect([...SORT_KEYS]).toEqual([
      "title",
      "dateAdded",
      "dateModified",
      "rating",
      "progress",
      "releaseDate",
      "nextAirDate",
      "timeLeft",
      "year",
      "status",
      "priority",
    ]);
    expect([...SORT_DIRECTIONS]).toEqual(["asc", "desc"]);
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("createPreset", () => {
  it("slugs the name into a prefixed id", () => {
    expect(createPreset("Crime nights", makeView()).id).toBe("preset-crime-nights");
    expect(createPreset("4K & chill!", makeView()).id).toBe("preset-4k-chill");
  });

  it("suffixes a colliding id", () => {
    expect(presetId("Crime nights", ["preset-crime-nights"])).toBe("preset-crime-nights-2");
    expect(
      presetId("Crime nights", ["preset-crime-nights", "preset-crime-nights-2"]),
    ).toBe("preset-crime-nights-3");
  });

  it("falls back to a usable name and id when the name is blank", () => {
    const preset = createPreset("   ", makeView());
    expect(preset.name).toBe(UNTITLED_PRESET_NAME);
    expect(preset.id).toBe("preset-untitled");
  });

  it("keeps an id even for a name that slugs to nothing", () => {
    expect(createPreset("＊＊＊", makeView()).id).toBe("preset-view");
  });

  it("captures the whole view state", () => {
    const view = makeView();
    const preset = createPreset("Crime nights", view);
    expect(preset.query).toBe(view.query);
    expect(preset.filters).toEqual(view.filters);
    expect(preset.sort).toEqual(view.sort);
    expect(preset.secondarySort).toEqual(view.secondarySort);
  });

  it("captures a null secondary sort", () => {
    expect(createPreset("Plain", makeView({ secondarySort: null })).secondarySort).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("capture / apply isolation", () => {
  it("does not alias the live filter state on capture", () => {
    const view = makeView();
    const preset = createPreset("Crime nights", view);

    view.filters.excludedGenres.push("Musical");
    view.filters.minRating = 5;
    view.sort.direction = "asc";
    view.query = "changed";

    expect(preset.filters.excludedGenres).toEqual(["Horror", "Western"]);
    expect(preset.filters.minRating).toBe(3);
    expect(preset.sort).toEqual({ key: "rating", direction: "desc" });
    expect(preset.query).toBe("genre:crime rating:>=4");
  });

  it("does not alias the stored state on apply", () => {
    const preset = createPreset("Crime nights", makeView());
    const applied = applyPreset(preset);

    applied.filters.excludedGenres.push("Musical");
    applied.filters.favoritesOnly = false;
    applied.sort.key = "title";
    if (applied.secondarySort) applied.secondarySort.direction = "desc";

    expect(preset.filters.excludedGenres).toEqual(["Horror", "Western"]);
    expect(preset.filters.favoritesOnly).toBe(true);
    expect(preset.sort).toEqual({ key: "rating", direction: "desc" });
    expect(preset.secondarySort).toEqual({ key: "title", direction: "asc" });
  });

  it("hands out an independent copy on every apply", () => {
    const preset = createPreset("Crime nights", makeView());
    const first = applyPreset(preset);
    const second = applyPreset(preset);
    expect(first).not.toBe(second);
    expect(first.filters).not.toBe(second.filters);
    expect(first).toEqual(second);
  });

  it("round-trips the view exactly", () => {
    const view = makeView();
    const restored = applyPreset(createPreset("Crime nights", view));
    expect(restored).toEqual(view);
    expect(viewsEqual(restored, view)).toBe(true);
  });

  it("copies every array in the filter state", () => {
    const filters = createFilterState();
    const copy = cloneFilterState(filters);
    for (const key of Object.keys(filters) as (keyof typeof filters)[]) {
      const original = filters[key];
      if (Array.isArray(original)) expect(copy[key]).not.toBe(original);
    }
    expect(copy).toEqual(filters);
  });

  it("captureView is a deep snapshot", () => {
    const view = makeView();
    const snapshot = captureView(view);
    view.filters.excludedTags.push("late");
    expect(snapshot.filters.excludedTags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// List CRUD
// ---------------------------------------------------------------------------

describe("preset list CRUD", () => {
  it("appends and finds by id and name", () => {
    const list: Preset[] = [];
    const first = addPreset(list, "Crime nights", makeView());
    const second = addPreset(list, "Movies only", makeView({ query: "type:movie" }));

    expect(list).toHaveLength(2);
    expect(findPreset(list, first.id)).toBe(first);
    expect(findPreset(list, "nope")).toBeUndefined();
    expect(findPresetByName(list, "movies only")).toBe(second);
    expect(findPresetByName(list, "  MOVIES ONLY  ")).toBe(second);
    expect(findPresetByName(list, "nope")).toBeUndefined();
  });

  it("mutates the list in place instead of replacing it", () => {
    const list: Preset[] = [];
    const same = list;
    addPreset(list, "One", makeView());
    deletePreset(list, list[0]!.id);
    expect(list).toBe(same);
  });

  it("gives each preset a unique id, even with the same name", () => {
    const list: Preset[] = [];
    addPreset(list, "Crime nights", makeView());
    addPreset(list, "Crime nights", makeView());
    expect(list.map((preset) => preset.id)).toEqual([
      "preset-crime-nights",
      "preset-crime-nights-2",
    ]);
  });

  it("overwrites the captured state and keeps id and name", () => {
    const list: Preset[] = [];
    const preset = addPreset(list, "Crime nights", makeView());
    const next = makeView({ query: "type:movie", sort: { key: "year", direction: "asc" } });
    next.filters.excludedGenres = [];

    const updated = overwritePreset(list, preset.id, next);
    expect(updated).toBe(preset);
    expect(preset.id).toBe("preset-crime-nights");
    expect(preset.name).toBe("Crime nights");
    expect(preset.query).toBe("type:movie");
    expect(preset.sort).toEqual({ key: "year", direction: "asc" });
    expect(preset.filters.excludedGenres).toEqual([]);

    // Still isolated after an overwrite.
    next.filters.excludedGenres.push("Musical");
    expect(preset.filters.excludedGenres).toEqual([]);
  });

  it("returns undefined when overwriting or renaming an unknown id", () => {
    const list: Preset[] = [];
    expect(overwritePreset(list, "nope", makeView())).toBeUndefined();
    expect(renamePreset(list, "nope", "New")).toBeUndefined();
  });

  it("renames in place without touching the id", () => {
    const list: Preset[] = [];
    const preset = addPreset(list, "Crime nights", makeView());
    expect(renamePreset(list, preset.id, "  Crime evenings  ")?.name).toBe("Crime evenings");
    expect(preset.id).toBe("preset-crime-nights");
    expect(renamePreset(list, preset.id, "")?.name).toBe(UNTITLED_PRESET_NAME);
  });

  it("deletes by id and reports whether anything was removed", () => {
    const list: Preset[] = [];
    const preset = addPreset(list, "Crime nights", makeView());
    addPreset(list, "Movies only", makeView());
    expect(deletePreset(list, preset.id)).toBe(true);
    expect(list.map((entry) => entry.name)).toEqual(["Movies only"]);
    expect(deletePreset(list, preset.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

describe("comparison", () => {
  it("recognises the live view a preset stores", () => {
    const view = makeView();
    const preset = createPreset("Crime nights", view);
    expect(presetMatchesView(preset, view)).toBe(true);
    expect(presetMatchesView(preset, { ...view, query: `  ${view.query}  ` })).toBe(true);
  });

  it("notices any difference", () => {
    const view = makeView();
    const preset = createPreset("Crime nights", view);

    expect(presetMatchesView(preset, { ...view, query: "other" })).toBe(false);
    expect(
      presetMatchesView(preset, { ...view, sort: { key: "rating", direction: "asc" } }),
    ).toBe(false);
    expect(presetMatchesView(preset, { ...view, secondarySort: null })).toBe(false);

    const looser = captureView(view);
    looser.filters.minRating = 0;
    expect(presetMatchesView(preset, looser)).toBe(false);
  });

  it("compares exclusion lists as sets, not sequences", () => {
    const a = createFilterState();
    const b = createFilterState();
    a.excludedGenres = ["Horror", "Western"];
    b.excludedGenres = ["Western", "Horror"];
    expect(filterStatesEqual(a, b)).toBe(true);

    b.excludedGenres = ["Western"];
    expect(filterStatesEqual(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Load-time hardening
// ---------------------------------------------------------------------------

describe("sanitizePresets", () => {
  it("returns an empty list for anything that is not an array", () => {
    for (const value of [undefined, null, {}, "presets", 7]) {
      expect(sanitizePresets(value)).toEqual([]);
    }
  });

  it("drops entries that are not objects", () => {
    expect(sanitizePresets([null, "x", 3, []])).toHaveLength(1); // [] is an object
  });

  it("backfills everything a half-written entry is missing", () => {
    const [preset] = sanitizePresets([{ name: "Legacy" }]);
    expect(preset).toBeDefined();
    expect(preset?.id).toBe("preset-legacy");
    expect(preset?.query).toBe("");
    expect(preset?.filters).toEqual(createFilterState());
    expect(preset?.sort).toEqual({ key: "dateAdded", direction: "desc" });
    expect(preset?.secondarySort).toBeNull();
  });

  it("keeps valid state verbatim", () => {
    const view = makeView();
    const stored = createPreset("Crime nights", view);
    expect(sanitizePresets([JSON.parse(JSON.stringify(stored))])).toEqual([stored]);
  });

  it("re-issues duplicate ids", () => {
    const list = sanitizePresets([
      { id: "preset-a", name: "A" },
      { id: "preset-a", name: "A again" },
    ]);
    expect(list.map((preset) => preset.id)).toEqual(["preset-a", "preset-a-2"]);
  });

  it("rejects an unknown sort key and clamps minRating", () => {
    const [preset] = sanitizePresets([
      {
        name: "Broken",
        sort: { key: "name", direction: "sideways" },
        secondarySort: { key: "rating", direction: "asc" },
        filters: { minRating: 99, excludedGenres: ["Horror", 7], favoritesOnly: "yes" },
      },
    ]);
    expect(preset?.sort).toEqual({ key: "dateAdded", direction: "desc" });
    expect(preset?.secondarySort).toEqual({ key: "rating", direction: "asc" });
    expect(preset?.filters.minRating).toBe(5);
    expect(preset?.filters.excludedGenres).toEqual(["Horror"]);
    expect(preset?.filters.favoritesOnly).toBe(false);
  });

  it("defaults a valid key with a broken direction to descending", () => {
    const [preset] = sanitizePresets([{ name: "X", sort: { key: "title", direction: 3 } }]);
    expect(preset?.sort).toEqual({ key: "title", direction: "desc" });
  });

  it("survives a full round-trip through JSON", () => {
    const list: Preset[] = [];
    addPreset(list, "Crime nights", makeView());
    addPreset(list, "Movies only", makeView({ query: "type:movie", secondarySort: null }));
    expect(sanitizePresets(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });
});
