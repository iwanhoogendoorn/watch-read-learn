/**
 * Suggestions, both directions.
 *
 * Two questions, one engine:
 *
 *   - **"What should I watch, given what I already like?"** Seeds come from the
 *     library — the things rated highly or actually finished — and each one is
 *     asked for its recommendations. What several seeds agree on rises.
 *   - **"I want a comedy like Ace Ventura."** Seeds come from the user's
 *     answers instead. Same aggregation, same scoring, different input.
 *
 * The scoring is deliberately simple and explainable, because a suggestion the
 * user cannot see the reason for is one they cannot trust or correct:
 *
 *   - **Consensus first.** A film recommended by three things you love beats
 *     one recommended by a single seed, whatever TMDB thinks of either.
 *   - **The seed's own weight.** A five-star seed speaks louder than one you
 *     merely finished. Something you dropped does not vote at all.
 *   - **Provenance.** A recommendation counts for more than a "similar" hit,
 *     which counts for more than a genre browse — in that order, because that
 *     is the order of how much human signal is behind them.
 *   - **A popularity floor, not a popularity ranking.** Vote count is used to
 *     discard the unverifiable, never to rank; otherwise every list is the
 *     same ten famous films.
 *
 * Everything here is pure. The clients are called by the caller, which is what
 * lets the whole ranking be tested against fixed inputs.
 */
import { STATUS_COMPLETED, STATUS_DROPPED, STATUS_WATCHING } from "../constants";
import type { OverseerrSearchResult, TitleV4 } from "../types";

/** Where a candidate came from. The order is the order of trust. */
export type SuggestionSource = "recommendation" | "similar" | "discover";

const SOURCE_WEIGHT: Record<SuggestionSource, number> = {
  recommendation: 1,
  similar: 0.55,
  discover: 0.4,
};

/** One provider answer, tagged with what produced it. */
export interface Candidate {
  result: OverseerrSearchResult;
  source: SuggestionSource;
  /** Human name of the thing that suggested it, for the "because" line. */
  seedName?: string;
  /** 0–1; how much this seed's opinion is worth. */
  seedWeight?: number;
}

export interface Suggestion {
  result: OverseerrSearchResult;
  score: number;
  /** Every reason, best first: "Because you watched Reacher", "Comedy". */
  reasons: string[];
  /** How many distinct seeds surfaced it — the consensus signal, for the UI. */
  seedCount: number;
}

export interface RankOptions {
  /** TMDB ids already in the library; never suggested back. */
  owned?: ReadonlySet<number>;
  /** TMDB ids the user said no to. Also never suggested. */
  dismissed?: ReadonlySet<number>;
  /** Below this many votes a title is unverifiable, not undiscovered. */
  minVotes?: number;
  /** 0–10. A floor, applied only when the candidate carries a rating at all. */
  minRating?: number;
  /** Release years, inclusive. */
  fromYear?: number;
  toYear?: number;
  limit?: number;
}

/**
 * How much a library title's opinion is worth as a seed.
 *
 * A rating the user gave is the strongest signal there is, so it dominates when
 * present. Without one, finishing something is a quieter yes. Dropping it is a
 * no — and a dropped show recommending more of the same is exactly the failure
 * that makes people turn recommendations off.
 */
export function seedWeightFor(title: TitleV4): number {
  // Case-insensitively, and against the constants rather than words spelled out
  // here: these are the same three semantic statuses every other surface keys
  // off, and a second spelling of them is how one surface ends up disagreeing.
  const status = (title.status ?? "").toLowerCase();
  const is = (name: string): boolean => status === name.toLowerCase();
  if (is(STATUS_DROPPED)) return 0;
  if (title.rating > 0) {
    // 5★ → 1.0, 4★ → 0.8, 3★ → 0.6. Below 3 the user is telling us something.
    return Math.max(0, Math.min(1, title.rating / 5));
  }
  if (is(STATUS_COMPLETED)) return 0.7;
  if (is(STATUS_WATCHING)) return 0.6;
  return 0.35;
}

/** Seeds worth asking about, strongest first. Never more than `limit`. */
export function pickSeeds(titles: readonly TitleV4[], limit = 8): TitleV4[] {
  return titles
    .filter((title) => title.tmdbId && seedWeightFor(title) > 0.35)
    .map((title) => ({ title, weight: seedWeightFor(title) }))
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      // Same weight: the more recently touched, so the list moves with use.
      return (b.title.dateModified ?? "").localeCompare(a.title.dateModified ?? "");
    })
    .slice(0, limit)
    .map((entry) => entry.title);
}

function yearOf(result: OverseerrSearchResult): number | null {
  if (result.year) return result.year;
  const date = result.releaseDate ?? "";
  const match = /^(\d{4})/.exec(date);
  return match ? Number(match[1]) : null;
}

/**
 * Merge every provider answer into one ranked list.
 *
 * Candidates for the same title are combined rather than deduplicated away:
 * three seeds recommending one film is the single most useful thing this
 * function knows, and it would be lost by keeping only the first hit.
 */
export function rankSuggestions(
  candidates: readonly Candidate[],
  options: RankOptions = {},
): Suggestion[] {
  const owned = options.owned ?? new Set<number>();
  const dismissed = options.dismissed ?? new Set<number>();
  const minVotes = options.minVotes ?? 50;
  const minRating = options.minRating ?? 0;

  interface Bucket {
    result: OverseerrSearchResult;
    score: number;
    seeds: Map<string, number>;
    sources: Set<SuggestionSource>;
  }
  const byId = new Map<number, Bucket>();

  for (const candidate of candidates) {
    const { result } = candidate;
    if (!result.tmdbId) continue;
    if (owned.has(result.tmdbId) || dismissed.has(result.tmdbId)) continue;
    if (result.voteCount < minVotes) continue;
    if (minRating > 0 && result.voteAverage > 0 && result.voteAverage < minRating) continue;

    const year = yearOf(result);
    if (options.fromYear !== undefined && (year === null || year < options.fromYear)) continue;
    if (options.toYear !== undefined && (year === null || year > options.toYear)) continue;

    const weight = candidate.seedWeight ?? 0.6;
    const contribution = SOURCE_WEIGHT[candidate.source] * weight;

    let bucket = byId.get(result.tmdbId);
    if (!bucket) {
      bucket = { result, score: 0, seeds: new Map(), sources: new Set() };
      byId.set(result.tmdbId, bucket);
    }
    bucket.sources.add(candidate.source);
    // A seed that turns up twice for the same title (recommendations *and*
    // similar) keeps its strongest contribution rather than voting twice.
    if (candidate.seedName) {
      const seen = bucket.seeds.get(candidate.seedName) ?? 0;
      if (contribution > seen) {
        bucket.score += contribution - seen;
        bucket.seeds.set(candidate.seedName, contribution);
      }
    } else {
      bucket.score += contribution;
    }
    // Prefer the richest copy of the metadata; providers vary by endpoint.
    if (result.posterUrl && !bucket.result.posterUrl) bucket.result = result;
  }

  const out: Suggestion[] = [];
  for (const bucket of byId.values()) {
    const seedNames = [...bucket.seeds.keys()];
    // Consensus is worth more than any single strong vote, so it is a
    // multiplier rather than another addend.
    const consensus = 1 + 0.35 * Math.max(0, seedNames.length - 1);
    const rating = bucket.result.voteAverage > 0 ? bucket.result.voteAverage / 10 : 0.5;
    out.push({
      result: bucket.result,
      score: bucket.score * consensus * (0.75 + 0.25 * rating),
      seedCount: seedNames.length,
      reasons: reasonsFor(seedNames, bucket.sources),
    });
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.result.voteAverage - a.result.voteAverage;
  });
  return options.limit === undefined ? out : out.slice(0, options.limit);
}

/** "Because you watched Reacher and 2 others" — plain, and never a lie. */
function reasonsFor(seedNames: string[], sources: Set<SuggestionSource>): string[] {
  const reasons: string[] = [];
  if (seedNames.length === 1) {
    reasons.push(`Because you watched ${seedNames[0]}`);
  } else if (seedNames.length === 2) {
    reasons.push(`Because you watched ${seedNames[0]} and ${seedNames[1]}`);
  } else if (seedNames.length > 2) {
    reasons.push(`Because you watched ${seedNames[0]} and ${seedNames.length - 1} others`);
  }
  if (seedNames.length === 0 && sources.has("discover")) reasons.push("Matches what you asked for");
  return reasons;
}
