/**
 * Search over Upcoming rows.
 *
 * The **grammar is the Library's** — `tokenizeQuery` from `search/query.ts`,
 * with a vocabulary of the fields an event actually has. Nothing about the
 * parser is re-implemented here: negation, quoted phrases, `|` OR groups,
 * numeric comparisons and the rule that nothing is ever a syntax error all come
 * from that one tokenizer, and the lazy Fuse pass comes from `FuzzyIndex`.
 *
 * What is local is the vocabulary and the documents:
 *
 *   the last of us          fuzzy, across title, show, episode name and detail
 *   show:severance          the programme, for an episode row
 *   episode:"the grid"      the episode's own title
 *   domain:games            which library the row came from
 *   kind:season             episode | season | release
 *   state:due               due | scheduled | announced
 *   plex:no                 availability: yes | queued | no, as the facet says it
 *   watched:no              have you finished this episode / book / game yet
 *   days:<=7                calendar days until it arrives; negative once past
 *   favorite:yes
 *
 * Plain typing is fuzzy and needs none of it — the syntax lives in the `?`
 * modal, exactly as on the other tabs.
 *
 * Pure module: no obsidian, no DOM, no network.
 */
import type { IFuseOptions } from "fuse.js";
import {
  FuzzyIndex,
  norm,
  tokenizeQuery,
  type GenericParsedQuery,
  type GenericTerm,
  type QueryVocabulary,
} from "../../search/query";
import type { NumericOp } from "../../types";
import { availabilityOf, favoriteOf, stateOf, typeOf, watchStateOf } from "./filters";
import type { UnifiedRow } from "./unified";

export type UpcomingTextField = "title" | "show" | "episode" | "detail" | "type" | "library";
export type UpcomingNumericField = "days" | "year";
export type UpcomingEnumField =
  | "domain"
  | "kind"
  | "state"
  | "plex"
  | "watched"
  | "favorite";

export const UPCOMING_TEXT_FIELDS: readonly UpcomingTextField[] = [
  "title",
  "show",
  "episode",
  "detail",
  "type",
  "library",
];

export const UPCOMING_NUMERIC_FIELDS: readonly UpcomingNumericField[] = ["days", "year"];

export const UPCOMING_ENUM_FIELDS: readonly UpcomingEnumField[] = [
  "domain",
  "kind",
  "state",
  "plex",
  "watched",
  "favorite",
];

/**
 * The vocabulary, in the shape the shared tokenizer takes.
 *
 * `show:` and `title:` are deliberately different fields: on an episode row the
 * programme is the show and the episode name is the title of that episode, and
 * conflating them makes `show:severance episode:pilot` impossible to express.
 */
export const UPCOMING_VOCABULARY: QueryVocabulary<
  UpcomingTextField,
  UpcomingNumericField,
  UpcomingEnumField
> = {
  text: {
    title: "title",
    name: "title",
    show: "show",
    series: "show",
    programme: "show",
    episode: "episode",
    ep: "episode",
    detail: "detail",
    note: "detail",
    type: "type",
    library: "library",
    source: "library",
  },
  numeric: {
    days: "days",
    in: "days",
    year: "year",
  },
  enums: {
    domain: "domain",
    kind: "kind",
    event: "kind",
    state: "state",
    plex: "plex",
    available: "plex",
    watched: "watched",
    seen: "watched",
    read: "watched",
    played: "watched",
    finished: "watched",
    favorite: "favorite",
    favourite: "favorite",
    fav: "favorite",
  },
  enumValues: {
    domain: {
      watchlist: "watchlist",
      watch: "watchlist",
      tv: "watchlist",
      reading: "reading",
      read: "reading",
      books: "reading",
      games: "games",
      game: "games",
    },
    kind: {
      episode: "episode",
      episodes: "episode",
      season: "season",
      seasons: "season",
      release: "release",
      releases: "release",
    },
    state: {
      due: "due",
      scheduled: "scheduled",
      upcoming: "scheduled",
      announced: "announced",
      tba: "announced",
    },
    plex: {
      yes: "plex",
      true: "plex",
      available: "plex",
      no: "not-plex",
      false: "not-plex",
      missing: "not-plex",
      // "we could not check" is filed with "not there yet" — see
      // `availabilityOfTitle`. The old spellings still parse.
      unknown: "not-plex",
      queued: "queued",
      requested: "queued",
      downloading: "queued",
      pending: "queued",
    },
    watched: { yes: "watched", true: "watched", no: "unwatched", false: "unwatched" },
    favorite: { yes: "yes", true: "yes", no: "no", false: "no" },
  },
};

export type UpcomingTerm = GenericTerm<
  UpcomingTextField,
  UpcomingNumericField,
  UpcomingEnumField
>;

export type ParsedUpcomingQuery = GenericParsedQuery<
  UpcomingTextField,
  UpcomingNumericField,
  UpcomingEnumField
>;

export function parseUpcomingQuery(raw: string): ParsedUpcomingQuery {
  return tokenizeQuery(raw, UPCOMING_VOCABULARY);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface UpcomingDoc {
  index: number;
  row: UnifiedRow;
  fields: Record<UpcomingTextField, string>;
  haystack: string;
}

/**
 * The show and the episode name, pulled apart.
 *
 * A watchlist episode row carries the programme in `name` and the episode's own
 * title in `detail` — which is exactly the pair the search box needs, so it is
 * projected once here rather than re-derived per term.
 */
function showAndEpisode(row: UnifiedRow): { show: string; episode: string } {
  if (row.entry.source !== "watchlist") return { show: row.name, episode: "" };
  const entry = row.entry.value;
  if (entry.kind !== "episode") return { show: row.name, episode: "" };
  return { show: row.name, episode: entry.detail };
}

function buildDoc(row: UnifiedRow, index: number): UpcomingDoc {
  const { show, episode } = showAndEpisode(row);
  const library = row.source;
  const fields: Record<UpcomingTextField, string> = {
    // `title` matches the row's own headline *and* the episode name, so plain
    // `title:pilot` does what a person means on an episode row.
    title: norm([row.name, episode].filter(Boolean).join(" ")),
    show: norm(show),
    episode: norm(episode),
    detail: norm(row.detail),
    type: norm(typeOf(row)),
    library: norm(library),
  };
  const haystack = norm(
    [row.name, episode, row.detail, row.label, typeOf(row), library, row.date ?? ""]
      .filter((part) => part !== "")
      .join(" "),
  );
  return { index, row, fields, haystack };
}

/** Weighted the way a person searches a schedule: the name dominates. */
const FUSE_OPTIONS: IFuseOptions<UpcomingDoc> = {
  threshold: 0.24,
  ignoreLocation: true,
  includeScore: false,
  keys: [
    { name: "fields.show", weight: 0.6 },
    { name: "fields.episode", weight: 0.35 },
    { name: "fields.detail", weight: 0.2 },
    { name: "fields.type", weight: 0.15 },
  ],
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function numericValue(row: UnifiedRow, field: UpcomingNumericField): number | undefined {
  switch (field) {
    case "days":
      return row.daysUntil ?? undefined;
    case "year": {
      const year = Number(row.date?.slice(0, 4));
      return Number.isFinite(year) ? year : undefined;
    }
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

function enumMatches(row: UnifiedRow, field: UpcomingEnumField, value: string): boolean {
  switch (field) {
    case "domain":
      return row.source === value;
    case "kind":
      return row.kind === value;
    case "state":
      return stateOf(row) === value;
    case "plex":
      return availabilityOf(row) === value;
    case "watched":
      return watchStateOf(row) === value;
    case "favorite":
      return value === "yes" ? favoriteOf(row) : !favoriteOf(row);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A search session over one pool of rows.
 *
 * Built once per facet-filter pass; the Fuse index inside is built only if a
 * bare term needs it, and each term's hits are memoised for the pool's life.
 */
export class UpcomingSearchEngine {
  private readonly docs: UpcomingDoc[];
  private readonly fuzzy: FuzzyIndex<UpcomingDoc>;

  constructor(pool: readonly UnifiedRow[]) {
    this.docs = pool.map((row, index) => buildDoc(row, index));
    this.fuzzy = new FuzzyIndex(this.docs, FUSE_OPTIONS);
  }

  /** True once a bare term has forced the index to be built. Exposed for tests. */
  get indexBuilt(): boolean {
    return this.fuzzy.built;
  }

  filter(query: string | ParsedUpcomingQuery): UnifiedRow[] {
    const parsed = typeof query === "string" ? parseUpcomingQuery(query) : query;
    if (parsed.isEmpty) return this.docs.map((doc) => doc.row);
    return this.docs.filter((doc) => this.matchDoc(doc, parsed)).map((doc) => doc.row);
  }

  matches(row: UnifiedRow, query: string | ParsedUpcomingQuery): boolean {
    const parsed = typeof query === "string" ? parseUpcomingQuery(query) : query;
    if (parsed.isEmpty) return true;
    const doc = this.docs.find((candidate) => candidate.row === row) ?? buildDoc(row, -1);
    return this.matchDoc(doc, parsed);
  }

  private matchDoc(doc: UpcomingDoc, parsed: ParsedUpcomingQuery): boolean {
    // Disjunction of conjunctions: any group, all of its terms.
    return parsed.groups.some((group) =>
      group.every((term) => {
        const hit = this.matchPositive(doc, term);
        return term.negated ? !hit : hit;
      }),
    );
  }

  private matchPositive(doc: UpcomingDoc, term: UpcomingTerm): boolean {
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
        const actual = numericValue(doc.row, term.field);
        if (actual === undefined || !Number.isFinite(actual)) return false;
        return compare(actual, term.op, term.value);
      }
      case "enum":
        return enumMatches(doc.row, term.field, term.value);
      default:
        return false;
    }
  }
}

/** One-shot convenience: parse, run, return. */
export function searchUpcoming(
  pool: readonly UnifiedRow[],
  query: string | ParsedUpcomingQuery,
): UnifiedRow[] {
  return new UpcomingSearchEngine(pool).filter(query);
}
