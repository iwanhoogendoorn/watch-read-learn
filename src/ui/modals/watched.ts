/**
 * "Just watched it" — the three things you know at that moment, asked once.
 *
 * Marking something Completed used to set a status and nothing else: the date
 * stayed empty (or wrong), the rating was a separate trip to the stars, and the
 * review was a third field somewhere below. All three are known at exactly the
 * same moment — the moment you finish it — so they are asked together.
 *
 * Two deliberate touches:
 *
 *   - **The date defaults to today**, because that is the answer nine times in
 *     ten, and it is a real field rather than an assumption: change it and the
 *     backdated entry is just as easy.
 *   - **The rating proposes the review** (`data/review.ts`), which is what binds
 *     two fields that always meant the same thing. It only ever fills a review
 *     that is still empty — a proposal, never an overwrite.
 *
 * Cancelling changes nothing at all, including the status: a wizard you can
 * back out of is only trustworthy if backing out is complete.
 */
import { Modal, type App } from "obsidian";
import type { NamedColor, RatingTier, TitleV4 } from "../../types";
import { createStars } from "../components/stars";
import { renderDateInput } from "../components/dates";
import { reviewForRating } from "../../data/review";
import type { DateFormat } from "../../types";

export interface WatchedResult {
  /** `YYYY-MM-DD`; the caller decides which date fields it fills. */
  date: string | null;
  rating: number;
  review: string;
}

export interface WatchedOptions {
  title: TitleV4;
  dateFormat: DateFormat;
  ratingTiers: readonly RatingTier[];
  halfStars: boolean;
  reviews: readonly NamedColor[];
  /** Today, injectable so the default is testable. */
  now?: Date;
  onConfirm: (result: WatchedResult) => void;
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
  /** True once the user picks a review by hand; stops proposals overwriting it. */
  private reviewChosen = false;

  constructor(
    app: App,
    private readonly options: WatchedOptions,
  ) {
    super(app);
    const { title } = options;
    this.date = title.dateFinished ?? todayString(options.now ?? new Date());
    this.rating = title.rating;
    this.review = title.review;
    this.reviewChosen = title.review.trim() !== "";
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
    const ratingField = contentEl.createDiv({ cls: "wl-field" });
    ratingField.createDiv({ cls: "wl-field-label", text: "Rating" });
    const reviewSelectHost = contentEl.createDiv({ cls: "wl-field" });
    reviewSelectHost.createDiv({ cls: "wl-field-label", text: "Review" });
    const select = reviewSelectHost.createEl("select", { cls: "wl-input wl-select" });
    for (const name of ["", ...this.options.reviews.map((r) => r.name)]) {
      select.createEl("option", { text: name === "" ? "— none —" : name, value: name });
    }
    select.value = this.review;
    select.addEventListener("change", () => {
      this.review = select.value;
      // Once touched it is the user's answer, and a later rating must not
      // quietly replace it.
      this.reviewChosen = true;
    });

    createStars(ratingField, {
      value: this.rating,
      tiers: this.options.ratingTiers,
      allowHalf: this.options.halfStars,
      showTierLabel: true,
      ariaLabel: `Rating for ${this.options.title.title}`,
      onChange: (value) => {
        this.rating = value;
        if (this.reviewChosen) return;
        const proposed = reviewForRating(value, this.options.reviews);
        if (proposed !== "") {
          this.review = proposed;
          select.value = proposed;
        }
      },
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
      this.options.onConfirm({ date: this.date, rating: this.rating, review: this.review });
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
