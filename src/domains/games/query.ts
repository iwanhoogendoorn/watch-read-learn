/**
 * The Games search language.
 *
 * Same grammar as the Library's (`search/query.ts`) — a disjunction of
 * conjunctions, quoted phrases exact, `-` negating, `|` splitting OR groups,
 * Fuse doing the fuzzy work for bare terms — with the vocabulary a game has:
 *
 *   hades                      fuzzy, across everything
 *   platform:switch            the platforms array
 *   playtime:>40               hours played, not minutes (see below)
 *   wishlist:yes -status:TBA   the flags and the enumerated fields
 *   dev:"Supergiant Games"     developer / publisher
 *   achievements:100           percentage of achievements earned
 *
 * **`playtime:` is hours.** `Game.playtimeMinutes` is what is stored, but nobody
 * thinks in minutes about a 4,210-minute save file, and `playtime:>40` meaning
 * "more than 40 minutes" would be a trap. `minutes:` is there for the literal.
 *
 * The two rules that make it safe on every keystroke are the Library's:
 * nothing is ever a syntax error (an unknown prefix or an unparseable comparison
 * degrades to a literal search), and the Fuse index is built lazily, at most
 * once per pool, only if a bare term needs it.
 *
 * Pure module — no obsidian, no DOM, no network.
 */
import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import type { Game } from "../../types";
import { achievementPercent, gameProgress, gameYear } from "./stats";

/** Lower-cased, NFKD-decomposed, combining marks stripped. */
export function norm(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type GameTextField =
  | "title"
  | "genre"
  | "status"
  | "priority"
  | "platform"
  | "developer"
  | "publisher";

export type GameNumericField =
  | "rating"
  | "year"
  | "playtime"
  | "minutes"
  | "progress"
  | "achievements";

export type GameEnumField = "wishlist" | "favorite" | "mode" | "played";

export const GAME_TEXT_FIELDS: readonly GameTextField[] = [
  "title",
  "genre",
  "status",
  "priority",
  "platform",
  "developer",
  "publisher",
];

export const GAME_NUMERIC_FIELDS: readonly GameNumericField[] = [
  "rating",
  "year",
  "playtime",
  "minutes",
  "progress",
  "achievements",
];

export const GAME_ENUM_FIELDS: readonly GameEnumField[] = [
  "wishlist",
  "favorite",
  "mode",
  "played",
];

const TEXT_ALIASES: Record<string, GameTextField> = {
  title: "title",
  name: "title",
  genre: "genre",
  genres: "genre",
  // v3 calls a game's genre its `type`, and the settings tab still says Genre.
  type: "genre",
  status: "status",
  priority: "priority",
  platform: "platform",
  platforms: "platform",
  developer: "developer",
  dev: "developer",
  studio: "developer",
  publisher: "publisher",
  pub: "publisher",
};

const NUMERIC_ALIASES: Record<string, GameNumericField> = {
  rating: "rating",
  stars: "rating",
  year: "year",
  playtime: "playtime",
  hours: "playtime",
  minutes: "minutes",
  mins: "minutes",
  progress: "progress",
  achievements: "achievements",
  achievement: "achievements",
  ach: "achievements",
};

const ENUM_ALIASES: Record<string, GameEnumField> = {
  wishlist: "wishlist",
  wanted: "wishlist",
  favorite: "favorite",
  favourite: "favorite",
  fav: "favorite",
  mode: "mode",
  players: "mode",
  played: "played",
};

const ENUM_VALUES: Record<GameEnumField, Record<string, string>> = {
  wishlist: { yes: "yes", true: "yes", no: "no", false: "no" },
  favorite: { yes: "yes", true: "yes", no: "no", false: "no" },
  mode: {
    solo: "solo",
    single: "solo",
    singleplayer: "solo",
    sp: "solo",
    coop: "coop",
    "co-op": "coop",
    multiplayer: "multi",
    multi: "multi",
    mp: "multi",
  },
  played: { yes: "yes", true: "yes", no: "no", false: "no" },
};

/** Everything the Games search-syntax modal needs to document itself. */
export const GAME_SEARCH_VOCABULARY = {
  textFields: GAME_TEXT_FIELDS,
  numericFields: GAME_NUMERIC_FIELDS,
  enumFields: GAME_ENUM_FIELDS,
  operators: [">", ">=", "<", "<=", "="] as const,
  enumValues: {
    wishlist: ["yes", "no"],
    favorite: ["yes", "no"],
    mode: ["solo", "coop", "multi"],
    played: ["yes", "no"],
  } as Record<GameEnumField, readonly string[]>,
} as const;

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export type GameNumericOp = ">" | ">=" | "<" | "<=" | "=";

export type GameTerm =
  | { kind: "fuzzy"; value: string; negated: false }
  | { kind: "exact"; value: string; negated: boolean }
  | { kind: "field"; field: GameTextField; value: string; negated: boolean }
  | {
      kind: "numeric";
      field: GameNumericField;
      op: GameNumericOp;
      value: number;
      negated: boolean;
    }
  | { kind: "enum"; field: GameEnumField; value: string; negated: boolean };

export interface ParsedGameQuery {
  raw: string;
  groups: GameTerm[][];
  isEmpty: boolean;
}

const TOKEN_RE = /(-)?(?:([A-Za-z][A-Za-z-]*):)?(?:"([^"]*)"|([^\s"]+))/g;
const NUMERIC_RE = /^(>=|<=|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/;

function literalTerm(raw: string, negated: boolean, quoted: boolean): GameTerm {
  // Negation always forces exact matching: "not roughly this" is not a thing a
  // person can predict, so `-hades` must mean the literal word.
  if (negated || quoted) return { kind: "exact", value: raw, negated };
  return { kind: "fuzzy", value: raw, negated: false };
}

function buildTerm(
  negated: boolean,
  field: string | undefined,
  value: string,
  quoted: boolean,
): GameTerm | null {
  if (field === undefined) {
    if (value === "") return null;
    return literalTerm(value, negated, quoted);
  }

  const key = field.toLowerCase();
  const literal = `${field}:${value}`;

  const textField = TEXT_ALIASES[key];
  if (textField) {
    if (value === "") return null;
    return { kind: "field", field: textField, value, negated };
  }

  const numericField = NUMERIC_ALIASES[key];
  if (numericField) {
    const match = NUMERIC_RE.exec(value.trim());
    const rawNumber = match?.[2];
    if (!match || rawNumber === undefined) return literalTerm(literal, negated, quoted);
    const parsed = Number(rawNumber.replace(",", "."));
    if (!Number.isFinite(parsed)) return literalTerm(literal, negated, quoted);
    return {
      kind: "numeric",
      field: numericField,
      op: (match[1] ?? "=") as GameNumericOp,
      value: parsed,
      negated,
    };
  }

  const enumField = ENUM_ALIASES[key];
  if (enumField) {
    const canonical = ENUM_VALUES[enumField][value.trim().toLowerCase()];
    if (!canonical) return literalTerm(literal, negated, quoted);
    return { kind: "enum", field: enumField, value: canonical, negated };
  }

  return literalTerm(literal, negated, quoted);
}

export function parseGameQuery(raw: string): ParsedGameQuery {
  const groups: GameTerm[][] = [];
  let current: GameTerm[] = [];

  TOKEN_RE.lastIndex = 0;
  for (const match of raw.matchAll(TOKEN_RE)) {
    const negated = match[1] === "-";
    const field = match[2];
    const quoted = match[3] !== undefined;
    const value = quoted ? (match[3] ?? "") : (match[4] ?? "");

    if (!quoted && field === undefined && /^\|+$/.test(value)) {
      groups.push(current);
      current = [];
      continue;
    }
    const term = buildTerm(negated, field, value, quoted);
    if (term) current.push(term);
  }
  groups.push(current);

  const nonEmpty = groups.filter((group) => group.length > 0);
  return { raw, groups: nonEmpty, isEmpty: nonEmpty.length === 0 };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface GameDoc {
  index: number;
  game: Game;
  fields: Record<GameTextField, string>;
  haystack: string;
}

function buildDoc(game: Game, index: number): GameDoc {
  const platforms = (game.platforms ?? []).join(" ");
  const fields: Record<GameTextField, string> = {
    title: norm(game.title ?? ""),
    genre: norm(game.type ?? ""),
    status: norm(game.status ?? ""),
    priority: norm(game.priority ?? ""),
    platform: norm(platforms),
    developer: norm(game.developer ?? ""),
    publisher: norm(game.publisher ?? ""),
  };
  const year = gameYear(game);
  const haystack = norm(
    [
      game.title,
      game.type,
      game.status,
      game.priority,
      game.developer,
      game.publisher,
      platforms,
      year === null ? "" : String(year),
    ]
      .filter((part) => (part ?? "") !== "")
      .join(" "),
  );
  return { index, game, fields, haystack };
}

const FUSE_OPTIONS: IFuseOptions<GameDoc> = {
  threshold: 0.24,
  ignoreLocation: true,
  includeScore: false,
  keys: [
    { name: "fields.title", weight: 0.6 },
    { name: "fields.genre", weight: 0.3 },
    { name: "fields.developer", weight: 0.25 },
    { name: "fields.publisher", weight: 0.2 },
    { name: "fields.platform", weight: 0.2 },
    { name: "fields.status", weight: 0.15 },
  ],
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function numericValue(game: Game, field: GameNumericField): number | undefined {
  switch (field) {
    case "rating":
      return game.rating;
    case "year":
      return gameYear(game) ?? undefined;
    case "playtime":
      // Hours, rounded to one decimal so `playtime:>0.5` is usable.
      return Math.round((game.playtimeMinutes / 60) * 10) / 10;
    case "minutes":
      return game.playtimeMinutes;
    case "progress":
      return gameProgress(game);
    case "achievements":
      return achievementPercent(game) ?? undefined;
    default:
      return undefined;
  }
}

function compare(actual: number, op: GameNumericOp, expected: number): boolean {
  switch (op) {
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
    case "=":
      return actual === expected;
    default:
      return false;
  }
}

function enumMatches(game: Game, field: GameEnumField, value: string): boolean {
  switch (field) {
    case "wishlist":
      return value === "yes" ? game.wishlist === true : game.wishlist !== true;
    case "favorite":
      return value === "yes" ? game.favorite === true : game.favorite !== true;
    case "played":
      return value === "yes" ? game.playtimeMinutes > 0 : !(game.playtimeMinutes > 0);
    case "mode":
      if (value === "solo") return game.singleplayer === true;
      if (value === "coop") return game.coop === true;
      if (value === "multi") return game.multiplayer === true;
      return false;
    default:
      return false;
  }
}

/**
 * A search session over one pool of games.
 *
 * Build it once per pool (i.e. per facet-filter pass); the Fuse index is only
 * built if a bare term actually needs it, and each term's hits are memoised.
 */
export class GameSearchEngine {
  private readonly docs: GameDoc[];
  private fuse: Fuse<GameDoc> | null = null;
  private readonly fuzzyCache = new Map<string, Set<number>>();

  constructor(pool: readonly Game[]) {
    this.docs = pool.map((game, index) => buildDoc(game, index));
  }

  /** True once a bare term has forced the index to be built. Exposed for tests. */
  get indexBuilt(): boolean {
    return this.fuse !== null;
  }

  filter(query: string | ParsedGameQuery): Game[] {
    const parsed = typeof query === "string" ? parseGameQuery(query) : query;
    if (parsed.isEmpty) return this.docs.map((doc) => doc.game);
    return this.docs.filter((doc) => this.matchDoc(doc, parsed)).map((doc) => doc.game);
  }

  matches(game: Game, query: string | ParsedGameQuery): boolean {
    const parsed = typeof query === "string" ? parseGameQuery(query) : query;
    if (parsed.isEmpty) return true;
    const doc = this.docs.find((candidate) => candidate.game === game) ?? buildDoc(game, -1);
    return this.matchDoc(doc, parsed);
  }

  private matchDoc(doc: GameDoc, parsed: ParsedGameQuery): boolean {
    return parsed.groups.some((group) =>
      group.every((term) => {
        const hit = this.matchPositive(doc, term);
        return term.negated ? !hit : hit;
      }),
    );
  }

  private matchPositive(doc: GameDoc, term: GameTerm): boolean {
    switch (term.kind) {
      case "exact": {
        const needle = norm(term.value);
        return needle === "" || doc.haystack.includes(needle);
      }
      case "fuzzy": {
        const needle = norm(term.value);
        if (needle === "") return true;
        if (doc.haystack.includes(needle)) return true;
        if (doc.index < 0) return false;
        return this.fuzzyMatches(needle).has(doc.index);
      }
      case "field": {
        const needle = norm(term.value);
        return needle === "" || doc.fields[term.field].includes(needle);
      }
      case "numeric": {
        const actual = numericValue(doc.game, term.field);
        if (actual === undefined || !Number.isFinite(actual)) return false;
        return compare(actual, term.op, term.value);
      }
      case "enum":
        return enumMatches(doc.game, term.field, term.value);
      default:
        return false;
    }
  }

  private fuzzyMatches(needle: string): Set<number> {
    const cached = this.fuzzyCache.get(needle);
    if (cached) return cached;
    if (!this.fuse) this.fuse = new Fuse(this.docs, FUSE_OPTIONS);
    const hits = new Set<number>();
    for (const result of this.fuse.search(needle)) hits.add(result.item.index);
    this.fuzzyCache.set(needle, hits);
    return hits;
  }
}

/** One-shot convenience: parse, run, return. */
export function searchGames(pool: readonly Game[], query: string | ParsedGameQuery): Game[] {
  return new GameSearchEngine(pool).filter(query);
}
