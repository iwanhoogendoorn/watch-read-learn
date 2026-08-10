/**
 * Widget DSL and selection — SPEC §4.9.
 *
 * `defaultWidgetParse` is the interim parser this lane renders against until
 * `widgets/parser.ts` merges; the selection, sorting and legacy-translation
 * tests below hold whichever parser is wired in, because they consume a
 * `WidgetSpec` rather than a source string.
 */
import { describe, expect, it } from "vitest";
import {
  WIDGET_DEFAULT_LIMIT_CARDS,
  WIDGET_DEFAULT_LIMIT_OTHER,
} from "../src/constants";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import {
  airingStateOf,
  defaultWidgetParse,
  emptySpec,
  isRequested,
  matchesSpec,
  selectTitles,
  sortForWidget,
  WIDGET_KEYS,
} from "../src/widgets/render";
import {
  LEGACY_STAT_VOCABULARY,
  LEGACY_TRANSLATORS,
  translateWlNowNext,
  translateWlNowWatching,
  translateWlStat,
  translateWlTodo,
  translateWlUpcoming,
} from "../src/widgets/legacy";
import type { Settings, TitleV4, WidgetSpec } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

function title(overrides: Partial<TitleV4> & { id: string }): TitleV4 {
  return createTitle({
    title: overrides.id,
    type: "TV Show",
    status: "Watching",
    totalEpisodes: 10,
    episodeDuration: 30,
    ...overrides,
  });
}

function settings(): Settings {
  return createDefaultSettings();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("defaultWidgetParse", () => {
  it("defaults to a cards view with computed limit, sort and direction", () => {
    const { spec, issues } = defaultWidgetParse("");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("cards");
    expect(spec.limit).toBe(WIDGET_DEFAULT_LIMIT_CARDS);
    expect(spec.sort).toBe("dateAdded");
    expect(spec.direction).toBe("desc");
  });

  it("computes different defaults per view", () => {
    expect(defaultWidgetParse("view: table").spec.limit).toBe(WIDGET_DEFAULT_LIMIT_OTHER);
    expect(defaultWidgetParse("view: table").spec.sort).toBe("title");
    expect(defaultWidgetParse("view: table").spec.direction).toBe("asc");
    expect(defaultWidgetParse("view: upcoming").spec.sort).toBe("nextAirDate");
  });

  it("implies the planning status for a shortlist, but not over an explicit one", () => {
    expect(defaultWidgetParse("view: shortlist").spec.statuses).toEqual(["Plan to watch"]);
    expect(defaultWidgetParse("view: shortlist\nstatus: Watching").spec.statuses).toEqual([
      "Watching",
    ]);
  });

  it("skips blank lines and # comments", () => {
    const { spec, issues } = defaultWidgetParse("# what I am watching\n\nview: list\n");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("list");
  });

  it("splits on the first colon only, so titles with colons survive", () => {
    expect(defaultWidgetParse("title: Dexter: Resurrection").spec.titles).toEqual([
      "Dexter: Resurrection",
    ]);
  });

  it("accumulates repeated and comma-separated keys as any-of", () => {
    const { spec } = defaultWidgetParse("genre: Sci-Fi, Thriller\ngenre: Drama");
    expect(spec.genres).toEqual(["Sci-Fi", "Thriller", "Drama"]);
  });

  it("parses a year range in either order", () => {
    expect(defaultWidgetParse("year: 2024").spec.year).toEqual({ from: 2024, to: 2024 });
    expect(defaultWidgetParse("year: 2020-2025").spec.year).toEqual({ from: 2020, to: 2025 });
    expect(defaultWidgetParse("year: 2025-2020").spec.year).toEqual({ from: 2020, to: 2025 });
  });

  it("reports unknown keys, bad values and non-pairs with the offending input", () => {
    const { issues } = defaultWidgetParse("citty: Delft\nlimit: 0\nview: grid\ncards");
    expect(issues).toHaveLength(4);
    expect(issues[0]?.message).toContain('Unknown key "citty"');
    expect(issues[1]?.message).toContain('limit: "0"');
    expect(issues[2]?.message).toContain('view: "grid"');
    expect(issues[3]?.message).toContain('"cards" is not a "key: value" pair');
    expect(issues[0]?.line).toBe(1);
    expect(issues[3]?.line).toBe(4);
  });

  it("still returns a usable spec when some lines are broken", () => {
    const { spec, issues } = defaultWidgetParse("view: list\nplex: maybe");
    expect(issues).toHaveLength(1);
    expect(spec.view).toBe("list");
    expect(spec.plex).toBeUndefined();
  });

  it("documents every key it accepts, for the error panel", () => {
    const documented = new Set(WIDGET_KEYS.map((k) => k.key));
    for (const key of ["view", "id", "plex", "requested", "airing", "stat", "minRating"]) {
      expect(documented.has(key)).toBe(true);
    }
    // A key in the vocabulary must actually parse.
    for (const entry of WIDGET_KEYS) {
      const { issues } = defaultWidgetParse(`${entry.key}: x`);
      expect(issues.some((i) => i.message.includes("Unknown key"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("matchesSpec", () => {
  function spec(overrides: Partial<WidgetSpec> = {}): WidgetSpec {
    return { ...emptySpec(), ...overrides };
  }

  it("matches ids and titles case-insensitively, ids first", () => {
    const t = title({ id: "dexter", title: "Dexter: Resurrection" });
    expect(matchesSpec(t, spec({ ids: ["dexter"] }), NOW)).toBe(true);
    expect(matchesSpec(t, spec({ titles: ["dexter: resurrection"] }), NOW)).toBe(true);
    expect(matchesSpec(t, spec({ ids: ["other"] }), NOW)).toBe(false);
  });

  it("treats multi-value fields as any-of", () => {
    const t = title({ id: "a", genres: ["Drama", "Sci-Fi"], tags: ["rewatch"] });
    expect(matchesSpec(t, spec({ genres: ["sci-fi"] }), NOW)).toBe(true);
    expect(matchesSpec(t, spec({ genres: ["Comedy"] }), NOW)).toBe(false);
    expect(matchesSpec(t, spec({ tags: ["Rewatch"] }), NOW)).toBe(true);
  });

  it("lets unrated titles through minRating, as the UI promises", () => {
    expect(matchesSpec(title({ id: "a", rating: 0 }), spec({ minRating: 4 }), NOW)).toBe(true);
    expect(matchesSpec(title({ id: "b", rating: 3 }), spec({ minRating: 4 }), NOW)).toBe(false);
    expect(matchesSpec(title({ id: "c", rating: 4 }), spec({ minRating: 4 }), NOW)).toBe(true);
  });

  it("counts never-checked titles as missing from Plex", () => {
    expect(matchesSpec(title({ id: "a" }), spec({ plex: "missing" }), NOW)).toBe(true);
    expect(
      matchesSpec(title({ id: "b", plex: { state: "unknown" } }), spec({ plex: "missing" }), NOW),
    ).toBe(true);
    expect(
      matchesSpec(title({ id: "c", plex: { state: "available" } }), spec({ plex: "missing" }), NOW),
    ).toBe(false);
    expect(
      matchesSpec(title({ id: "d", plex: { state: "partial" } }), spec({ plex: "partial" }), NOW),
    ).toBe(true);
  });

  it("knows a title is requested from either the request id or the media status", () => {
    expect(isRequested(title({ id: "a" }))).toBe(false);
    expect(isRequested(title({ id: "b", request: { id: 4 } }))).toBe(true);
    expect(isRequested(title({ id: "c", request: { mediaStatus: 3 } }))).toBe(true);
    expect(matchesSpec(title({ id: "d" }), spec({ requested: false }), NOW)).toBe(true);
  });

  it("derives the airing state from status, next episode and release date", () => {
    expect(airingStateOf(title({ id: "a", airing: { showStatus: "Ended" } }), NOW)).toBe("ended");
    expect(airingStateOf(title({ id: "b", airing: { showStatus: "Canceled" } }), NOW)).toBe("ended");
    expect(
      airingStateOf(
        title({ id: "c", airing: { nextEpisode: { season: 1, episode: 2, airDate: "2026-08-09" } } }),
        NOW,
      ),
    ).toBe("returning");
    expect(airingStateOf(title({ id: "d", releaseDate: "2026-12-01" }), NOW)).toBe("upcoming");
    expect(airingStateOf(title({ id: "e" }), NOW)).toBeNull();
  });

  it("filters by year range, excluding titles with no known year", () => {
    expect(matchesSpec(title({ id: "a", year: 2022 }), spec({ year: { from: 2020, to: 2025 } }), NOW)).toBe(true);
    expect(matchesSpec(title({ id: "b", year: 2019 }), spec({ year: { from: 2020, to: 2025 } }), NOW)).toBe(false);
    expect(matchesSpec(title({ id: "c" }), spec({ year: { from: 2020, to: 2025 } }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sorting and selection
// ---------------------------------------------------------------------------

describe("sortForWidget", () => {
  it("sorts empty values last whichever direction is asked for", () => {
    const titles = [
      title({ id: "unrated", rating: 0 }),
      title({ id: "high", rating: 5 }),
      title({ id: "low", rating: 2 }),
    ];
    expect(sortForWidget(titles, "rating", "desc", settings()).map((t) => t.id)).toEqual([
      "high",
      "low",
      "unrated",
    ]);
    expect(sortForWidget(titles, "rating", "asc", settings()).map((t) => t.id)).toEqual([
      "low",
      "high",
      "unrated",
    ]);
  });

  it("orders status by the user's configured list, not the alphabet", () => {
    const custom = settings();
    custom.statuses = [
      { name: "Watching", color: "#000000" },
      { name: "Completed", color: "#000000" },
      { name: "Plan to watch", color: "#000000" },
    ];
    const titles = [
      title({ id: "plan", status: "Plan to watch" }),
      title({ id: "done", status: "Completed" }),
      title({ id: "now", status: "Watching" }),
    ];
    expect(sortForWidget(titles, "status", "asc", custom).map((t) => t.id)).toEqual([
      "now",
      "done",
      "plan",
    ]);
  });

  it("sorts titles alphabetically and breaks every tie by name", () => {
    const titles = [
      title({ id: "b", title: "Banshee" }),
      title({ id: "a", title: "Andor" }),
      title({ id: "c", title: "Chernobyl" }),
    ];
    expect(sortForWidget(titles, "title", "asc", settings()).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("selectTitles", () => {
  const titles = [
    title({ id: "a", status: "Watching", rating: 5 }),
    title({ id: "b", status: "Completed", rating: 4 }),
    title({ id: "c", status: "Watching", rating: 3 }),
  ];

  it("filters, sorts and caps in that order", () => {
    const { spec } = defaultWidgetParse("view: list\nstatus: Watching\nsort: rating\ndirection: desc\nlimit: 1");
    expect(selectTitles(titles, spec, { settings: settings(), now: NOW }).map((t) => t.id)).toEqual([
      "a",
    ]);
  });

  it("ignores the limit when the caller asks for everything", () => {
    const { spec } = defaultWidgetParse("limit: 1");
    expect(
      selectTitles(titles, spec, { settings: settings(), now: NOW, unlimited: true }),
    ).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Legacy fences
// ---------------------------------------------------------------------------

describe("legacy translators", () => {
  it("covers all five v3 fences", () => {
    expect(Object.keys(LEGACY_TRANSLATORS).sort()).toEqual([
      "wl-now-next",
      "wl-nowwatching",
      "wl-stat",
      "wl-todo",
      "wl-upcoming",
    ]);
  });

  it("wl-todo resolves by title name and honours the mini line", () => {
    const plan = translateWlTodo("Dexter: Resurrection");
    expect(plan.issues).toEqual([]);
    expect(plan.spec.view).toBe("now");
    expect(plan.spec.titles).toEqual(["Dexter: Resurrection"]);
    expect(plan.options?.variant).toBe("full");

    const mini = translateWlTodo("Dexter: Resurrection\nmini");
    expect(mini.spec.titles).toEqual(["Dexter: Resurrection"]);
    expect(mini.options?.variant).toBe("mini");
  });

  it("wl-todo without a name is an error, not a silent empty block", () => {
    const plan = translateWlTodo("mini");
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]?.message).toContain("title name");
  });

  it("wl-stat accepts exactly the seven v3 bodies", () => {
    expect(LEGACY_STAT_VOCABULARY).toHaveLength(7);
    for (const body of LEGACY_STAT_VOCABULARY) {
      const plan = translateWlStat(body);
      expect(plan.issues).toEqual([]);
      expect(plan.spec.view).toBe("stat");
    }
    expect(translateWlStat("completed full").spec.stat).toBe("completed");
    expect(translateWlStat("time completed full").options?.extraStats).toEqual(["completed"]);
  });

  it("wl-stat rejects anything else and prints the vocabulary", () => {
    const plan = translateWlStat("bananas");
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]?.message).toContain('unknown stat "bananas"');
    expect(plan.issues[0]?.message).toContain("time completed full");
  });

  it("wl-upcoming maps to the upcoming view for both accepted bodies", () => {
    for (const body of ["next", "next full"]) {
      const plan = translateWlUpcoming(body);
      expect(plan.issues).toEqual([]);
      expect(plan.spec.view).toBe("upcoming");
      expect(plan.spec.limit).toBe(1);
    }
    expect(translateWlUpcoming("soon").issues).toHaveLength(1);
  });

  it("wl-nowwatching accepts an empty body or full", () => {
    expect(translateWlNowWatching("").issues).toEqual([]);
    expect(translateWlNowWatching("full").options?.variant).toBe("full");
    expect(translateWlNowWatching("everything").issues).toHaveLength(1);
  });

  it("wl-now-next takes no body and asks for two columns", () => {
    const plan = translateWlNowNext("");
    expect(plan.issues).toEqual([]);
    expect(plan.options?.twoColumn).toBe(true);
    expect(translateWlNowNext("please").issues).toHaveLength(1);
  });

  it("names the offending fence in every error heading", () => {
    for (const [lang, translate] of Object.entries(LEGACY_TRANSLATORS)) {
      expect(translate("definitely not valid").options?.errorHeading).toContain(lang);
    }
  });

  it("keeps v3 watchlog id: blocks working through the modern parser", () => {
    const { spec, issues } = defaultWidgetParse("id: the-odyssey");
    expect(issues).toEqual([]);
    expect(spec.ids).toEqual(["the-odyssey"]);
  });
});
