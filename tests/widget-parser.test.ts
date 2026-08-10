/**
 * The ```watchlog``` fence DSL (SPEC §4.9) and every legacy v3 grammar
 * (`docs/research/report-watchlog.md` §2.6).
 */
import { describe, expect, it } from "vitest";
import {
  STAT_DOMAINS,
  WIDGET_AIRING_VALUES,
  WIDGET_DIRECTIONS,
  WIDGET_KEYS,
  WIDGET_PLEX_VALUES,
  WIDGET_STATS,
  WIDGET_VIEWS,
  createWidgetSpec,
  defaultDirectionForKey,
  defaultLimitForView,
  defaultSortForView,
  parseLegacyBlock,
  parseLegacyWatchlog,
  parseWidgetSource,
  parseWlNowNext,
  parseWlNowWatching,
  parseWlStat,
  parseWlTodo,
  parseWlUpcoming,
  vocabulary,
  wlStatUnknownMessage,
} from "../src/widgets/parser";
import { SORT_KEYS } from "../src/data/presets";
import { WIDGET_DEFAULT_LIMIT_CARDS, WIDGET_DEFAULT_LIMIT_OTHER } from "../src/constants";
import { WIDGET_DOMAINS } from "../src/types";

function messages(source: string): string[] {
  return parseWidgetSource(source).issues.map((issue) => issue.message);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("parseWidgetSource — structure", () => {
  it("gives an empty block the full set of defaults", () => {
    const { spec, issues } = parseWidgetSource("");
    expect(issues).toEqual([]);
    expect(spec).toEqual(createWidgetSpec("cards"));
    expect(spec.view).toBe("cards");
    expect(spec.limit).toBe(WIDGET_DEFAULT_LIMIT_CARDS);
    expect(spec.sort).toBe("dateAdded");
    expect(spec.direction).toBe("desc");
    expect(spec.ids).toEqual([]);
    expect(spec.stat).toBeUndefined();
  });

  it("skips blank lines and # comments", () => {
    const { spec, issues } = parseWidgetSource(
      ["# a comment", "", "   ", "view: table", "  # indented comment"].join("\n"),
    );
    expect(issues).toEqual([]);
    expect(spec.view).toBe("table");
  });

  it("splits on the first colon so values may contain colons", () => {
    const { spec, issues } = parseWidgetSource("title: Dexter: New Blood");
    expect(issues).toEqual([]);
    expect(spec.titles).toEqual(["Dexter: New Blood"]);
  });

  it("trims keys and values and ignores key case", () => {
    const { spec, issues } = parseWidgetSource("  VIEW  :   table   ");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("table");
  });

  it("accepts CRLF line endings", () => {
    const { spec, issues } = parseWidgetSource("view: list\r\ntype: Movie\r\n");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("list");
    expect(spec.types).toEqual(["Movie"]);
  });

  it("accumulates repeatable keys across lines", () => {
    const { spec } = parseWidgetSource(
      ["genre: Crime", "genre: Drama", "tag: gore", "type: TV Show", "id: a", "id: b"].join("\n"),
    );
    expect(spec.genres).toEqual(["Crime", "Drama"]);
    expect(spec.tags).toEqual(["gore"]);
    expect(spec.types).toEqual(["TV Show"]);
    expect(spec.ids).toEqual(["a", "b"]);
  });

  it("folds key aliases onto the canonical key", () => {
    const { spec, issues } = parseWidgetSource(
      ["genres: Crime", "tags: gore", "titles: Arcane", "min-rating: 3", "dir: asc"].join("\n"),
    );
    expect(issues).toEqual([]);
    expect(spec.genres).toEqual(["Crime"]);
    expect(spec.tags).toEqual(["gore"]);
    expect(spec.titles).toEqual(["Arcane"]);
    expect(spec.minRating).toBe(3);
    expect(spec.direction).toBe("asc");
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("parseWidgetSource — errors", () => {
  it("rejects a line that is not a key: value pair", () => {
    expect(messages("cards")).toEqual([`"cards" is not a "key: value" pair.`]);
  });

  it("rejects an unknown key, quoting it", () => {
    expect(messages("vieww: cards")).toEqual([`Unknown key "vieww".`]);
    expect(messages("citty: Den Haag")).toEqual([`Unknown key "citty".`]);
  });

  it("rejects an empty value", () => {
    expect(messages("type:")).toEqual(["type: value is empty."]);
    expect(messages("type:    ")).toEqual(["type: value is empty."]);
  });

  it("reports the offending line number, key and value", () => {
    const { issues } = parseWidgetSource(["# comment", "view: cards", "limit: 0"].join("\n"));
    expect(issues).toEqual([
      {
        line: 3,
        key: "limit",
        value: "0",
        message: `limit: "0" — must be a positive whole number.`,
      },
    ]);
  });

  it("produces one specific message per invalid value", () => {
    const cases: [string, string][] = [
      ["view: grid", `view: "grid" — not a valid view. Use ${WIDGET_VIEWS.join(", ")}.`],
      ["plex: yes", `plex: "yes" — use ${WIDGET_PLEX_VALUES.join(", ")}.`],
      ["airing: soon", `airing: "soon" — use ${WIDGET_AIRING_VALUES.join(", ")}.`],
      ["requested: maybe", `requested: "maybe" — use true or false.`],
      ["favorite: 1", `favorite: "1" — use true or false.`],
      ["minRating: 9", `minRating: "9" — must be a number between 0 and 5.`],
      ["minRating: high", `minRating: "high" — must be a number between 0 and 5.`],
      ["year: 20x4", `year: "20x4" — must be a year (2024) or a range (2020-2025).`],
      ["year: 2020-", `year: "2020-" — must be a year (2024) or a range (2020-2025).`],
      ["limit: 0", `limit: "0" — must be a positive whole number.`],
      ["limit: -3", `limit: "-3" — must be a positive whole number.`],
      ["limit: 2.5", `limit: "2.5" — must be a positive whole number.`],
      ["sort: name", `sort: "name" — not a valid sort key. Use ${SORT_KEYS.join(", ")}.`],
      ["direction: up", `direction: "up" — use asc or desc.`],
      ["stat: top", `stat: "top" — not a valid stat. Use ${WIDGET_STATS.join(", ")}.`],
    ];
    for (const [source, message] of cases) {
      expect(messages(source), source).toEqual([message]);
    }
  });

  it("collects every issue instead of stopping at the first", () => {
    const { issues } = parseWidgetSource(["view: grid", "limit: 0", "nope: 1"].join("\n"));
    expect(issues.map((entry) => entry.line)).toEqual([1, 2, 3]);
  });

  it("still returns a usable spec when part of the block is broken", () => {
    const { spec, issues } = parseWidgetSource(["view: table", "limit: many", "genre: Crime"].join("\n"));
    expect(issues).toHaveLength(1);
    expect(spec.view).toBe("table");
    expect(spec.genres).toEqual(["Crime"]);
    expect(spec.limit).toBe(WIDGET_DEFAULT_LIMIT_OTHER);
  });

  it("accepts every legal value of every enumerated key", () => {
    for (const view of WIDGET_VIEWS) expect(messages(`view: ${view}`)).toEqual([]);
    // Each stat with a library that can answer it: a stat is domain-specific,
    // and pairing `pages-read` with the watchlist is now a reported mistake
    // rather than a silent zero (W8-integration).
    for (const stat of WIDGET_STATS) {
      const domain = STAT_DOMAINS[stat][0];
      expect(messages(`domain: ${domain}\nstat: ${stat}`)).toEqual([]);
    }
    for (const domain of WIDGET_DOMAINS) expect(messages(`domain: ${domain}`)).toEqual([]);
    for (const key of SORT_KEYS) expect(messages(`sort: ${key}`)).toEqual([]);
    for (const dir of WIDGET_DIRECTIONS) expect(messages(`direction: ${dir}`)).toEqual([]);
    for (const plex of WIDGET_PLEX_VALUES) expect(messages(`plex: ${plex}`)).toEqual([]);
    for (const airing of WIDGET_AIRING_VALUES) expect(messages(`airing: ${airing}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

describe("parseWidgetSource — values", () => {
  it("parses booleans, including yes/no", () => {
    expect(parseWidgetSource("requested: true").spec.requested).toBe(true);
    expect(parseWidgetSource("requested: FALSE").spec.requested).toBe(false);
    expect(parseWidgetSource("favorite: yes").spec.favorite).toBe(true);
    expect(parseWidgetSource("favorite: no").spec.favorite).toBe(false);
  });

  it("parses a bare year as a one-year range", () => {
    expect(parseWidgetSource("year: 2024").spec.year).toEqual({ from: 2024, to: 2024 });
  });

  it("parses a year range and normalises a reversed one", () => {
    expect(parseWidgetSource("year: 2020-2025").spec.year).toEqual({ from: 2020, to: 2025 });
    expect(parseWidgetSource("year: 2025 - 2020").spec.year).toEqual({ from: 2020, to: 2025 });
  });

  it("accepts a decimal comma in minRating", () => {
    expect(parseWidgetSource("minRating: 3,5").spec.minRating).toBe(3.5);
    expect(parseWidgetSource("minRating: 0").spec.minRating).toBe(0);
    expect(parseWidgetSource("minRating: 5").spec.minRating).toBe(5);
  });

  it("takes the last value for single-valued keys", () => {
    expect(parseWidgetSource("view: list\nview: table").spec.view).toBe("table");
    expect(parseWidgetSource("limit: 5\nlimit: 9").spec.limit).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Computed defaults
// ---------------------------------------------------------------------------

describe("parseWidgetSource — computed defaults", () => {
  it("derives the sort key from the view", () => {
    const expected: Record<string, string> = {
      cards: "dateAdded",
      list: "title",
      table: "title",
      shortlist: "title",
      stat: "dateAdded",
      random: "dateAdded",
      upcoming: "nextAirDate",
      now: "dateModified",
    };
    for (const view of WIDGET_VIEWS) {
      expect(parseWidgetSource(`view: ${view}`).spec.sort, view).toBe(expected[view]);
      expect(defaultSortForView(view)).toBe(expected[view]);
    }
  });

  it("derives the direction from the key", () => {
    expect(defaultDirectionForKey("title")).toBe("asc");
    expect(defaultDirectionForKey("status")).toBe("asc");
    expect(defaultDirectionForKey("priority")).toBe("asc");
    expect(defaultDirectionForKey("nextAirDate")).toBe("asc");
    expect(defaultDirectionForKey("dateAdded")).toBe("desc");
    expect(defaultDirectionForKey("rating")).toBe("desc");
  });

  it("derives the limit from the view", () => {
    expect(defaultLimitForView("cards")).toBe(WIDGET_DEFAULT_LIMIT_CARDS);
    for (const view of WIDGET_VIEWS.filter((candidate) => candidate !== "cards")) {
      expect(defaultLimitForView(view), view).toBe(WIDGET_DEFAULT_LIMIT_OTHER);
    }
    expect(parseWidgetSource("view: list").spec.limit).toBe(WIDGET_DEFAULT_LIMIT_OTHER);
    expect(parseWidgetSource("view: cards\nlimit: 3").spec.limit).toBe(3);
  });

  it("gives an explicit sort key its own default direction", () => {
    const { spec } = parseWidgetSource("view: cards\nsort: title");
    expect(spec.sort).toBe("title");
    expect(spec.direction).toBe("asc");
  });

  it("lets an explicit direction override the computed one", () => {
    const { spec } = parseWidgetSource("view: table\ndirection: desc");
    expect(spec.sort).toBe("title");
    expect(spec.direction).toBe("desc");
  });

  it("defaults `view: stat` to the time statistic, and keeps an explicit one", () => {
    expect(parseWidgetSource("view: stat").spec.stat).toBe("time");
    expect(parseWidgetSource("view: stat\nstat: by-status").spec.stat).toBe("by-status");
    expect(parseWidgetSource("view: cards\nstat: counts").spec.stat).toBe("counts");
    expect(parseWidgetSource("view: cards").spec.stat).toBeUndefined();
  });

  it("makes a shortlist a Plan-to-watch list unless a status is given", () => {
    expect(parseWidgetSource("view: shortlist").spec.statuses).toEqual(["Plan to watch"]);
    expect(parseWidgetSource("view: shortlist\nstatus: Watching").spec.statuses).toEqual([
      "Watching",
    ]);
  });

  it("renders a pinned block with no view as the tracker card (v3 compatibility)", () => {
    const { spec, issues } = parseWidgetSource("id: the-odyssey");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("now");
    expect(spec.ids).toEqual(["the-odyssey"]);

    expect(parseWidgetSource("title: Arcane").spec.view).toBe("now");
    expect(parseWidgetSource("view: cards\nid: the-odyssey").spec.view).toBe("cards");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe("vocabulary", () => {
  it("documents every key the parser accepts, and nothing else", () => {
    const vocab = vocabulary();
    expect(vocab.keys.map((entry) => entry.key)).toEqual([...WIDGET_KEYS]);
    for (const entry of vocab.keys) {
      expect(entry.values.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("lists every enumerated value the error panel has to print", () => {
    const vocab = vocabulary();
    expect(vocab.views).toEqual(WIDGET_VIEWS);
    expect(vocab.stats).toEqual(WIDGET_STATS);
    expect(vocab.sortKeys).toEqual(SORT_KEYS);
    expect(vocab.directions).toEqual(WIDGET_DIRECTIONS);
    expect(vocab.plex).toEqual(WIDGET_PLEX_VALUES);
    expect(vocab.airing).toEqual(WIDGET_AIRING_VALUES);
    expect(vocab.booleans).toEqual(["true", "false"]);
    expect(vocab.legacyFences).toEqual([
      "wl-todo",
      "wl-stat",
      "wl-upcoming",
      "wl-nowwatching",
      "wl-now-next",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Legacy grammars
// ---------------------------------------------------------------------------

describe("legacy — wl-todo", () => {
  it("reads the title line and renders the tracker card", () => {
    const result = parseWlTodo("Dexter: Resurrection");
    expect(result.issues).toEqual([]);
    expect(result.fence).toBe("wl-todo");
    expect(result.compact).toBe(false);
    expect(result.specs).toHaveLength(1);
    expect(result.spec.view).toBe("now");
    expect(result.spec.titles).toEqual(["Dexter: Resurrection"]);
    expect(result.spec.limit).toBe(1);
  });

  it("switches to the compact card on a `mini` line", () => {
    const result = parseWlTodo("Dexter: Resurrection\nmini");
    expect(result.issues).toEqual([]);
    expect(result.compact).toBe(true);
    expect(result.spec.titles).toEqual(["Dexter: Resurrection"]);
  });

  it("accepts `mini` before the title and ignores blank lines", () => {
    const result = parseWlTodo("\nMINI\n\nArcane\n");
    expect(result.compact).toBe(true);
    expect(result.spec.titles).toEqual(["Arcane"]);
  });

  it("reports a block with no title", () => {
    const result = parseWlTodo("mini");
    expect(result.spec.titles).toEqual([]);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      "wl-todo: the block needs a title on its own line.",
    ]);
  });
});

describe("legacy — wl-stat", () => {
  it("translates all seven exact bodies", () => {
    const cases: [string, string, boolean][] = [
      ["watched", "time", true],
      ["completed", "completed", true],
      ["remaining", "time", true],
      ["time", "time", true],
      ["time full", "time", false],
      ["completed full", "completed", false],
      ["time completed full", "counts", false],
    ];
    for (const [body, stat, compact] of cases) {
      const result = parseWlStat(body);
      expect(result.issues, body).toEqual([]);
      expect(result.spec.view, body).toBe("stat");
      expect(result.spec.stat, body).toBe(stat);
      expect(result.compact, body).toBe(compact);
      // The exact body survives translation, so `watched` and `remaining` stay
      // distinguishable even though both map to `stat: time`.
      expect(result.body, body).toBe(body);
    }
  });

  it("lower-cases and trims the body", () => {
    expect(parseWlStat("  Time Full  ").spec.stat).toBe("time");
    expect(parseWlStat("  Time Full  ").compact).toBe(false);
  });

  it("keeps v3's exact message for an unknown body", () => {
    const result = parseWlStat("nonsense");
    expect(result.issues.map((issue) => issue.message)).toEqual([
      `wl-stat: unknown stat "nonsense". Use watched, completed, remaining, time, time full, completed full, or time completed full.`,
    ]);
    expect(wlStatUnknownMessage("x")).toContain(`unknown stat "x"`);
    // Still renders something rather than nothing.
    expect(result.spec.stat).toBe("time");
  });
});

describe("legacy — wl-upcoming", () => {
  it("accepts `next` and `next full`", () => {
    for (const [body, compact] of [
      ["next", true],
      ["next full", false],
    ] as [string, boolean][]) {
      const result = parseWlUpcoming(body);
      expect(result.issues, body).toEqual([]);
      expect(result.spec.view).toBe("upcoming");
      expect(result.spec.limit).toBe(1);
      expect(result.compact).toBe(compact);
    }
  });

  it("rejects any other body", () => {
    const result = parseWlUpcoming("soon");
    expect(result.issues.map((issue) => issue.message)).toEqual([
      `wl-upcoming: body must be "next" or "next full".`,
    ]);
    expect(result.spec.view).toBe("upcoming");
  });
});

describe("legacy — wl-nowwatching", () => {
  it("accepts an empty body and `full`", () => {
    const empty = parseWlNowWatching("");
    expect(empty.issues).toEqual([]);
    expect(empty.spec.view).toBe("now");
    expect(empty.spec.limit).toBe(1);
    expect(empty.compact).toBe(true);

    const full = parseWlNowWatching("full");
    expect(full.issues).toEqual([]);
    expect(full.compact).toBe(false);
  });

  it("rejects any other body", () => {
    expect(parseWlNowWatching("mini").issues.map((issue) => issue.message)).toEqual([
      `wl-nowwatching: body must be empty or "full".`,
    ]);
  });
});

describe("legacy — wl-now-next", () => {
  it("translates into two panels", () => {
    const result = parseWlNowNext("");
    expect(result.issues).toEqual([]);
    expect(result.specs.map((spec) => spec.view)).toEqual(["now", "upcoming"]);
    expect(result.specs.every((spec) => spec.limit === 1)).toBe(true);
    expect(result.spec).toBe(result.specs[0]);
  });

  it("reports a body it does not take", () => {
    expect(parseWlNowNext("next").issues.map((issue) => issue.message)).toEqual([
      "wl-now-next: this block takes no body.",
    ]);
  });
});

describe("legacy — v3 watchlog body", () => {
  it("parses natively through the v4 parser", () => {
    const { spec, issues } = parseWidgetSource("id: the-odyssey");
    expect(issues).toEqual([]);
    expect(spec.view).toBe("now");
    expect(spec.ids).toEqual(["the-odyssey"]);
  });

  it("tolerates junk around the id line, exactly as v3 did", () => {
    const result = parseLegacyWatchlog("some junk\nid:   the-odyssey  \nmore junk");
    expect(result.issues).toEqual([]);
    expect(result.spec.view).toBe("now");
    expect(result.spec.ids).toEqual(["the-odyssey"]);
    expect(result.spec.limit).toBe(1);
  });

  it("reports a body with no id line", () => {
    expect(parseLegacyWatchlog("nothing here").issues.map((issue) => issue.message)).toEqual([
      "watch-read-learn: the block needs an `id:` line.",
    ]);
  });
});

describe("parseLegacyBlock", () => {
  it("dispatches every fence to its grammar", () => {
    expect(parseLegacyBlock("wl-todo", "Arcane").spec.titles).toEqual(["Arcane"]);
    expect(parseLegacyBlock("wl-stat", "watched").spec.stat).toBe("time");
    expect(parseLegacyBlock("wl-upcoming", "next").spec.view).toBe("upcoming");
    expect(parseLegacyBlock("wl-nowwatching", "full").spec.view).toBe("now");
    expect(parseLegacyBlock("wl-now-next", "").specs).toHaveLength(2);
  });

  it("returns a spec and an issues array for every fence, like the v4 parser", () => {
    for (const fence of vocabulary().legacyFences) {
      const result = parseLegacyBlock(fence, "");
      expect(result.spec, fence).toBeDefined();
      expect(Array.isArray(result.issues), fence).toBe(true);
      expect(result.specs.length, fence).toBeGreaterThan(0);
    }
  });
});
