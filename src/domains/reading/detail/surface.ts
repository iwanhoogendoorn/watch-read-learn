/**
 * What a "reading detail surface" is — the book half of `ui/detail/surface.ts`.
 *
 * A book can now be looked at in two places, the modal (`modals/detail.ts`) and
 * the workspace view (`ui/views/book-detail.ts`), and the controls inside them
 * are the *same controls*: every section in `sections.ts` takes one of these and
 * neither surface is allowed its own copy of the rules. That is the same
 * discipline the title surfaces adopted, for the same reason — a second copy of
 * the rating/review rules is the defect that got reported four times.
 *
 * The contract is deliberately tiny: the two stores (the reading rows to write,
 * the plugin settings to read), the shelf being looked at, a write that
 * **repaints**, and a repaint on its own.
 *
 * ---------------------------------------------------------------------------
 * The bridge to `ui/detail/judgement.ts`
 * ---------------------------------------------------------------------------
 *
 * The rating and the review are **not** re-implemented here. `judgementBridge`
 * and `asJudged` exist so a book can be handed to `renderRatingField` and
 * `renderReviewField` — the plugin's only UI over `data/review.ts` — exactly as
 * a title is. A star click on a book therefore runs `syncedRatingPatch`, and a
 * review pick runs `syncedReviewPatch`, byte for byte the same functions.
 */
import type { App } from "obsidian";
import type {
  ReadingKind,
  ReadingPatch,
  TitlePatch,
  TitleV4,
  WatchLogStoreApi,
} from "../../../types";
import type { DetailSurface } from "../../../ui/detail/surface";
import type { ReadingEntry } from "../progress";
import type { ReadingStore } from "../store";
import { readingExtra } from "./extras";

export interface ReadingSurface {
  readonly app: App;
  /** The shelf. Every write goes through it, so unknown v3 keys survive. */
  readonly reading: ReadingStore;
  /** The plugin store — read for `settings` only (tiers, reviews, dates). */
  readonly watch: WatchLogStoreApi;
  readonly kind: ReadingKind;
  /** The row as it is *now*. Re-read per render; never captured across one. */
  entry(): ReadingEntry | undefined;
  /**
   * Write, then repaint.
   *
   * The repaint is not optional and not the caller's problem: a write nobody
   * can see is indistinguishable from no write, which is exactly what "rating
   * and review are not connected" looked like for three releases.
   */
  patch(patch: ReadingPatch, reason: string): void;
  /** Repaint after a write that went straight to the store. */
  refresh(): void;
}

/**
 * A `DetailSurface` over a reading surface, so the shared judgement controls
 * work unchanged.
 *
 * Only two fields ever arrive here — `rating` and `review` — because only two
 * are ever sent: `renderRatingField` emits `syncedRatingPatch`'s output and
 * `renderReviewField` emits `syncedReviewPatch`'s. Anything else would be a new
 * control in that module, and it would land in this translation as a compile
 * error rather than as a silently dropped write.
 */
export function judgementBridge(surface: ReadingSurface): DetailSurface {
  const write = (patch: TitlePatch, reason: string): void => {
    const next: Record<string, unknown> = {};
    if (patch.rating !== undefined) next.rating = patch.rating;
    // The review is a preserved extra key on a reading row — see `extras.ts`.
    if (patch.review !== undefined) next.review = patch.review;
    if (Object.keys(next).length === 0) return;
    surface.patch(next as ReadingPatch, reason);
  };
  return {
    store: surface.watch,
    patch: write,
    // Never reached from `judgement.ts`; present because the contract has it,
    // and immediate rather than dropped so a future caller cannot lose a write.
    debouncedPatch: (key, read) => write(read(), `detail-${key}`),
  };
}

/**
 * A reading row in the shape the judgement controls read.
 *
 * The cast is honest about what it is: `renderRatingField`, `renderReviewField`
 * and `renderCommunityRating` read exactly the six fields below and nothing
 * else, so this is the whole of the surface they touch. It is a *projection*,
 * never stored and never patched — every write goes back through
 * `judgementBridge`, which writes the reading row.
 */
export function asJudged(entry: ReadingEntry): TitleV4 {
  return {
    title: entry.title,
    rating: entry.rating,
    review: readingExtra(entry, "review"),
    communityRating: entry.communityRating ?? 0,
    communityVotes: entry.communityVotes ?? 0,
    communitySource: entry.communitySource ?? "",
  } as unknown as TitleV4;
}
