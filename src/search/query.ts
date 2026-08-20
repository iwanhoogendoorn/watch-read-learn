/**
 * The Library search language (SPEC §4.5), ported from foodspot's `query.ts`
 * (`docs/research/report-foodspot.md` §2c) and widened for media fields.
 *
 * Grammar — a **disjunction of conjunctions**:
 *
 *   dexter blood            two bare terms, both must match (fuzzy, via Fuse)
 *   "den haag"              quoted → exact, accent-insensitive substring
 *   -sushi                  negation; negation always forces *exact* matching
 *   cast:cranston           field-scoped substring
 *   via:"Netflix"           where you watched it (`venue:` also accepted)
 *   rating:>=4 year:>2020   numeric comparison, `>` `>=` `<` `<=` `=`
 *   eps-left:<5 runtime:<45 …and the derived numeric fields
 *   plex:yes requested:no   enumerated predicates
 *   airing:soon             …including the airing state
 *   ramen | sushi           a bare `|` splits the query into OR groups
 *
 * Two rules make it safe to run on every keystroke:
 *
 *   1. **Nothing is ever a syntax error.** An unknown prefix (`foo:bar`), an
 *      unparseable comparison (`rating:soon`) or an unknown enum value
 *      (`plex:maybe`) degrades to a literal text search for the whole token —
 *      which is exactly right for a user who is mid-typing.
 *   2. **Fuse is lazy.** The index is built at most once per `filter()` call,
 *      over the already-facet-filtered pool, and each fuzzy term's result set is
 *      memoised. Quoted and negated terms never touch Fuse at all.
 *
 * Pure module: no obsidian imports, no DOM, no network.
 */
import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import { episodesRemaining } from "../data/episodes";
import type {
  EnumTerm,
  ExactTerm,
  FieldTerm,
  FuzzyTerm,
  NumericOp,
  NumericTerm,
  ParsedQuery,
  QueryEnumField,
  QueryNumericField,
  QueryTerm,
  QueryTextField,
  TitleV4,
} from "../types";

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Lower-cased, NFKD-decomposed, combining marks stripped — so `cafe` matches
 * `café` and `Pokemon` matches `Pokémon`. Every comparison in this module runs
 * on `norm()`ed strings on both sides.
 */
export function norm(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function joinValues(...parts: (string | string[] | undefined)[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (Array.isArray(part)) {
      for (const item of part) if (item) out.push(item);
    } else {
      out.push(part);
    }
  }
  return out.join(" ");
}

/** API list plus the user's manual additions, deduped, order preserved. */
function merged(api: string[] | undefined, manual: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...(api ?? []), ...(manual ?? [])]) {
    if (!value) continue;
    const key = norm(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field vocabulary
// ---------------------------------------------------------------------------

export const TEXT_FIELDS: readonly QueryTextField[] = [
  "title",
  "type",
  "status",
  "priority",
  "genre",
  "tag",
  "cast",
  "director",
  "studio",
  "note",
  "via",
];

export const NUMERIC_FIELDS: readonly QueryNumericField[] = [
  "rating",
  "year",
  "eps-left",
  "runtime",
  "community",
];

export const ENUM_FIELDS: readonly QueryEnumField[] = ["plex", "requested", "airing", "favorite"];

/**
 * The vocabulary half of the grammar, lifted out so a surface with different
 * fields can reuse the *parser* instead of forking it.
 *
 * The tokenizer below is the fiddly part — negation at a word boundary, quoted
 * phrases, `|` groups, numeric comparisons, and the rule that nothing is ever a
 * syntax error. None of that varies per domain; only the field names do. So the
 * field names are data (this interface) and the tokenizer takes them as an
 * argument (`tokenizeQuery`), and `parseQuery` is that call with the Library's
 * vocabulary baked in.
 */
export interface QueryVocabulary<
  T extends string = string,
  N extends string = string,
  E extends string = string,
> {
  /** Accepted spelling → canonical text field (`actors` → `cast`). */
  text: Readonly<Record<string, T>>;
  numeric: Readonly<Record<string, N>>;
  enums: Readonly<Record<string, E>>;
  /** Per enum field: accepted value spelling → canonical value. */
  enumValues: Readonly<Record<E, Readonly<Record<string, string>>>>;
}

/** `QueryTerm`, with the field vocabulary left open. */
export type GenericTerm<T extends string, N extends string, E extends string> =
  | { kind: "fuzzy"; value: string; negated: false }
  | { kind: "exact"; value: string; negated: boolean }
  | { kind: "field"; field: T; value: string; negated: boolean }
  | { kind: "numeric"; field: N; op: NumericOp; value: number; negated: boolean }
  | { kind: "enum"; field: E; value: string; negated: boolean };

/** `ParsedQuery`, with the field vocabulary left open. */
export interface GenericParsedQuery<T extends string, N extends string, E extends string> {
  raw: string;
  groups: GenericTerm<T, N, E>[][];
  isEmpty: boolean;
}

/** Spellings the tokenizer accepts for each canonical text field. */
const TEXT_ALIASES: Record<string, QueryTextField> = {
  title: "title",
  name: "title",
  type: "type",
  status: "status",
  priority: "priority",
  genre: "genre",
  genres: "genre",
  tag: "tag",
  tags: "tag",
  cast: "cast",
  actor: "cast",
  actors: "cast",
  director: "director",
  directors: "director",
  studio: "studio",
  studios: "studio",
  network: "studio",
  note: "note",
  notes: "note",
  via: "via",
  venue: "via",
  watchedvia: "via",
};

const NUMERIC_ALIASES: Record<string, QueryNumericField> = {
  rating: "rating",
  stars: "rating",
  year: "year",
  "eps-left": "eps-left",
  epsleft: "eps-left",
  "episodes-left": "eps-left",
  left: "eps-left",
  runtime: "runtime",
  duration: "runtime",
  community: "community",
  public: "community",
  imdb: "community",
};

const ENUM_ALIASES: Record<string, QueryEnumField> = {
  plex: "plex",
  requested: "requested",
  request: "requested",
  airing: "airing",
  favorite: "favorite",
  favourite: "favorite",
  fav: "favorite",
};

/** Canonical enum values, after alias folding. */
const ENUM_VALUES: Record<QueryEnumField, Record<string, string>> = {
  plex: {
    yes: "yes",
    true: "yes",
    available: "yes",
    partial: "partial",
    no: "no",
    false: "no",
    missing: "no",
    none: "no",
    unknown: "unknown",
  },
  requested: {
    yes: "yes",
    true: "yes",
    no: "no",
    false: "no",
  },
  airing: {
    soon: "soon",
    upcoming: "soon",
    returning: "returning",
    ended: "ended",
    finished: "ended",
  },
  favorite: {
    yes: "yes",
    true: "yes",
    no: "no",
    false: "no",
  },
};

/** Everything the Library's own tokenizer pass needs, as one value. */
export const LIBRARY_VOCABULARY: QueryVocabulary<
  QueryTextField,
  QueryNumericField,
  QueryEnumField
> = {
  text: TEXT_ALIASES,
  numeric: NUMERIC_ALIASES,
  enums: ENUM_ALIASES,
  enumValues: ENUM_VALUES,
};

/** How near a scheduled episode or release has to be to count as `airing:soon`. */
export const AIRING_SOON_DAYS = 30;

const DAY_MS = 86_400_000;

/** Everything the Search-syntax modal needs to document itself. */
export const SEARCH_VOCABULARY = {
  textFields: TEXT_FIELDS,
  numericFields: NUMERIC_FIELDS,
  enumFields: ENUM_FIELDS,
  operators: [">", ">=", "<", "<=", "="] as readonly NumericOp[],
  enumValues: {
    plex: ["yes", "partial", "no", "unknown"],
    requested: ["yes", "no"],
    airing: ["soon", "returning", "ended"],
    favorite: ["yes", "no"],
  } as Record<QueryEnumField, readonly string[]>,
} as const;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * `-`? then an optional `field:` prefix, then either a quoted phrase or a run of
 * non-space characters. Field names may contain hyphens so `eps-left:` scopes,
 * while a leading `-` is still read as negation.
 */
const TOKEN_RE = /(-)?(?:([A-Za-z][A-Za-z-]*):)?(?:"([^"]*)"|([^\s"]+))/g;

const NUMERIC_RE = /^(>=|<=|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/;

/** A bare `|` (or `||`, `|||`) — the OR separator, never a search term. */
function isOrSeparator(field: string | undefined, value: string, quoted: boolean): boolean {
  return !quoted && field === undefined && /^\|+$/.test(value);
}

function literalTerm<T extends string, N extends string, E extends string>(
  raw: string,
  negated: boolean,
  quoted: boolean,
): GenericTerm<T, N, E> {
  if (negated || quoted) {
    return { kind: "exact", value: raw, negated };
  }
  return { kind: "fuzzy", value: raw, negated: false };
}

function buildTerm<T extends string, N extends string, E extends string>(
  negated: boolean,
  field: string | undefined,
  value: string,
  quoted: boolean,
  vocab: QueryVocabulary<T, N, E>,
): GenericTerm<T, N, E> | null {
  if (field === undefined) {
    if (value === "") return null;
    return literalTerm(value, negated, quoted);
  }

  const key = field.toLowerCase();
  const literal = `${field}:${value}`;

  const textField = vocab.text[key];
  if (textField) {
    if (value === "") return null;
    return { kind: "field", field: textField, value, negated };
  }

  const numericField = vocab.numeric[key];
  if (numericField) {
    const match = NUMERIC_RE.exec(value.trim());
    const rawNumber = match?.[2];
    if (!match || rawNumber === undefined) return literalTerm(literal, negated, quoted);
    const parsed = Number(rawNumber.replace(",", "."));
    if (!Number.isFinite(parsed)) return literalTerm(literal, negated, quoted);
    const op = (match[1] ?? "=") as NumericOp;
    return { kind: "numeric", field: numericField, op, value: parsed, negated };
  }

  const enumField = vocab.enums[key];
  if (enumField) {
    const canonical = vocab.enumValues[enumField][value.trim().toLowerCase()];
    if (!canonical) return literalTerm(literal, negated, quoted);
    return { kind: "enum", field: enumField, value: canonical, negated };
  }

  // Unknown prefix — not an error, just text. `foo:bar` searches for "foo:bar".
  return literalTerm(literal, negated, quoted);
}

/**
 * The grammar, over any vocabulary.
 *
 * Never throws and never reports an error: anything it cannot interpret becomes
 * a literal text term.
 */
export function tokenizeQuery<T extends string, N extends string, E extends string>(
  raw: string,
  vocab: QueryVocabulary<T, N, E>,
): GenericParsedQuery<T, N, E> {
  const groups: GenericTerm<T, N, E>[][] = [];
  let current: GenericTerm<T, N, E>[] = [];

  TOKEN_RE.lastIndex = 0;
  for (const match of raw.matchAll(TOKEN_RE)) {
    const negated = match[1] === "-";
    const field = match[2];
    const quoted = match[3] !== undefined;
    const value = quoted ? (match[3] ?? "") : (match[4] ?? "");

    if (isOrSeparator(field, value, quoted)) {
      groups.push(current);
      current = [];
      continue;
    }

    const term = buildTerm(negated, field, value, quoted, vocab);
    if (term) current.push(term);
  }
  groups.push(current);

  const nonEmpty = groups.filter((group) => group.length > 0);
  return { raw, groups: nonEmpty, isEmpty: nonEmpty.length === 0 };
}

/** Parse a raw search box string with the Library's vocabulary. */
export function parseQuery(raw: string): ParsedQuery {
  return tokenizeQuery(raw, LIBRARY_VOCABULARY);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface SearchDoc {
  index: number;
  title: TitleV4;
  /** Normalised text per scoped field. */
  fields: Record<QueryTextField, string>;
  /** Everything, normalised, for bare and quoted terms. */
  haystack: string;
}

function titleYear(title: TitleV4): number | undefined {
  if (typeof title.year === "number" && Number.isFinite(title.year) && title.year > 0) {
    return title.year;
  }
  if (title.releaseDate) {
    const year = Number(title.releaseDate.slice(0, 4));
    if (Number.isFinite(year) && year > 0) return year;
  }
  return undefined;
}

function buildDoc(title: TitleV4, index: number): SearchDoc {
  const cast = merged(title.cast, title.manualCast);
  const director = merged(title.director, title.manualDirector);
  const studio = merged(title.studio, title.manualStudio);

  const fields: Record<QueryTextField, string> = {
    title: norm(title.title ?? ""),
    type: norm(title.type ?? ""),
    status: norm(title.status ?? ""),
    priority: norm(title.priority ?? ""),
    genre: norm(joinValues(title.genres)),
    tag: norm(joinValues(title.tags)),
    cast: norm(joinValues(cast)),
    director: norm(joinValues(director)),
    studio: norm(joinValues(studio)),
    note: norm(title.notes ?? ""),
    via: norm(title.watchedVia ?? ""),
  };

  const year = titleYear(title);
  const haystack = norm(
    joinValues(
      title.title,
      title.type,
      title.status,
      title.priority,
      title.review,
      title.watchedVia,
      title.genres,
      title.tags,
      cast,
      director,
      studio,
      title.notes,
      title.overview,
      year ? String(year) : undefined,
    ),
  );

  return { index, title, fields, haystack };
}

// ---------------------------------------------------------------------------
// Fuse
// ---------------------------------------------------------------------------

/**
 * Weighted the way a person searches a watchlist: the name dominates, credits
 * and genres are useful, free text is a long shot. Mirrors foodspot's tuning.
 */
const FUSE_OPTIONS: IFuseOptions<SearchDoc> = {
  threshold: 0.24,
  ignoreLocation: true,
  includeScore: false,
  keys: [
    { name: "fields.title", weight: 0.6 },
    { name: "fields.genre", weight: 0.3 },
    { name: "fields.cast", weight: 0.25 },
    { name: "fields.director", weight: 0.2 },
    { name: "fields.tag", weight: 0.2 },
    { name: "fields.studio", weight: 0.15 },
    { name: "fields.type", weight: 0.15 },
    { name: "fields.status", weight: 0.15 },
    { name: "fields.note", weight: 0.1 },
  ],
};

/**
 * The lazy, memoised Fuse pass, over any document that carries an `index`.
 *
 * Both rules that make fuzzy search safe on every keystroke live here rather
 * than in each engine: the index is built **at most once** per pool and only
 * when a bare term actually needs it, and every term's hit set is cached for the
 * life of the pool.
 */
export interface FuzzyDoc {
  /** Position in the pool. `-1` for a document built outside it. */
  index: number;
}

export class FuzzyIndex<D extends FuzzyDoc> {
  private fuse: Fuse<D> | null = null;
  private readonly cache = new Map<string, Set<number>>();

  constructor(
    private readonly docs: readonly D[],
    private readonly options: IFuseOptions<D>,
  ) {}

  /** True once a bare term has forced the index to be built. Exposed for tests. */
  get built(): boolean {
    return this.fuse !== null;
  }

  /** Doc indexes Fuse matched for one already-normalised term. */
  matches(needle: string): Set<number> {
    const cached = this.cache.get(needle);
    if (cached) return cached;
    if (!this.fuse) this.fuse = new Fuse([...this.docs], this.options);
    const hits = new Set<number>();
    for (const result of this.fuse.search(needle)) hits.add(result.item.index);
    this.cache.set(needle, hits);
    return hits;
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function numericValue(title: TitleV4, field: QueryNumericField): number | undefined {
  switch (field) {
    case "rating":
      return title.rating;
    case "year":
      return titleYear(title);
    case "eps-left":
      return episodesRemaining(title);
    case "runtime":
      return title.episodeDuration;
    case "community":
      return title.communityRating;
    default:
      return undefined;
  }
}

function compare(actual: number, op: NumericOp, expected: number): boolean {
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

function plexMatches(title: TitleV4, value: string): boolean {
  const state = title.plex?.state;
  switch (value) {
    case "yes":
      return state === "available";
    case "partial":
      return state === "partial";
    case "unknown":
      return state === undefined || state === "unknown";
    case "no":
      return state !== "available" && state !== "partial";
    default:
      return false;
  }
}

function isRequested(title: TitleV4): boolean {
  const request = title.request;
  if (!request) return false;
  return request.id !== undefined || request.status !== undefined || request.requestedAt !== undefined;
}

function airingMatches(title: TitleV4, value: string, now: number, soonDays: number): boolean {
  const airing = title.airing;
  switch (value) {
    case "returning": {
      if (!airing) return false;
      if (airing.inProduction === true) return true;
      const status = airing.showStatus ?? "";
      return status === "Returning Series" || status === "In Production";
    }
    case "ended": {
      const status = airing?.showStatus ?? "";
      return status === "Ended" || status === "Canceled" || status === "Cancelled";
    }
    case "soon": {
      const horizon = now + soonDays * DAY_MS;
      for (const date of [
        airing?.nextEpisode?.airDate,
        airing?.digitalReleaseDate,
        title.releaseDate,
      ]) {
        if (!date) continue;
        const at = Date.parse(`${date}T00:00:00`);
        if (!Number.isFinite(at)) continue;
        if (at >= now && at <= horizon) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /** Epoch ms used by `airing:soon`. Defaults to `Date.now()`. Injected by tests. */
  now?: number;
  /** Horizon for `airing:soon`, in days. Defaults to `AIRING_SOON_DAYS`. */
  soonDays?: number;
}

/**
 * A search session over one pool of titles.
 *
 * Build it once per pool (i.e. per facet-filter pass), then run as many queries
 * against it as you like — the document projection is shared and the Fuse index
 * is only built if a bare term actually needs it.
 */
export class SearchEngine {
  private readonly docs: SearchDoc[];
  private readonly now: number;
  private readonly soonDays: number;
  private readonly fuzzy: FuzzyIndex<SearchDoc>;

  constructor(pool: readonly TitleV4[], options: QueryOptions = {}) {
    this.docs = pool.map((title, index) => buildDoc(title, index));
    this.now = options.now ?? Date.now();
    this.soonDays = options.soonDays ?? AIRING_SOON_DAYS;
    this.fuzzy = new FuzzyIndex(this.docs, FUSE_OPTIONS);
  }

  /** True once a bare term has forced the index to be built. Exposed for tests. */
  get indexBuilt(): boolean {
    return this.fuzzy.built;
  }

  /** Titles matching the query, in pool order. An empty query returns everything. */
  filter(query: string | ParsedQuery): TitleV4[] {
    const parsed = typeof query === "string" ? parseQuery(query) : query;
    if (parsed.isEmpty) return this.docs.map((doc) => doc.title);
    return this.docs.filter((doc) => this.matchDoc(doc, parsed)).map((doc) => doc.title);
  }

  /** Does one title in this pool match? Same semantics as `filter`. */
  matches(title: TitleV4, query: string | ParsedQuery): boolean {
    const parsed = typeof query === "string" ? parseQuery(query) : query;
    if (parsed.isEmpty) return true;
    const doc = this.docs.find((candidate) => candidate.title === title) ?? buildDoc(title, -1);
    return this.matchDoc(doc, parsed);
  }

  private matchDoc(doc: SearchDoc, parsed: ParsedQuery): boolean {
    // Disjunction of conjunctions: any group, all of its terms.
    return parsed.groups.some((group) => group.every((term) => this.matchTerm(doc, term)));
  }

  private matchTerm(doc: SearchDoc, term: QueryTerm): boolean {
    const hit = this.matchPositive(doc, term);
    return term.negated ? !hit : hit;
  }

  private matchPositive(doc: SearchDoc, term: QueryTerm): boolean {
    switch (term.kind) {
      case "exact": {
        const needle = norm(term.value);
        return needle === "" || doc.haystack.includes(needle);
      }
      case "fuzzy": {
        const needle = norm(term.value);
        if (needle === "") return true;
        // A literal substring is always a hit; Fuse handles the rest.
        if (doc.haystack.includes(needle)) return true;
        if (doc.index < 0) return false;
        return this.fuzzy.matches(needle).has(doc.index);
      }
      case "field": {
        const needle = norm(term.value);
        return needle === "" || doc.fields[term.field].includes(needle);
      }
      case "numeric": {
        const actual = numericValue(doc.title, term.field);
        if (actual === undefined || !Number.isFinite(actual)) return false;
        return compare(actual, term.op, term.value);
      }
      case "enum": {
        switch (term.field) {
          case "plex":
            return plexMatches(doc.title, term.value);
          case "requested":
            return term.value === "yes" ? isRequested(doc.title) : !isRequested(doc.title);
          case "airing":
            return airingMatches(doc.title, term.value, this.now, this.soonDays);
          case "favorite":
            return term.value === "yes" ? doc.title.favorite === true : doc.title.favorite !== true;
          default:
            return false;
        }
      }
      default:
        return false;
    }
  }
}

/**
 * One-shot convenience: parse, run and return. Callers that filter repeatedly
 * against the same pool should hold a `SearchEngine` instead.
 */
export function searchTitles(
  pool: readonly TitleV4[],
  query: string | ParsedQuery,
  options: QueryOptions = {},
): TitleV4[] {
  return new SearchEngine(pool, options).filter(query);
}
