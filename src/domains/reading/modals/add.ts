/**
 * Add a book or a manga — **search first**, exactly like the Add-title modal.
 *
 * The difference from the movie/TV flow is that search here needs nothing at
 * all: Open Library is keyless, so the search box is live on a fresh install
 * with no settings touched. Google Books is offered *only* when a key is set,
 * because its keyless quota is literally zero (`report-media-apis.md` §2.2) and
 * a provider that always fails is worse than a provider that is not listed.
 *
 * Typing an ISBN is recognised and routed to the single-record lookup instead of
 * the search index — `/api/books` answers with page counts and publisher data
 * that `search.json` does not carry.
 *
 * Async discipline is the Add modal's: a generation counter guards every search,
 * so a slow answer for "dun" can never overwrite the results for "dune".
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type {
  Book,
  BookSearchResult,
  GoogleBooksClient,
  Manga,
  OpenLibraryClient,
  ReadingKind,
} from "../../../types";
import { describeBookError } from "../../../services/openlibrary";
import { renderPosterPlaceholder } from "../../../ui/components/posters";
import { CoverPool, loadCover } from "../covers";
import { renderDateInput } from "../../../ui/components/dates";
import {
  buildReadingEntry,
  findExistingReading,
  type NewEntrySeed,
  type ReadingStore,
} from "../store";
import type { ReadingEntry } from "../progress";

const SEARCH_DEBOUNCE_MS = 300;

/** 10 or 13 digits, optionally hyphenated, with an X check digit allowed. */
export function looksLikeIsbn(query: string): boolean {
  const clean = query.replace(/[\s-]/g, "");
  return /^(\d{9}[\dXx]|\d{13})$/.test(clean);
}

export interface ReadingAddOptions {
  store: ReadingStore;
  kind: ReadingKind;
  /** Keyless; always present in production. */
  openLibrary?: OpenLibraryClient;
  /** Only usable when the user has set a key. */
  googleBooks?: GoogleBooksClient;
  dateFormat: "european" | "american" | "iso";
  onAdded?: (entry: ReadingEntry, kind: ReadingKind) => void;
}

type Provider = "openlibrary" | "googlebooks";

export class AddReadingModal extends Modal {
  private options: ReadingAddOptions;
  private provider: Provider = "openlibrary";

  private resultsEl: HTMLElement | null = null;
  private manualEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;
  private manualOpen = false;
  private lastQuery = "";
  /** Object URLs for the covers on screen; released when the results change. */
  private readonly covers = new CoverPool();

  constructor(app: App, options: ReadingAddOptions) {
    super(app);
    this.options = options;
  }

  private get noun(): string {
    return this.options.kind === "book" ? "book" : "manga";
  }

  private get searchable(): boolean {
    return this.client() !== undefined;
  }

  private client(): OpenLibraryClient | GoogleBooksClient | undefined {
    if (this.provider === "googlebooks") {
      const google = this.options.googleBooks;
      return google?.configured() ? google : undefined;
    }
    const open = this.options.openLibrary;
    return open?.configured() ? open : undefined;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    // `wl-add-modal` on purpose: the search/results/manual chrome below is the
    // Add-title modal's markup, so it inherits the Add-title modal's styling
    // rather than growing a second copy of it in the reading partial.
    modalEl.addClass("wl-modal", "wl-add-modal", "wl-reading-add-modal");
    contentEl.empty();

    contentEl.createEl("h3", {
      cls: "wl-modal-title",
      text: this.options.kind === "book" ? "Add a book" : "Add a manga",
    });

    if (this.searchable) {
      this.renderProviderPicker(contentEl);
      this.renderSearch(contentEl);
    } else {
      this.renderNoSearchNotice(contentEl);
    }

    this.statusEl = contentEl.createDiv({ cls: "wl-add-status" });
    this.resultsEl = contentEl.createDiv({ cls: "wl-add-results" });
    this.manualEl = contentEl.createDiv({ cls: "wl-add-manual" });

    this.manualOpen = !this.searchable;
    this.renderManualToggle(contentEl);
    this.renderManual();
  }

  override onClose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    // An object URL pins its blob until it is revoked, and the modal can be
    // opened and closed all afternoon.
    this.covers.releaseAll();
    this.contentEl.empty();
  }

  // --- provider -----------------------------------------------------------

  /**
   * Only shown when there is a choice to make. With no Google key the picker is
   * absent rather than showing a disabled option nobody can use.
   */
  private renderProviderPicker(host: HTMLElement): void {
    if (this.options.googleBooks?.configured() !== true) {
      const note = host.createDiv({ cls: "wl-reading-provider" });
      note.createSpan({ cls: "wl-reading-provider-name", text: "Open Library" });
      note.createSpan({ cls: "wl-reading-provider-hint", text: "no key needed" });
      return;
    }

    const row = host.createDiv({ cls: "wl-reading-provider" });
    const make = (provider: Provider, label: string): void => {
      const button = row.createEl("button", {
        cls: "wl-btn wl-small-btn",
        text: label,
        attr: { type: "button" },
      });
      button.toggleClass("is-on", this.provider === provider);
      button.addEventListener("click", () => {
        if (this.provider === provider) return;
        this.provider = provider;
        for (const child of Array.from(row.children)) {
          if (child instanceof HTMLElement) child.toggleClass("is-on", child === button);
        }
        if (this.lastQuery.trim() !== "") void this.runSearch(this.lastQuery);
      });
    };
    make("openlibrary", "Open Library");
    make("googlebooks", "Google Books");
  }

  // --- search -------------------------------------------------------------

  private renderSearch(host: HTMLElement): void {
    const wrap = host.createDiv({ cls: "wl-searchbox wl-add-search" });
    const icon = wrap.createSpan({ cls: "wl-searchbox-icon" });
    setIcon(icon, "search");
    const input = wrap.createEl("input", {
      cls: "wl-searchbox-input",
      attr: {
        type: "search",
        placeholder: `Search by title, author or ISBN…`,
        "aria-label": `Search for a ${this.noun}`,
        spellcheck: "false",
      },
    });

    input.addEventListener("input", () => {
      this.lastQuery = input.value;
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.runSearch(input.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      void this.runSearch(input.value);
    });

    window.setTimeout(() => input.focus(), 0);
  }

  private renderNoSearchNotice(host: HTMLElement): void {
    const note = host.createDiv({ cls: "wl-add-notice" });
    const icon = note.createSpan({ cls: "wl-add-notice-icon" });
    setIcon(icon, "info");
    note.createSpan({
      text: "No book provider is available in this window, so search is off. Add it by hand below — nothing else is missing.",
    });
  }

  private setStatus(text: string, tone: "" | "error" = ""): void {
    const el = this.statusEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-hidden", text === "");
  }

  private async runSearch(query: string): Promise<void> {
    const client = this.client();
    const results = this.resultsEl;
    if (!client || !results) return;

    const trimmed = query.trim();
    const generation = ++this.searchGeneration;

    if (trimmed === "") {
      results.empty();
      this.setStatus("");
      return;
    }

    this.setStatus("Searching…");
    try {
      // An ISBN is a lookup, not a search — and the lookup answers with the page
      // count the search index leaves out.
      const hits = looksLikeIsbn(trimmed)
        ? [await client.byIsbn(trimmed)].filter((hit): hit is BookSearchResult => hit !== undefined)
        : await client.search(trimmed, 12);
      if (generation !== this.searchGeneration) return;
      this.renderResults(hits);
    } catch (error) {
      if (generation !== this.searchGeneration) return;
      results.empty();
      this.setStatus(describeBookError(error), "error");
    }
  }

  private renderResults(hits: BookSearchResult[]): void {
    const host = this.resultsEl;
    if (!host) return;
    // The previous results' covers go with them.
    this.covers.releaseAll();
    host.empty();

    if (hits.length === 0) {
      this.setStatus("Nothing found. Try fewer words, or add it by hand below.");
      return;
    }
    this.setStatus("");

    for (const hit of hits) {
      const existing = findExistingReading(this.options.store.reading, this.options.kind, hit.title);
      renderBookResult(host, hit, {
        openLibrary: this.options.openLibrary,
        covers: this.covers,
        tracked: existing !== undefined,
        onPick: () => {
          if (existing) {
            new Notice(`“${existing.title}” is already on this shelf.`);
            return;
          }
          this.commit(seedFromHit(hit, this.options.kind));
        },
      });
    }
  }

  // --- manual -------------------------------------------------------------

  private renderManualToggle(host: HTMLElement): void {
    if (!this.searchable) return;
    const toggle = host.createEl("button", {
      cls: "wl-link-btn wl-add-manual-toggle",
      text: this.manualOpen ? "Hide manual entry" : "Add it by hand instead",
      attr: { type: "button" },
    });
    toggle.addEventListener("click", () => {
      this.manualOpen = !this.manualOpen;
      toggle.setText(this.manualOpen ? "Hide manual entry" : "Add it by hand instead");
      this.renderManual();
    });
  }

  private renderManual(): void {
    const host = this.manualEl;
    if (!host) return;
    host.empty();
    host.toggleClass("is-hidden", !this.manualOpen);
    if (!this.manualOpen) return;

    const isBookShelf = this.options.kind === "book";
    const grid = host.createDiv({ cls: "wl-field-grid" });

    const titleInput = textField(grid, "Title");
    const titleMsg = grid.createDiv({ cls: "wl-field-msg" });
    const authorInput = textField(grid, "Author");
    const totalInput = numberField(grid, isBookShelf ? "Pages" : "Chapters");
    const secondInput = isBookShelf ? null : numberField(grid, "Volumes");

    const dateField = grid.createDiv({ cls: "wl-field" });
    dateField.createDiv({ cls: "wl-field-label", text: "Release date" });
    let releaseDate: string | null = null;
    renderDateInput(dateField, {
      format: this.options.dateFormat,
      label: "Release date",
      value: null,
      messageHost: dateField,
      onCommit: (value) => {
        releaseDate = value;
      },
    });

    const buttons = host.createDiv({ cls: "wl-modal-buttons" });
    const submit = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: isBookShelf ? "Add book" : "Add manga",
      attr: { type: "button" },
    });

    const commit = (): void => {
      const title = titleInput.value.trim();
      if (title === "") {
        titleMsg.setText(`A ${this.noun} needs a title.`);
        titleInput.focus();
        return;
      }
      const total = Math.max(0, Math.trunc(Number(totalInput.value) || 0));
      const seed: NewEntrySeed = { title, author: authorInput.value.trim(), releaseDate };
      if (isBookShelf) seed.totalPages = total;
      else {
        seed.totalChapters = total;
        seed.totalVolumes = Math.max(0, Math.trunc(Number(secondInput?.value) || 0));
      }
      this.commit(seed);
    };

    titleInput.addEventListener("input", () => titleMsg.setText(""));
    titleInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    submit.addEventListener("click", commit);
  }

  // --- commit -------------------------------------------------------------

  private commit(seed: NewEntrySeed): void {
    const { store, kind } = this.options;
    const existing = findExistingReading(store.reading, kind, seed.title);
    if (existing) {
      new Notice(`“${existing.title}” is already on this shelf.`);
      return;
    }
    const entry = buildReadingEntry(kind, store.nextId(kind, seed.title), seed, store.reading);
    if (kind === "book") store.addBook(entry as Book);
    else store.addManga(entry as Manga);
    new Notice(`Added “${entry.title}”`);
    this.options.onAdded?.(entry, kind);
    this.close();
  }
}

// ---------------------------------------------------------------------------
// Pure-ish helpers
// ---------------------------------------------------------------------------

/** A provider hit → the seed for a new row. */
export function seedFromHit(hit: BookSearchResult, kind: ReadingKind): NewEntrySeed {
  const seed: NewEntrySeed = {
    title: hit.title,
    author: hit.authors.join(", "),
    coverUrl: hit.coverUrl,
  };
  if (hit.firstPublishYear !== undefined) {
    // Only the year is trustworthy on either provider, so the release date is
    // pinned to 1 January rather than invented — a book published "2005" is not
    // published today.
    seed.releaseDate = `${hit.firstPublishYear}-01-01`;
  }
  if (kind === "book" && hit.pageCount !== undefined) seed.totalPages = hit.pageCount;
  if (kind === "book" && hit.source === "googlebooks") seed.googleBooksId = hit.id;
  if ((hit.categories ?? []).length > 0) seed.categories = [...(hit.categories ?? [])];
  return seed;
}

interface BookResultOptions {
  tracked: boolean;
  onPick: () => void;
  /** Fetches Open Library covers politely; absent means they are not fetched. */
  openLibrary?: OpenLibraryClient | undefined;
  /** Collects object URLs so a re-render can release them. */
  covers?: CoverPool | undefined;
}

/**
 * One book result row.
 *
 * Deliberately not `renderProviderResult`: that component's contract is an
 * `OverseerrSearchResult` (media type, vote average, TMDB poster), and forcing a
 * book through it would mean inventing three fields to throw them away again.
 */
export function renderBookResult(
  host: HTMLElement,
  hit: BookSearchResult,
  options: BookResultOptions,
): HTMLElement {
  const row = host.createDiv({ cls: "wl-add-result" });
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");

  const posterWrap = row.createDiv({ cls: "wl-add-result-poster" });
  const poster = posterWrap.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = hit.title;
  if (hit.coverUrl) {
    const img = poster.createEl("img", { cls: "wl-poster-img" });
    img.setAttribute("alt", "");
    img.setAttribute("decoding", "async");
    // Open Library covers go through the client — same User-Agent, same
    // limiter (W8 review P1-5). Without a client they are not fetched at all:
    // an unidentified burst is not a better answer than a placeholder.
    const handle = loadCover(img, hit.coverUrl, {
      client: options.openLibrary,
      onMissing: () => {
        img.remove();
        renderPosterPlaceholder(poster, hit.title);
      },
    });
    options.covers?.add(handle);
  } else {
    renderPosterPlaceholder(poster, hit.title);
  }

  const body = row.createDiv({ cls: "wl-add-result-body" });
  body.createDiv({ cls: "wl-add-result-title", text: hit.title });

  const meta: string[] = [];
  if (hit.authors.length > 0) meta.push(hit.authors.join(", "));
  if (hit.firstPublishYear) meta.push(String(hit.firstPublishYear));
  if (hit.pageCount) meta.push(`${hit.pageCount} pages`);
  meta.push(hit.source === "googlebooks" ? "Google Books" : "Open Library");
  body.createDiv({ cls: "wl-add-result-meta", text: meta.join(" · ") });
  if (hit.description) {
    body.createDiv({ cls: "wl-add-result-overview", text: hit.description });
  }

  if (options.tracked) {
    const flags = row.createDiv({ cls: "wl-add-result-flags" });
    flags.createSpan({ cls: "wl-flag is-tracked", text: "Already tracked" });
    row.addClass("is-disabled");
  }

  row.addEventListener("click", () => options.onPick());
  row.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    options.onPick();
  });

  return row;
}

function textField(grid: HTMLElement, label: string): HTMLInputElement {
  const field = grid.createDiv({ cls: "wl-field" });
  field.createDiv({ cls: "wl-field-label", text: label });
  return field.createEl("input", {
    cls: "wl-input",
    attr: { type: "text", "aria-label": label },
  });
}

function numberField(grid: HTMLElement, label: string): HTMLInputElement {
  const field = grid.createDiv({ cls: "wl-field" });
  field.createDiv({ cls: "wl-field-label", text: label });
  const input = field.createEl("input", {
    cls: "wl-input",
    attr: { type: "number", min: "0", step: "1", "aria-label": label },
  });
  input.value = "0";
  return input;
}
