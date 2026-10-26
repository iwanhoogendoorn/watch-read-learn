/**
 * What "I watched it" writes, as a pure function.
 *
 * The wizard (`ui/detail/actions.ts`) and the local HTTP API both mark titles
 * watched, and they must write exactly the same thing: a second copy of these
 * rules is how the rating/review binding drifted apart once already. So the
 * rules live here, and both callers hand over what they were told.
 */
import { STATUS_COMPLETED } from "../constants";
import type { TitlePatch, TitleV4 } from "../types";
import { isSingleSitting } from "./review";

/** What finishing something tells you — the wizard's answers, or an API body. */
export interface WatchedAnswers {
  /** `YYYY-MM-DD`, or `null` to leave both dates alone. */
  date: string | null;
  /** `0` means "did not say" and writes nothing. */
  rating: number;
  /** `""` means "did not say" and writes nothing. */
  review: string;
  /** `""` means "did not say" and writes nothing. */
  watchedVia: string;
}

/**
 * The patch that marks `title` watched.
 *
 * Only the fields actually answered are written: leaving the rating — or the
 * venue — blank must leave the stored one alone.
 */
export function watchedPatch(title: TitleV4, result: WatchedAnswers): TitlePatch {
  const patch: TitlePatch = { status: STATUS_COMPLETED };
  if (result.date) {
    patch.dateFinished = result.date;
    // A film's two dates are one date; a series keeps whatever start it
    // already had rather than being told it began the night it ended.
    if (isSingleSitting(title) || !title.dateStarted) patch.dateStarted = result.date;
  }
  if (result.rating > 0) patch.rating = result.rating;
  if (result.review !== "") patch.review = result.review;
  // A venue nobody picked is not a venue. The Plex pre-selection only becomes
  // a write because the user pressed Mark watched with it showing.
  if (result.watchedVia !== "") patch.watchedVia = result.watchedVia;
  return patch;
}
