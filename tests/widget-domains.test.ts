/**
 * `domain: reading | games` on a code block (SPEC2 §"Surfaces that grow").
 *
 * Two things matter here and they pull against each other: a block that names
 * another library has to actually read it, and every block written before parity
 * has to keep meaning exactly what it meant. The second is why `domain` defaults
 * to `watchlist` everywhere and why the legacy fences are checked below.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBook,
  createGame,
  createGamesSettings,
  createManga,
  createReadingSettings,
} from "../src/data/schema";
import { parseWidgetSource, parseLegacyBlock, STAT_DOMAINS } from "../src/widgets/parser";
import {
  domainStat,
  gameRow,
  readingRow,
  renderDomainBlock,
  selectGames,
  selectReading,
} from "../src/widgets/domains";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { GamesData, ReadingData } from "../src/types";

const NOW = new Date(2026, 7, 3);

let restore: () => void;
beforeEach(() => {
  restore = installDomGlobals(900);
});
afterEach(() => {
  restore();
});

function reading(): ReadingData {
  return {
    books: [
      createBook({
        id: "dune",
        title: "Dune",
        author: "Frank Herbert",
        status: "Completed",
        pagesRead: 528,
        totalPages: 528,
        rating: 5,
      }),
      createBook({
        id: "wip",
        title: "Half Read",
        author: "Frank Herbert",
        status: "Reading",
        pagesRead: 100,
        totalPages: 400,
      }),
    ],
    manga: [
      createManga({
        id: "berserk",
        title: "Berserk",
        author: "Kentaro Miura",
        status: "Reading",
        chaptersRead: 300,
        totalChapters: 374,
        favorite: true,
      }),
    ],
    bookColumns: [],
    mangaColumns: [],
    settings: createReadingSettings(),
  };
}

function games(): GamesData {
  return {
    games: [
      createGame({
        id: "hades",
        title: "Hades",
        developer: "Supergiant",
        status: "Finished",
        playtimeMinutes: 4210,
        achievementsEarned: 49,
        achievementsTotal: 49,
        platforms: ["Windows PC"],
      }),
      createGame({
        id: "next",
        title: "Next Up",
        status: "Playing",
        playtimeMinutes: 120,
        platforms: ["Nintendo Switch 2"],
      }),
    ],
    groups: [],
    settings: createGamesSettings(),
  };
}

const specOf = (source: string) => parseWidgetSource(source).spec;

// ---------------------------------------------------------------------------

describe("the domain key", () => {
  it("defaults to the watchlist, so every old block is unchanged", () => {
    expect(specOf("view: cards").domain).toBe("watchlist");
    expect(specOf("view: stat\nstat: time").domain).toBe("watchlist");
  });

  it("accepts either spelling", () => {
    expect(specOf("domain: reading").domain).toBe("reading");
    expect(specOf("library: games").domain).toBe("games");
  });

  it("rejects a library that does not exist, and says which do", () => {
    const { issues } = parseWidgetSource("domain: comics");
    expect(issues[0]?.message).toContain("watchlist, reading, games");
  });

  it("never reaches a legacy fence", () => {
    // v3 blocks predate the idea of another library; they must stay watchlist.
    for (const fence of ["wl-todo", "wl-stat", "wl-upcoming", "wl-nowwatching"] as const) {
      expect(parseLegacyBlock(fence, "").spec.domain).toBe("watchlist");
    }
  });
});

describe("stat and library have to agree", () => {
  it("reports a stat its library cannot answer", () => {
    const { issues } = parseWidgetSource("domain: games\nview: stat\nstat: pages-read");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("not a games statistic");
    // Silence would have rendered a 0, which looks like an answer.
    expect(issues[0]?.message).toContain("reading");
  });

  it("gives each library its own headline stat by default", () => {
    expect(specOf("view: stat").stat).toBe("time");
    expect(specOf("domain: reading\nview: stat").stat).toBe("pages-read");
    expect(specOf("domain: games\nview: stat").stat).toBe("time-played");
  });

  it("agrees with the table it publishes", () => {
    for (const [stat, domains] of Object.entries(STAT_DOMAINS)) {
      for (const domain of domains) {
        const { issues } = parseWidgetSource(`domain: ${domain}\nview: stat\nstat: ${stat}`);
        expect(issues, `${stat} on ${domain}`).toEqual([]);
      }
    }
  });
});

describe("selecting rows from a parity library", () => {
  it("filters reading by status and honours the limit", () => {
    const rows = selectReading(reading(), specOf("domain: reading\nstatus: Reading\nlimit: 1"), {
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(["Half Read", "Berserk"]).toContain(rows[0]?.title);
  });

  it("filters reading by author through the lane's own engine", () => {
    const rows = selectReading(reading(), specOf('domain: reading\nauthor: "Frank Herbert"'), {
      now: NOW,
    });
    expect(rows.map((r) => r.title).sort()).toEqual(["Dune", "Half Read"]);
  });

  it("narrows to one shelf when asked", () => {
    const spec = specOf("domain: reading");
    spec.readingKind = "manga";
    expect(selectReading(reading(), spec, { now: NOW }).map((r) => r.title)).toEqual(["Berserk"]);
  });

  it("filters games by platform and status", () => {
    expect(
      selectGames(games(), specOf('domain: games\nplatform: "Windows PC"')).map((g) => g.title),
    ).toEqual(["Hades"]);
    expect(selectGames(games(), specOf("domain: games\nstatus: Playing")).map((g) => g.title)).toEqual([
      "Next Up",
    ]);
  });

  it("passes unrated entries through a minimum rating, as the watchlist does", () => {
    const rows = selectReading(reading(), specOf("domain: reading\nminRating: 4"), { now: NOW });
    // Dune is 5★; the unrated two are not excluded for being unrated.
    expect(rows.map((r) => r.title)).toContain("Dune");
    expect(rows.map((r) => r.title)).toContain("Berserk");
  });
});

describe("a row carries the number its library is judged by", () => {
  it("shows pages for a book and chapters for a manga", () => {
    const data = reading();
    expect(readingRow(data.books[0]!, NOW).metric).toBe("528 of 528 pages");
    expect(readingRow(data.manga[0]!, NOW).metric).toBe("300 of 374 chapters");
  });

  it("shows words when that is the unit the book counts in", () => {
    const book = createBook({
      id: "w",
      title: "W",
      progressUnit: "words",
      wordsRead: 12500,
      totalWords: 90000,
    });
    expect(readingRow(book, NOW).metric).toContain("words");
  });

  it("shows playtime and achievements for a game", () => {
    const row = gameRow(games().games[0]!);
    expect(row.metric).toContain("70 h");
    expect(row.metric).toContain("49");
  });
});

describe("statistics per library", () => {
  it("computes each parity stat from its own library", () => {
    const r = reading();
    const g = games();
    expect(domainStat("pages-read", r, g, NOW).value).toBe("628");
    expect(domainStat("reading-completed", r, g, NOW).value).toBe("1");
    expect(domainStat("time-played", r, g, NOW).value).toBe("72 h");
    expect(domainStat("games-completed", r, g, NOW).value).toBe("1");
  });

  it("never emits NaN for an empty library", () => {
    const empty: ReadingData = {
      books: [],
      manga: [],
      bookColumns: [],
      mangaColumns: [],
      settings: createReadingSettings(),
    };
    const noGames: GamesData = { games: [], groups: [], settings: createGamesSettings() };
    for (const stat of ["pages-read", "reading-completed", "time-played", "games-completed"] as const) {
      const value = domainStat(stat, empty, noGames, NOW);
      expect(value.value).not.toContain("NaN");
      expect(value.detail ?? "").not.toContain("NaN");
    }
  });
});

describe("rendering a domain block", () => {
  const render = (source: string): StubEl => {
    const host = createHost(900);
    renderDomainBlock(
      host as unknown as HTMLElement,
      specOf(source),
      reading(),
      games(),
      {},
      NOW,
    );
    return host;
  };

  it("draws a row per entry", () => {
    const el = render("domain: reading\nview: list");
    expect(el.querySelectorAll(".wl-widget-domain-row")).toHaveLength(3);
    expect(el.textContent).toContain("Dune");
    expect(el.textContent).toContain("Berserk");
  });

  it("draws the library's own statistic", () => {
    const el = render("domain: games\nview: stat\nstat: time-played");
    expect(el.textContent).toContain("72 h");
    expect(el.textContent).toContain("Time played");
  });

  it("says what to use instead of a watchlist-only view", () => {
    // `now` means "the episode I am part-way through" — books have progress but
    // no next episode, so an empty box would be a lie by omission.
    const el = render("domain: reading\nview: now");
    expect(el.textContent).toContain("only makes sense for the watchlist");
    expect(el.textContent).toContain("view: list");
  });

  it("says so when nothing matches, rather than drawing an empty list", () => {
    const el = render("domain: games\nstatus: Dropped");
    expect(el.textContent).toContain("No games match");
    expect(el.querySelectorAll(".wl-widget-domain-row")).toHaveLength(0);
  });

  it("emits no NaN for any view over either library", () => {
    for (const source of [
      "domain: reading\nview: cards",
      "domain: reading\nview: table",
      "domain: games\nview: list",
      "domain: games\nview: stat",
    ]) {
      const el = render(source);
      expect(el.textContent).not.toContain("NaN");
      expect(el.textContent).not.toContain("undefined");
    }
  });
});
