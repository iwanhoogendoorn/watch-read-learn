/**
 * The search token language (SPEC §4.5): every operator, every field, every
 * degradation path. Pure logic — no DOM, no network.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import {
  AIRING_SOON_DAYS,
  ENUM_FIELDS,
  NUMERIC_FIELDS,
  SEARCH_VOCABULARY,
  SearchEngine,
  TEXT_FIELDS,
  norm,
  parseQuery,
  searchTitles,
} from "../src/search/query";
import type { TitleV4 } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-03T12:00:00");

const dexter = createTitle({
  id: "dexter-new-blood",
  title: "Dexter: New Blood",
  type: "TV Show",
  status: "Watching",
  priority: "High",
  rating: 4,
  year: 2021,
  releaseDate: "2021-11-07",
  genres: ["Crime", "Drama"],
  tags: ["gore"],
  cast: ["Michael C. Hall"],
  director: ["Marcos Siega"],
  studio: ["Showtime"],
  totalEpisodes: 10,
  episodeDuration: 50,
  watchedEpisodes: [1, 2, 3, 4, 5, 6, 7, 8],
  communityRating: 7.4,
  seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] }],
});

const breakingBad = createTitle({
  id: "breaking-bad",
  title: "Breaking Bad",
  type: "TV Show",
  status: "Watched",
  rating: 5,
  year: 2008,
  genres: ["Crime", "Thriller"],
  cast: ["Bryan Cranston", "Aaron Paul"],
  director: ["Vince Gilligan"],
  studio: ["AMC"],
  manualCast: ["Giancarlo Esposito"],
  notes: "Best show ever. foo:bar",
  totalEpisodes: 62,
  episodeDuration: 47,
  watchedEpisodes: Array.from({ length: 62 }, (_, i) => i + 1),
  communityRating: 9.5,
  seasons: [{ name: "Season 1", episodes: 62, offset: 0, skippedEpisodes: [] }],
});

const amelie = createTitle({
  id: "amelie",
  title: "Amélie",
  type: "Movie",
  status: "Watched",
  rating: 5,
  year: 2001,
  genres: ["Romance", "Comédie"],
  cast: ["Audrey Tautou"],
  notes: "The café scene",
  favorite: true,
  totalEpisodes: 1,
  episodeDuration: 122,
  watchedEpisodes: [1],
  plex: { state: "available", ratingKey: "12" },
});

const arcane = createTitle({
  id: "arcane",
  title: "Arcane",
  type: "Animation",
  status: "Plan to watch",
  rating: 0,
  year: 2021,
  genres: ["Animation", "Fantasy"],
  tags: ["league"],
  totalEpisodes: 18,
  episodeDuration: 40,
  watchedEpisodes: [],
  plex: { state: "partial", leafCount: 9 },
  request: { id: 4, status: 2, requestedAt: "2026-07-30T10:00:00.000Z" },
  airing: {
    showStatus: "Returning Series",
    inProduction: true,
    nextEpisode: { season: 2, episode: 1, airDate: "2026-08-10" },
  },
});

const severance = createTitle({
  id: "severance",
  title: "Severance",
  type: "TV Show",
  status: "Watching",
  rating: 3,
  year: 2022,
  genres: ["Sci-Fi"],
  totalEpisodes: 18,
  episodeDuration: 45,
  watchedEpisodes: [1, 2, 3],
  communityRating: 8.7,
  plex: { state: "none" },
  airing: { showStatus: "Ended", inProduction: false },
});

const POOL: TitleV4[] = [dexter, breakingBad, amelie, arcane, severance];

function ids(titles: readonly TitleV4[]): string[] {
  return titles.map((title) => title.id).sort();
}

function run(query: string, pool: readonly TitleV4[] = POOL): string[] {
  return ids(searchTitles(pool, query, { now: NOW }));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe("parseQuery — structure", () => {
  it("treats an empty or whitespace query as no constraint", () => {
    for (const raw of ["", "   ", "\n\t"]) {
      const parsed = parseQuery(raw);
      expect(parsed.isEmpty).toBe(true);
      expect(parsed.groups).toEqual([]);
      expect(parsed.raw).toBe(raw);
    }
  });

  it("puts bare terms in one conjunctive group", () => {
    const parsed = parseQuery("dexter blood");
    expect(parsed.isEmpty).toBe(false);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]).toEqual([
      { kind: "fuzzy", value: "dexter", negated: false },
      { kind: "fuzzy", value: "blood", negated: false },
    ]);
  });

  it("splits groups on a bare pipe", () => {
    const parsed = parseQuery("dexter | arcane");
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]?.[0]).toMatchObject({ value: "dexter" });
    expect(parsed.groups[1]?.[0]).toMatchObject({ value: "arcane" });
  });

  it("drops empty groups from leading, trailing and doubled separators", () => {
    expect(parseQuery("| dexter |").groups).toHaveLength(1);
    expect(parseQuery("dexter || arcane").groups).toHaveLength(2);
    expect(parseQuery("|").isEmpty).toBe(true);
  });

  it("reads a quoted phrase as an exact term", () => {
    expect(parseQuery('"new blood"').groups[0]?.[0]).toEqual({
      kind: "exact",
      value: "new blood",
      negated: false,
    });
  });

  it("ignores an empty quoted phrase", () => {
    expect(parseQuery('""').isEmpty).toBe(true);
  });

  it("forces exact matching for negated terms", () => {
    expect(parseQuery("-dexter").groups[0]?.[0]).toEqual({
      kind: "exact",
      value: "dexter",
      negated: true,
    });
    expect(parseQuery('-"new blood"').groups[0]?.[0]).toEqual({
      kind: "exact",
      value: "new blood",
      negated: true,
    });
  });
});

describe("parseQuery — field scopes", () => {
  it("parses every documented text field", () => {
    for (const field of TEXT_FIELDS) {
      expect(parseQuery(`${field}:x`).groups[0]?.[0]).toEqual({
        kind: "field",
        field,
        value: "x",
        negated: false,
      });
    }
  });

  it("folds plural and synonym spellings onto the canonical field", () => {
    const cases: [string, string][] = [
      ["genres:crime", "genre"],
      ["tags:gore", "tag"],
      ["notes:café", "note"],
      ["actor:paul", "cast"],
      ["directors:gilligan", "director"],
      ["network:amc", "studio"],
      ["name:arcane", "title"],
    ];
    for (const [raw, field] of cases) {
      expect(parseQuery(raw).groups[0]?.[0]).toMatchObject({ kind: "field", field });
    }
  });

  it("is case-insensitive about field names", () => {
    expect(parseQuery("CAST:cranston").groups[0]?.[0]).toMatchObject({
      kind: "field",
      field: "cast",
    });
  });

  it("keeps a quoted field value together", () => {
    expect(parseQuery('cast:"bryan cranston"').groups[0]?.[0]).toEqual({
      kind: "field",
      field: "cast",
      value: "bryan cranston",
      negated: false,
    });
  });

  it("negates a field term", () => {
    expect(parseQuery("-genre:crime").groups[0]?.[0]).toEqual({
      kind: "field",
      field: "genre",
      value: "crime",
      negated: true,
    });
  });
});

describe("parseQuery — numeric comparators", () => {
  it("parses every operator, defaulting a bare number to equality", () => {
    const cases: [string, string, number][] = [
      ["rating:>4", ">", 4],
      ["rating:>=4", ">=", 4],
      ["rating:<4", "<", 4],
      ["rating:<=4", "<=", 4],
      ["rating:=4", "=", 4],
      ["rating:4", "=", 4],
    ];
    for (const [raw, op, value] of cases) {
      expect(parseQuery(raw).groups[0]?.[0]).toEqual({
        kind: "numeric",
        field: "rating",
        op,
        value,
        negated: false,
      });
    }
  });

  it("covers every documented numeric field", () => {
    for (const field of NUMERIC_FIELDS) {
      expect(parseQuery(`${field}:>=1`).groups[0]?.[0]).toMatchObject({ kind: "numeric", field });
    }
  });

  it("accepts decimal commas", () => {
    expect(parseQuery("rating:>=4,5").groups[0]?.[0]).toMatchObject({ value: 4.5 });
    expect(parseQuery("community:>8.7").groups[0]?.[0]).toMatchObject({ value: 8.7 });
  });

  it("accepts the hyphenated and collapsed spellings of eps-left", () => {
    for (const raw of ["eps-left:<5", "epsleft:<5", "episodes-left:<5"]) {
      expect(parseQuery(raw).groups[0]?.[0]).toMatchObject({ kind: "numeric", field: "eps-left" });
    }
  });

  it("degrades an unparseable comparison to literal text", () => {
    expect(parseQuery("rating:soon").groups[0]?.[0]).toEqual({
      kind: "fuzzy",
      value: "rating:soon",
      negated: false,
    });
  });
});

describe("parseQuery — enumerated fields", () => {
  it("covers every documented enum field and value", () => {
    for (const field of ENUM_FIELDS) {
      for (const value of SEARCH_VOCABULARY.enumValues[field]) {
        expect(parseQuery(`${field}:${value}`).groups[0]?.[0]).toEqual({
          kind: "enum",
          field,
          value,
          negated: false,
        });
      }
    }
  });

  it("folds enum aliases onto canonical values", () => {
    const cases: [string, string, string][] = [
      ["plex:available", "plex", "yes"],
      ["plex:missing", "plex", "no"],
      ["plex:true", "plex", "yes"],
      ["airing:upcoming", "airing", "soon"],
      ["airing:finished", "airing", "ended"],
      ["favourite:true", "favorite", "yes"],
      ["fav:no", "favorite", "no"],
      ["request:yes", "requested", "yes"],
    ];
    for (const [raw, field, value] of cases) {
      expect(parseQuery(raw).groups[0]?.[0]).toEqual({ kind: "enum", field, value, negated: false });
    }
  });

  it("degrades an unknown enum value to literal text", () => {
    expect(parseQuery("plex:maybe").groups[0]?.[0]).toEqual({
      kind: "fuzzy",
      value: "plex:maybe",
      negated: false,
    });
  });
});

describe("parseQuery — degradation", () => {
  it("never errors on an unknown prefix; it searches for the literal", () => {
    expect(parseQuery("foo:bar").groups[0]?.[0]).toEqual({
      kind: "fuzzy",
      value: "foo:bar",
      negated: false,
    });
  });

  it("keeps negation and quoting when degrading", () => {
    expect(parseQuery("-foo:bar").groups[0]?.[0]).toEqual({
      kind: "exact",
      value: "foo:bar",
      negated: true,
    });
    expect(parseQuery('foo:"bar baz"').groups[0]?.[0]).toEqual({
      kind: "exact",
      value: "foo:bar baz",
      negated: false,
    });
  });

  it("survives punctuation soup without throwing", () => {
    for (const raw of ['"', '"unterminated', ":::", "-", "-:", "()[]{}", "  :  "]) {
      expect(() => parseQuery(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("norm", () => {
  it("lower-cases and strips accents", () => {
    expect(norm("Amélie")).toBe("amelie");
    expect(norm("CAFÉ")).toBe("cafe");
    expect(norm("Pokémon")).toBe("pokemon");
  });
});

describe("matching — text", () => {
  it("returns the whole pool for an empty query", () => {
    expect(run("")).toEqual(ids(POOL));
  });

  it("matches bare terms as a conjunction", () => {
    expect(run("dexter")).toEqual(["dexter-new-blood"]);
    expect(run("dexter blood")).toEqual(["dexter-new-blood"]);
    expect(run("dexter arcane")).toEqual([]);
  });

  it("matches quoted phrases exactly and accent-insensitively", () => {
    expect(run('"new blood"')).toEqual(["dexter-new-blood"]);
    expect(run('"amelie"')).toEqual(["amelie"]);
    expect(run('"comedie"')).toEqual(["amelie"]);
    expect(run('"blood new"')).toEqual([]);
  });

  it("excludes with negation, exactly", () => {
    expect(run("-dexter")).toEqual(ids([breakingBad, amelie, arcane, severance]));
    expect(run('crime -"breaking bad"')).toEqual(["dexter-new-blood"]);
  });

  it("does not fuzzy-match a negated term", () => {
    // "dexterr" is a typo: as an exclusion it must not remove Dexter.
    expect(run("-dexterr")).toEqual(ids(POOL));
  });

  it("scopes field terms", () => {
    expect(run("cast:cranston")).toEqual(["breaking-bad"]);
    expect(run("cast:esposito")).toEqual(["breaking-bad"]); // manual cast counts
    expect(run("director:gilligan")).toEqual(["breaking-bad"]);
    expect(run("studio:showtime")).toEqual(["dexter-new-blood"]);
    expect(run("genre:crime")).toEqual(ids([dexter, breakingBad]));
    expect(run("tag:gore")).toEqual(["dexter-new-blood"]);
    expect(run("type:movie")).toEqual(["amelie"]);
    expect(run("status:watching")).toEqual(ids([dexter, severance]));
    expect(run("note:café")).toEqual(["amelie"]);
    expect(run("note:cafe")).toEqual(["amelie"]);
  });

  it("keeps a field term inside its field", () => {
    // "crime" is a genre, never a cast member.
    expect(run("cast:crime")).toEqual([]);
  });

  it("searches the literal when the prefix is unknown", () => {
    // Breaking Bad's notes contain the string "foo:bar".
    expect(run("foo:bar")).toEqual(["breaking-bad"]);
  });

  it("ORs groups and ANDs within them", () => {
    expect(run("dexter | arcane")).toEqual(ids([dexter, arcane]));
    expect(run("genre:crime rating:5 | type:movie")).toEqual(ids([breakingBad, amelie]));
    expect(run("genre:crime rating:5")).toEqual(["breaking-bad"]);
  });
});

describe("matching — numeric", () => {
  it("compares the user's rating", () => {
    expect(run("rating:>=4")).toEqual(ids([dexter, breakingBad, amelie]));
    expect(run("rating:5")).toEqual(ids([breakingBad, amelie]));
    expect(run("rating:>4")).toEqual(ids([breakingBad, amelie]));
    expect(run("rating:<=3")).toEqual(ids([arcane, severance])); // unrated is 0
  });

  it("accepts decimal commas in comparisons", () => {
    expect(run("rating:>=4,5")).toEqual(ids([breakingBad, amelie]));
  });

  it("compares the year, falling back to the release date", () => {
    expect(run("year:>2020")).toEqual(ids([dexter, arcane, severance]));
    expect(run("year:2001")).toEqual(["amelie"]);
    expect(run("year:<2010")).toEqual(ids([breakingBad, amelie]));
  });

  it("derives the year from releaseDate when `year` is absent", () => {
    const undated = createTitle({
      id: "undated",
      title: "Undated",
      type: "Movie",
      releaseDate: "1999-03-31",
    });
    expect(run("year:1999", [undated])).toEqual(["undated"]);
  });

  it("compares episodes left", () => {
    expect(run("eps-left:<5")).toEqual(ids([dexter, breakingBad, amelie]));
    expect(run("eps-left:0")).toEqual(ids([breakingBad, amelie]));
    expect(run("eps-left:>=15")).toEqual(ids([arcane, severance]));
  });

  it("compares runtime and community rating", () => {
    expect(run("runtime:<45")).toEqual(["arcane"]);
    expect(run("runtime:>100")).toEqual(["amelie"]);
    expect(run("community:>=8.7")).toEqual(ids([breakingBad, severance]));
  });

  it("never matches a title whose value is unknown", () => {
    const yearless = createTitle({ id: "yearless", title: "Yearless", type: "Movie" });
    expect(run("year:>1900", [yearless])).toEqual([]);
    expect(run("-year:>1900", [yearless])).toEqual(["yearless"]);
  });
});

describe("matching — enumerated", () => {
  it("filters on Plex availability", () => {
    expect(run("plex:yes")).toEqual(["amelie"]);
    expect(run("plex:partial")).toEqual(["arcane"]);
    expect(run("plex:no")).toEqual(ids([dexter, breakingBad, severance]));
    expect(run("plex:unknown")).toEqual(ids([dexter, breakingBad]));
  });

  it("filters on request state", () => {
    expect(run("requested:yes")).toEqual(["arcane"]);
    expect(run("requested:no")).toEqual(ids([dexter, breakingBad, amelie, severance]));
  });

  it("filters on airing state", () => {
    expect(run("airing:returning")).toEqual(["arcane"]);
    expect(run("airing:ended")).toEqual(["severance"]);
    expect(run("airing:soon")).toEqual(["arcane"]);
  });

  it("only counts a date inside the soon horizon", () => {
    const far = createTitle({
      id: "far",
      title: "Far",
      type: "TV Show",
      airing: { nextEpisode: { season: 1, episode: 1, airDate: "2027-01-01" } },
    });
    const past = createTitle({
      id: "past",
      title: "Past",
      type: "TV Show",
      airing: { nextEpisode: { season: 1, episode: 1, airDate: "2026-07-01" } },
    });
    expect(run("airing:soon", [far, past])).toEqual([]);
    expect(searchTitles([far], "airing:soon", { now: NOW, soonDays: 400 })).toHaveLength(1);
    expect(AIRING_SOON_DAYS).toBe(30);
  });

  it("counts an upcoming release date as airing soon", () => {
    const upcoming = createTitle({
      id: "upcoming",
      title: "Upcoming",
      type: "Movie",
      releaseDate: "2026-08-20",
    });
    expect(run("airing:soon", [upcoming])).toEqual(["upcoming"]);
  });

  it("filters on favourites", () => {
    expect(run("favorite:yes")).toEqual(["amelie"]);
    expect(run("favorite:no")).toEqual(ids([dexter, breakingBad, arcane, severance]));
  });

  it("negates an enum term", () => {
    expect(run("-plex:yes")).toEqual(ids([dexter, breakingBad, arcane, severance]));
  });
});

describe("SearchEngine — Fuse discipline", () => {
  it("never builds the index for quoted, negated, field or numeric terms", () => {
    const engine = new SearchEngine(POOL, { now: NOW });
    engine.filter('"new blood" -arcane cast:cranston rating:>=4 plex:yes');
    expect(engine.indexBuilt).toBe(false);
  });

  it("builds the index lazily, once, for bare terms", () => {
    const engine = new SearchEngine(POOL, { now: NOW });
    expect(engine.indexBuilt).toBe(false);
    const first = engine.filter("braking bad");
    expect(engine.indexBuilt).toBe(true);
    // Memoised: a second identical run returns the same set.
    expect(ids(engine.filter("braking bad"))).toEqual(ids(first));
  });

  it("fuzzy-matches a typo a substring search would miss", () => {
    const engine = new SearchEngine(POOL, { now: NOW });
    expect(ids(engine.filter("braking bad"))).toEqual(["breaking-bad"]);
  });

  it("answers `matches` for a single title", () => {
    const engine = new SearchEngine(POOL, { now: NOW });
    expect(engine.matches(dexter, "genre:crime")).toBe(true);
    expect(engine.matches(amelie, "genre:crime")).toBe(false);
    expect(engine.matches(amelie, "")).toBe(true);
  });

  it("preserves pool order in results", () => {
    const engine = new SearchEngine(POOL, { now: NOW });
    expect(engine.filter("genre:crime | type:movie").map((title) => title.id)).toEqual([
      "dexter-new-blood",
      "breaking-bad",
      "amelie",
    ]);
  });

  it("accepts a pre-parsed query", () => {
    const parsed = parseQuery("type:movie");
    expect(ids(searchTitles(POOL, parsed, { now: NOW }))).toEqual(["amelie"]);
  });
});

describe("SEARCH_VOCABULARY", () => {
  it("lists exactly the fields the parser accepts", () => {
    expect(SEARCH_VOCABULARY.textFields).toEqual(TEXT_FIELDS);
    expect(SEARCH_VOCABULARY.numericFields).toEqual(NUMERIC_FIELDS);
    expect(SEARCH_VOCABULARY.enumFields).toEqual(ENUM_FIELDS);
    expect(SEARCH_VOCABULARY.operators).toEqual([">", ">=", "<", "<=", "="]);
  });
});
