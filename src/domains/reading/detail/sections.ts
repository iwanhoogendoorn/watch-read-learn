/**
 * Every control a book's detail is made of — **one implementation, two surfaces**.
 *
 * The modal (`modals/detail.ts`) and the workspace view (`ui/views/book-detail.ts`)
 * differ only in *layout*: the modal is a stacked column in a narrow box, the
 * view puts the cover beside the facts and spends the width a leaf has. What a
 * control **does** is decided here, once, and neither surface gets an opinion
 * about it. Two copies of a control are two places for a write to go missing,
 * which is the bug this module exists to make impossible.
 *
 * Two things nothing in here is allowed to reinvent:
 *
 *   - **the rating/review binding.** `renderJudgementRow` hands the book to
 *     `ui/detail/judgement.ts` — the plugin's only UI over `data/review.ts` —
 *     through the bridge in `surface.ts`. There is no book-specific mapping.
 *   - **the progress arithmetic.** Every counter, patch and percentage comes
 *     from `progress.ts`; nothing here does maths on `pagesRead`.
 */
import { Notice, setIcon, type App } from "obsidian";
import type {
  BookSuggestionHit,
  CustomColumn,
  DateFormat,
  GoogleBooksClient,
  OpenLibraryClient,
  ProgressUnit,
  ReadingKind,
  ReadingPatch,
  ReadingStatus,
} from "../../../types";
import { READING_STATUSES } from "../../../types";
import { renderDateField, iconTextButton } from "../../../ui/detail/fields";
import { renderRatingField, renderReviewField } from "../../../ui/detail/judgement";
import { renderPosterPlaceholder } from "../../../ui/components/posters";
import { sanitizeColor } from "../../../ui/components/pills";
import { confirmAction } from "../../../ui/modals/confirm";
import { columnDisplay, selectOptions, writeColumnValue } from "../columns";
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
import { coverIsbn, loadCover, type CoverCache, type CoverHandle } from "../covers";
import { fetchCoverBytes } from "../coverfetch";
import { readPdfPageCount } from "../pdfpages";
import {
  bumpPatch,
  derivedStatus,
  isBook,
  isFutureRelease,
  primaryCounter,
  progressLabel,
  progressPatch,
  readingProgress,
  remainingLabel,
  statusPatch,
  totalPatchFor,
  unitPatch,
  volumeCounter,
  type ReadingEntry,
} from "../progress";
import type { BookSuggestion } from "../suggest";
import { extraPatch, readingExtra } from "./extras";
import { asJudged, judgementBridge, type ReadingSurface } from "./surface";

/**
 * The optional halves of a detail surface: clients that may not be configured
 * and callbacks a host may not offer. Absent is always a real answer — a
 * section that cannot work is not drawn rather than drawn broken.
 */
export interface ReadingDetailContext {
  /** Polite Open Library cover loading; absent falls back politely too. */
  openLibrary?: OpenLibraryClient;
  /** For the public-rating fetch; absent (or unconfigured) explains itself. */
  googleBooks?: GoogleBooksClient;
  /** Local artwork cache; absent (the default) is the uncached path. */
  imageCache?: CoverCache;
  /** Open the generated note; absent when note generation is off. */
  onOpenNote?: (entry: ReadingEntry, kind: ReadingKind) => void;
  /**
   * Chip → filtered Reading tab. It must land on *that* tab, not the Library,
   * or the query means nothing (SPEC2 §"Surfaces that grow").
   */
  onJumpToQuery?: (query: string) => void;
  /**
   * **Seam for the author screen.** Absent — today's behaviour — means an
   * author name filters the Reading tab, exactly as it always has. Supplied, a
   * plain click opens the author and Alt-click still filters, which is the same
   * two-destination rule `ui/detail/people.ts` gives a cast name.
   */
  onOpenAuthor?: (name: string) => void;
  /** A surface that has to get out of the way before a jump — the modal closes. */
  onBeforeJump?: () => void;
  /** "More like this"; absent means the section is not drawn. */
  onMoreLikeThis?: (entry: ReadingEntry) => Promise<BookSuggestion[]>;
  onAddSuggestion?: (hit: BookSuggestionHit) => Promise<boolean>;
  onDismissSuggestion?: (key: string) => void;
  /** The surface closes itself after a delete: a modal closes, a leaf detaches. */
  onDeleted?: () => void;
  /** Injectable clock, so "Today" is testable. */
  now?: () => Date;
}

function clockOf(context: ReadingDetailContext): () => Date {
  return context.now ?? ((): Date => new Date());
}

function dateFormatOf(surface: ReadingSurface): DateFormat {
  return surface.watch.settings.dateFormat as DateFormat;
}

// ---------------------------------------------------------------------------
// Small shared controls
// ---------------------------------------------------------------------------

/**
 * A text field that commits on blur and on Enter — **never per keystroke**.
 *
 * Both surfaces repaint on every write, so a per-keystroke commit would rebuild
 * the field under the caret. Committing on the way out means the repaint always
 * lands on a field nobody is typing in.
 */
export function readingTextField(
  host: HTMLElement,
  label: string,
  value: string,
  onCommit: (value: string) => void,
  cls?: string,
): HTMLElement {
  const field = host.createDiv({ cls: `wl-field${cls ? ` ${cls}` : ""}` });
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
  return field;
}

/** The same, as a textarea: synopsis and notes are paragraphs, not lines. */
export function readingTextArea(
  host: HTMLElement,
  label: string,
  value: string,
  placeholder: string,
  onCommit: (value: string) => void,
  cls?: string,
): HTMLElement {
  const section = host.createDiv({
    cls: `wl-field wl-bdv-textblock${cls ? ` ${cls}` : ""}`,
  });
  section.createDiv({ cls: "wl-field-label", text: label });
  const area = section.createEl("textarea", {
    cls: "wl-textarea",
    attr: { rows: "4", placeholder },
  });
  area.setAttribute("aria-label", label);
  area.value = value;
  area.addEventListener("change", () => {
    if (area.value === value) return;
    onCommit(area.value);
  });
  return section;
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

/** The release year, or `null` — a book's year is its release date's year. */
export function readingYear(entry: ReadingEntry): number | null {
  const year = Number.parseInt((entry.releaseDate ?? "").slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

/**
 * The cover, through the same loader as the table: Open Library via the polite
 * client, a Google-by-ISBN fallback when upstream has no image, placeholder
 * last. Returns the handle so the surface can release the object URL — a
 * surface that drops it pins one blob per repaint.
 */
export function renderReadingCover(
  host: HTMLElement,
  entry: ReadingEntry,
  context: ReadingDetailContext,
): CoverHandle | null {
  const poster = host.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = entry.title;

  const cover = (entry.coverUrl ?? "").trim();
  const isbn = coverIsbn(entry);
  if ((cover === "" || cover === "none") && isbn === "") {
    renderPosterPlaceholder(poster, entry.title);
    return null;
  }

  const img = poster.createEl("img", { cls: "wl-poster-img is-loaded" });
  img.setAttribute("alt", "");
  return loadCover(img, cover === "none" ? "" : cover, {
    client: context.openLibrary,
    fallbackIsbn: isbn,
    fetchBytes: fetchCoverBytes,
    cache: context.imageCache,
    cacheId: entry.id,
    onMissing: () => {
      img.remove();
      renderPosterPlaceholder(poster, entry.title);
    },
  });
}

// ---------------------------------------------------------------------------
// The author, and the seam to the author screen
// ---------------------------------------------------------------------------

/**
 * The author as a way *into* them, not only a way to filter by them.
 *
 * Same two-destination rule as a cast name (`ui/detail/people.ts`): a plain
 * click opens the author screen when one is reachable, Alt-click filters the
 * shelf, and with no opener at all it degrades to the filter it has always
 * been. Draws nothing when the book has no author.
 */
export function renderAuthorLink(
  host: HTMLElement,
  entry: ReadingEntry,
  context: ReadingDetailContext,
): HTMLElement | null {
  const name = (entry.author ?? "").trim();
  if (name === "") return null;

  const open = context.onOpenAuthor;
  const jump = context.onJumpToQuery;
  if (!open && !jump) return host.createDiv({ cls: "wl-reading-author", text: name });

  const chip = host.createEl("button", {
    cls: "wl-reading-author wl-chip is-clickable",
    text: name,
    attr: {
      type: "button",
      title: open
        ? jump
          ? `Open ${name} — Alt-click to filter the shelf by them instead`
          : `Open ${name}`
        : `Show everything by ${name}`,
    },
  });
  chip.addEventListener("click", (event: MouseEvent) => {
    if (event.altKey === true && jump) {
      context.onBeforeJump?.();
      jump(`author:"${name}"`);
      return;
    }
    if (open) {
      open(name);
      return;
    }
    context.onBeforeJump?.();
    jump?.(`author:"${name}"`);
  });
  return chip;
}

/**
 * `Chatto & Windus · 1965` — the one-line edition note.
 *
 * Only what is actually known: an empty publisher and an unparseable release
 * date leave nothing, and nothing is what gets drawn.
 */
export function renderFactsLine(host: HTMLElement, entry: ReadingEntry): HTMLElement | null {
  const year = readingYear(entry);
  const parts = [readingExtra(entry, "publisher").trim(), year === null ? "" : String(year)]
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  return host.createDiv({ cls: "wl-bdv-facts", text: parts.join(" · ") });
}

/**
 * The synopsis as prose — what the screen is *for*, above the fields it is
 * edited in. Says so plainly when there is none rather than leaving a hole.
 */
export function renderSynopsisProse(host: HTMLElement, entry: ReadingEntry): HTMLElement {
  const text = readingExtra(entry, "description").trim();
  return host.createEl("p", {
    cls: "wl-bdv-overview",
    text: text === "" ? "No synopsis stored for this one yet." : text,
  });
}

// ---------------------------------------------------------------------------
// Status, rating, review — the judgement
// ---------------------------------------------------------------------------

/**
 * The status select.
 *
 * `To be released` is deliberately **not** in the picker: it is derived from the
 * release date (v3 line 214), so offering it would let the user choose a state
 * the next render silently overrules. The derived value is what the picker
 * shows, with the date that causes it spelled out underneath.
 */
export function renderReadingStatusField(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  cls?: string,
): HTMLElement {
  const field = host.createDiv({ cls: `wl-field${cls ? ` ${cls}` : ""}` });
  field.createDiv({ cls: "wl-field-label", text: "Status" });
  const derived = derivedStatus(entry);
  const select = field.createEl("select", { cls: "wl-select" });
  select.setAttribute("aria-label", "Status");
  for (const status of READING_STATUSES) {
    if (status === "To be released") continue;
    select.createEl("option", { value: status, text: status });
  }
  select.value = derived === "To be released" ? entry.status : derived;
  select.addEventListener("change", () =>
    surface.patch(statusPatch(entry, select.value as ReadingStatus), "reading-status"),
  );
  if (isFutureRelease(entry.releaseDate)) {
    field.createDiv({
      cls: "wl-reading-hint",
      text: `Shown as “To be released” until ${entry.releaseDate}.`,
    });
  }
  return field;
}

/**
 * Status, your stars and your review label, in one row.
 *
 * The stars and the select are `ui/detail/judgement.ts` verbatim — the same two
 * functions the film modal and the film view call, over the same
 * `data/review.ts` mapping. A book's review is a preserved extra key
 * (`extras.ts`) rather than a column, and that is the *only* difference; the
 * rules that bind it to the rating are not restated anywhere.
 */
export function renderJudgementRow(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  options: { ratingLabel?: string; ratingCls?: string } = {},
): HTMLElement {
  const row = host.createDiv({ cls: "wl-bdv-judgement" });
  renderReadingStatusField(row, entry, surface);

  const bridge = judgementBridge(surface);
  const judged = asJudged(entry);
  renderReviewField(row, judged, bridge);
  const ratingOptions: { label?: string; cls?: string } = {
    label: options.ratingLabel ?? "My rating",
  };
  if (options.ratingCls !== undefined) ratingOptions.cls = options.ratingCls;
  renderRatingField(row, judged, bridge, ratingOptions);

  const favorite = row.createEl("button", {
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
    surface.patch({ favorite: !entry.favorite }, "reading-favorite"),
  );

  return row;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function renderUnitSwitch(host: HTMLElement, entry: ReadingEntry, surface: ReadingSurface): void {
  if (!isBook(entry)) return;
  const row = host.createDiv({ cls: "wl-reading-unit-switch" });
  row.createSpan({ cls: "wl-field-label", text: "Count in" });
  const make = (unit: ProgressUnit, label: string): void => {
    const button = row.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: label,
      attr: { type: "button" },
    });
    button.toggleClass("is-on", entry.progressUnit === unit);
    button.addEventListener("click", () => {
      if (entry.progressUnit === unit) return;
      surface.patch(unitPatch(unit), "reading-unit");
    });
  };
  make("pages", "Pages");
  make("words", "Words");
  row.createSpan({
    cls: "wl-reading-hint",
    text: "Both counters are kept — 250 words counts as a page in your statistics.",
  });
}

/** The patch for editing the *total*, which depends on the active unit. */
export function totalPatch(entry: ReadingEntry, value: number): ReadingPatch {
  return totalPatchFor(entry, value);
}

/**
 * −/+, the two counters, and the bar.
 *
 * Every edit is a `progress.ts` patch, so "I moved the counter" still carries
 * everything it implies — starting stamps `dateStarted`, finishing stamps
 * `dateFinished` and sets Completed, and coming back off a finished book undoes
 * the completion instead of leaving it saying both.
 */
export function renderProgressSection(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  cls?: string,
): HTMLElement {
  const section = host.createDiv({
    cls: `wl-reading-detail-section${cls ? ` ${cls}` : ""}`,
  });
  const counter = primaryCounter(entry);

  renderUnitSwitch(section, entry, surface);

  const row = section.createDiv({ cls: "wl-reading-progress-row" });

  const minus = row.createEl("button", {
    cls: "wl-btn wl-icon-btn",
    attr: {
      type: "button",
      "aria-label": `One ${counter.noun} back`,
      title: `One ${counter.noun} back`,
    },
  });
  setIcon(minus, "minus");
  minus.addEventListener("click", () => surface.patch(bumpPatch(entry, -1), "reading-progress"));

  const readInput = row.createEl("input", {
    cls: "wl-input wl-reading-count",
    attr: { type: "number", min: "0", step: "1", "aria-label": `${counter.noun}s read` },
  });
  readInput.value = String(counter.read);
  commitNumber(readInput, (value) =>
    surface.patch(progressPatch(entry, value), "reading-progress"),
  );

  row.createSpan({ cls: "wl-reading-of", text: "of" });

  const totalInput = row.createEl("input", {
    cls: "wl-input wl-reading-count",
    attr: { type: "number", min: "0", step: "1", "aria-label": `total ${counter.noun}s` },
  });
  totalInput.value = String(counter.total);
  commitNumber(totalInput, (value) => surface.patch(totalPatch(entry, value), "reading-total"));

  row.createSpan({ cls: "wl-reading-unit-label", text: counter.unit });

  const plus = row.createEl("button", {
    cls: "wl-btn wl-icon-btn",
    attr: {
      type: "button",
      "aria-label": `One more ${counter.noun}`,
      title: `One more ${counter.noun}`,
    },
  });
  setIcon(plus, "plus");
  plus.addEventListener("click", () => surface.patch(bumpPatch(entry, 1), "reading-progress"));

  // Manga's second axis, alongside the chapter counter rather than instead of
  // it — a shelf tracks volumes, a reader tracks chapters.
  if (!isBook(entry)) {
    const volumes = volumeCounter(entry);
    const volRow = section.createDiv({ cls: "wl-reading-progress-row" });
    volRow.createSpan({ cls: "wl-reading-unit-label", text: "volumes" });
    const readVol = volRow.createEl("input", {
      cls: "wl-input wl-reading-count",
      attr: { type: "number", min: "0", step: "1", "aria-label": "volumes read" },
    });
    readVol.value = String(volumes.read);
    commitNumber(readVol, (value) => surface.patch({ volumesRead: value }, "reading-volumes"));
    volRow.createSpan({ cls: "wl-reading-of", text: "of" });
    const totalVol = volRow.createEl("input", {
      cls: "wl-input wl-reading-count",
      attr: { type: "number", min: "0", step: "1", "aria-label": "total volumes" },
    });
    totalVol.value = String(volumes.total);
    commitNumber(totalVol, (value) => surface.patch({ totalVolumes: value }, "reading-volumes"));
  }

  const bar = section.createDiv({ cls: "wl-reading-bar" });
  const fill = bar.createDiv({ cls: "wl-reading-bar-fill" });
  fill.style.width = `${readingProgress(entry)}%`;

  const label = [progressLabel(entry), remainingLabel(entry)].filter(Boolean).join(" · ");
  section.createDiv({ cls: "wl-reading-progress-label", text: label || "Nothing counted yet" });

  return section;
}

// ---------------------------------------------------------------------------
// The public's verdict, and the stores
// ---------------------------------------------------------------------------

/**
 * What everyone else thought, under the user's own stars.
 *
 * One line plus a fetch/refresh affordance; without a Google Books key the
 * button says what is missing rather than pretending nothing exists. The stores
 * themselves are one click away because reviews live where no API does.
 */
export function renderCommunitySection(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: ReadingDetailContext,
): HTMLElement {
  const row = host.createDiv({ cls: "wl-reading-community" });
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

  const google = context.googleBooks;
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
        // One pass, three fields: the rating, the categories, and the blurb —
        // which is why the synopsis fills itself in for a book that came from a
        // search rather than sitting empty until somebody types one.
        const patch = communityRatingPatch(info, entry, clockOf(context)());
        if (info.description && readingExtra(entry, "description") === "") {
          Object.assign(patch, extraPatch("description", info.description));
        }
        surface.patch(patch, "reading-community-rating");
        if (!info.rated) new Notice("Google has no rated edition of this one.");
      })
      .catch((err: unknown) => {
        new Notice(`Rating fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        fetchButton.disabled = false;
      });
  });

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

  return row;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Categories as a picker, not a text field: the current ones are removable
 * chips, the dropdown offers everything known (built-in defaults, the user's own
 * additions, every value already on a shelf) minus what this entry already has,
 * and "New category…" keeps the free-text escape hatch — a new name is
 * remembered in settings so the next book can pick it.
 */
export function renderCategoriesField(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
): HTMLElement {
  const field = host.createDiv({ cls: "wl-field wl-reading-categories-field" });
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
      surface.patch({ categories: current.filter((c) => c !== name) }, "reading-categories"),
    );
  }

  const add = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === "" || current.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    // A name nobody has seen before joins the offered list for every next book.
    const settings = surface.reading.reading.settings;
    const known = availableCategories(settings.categoryOptions, []);
    if (!known.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      settings.categoryOptions = [...(settings.categoryOptions ?? []), trimmed];
    }
    surface.patch({ categories: [...current, trimmed] }, "reading-categories");
  };

  const reading = surface.reading.reading;
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
        // Esc backs out; the surface re-renders on the next patch anyway.
        if (event.key === "Escape") surface.refresh();
      });
      input.addEventListener("blur", commit);
      return;
    }
    add(value);
  });

  return field;
}

// ---------------------------------------------------------------------------
// The book file itself
// ---------------------------------------------------------------------------

/** Where an imported book lands: the reading folder, or the vault root. */
function readingFolder(surface: ReadingSurface): string {
  return (surface.reading.reading.settings.defaultFolder ?? "").trim();
}

/**
 * The linked epub/pdf, and the three verbs: Open when a file is linked, Browse
 * over what the vault already holds, Import to copy one in from outside and
 * link it in a single motion.
 */
export function renderFileField(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  app: App,
): HTMLElement {
  const field = host.createDiv({ cls: "wl-field wl-reading-file-field" });
  field.createDiv({ cls: "wl-field-label", text: "File in vault" });
  const row = field.createDiv({ cls: "wl-reading-file-row" });

  const input = row.createEl("input", {
    cls: "wl-input",
    attr: { type: "text", placeholder: "Books/Dune.epub", "aria-label": "Book file path" },
  });
  input.value = entry.filePath ?? "";
  input.addEventListener("change", () =>
    surface.patch({ filePath: input.value.trim() }, "reading-file"),
  );

  /*
   * Link a file — and, when it is a PDF the book has no length for, take the
   * page count out of it there and then. The Reading tab does this on mount
   * anyway, but "I just attached the book and it still says no pages" is a bad
   * half-second to leave lying around.
   */
  const link = (path: string): void => {
    surface.patch({ filePath: path }, "reading-file");
    if (primaryCounter(entry).total > 0 || !path.toLowerCase().endsWith(".pdf")) return;
    void readPdfPageCount(app.vault.adapter, path).then((pages) => {
      if (pages === null) return;
      surface.patch(totalPatchFor(entry, pages), "reading-pages-from-file");
      new Notice(`${pages} pages, read from the file.`);
    });
  };

  const linked = (entry.filePath ?? "").trim() !== "";

  if (linked) {
    const open = row.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": "Open the book", title: "Open the book" },
    });
    setIcon(open, "book-open");
    open.addEventListener("click", () =>
      openBookFile(app, (entry.filePath ?? "").trim(), entry.filePage),
    );
  }

  // Two ways to fill this in, and which one a person wants depends on where the
  // book already is. With nothing linked they are spelled out — an unlabelled
  // pair of icons is not an offer anyone can accept. Once a file *is* linked the
  // row is mostly the open button, so they shrink back to icons.
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
    new BookFileSuggestModal(app, entry.title, link).open(),
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
    importBookFile(app, readingFolder(surface), link),
  );

  if (!linked) {
    field.createDiv({
      cls: "wl-reading-hint",
      text: `Importing copies the file into ${readingFolder(surface) || "your vault"} and links it here — the original is left where it is. ${BOOK_FILE_EXTENSIONS.map((e) => `.${e}`).join(", ")}`,
    });
  }

  // The bookmark the page-watcher keeps while the PDF is open.
  if ((entry.filePage ?? 0) > 1) {
    field.createDiv({ cls: "wl-reading-hint", text: `Reopens at page ${entry.filePage}.` });
  }

  return field;
}

// ---------------------------------------------------------------------------
// Dates and the plain facts
// ---------------------------------------------------------------------------

/**
 * Started, Finished, Released — each with the "Today" button `components/dates.ts`
 * gives every date field, so the two surfaces cannot offer different affordances
 * for the same date.
 */
export function renderReadingDates(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: ReadingDetailContext,
  cls?: string,
): HTMLElement {
  const row = host.createDiv({ cls: `wl-bdv-dates${cls ? ` ${cls}` : ""}` });
  const format = dateFormatOf(surface);
  const now = clockOf(context);

  renderDateField(row, {
    label: "Started",
    format,
    now,
    current: entry.dateStarted,
    onChange: (value) => surface.patch({ dateStarted: value }, "reading-date"),
  });
  renderDateField(row, {
    label: "Finished",
    format,
    now,
    current: entry.dateFinished,
    onChange: (value) => surface.patch({ dateFinished: value }, "reading-date"),
  });
  renderDateField(row, {
    label: "Released",
    format,
    now,
    current: entry.releaseDate,
    onChange: (value) => surface.patch({ releaseDate: value }, "reading-date"),
  });

  return row;
}

/**
 * The editable facts: what it is called, who wrote it, who published it, where
 * its cover and its page live.
 *
 * `publisher` is a preserved extra key (`extras.ts`) — no provider this plugin
 * talks to reports one, so it is the user's own note about the edition on the
 * shelf, and it is only ever shown when they have filled it in.
 */
export function renderFactFields(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
): HTMLElement {
  const grid = host.createDiv({ cls: "wl-field-grid" });

  readingTextField(grid, "Title", entry.title, (value) => {
    if (value.trim() === "") return;
    surface.patch({ title: value.trim() }, "reading-title");
  });
  readingTextField(grid, "Author", entry.author ?? "", (value) =>
    surface.patch({ author: value }, "reading-author"),
  );
  readingTextField(grid, "Publisher", readingExtra(entry, "publisher"), (value) =>
    surface.patch(extraPatch("publisher", value.trim()), "reading-publisher"),
  );
  readingTextField(grid, "Cover URL", entry.coverUrl ?? "", (value) =>
    surface.patch({ coverUrl: value.trim() }, "reading-cover"),
  );
  readingTextField(grid, "Link", entry.externalLink ?? "", (value) =>
    surface.patch({ externalLink: value.trim() }, "reading-link"),
  );
  if (!isBook(entry)) {
    readingTextField(grid, "MyAnimeList id", entry.malId ?? "", (value) =>
      surface.patch({ malId: value.trim() }, "reading-malid"),
    );
  }

  return grid;
}

/** The synopsis. Editable, and filled in by the Google pass when it is blank. */
export function renderDescriptionField(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
): HTMLElement {
  return readingTextArea(
    host,
    "Synopsis",
    readingExtra(entry, "description"),
    "What is it about?",
    (value) => surface.patch(extraPatch("description", value), "reading-description"),
    "wl-bdv-synopsis",
  );
}

/**
 * The notes box.
 *
 * Deliberately **not** mirrored into the generated note's `## Notes` section:
 * `domains/reading/notes.ts` never reads a reading note back, which is what
 * guarantees regenerating one cannot lose a word the user wrote in the vault.
 * This is the in-app scratchpad; "Open note" is right there for the prose.
 */
export function renderReadingNotesField(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
): HTMLElement {
  return readingTextArea(
    host,
    "Notes",
    readingExtra(entry, "notes"),
    "Anything worth remembering about this one…",
    (value) => surface.patch(extraPatch("notes", value), "reading-notes"),
    "wl-bdv-notes",
  );
}

// ---------------------------------------------------------------------------
// The user's own columns
// ---------------------------------------------------------------------------

export function renderCustomColumns(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
): HTMLElement | null {
  const columns: CustomColumn[] = surface.reading.columns(surface.kind);
  if (columns.length === 0) return null;

  const section = host.createDiv({ cls: "wl-reading-detail-section" });
  section.createDiv({ cls: "wl-field-label", text: "Your columns" });
  const grid = section.createDiv({ cls: "wl-field-grid" });

  const pool =
    surface.kind === "book" ? surface.reading.allBooks() : surface.reading.allManga();

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
        surface.patch(
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
      attr: { type: column.type === "number" ? "number" : "text", "aria-label": column.name },
    });
    input.value = columnDisplay(entry, column);
    const commit = (): void =>
      surface.patch(
        { customFields: writeColumnValue(entry, column, input.value) },
        "reading-column",
      );
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    const color = sanitizeColor(column.color ?? "");
    if (color) field.style.setProperty("--wl-column-color", color);
  }

  return section;
}

// ---------------------------------------------------------------------------
// "More like this"
// ---------------------------------------------------------------------------

function renderMoreRow(
  parent: HTMLElement,
  suggestion: BookSuggestion,
  context: ReadingDetailContext,
): void {
  const { hit } = suggestion;
  const row = parent.createDiv({ cls: "wl-recent-row wl-suggest-mini" });

  const cover = row.createDiv({ cls: "wl-thumb" });
  if (hit.coverUrl) {
    const img = cover.createEl("img", { cls: "wl-thumb-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    // Open Library has a cover id for plenty of books it has no image for, so a
    // 404 here is routine. Falling back to the initial beats leaving the
    // browser's broken-image glyph in a list of book covers.
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
  if (context.onAddSuggestion) {
    const add = actions.createEl("button", {
      cls: "wl-mini-btn",
      text: "Add",
      attr: { type: "button", title: `Add ${hit.title} to your shelf` },
    });
    add.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      add.disabled = true;
      void context.onAddSuggestion?.(hit).then((ok) => {
        if (ok) {
          new Notice(`Added «${hit.title}».`);
          row.remove();
        } else {
          add.disabled = false;
        }
      });
    });
  }
  if (context.onDismissSuggestion) {
    const no = actions.createEl("button", {
      cls: "wl-icon-btn",
      attr: { type: "button", "aria-label": "Not interested", title: "Not interested" },
    });
    setIcon(no, "x");
    no.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      context.onDismissSuggestion?.(hit.id);
      row.remove();
    });
  }
}

/**
 * "More like this", for a book.
 *
 * Same place and same shape as the film surfaces', deliberately: the question is
 * identical and so should be the answer. The signals underneath are not —
 * subjects and authors rather than "people who liked this" — which is why the
 * reason line says what it matched on.
 */
export function renderMoreLikeThis(
  host: HTMLElement,
  entry: ReadingEntry,
  context: ReadingDetailContext,
): HTMLElement | null {
  const fetch = context.onMoreLikeThis;
  if (!fetch) return null;

  const section = host.createDiv({ cls: "wl-reading-detail-section wl-detail-more" });
  section.createDiv({ cls: "wl-reading-section-label", text: "More like this" });
  const list = section.createDiv({ cls: "wl-suggest-mini-list" });
  list.createDiv({ cls: "wl-suggest-empty", text: "Looking…" });

  void fetch(entry)
    .then((results) => {
      list.empty();
      if (results.length === 0) {
        list.createDiv({ cls: "wl-suggest-empty", text: "Nothing to suggest from this one." });
        return;
      }
      for (const suggestion of results.slice(0, 6)) renderMoreRow(list, suggestion, context);
    })
    .catch((err) => {
      list.empty();
      list.createDiv({
        cls: "wl-suggest-empty",
        text: `Could not ask Open Library — ${err instanceof Error ? err.message : String(err)}`,
      });
    });

  return section;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * "Delete this", with the confirm that says what goes with it.
 *
 * Icon *and* label, never a bare coloured rectangle whatever a theme does to
 * `.mod-warning` (QA1 B6).
 */
export function renderDeleteButton(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: ReadingDetailContext,
): HTMLElement {
  return iconTextButton(
    host,
    "trash-2",
    "Delete",
    () => {
      void confirmAction(surface.app, {
        title: `Delete “${entry.title}”?`,
        message: "It is removed from this shelf. Any note it generated stays in your vault.",
        confirmText: "Delete",
        danger: true,
      }).then((result) => {
        if (!result.confirmed) return;
        surface.reading.remove(surface.kind, entry.id);
        new Notice(`Removed “${entry.title}”`);
        context.onDeleted?.();
      });
    },
    "wl-btn mod-warning",
  );
}
