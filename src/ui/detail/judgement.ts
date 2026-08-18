/**
 * Rating and review — **one implementation, two surfaces**.
 *
 * The pair is one judgement with two spellings, bound by `data/review.ts`.
 * That binding has been reported broken four separate times, and the last two
 * root causes were both duplication: the detail modal wrote without repainting,
 * and the "just watched it" wizard kept its own divergent copy of the rules.
 *
 * So there is exactly one place that turns a star click into a patch and one
 * place that turns a review pick into a patch, both of them here, both of them
 * going through `DetailSurface.patch` — which writes *and repaints*. A surface
 * that wants these controls calls these functions; it does not get to have an
 * opinion about what they do.
 */
import { setIcon } from "obsidian";
import type { TitleV4 } from "../../types";
import { syncedRatingPatch, syncedReviewPatch } from "../../data/review";
import { createStars, type StarsHandle } from "../components/stars";
import { renderSelectField } from "./fields";
import type { DetailSurface } from "./surface";

export interface RatingFieldOptions {
  /** "My rating" in the modal, "Your rating" in the view. */
  label?: string;
  /** Extra class on the row wrapper. */
  cls?: string;
}

export function renderRatingField(
  host: HTMLElement,
  title: TitleV4,
  surface: DetailSurface,
  options: RatingFieldOptions = {},
): StarsHandle {
  const row = host.createDiv({
    cls: `wl-detail-rating${options.cls ? ` ${options.cls}` : ""}`,
  });
  row.createSpan({ cls: "wl-field-label", text: options.label ?? "My rating" });
  return createStars(row, {
    value: title.rating,
    tiers: surface.store.settings.ratingSystem,
    allowHalf: surface.store.settings.halfStarRatings,
    showTierLabel: true,
    ariaLabel: `${title.title} rating`,
    onChange: (value) =>
      surface.patch(
        syncedRatingPatch(title, value, surface.store.settings.reviews),
        "detail-rating",
      ),
  });
}

export function renderReviewField(
  host: HTMLElement,
  title: TitleV4,
  surface: DetailSurface,
  cls?: string,
): HTMLSelectElement {
  return renderSelectField(host, {
    label: "Review",
    cls,
    values: ["", ...surface.store.settings.reviews.map((r) => r.name)],
    current: title.review,
    onChange: (value) =>
      surface.patch(
        syncedReviewPatch(title, value, surface.store.settings.reviews),
        "detail-review",
      ),
  });
}

/**
 * What everyone else thought — the other half of the judgement, and not the
 * user's.
 *
 * This is the modal's existing badge, moved rather than reinvented: it already
 * prints score, vote count *and* source, and `communitySource` here is
 * `"" | "imdb" | "tmdb" | "jikan" | "anilist"`, so naming it is the difference
 * between "8.4" and "8.4 from IMDb". Returns `null` when nothing has rated the
 * title, because a badge reading 0.0 is worse than no badge.
 */
export function renderCommunityRating(
  host: HTMLElement,
  title: TitleV4,
): HTMLElement | null {
  if (!(title.communityRating > 0)) return null;
  const community = host.createDiv({ cls: "wl-detail-community" });
  const icon = community.createSpan({ cls: "wl-detail-community-icon" });
  setIcon(icon, "users");
  const source = title.communitySource ? ` · ${title.communitySource}` : "";
  const votes = title.communityVotes > 0 ? ` (${title.communityVotes} votes)` : "";
  community.createSpan({
    text: `${title.communityRating.toFixed(1)}${votes}${source}`,
  });
  return community;
}
