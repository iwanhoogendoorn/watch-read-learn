/**
 * The star-rating widget — foodspot's best single component, ported whole
 * (`report-foodspot.md` §4).
 *
 * Each star is two stacked Lucide `star` icons: an outline underneath and a
 * filled one clipped to `width: N%`, which is what buys **arbitrary fractional
 * fill** rather than only halves. On top of that:
 *   - hover repaints the whole widget as a preview, `mouseleave` restores;
 *   - clicking the value you already have clears it to 0;
 *   - full `role="slider"` semantics: arrows step, Home/End jump, Backspace clears;
 *   - the active rating tier drives `--wl-rating` and can print its label.
 *
 * The maths lives in exported pure functions so it can be tested without a DOM.
 */
import { setIcon } from "obsidian";
import type { RatingTier } from "../../types";
import { sanitizeColor } from "./pills";

export const MAX_STARS = 5;

/**
 * Which of the five configured tiers a rating falls in, or `null` when unrated.
 * `4.2` is still "tier 4" — the tier is the ceiling the rating has reached.
 */
export function tierIndex(rating: number): number | null {
  if (!(rating > 0)) return null;
  return Math.min(MAX_STARS, Math.max(1, Math.ceil(rating))) - 1;
}

export function tierFor(rating: number, tiers: readonly RatingTier[]): RatingTier | null {
  const index = tierIndex(rating);
  if (index === null) return null;
  return tiers[index] ?? null;
}

/** Fill percentage (0–100) for each of the five stars at a given rating. */
export function fillPercents(rating: number): number[] {
  const value = Math.min(MAX_STARS, Math.max(0, rating));
  const out: number[] = [];
  for (let i = 0; i < MAX_STARS; i += 1) {
    const fill = Math.min(1, Math.max(0, value - i));
    out.push(Math.round(fill * 100));
  }
  return out;
}

/**
 * Rating implied by a pointer at `clientX` over a star spanning `rect`.
 * Left half of star 3 is 2.5 when halves are enabled, 3 when they are not.
 */
export function ratingFromPointer(
  clientX: number,
  rect: { left: number; width: number },
  starIndex: number,
  allowHalf: boolean,
): number {
  if (!allowHalf) return starIndex + 1;
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 1;
  return ratio <= 0.5 ? starIndex + 0.5 : starIndex + 1;
}

/** Arrow/Home/End stepping for the slider role. */
export function stepRating(current: number, delta: number, allowHalf: boolean): number {
  const step = allowHalf ? 0.5 : 1;
  const next = current + delta * step;
  return Math.min(MAX_STARS, Math.max(0, Math.round(next / step) * step));
}

/** `4` → `"4"`, `4.5` → `"4.5"`, `0` → `"unrated"`. */
export function formatRating(rating: number): string {
  if (!(rating > 0)) return "unrated";
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

export interface StarsOptions {
  value: number;
  tiers: readonly RatingTier[];
  allowHalf: boolean;
  /** Omit for a display-only widget (cards, table cells). */
  onChange?: (value: number) => void;
  /** Print the tier word ("Great") next to the stars. */
  showTierLabel?: boolean;
  /**
   * Read-only widgets only: show this instead of five hollow stars when
   * unrated. Foodspot's compact rows taught the lesson — a row of empty
   * outlines reads as *content*, while "—" reads correctly as absence, and it
   * makes the rows that ARE rated stand out.
   */
  unratedPlaceholder?: string;
  ariaLabel?: string;
}

export interface StarsHandle {
  el: HTMLElement;
  set(value: number): void;
  destroy(): void;
}

export function createStars(parent: HTMLElement, options: StarsOptions): StarsHandle {
  const readOnly = options.onChange === undefined;
  const el = parent.createDiv({ cls: "wl-stars" });
  if (readOnly) el.addClass("is-readonly");
  const starsEl = el.createDiv({ cls: "wl-stars-row" });
  const labelEl = options.showTierLabel ? el.createSpan({ cls: "wl-stars-tier" }) : null;
  const unratedEl =
    readOnly && options.unratedPlaceholder !== undefined
      ? el.createSpan({ cls: "wl-stars-unrated", text: options.unratedPlaceholder })
      : null;

  let value = options.value;
  let preview: number | null = null;

  const stars: { fill: HTMLElement }[] = [];
  for (let i = 0; i < MAX_STARS; i += 1) {
    const star = starsEl.createSpan({ cls: "wl-star" });
    const bg = star.createSpan({ cls: "wl-star-bg" });
    setIcon(bg, "star");
    const fill = star.createSpan({ cls: "wl-star-fill" });
    setIcon(fill, "star");
    stars.push({ fill });

    if (!readOnly) {
      star.addEventListener("mousemove", (event: MouseEvent) => {
        const rect = star.getBoundingClientRect();
        preview = ratingFromPointer(event.clientX, rect, i, options.allowHalf);
        el.addClass("is-previewing");
        paint();
      });
      star.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = star.getBoundingClientRect();
        const picked = ratingFromPointer(event.clientX, rect, i, options.allowHalf);
        // Clicking the committed value clears it — the only way back to unrated.
        commit(picked === value ? 0 : picked);
      });
    }
  }

  function paint(): void {
    const shown = preview ?? value;
    const percents = fillPercents(shown);
    for (let i = 0; i < stars.length; i += 1) {
      const star = stars[i];
      if (star) star.fill.style.width = `${percents[i] ?? 0}%`;
    }
    const tier = tierFor(shown, options.tiers);
    // Colour comes from the user's tier palette, injected — never hardcoded, and
    // never trusted: `ratingSystem[].color` is user data (and survives an
    // import), so it goes through the same hex sanitiser the pills use before it
    // reaches a style attribute. A malformed value simply falls back to the theme.
    const color = tier ? sanitizeColor(tier.color) : "";
    if (color) el.style.setProperty("--wl-rating", color);
    else el.style.removeProperty("--wl-rating");
    el.toggleClass("has-rating", shown > 0);
    if (unratedEl) el.toggleClass("is-unrated", !(shown > 0));
    if (labelEl) labelEl.setText(tier?.label ?? "");
    el.setAttribute("aria-valuenow", String(shown));
    el.setAttribute(
      "aria-valuetext",
      tier ? `${formatRating(shown)} of 5 — ${tier.label}` : "unrated",
    );
  }

  function commit(next: number): void {
    value = Math.min(MAX_STARS, Math.max(0, next));
    preview = null;
    el.removeClass("is-previewing");
    paint();
    options.onChange?.(value);
  }

  if (readOnly) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", options.ariaLabel ?? "Rating");
  } else {
    el.setAttribute("role", "slider");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", options.ariaLabel ?? "Rating");
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", String(MAX_STARS));

    el.addEventListener("mouseleave", () => {
      preview = null;
      el.removeClass("is-previewing");
      paint();
    });

    el.addEventListener("keydown", (event: KeyboardEvent) => {
      let handled = true;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowUp":
          commit(stepRating(value, 1, options.allowHalf));
          break;
        case "ArrowLeft":
        case "ArrowDown":
          commit(stepRating(value, -1, options.allowHalf));
          break;
        case "Home":
          commit(0);
          break;
        case "End":
          commit(MAX_STARS);
          break;
        case "Backspace":
        case "Delete":
          commit(0);
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  paint();

  return {
    el,
    set(next: number): void {
      value = next;
      preview = null;
      paint();
    },
    destroy(): void {
      el.remove();
    },
  };
}
