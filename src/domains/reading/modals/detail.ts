/**
 * The book/manga detail modal — read it, edit it, delete it.
 *
 * Every field writes straight through to the store on commit, so there is no
 * Save button and no half-saved state to reason about. Two things are worth
 * knowing before changing anything here:
 *
 *   - **`To be released` is not in the status picker.** It is derived from the
 *     release date (v3 line 214), so offering it would let the user pick a state
 *     the next render silently overrules. The current derived status is shown
 *     above the picker instead, with the date that causes it.
 *   - **The unit switch keeps both counters.** Flipping a book from pages to
 *     words changes what is *counted*, never what was counted before — the page
 *     figures are still there when it flips back, and the fields for the inactive
 *     unit stay editable so a half-migrated book can be corrected.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type {
  Book,
  CustomColumn,
  DateFormat,
  GoogleBooksClient,
  Manga,
  OpenLibraryClient,
  ProgressUnit,
  RatingTier,
  ReadingKind,
  ReadingStatus,
} from "../../../types";
import { READING_STATUSES } from "../../../types";
import type { BookSuggestionHit } from "../../../types";
import type { BookSuggestion } from "../suggest";
import { readPdfPageCount } from "../pdfpages";
import { renderDateInput } from "../../../ui/components/dates";
import { renderPosterPlaceholder } from "../../../ui/components/posters";
import { createStars } from "../../../ui/components/stars";
import { sanitizeColor } from "../../../ui/components/pills";
import { confirmAction } from "../../../ui/modals/confirm";
import { columnDisplay, selectOptions, writeColumnValue } from "../columns";
import { coverIsbn, loadCover, type CoverHandle } from "../covers";
import { fetchCoverBytes } from "../coverfetch";
import {
  BOOK_FILE_EXTENSIONS,
  BookFileSuggestModal,
  importBookFile,
  openBookFile,
} from "../bookfile";
import {
  amazonUrl,
  availableCategories,
  communityRatingPatch,
  fetchBookRating,
  formatCommunityRating,
  googleBooksUrl,
  type RatableBook,
} from "../community";
import {
  bumpPatch,
  derivedStatus,
  isBook,
  isFutureRelease,
  primaryCounter,
  totalPatchFor,
  progressLabel,
  progressPatch,
  readingProgress,
  remainingLabel,
  statusPatch,
  unitPatch,
  volumeCounter,
  type ReadingEntry,
} from "../progress";
import type { ReadingStore } from "../store";

export interface ReadingDetailOptions {
  store: ReadingStore;
  kind: ReadingKind;
  id: string;
  dateFormat: DateFormat;
  ratingTiers: readonly RatingTier[];
  halfStars: boolean;
  /** Open the generated note; absent when note generation is off. */
  onOpenNote?: (entry: ReadingEntry, kind: ReadingKind) => void;
  onDeleted?: () => void;
  onChanged?: () => void;
  /**
   * Chip → filtered Reading tab, the same handoff the Library's modal makes —
   * and it must land on *this* tab, not the Library, or the query means nothing
   * (SPEC2 §"Surfaces that grow").
   */
  onJumpToQuery?: (query: string) => void;
  /** For polite Open Library cover loading; absent falls back politely too. */
  openLibrary?: OpenLibraryClient;
  /** For the public-rating fetch; absent (or unconfigured) explains itself. */
  googleBooks?: GoogleBooksClient;
  /**
   * "More like this" for the book being looked at. Absent means the section is
   * not drawn — which is the honest answer when there is nothing to ask.
   */
  onMoreLikeThis?: (entry: ReadingEntry) => Promise<BookSuggestion[]>;
  /** Add a suggested book to the shelf. */
  onAddSuggestion?: (hit: BookSuggestionHit) => Promise<boolean>;
  onDismissSuggestion?: (key: string) => void;
}

export class ReadingDetailModal extends Modal {
  private options: ReadingDetailOptions;
  /** Object URL of a proxied/fallback cover; released on re-render and close. */
  private cover: CoverHandle | null = null;

  constructor(app: App, options: ReadingDetailOptions) {
    super(app);
    this.options = options;
  }

  private entry(): ReadingEntry | undefined {
    return this.options.store.getEntry(this.options.kind, this.options.id);
  }

  private patch(patch: Parameters<ReadingStore["update"]>[2], reason?: string): void {
    this.options.store.update(this.options.kind, this.options.id, patch, reason);
    this.options.onChanged?.();
    this.render();
  }

  override onOpen(): void {
    this.modalEl.addClass("wl-modal", "wl-reading-detail-modal");
    this.render();
  }

  override onClose(): void {
    this.cover?.release();
    this.cover = null;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const entry = this.entry();
    if (!entry) {
      contentEl.createDiv({ cls: "wl-empty-body", text: "That entry is no longer in your library." });
      return;
    }

    this.renderHead(contentEl, entry);
    this.renderProgress(contentEl, entry);
    this.renderFields(contentEl, entry);
    this.renderCustomFields(contentEl, entry);
    this.renderMoreLikeThis(contentEl, entry);
    this.renderButtons(contentEl, entry);
  }

  // --- head ---------------------------------------------------------------

  private renderHead(host: HTMLElement, entry: ReadingEntry): void {
    const head = host.createDiv({ cls: "wl-reading-detail-head" });

    const coverWrap = head.createDiv({ cls: "wl-reading-cover" });
    const poster = coverWrap.createDiv({ cls: "wl-poster" });
    poster.dataset.posterSeed = entry.title;
    // Same loader as the table: Open Library through the polite client, a
    // Google-by-ISBN fallback when upstream has no image, placeholder last.
    this.cover?.release();
    this.cover = null;
    const cover = (entry.coverUrl ?? "").trim();
    const isbn = coverIsbn(entry);
    if ((cover === "" || cover === "none") && isbn === "") {
      renderPosterPlaceholder(poster, entry.title);
    } else {
      const img = poster.createEl("img", { cls: "wl-poster-img is-loaded" });
      img.setAttribute("alt", "");
      this.cover = loadCover(img, cover === "none" ? "" : cover, {
        client: this.options.openLibrary,
        fallbackIsbn: isbn,
        fetchBytes: fetchCoverBytes,
        onMissing: () => {
          img.remove();
          renderPosterPlaceholder(poster, entry.title);
        },
      });
    }

    const body = head.createDiv({ cls: "wl-reading-detail-body" });
    body.createEl("h3", { cls: "wl-modal-title", text: entry.title });
    if (entry.author) {
      const jump = this.options.onJumpToQuery;
      if (jump) {
        // A clickable author is the reading equivalent of a cast chip: it is the
        // one field you actually want to pivot on.
        const chip = body.createEl("button", {
          cls: "wl-reading-author wl-chip is-clickable",
          text: entry.author,
          attr: { type: "button", title: `Show everything by ${entry.author}` },
        });
        chip.addEventListener("click", () => {
          this.close();
          jump(`author:"${entry.author}"`);
        });
      } else {
        body.createDiv({ cls: "wl-reading-author", text: entry.author });
      }
    }

    const stars = body.createDiv({ cls: "wl-reading-detail-stars" });
    createStars(stars, {
      value: entry.rating,
      tiers: this.options.ratingTiers,
      allowHalf: this.options.halfStars,
      showTierLabel: true,
      ariaLabel: `Rating for ${entry.title}`,
      onChange: (value) => this.patch({ rating: value }, "reading-rating"),
    });
    this.renderCommunityRating(body, entry);

    const favorite = body.createEl("button", {
      cls: "wl-btn wl-small-btn wl-reading-fav",
      attr: { type: "button" },
    });
    favorite.toggleClass("is-on", entry.favorite === true);
    const favIcon = favorite.createSpan({ cls: "wl-btn-icon" });
    setIcon(favIcon, "heart");
    favorite.createSpan({
      cls: "wl-btn-label",
      text: entry.favorite ? "Favourite" : "Add to favourites",
    });
    favorite.addEventListener("click", () =>
      this.patch({ favorite: !entry.favorite }, "reading-favorite"),
    );
  }

  // --- progress -----------------------------------------------------------

  private renderProgress(host: HTMLElement, entry: ReadingEntry): void {
    const section = host.createDiv({ cls: "wl-reading-detail-section" });
    const counter = primaryCounter(entry);

    if (isBook(entry)) this.renderUnitSwitch(section, entry);

    const row = section.createDiv({ cls: "wl-reading-progress-row" });

    const minus = row.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": `One ${counter.noun} back`, title: `One ${counter.noun} back` },
    });
    setIcon(minus, "minus");
    minus.addEventListener("click", () => this.patch(bumpPatch(entry, -1), "reading-progress"));

    const readInput = row.createEl("input", {
      cls: "wl-input wl-reading-count",
      attr: {
        type: "number",
        min: "0",
        step: "1",
        "aria-label": `${counter.noun}s read`,
      },
    });
    readInput.value = String(counter.read);
    commitNumber(readInput, (value) => this.patch(progressPatch(entry, value), "reading-progress"));

    row.createSpan({ cls: "wl-reading-of", text: "of" });

    const totalInput = row.createEl("input", {
      cls: "wl-input wl-reading-count",
      attr: { type: "number", min: "0", step: "1", "aria-label": `total ${counter.noun}s` },
    });
    totalInput.value = String(counter.total);
    commitNumber(totalInput, (value) => this.patch(totalPatch(entry, value), "reading-total"));

    row.createSpan({ cls: "wl-reading-unit-label", text: counter.unit });

    const plus = row.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": `One more ${counter.noun}`, title: `One more ${counter.noun}` },
    });
    setIcon(plus, "plus");
    plus.addEventListener("click", () => this.patch(bumpPatch(entry, 1), "reading-progress"));

    // Manga's second axis, alongside the chapter counter rather than instead
    // of it — a shelf tracks volumes, a reader tracks chapters.
    if (!isBook(entry)) {
      const volumes = volumeCounter(entry);
      const volRow = section.createDiv({ cls: "wl-reading-progress-row" });
      volRow.createSpan({ cls: "wl-reading-unit-label", text: "volumes" });
      const readVol = volRow.createEl("input", {
        cls: "wl-input wl-reading-count",
        attr: { type: "number", min: "0", step: "1", "aria-label": "volumes read" },
      });
      readVol.value = String(volumes.read);
      commitNumber(readVol, (value) => this.patch({ volumesRead: value }, "reading-volumes"));
      volRow.createSpan({ cls: "wl-reading-of", text: "of" });
      const totalVol = volRow.createEl("input", {
        cls: "wl-input wl-reading-count",
        attr: { type: "number", min: "0", step: "1", "aria-label": "total volumes" },
      });
      totalVol.value = String(volumes.total);
      commitNumber(totalVol, (value) => this.patch({ totalVolumes: value }, "reading-volumes"));
    }

    const bar = section.createDiv({ cls: "wl-reading-bar" });
    const fill = bar.createDiv({ cls: "wl-reading-bar-fill" });
    fill.style.width = `${readingProgress(entry)}%`;

    const label = [progressLabel(entry), remainingLabel(entry)].filter(Boolean).join(" · ");
    section.createDiv({ cls: "wl-reading-progress-label", text: label || "Nothing counted yet" });
  }

  private renderUnitSwitch(host: HTMLElement, book: Book): void {
    const row = host.createDiv({ cls: "wl-reading-unit-switch" });
    row.createSpan({ cls: "wl-field-label", text: "Count in" });
    const make = (unit: ProgressUnit, label: string): void => {
      const button = row.createEl("button", {
        cls: "wl-btn wl-small-btn",
        text: label,
        attr: { type: "button" },
      });
      button.toggleClass("is-on", book.progressUnit === unit);
      button.addEventListener("click", () => {
        if (book.progressUnit === unit) return;
        this.patch(unitPatch(unit), "reading-unit");
      });
    };
    make("pages", "Pages");
    make("words", "Words");
    row.createSpan({
      cls: "wl-reading-hint",
      text: "Both counters are kept — 250 words counts as a page in your statistics.",
    });
  }

  // --- fields -------------------------------------------------------------

  private renderFields(host: HTMLElement, entry: ReadingEntry): void {
    const grid = host.createDiv({ cls: "wl-field-grid" });

    // Status. The derived value is shown, the picker offers only what can be
    // chosen — see the header.
    const statusField = grid.createDiv({ cls: "wl-field" });
    statusField.createDiv({ cls: "wl-field-label", text: "Status" });
    const derived = derivedStatus(entry);
    const select = statusField.createEl("select", { cls: "wl-select" });
    select.setAttribute("aria-label", "Status");
    for (const status of READING_STATUSES) {
      if (status === "To be released") continue;
      select.createEl("option", { value: status, text: status });
    }
    select.value = derived === "To be released" ? entry.status : derived;
    select.addEventListener("change", () =>
      this.patch(statusPatch(entry, select.value as ReadingStatus), "reading-status"),
    );
    if (isFutureRelease(entry.releaseDate)) {
      statusField.createDiv({
        cls: "wl-reading-hint",
        text: `Shown as “To be released” until ${entry.releaseDate}.`,
      });
    }

    textField(grid, "Author", entry.author ?? "", (value) =>
      this.patch({ author: value }, "reading-author"),
    );
    textField(grid, "Title", entry.title, (value) => {
      if (value.trim() === "") return;
      this.patch({ title: value.trim() }, "reading-title");
    });

    dateField(grid, "Started", entry.dateStarted, this.options.dateFormat, (value) =>
      this.patch({ dateStarted: value }, "reading-date"),
    );
    dateField(grid, "Finished", entry.dateFinished, this.options.dateFormat, (value) =>
      this.patch({ dateFinished: value }, "reading-date"),
    );
    dateField(grid, "Released", entry.releaseDate, this.options.dateFormat, (value) =>
      this.patch({ releaseDate: value }, "reading-date"),
    );

    this.renderCategoriesField(grid, entry);
    textField(grid, "Cover URL", entry.coverUrl ?? "", (value) =>
      this.patch({ coverUrl: value.trim() }, "reading-cover"),
    );
    textField(grid, "Link", entry.externalLink ?? "", (value) =>
      this.patch({ externalLink: value.trim() }, "reading-link"),
    );
    this.renderFileField(grid, entry);
    if (!isBook(entry)) {
      textField(grid, "MyAnimeList id", entry.malId ?? "", (value) =>
        this.patch({ malId: value.trim() }, "reading-malid"),
      );
    }
  }

  /**
   * The public's verdict, under the user's own stars (community.ts). One
   * line + a fetch/refresh affordance; without a Google Books key the button
   * says what is missing instead of pretending nothing exists.
   */
  private renderCommunityRating(body: HTMLElement, entry: ReadingEntry): void {
    const row = body.createDiv({ cls: "wl-reading-community" });
    const rating = entry.communityRating ?? 0;
    if (rating > 0) {
      row.createSpan({
        cls: "wl-reading-community-value",
        text: `★ ${formatCommunityRating(rating, entry.communityVotes ?? 0)}`,
      });
      row.createSpan({ cls: "wl-reading-community-source", text: "on Google" });
    } else if (entry.communityRatingLastFetched) {
      row.createSpan({
        cls: "wl-reading-community-source",
        text: "No public ratings on Google.",
      });
    }

    const google = this.options.googleBooks;
    const fetchButton = row.createEl("button", {
      cls: "wl-mini-btn",
      text: rating > 0 || entry.communityRatingLastFetched ? "Refresh" : "Fetch public rating",
      attr: { type: "button" },
    });
    fetchButton.addEventListener("click", () => {
      if (!google || !google.configured()) {
        new Notice("Set a Google Books API key in the plugin's settings first.");
        return;
      }
      fetchButton.disabled = true;
      void fetchBookRating(google, entry as RatableBook)
        .then((info) => {
          this.patch(communityRatingPatch(info, entry, new Date()), "reading-community-rating");
          if (!info.rated) new Notice("Google has no rated edition of this one.");
        })
        .catch((err: unknown) => {
          new Notice(`Rating fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          fetchButton.disabled = false;
        });
    });

    // The stores themselves, one click away — reviews live where no API does.
    const links = row.createDiv({ cls: "wl-reading-store-links" });
    const storeLink = (label: string, url: string): void => {
      const a = links.createEl("a", {
        cls: "wl-reading-store-link",
        text: label,
        attr: { href: url, target: "_blank", rel: "noopener" },
      });
      a.setAttribute("aria-label", `${entry.title} on ${label}`);
    };
    storeLink("Google Books", googleBooksUrl(entry as RatableBook));
    storeLink("Amazon", amazonUrl(entry as RatableBook));
  }

  /**
   * Categories as a picker, not a text field: the current ones are removable
   * chips, the dropdown offers everything known (built-in defaults, the
   * user's own additions, every value already on a shelf) minus what this
   * entry already has, and "New category…" keeps the free-text escape hatch —
   * a new name is remembered in settings so the next book can pick it.
   */
  private renderCategoriesField(grid: HTMLElement, entry: ReadingEntry): void {
    const field = grid.createDiv({ cls: "wl-field wl-reading-categories-field" });
    field.createDiv({ cls: "wl-field-label", text: "Categories" });

    const current = (entry.categories ?? []).map((c) => c.trim()).filter((c) => c !== "");
    const chips = field.createDiv({ cls: "wl-reading-category-chips" });
    for (const name of current) {
      const chip = chips.createEl("button", {
        cls: "wl-chip wl-reading-category-chip",
        attr: { type: "button", "aria-label": `Remove category ${name}`, title: "Remove" },
      });
      chip.createSpan({ text: name });
      chip.createSpan({ cls: "wl-reading-category-x", text: "×" });
      chip.addEventListener("click", () =>
        this.patch({ categories: current.filter((c) => c !== name) }, "reading-categories"),
      );
    }

    const add = (name: string): void => {
      const trimmed = name.trim();
      if (trimmed === "" || current.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
      // A name nobody has seen before joins the offered list for every next book.
      const settings = this.options.store.reading.settings;
      const known = availableCategories(settings.categoryOptions, []);
      if (!known.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
        settings.categoryOptions = [...(settings.categoryOptions ?? []), trimmed];
      }
      this.patch({ categories: [...current, trimmed] }, "reading-categories");
    };

    const reading = this.options.store.reading;
    const offered = availableCategories(reading.settings.categoryOptions, [
      ...reading.books,
      ...reading.manga,
    ]).filter((name) => !current.some((c) => c.toLowerCase() === name.toLowerCase()));

    const row = field.createDiv({ cls: "wl-reading-category-add" });
    const select = row.createEl("select", { cls: "wl-select" });
    select.setAttribute("aria-label", "Add category");
    select.createEl("option", { value: "", text: "Add category…" });
    for (const name of offered) select.createEl("option", { value: name, text: name });
    select.createEl("option", { value: "__new__", text: "New category…" });
    select.addEventListener("change", () => {
      const value = select.value;
      if (value === "") return;
      if (value === "__new__") {
        select.addClass("is-hidden");
        const input = row.createEl("input", {
          cls: "wl-input",
          attr: { type: "text", placeholder: "New category", "aria-label": "New category" },
        });
        input.focus();
        const commit = (): void => add(input.value);
        input.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") commit();
          // Esc backs out; the modal re-renders on the next patch anyway.
          if (event.key === "Escape") this.render();
        });
        input.addEventListener("blur", commit);
        return;
      }
      add(value);
    });
  }

  /**
   * The book file itself (bookfile.ts). Path field + three verbs: Open when a
   * file is linked, Browse over what the vault already holds, Import to copy
   * an epub/pdf in from outside and link it in one motion.
   */
  /**
   * Where an imported book lands: the reading folder when one is configured,
   * the vault root otherwise. Read live rather than captured, because the user
   * may have changed it since the modal opened.
   */
  private readingFolder(): string {
    return (this.options.store.reading.settings.defaultFolder ?? "").trim();
  }

  private renderFileField(grid: HTMLElement, entry: ReadingEntry): void {
    const field = grid.createDiv({ cls: "wl-field wl-reading-file-field" });
    field.createDiv({ cls: "wl-field-label", text: "File in vault" });
    const row = field.createDiv({ cls: "wl-reading-file-row" });

    const input = row.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "Books/Dune.epub", "aria-label": "Book file path" },
    });
    input.value = entry.filePath ?? "";
    input.addEventListener("change", () =>
      this.patch({ filePath: input.value.trim() }, "reading-file"),
    );

    /**
     * Link a file — and, when it is a PDF the book has no length for, take the
     * page count out of it there and then. The Reading tab does this on mount
     * anyway, but "I just attached the book and it still says no pages" is a
     * bad half-second to leave lying around.
     */
    const link = (path: string): void => {
      this.patch({ filePath: path }, "reading-file");
      if (primaryCounter(entry).total > 0 || !path.toLowerCase().endsWith(".pdf")) return;
      void readPdfPageCount(this.app.vault.adapter, path).then((pages) => {
        if (pages === null) return;
        this.patch(totalPatchFor(entry, pages), "reading-pages-from-file");
        new Notice(`${pages} pages, read from the file.`);
      });
    };

    if ((entry.filePath ?? "").trim() !== "") {
      const open = row.createEl("button", {
        cls: "wl-btn wl-icon-btn",
        attr: { type: "button", "aria-label": "Open the book", title: "Open the book" },
      });
      setIcon(open, "book-open");
      open.addEventListener("click", () =>
        openBookFile(this.app, (entry.filePath ?? "").trim(), entry.filePage),
      );
    }

    // Two ways to fill this in, and which one a person wants depends on where
    // the book already is. With nothing linked they are spelled out — an
    // unlabelled pair of icons is not an offer anyone can accept. Once a file
    // *is* linked the row is mostly the open button, so they shrink back to
    // icons rather than crowding it.
    const linked = (entry.filePath ?? "").trim() !== "";

    // With labels rather than icons the two buttons need a line of their own,
    // and they need to be *on it together* — left to wrap, each took a line
    // and the field became four rows tall in a half-width column.
    const actions = linked ? row : field.createDiv({ cls: "wl-reading-file-actions" });

    const browse = actions.createEl("button", {
      cls: linked ? "wl-btn wl-icon-btn" : "wl-btn",
      attr: {
        type: "button",
        "aria-label": "Pick a file already in the vault",
        title: "Pick a file already in the vault",
      },
    });
    if (linked) setIcon(browse, "folder-search");
    else browse.setText("Choose from vault");
    browse.addEventListener("click", () =>
      new BookFileSuggestModal(this.app, entry.title, link).open(),
    );

    const importButton = actions.createEl("button", {
      cls: linked ? "wl-btn wl-icon-btn" : "wl-btn mod-cta",
      attr: {
        type: "button",
        "aria-label": "Import a file from your computer",
        title: "Copy an epub or PDF from your computer into the vault",
      },
    });
    if (linked) setIcon(importButton, "file-down");
    else importButton.setText("Import from disk…");
    importButton.addEventListener("click", () =>
      importBookFile(this.app, this.readingFolder(), link),
    );

    if (!linked) {
      field.createDiv({
        cls: "wl-reading-hint",
        text: `Importing copies the file into ${this.readingFolder() || "your vault"} and links it here — the original is left where it is. ${BOOK_FILE_EXTENSIONS.map((e) => `.${e}`).join(", ")}`,
      });
    }

    // The bookmark the page-watcher keeps while the PDF is open.
    if ((entry.filePage ?? 0) > 1) {
      field.createDiv({
        cls: "wl-reading-hint",
        text: `Reopens at page ${entry.filePage}.`,
      });
    }
  }

  /**
   * "More like this", for a book.
   *
   * Same place and same shape as the film modal's, deliberately: the question
   * is identical and so should be the answer. The signals underneath are not —
   * subjects and authors rather than "people who liked this" — which is why
   * the reason line says what it matched on.
   */
  private renderMoreLikeThis(host: HTMLElement, entry: ReadingEntry): void {
    const fetch = this.options.onMoreLikeThis;
    if (!fetch) return;

    const section = host.createDiv({ cls: "wl-reading-detail-section wl-detail-more" });
    section.createDiv({ cls: "wl-reading-section-label", text: "More like this" });
    const list = section.createDiv({ cls: "wl-suggest-mini-list" });
    list.createDiv({ cls: "wl-suggest-empty", text: "Looking…" });

    void fetch(entry)
      .then((results) => {
        list.empty();
        if (results.length === 0) {
          list.createDiv({
            cls: "wl-suggest-empty",
            text: "Nothing to suggest from this one.",
          });
          return;
        }
        for (const suggestion of results.slice(0, 6)) this.renderMoreRow(list, suggestion);
      })
      .catch((err) => {
        list.empty();
        list.createDiv({
          cls: "wl-suggest-empty",
          text: `Could not ask Open Library — ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private renderMoreRow(parent: HTMLElement, suggestion: BookSuggestion): void {
    const { hit } = suggestion;
    const row = parent.createDiv({ cls: "wl-recent-row wl-suggest-mini" });

    const cover = row.createDiv({ cls: "wl-thumb" });
    if (hit.coverUrl) {
      const img = cover.createEl("img", { cls: "wl-thumb-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      // Open Library has a cover id for plenty of books it has no image for,
      // so a 404 here is routine. Falling back to the initial beats leaving
      // the browser's broken-image glyph in a list of book covers.
      img.addEventListener("error", () => {
        img.remove();
        renderPosterPlaceholder(cover, hit.title);
      });
      img.src = hit.coverUrl;
    } else {
      renderPosterPlaceholder(cover, hit.title);
    }

    const body = row.createDiv({ cls: "wl-recent-body" });
    const author = hit.authors[0] ?? "";
    body.createDiv({
      cls: "wl-recent-name",
      text: author ? `${hit.title} — ${author}` : hit.title,
    });
    const rating =
      hit.ratingsCount >= 3 ? `★ ${hit.ratingsAverage.toFixed(1)} (${hit.ratingsCount})` : "";
    body.createDiv({
      cls: "wl-recent-meta",
      text: [rating, suggestion.reasons[0] ?? ""].filter(Boolean).join(" · "),
    });

    const actions = row.createDiv({ cls: "wl-suggest-mini-actions" });
    if (this.options.onAddSuggestion) {
      const add = actions.createEl("button", {
        cls: "wl-mini-btn",
        text: "Add",
        attr: { type: "button", title: `Add ${hit.title} to your shelf` },
      });
      add.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        add.disabled = true;
        void this.options.onAddSuggestion?.(hit).then((ok) => {
          if (ok) {
            new Notice(`Added «${hit.title}».`);
            row.remove();
          } else {
            add.disabled = false;
          }
        });
      });
    }
    if (this.options.onDismissSuggestion) {
      const no = actions.createEl("button", {
        cls: "wl-icon-btn",
        attr: { type: "button", "aria-label": "Not interested", title: "Not interested" },
      });
      setIcon(no, "x");
      no.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        this.options.onDismissSuggestion?.(hit.id);
        row.remove();
      });
    }
  }

  private renderCustomFields(host: HTMLElement, entry: ReadingEntry): void {
    const columns: CustomColumn[] = this.options.store.columns(this.options.kind);
    if (columns.length === 0) return;

    const section = host.createDiv({ cls: "wl-reading-detail-section" });
    section.createDiv({ cls: "wl-field-label", text: "Your columns" });
    const grid = section.createDiv({ cls: "wl-field-grid" });

    const pool = this.options.kind === "book"
      ? this.options.store.allBooks()
      : this.options.store.allManga();

    for (const column of columns) {
      if (column.type === "select") {
        const field = grid.createDiv({ cls: "wl-field" });
        field.createDiv({ cls: "wl-field-label", text: column.name });
        const select = field.createEl("select", { cls: "wl-select" });
        select.setAttribute("aria-label", column.name);
        select.createEl("option", { value: "", text: "—" });
        for (const option of selectOptions(column, pool)) {
          select.createEl("option", { value: option, text: option });
        }
        select.value = columnDisplay(entry, column);
        select.addEventListener("change", () =>
          this.patch(
            { customFields: writeColumnValue(entry, column, select.value) },
            "reading-column",
          ),
        );
        continue;
      }

      const field = grid.createDiv({ cls: "wl-field" });
      field.createDiv({ cls: "wl-field-label", text: column.name });
      const input = field.createEl("input", {
        cls: "wl-input",
        attr: {
          type: column.type === "number" ? "number" : "text",
          "aria-label": column.name,
        },
      });
      input.value = columnDisplay(entry, column);
      const commit = (): void =>
        this.patch({ customFields: writeColumnValue(entry, column, input.value) }, "reading-column");
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      });
      const color = sanitizeColor(column.color ?? "");
      if (color) field.style.setProperty("--wl-column-color", color);
    }
  }

  // --- buttons ------------------------------------------------------------

  private renderButtons(host: HTMLElement, entry: ReadingEntry): void {
    const row = host.createDiv({ cls: "wl-modal-buttons" });

    if (this.options.onOpenNote) {
      const note = row.createEl("button", {
        cls: "wl-btn",
        text: "Open note",
        attr: { type: "button" },
      });
      note.addEventListener("click", () => this.options.onOpenNote?.(entry, this.options.kind));
    }

    if (entry.externalLink) {
      const link = row.createEl("button", {
        cls: "wl-btn",
        text: "Open link",
        attr: { type: "button" },
      });
      link.addEventListener("click", () => window.open(entry.externalLink, "_blank"));
    }

    const remove = row.createEl("button", {
      cls: "wl-btn mod-warning",
      text: "Delete",
      attr: { type: "button" },
    });
    remove.addEventListener("click", () => {
      void confirmAction(this.app, {
        title: `Delete “${entry.title}”?`,
        message: "It is removed from this shelf. Any note it generated stays in your vault.",
        confirmText: "Delete",
        danger: true,
      }).then((result) => {
        if (!result.confirmed) return;
        this.options.store.remove(this.options.kind, this.options.id);
        new Notice(`Removed “${entry.title}”`);
        this.options.onDeleted?.();
        this.close();
      });
    });

    const done = row.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Done",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => this.close());
  }
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** The patch for editing the *total*, which depends on the active unit. */
export function totalPatch(entry: ReadingEntry, value: number): Partial<Book & Manga> {
  const total = Math.max(0, Math.trunc(value));
  if (isBook(entry)) {
    return entry.progressUnit === "words" ? { totalWords: total } : { totalPages: total };
  }
  return { totalChapters: total };
}

function commitNumber(input: HTMLInputElement, onCommit: (value: number) => void): void {
  const commit = (): void => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.max(0, Math.trunc(parsed)));
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });
}

function textField(
  grid: HTMLElement,
  label: string,
  value: string,
  onCommit: (value: string) => void,
): void {
  const field = grid.createDiv({ cls: "wl-field" });
  field.createDiv({ cls: "wl-field-label", text: label });
  const input = field.createEl("input", {
    cls: "wl-input",
    attr: { type: "text", "aria-label": label },
  });
  input.value = value;
  const commit = (): void => {
    if (input.value === value) return;
    onCommit(input.value);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });
}

function dateField(
  grid: HTMLElement,
  label: string,
  value: string | null,
  format: DateFormat,
  onCommit: (value: string | null) => void,
): void {
  const field = grid.createDiv({ cls: "wl-field" });
  field.createDiv({ cls: "wl-field-label", text: label });
  renderDateInput(field, { format, label, value, messageHost: field, onCommit });
}
