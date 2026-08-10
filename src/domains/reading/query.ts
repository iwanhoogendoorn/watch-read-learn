/**
 * The Reading search language.
 *
 * **The grammar is not re-implemented here.** `search/query.ts` owns it —
 * quoting, negation, `|` OR-groups, numeric operators, the rule that nothing is
 * ever a syntax error — and this module reuses `parseQuery` verbatim, then
 * *re-reads* the terms it produced against a reading vocabulary:
 *
 *     author:herbert      pages:>300      chapters-read:<50
 *     status:Reading      rating:>=4      unit:words
 *     "dune"              -dropped        dune | berserk
 *
 * The shared tokenizer does not know `author:`, so it degrades that token to a
 * literal search for the string `author:herbert` — exactly as documented. The
 * adapter below picks those literals back up and promotes them, which means the
 * two languages can never drift apart on quoting or precedence: there is one
 * tokenizer, and this file is a dictionary on top of it.
 *
 * Bare terms behave the way the Library's do, down to the lazy Fuse index built
 * at most once per session over the already-filtered pool.
 *
 * Pure: no obsidian, no DOM, no store.
 */
import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import { norm, parseQuery } from "../../search/query";
import type { CustomColumn, NumericOp, ParsedQuery, QueryTerm } from "../../types";
import {
  derivedStatus,
  isBook,
  pagesEquivalent,
  primaryCounter,
  readingProgress,
  volumeCounter,
  type ReadingEntry,
} from "./progress";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ReadingTextField = "title" | "author" | "category" | "status" | "column";

export type ReadingNumericField =
  | "rating"
  | "year"
  | "progress"
  | "pages"
  | "pages-read"
  | "words"
  | "words-read"
  | "chapters"
  | "chapters-read"
  | "volumes"
  | "volumes-read";

export type ReadingEnumField = "favorite" | "unit";

const TEXT_ALIASES: Record<string, ReadingTextField> = {
  title: "title",
  name: "title",
  author: "author",
  by: "author",
  writer: "author",
  category: "category",
  categories: "category",
  genre: "category",
  status: "status",
  column: "column",
  col: "column",
  field: "column",
};

const NUMERIC_ALIASES: Record<string, ReadingNumericField> = {
  rating: "rating",
  stars: "rating",
  year: "year",
  progress: "progress",
  percent: "progress",
  pages: "pages",
  "pages-read": "pages-read",
  pagesread: "pages-read",
  read: "pages-read",
  words: "words",
  "words-read": "words-read",
  chapters: "chapters",
  chapter: "chapters",
  "chapters-read": "chapters-read",
  volumes: "volumes",
  volume: "volumes",
  "volumes-read": "volumes-read",
};

const ENUM_ALIASES: Record<string, ReadingEnumField> = {
  favorite: "favorite",
  favourite: "favorite",
  fav: "favorite",
  unit: "unit",
};

const ENUM_VALUES: Record<ReadingEnumField, Record<string, string>> = {
  favorite: { yes: "yes", true: "yes", no: "no", false: "no" },
  unit: { pages: "pages", page: "pages", words: "words", word: "words" },
};

/** Everything a help panel needs to document itself, without importing the DOM. */
export const READING_SEARCH_VOCABULARY = {
  textFields: ["title", "author", "category", "status", "column"] as readonly ReadingTextField[],
  numericFields: [
    "rating",
    "year",
    "progress",
    "pages",
    "pages-read",
    "words",
    "chapters",
    "chapters-read",
    "volumes",
  ] as readonly string[],
  enumFields: ["favorite", "unit"] as readonly ReadingEnumField[],
  operators: [">", ">=", "<", "<=", "="] as readonly NumericOp[],
} as const;

// ---------------------------------------------------------------------------
// Re-reading the shared parser's output
// ---------------------------------------------------------------------------

interface ReadingTextTerm {
  kind: "text";
  field: ReadingTextField;
  value: string;
  negated: boolean;
}

interface ReadingNumericTerm {
  kind: "number";
  field: ReadingNumericField;
  op: NumericOp;
  value: number;
  negated: boolean;
}

interface ReadingEnumTerm {
  kind: "flag";
  field: ReadingEnumField;
  value: string;
  negated: boolean;
}

interface ReadingLiteralTerm {
  kind: "literal";
  value: string;
  /** Exact substring rather than fuzzy — quoted or negated, per the shared rules. */
  exact: boolean;
  negated: boolean;
}

type ReadingTerm = ReadingTextTerm | ReadingNumericTerm | ReadingEnumTerm | ReadingLiteralTerm;

/** `field:value`, as the shared parser leaves an unknown prefix behind. */
const LITERAL_FIELD_RE = /^([A-Za-z][A-Za-z-]*):([\s\S]*)$/;
const NUMERIC_RE = /^(>=|<=|>|<|=)?\s*(-?\d+(?:[.,]\d+)?)$/;

function numericTerm(
  field: ReadingNumericField,
  raw: string,
  negated: boolean,
): ReadingNumericTerm | null {
  const match = NUMERIC_RE.exec(raw.trim());
  const digits = match?.[2];
  if (!match || digits === undefined) return null;
  const value = Number(digits.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return { kind: "number", field, op: (match[1] ?? "=") as NumericOp, value, negated };
}

/** One `field:value` pair → a reading term, or `null` when the field is not ours. */
function fromFieldPair(field: string, value: string, negated: boolean): ReadingTerm | null {
  const key = field.toLowerCase();

  const text = TEXT_ALIASES[key];
  if (text) {
    if (value === "") return null;
    return { kind: "text", field: text, value, negated };
  }

  const numeric = NUMERIC_ALIASES[key];
  if (numeric) return numericTerm(numeric, value, negated);

  const flag = ENUM_ALIASES[key];
  if (flag) {
    const canonical = ENUM_VALUES[flag][value.trim().toLowerCase()];
    if (!canonical) return null;
    return { kind: "flag", field: flag, value: canonical, negated };
  }

  return null;
}

/**
 * Shared AST → reading AST.
 *
 * A term the reading vocabulary does not recognise is not dropped: it becomes
 * the literal text search the shared parser already intended, so `plex:yes`
 * typed into the Reading box searches for the string rather than silently
 * matching everything.
 */
export function toReadingTerm(term: QueryTerm): ReadingTerm {
  switch (term.kind) {
    case "field": {
      const mapped = fromFieldPair(term.field, term.value, term.negated);
      if (mapped) return mapped;
      return { kind: "literal", value: `${term.field}:${term.value}`, exact: true, negated: term.negated };
    }
    case "numeric": {
      const mapped = fromFieldPair(term.field, `${term.op}${term.value}`, term.negated);
      if (mapped) return mapped;
      return {
        kind: "literal",
        value: `${term.field}:${term.op}${term.value}`,
        exact: true,
        negated: term.negated,
      };
    }
    case "enum": {
      const mapped = fromFieldPair(term.field, term.value, term.negated);
      if (mapped) return mapped;
      return { kind: "literal", value: `${term.field}:${term.value}`, exact: true, negated: term.negated };
    }
    case "exact":
    case "fuzzy": {
      // The interesting case: `author:herbert` arrives here as a literal,
      // because the shared tokenizer has no `author` field.
      const pair = LITERAL_FIELD_RE.exec(term.value);
      if (pair?.[1] !== undefined && pair[2] !== undefined) {
        const mapped = fromFieldPair(pair[1], pair[2], term.negated);
        if (mapped) return mapped;
      }
      return { kind: "literal", value: term.value, exact: term.kind === "exact", negated: term.negated };
    }
  }
}

export interface ReadingQuery {
  raw: string;
  groups: ReadingTerm[][];
  isEmpty: boolean;
}

export function parseReadingQuery(raw: string): ReadingQuery {
  const parsed: ParsedQuery = parseQuery(raw);
  return {
    raw,
    groups: parsed.groups.map((group) => group.map(toReadingTerm)),
    isEmpty: parsed.isEmpty,
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

interface ReadingDoc {
  index: number;
  entry: ReadingEntry;
  fields: Record<ReadingTextField, string>;
  haystack: string;
}

/** Custom-column values as text, so a bare term finds `Sci-Fi` in a select column. */
export function customFieldText(entry: ReadingEntry, columns: readonly CustomColumn[]): string {
  const parts: string[] = [];
  for (const column of columns) {
    const value = entry.customFields?.[column.id];
    if (value === undefined || value === null || value === "") continue;
    parts.push(String(value));
  }
  // Anything under a column that no longer exists still counts — the value is
  // still on the row, and hiding it from search would be a silent data loss.
  for (const [key, value] of Object.entries(entry.customFields ?? {})) {
    if (columns.some((column) => column.id === key)) continue;
    if (value === undefined || value === null || value === "") continue;
    parts.push(String(value));
  }
  return parts.join(" ");
}

function buildDoc(
  entry: ReadingEntry,
  index: number,
  columns: readonly CustomColumn[],
  now: Date,
): ReadingDoc {
  const columnText = customFieldText(entry, columns);
  const fields: Record<ReadingTextField, string> = {
    title: norm(entry.title ?? ""),
    author: norm(entry.author ?? ""),
    category: norm((entry.categories ?? []).join(" ")),
    status: norm(derivedStatus(entry, now)),
    column: norm(columnText),
  };
  const haystack = norm(
    [
      entry.title,
      entry.author,
      (entry.categories ?? []).join(" "),
      derivedStatus(entry, now),
      columnText,
      entry.releaseDate ?? "",
    ]
      .filter((part) => part !== "" && part !== undefined)
      .join(" "),
  );
  return { index, entry, fields, haystack };
}

/** Weighted the way a shelf is searched: the name first, then who wrote it. */
const FUSE_OPTIONS: IFuseOptions<ReadingDoc> = {
  threshold: 0.24,
  ignoreLocation: true,
  includeScore: false,
  keys: [
    { name: "fields.title", weight: 0.6 },
    { name: "fields.author", weight: 0.35 },
    { name: "fields.category", weight: 0.25 },
    { name: "fields.column", weight: 0.2 },
    { name: "fields.status", weight: 0.15 },
  ],
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * A **total** of zero means "nobody has said how long this is", not "zero pages
 * long", so it never matches a comparison — the same rule that keeps unrated
 * titles out of `rating:` in the Library. A *read* counter of zero is a real
 * value and does match.
 */
function unknownIfZero(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

function numericValue(entry: ReadingEntry, field: ReadingNumericField): number | undefined {
  const counter = primaryCounter(entry);
  switch (field) {
    case "rating":
      return entry.rating > 0 ? entry.rating : undefined;
    case "year": {
      const year = Number.parseInt((entry.releaseDate ?? "").slice(0, 4), 10);
      return Number.isFinite(year) && year > 0 ? year : undefined;
    }
    case "progress":
      return readingProgress(entry);
    case "pages":
      return isBook(entry) ? unknownIfZero(pagesEquivalent(entry).total) : undefined;
    case "pages-read":
      return isBook(entry) ? pagesEquivalent(entry).read : undefined;
    case "words":
      return isBook(entry) ? unknownIfZero(entry.totalWords) : undefined;
    case "words-read":
      return isBook(entry) ? entry.wordsRead : undefined;
    case "chapters":
      return unknownIfZero(isBook(entry) ? entry.totalChapters : counter.total);
    case "chapters-read":
      return isBook(entry) ? entry.chaptersRead : counter.read;
    case "volumes":
      return isBook(entry) ? undefined : unknownIfZero(volumeCounter(entry).total);
    case "volumes-read":
      return isBook(entry) ? undefined : volumeCounter(entry).read;
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

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReadingSearchOptions {
  /** Column definitions for the sub-tab being searched. */
  columns?: readonly CustomColumn[];
  /** Injected so `status:` on a derived `To be released` is testable. */
  now?: Date;
}

/**
 * A search session over one pool of reading entries.
 *
 * Same lifecycle as the Library's `SearchEngine`: build it per facet-filtered
 * pool, run as many queries against it as you like, and the Fuse index is only
 * built if a bare term actually needs one.
 */
export class ReadingSearchEngine {
  private readonly docs: ReadingDoc[];
  private fuse: Fuse<ReadingDoc> | null = null;
  private readonly fuzzyCache = new Map<string, Set<number>>();

  constructor(pool: readonly ReadingEntry[], options: ReadingSearchOptions = {}) {
    const columns = options.columns ?? [];
    const now = options.now ?? new Date();
    this.docs = pool.map((entry, index) => buildDoc(entry, index, columns, now));
  }

  /** Exposed for the test that proves quoted terms never touch Fuse. */
  get indexBuilt(): boolean {
    return this.fuse !== null;
  }

  filter(query: string | ReadingQuery): ReadingEntry[] {
    const parsed = typeof query === "string" ? parseReadingQuery(query) : query;
    if (parsed.isEmpty) return this.docs.map((doc) => doc.entry);
    return this.docs.filter((doc) => this.matchDoc(doc, parsed)).map((doc) => doc.entry);
  }

  matches(entry: ReadingEntry, query: string | ReadingQuery): boolean {
    const parsed = typeof query === "string" ? parseReadingQuery(query) : query;
    if (parsed.isEmpty) return true;
    const doc = this.docs.find((candidate) => candidate.entry === entry);
    return doc !== undefined && this.matchDoc(doc, parsed);
  }

  private matchDoc(doc: ReadingDoc, query: ReadingQuery): boolean {
    return query.groups.some((group) =>
      group.every((term) => {
        const hit = this.matchPositive(doc, term);
        return term.negated ? !hit : hit;
      }),
    );
  }

  private matchPositive(doc: ReadingDoc, term: ReadingTerm): boolean {
    switch (term.kind) {
      case "text": {
        const needle = norm(term.value);
        return needle === "" || doc.fields[term.field].includes(needle);
      }
      case "number": {
        const actual = numericValue(doc.entry, term.field);
        if (actual === undefined || !Number.isFinite(actual)) return false;
        return compare(actual, term.op, term.value);
      }
      case "flag": {
        if (term.field === "favorite") {
          return term.value === "yes" ? doc.entry.favorite === true : doc.entry.favorite !== true;
        }
        // `unit:` only means anything for a book; manga never match either way.
        if (!isBook(doc.entry)) return false;
        return doc.entry.progressUnit === term.value;
      }
      case "literal": {
        const needle = norm(term.value);
        if (needle === "") return true;
        if (doc.haystack.includes(needle)) return true;
        if (term.exact) return false;
        return this.fuzzyMatches(needle).has(doc.index);
      }
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

/** One-shot convenience; hold an engine when filtering the same pool repeatedly. */
export function searchReading(
  pool: readonly ReadingEntry[],
  query: string,
  options: ReadingSearchOptions = {},
): ReadingEntry[] {
  return new ReadingSearchEngine(pool, options).filter(query);
}
