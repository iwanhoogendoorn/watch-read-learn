/**
 * A book, as a **workspace view** rather than a modal.
 *
 * This is the sibling of `title-detail.ts`, and it exists for the same complaint
 * in the same words: a modal is the wrong shape for this content. A book's
 * cover, its facts, its synopsis, the four numbers that matter and the counter
 * you actually came to move were stacked in one narrow column, while a film had
 * already been given a real leaf with room to put them side by side. "The book
 * pages still behave differently as the movies one" — so now they do not.
 *
 * **Nothing about a control is decided here.** Every field, the progress
 * counters, the categories picker, the file field and — above all — the
 * rating/review binding come from `domains/reading/detail/`, shared verbatim
 * with the modal. That is not tidiness: a second copy of the rating/review rules
 * is the exact defect that got reported four times, and the only way to not have
 * one is to not write one. The stars and the review select in this pane are
 * `ui/detail/judgement.ts`, over `data/review.ts`, byte for byte the two
 * functions a film uses.
 *
 * `main.ts` is not edited by this module. `registerBookDetailView` and
 * `openBookDetail` are the two entry points it needs to call — see the wiring
 * note at the bottom of this file.
 */
import {
  ItemView,
  setIcon,
  type App,
  type Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import {
  DATA_CHANGED_EVENT,
  type MountHandle,
  type ReadingKind,
  type ReadingPatch,
  type WatchLogStoreApi,
} from "../../types";
import type { ReadingStore } from "../../domains/reading/store";
import { derivedStatus, type ReadingEntry } from "../../domains/reading/progress";
import { openBookFile } from "../../domains/reading/bookfile";
import type { CoverHandle } from "../../domains/reading/covers";
import { renderReadingStatTiles } from "../../domains/reading/detail/stats";
import type { ReadingSurface } from "../../domains/reading/detail/surface";
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
} from "../../domains/reading/detail/sections";
import { renderPill, sanitizeColor } from "../components/pills";
import { iconTextButton } from "../detail/fields";
import { isEditable } from "../detail/surface";
import { safeExternalUrl } from "../modals/trailer";

/**
 * Deliberately not `watchlog-view`: that id is written into saved workspace
 * layouts and must keep meaning the tab bar. This is another view type, added
 * alongside `watchlog-title-detail`.
 */
export const VIEW_TYPE_BOOK_DETAIL = "watchlog-book-detail";

/** How long after leaving an input before a deferred refresh is allowed through. */
const REFRESH_RESUME_MS = 120;

export interface BookDetailDeps extends ReadingDetailContext {
  app: App;
  /** The plugin store — settings only (rating tiers, review labels, dates). */
  store: WatchLogStoreApi;
  /** The shelf. Every write goes through it. */
  reading: ReadingStore;
  /** The surface closes itself after a delete: a leaf detaches, a test spies. */
  onClose?: () => void;
}

/** Which shelf and which row a pane is pointed at. */
export interface BookDetailTarget {
  kind: ReadingKind;
  id: string;
}

export interface BookDetailController extends MountHandle {
  /** Point the same pane at a different book without remounting it. */
  setTarget(target: BookDetailTarget): void;
  readonly target: BookDetailTarget;
}

/**
 * The pane, independent of `ItemView`.
 *
 * Mounting is a plain function over an element for the same reason every other
 * surface in this plugin is: it can be driven headlessly in a test, against a
 * real store, and assert what is actually on screen.
 */
export function mountBookDetail(
  host: HTMLElement,
  target: BookDetailTarget,
  deps: BookDetailDeps,
): BookDetailController {
  return new BookDetailPane(host, target, deps);
}

class BookDetailPane implements BookDetailController, ReadingSurface {
  readonly el: HTMLElement;
  readonly app: App;
  readonly reading: ReadingStore;
  readonly watch: WatchLogStoreApi;

  private deps: BookDetailDeps;
  private current: BookDetailTarget;
  private bodyEl: HTMLElement;
  private pendingRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The object URL of a proxied cover; released on every repaint and on close. */
  private cover: CoverHandle | null = null;

  private onDataChanged = (): void => this.requestRefresh();
  private onFocusIn = (): void => {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  };
  private onFocusOut = (): void => {
    if (!this.pendingRefresh) return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.render();
    }, REFRESH_RESUME_MS);
  };

  constructor(host: HTMLElement, target: BookDetailTarget, deps: BookDetailDeps) {
    this.deps = deps;
    this.app = deps.app;
    this.reading = deps.reading;
    this.watch = deps.store;
    this.current = { ...target };
    this.el = host.createDiv({ cls: "wl-bdv" });
    this.bodyEl = this.el.createDiv({ cls: "wl-bdv-body" });

    const doc = this.el.ownerDocument;
    doc?.addEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.el.addEventListener("focusin", this.onFocusIn);
    this.el.addEventListener("focusout", this.onFocusOut);

    this.render();
  }

  // --- ReadingSurface -------------------------------------------------------

  get kind(): ReadingKind {
    return this.current.kind;
  }

  get target(): BookDetailTarget {
    return this.current;
  }

  entry(): ReadingEntry | undefined {
    return this.reading.getEntry(this.current.kind, this.current.id);
  }

  patch(patch: ReadingPatch, reason: string): void {
    this.reading.update(this.current.kind, this.current.id, patch, reason);
    this.requestRefresh();
  }

  refresh(): void {
    this.requestRefresh();
  }

  // --- lifecycle ------------------------------------------------------------

  setTarget(target: BookDetailTarget): void {
    if (target.kind === this.current.kind && target.id === this.current.id) return;
    this.current = { ...target };
    this.render();
  }

  destroy(): void {
    const doc = this.el.ownerDocument;
    doc?.removeEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.el.removeEventListener("focusin", this.onFocusIn);
    this.el.removeEventListener("focusout", this.onFocusOut);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.releaseCover();
    this.el.remove();
  }

  private releaseCover(): void {
    this.cover?.release();
    this.cover = null;
  }

  /**
   * Repaint — unless the user is mid-edit, in which case it waits.
   *
   * Every text field here commits on blur rather than per keystroke, so this is
   * belt and braces against a *background* write (the PDF page watcher, a note
   * mirror, another pane) rebuilding a field under the caret.
   */
  private requestRefresh(): void {
    const active = this.el.ownerDocument?.activeElement as
      | { tagName?: string; isContentEditable?: boolean }
      | null
      | undefined;
    if (active && isEditable(active)) {
      this.pendingRefresh = true;
      return;
    }
    this.render();
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** The shared context, with this pane's own clock and close behaviour. */
  private context(): ReadingDetailContext {
    return {
      ...(this.deps as ReadingDetailContext),
      now: () => this.now(),
      onDeleted: () => this.deps.onClose?.(),
    };
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private render(): void {
    this.pendingRefresh = false;
    this.releaseCover();
    const host = this.bodyEl;
    host.empty();

    const entry = this.entry();
    if (!entry) {
      host.createDiv({
        cls: "wl-empty-body",
        text: "That entry is no longer in your library.",
      });
      return;
    }

    const context = this.context();

    this.renderHead(host, entry, context);
    renderReadingStatTiles(host, entry);
    this.renderControls(host, entry, context);
    renderProgressSection(host, entry, this, "wl-bdv-progress");
    this.renderEditor(host, entry, context);
    renderCustomColumns(host, entry, this);
    renderMoreLikeThis(host, entry, context);
    this.renderFooter(host, entry, context);
  }

  // --- head: cover beside the facts ----------------------------------------

  private renderHead(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    const head = host.createDiv({ cls: "wl-bdv-head" });

    const coverWrap = head.createDiv({ cls: "wl-reading-cover" });
    this.cover = renderReadingCover(coverWrap, entry, context);

    const main = head.createDiv({ cls: "wl-bdv-headmain" });

    const nameRow = main.createDiv({ cls: "wl-bdv-titlerow" });
    nameRow.createEl("h2", { cls: "wl-bdv-title", text: entry.title });
    this.renderIconActions(nameRow, entry);

    const byline = main.createDiv({ cls: "wl-bdv-byline" });
    renderAuthorLink(byline, entry, context);
    renderFactsLine(byline, entry);
    if (byline.childElementCount === 0) byline.remove();

    // The status pill is the table's pill, in the table's colour: two spellings
    // of the same state on two screens is exactly the drift this whole exercise
    // is about.
    const pills = main.createDiv({ cls: "wl-bdv-pills" });
    const status = derivedStatus(entry, this.now());
    renderPill(pills, {
      text: status,
      color: sanitizeColor(this.reading.reading.settings.statusColors?.[status] ?? ""),
      cls: "is-status",
    });
    for (const category of (entry.categories ?? []).filter((c) => c.trim() !== "")) {
      this.categoryChip(pills, category, context);
    }

    renderSynopsisProse(main, entry);
  }

  /** Favourite lives with the judgement; these are the ways *out* of the screen. */
  private renderIconActions(host: HTMLElement, entry: ReadingEntry): void {
    const row = host.createDiv({ cls: "wl-bdv-iconactions" });

    const path = (entry.filePath ?? "").trim();
    if (path !== "") {
      this.iconButton(row, "book-open", "Open the book", () =>
        openBookFile(this.app, path, entry.filePage),
      );
    }

    // Only ever through the allowlist, so a stored `javascript:` URL never
    // reaches an `href`.
    const external = safeExternalUrl(entry.externalLink ?? "");
    if (external !== "") {
      this.iconButton(row, "external-link", "Open the external link", () => {
        window.open(external, "_blank");
      });
    }
  }

  /** A category chip. Filters the shelf, exactly as the table's chips do. */
  private categoryChip(
    host: HTMLElement,
    name: string,
    context: ReadingDetailContext,
  ): void {
    const jump = context.onJumpToQuery;
    const chip = host.createSpan({
      cls: jump ? "wl-chip is-clickable" : "wl-chip",
      text: name,
    });
    if (!jump) return;
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.setAttribute("title", `Show everything in ${name}`);
    const fire = (): void => jump(`category:"${name}"`);
    chip.addEventListener("click", fire);
    chip.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      fire();
    });
  }

  // --- the one compact control row ------------------------------------------

  private renderControls(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    const row = host.createDiv({ cls: "wl-bdv-controls" });
    renderJudgementRow(row, entry, this, {
      ratingLabel: "Your rating",
      ratingCls: "wl-bdv-rating",
    });
    renderCommunitySection(row, entry, this, context);

    const buttons = row.createDiv({ cls: "wl-bdv-rowbuttons" });
    if (this.deps.onOpenNote) {
      iconTextButton(buttons, "file-text", "Open note", () =>
        this.deps.onOpenNote?.(entry, this.current.kind),
      );
    }
  }

  // --- everything editable, below the fold ---------------------------------

  private renderEditor(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    renderReadingDates(host, entry, this, context, "wl-bdv-daterow");

    const section = host.createDiv({ cls: "wl-bdv-editor" });
    renderFactFields(section, entry, this);
    const extras = section.createDiv({ cls: "wl-field-grid" });
    renderCategoriesField(extras, entry, this);
    renderFileField(extras, entry, this, this.app);
    renderDescriptionField(section, entry, this);
    renderReadingNotesField(section, entry, this);
  }

  private renderFooter(
    host: HTMLElement,
    entry: ReadingEntry,
    context: ReadingDetailContext,
  ): void {
    const footer = host.createDiv({ cls: "wl-bdv-footer" });
    renderDeleteButton(footer, entry, this, context);
  }

  private iconButton(
    host: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const button = host.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }
}

// ---------------------------------------------------------------------------
// The Obsidian leaf
// ---------------------------------------------------------------------------

/** State Obsidian round-trips through a saved workspace layout. */
interface BookDetailState {
  kind?: string;
  id?: string;
}

export class BookDetailView extends ItemView {
  private deps: () => BookDetailDeps;
  private pane: BookDetailController | null = null;
  private pending: BookDetailTarget = { kind: "book", id: "" };

  constructor(leaf: WorkspaceLeaf, deps: () => BookDetailDeps) {
    super(leaf);
    this.deps = deps;
  }

  override getViewType(): string {
    return VIEW_TYPE_BOOK_DETAIL;
  }

  override getDisplayText(): string {
    const entry = this.deps().reading.getEntry(this.pending.kind, this.pending.id);
    return entry?.title ?? (this.pending.kind === "manga" ? "Manga" : "Book");
  }

  override getIcon(): string {
    return "book-open";
  }

  override getState(): Record<string, unknown> {
    return { kind: this.pending.kind, id: this.pending.id };
  }

  override async setState(state: unknown, result: unknown): Promise<void> {
    const raw = state as BookDetailState | null;
    const id = raw?.id ?? "";
    if (id !== "") {
      this.showEntry({ kind: raw?.kind === "manga" ? "manga" : "book", id });
    }
    // The base class keeps the leaf's own bookkeeping; the target above is ours
    // and is round-tripped by `getState`.
    await super.setState(state, result as never);
  }

  showEntry(target: BookDetailTarget): void {
    this.pending = { ...target };
    if (this.pane) this.pane.setTarget(this.pending);
    else if (this.contentEl) this.mount();
  }

  override async onOpen(): Promise<void> {
    this.mount();
  }

  override async onClose(): Promise<void> {
    this.pane?.destroy();
    this.pane = null;
    this.contentEl.empty();
    this.contentEl.removeClass("wl-view", "wl-bdv-host");
  }

  private mount(): void {
    // `setViewState` and `onOpen` both land here, in either order depending on
    // how the leaf was created. Remounting a pane that is already showing the
    // right book would throw away its scroll position for nothing.
    if (
      this.pane &&
      this.pane.target.id === this.pending.id &&
      this.pane.target.kind === this.pending.kind
    ) {
      return;
    }
    const root = this.contentEl;
    root.empty();
    root.addClass("wl-view", "wl-bdv-host");
    this.pane?.destroy();
    this.pane = mountBookDetail(root, this.pending, {
      ...this.deps(),
      onClose: () => this.leaf.detach(),
    });
  }
}

// ---------------------------------------------------------------------------
// Wiring helpers — `main.ts` calls these; this module never edits it
// ---------------------------------------------------------------------------

/**
 * Whether the leaf type has been registered with Obsidian yet.
 *
 * Module-level rather than passed around because `openBookDetail` is called from
 * inside the Reading tab, which has no way of knowing what the plugin's
 * `onload` did. Without it, a call to `setViewState` for an unregistered type
 * leaves the user staring at an empty leaf; with it, the tab falls back to the
 * modal, which is a perfectly good screen and the one it has always used.
 */
let registered = false;

/** True when `openBookDetail` can actually open something. */
export function isBookDetailViewRegistered(): boolean {
  return registered;
}

/**
 * Register the leaf type. Call once from `onload()`:
 *
 * ```ts
 * registerBookDetailView(this, () => this.bookDetailDeps());
 * ```
 */
export function registerBookDetailView(
  plugin: Plugin,
  deps: () => BookDetailDeps,
): void {
  plugin.registerView(
    VIEW_TYPE_BOOK_DETAIL,
    (leaf: WorkspaceLeaf) => new BookDetailView(leaf, deps),
  );
  registered = true;
}

/**
 * Open a book in a leaf, reusing one that is already showing this view.
 *
 * Reuse rather than a new tab per book, for the same reason the title view
 * reuses: the view is a *place you look at a book*, and a workspace that
 * accumulates one leaf per book you opened is the thing everybody immediately
 * asks to turn off.
 *
 * Returns `false` when the view type is not registered, so the caller can fall
 * back rather than open an empty leaf.
 */
export async function openBookDetail(
  app: App,
  target: BookDetailTarget,
): Promise<boolean> {
  if (!registered) return false;
  const { workspace } = app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_BOOK_DETAIL);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({
    type: VIEW_TYPE_BOOK_DETAIL,
    active: true,
    state: { kind: target.kind, id: target.id },
  });
  workspace.revealLeaf(leaf);
  const view = leaf.view;
  if (view instanceof BookDetailView) view.showEntry(target);
  return true;
}
