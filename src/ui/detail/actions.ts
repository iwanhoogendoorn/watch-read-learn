/**
 * "I watched it" and "no I didn't" — the two multi-field edits, written once.
 *
 * Both touch the rating and the review, which is exactly why they are not
 * allowed a copy each: the wizard already carried a second, divergent version
 * of the rating/review rules once, and that shipped as one star beside the word
 * "Good". Whatever a surface's chrome looks like, these two do the same thing.
 */
import type { App } from "obsidian";
import { STATUS_COMPLETED, STATUS_PLAN_TO_WATCH } from "../../constants";
import { isSingleSitting } from "../../data/review";
import type { TitlePatch, TitleV4 } from "../../types";
import { confirmAction } from "../modals/confirm";
import { openWatchedWizard } from "../modals/watched";
import type { DetailSurface } from "./surface";

/**
 * Ask the three things finishing something tells you, then write them.
 *
 * Only the fields the wizard actually returns are written: leaving the rating
 * alone in there must leave the rating alone here.
 */
export function askWatched(app: App, title: TitleV4, surface: DetailSurface): void {
  openWatchedWizard(app, {
    title,
    dateFormat: surface.store.settings.dateFormat,
    ratingTiers: surface.store.settings.ratingSystem,
    halfStars: surface.store.settings.halfStarRatings,
    reviews: surface.store.settings.reviews,
    onConfirm: (result) => {
      const patch: TitlePatch = { status: STATUS_COMPLETED };
      if (result.date) {
        patch.dateFinished = result.date;
        // A film's two dates are one date; a series keeps whatever start it
        // already had rather than being told it began the night it ended.
        if (isSingleSitting(title) || !title.dateStarted) patch.dateStarted = result.date;
      }
      if (result.rating > 0) patch.rating = result.rating;
      if (result.review !== "") patch.review = result.review;
      surface.patch(patch, "detail-watched");
    },
  });
}

/**
 * Put a title back to unwatched.
 *
 * "Watched" is four separate pieces of state — a status, two dates and a list
 * of ticked episodes — so undoing it by hand means four edits, one of which
 * (the episode list) has no obvious control at all. This does the lot.
 *
 * What it deliberately does not touch is the rating and the review. Those are
 * what you thought of it, and they remain true whether or not you are about to
 * watch it again; the confirm offers to clear them for the case where the entry
 * was a mistake.
 */
export function askUnwatch(app: App, title: TitleV4, surface: DetailSurface): void {
  const single = isSingleSitting(title);
  void confirmAction(app, {
    title: `Mark «${title.title}» as not watched?`,
    message: single
      ? "Clears the watched date and puts it back on the watchlist."
      : `Clears every ticked episode (${title.watchedEpisodes.length}), the dates, and puts it back on the watchlist.`,
    details: ["Your rating and review are kept unless you say otherwise."],
    confirmText: "Not watched",
    cancelText: "Keep it",
    checkbox: { label: "Also clear my rating and review", default: false },
  }).then((result) => {
    if (!result.confirmed) return;
    const patch: TitlePatch = {
      status: STATUS_PLAN_TO_WATCH,
      watchedEpisodes: [],
      dateFinished: null,
      ...(single ? { dateStarted: null } : {}),
    };
    // The two go together, because they are one judgement.
    if (result.checked) {
      patch.rating = 0;
      patch.review = "";
    }
    surface.patch(patch, "detail-unwatched");
  });
}

/**
 * "Delete this title", with the confirm that says what goes with it.
 *
 * `onDeleted` is how a surface closes itself afterwards — a modal calls
 * `close()`, a view detaches its leaf.
 */
export function askDelete(
  app: App,
  title: TitleV4,
  surface: DetailSurface,
  watchedCount: number,
  onDeleted: () => void,
): void {
  void confirmAction(app, {
    title: `Delete “${title.title}”?`,
    message: "It is removed from your library and from any groups it belongs to.",
    details:
      watchedCount > 0
        ? [`${watchedCount} watched episode(s) and its rating go with it.`]
        : undefined,
    confirmText: "Delete",
    danger: true,
  }).then((result) => {
    if (!result.confirmed) return;
    surface.store.deleteTitle(title.id);
    onDeleted();
  });
}
