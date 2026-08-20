/**
 * "Just watched it" — the things you know at that moment, asked once.
 *
 * Marking something Watched used to set a status and nothing else: the date
 * stayed empty (or wrong), the rating was a separate trip to the stars, and the
 * review was a third field somewhere below. They are all known at exactly the
 * same moment — the moment you finish it — so they are asked together, and
 * *where* you watched it is known then too and nowhere else afterwards.
 *
 * Three deliberate touches:
 *
 *   - **The date defaults to today**, because that is the answer nine times in
 *     ten, and it is a real field rather than an assumption: change it and the
 *     backdated entry is just as easy.
 *   - **The rating and the review are one judgement** (`data/review.ts`), so
 *     each control moves the other. Two fields that always meant the same
 *     thing should never be able to sit there contradicting each other.
 *   - **The venue is a suggestion, never an answer.** Plex gets pre-selected
 *     when the server says it has the file; everything else opens blank, and
 *     blank writes nothing at all.
 *
 * Cancelling changes nothing at all, including the status: a wizard you can
 * back out of is only trustworthy if backing out is complete.
 */
import { Modal, type App } from "obsidian";
import type { NamedColor, RatingTier, TitleV4 } from "../../types";
import { plexStateOf } from "../components/facets";
import { createStars } from "../components/stars";
import { renderDateInput } from "../components/dates";
import { syncedRatingPatch, syncedReviewPatch } from "../../data/review";
import type { DateFormat } from "../../types";

export interface WatchedResult {
  /** `YYYY-MM-DD`; the caller decides which date fields it fills. */
  date: string | null;
  rating: number;
  review: string;
  /** `""` means "did not say" and writes nothing, like a blank rating. */
  watchedVia: string;
}

export interface WatchedOptions {
  title: TitleV4;
  dateFormat: DateFormat;
  ratingTiers: readonly RatingTier[];
  halfStars: boolean;
  reviews: readonly NamedColor[];
  /** The venues on offer — `settings.watchedViaOptions`. */
  watchedViaOptions: readonly NamedColor[];
  /** Today, injectable so the default is testable. */
  now?: Date;
  onConfirm: (result: WatchedResult) => void;
}

/**
 * The venue the dropdown opens on — a suggestion, never a write.
 *
 * If the Plex cache says this title is sitting on the server, Plex is the
 * overwhelmingly likely answer, so it is pre-selected and one glance confirms
 * or changes it. Anything else opens blank, because the plugin does not know
 * and guessing would put a number on the Dashboard that nobody typed.
 *
 * The name has to still exist in the user's list: rename Plex to "Home server"
 * and the suggestion follows it; delete it and there is nothing to suggest.
 */
export function suggestedVenue(
  title: TitleV4,
  options: readonly NamedColor[],
): string {
  if (plexStateOf(title) !== "available") return "";
  return options.find((option) => option.name.trim().toLowerCase() === "plex")?.name ?? "";
}

/** `YYYY-MM-DD` for a local day — never `toISOString`, which is UTC. */
export function todayString(now: Date): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class WatchedModal extends Modal {
  private date: string | null;
  private rating: number;
  private review: string;
  private watchedVia: string;

  constructor(
    app: App,
    private readonly options: WatchedOptions,
  ) {
    super(app);
    const { title } = options;
    this.date = title.dateFinished ?? todayString(options.now ?? new Date());
    /*
     * Blank, not pre-filled from the title.
     *
     * This is a form about the viewing that just happened, so it should not
     * arrive with an opinion already in it — a pre-selected review reads as
     * "this is what you think", and one click on Mark watched makes it true.
     * Leaving either blank writes nothing (see the caller), so what is already
     * stored survives untouched.
     */
    this.rating = 0;
    this.review = "";
    /*
     * The one control that *does* arrive with something in it, and only when
     * the plugin genuinely knows: Plex told us the file is there. It is still
     * only a suggestion — nothing is written until Mark watched is pressed.
     */
    this.watchedVia = suggestedVenue(title, options.watchedViaOptions);
  }

  /** What the two controls currently say, as the shared rule wants it. */
  private judgement(): { rating: number; review: string } {
    return { rating: this.rating, review: this.review };
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-watched-modal");
    contentEl.empty();

    contentEl.createEl("h3", {
      cls: "wl-modal-title",
      text: `Finished «${this.options.title.title}»`,
    });
    contentEl.createDiv({
      cls: "wl-modal-message",
      text: "Everything you know right now, in one go. Change what is wrong and nothing else is touched.",
    });

    // --- when -------------------------------------------------------------
    const dateField = contentEl.createDiv({ cls: "wl-field" });
    dateField.createDiv({ cls: "wl-field-label", text: "Watched on" });
    renderDateInput(dateField, {
      format: this.options.dateFormat,
      label: "Watched on",
      value: this.date,
      messageHost: dateField,
      onCommit: (value) => {
        this.date = value;
      },
    });

    // --- how good ---------------------------------------------------------
    //
    // One judgement, two controls, and each drives the other — the same rule
    // the detail modal follows (`data/review.ts`). An earlier version here
    // only pushed one way and stopped entirely once the review had been
    // touched, which is exactly how you end up looking at one star next to
    // the word "Good".
    const ratingField = contentEl.createDiv({ cls: "wl-field" });
    ratingField.createDiv({ cls: "wl-field-label", text: "Rating" });
    const reviewSelectHost = contentEl.createDiv({ cls: "wl-field" });
    reviewSelectHost.createDiv({ cls: "wl-field-label", text: "Review" });
    const select = reviewSelectHost.createEl("select", { cls: "wl-input wl-select" });
    for (const name of ["", ...this.options.reviews.map((r) => r.name)]) {
      select.createEl("option", { text: name === "" ? "— none —" : name, value: name });
    }
    select.value = this.review;

    const stars = createStars(ratingField, {
      value: this.rating,
      tiers: this.options.ratingTiers,
      allowHalf: this.options.halfStars,
      showTierLabel: true,
      ariaLabel: `Rating for ${this.options.title.title}`,
      onChange: (value) => {
        const patch = syncedRatingPatch(this.judgement(), value, this.options.reviews);
        this.rating = patch.rating;
        if (patch.review !== undefined) {
          this.review = patch.review;
          select.value = patch.review;
        }
      },
    });

    select.addEventListener("change", () => {
      const patch = syncedReviewPatch(this.judgement(), select.value, this.options.reviews);
      this.review = patch.review;
      if (patch.rating !== undefined) {
        this.rating = patch.rating;
        stars.set(patch.rating);
      }
    });

    // --- where ------------------------------------------------------------
    //
    // Last of the four, and after the review select on purpose: this one is
    // optional and blank writes nothing, so it must never be the control that
    // greets you.
    const viaField = contentEl.createDiv({ cls: "wl-field" });
    viaField.createDiv({ cls: "wl-field-label", text: "Where did you watch it?" });
    const via = viaField.createEl("select", { cls: "wl-input wl-select" });
    via.setAttribute("aria-label", "Where did you watch it?");
    for (const name of ["", ...this.options.watchedViaOptions.map((v) => v.name)]) {
      via.createEl("option", { text: name === "" ? "— not recorded —" : name, value: name });
    }
    via.value = this.watchedVia;
    via.addEventListener("change", () => {
      this.watchedVia = via.value;
    });

    // --- out --------------------------------------------------------------
    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    const cancel = buttons.createEl("button", {
      cls: "wl-btn",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());

    const save = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Mark watched",
      attr: { type: "button" },
    });
    save.addEventListener("click", () => {
      this.options.onConfirm({
        date: this.date,
        rating: this.rating,
        review: this.review,
        watchedVia: this.watchedVia,
      });
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export function openWatchedWizard(app: App, options: WatchedOptions): void {
  new WatchedModal(app, options).open();
}
