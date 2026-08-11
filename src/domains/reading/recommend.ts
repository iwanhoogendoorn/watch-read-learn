/**
 * Fetching book suggestions — the impure half of `suggest.ts`.
 *
 * Kept apart from the ranking so the ranking stays testable without a network,
 * and apart from the reading store so the Reading tab does not learn what Open
 * Library is.
 *
 * The shape of a run: ask what the seed is about, search those subjects, search
 * the author, rank the two together. Subjects come from Open Library rather
 * than from the user's own categories on purpose — "Hacking" is a shelf label,
 * "Computer security AND Hackers AND Computer crimes" is a query.
 */
import type { Book, BookSuggestionHit, Manga, OpenLibraryClient } from "../../types";
import {
  bookKey,
  pickReadingSeeds,
  rankBookSuggestions,
  readingSeedWeight,
  usefulSubjects,
  type BookCandidate,
  type BookSuggestion,
  type ReadingSeed,
} from "./suggest";

export interface BookRecommendDeps {
  openLibrary: OpenLibraryClient;
  /** Everything on the shelf, so nothing owned is suggested back. */
  owned(): readonly ReadingSeed[];
  dismissed(): string[];
}

/** Candidates for one seed: its subjects, and its author. */
async function candidatesFor(
  deps: BookRecommendDeps,
  seed: ReadingSeed,
): Promise<BookCandidate[]> {
  const weight = readingSeedWeight(seed) || 1;
  const out: BookCandidate[] = [];

  let subjects: string[] = [];
  try {
    subjects = usefulSubjects(await deps.openLibrary.subjectsFor(seed.title, seed.author));
  } catch {
    subjects = [];
  }
  // Open Library has no subjects at all for plenty of recent or niche books —
  // five of six on a real shelf. The user's own categories are a worse signal
  // (a shelf label rather than a catalogue subject) but an infinitely better
  // one than nothing, and they are the topics that user actually thinks in.
  if (subjects.length === 0) {
    const own = (seed as { categories?: string[] }).categories ?? [];
    subjects = usefulSubjects(own, 2);
  }

  if (subjects.length > 0) {
    try {
      const hits = await deps.openLibrary.bySubjects(subjects, 20);
      for (const hit of hits) {
        out.push({
          hit,
          source: "subject",
          seedName: seed.title,
          seedWeight: weight,
          sharedSubjects: sharedWith(subjects, hit),
        });
      }
    } catch {
      // A subject search that fails leaves the author search to carry the seed.
    }
  }

  if (seed.author.trim() !== "") {
    try {
      const hits = await deps.openLibrary.byAuthor(seed.author, 10);
      for (const hit of hits) {
        out.push({ hit, source: "author", seedName: seed.title, seedWeight: weight });
      }
    } catch {
      /* same */
    }
  }
  return out;
}

/** Which of the seed's subjects this hit actually carries. */
function sharedWith(seedSubjects: readonly string[], hit: BookSuggestionHit): string[] {
  const have = new Set(hit.subjects.map((s) => s.toLowerCase()));
  const shared = seedSubjects.filter((s) => have.has(s.toLowerCase()));
  // Open Library's search matched on these subjects even when the doc's own
  // list is truncated, so an empty intersection still means one subject hit.
  return shared.length > 0 ? shared : seedSubjects.slice(0, 1);
}

function ownedKeys(deps: BookRecommendDeps): Set<string> {
  const keys = new Set<string>();
  for (const entry of deps.owned()) keys.add(bookKey(entry.title));
  return keys;
}

/** "More like this book" — one seed, both signals. */
export async function moreLikeBook(
  deps: BookRecommendDeps,
  seed: Book | Manga,
  limit = 8,
): Promise<BookSuggestion[]> {
  const candidates = await candidatesFor(deps, seed);
  return rankBookSuggestions(candidates, {
    ownedTitles: ownedKeys(deps),
    dismissed: new Set(deps.dismissed()),
    limit,
  });
}

/** "What should I read next?" — the whole shelf's strongest signals. */
export async function suggestFromShelf(
  deps: BookRecommendDeps,
  options: { limit?: number; seedLimit?: number } = {},
): Promise<{ suggestions: BookSuggestion[]; seeds: string[]; note: string }> {
  const seeds = pickReadingSeeds(deps.owned(), options.seedLimit ?? 4);
  if (seeds.length === 0) {
    return {
      suggestions: [],
      seeds: [],
      note: "Rate or finish a book and suggestions will build themselves from it.",
    };
  }
  // Sequential: Open Library's allowance is small and shared with covers, and
  // four seeds firing eight requests at once is how a plugin gets throttled.
  const candidates: BookCandidate[] = [];
  for (const seed of seeds) candidates.push(...(await candidatesFor(deps, seed)));

  const suggestions = rankBookSuggestions(candidates, {
    ownedTitles: ownedKeys(deps),
    dismissed: new Set(deps.dismissed()),
    limit: options.limit ?? 12,
  });
  return {
    suggestions,
    seeds: seeds.map((seed) => seed.title),
    note:
      suggestions.length === 0
        ? "Nothing new came back — everything suggested is already on your shelf."
        : "",
  };
}
