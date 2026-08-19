/**
 * The book card — the Reading tab's half of the plugin's signature grid.
 *
 * ## Not a second card
 *
 * The frame is `buildPosterCard` from `ui/components/card.ts`: the same 2:3
 * poster, the same scrim caption, the same badge and heart corners, the same
 * hover action column, the same focus and selection outlines, the same
 * `@media (hover: none)` and reduced-motion handling. Every class here —
 * `.wl-card`, `.wl-card-poster`, `.wl-card-body`, `.wl-card-title`,
 * `.wl-card-pills`, `.wl-card-meta`, `.wl-card-rating-empty`, `.wl-card-fav`,
 * `.wl-card-actions`, `.wl-card-action`, `.wl-progress` — is declared exactly
 * once, in `styles/20-cards.css`, and is the *same* declaration the Library's
 * cards read. That is what makes the two grids identical and keeps them that
 * way: there is no second stylesheet to forget to update.
 *
 * This is the same move `detail/surface.ts` made for the rating and the review.
 * `buildTitleCard` is built around `TitleV4` — episodes, Plex state, airing — so
 * a book cannot be handed to it; what a book *can* share is the presentation,
 * and that is what was extracted.
 *
 * ## What a book card says, and what it does not
 *
 * Cover, title, status, category, author, progress, rating. No Plex badge, no
 * episode count, no airing chip: an empty pill is worse than no pill, and a
 * book has no next episode. The caption rows a book *does* have hold their
 * height whether or not they are filled, for the same reason a title card's do
 * — a row that collapses is a poster cropped on a different line from its
 * neighbour, and a grid of those reads as ragged however good each card is.
 *
 * ## Covers
 *
 * `renderReadingCover` is the one path a cover is ever drawn by, in the grid and
 * in the table alike. It is here rather than in `tab.ts` because a grid is
 * exactly the surface that would have got this wrong: assigning
 * `covers.openlibrary.org/...` to an `<img src>` fires a request Chromium owns,
 * carrying none of our headers and passing through none of our limiter, and a
 * screenful of cards would fire twenty of them at once. See `covers.ts`.
 */
import { Menu, setIcon } from "obsidian";
import type { OpenLibraryClient, PosterLoader, Settings } from "../../types";
import {
  buildPosterCard,
  cardActionButton,
  type PosterCardSpec,
} from "../../ui/components/card";
import { renderPill, sanitizeColor } from "../../ui/components/pills";
import { renderPosterPlaceholder } from "../../ui/components/posters";
import { createStars } from "../../ui/components/stars";
import {
  coverIsbn,
  coverSource,
  keepCover,
  loadCover,
  localCoverUrl,
  needsProxy,
  type CoverCache,
  type CoverHandle,
} from "./covers";
import {
  derivedStatus,
  isBook,
  isMeasurable,
  primaryCounter,
  progressLabel,
  readingProgress,
  type ReadingEntry,
} from "./progress";

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

export interface ReadingCoverDeps {
  /** The shared lazy loader, for URLs that are safe to assign directly. */
  posterLoader?: PosterLoader | undefined;
  /** The rate-limited, identified client. Absent means no Open Library cover. */
  openLibrary?: OpenLibraryClient | undefined;
  /** The user's local artwork cache, when they have turned it on. */
  imageCache?: CoverCache | undefined;
  /**
   * How fallback bytes are fetched. Injected rather than imported so this
   * module stays testable offline — no fetcher, no Google-by-ISBN fallback.
   */
  fetchBytes?: ((url: string) => Promise<ArrayBuffer | null>) | undefined;
}

/**
 * Draw an entry's cover into an existing `.wl-poster` box, politely.
 *
 * Returns the handle whose object URL has to be released when the box goes
 * away, or `null` when nothing was fetched (a placeholder, or a directly
 * assignable URL the shared loader owns).
 */
export function renderReadingCover(
  poster: HTMLElement,
  entry: ReadingEntry,
  deps: ReadingCoverDeps,
): CoverHandle | null {
  poster.dataset.posterSeed = entry.title;
  // The user's own picture when they set one, else the catalogue's — and a
  // hand-set *file* arrives already resolved to a vault resource URL, which is
  // directly assignable and needs no fetch of any kind.
  const source = coverSource(entry, deps.imageCache);
  const cover = source.url;
  const isbn = coverIsbn(entry);

  if (cover === "" && isbn === "") {
    renderPosterPlaceholder(poster, entry.title);
    return null;
  }

  if (!source.direct && (cover === "" || needsProxy(cover))) {
    // Open Library covers go through the client: same User-Agent, same limiter
    // as the API, because covers share its allowance and an unidentified caller
    // gets a third of it (W8 review P1-5). The shared lazy loader cannot help
    // here — it ends in an `<img src>`, which is Chromium's request rather than
    // ours. When Open Library has no image for the book (niche titles routinely
    // 404), the loader falls back to Google's keyless cover CDN by ISBN before
    // settling for a placeholder.
    const img = poster.createEl("img", { cls: "wl-poster-img" });
    img.setAttribute("alt", "");
    img.setAttribute("decoding", "async");
    return loadCover(img, cover, {
      client: deps.openLibrary,
      fallbackIsbn: isbn,
      fetchBytes: deps.fetchBytes,
      cache: deps.imageCache,
      cacheId: entry.id,
      onMissing: () => {
        img.remove();
        renderPosterPlaceholder(poster, entry.title);
      },
    });
  }

  // Directly assignable, so it goes through the shared lazy loader like a film
  // poster does — off the local copy when there is one, and asking the cache to
  // make one when there is not.
  const local = source.direct ? cover : localCoverUrl(deps.imageCache, entry.id, cover);
  if (deps.posterLoader) deps.posterLoader.observe(poster, local === "" ? cover : local);
  else renderPosterPlaceholder(poster, entry.title);
  if (!source.direct && local === "") keepCover(deps.imageCache, entry.id, cover);
  return null;
}

// ---------------------------------------------------------------------------
// The caption's own small pieces
// ---------------------------------------------------------------------------

/**
 * `312/528 pages`, tightened.
 *
 * `progressLabel` is the domain's one answer to "how far along is this", spaces
 * and volume fallback included; a card is a 160px column, so the spaces around
 * the slash come out. Deriving it rather than re-branching means a manga
 * tracked only in volumes reads correctly here without a second copy of that
 * rule.
 */
export function compactProgress(entry: ReadingEntry): string {
  return progressLabel(entry).replace(" / ", "/");
}

/**
 * The one meta line: who wrote it, and where you are.
 *
 * Same shape as a title card's (`year · 12/24 eps · 50%`) and the same
 * discipline — one line, truncated rather than wrapped, and simply empty when
 * a book has neither an author nor anything to count. The row still holds its
 * height, so a book with nothing to say here is cropped on the same line as the
 * one beside it.
 */
export function bookMetaLine(entry: ReadingEntry): string {
  const parts: string[] = [];
  const author = (entry.author ?? "").trim();
  if (author !== "") parts.push(author);
  const progress = compactProgress(entry);
  if (progress !== "") parts.push(progress);
  return parts.join(" · ");
}

/**
 * The filmstrip at the bottom of the caption — the same `.wl-progress` the
 * Library's cards draw, so it gets the same sprocket-hole treatment from
 * `.wl-card-body .wl-progress`.
 *
 * `null` when there is nothing to be a fraction of. A book with no page count
 * is not "0 % read", it is unmeasured, and a bar sitting at zero says the wrong
 * thing. The strip is reserved by the caption's padding either way, so leaving
 * it out costs no alignment.
 */
export function renderReadingBar(parent: HTMLElement, entry: ReadingEntry): HTMLElement | null {
  if (!isMeasurable(entry)) return null;
  const percent = readingProgress(entry);
  const bar = parent.createDiv({ cls: "wl-progress" });
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent));
  bar.setAttribute("aria-label", `${progressLabel(entry)} read`);
  bar.createDiv({ cls: "wl-progress-fill" }).style.width = `${percent}%`;
  return bar;
}

/** The first real category, or `""`. One pill: the row is capped at one line. */
export function primaryCategory(entry: ReadingEntry): string {
  return (entry.categories ?? []).map((name) => name.trim()).find((name) => name !== "") ?? "";
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface BookCardCtx {
  /** Read for the rating tiers and the half-star preference only. */
  settings: Settings;
  /** `reading.settings.statusColors` — the user's own palette for the shelf. */
  statusColors?: Partial<Record<string, string>> | undefined;
  /** Fill the poster box. The tab wires this to `renderReadingCover`. */
  renderPoster: (poster: HTMLElement, entry: ReadingEntry) => void;
  /** Off for a read-only surface; on, the hover column and ⋮ menu appear. */
  showActions?: boolean;
  onOpen?: (entry: ReadingEntry) => void;
  /** One more page / one more chapter. Hidden once the entry is finished. */
  onBump?: (entry: ReadingEntry) => void;
  onToggleFavorite?: (entry: ReadingEntry) => void;
  /** The linked book file or the generated note; absent hides the entry. */
  onOpenInVault?: (entry: ReadingEntry) => void;
  /** Whether *this* entry has anything to open. No target, no menu entry. */
  canOpenInVault?: (entry: ReadingEntry) => boolean;
  /**
   * The study shortcut — the book beside the current chapter's note. The card
   * offers it in the ⋮ menu rather than as a fourth hover icon: a poster is
   * mostly poster, and a row of four controls over it is a toolbar with a
   * picture behind it.
   */
  onStudy?: (entry: ReadingEntry) => void;
  /** Open what is already written for the current chapter. */
  onOpenChapterNote?: (entry: ReadingEntry) => void;
  /** The same note, in an OS window of its own — a menu is where a modifier
   *  cannot be taught, so this one is spelled out. */
  onPopOutChapter?: (entry: ReadingEntry) => void;
  onDelete?: (entry: ReadingEntry) => void;
}

export function buildBookCard(
  parent: HTMLElement,
  entry: ReadingEntry,
  ctx: BookCardCtx,
): HTMLElement {
  const spec: PosterCardSpec = {
    ariaLabel: `${entry.title} — open details`,
    favorite: entry.favorite === true,
    renderPoster: (poster) => ctx.renderPoster(poster, entry),
    renderBody: (body) => buildBookBody(body, entry, ctx),
  };
  if (ctx.onOpen) spec.onActivate = () => ctx.onOpen?.(entry);
  // No `renderBadges`: the corner badge is Plex availability, which means
  // nothing for a book. An empty corner is the honest answer.
  if (ctx.showActions) {
    spec.renderActions = (row) => buildBookActions(row, entry, ctx);
    spec.onContextMenu = (event) => openBookCardMenu(event, entry, ctx);
  }

  const card = buildPosterCard(parent, spec);
  card.dataset.readingId = entry.id;
  return card;
}

function buildBookBody(body: HTMLElement, entry: ReadingEntry, ctx: BookCardCtx): void {
  body.createDiv({ cls: "wl-card-title", text: entry.title });

  // Status first, and it is always there: `derivedStatus` answers for every
  // row. The Library's first pill is the one that never gives way (the CSS
  // pins `:first-child`), and on this shelf that is the short, fixed one.
  const pills = body.createDiv({ cls: "wl-card-pills" });
  const status = derivedStatus(entry);
  renderPill(pills, {
    text: status,
    color: sanitizeColor(ctx.statusColors?.[status] ?? ""),
    cls: "is-status",
  });
  const category = primaryCategory(entry);
  // Only when there is one. A blank pill is a shape with nothing in it, which
  // reads as a bug rather than as an absence.
  //
  // `is-category` is the same modifier the table's chips carry, so the two say
  // the same thing in the same colour — and because it works by setting
  // `--wl-pill`, the card's scrim rules pick it up and lift it for legibility
  // over artwork without knowing anything about categories.
  if (category !== "") renderPill(pills, { text: category, cls: "is-category" });

  body.createDiv({ cls: "wl-card-meta", text: bookMetaLine(entry) });

  if (entry.rating > 0) {
    createStars(body, {
      value: entry.rating,
      tiers: ctx.settings.ratingSystem,
      allowHalf: ctx.settings.halfStarRatings,
      ariaLabel: `${entry.title} rating`,
    });
  } else {
    // Holds the line an unrated entry would otherwise not occupy. Empty rather
    // than a row of grey stars: "not rated" should read as absence, not as a
    // score of zero.
    body.createDiv({ cls: "wl-card-rating-empty" });
  }

  renderReadingBar(body, entry);
}

function buildBookActions(row: HTMLElement, entry: ReadingEntry, ctx: BookCardCtx): void {
  const counter = primaryCounter(entry);
  const finished = counter.total > 0 && counter.read >= counter.total;
  if (ctx.onBump && !finished) {
    const label = isBook(entry)
      ? `One more ${counter.noun} of ${entry.title}`
      : `One more chapter of ${entry.title}`;
    cardActionButton(row, "plus", label, () => ctx.onBump?.(entry));
  }

  if (ctx.onToggleFavorite) {
    cardActionButton(
      row,
      entry.favorite ? "heart-off" : "heart",
      entry.favorite ? "Remove from favourites" : "Mark as favourite",
      () => ctx.onToggleFavorite?.(entry),
    );
  }

  const menuButton = cardActionButton(
    row,
    "more-vertical",
    `More actions for ${entry.title}`,
    (event) => openBookCardMenu(event, entry, ctx),
  );
  menuButton.addClass("wl-card-menu");
}

function openBookCardMenu(event: MouseEvent, entry: ReadingEntry, ctx: BookCardCtx): void {
  const menu = new Menu();

  if (ctx.onOpen) {
    menu.addItem((item) =>
      item
        .setTitle("Open details")
        .setIcon("panel-right-open")
        .onClick(() => ctx.onOpen?.(entry)),
    );
  }
  // An entry whose callback is absent simply does not appear — a menu never
  // shows an action the data cannot support, and neither does one whose row
  // has nothing in the vault to open.
  if (ctx.onOpenInVault && (ctx.canOpenInVault?.(entry) ?? true)) {
    const hasFile = (entry.filePath ?? "").trim() !== "";
    menu.addItem((item) =>
      item
        .setTitle(hasFile ? "Open the book" : "Open the note")
        .setIcon(hasFile ? "book-open" : "file-text")
        .onClick(() => ctx.onOpenInVault?.(entry)),
    );
  }

  if (ctx.onStudy) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Read & take notes")
        .setIcon("columns-2")
        .onClick(() => ctx.onStudy?.(entry)),
    );
  }
  if (ctx.onOpenChapterNote) {
    menu.addItem((item) =>
      item
        .setTitle("Open the chapter note")
        .setIcon("file-text")
        .onClick(() => ctx.onOpenChapterNote?.(entry)),
    );
  }

  if (ctx.onPopOutChapter) {
    menu.addItem((item) =>
      item
        .setTitle("Chapter note in a separate window")
        .setIcon("picture-in-picture-2")
        .onClick(() => ctx.onPopOutChapter?.(entry)),
    );
  }

  if (ctx.onDelete) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => ctx.onDelete?.(entry)),
    );
  }

  menu.showAtMouseEvent(event);
}
