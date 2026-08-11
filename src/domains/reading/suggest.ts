/**
 * Book suggestions.
 *
 * The film engine leans on TMDB's "people who liked this also liked", which
 * books have no equivalent of — Goodreads' API was shut in 2020 and Google
 * Books answers nothing without a key. What Open Library *does* have, keyless,
 * is subjects, and they are unusually specific: a hacking book comes back as
 * "Computer security", "Hackers", "Computer crimes" rather than "Computing".
 *
 * So the shape of the answer is different from the film one even though the
 * philosophy is the same:
 *
 *   - **Shared subjects are the consensus signal.** A book matching three of a
 *     seed's subjects is a neighbour; one matching a single broad subject is
 *     just on the same shelf, and the score says so.
 *   - **The same author is a strong, separate signal**, and it is named as such
 *     in the reason rather than being blended away.
 *   - **A ratings floor, not a ratings sort.** Open Library will happily report
 *     5.0 from a single vote. Below a handful of ratings a book is unrated, not
 *     brilliant, and it is scored as unknown rather than as either.
 *
 * Pure: the client calls belong to the caller, which is what makes the ranking
 * testable against fixed input.
 */
import type { Book, BookSuggestionHit, Manga } from "../../types";

export type ReadingSeed = Book | Manga;

/** One provider answer plus why it was fetched. */
export interface BookCandidate {
  hit: BookSuggestionHit;
  /** What produced it: the seed's subjects, or the seed's author. */
  source: "subject" | "author";
  seedName: string;
  /** 0–1, how much this seed's opinion is worth. */
  seedWeight: number;
  /** Subjects the seed and the candidate share, for scoring and the reason. */
  sharedSubjects?: string[];
}

export interface BookSuggestion {
  hit: BookSuggestionHit;
  score: number;
  reasons: string[];
}

export interface BookRankOptions {
  /** Titles already on the shelf, lowercased. Never suggested back. */
  ownedTitles?: ReadonlySet<string>;
  /** Open Library keys the user said no to. */
  dismissed?: ReadonlySet<string>;
  /** Below this a rating is noise rather than signal. */
  minRatings?: number;
  /**
   * How many books by one author may appear.
   *
   * Without a cap, a seed whose only usable signal is its author returns that
   * author's entire bibliography — six Hacking University editions is a
   * bibliography, not a recommendation. Two is enough to say "there is more by
   * this person" without the list becoming about them.
   */
  maxPerAuthor?: number;
  limit?: number;
}

/** Normalised for comparison: a shelf match must survive punctuation. */
export function bookKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * How much a book's opinion is worth as a seed. Mirrors the film rule: a
 * rating speaks loudest, finishing is a quieter yes, dropping is a no.
 */
export function readingSeedWeight(entry: ReadingSeed): number {
  const status = (entry.status ?? "").toLowerCase();
  if (status === "dropped") return 0;
  if (entry.rating > 0) return Math.max(0, Math.min(1, entry.rating / 5));
  if (status === "completed") return 0.7;
  if (status === "reading") return 0.6;
  return 0.35;
}

/** Seeds worth asking about, strongest first. */
export function pickReadingSeeds(entries: readonly ReadingSeed[], limit = 5): ReadingSeed[] {
  return entries
    .filter((entry) => entry.title.trim() !== "" && readingSeedWeight(entry) > 0.35)
    .map((entry) => ({ entry, weight: readingSeedWeight(entry) }))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return (b.entry.dateModified ?? "").localeCompare(a.entry.dateModified ?? "");
    })
    .slice(0, limit)
    .map((row) => row.entry);
}

/**
 * The subjects worth searching on.
 *
 * Open Library returns dozens, most of them useless for finding neighbours —
 * "Accessible book", "Protected DAISY" and friends are library metadata, not
 * topics. The broadest few are also the least useful: everything is "Fiction".
 */
const SUBJECT_NOISE = /^(accessible book|protected daisy|in library|overdrive|large type|ebook|open library)/i;

export function usefulSubjects(subjects: readonly string[], limit = 3): string[] {
  return subjects
    .map((subject) => subject.trim())
    .filter((subject) => subject !== "" && !SUBJECT_NOISE.test(subject))
    // Longer subjects are more specific: "Mobile computing" beats "Computers".
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

export function rankBookSuggestions(
  candidates: readonly BookCandidate[],
  options: BookRankOptions = {},
): BookSuggestion[] {
  const owned = options.ownedTitles ?? new Set<string>();
  const dismissed = options.dismissed ?? new Set<string>();
  const minRatings = options.minRatings ?? 3;

  interface Bucket {
    hit: BookSuggestionHit;
    score: number;
    subjects: Set<string>;
    authors: Set<string>;
    seeds: Set<string>;
  }
  const byKey = new Map<string, Bucket>();

  for (const candidate of candidates) {
    const { hit } = candidate;
    const key = bookKey(hit.title);
    if (key === "" || owned.has(key)) continue;
    if (hit.id && dismissed.has(hit.id)) continue;

    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { hit, score: 0, subjects: new Set(), authors: new Set(), seeds: new Set() };
      byKey.set(key, bucket);
    }
    bucket.seeds.add(candidate.seedName);

    if (candidate.source === "author") {
      bucket.authors.add(candidate.seedName);
      // A book by an author you rated is a strong, self-explanatory suggestion.
      bucket.score += 1.1 * candidate.seedWeight;
    } else {
      const shared = candidate.sharedSubjects ?? [];
      for (const subject of shared) bucket.subjects.add(subject);
      // One shared subject is a shelf; three is a neighbourhood.
      bucket.score += (0.45 + 0.35 * Math.max(0, shared.length - 1)) * candidate.seedWeight;
    }
    if (!bucket.hit.coverUrl && hit.coverUrl) bucket.hit = hit;
  }

  const out: BookSuggestion[] = [];
  for (const bucket of byKey.values()) {
    // A rating with too few votes is unknown, not good and not bad — scored
    // in the middle rather than allowed to win or lose the list.
    const rated = bucket.hit.ratingsCount >= minRatings;
    const quality = rated ? bucket.hit.ratingsAverage / 5 : 0.5;
    out.push({
      hit: bucket.hit,
      score: bucket.score * (0.7 + 0.3 * quality),
      reasons: bookReasons(bucket.authors, bucket.subjects, bucket.seeds),
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.hit.ratingsCount - a.hit.ratingsCount;
  });

  const capped = capPerAuthor(out, options.maxPerAuthor ?? 2);
  return options.limit === undefined ? capped : capped.slice(0, options.limit);
}

/**
 * Keep the best few from any one author, in score order.
 *
 * Applied after sorting so the ones that survive are that author's strongest,
 * and applied before the limit so the space freed goes to somebody else.
 */
export function capPerAuthor(
  suggestions: readonly BookSuggestion[],
  max: number,
): BookSuggestion[] {
  if (max <= 0) return [...suggestions];
  const seen = new Map<string, number>();
  const out: BookSuggestion[] = [];
  for (const suggestion of suggestions) {
    const author = (suggestion.hit.authors[0] ?? "").trim().toLowerCase();
    if (author === "") {
      out.push(suggestion);
      continue;
    }
    const count = seen.get(author) ?? 0;
    if (count >= max) continue;
    seen.set(author, count + 1);
    out.push(suggestion);
  }
  return out;
}

function bookReasons(
  authors: Set<string>,
  subjects: Set<string>,
  seeds: Set<string>,
): string[] {
  const reasons: string[] = [];
  const [author] = [...authors];
  if (author) reasons.push(`Same author as ${author}`);
  const topics = [...subjects].slice(0, 2);
  if (topics.length > 0) {
    reasons.push(`${topics.join(" · ")} — like ${[...seeds][0] ?? "your shelf"}`);
  } else if (!author) {
    const [seed] = [...seeds];
    if (seed) reasons.push(`Because you read ${seed}`);
  }
  return reasons;
}
