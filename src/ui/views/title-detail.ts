/**
 * A title, as a **workspace view** rather than a modal.
 *
 * The modal survives as the fallback, but a modal is the wrong shape for this
 * content: measured in the running app, a show with a full cast wrapped its
 * chips onto five rows and pushed "Progress" below the fold, and everything was
 * one stacked column in a box narrower than the poster deserves. A real leaf has
 * the width to put the poster beside the facts, the cast on one line, and the
 * four numbers that matter — left, watched, episodes, progress — where you can
 * read them at a glance.
 *
 * **Nothing about a control is decided here.** Every field, the season grid, the
 * rating/review binding and the watched/unwatched flows come from `ui/detail/`,
 * shared verbatim with the modal. That is not tidiness: a second copy of the
 * rating/review rules is the exact defect that got reported four times, and the
 * only way to not have one is to not write one.
 *
 * `main.ts` is not edited by this module. `registerTitleDetailView` and
 * `openTitleDetail` are the two entry points it needs to call — see the wiring
 * note at the bottom of this file.
 */
import {
  ItemView,
  setIcon,
  type App,
  type Plugin,
  type WorkspaceLeaf,
} from "obsidian";
import { SAVE_DEBOUNCE_MS, STATUS_COMPLETED } from "../../constants";
import { getWatchedCount, recomputeOffsets } from "../../data/episodes";
import { imdbUrl, isSingleSitting } from "../../data/review";
import {
  DATA_CHANGED_EVENT,
  type MountHandle,
  type TitlePatch,
  type TitleV4,
  type WatchLogStoreApi,
} from "../../types";
import { yearOf } from "../components/facets";
import {
  colorFor,
  relativeTime,
  renderAiringChip,
  renderPill,
  renderPlexBadge,
  renderProgressBar,
} from "../components/pills";
import { askDelete, askUnwatch, askWatched } from "../detail/actions";
import {
  iconTextButton,
  renderDateField,
  renderNotesField,
  renderNumberField,
  renderStatusField,
} from "../detail/fields";
import {
  renderCommunityRating,
  renderRatingField,
  renderReviewField,
} from "../detail/judgement";
import {
  bindCreditLink,
  personOpener,
  type PersonOpener,
} from "../detail/people";
import { renderDetailPoster } from "../detail/poster";
import {
  markEpisodesPatch,
  plexEpisodeKeys,
  progressAffordance,
  renderSeasonBlock,
  renderSingleToggle,
  seasonsWithSkipToggled,
} from "../detail/progress";
import { renderStatTiles } from "../detail/stats";
import { isEditable, readTagList, type DetailSurface } from "../detail/surface";
import { safeExternalUrl, trailerUrlOf } from "../modals/trailer";
import { SeasonEditorModal } from "../modals/seasons";

/**
 * Deliberately *not* `watchlog-view`: that id is written into saved workspace
 * layouts and must keep meaning the tab bar. This is a second view type, added
 * alongside.
 */
export const VIEW_TYPE_TITLE_DETAIL = "watchlog-title-detail";

/** How long after leaving an input before a deferred refresh is allowed through. */
const REFRESH_RESUME_MS = 120;

/** A debounced field edit that has not reached the store yet. */
interface PendingCommit {
  timer: ReturnType<typeof setTimeout>;
  read: () => TitlePatch;
}

export interface TitleDetailDeps {
  app: App;
  store: WatchLogStoreApi;
  /** Chip → filtered Library, exactly as the modal's chips do. */
  onJumpToQuery?: (query: string) => void;
  /**
   * Cast/director name → the person screen.
   *
   * Optional because it is derived from `app` when it is absent, which is what
   * keeps this out of `main.ts`. A test passes its own and observes it.
   */
  onOpenPerson?: (name: string) => void;
  onOpenNote?: (title: TitleV4) => void;
  onOpenInPlex?: (title: TitleV4) => void;
  onRefreshMetadata?: (title: TitleV4) => void;
  onPlayTrailer?: (title: TitleV4) => void;
  onRequest?: (title: TitleV4) => void;
  /** The surface closes itself after a delete: a leaf detaches, a test spies. */
  onClose?: () => void;
  /** Injectable clock, so "Today" and "Updated …" are testable. */
  now?: () => Date;
}

export interface TitleDetailController extends MountHandle {
  /** Point the same pane at a different title without remounting it. */
  setTitleId(id: string): void;
  readonly titleId: string;
}

/**
 * The pane, independent of `ItemView`.
 *
 * Mounting is a plain function over an element for the same reason every tab in
 * this plugin is: it can be driven headlessly in a test, against a real store,
 * and assert what is actually on screen.
 */
export function mountTitleDetail(
  host: HTMLElement,
  titleId: string,
  deps: TitleDetailDeps,
): TitleDetailController {
  return new TitleDetailPane(host, titleId, deps);
}

class TitleDetailPane implements TitleDetailController, DetailSurface {
  readonly el: HTMLElement;
  readonly store: WatchLogStoreApi;

  private deps: TitleDetailDeps;
  private currentId: string;
  private bodyEl: HTMLElement;
  private pendingRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimers = new Map<string, PendingCommit>();
  private fieldValues = new Map<string, string>();
  /** Seasons the user collapsed, by index; survives a repaint. */
  private collapsed = new Set<number>();

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

  constructor(host: HTMLElement, titleId: string, deps: TitleDetailDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.currentId = titleId;
    this.el = host.createDiv({ cls: "wl-tdv" });
    this.bodyEl = this.el.createDiv({ cls: "wl-tdv-body" });

    const doc = this.el.ownerDocument;
    doc?.addEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.el.addEventListener("focusin", this.onFocusIn);
    this.el.addEventListener("focusout", this.onFocusOut);

    this.render();
  }

  get titleId(): string {
    return this.currentId;
  }

  setTitleId(id: string): void {
    if (id === this.currentId) return;
    this.flushPendingCommits();
    this.currentId = id;
    this.collapsed.clear();
    this.render();
  }

  refresh(): void {
    this.requestRefresh();
  }

  destroy(): void {
    // FIRST, before anything is torn down: a field edited less than
    // `SAVE_DEBOUNCE_MS` ago still has its patch pending, and dropping the
    // timer without applying it is silent data loss.
    this.flushPendingCommits();
    const doc = this.el.ownerDocument;
    doc?.removeEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.el.removeEventListener("focusin", this.onFocusIn);
    this.el.removeEventListener("focusout", this.onFocusOut);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.el.remove();
  }

  // -------------------------------------------------------------------------
  // Write-through plumbing — the same discipline as the modal, for the same
  // reason: a write nobody can see is indistinguishable from no write.
  // -------------------------------------------------------------------------

  patch(patch: TitlePatch, reason: string): void {
    this.store.updateTitle(this.currentId, patch, reason);
    this.requestRefresh();
  }

  debouncedPatch(key: string, read: () => TitlePatch): void {
    const existing = this.commitTimers.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.commitTimers.delete(key);
      this.patch(read(), `detail-${key}`);
    }, SAVE_DEBOUNCE_MS);
    this.commitTimers.set(key, { timer, read });
  }

  private flushPendingCommits(): void {
    const pending = [...this.commitTimers.entries()];
    this.commitTimers.clear();
    for (const [key, entry] of pending) {
      clearTimeout(entry.timer);
      try {
        this.patch(entry.read(), `detail-${key}`);
      } catch (err) {
        console.error(`[wrl] could not commit the ${key} field`, err);
      }
    }
  }

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

  private title(): TitleV4 | undefined {
    return this.store.getTitle(this.currentId);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private jump(query: string): void {
    this.deps.onJumpToQuery?.(query);
  }

  /** The person opener, or `undefined` when there is nowhere to open one. */
  private personOpen(): PersonOpener | undefined {
    return this.deps.onOpenPerson ?? personOpener(this.deps.app);
  }

  /** The filter half of a credit link, or `undefined` when nothing listens. */
  private filterFn(): ((query: string) => void) | undefined {
    if (!this.deps.onJumpToQuery) return undefined;
    return (query: string) => this.jump(query);
  }

  private fieldValue(key: string): string {
    return this.fieldValues.get(key) ?? "";
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private render(): void {
    this.pendingRefresh = false;
    const host = this.bodyEl;
    host.empty();

    const title = this.title();
    if (!title) {
      host.createDiv({
        cls: "wl-empty-body",
        text: "This title is no longer in your library.",
      });
      return;
    }

    this.renderHead(host, title);
    renderStatTiles(host, title);
    this.renderControls(host, title);
    this.renderPeople(host, title);
    this.renderDates(host, title);
    this.renderNotes(host, title);
    this.renderDelete(host, title);
    this.renderProgress(host, title);
  }

  // --- head: poster beside the facts --------------------------------------

  private renderHead(host: HTMLElement, title: TitleV4): void {
    const head = host.createDiv({ cls: "wl-tdv-head" });

    const posterWrap = head.createDiv({ cls: "wl-detail-poster" });
    renderDetailPoster(posterWrap, title);

    const main = head.createDiv({ cls: "wl-tdv-headmain" });

    const year = yearOf(title);
    const nameRow = main.createDiv({ cls: "wl-tdv-titlerow" });
    nameRow.createEl("h2", {
      cls: "wl-tdv-title",
      text: year === null ? title.title : `${title.title} (${year})`,
    });
    this.renderIconActions(nameRow, title);

    this.renderSyncRow(main, title);

    const pills = main.createDiv({ cls: "wl-tdv-pills" });
    if (title.type) {
      renderPill(pills, {
        text: title.type,
        color: colorFor(this.store.settings.types, title.type),
        cls: "is-type",
      });
    }
    renderPlexBadge(pills, title);
    renderAiringChip(pills, title);

    const studios = dedupe([...title.studio, ...title.manualStudio]);
    if (studios.length > 0) {
      const row = main.createDiv({ cls: "wl-tdv-chiprow" });
      for (const studio of studios) {
        this.linkChip(row, studio, "studio", "studio");
      }
    }

    main.createEl("p", {
      cls: "wl-tdv-overview",
      text:
        title.overview && title.overview.trim() !== ""
          ? title.overview
          : "No synopsis stored for this one yet.",
    });
  }

  /**
   * Favourite, trailer, external link — icon-only, because they sit beside the
   * name and a row of words there would compete with it.
   */
  private renderIconActions(host: HTMLElement, title: TitleV4): void {
    const row = host.createDiv({ cls: "wl-tdv-iconactions" });

    const fav = this.iconButton(
      row,
      title.favorite ? "heart-off" : "heart",
      title.favorite ? "Remove from favourites" : "Add to favourites",
      () => {
        const favorite = !title.favorite;
        this.patch(
          favorite
            ? { favorite, dateFavorited: new Date().toISOString() }
            : { favorite, dateFavorited: undefined },
          "detail-favorite",
        );
      },
    );
    fav.toggleClass("is-on", title.favorite);

    if (trailerUrlOf(title) !== "" && this.deps.onPlayTrailer) {
      this.iconButton(row, "play", "Play trailer", () =>
        this.deps.onPlayTrailer?.(title),
      );
    }

    // IMDb when the title is actually linked to one, otherwise whatever the
    // user pasted in the Link field — and only ever through the allowlist, so a
    // stored `javascript:` URL never reaches an `href`.
    const external = imdbUrl(title) || safeExternalUrl(title.externalLink ?? "");
    if (external !== "") {
      this.iconButton(row, "external-link", "Open the external link", () => {
        window.open(external, "_blank");
      });
    }

    if (this.deps.onOpenInPlex && title.plex?.ratingKey) {
      this.iconButton(row, "clapperboard", "Open in Plex", () =>
        this.deps.onOpenInPlex?.(title),
      );
    }
  }

  /**
   * "Updated 3 d ago", with the button that fixes it.
   *
   * The wording comes from `relativeTime`, the plugin's one relative-date
   * formatter — day granularity, so anything inside 24 hours reads "today".
   * A second formatter for the sake of an hours figure is not worth the
   * divergence.
   */
  private renderSyncRow(host: HTMLElement, title: TitleV4): void {
    const row = host.createDiv({ cls: "wl-tdv-syncrow" });
    const when = relativeTime(title.dateModified, this.now());
    row.createSpan({
      cls: "wl-tdv-synclabel",
      text: when === "" ? "Never updated" : `Updated ${when}`,
    });
    if (this.deps.onRefreshMetadata) {
      this.iconButton(row, "refresh-cw", "Refresh this title's metadata", () =>
        this.deps.onRefreshMetadata?.(title),
      );
    }
  }

  // --- the one compact control row ----------------------------------------

  private renderControls(host: HTMLElement, title: TitleV4): void {
    const row = host.createDiv({ cls: "wl-tdv-controls" });

    renderStatusField(row, title, this, (value) => {
      // Finishing something is the one status change that knows three other
      // things — when, how good, what you thought — so it asks for them.
      if (value === STATUS_COMPLETED && title.status !== STATUS_COMPLETED) {
        askWatched(this.deps.app, title, this);
      }
    });

    renderReviewField(row, title, this);
    renderRatingField(row, title, this, { label: "Your rating", cls: "wl-tdv-rating" });

    renderCommunityRating(row, title);

    const buttons = row.createDiv({ cls: "wl-tdv-rowbuttons" });
    if (this.deps.onOpenNote) {
      iconTextButton(buttons, "file-text", "Open note", () => this.deps.onOpenNote?.(title));
    }
    iconTextButton(buttons, "check-check", "Watched…", () =>
      askWatched(this.deps.app, title, this),
    );
    if (title.status === STATUS_COMPLETED || title.watchedEpisodes.length > 0) {
      iconTextButton(buttons, "rotate-ccw", "Not watched", () =>
        askUnwatch(this.deps.app, title, this),
      );
    }
    if (this.deps.onRequest) {
      iconTextButton(buttons, "download", "Request", () => this.deps.onRequest?.(title));
    }
  }

  // --- cast and the other name lists, inline ------------------------------

  /**
   * `Cast: Pedro Pascal, Bella Ramsey, …` on one line.
   *
   * Chips were the modal's answer and they cost five wrapped rows and ~200px on
   * a full cast. A comma-separated line of links carries the same information
   * and the same click target in one.
   */
  private renderPeople(host: HTMLElement, title: TitleV4): void {
    const section = host.createDiv({ cls: "wl-tdv-people" });
    this.inlineList(section, "Cast", dedupe([...title.cast, ...title.manualCast]), "cast");
    this.inlineList(
      section,
      "Director",
      dedupe([...title.director, ...title.manualDirector]),
      "director",
    );
    this.inlineList(section, "Genres", dedupe(title.genres ?? []), "genre");
    this.inlineList(section, "Tags", dedupe(title.tags), "tag");
    if (section.childElementCount === 0) section.remove();
  }

  /**
   * One `Label: a, b, c` line of links.
   *
   * What a link *does* is `bindCreditLink`'s, not this method's: a cast name
   * opens the person and Alt-click filters, a genre only ever filters, and the
   * decision between those is the shared module's single `isPersonField` gate
   * rather than a condition written here and again in the modal.
   */
  private inlineList(
    host: HTMLElement,
    label: string,
    values: string[],
    field: string,
  ): void {
    if (values.length === 0) return;
    const row = host.createDiv({ cls: "wl-tdv-inline" });
    row.createSpan({ cls: "wl-tdv-inline-label", text: `${label}:` });
    const openPerson = this.personOpen();
    const onFilter = this.filterFn();
    values.forEach((value, index) => {
      const link = row.createSpan({ cls: "wl-tdv-inline-link", text: value });
      bindCreditLink(link, {
        name: value,
        field,
        noun: label.toLowerCase(),
        ...(openPerson ? { openPerson } : {}),
        ...(onFilter ? { onFilter } : {}),
      });
      if (index < values.length - 1) row.createSpan({ cls: "wl-tdv-inline-sep", text: ", " });
    });
  }

  /** A studio chip. Never a person — `bindCreditLink` refuses to make it one. */
  private linkChip(host: HTMLElement, text: string, label: string, field: string): void {
    const onFilter = this.filterFn();
    // `is-clickable` only when it actually is: a chip that looks like a button
    // and does nothing is worse than a plain label.
    const chip = host.createSpan({ cls: onFilter ? "wl-chip is-clickable" : "wl-chip", text });
    bindCreditLink(chip, {
      name: text,
      field,
      noun: label,
      ...(onFilter ? { onFilter } : {}),
    });
  }

  // --- dates, inline, each with a Today button ----------------------------

  private renderDates(host: HTMLElement, title: TitleV4): void {
    const row = host.createDiv({ cls: "wl-tdv-dates" });
    const format = this.store.settings.dateFormat;
    const now = (): Date => this.now();

    // A film is watched in an evening. Two date fields for one sitting is a
    // question nobody has an interesting answer to, so films get one — and it
    // writes both, keeping every "started/finished" reader working unchanged.
    if (isSingleSitting(title)) {
      renderDateField(row, {
        label: "Watched on",
        format,
        now,
        current: title.dateFinished ?? title.dateStarted,
        onChange: (value) =>
          this.patch({ dateStarted: value, dateFinished: value }, "detail-watched-on"),
      });
    } else {
      renderDateField(row, {
        label: "Started",
        format,
        now,
        current: title.dateStarted,
        onChange: (value) => this.patch({ dateStarted: value }, "detail-started"),
      });
      renderDateField(row, {
        label: "Finished",
        format,
        now,
        current: title.dateFinished,
        onChange: (value) => this.patch({ dateFinished: value }, "detail-finished"),
      });
    }

    renderDateField(row, {
      label: "Released",
      format,
      now,
      current: title.releaseDate,
      onChange: (value) => this.patch({ releaseDate: value }, "detail-released"),
    });

    renderNumberField(row, {
      label: "Minutes per episode",
      current: title.episodeDuration,
      onChange: (value) => this.patch({ episodeDuration: value }, "detail-duration"),
    });

    // Read-only: what upstream says last aired. Not a field, because nothing
    // the user types here would be true.
    const lastAired = title.airing?.lastEpisode?.airDate;
    if (lastAired) {
      const field = row.createDiv({ cls: "wl-field wl-tdv-readonly" });
      field.createDiv({ cls: "wl-field-label", text: "Last aired" });
      field.createDiv({ cls: "wl-tdv-readonly-value", text: lastAired });
    }
  }

  private renderNotes(host: HTMLElement, title: TitleV4): void {
    renderNotesField(host, {
      current: title.notes,
      surface: this,
      cls: "wl-tdv-notes",
      onInput: (value) => this.fieldValues.set("notes", value),
      read: () => ({ notes: this.fieldValue("notes") }),
    });
    // Tags are edited as text next to the notes rather than as chips: the chips
    // above are for *going somewhere*, this is for changing what they say.
    this.fieldValues.set("tags", title.tags.join(", "));
    const tagRow = host.createDiv({ cls: "wl-tdv-tagedit" });
    const field = tagRow.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: "Tags" });
    const input = field.createEl("input", { cls: "wl-input", attr: { type: "text" } });
    input.setAttribute("aria-label", "Tags");
    input.value = title.tags.join(", ");
    input.addEventListener("input", () => {
      this.fieldValues.set("tags", input.value);
      this.debouncedPatch("tags", () => ({ tags: readTagList(this.fieldValue("tags")) }));
    });
  }

  private renderDelete(host: HTMLElement, title: TitleV4): void {
    const footer = host.createDiv({ cls: "wl-tdv-footer" });
    // Icon *and* label: a destructive action never renders as a bare coloured
    // rectangle, whatever a theme does to `.mod-warning` (QA1 B6).
    iconTextButton(
      footer,
      "trash-2",
      "Delete title",
      () =>
        askDelete(this.deps.app, title, this, getWatchedCount(title), () =>
          this.deps.onClose?.(),
        ),
      "wl-btn mod-warning",
    );
  }

  // --- progress, and the per-season accordions ----------------------------

  private renderProgress(host: HTMLElement, title: TitleV4): void {
    const affordance = progressAffordance(title);
    const section = host.createDiv({ cls: "wl-detail-section wl-tdv-progress" });
    const head = section.createDiv({ cls: "wl-detail-section-head" });
    head.createSpan({ cls: "wl-field-label", text: "Progress" });
    iconTextButton(head, "list-tree", "Edit seasons", () => {
      new SeasonEditorModal(this.deps.app, this.store, title).open();
    });

    renderProgressBar(section, title);

    if (affordance !== "season-grid") {
      const note = section.createDiv({ cls: "wl-detail-note" });
      note.setText(
        affordance === "movie-toggle"
          ? "Single entry — use the button below to mark it watched."
          : "No seasons defined yet. “Edit seasons” gives this show a per-episode grid.",
      );
      if (affordance === "movie-toggle") {
        renderSingleToggle(section, title, this.store, () => this.requestRefresh());
      }
      return;
    }

    const plexEpisodes = plexEpisodeKeys(title);
    title.seasons.forEach((season, index) => {
      renderSeasonBlock(section, {
        title,
        store: this.store,
        season,
        index,
        collapsed: this.collapsed.has(index),
        plexEpisodes,
        bulkLabels: { mark: "Mark season watched", unmark: "Unmark season" },
        onToggleCollapse: () => {
          if (this.collapsed.has(index)) this.collapsed.delete(index);
          else this.collapsed.add(index);
          this.render();
        },
        onToggleSkipped: (seasonIndex, relative) => {
          const seasons = seasonsWithSkipToggled(title, seasonIndex, relative);
          recomputeOffsets(seasons);
          this.patch({ seasons }, "detail-skip-toggled");
        },
        onWrote: () => this.requestRefresh(),
        onMarkEpisodes: (episodes, watched) =>
          this.patch(markEpisodesPatch(title, episodes, watched), "detail-season-aired"),
        now: this.now(),
      });
    });
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

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

// ---------------------------------------------------------------------------
// The Obsidian leaf
// ---------------------------------------------------------------------------

/** State Obsidian round-trips through a saved workspace layout. */
interface TitleDetailState {
  titleId?: string;
}

export class TitleDetailView extends ItemView {
  private deps: () => TitleDetailDeps;
  private pane: TitleDetailController | null = null;
  private pendingId = "";

  constructor(leaf: WorkspaceLeaf, deps: () => TitleDetailDeps) {
    super(leaf);
    this.deps = deps;
  }

  override getViewType(): string {
    return VIEW_TYPE_TITLE_DETAIL;
  }

  override getDisplayText(): string {
    const store = this.deps().store;
    return store.getTitle(this.pendingId)?.title ?? "Title";
  }

  override getIcon(): string {
    return "clapperboard";
  }

  override getState(): Record<string, unknown> {
    return { titleId: this.pendingId };
  }

  override async setState(state: unknown, result: unknown): Promise<void> {
    const next = (state as TitleDetailState | null)?.titleId ?? "";
    if (next !== "") this.showTitle(next);
    // The base class keeps the leaf's own bookkeeping; the id above is ours and
    // is round-tripped by `getState`.
    await super.setState(state, result as never);
  }

  showTitle(id: string): void {
    this.pendingId = id;
    if (this.pane) this.pane.setTitleId(id);
    else if (this.contentEl) this.mount();
  }

  override async onOpen(): Promise<void> {
    this.mount();
  }

  override async onClose(): Promise<void> {
    this.pane?.destroy();
    this.pane = null;
    this.contentEl.empty();
    this.contentEl.removeClass("wl-view", "wl-tdv-host");
  }

  private mount(): void {
    // `setViewState` and `onOpen` both land here, in either order depending on
    // how the leaf was created. Remounting a pane that is already showing the
    // right title would throw away its collapse state for nothing.
    if (this.pane && this.pane.titleId === this.pendingId) return;
    const root = this.contentEl;
    root.empty();
    root.addClass("wl-view", "wl-tdv-host");
    this.pane?.destroy();
    this.pane = mountTitleDetail(root, this.pendingId, {
      ...this.deps(),
      onClose: () => this.leaf.detach(),
    });
  }
}

// ---------------------------------------------------------------------------
// Wiring helpers — `main.ts` calls these; this module never edits it
// ---------------------------------------------------------------------------

/**
 * Register the leaf type. Call once from `onload()`:
 *
 * ```ts
 * registerTitleDetailView(this, () => this.titleDetailDeps());
 * ```
 */
export function registerTitleDetailView(
  plugin: Plugin,
  deps: () => TitleDetailDeps,
): void {
  plugin.registerView(
    VIEW_TYPE_TITLE_DETAIL,
    (leaf: WorkspaceLeaf) => new TitleDetailView(leaf, deps),
  );
}

/**
 * Open a title in a leaf, reusing one that is already showing this view.
 *
 * Reuse rather than a new tab per title: the view is a *place you look at a
 * title*, and a workspace that accumulates one leaf per film you opened is the
 * thing everybody immediately asks to turn off.
 */
export async function openTitleDetail(app: App, titleId: string): Promise<void> {
  const { workspace } = app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_TITLE_DETAIL);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({
    type: VIEW_TYPE_TITLE_DETAIL,
    active: true,
    state: { titleId },
  });
  workspace.revealLeaf(leaf);
  const view = leaf.view;
  if (view instanceof TitleDetailView) view.showTitle(titleId);
}
