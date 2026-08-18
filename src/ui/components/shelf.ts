/**
 * The poster shelf — a titled row of cards that scrolls sideways.
 *
 * This is a *layout*, not a second card implementation. It paints a heading and
 * a scroll track, and then hands every item straight to the injected card
 * factory (`buildTitleCard` in practice, via `cardRenderer(deps)`), so a card on
 * a shelf is byte-for-byte the card in the Library grid. The context, not the
 * component, decides what is interactive — see the header of
 * `ui/components/card.ts`.
 *
 * **On the class name.** The concept is a shelf, but `.wl-shelf` was already
 * taken: it is the *wrapping grid* of compact rows behind "Continue watching"
 * in `ui/tabs/dashboard.ts`, and one class must mean one component
 * (`tests/styles.test.ts`). A wrapping grid and a horizontal rail are not the
 * same box, so this one is `.wl-rail` and the old grid keeps its name untouched.
 *
 * Two things this has to get right, and both are easy to get wrong:
 *
 *   1. **It must not trap the page's vertical scroll.** The track is
 *      `overflow-y: hidden` with `overscroll-behavior-x: contain`, so a wheel
 *      gesture down the page passes straight through while a horizontal flick
 *      stops at the end of the row instead of scrolling the tab behind it.
 *   2. **Nothing on a shelf card may be truncated into nonsense.** A 110px card
 *      cannot carry the `full` variant's caption — measured in the live vault,
 *      its pills came out as `Pla…` and `Co…`, which occupy space *and* say
 *      nothing. So a shelf renders the `mini` variant, whose documented purpose
 *      is exactly this: poster, plus a title underneath, and no other field. The
 *      rule is "do not render what cannot fit", not "shrink it until it fits".
 *   3. **It must be reachable without a mouse.** The track is a focusable
 *      `role="group"` that answers Arrow keys, Home and End; every card inside
 *      it is already a `role="button"` with its own tab stop, so tabbing through
 *      a shelf scrolls it into view for free. No arrow buttons: they would be
 *      two dead tab stops per shelf repeating a key the track already answers,
 *      and horizontal scrolling is a gesture every pointer already has.
 *
 * Selection lives in `domains/shelves.ts` and is pure; nothing here decides
 * *what* is on a shelf.
 */
import type { CardContext, TitleV4 } from "../../types";
import type { CardFactory } from "../tabs/upcoming";

export interface ShelfOptions {
  /** Heading. Also the track's accessible name. */
  label: string;
  titles: readonly TitleV4[];
  /** `cardRenderer(deps)` — the shared card component, never a local one. */
  build: CardFactory;
  ctx: CardContext;
}

/** How far one Arrow-key press moves the row, as a fraction of what is visible. */
const NUDGE_FRACTION = 0.8;

/**
 * Paint one shelf, or nothing at all.
 *
 * Returns `null` for an empty list rather than an empty headed row: a heading
 * over a void reads as a bug. Callers that use `buildShelves` never hit this,
 * but a caller that filters its own list should not have to remember.
 */
export function renderShelfRow(parent: HTMLElement, options: ShelfOptions): HTMLElement | null {
  if (options.titles.length === 0) return null;

  const row = parent.createDiv({ cls: "wl-rail" });

  // The tab's own heading markup, deliberately: a shelf heading beside a panel
  // heading has to be the same heading, or the tab reads as two products.
  const head = row.createDiv({ cls: "wl-section-head" });
  head.createDiv({ cls: "wl-section-title", text: options.label });

  const track = row.createDiv({ cls: "wl-rail-track" });
  track.setAttr("role", "group");
  track.setAttr("tabindex", "0");
  const count = options.titles.length;
  track.setAttr(
    "aria-label",
    `${options.label} — ${count} title${count === 1 ? "" : "s"}. Use the left and right arrow keys to scroll.`,
  );

  for (const title of options.titles) {
    // Each card gets a wrapper rather than being sized directly.
    //
    // Two reasons, both about not reaching into a component this lane does not
    // own: the rail can set one width in one place whatever variant the factory
    // built, and the full title can live in a `title` attribute for the hover
    // tooltip. At 110px a long name cannot be shown in full anywhere on the
    // card, and the card's own `aria-label` already carries it for a screen
    // reader — this is the same courtesy for a pointer.
    const item = track.createDiv({ cls: "wl-rail-item" });
    item.setAttr("title", title.title);
    options.build(item, title, options.ctx);
  }

  const step = (): number => {
    const width = track.clientWidth || 0;
    // A row measured before layout (a hidden tab, or a headless harness) still
    // has to move *something*, or Arrow-right becomes a key that is swallowed
    // and does nothing.
    return Math.max(1, Math.round(width * NUDGE_FRACTION));
  };

  const scrollBy = (delta: number): void => {
    if (typeof track.scrollBy === "function") {
      track.scrollBy({ left: delta, behavior: "smooth" });
      return;
    }
    // No smooth-scroll API (old webview, or a headless harness): move the
    // offset directly rather than letting `undefined + delta` write a NaN.
    const current = typeof track.scrollLeft === "number" ? track.scrollLeft : 0;
    track.scrollLeft = current + delta;
  };

  /** Far enough to land at an end, whatever the box actually measures. */
  const span = (): number => Math.max(step(), track.scrollWidth || 0);

  track.addEventListener("keydown", (event: KeyboardEvent) => {
    let delta: number | null = null;
    if (event.key === "ArrowRight") delta = step();
    else if (event.key === "ArrowLeft") delta = -step();
    else if (event.key === "Home") delta = -span();
    else if (event.key === "End") delta = span();
    if (delta === null) return;
    // PageUp/PageDown and the arrow keys' vertical siblings are deliberately not
    // claimed: this row scrolls sideways, the page still scrolls down.
    event.preventDefault();
    scrollBy(delta);
  });

  return row;
}
