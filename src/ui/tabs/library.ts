/**
 * The Library tab — the main list, and the surface every other component plugs
 * into (SPEC §4.5).
 *
 * The whole pipeline is one line, exactly as in foodspot:
 *
 *     results = engine.sort(engine.filter(all, query, filterState), sort, secondary)
 *
 * Everything else in this file is chrome around that: the toolbar, two view
 * modes, select mode with a bulk bar, and the mount-handle wiring that lets the
 * view refresh or tear the whole thing down without leaking an observer.
 *
 * Ownership note: the search/filter/sort implementation arrives from another lane
 * as a `LibraryEngine` (see `components/engine.ts`). Nothing here reaches past
 * that interface, so swapping the stand-in for the real modules touches one line.
 */
import { Menu, Notice, setIcon, type App } from "obsidian";
import { CARD_SIZE_OFFSET, CARD_SIZE_PX } from "../../constants";
import type {
  OverseerrClient,
  OverseerrSearchResult,
  Preset,
  SortSpec,
  TabController,
  TitleV4,
  WatchLogStoreApi,
} from "../../types";
import { buildTitleCard, type CardCtx } from "../components/card";
import { createFiltersControl } from "../components/filters";
import { createPosterLoader } from "../components/posters";
import { createSearchBox } from "../components/searchbox";
import { createSortButton } from "../components/sortmenu";
import { createVirtualGrid, type VirtualGridHandle } from "../components/virtual";
import { createFallbackEngine, type LibraryEngine } from "../components/engine";
import { clearFilters, isFilterActive, plexStateOf, yearOf } from "../components/facets";
import { renderFirstRunEmpty, renderNoMatchEmpty } from "../components/empty";
import { colorFor, plexBadge, progressText, renderPill } from "../components/pills";
import { AddTitleModal } from "../modals/add";
import { confirmAction } from "../modals/confirm";
import { DetailModal, type MoreLikeThis } from "../modals/detail";
import { createPresetButton, clonePresetView, type PresetView } from "../modals/preset";
import { SearchTipsModal } from "../modals/tips";

const GRID_GAP = 12;

export interface LibraryDeps {
  app: App;
  store: WatchLogStoreApi;
  /** Defaults to the stand-in in `components/engine.ts`. */
  engine?: LibraryEngine;
  /** Powers search in the Add modal; absent means manual entry only. */
  overseerr?: OverseerrClient;
  onRequest?: (title: TitleV4) => void;
  onPlayTrailer?: (title: TitleV4) => void;
  /**
   * Open a title. Absent means "use the detail modal", which is what the
   * Library has always done and what a standalone mount (tests, any host that
   * wires no root) still gets.
   *
   * The composition root supplies this so the Library obeys the same
   * `openTitlesInFullView` choice as every other surface — otherwise the one
   * grid people spend their time in would be the only place the setting did
   * nothing.
   */
  onOpenTitle?: (title: TitleV4) => void;
  onOpenNote?: (title: TitleV4) => void;
  onOpenInPlex?: (title: TitleV4) => void;
  onOpenInOverseerr?: (title: TitleV4) => void;
  onRefreshMetadata?: (title: TitleV4) => void;
  /** Open the manual TMDB picker for a title that has no id yet. */
  onFindMatch?: (title: TitleV4) => void;
  /** "More like this" inside a title's detail view; absent hides the section. */
  onMoreLikeThis?: (title: TitleV4) => Promise<MoreLikeThis[]>;
  onAddSuggestion?: (result: OverseerrSearchResult) => Promise<TitleV4 | undefined>;
  onDismissSuggestion?: (tmdbId: number) => void;
  /**
   * Open the Drafts panel into `host` (W8-extras owns the panel itself).
   * Absent means the scanner is not built/enabled and no button is shown.
   */
  onOpenDrafts?: (host: HTMLElement) => void;
  /** Pending draft count for the toolbar badge. */
  draftCount?: () => number;
  /**
   * Open the Add modal. Supplied by the composition root so the Library's own
   * Add button gets the same post-add Plex/airing refresh as every other entry
   * point; `afterAdd` is how the Library still lands on the new title.
   */
  onAddTitle?: (afterAdd: (title: TitleV4) => void) => void;
  /** Roll a random title from the watchable backlog. Absent means no button. */
  onSurprise?: () => void;
  /**
   * One additive seam for surfaces the Library hosts but does not own — today
   * that is Groups (W8-extras). Called once after the tab is built, and its
   * return value is run on teardown.
   *
   * It is a seam rather than a feature so the Library keeps knowing nothing
   * about groups: it lends a chip row, a drawer, a predicate and a bulk button,
   * and the module on the other side decides what any of it means.
   */
  onMountExtras?: (ext: LibraryExtensions) => (() => void) | void;
}

/** What `onMountExtras` is handed. Everything on it is already wired. */
export interface LibraryExtensions {
  /** A row above the results, for chips owned by another module. */
  chipsHost: HTMLElement;
  /** Where a panel drops in — the same host the filter drawer uses. */
  drawerHost: HTMLElement;
  toolbar: HTMLElement;
  /** Re-run filter → sort → render. */
  refresh(): void;
  /** An extra predicate applied after the engine's own filter. `null` clears it. */
  setExtraFilter(predicate: ((title: TitleV4) => boolean) | null): void;
  /** Title ids currently ticked in select mode. */
  selection(): string[];
  exitSelectMode(): void;
  /** Add a button to the bulk bar, alongside Status/Tag/Favourite/Delete. */
  addBulkAction(label: string, icon: string, onClick: (ids: string[], event: MouseEvent) => void): void;
}

export interface LibraryController extends TabController {
  /** The cross-tab handoff: a chip elsewhere hands us a scoped query. */
  applyQuery(query: string): void;
}

export function mountLibraryTab(
  container: HTMLElement,
  deps: LibraryDeps,
): LibraryController {
  const { app, store } = deps;
  const settings = store.settings;
  const engine = deps.engine ?? createFallbackEngine(settings);

  const el = container.createDiv({ cls: "wl-library" });
  const toolbar = el.createDiv({ cls: "wl-toolbar" });
  const drawerHost = el.createDiv({ cls: "wl-filter-host" });
  const chipsHost = el.createDiv({ cls: "wl-chips-host" });
  const infoBar = el.createDiv({ cls: "wl-infobar" });
  const resultsHost = el.createDiv({ cls: "wl-results" });
  const bulkBar = el.createDiv({ cls: "wl-bulk-bar is-hidden" });

  let query = "";
  let results: TitleV4[] = [];
  let selectMode = false;
  const selected = new Set<string>();
  /** Set by `onMountExtras`; applied after the engine, before rendering. */
  let extraFilter: ((title: TitleV4) => boolean) | null = null;

  const posterLoader = createPosterLoader({ rootMargin: "400px" });

  // --- toolbar ------------------------------------------------------------

  const searchBox = createSearchBox(toolbar, {
    value: query,
    onChange: (value) => {
      query = value;
      render();
    },
    onTips: () => new SearchTipsModal(app).open(),
  });

  const filters = createFiltersControl(toolbar, {
    state: settings.filterState,
    settings,
    getTitles: () => store.allTitles(),
    onChange: () => render(),
    onPersist: () => store.save("filter-state"),
    panelHost: drawerHost,
  });

  const presets = createPresetButton(toolbar, {
    app,
    getPresets: () => settings.savedPresets,
    getView: (): PresetView => ({
      query,
      filters: settings.filterState,
      sort: settings.sort,
      secondarySort: settings.secondarySort,
    }),
    onApply: (preset: Preset) => applyPreset(preset),
    onChange: (next) => {
      settings.savedPresets = next;
      store.save("presets");
      presets.refresh();
    },
  });

  const sortButton = createSortButton(toolbar, {
    getSort: () => settings.sort,
    getSecondary: () => settings.secondarySort,
    onChange: (sort: SortSpec, secondary: SortSpec | null) => {
      settings.sort = sort;
      settings.secondarySort = secondary;
      store.save("sort");
      render();
    },
  });

  const viewToggle = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-view-toggle",
    attr: { type: "button" },
  });
  const syncViewToggle = (): void => {
    const grid = settings.libraryViewMode === "grid";
    viewToggle.empty();
    // The icon shows the *destination*, not the current mode.
    setIcon(viewToggle, grid ? "table" : "layout-grid");
    const label = grid ? "Switch to table view" : "Switch to poster grid";
    viewToggle.setAttribute("aria-label", label);
    viewToggle.setAttribute("title", label);
  };
  viewToggle.addEventListener("click", () => {
    settings.libraryViewMode = settings.libraryViewMode === "grid" ? "table" : "grid";
    store.save("library-view-mode");
    syncViewToggle();
    render();
  });
  syncViewToggle();

  const selectToggle = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-select-toggle",
    attr: { type: "button", "aria-label": "Select titles", title: "Select titles" },
  });
  setIcon(selectToggle, "check-square");
  selectToggle.addEventListener("click", () => setSelectMode(!selectMode));

  if (deps.onSurprise) {
    const surpriseButton = toolbar.createEl("button", {
      cls: "wl-btn wl-icon-btn wl-surprise-btn",
      attr: {
        type: "button",
        "aria-label": "Surprise me — pick something to watch",
        title: "Surprise me — pick something to watch",
      },
    });
    setIcon(surpriseButton, "dices");
    surpriseButton.addEventListener("click", () => deps.onSurprise?.());
  }

  toolbar.createDiv({ cls: "wl-toolbar-spacer" });

  /**
   * Drafts (SPEC2-PARITY.md §D-EXTRAS).
   *
   * v3 gave drafts a whole tab; here it is a panel behind a toolbar button,
   * because a triage queue is something you visit *from* the library you are
   * filing into, not a place to be. The button carries the pending count as a
   * badge — and only exists once the scanner does, so nothing here claims a
   * feature that is not built.
   */
  if (deps.onOpenDrafts) {
    const draftsButton = toolbar.createEl("button", {
      cls: "wl-btn wl-icon-btn wl-drafts-btn",
      attr: { type: "button", "aria-label": "Drafts", title: "Drafts found in your notes" },
    });
    setIcon(draftsButton, "square-pen");
    const count = deps.draftCount?.() ?? 0;
    if (count > 0) {
      draftsButton.createSpan({ cls: "wl-drafts-badge", text: String(Math.min(99, count)) });
    }
    draftsButton.addEventListener("click", () => deps.onOpenDrafts?.(drawerHost));
  }

  const addButton = toolbar.createEl("button", {
    cls: "wl-btn mod-cta wl-add-btn",
    attr: { type: "button" },
  });
  const addIcon = addButton.createSpan({ cls: "wl-btn-icon" });
  setIcon(addIcon, "plus");
  addButton.createSpan({ cls: "wl-btn-label", text: "Add" });
  addButton.addEventListener("click", () => openAdd());

  const counterEl = infoBar.createDiv({ cls: "wl-results-info" });

  // --- card context -------------------------------------------------------

  function cardContext(): CardCtx {
    return {
      store,
      variant: "full",
      showActions: true,
      showPlexBadge: true,
      showAiringChip: true,
      showProgress: true,
      showRating: true,
      embedded: false,
      posterLoader,
      onOpen: (title) => openDetail(title),
      onJumpToQuery: (q) => applyQuery(q),
      onRequest: deps.onRequest,
      onPlayTrailer: deps.onPlayTrailer,
      onOpenNote: deps.onOpenNote,
      onEdit: (title) => openDetail(title),
      onTogglePin: (title) =>
        store.updateTitle(title.id, { pinned: !title.pinned }, "pin-toggled"),
      onOpenInPlex: deps.onOpenInPlex,
      onOpenInOverseerr: deps.onOpenInOverseerr,
      onRefreshMetadata: deps.onRefreshMetadata,
      onFindMatch: deps.onFindMatch,
      onDelete: (title) => confirmDelete([title]),
    };
  }

  function openDetail(title: TitleV4): void {
    if (deps.onOpenTitle) {
      deps.onOpenTitle(title);
      return;
    }
    new DetailModal(app, {
      store,
      titleId: title.id,
      onJumpToQuery: (q) => applyQuery(q),
      onPlayTrailer: deps.onPlayTrailer,
      onRequest: deps.onRequest,
      onOpenNote: deps.onOpenNote,
      onOpenInPlex: deps.onOpenInPlex,
      onRefreshMetadata: deps.onRefreshMetadata,
      onFindMatch: deps.onFindMatch,
      onMoreLikeThis: deps.onMoreLikeThis,
      onAddSuggestion: deps.onAddSuggestion,
      onDismissSuggestion: deps.onDismissSuggestion,
    }).open();
  }

  function openAdd(): void {
    // Land on the thing you just added rather than wherever you were.
    const afterAdd = (title: TitleV4): void => {
      if (settings.openLibraryAfterAdd) openDetail(title);
    };
    if (deps.onAddTitle) {
      deps.onAddTitle(afterAdd);
      return;
    }
    // Standalone fallback (tests, and any host that wires no root).
    new AddTitleModal(app, {
      store,
      client: deps.overseerr,
      onAdded: (result) => afterAdd(result.title),
    }).open();
  }

  // --- presets / query handoff -------------------------------------------

  function applyPreset(preset: Preset): void {
    const view = clonePresetView({
      query: preset.query,
      filters: preset.filters,
      sort: preset.sort,
      secondarySort: preset.secondarySort,
    });
    query = view.query;
    // Mutate the live filter object — settings holds this exact reference.
    Object.assign(settings.filterState, view.filters);
    settings.sort = view.sort;
    settings.secondarySort = view.secondarySort;
    searchBox.setValue(query);
    filters.refresh();
    sortButton.refresh();
    store.save("preset-applied");
    render();
  }

  function applyQuery(next: string): void {
    query = next;
    searchBox.setValue(next);
    render();
  }

  function clearEverything(): void {
    query = "";
    searchBox.setValue("");
    clearFilters(settings.filterState);
    filters.refresh();
    store.save("filters-cleared");
    render();
  }

  // --- select mode --------------------------------------------------------

  function setSelectMode(next: boolean): void {
    selectMode = next;
    if (!next) selected.clear();
    el.toggleClass("wl-select-mode", selectMode);
    selectToggle.toggleClass("is-on", selectMode);
    bulkBar.toggleClass("is-hidden", !selectMode);
    render();
  }

  /**
   * Capture phase on purpose: in select mode a click must toggle selection and
   * never reach the card's own "open details" handler.
   */
  const onResultsClickCapture = (event: MouseEvent): void => {
    if (!selectMode) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const card = target.closest<HTMLElement>("[data-title-id]");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    const id = card.dataset.titleId;
    if (!id) return;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    card.toggleClass("is-selected", selected.has(id));
    syncBulkBar();
  };
  resultsHost.addEventListener("click", onResultsClickCapture, true);

  const bulkCount = bulkBar.createSpan({ cls: "wl-bulk-count" });

  function bulkButton(label: string, icon: string, onClick: (event: MouseEvent) => void): HTMLElement {
    const button = bulkBar.createEl("button", { cls: "wl-btn wl-small-btn", attr: { type: "button" } });
    const iconEl = button.createSpan({ cls: "wl-btn-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ cls: "wl-btn-label", text: label });
    button.addEventListener("click", onClick);
    return button;
  }

  bulkButton("All", "check-check", () => {
    for (const title of results) selected.add(title.id);
    render();
  });

  bulkButton("Status", "circle-dot", (event) => {
    const menu = new Menu();
    for (const status of settings.statuses) {
      menu.addItem((item) =>
        item.setTitle(status.name).onClick(() => {
          for (const id of selected) store.updateTitle(id, { status: status.name }, "bulk-status");
          new Notice(`${selected.size} title(s) set to ${status.name}`);
          setSelectMode(false);
        }),
      );
    }
    menu.showAtMouseEvent(event);
  });

  const tagWrap = bulkBar.createDiv({ cls: "wl-bulk-tag is-hidden" });
  const tagInput = tagWrap.createEl("input", {
    cls: "wl-input",
    attr: { type: "text", placeholder: "Tag name", "aria-label": "Tag to add" },
  });
  tagInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      tagWrap.addClass("is-hidden");
      tagInput.value = "";
      return;
    }
    if (event.key !== "Enter") return;
    const tag = tagInput.value.trim();
    if (tag === "") return;
    for (const id of selected) {
      const title = store.getTitle(id);
      if (!title || title.tags.includes(tag)) continue;
      store.updateTitle(id, { tags: [...title.tags, tag] }, "bulk-tag");
    }
    new Notice(`Tagged ${selected.size} title(s) “${tag}”`);
    tagInput.value = "";
    tagWrap.addClass("is-hidden");
    setSelectMode(false);
  });

  bulkButton("Tag", "tag", () => {
    tagWrap.removeClass("is-hidden");
    tagInput.focus();
  });

  bulkButton("Favourite", "heart", () => {
    const now = new Date().toISOString();
    for (const id of selected) {
      store.updateTitle(id, { favorite: true, dateFavorited: now }, "bulk-favorite");
    }
    setSelectMode(false);
  });

  const deleteButton = bulkButton("Delete", "trash-2", () => {
    const titles = [...selected]
      .map((id) => store.getTitle(id))
      .filter((t): t is TitleV4 => t !== undefined);
    void confirmDelete(titles).then(() => setSelectMode(false));
  });
  deleteButton.addClass("mod-warning");

  bulkButton("Done", "x", () => setSelectMode(false));

  function syncBulkBar(): void {
    bulkCount.setText(`${selected.size} selected`);
  }

  async function confirmDelete(titles: TitleV4[]): Promise<void> {
    if (titles.length === 0) return;
    const one = titles.length === 1 ? titles[0] : undefined;
    const result = await confirmAction(app, {
      title: one ? `Delete “${one.title}”?` : `Delete ${titles.length} titles?`,
      message: "They are removed from your library and from any groups they belong to.",
      details: ["Your `data.json` backup from before the v4 migration is untouched."],
      confirmText: "Delete",
      danger: true,
    });
    if (!result.confirmed) return;
    for (const title of titles) store.deleteTitle(title.id);
  }

  // --- rendering ----------------------------------------------------------

  let grid: VirtualGridHandle<TitleV4> | null = null;

  function render(): void {
    grid?.destroy();
    grid = null;
    resultsHost.empty();

    const all = store.allTitles();
    const filtered = engine.filter(all, query, settings.filterState);
    results = engine.sort(
      extraFilter ? filtered.filter(extraFilter) : filtered,
      settings.sort,
      settings.secondarySort,
    );

    // Drop selections whose titles no longer survive the filter.
    for (const id of [...selected]) {
      if (!results.some((t) => t.id === id)) selected.delete(id);
    }
    syncBulkBar();
    renderCounter(all.length);

    if (all.length === 0) {
      renderFirstRunEmpty(resultsHost, () => openAdd());
      return;
    }
    if (results.length === 0) {
      renderNoMatchEmpty(resultsHost, () => clearEverything());
      return;
    }

    if (settings.libraryViewMode === "table") renderTable();
    else renderGrid();
  }

  function renderCounter(total: number): void {
    const filtered =
      query.trim() !== "" || isFilterActive(settings.filterState) || extraFilter !== null;
    const noun = total === 1 ? "title" : "titles";
    // The always-on signal that a filter is doing something (convention 9).
    counterEl.setText(
      filtered ? `${results.length} of ${total} ${noun}` : `${total} ${noun}`,
    );
  }

  function renderGrid(): void {
    const ctx = cardContext();
    const minWidth = CARD_SIZE_PX[settings.cardSize + CARD_SIZE_OFFSET] ?? 160;
    const handle = createVirtualGrid<TitleV4>(resultsHost, {
      minCellWidth: minWidth,
      gap: GRID_GAP,
      // 2:3 poster, text overlaid on the scrim — the cell is the poster.
      cellHeight: (width) => Math.round(width * 1.5),
      onUnmount: (cell) => {
        const poster = cell.querySelector<HTMLElement>(".wl-poster");
        if (poster) posterLoader.unobserve(poster);
      },
      renderCell: (title, cell) => {
        const card = buildTitleCard(cell, title, ctx);
        card.toggleClass("is-selected", selected.has(title.id));
      },
    });
    handle.setItems(results);
    grid = handle;
  }

  function renderTable(): void {
    const wrap = resultsHost.createDiv({ cls: "wl-tablewrap" });
    const table = wrap.createEl("table", { cls: "wl-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of ["Title", "Type", "Status", "Year", "Rating", "Progress", "Plex"]) {
      head.createEl("th", { text: label });
    }
    const body = table.createEl("tbody");

    for (const title of results) {
      const row = body.createEl("tr", { cls: "wl-table-row" });
      row.dataset.titleId = title.id;
      row.toggleClass("is-selected", selected.has(title.id));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      row.createEl("td", { cls: "wl-table-title", text: title.title });

      const typeCell = row.createEl("td");
      if (title.type) {
        renderPill(typeCell, {
          text: title.type,
          color: colorFor(settings.types, title.type),
          cls: "is-type",
        });
      }

      const statusCell = row.createEl("td");
      if (title.status) {
        renderPill(statusCell, {
          text: title.status,
          color: colorFor(settings.statuses, title.status),
          cls: "is-status",
        });
      }

      const year = yearOf(title);
      row.createEl("td", { text: year === null ? "—" : String(year) });
      row.createEl("td", { text: title.rating > 0 ? `★ ${title.rating}` : "—" });
      row.createEl("td", { text: progressText(title) || "—" });

      const badge = plexBadge(title);
      row.createEl("td", {
        text: badge ? badge.text : plexStateOf(title) === "none" ? "—" : "?",
      });

      const open = (): void => {
        if (selectMode) return;
        openDetail(title);
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }

  render();

  // Hosted-but-not-owned surfaces, last so everything above them is live.
  const teardownExtras = deps.onMountExtras?.({
    chipsHost,
    drawerHost,
    toolbar,
    refresh: () => render(),
    setExtraFilter: (predicate) => {
      extraFilter = predicate;
    },
    selection: () => [...selected],
    exitSelectMode: () => setSelectMode(false),
    addBulkAction: (label, icon, onClick) => {
      bulkButton(label, icon, (event) => onClick([...selected], event));
    },
  });

  return {
    id: "library",
    el,
    applyQuery,
    refresh(): void {
      filters.refresh();
      presets.refresh();
      sortButton.refresh();
      syncViewToggle();
      render();
    },
    destroy(): void {
      teardownExtras?.();
      grid?.destroy();
      grid = null;
      resultsHost.removeEventListener("click", onResultsClickCapture, true);
      searchBox.destroy();
      filters.destroy();
      presets.destroy();
      sortButton.destroy();
      posterLoader.destroy();
      el.remove();
    },
  };
}
