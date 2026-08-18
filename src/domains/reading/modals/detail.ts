/**
 * The book/manga detail **modal** — the same screen as the workspace view, in a
 * box.
 *
 * Everything it draws comes from `../detail/sections.ts`, shared verbatim with
 * `ui/views/book-detail.ts`. This file decides *order and layout* and nothing
 * else: the status picker's derived-status rule, the unit switch that keeps both
 * counters, the categories picker, the file field and the rating/review binding
 * all live in the shared module, because two copies of a control are two places
 * for a write to go missing.
 *
 * Every field writes straight through to the store on commit, so there is no
 * Save button and no half-saved state to reason about.
 */
import { Modal, type App } from "obsidian";
import type {
  ReadingKind,
  ReadingPatch,
  WatchLogStoreApi,
} from "../../../types";
import type { CoverHandle } from "../covers";
import { type ReadingEntry } from "../progress";
import type { ReadingStore } from "../store";
import { renderReadingStatTiles } from "../detail/stats";
import type { ReadingSurface } from "../detail/surface";
import {
  renderAuthorLink,
  renderCategoriesField,
  renderCommunitySection,
  renderCustomColumns,
  renderDeleteButton,
  renderDescriptionField,
  renderFactFields,
  renderFactsLine,
  renderFileField,
  renderJudgementRow,
  renderMoreLikeThis,
  renderProgressSection,
  renderReadingCover,
  renderReadingDates,
  renderReadingNotesField,
  renderSynopsisProse,
  type ReadingDetailContext,
} from "../detail/sections";

export interface ReadingDetailOptions extends ReadingDetailContext {
  store: ReadingStore;
  /**
   * The plugin store, for `settings` only.
   *
   * The rating tiers, the half-star preference and the review labels are read
   * live from it rather than copied in: they are the *same* settings the film
   * surfaces read, which is what makes a book's stars and a film's stars the
   * same control rather than two that happen to look alike.
   */
  watch: WatchLogStoreApi;
  kind: ReadingKind;
  id: string;
  onChanged?: () => void;
}

export class ReadingDetailModal extends Modal implements ReadingSurface {
  private options: ReadingDetailOptions;
  /** Object URL of a proxied/fallback cover; released on re-render and close. */
  private cover: CoverHandle | null = null;

  constructor(app: App, options: ReadingDetailOptions) {
    super(app);
    this.options = options;
  }

  // --- ReadingSurface -------------------------------------------------------

  get reading(): ReadingStore {
    return this.options.store;
  }

  get watch(): WatchLogStoreApi {
    return this.options.watch;
  }

  get kind(): ReadingKind {
    return this.options.kind;
  }

  entry(): ReadingEntry | undefined {
    return this.options.store.getEntry(this.options.kind, this.options.id);
  }

  patch(patch: ReadingPatch, reason: string): void {
    this.options.store.update(this.options.kind, this.options.id, patch, reason);
    this.options.onChanged?.();
    this.render();
  }

  refresh(): void {
    this.render();
  }

  // --- lifecycle ------------------------------------------------------------

  override onOpen(): void {
    this.modalEl.addClass("wl-modal", "wl-reading-detail-modal");
    this.render();
  }

  override onClose(): void {
    this.cover?.release();
    this.cover = null;
    this.contentEl.empty();
  }

  /** The shared context, with the modal's own close-then-jump behaviour. */
  private context(): ReadingDetailContext {
    return {
      ...(this.options as ReadingDetailContext),
      onBeforeJump: () => this.close(),
      onOpenAuthor: this.options.onOpenAuthor
        ? (name: string): void => {
            // A leaf opening behind a modal is a leaf nobody can see.
            this.close();
            this.options.onOpenAuthor?.(name);
          }
        : undefined,
      onDeleted: () => {
        this.options.onDeleted?.();
        this.close();
      },
    };
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.cover?.release();
    this.cover = null;

    const entry = this.entry();
    if (!entry) {
      contentEl.createDiv({
        cls: "wl-empty-body",
        text: "That entry is no longer in your library.",
      });
      return;
    }

    const context = this.context();

    this.renderHead(contentEl, entry, context);
    renderReadingStatTiles(contentEl, entry);
    renderProgressSection(contentEl, entry, this);
    renderReadingDates(contentEl, entry, this, context);
    const fields = contentEl.createDiv({ cls: "wl-reading-detail-section" });
    renderFactFields(fields, entry, this);
    const extras = fields.createDiv({ cls: "wl-field-grid" });
    renderCategoriesField(extras, entry, this);
    renderFileField(extras, entry, this, this.app);
    renderDescriptionField(fields, entry, this);
    renderReadingNotesField(fields, entry, this);
    renderCustomColumns(contentEl, entry, this);
    renderMoreLikeThis(contentEl, entry, context);
    this.renderButtons(contentEl, entry, context);
  }

  private renderHead(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    const head = host.createDiv({ cls: "wl-reading-detail-head" });

    const coverWrap = head.createDiv({ cls: "wl-reading-cover" });
    this.cover = renderReadingCover(coverWrap, entry, context);

    const body = head.createDiv({ cls: "wl-reading-detail-body" });
    body.createEl("h3", { cls: "wl-modal-title", text: entry.title });
    renderAuthorLink(body, entry, context);
    renderFactsLine(body, entry);
    renderJudgementRow(body, entry, this);
    renderCommunitySection(body, entry, this, context);
    renderSynopsisProse(body, entry);
  }

  private renderButtons(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    const row = host.createDiv({ cls: "wl-modal-buttons" });

    if (this.options.onOpenNote) {
      const note = row.createEl("button", {
        cls: "wl-btn",
        text: "Open note",
        attr: { type: "button" },
      });
      note.addEventListener("click", () =>
        this.options.onOpenNote?.(entry, this.options.kind),
      );
    }

    if (entry.externalLink) {
      const link = row.createEl("button", {
        cls: "wl-btn",
        text: "Open link",
        attr: { type: "button" },
      });
      link.addEventListener("click", () => window.open(entry.externalLink, "_blank"));
    }

    renderDeleteButton(row, entry, this, context);

    const done = row.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Done",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => this.close());
  }
}
