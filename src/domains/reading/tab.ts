/**
 * The Reading tab — Books and Manga, each a full library of its own.
 *
 * The pipeline is the Library's, one line long:
 *
 *     rows = sortReading(search.filter(applyReadingFilters(all, facets), query), sort, secondary)
 *
 * and everything else here is chrome around it: two sub-tabs, the standard
 * toolbar (search · filters · saved views · sort · columns · add), a table whose
 * columns the user defines, and the mount-handle wiring that lets the view
 * refresh or tear the whole thing down without stranding an observer.
 *
 * Reuse, not fork (SPEC2 ground rules): the search box, the saved-view button,
 * the star widget, the poster loader, the empty-state discipline and the pill
 * renderer are all the shared components. What is local is what is genuinely
 * reading-shaped — the facet set, the sort axes, and a table of custom columns.
 *
 * Sub-tab, query, facets and sort persist in `data.reading.settings` (with the
 * two view keys parked in the round-tripped remainder), so reopening the tab
 * lands where you left it.
 */
import { Menu, setIcon, type App } from "obsidian";
import {
  readExtra,
  writeExtra,
  type CustomColumn,
  type DateFormat,
  type BookSuggestionHit,
  type GoogleBooksClient,
  type LibraryViewMode,
  type OpenLibraryClient,
  type Preset,
  type ReadingKind,
  type ReadingPatch,
  type Settings,
  type SortSpec,
  type TabController,
  type WatchLogStoreApi,
} from "../../types";
import { createSearchBox } from "../../ui/components/searchbox";
import { createPosterLoader } from "../../ui/components/posters";
import { createVirtualGrid, type VirtualGridHandle } from "../../ui/components/virtual";
import { CARD_SIZE_OFFSET, CARD_SIZE_PX } from "../../constants";
import { CoverPool, type CoverCache, type CoverHandle } from "./covers";
import {
  buildBookCard,
  compactProgress,
  renderReadingCover,
  type BookCardCtx,
  type ReadingCoverDeps,
} from "./card";
import { fetchCoverBytes } from "./coverfetch";
import { openBookFile } from "./bookfile";
import {
  READ_HINT,
  chapterLabel,
  currentChapter,
  openReadMenu,
  openStudyShortcut,
  popoutRequested,
  readRequestFor,
  POPOUT_HINT,
  READ_BUTTONS,
  type ReadRequest,
  type StudyContext,
} from "./study";
import { formatCommunityRating } from "./community";
import { createStars } from "../../ui/components/stars";
import { renderEmptyState } from "../../ui/components/empty";
import { renderPill, sanitizeColor } from "../../ui/components/pills";
import { createPresetButton, makePresetId, type PresetView } from "../../ui/modals/preset";
import {
  columnDisplay,
  columnStyleClass,
  toggleBuiltInColumn,
  visibleBuiltInColumns,
} from "./columns";
import { ReadingColumnsModal } from "./modals/columns";
import { AddReadingModal } from "./modals/add";
import { ReadingDetailModal } from "./modals/detail";
import {
  isBookDetailViewRegistered,
  openBookDetail,
} from "../../ui/views/book-detail";
import {
  bumpPatch,
  derivedStatus,
  isBook,
  primaryCounter,
  progressLabel,
  readingProgress,
  totalPatchFor,
  type ReadingEntry,
} from "./progress";
import { fillPageCountsFromFiles } from "./pdfpages";
import type { BookSuggestion } from "./suggest";
import { ReadingSearchEngine } from "./query";
import { createReadingStore, type ReadingStore } from "./store";
import {
  applyReadingFilters,
  assignReadingFilters,
  clearReadingFilters,
  cloneReadingFilters,
  countActiveReadingFilters,
  createReadingFilterState,
  defaultReadingSort,
  fromPreset,
  isReadingFilterActive,
  nextReadingSort,
  readingFacetOptions,
  readingSortLabel,
  toggleReadingFacet,
  toPreset,
  READING_SORT_KEYS,
  sortReading,
  type ReadingFacetField,
  type ReadingFilterState,
} from "./viewstate";

export interface ReadingDeps {
  app: App;
  store: WatchLogStoreApi;
  /** Supplied by the composition root so the note mirror is wired; else built here. */
  reading?: ReadingStore;
  openLibrary?: OpenLibraryClient;
  googleBooks?: GoogleBooksClient;
  /**
   * The optional local artwork cache (`services/imagecache.ts`), the same
   * instance the Library's posters use. Absent — the default, because the
   * setting is off — leaves every cover on the path it takes today.
   */
  imageCache?: CoverCache;
  /** Open (creating if needed) the generated note. Absent when notes are off. */
  onOpenNote?: (entry: ReadingEntry, kind: ReadingKind) => void;
  /** "More like this" inside a book's detail view; absent hides the section. */
  onMoreLikeThis?: (entry: ReadingEntry) => Promise<BookSuggestion[]>;
  onAddSuggestion?: (hit: BookSuggestionHit) => Promise<boolean>;
  onDismissSuggestion?: (key: string) => void;
}

/** Where the view keys live inside the round-tripped reading settings. */
const SUBTAB_KEY = "activeSubTab";
const VIEW_STATE_KEY = "viewState";
/**
 * Grid or table, for **both** shelves.
 *
 * Not per-shelf, unlike the query/filters/sort beside it. Those describe a
 * *library* — excluding an author on the books shelf must not silently filter
 * the manga one — but "I want to see covers" describes the person, not the
 * shelf, and both shelves are covers either way. Same argument
 * `openTitlesInFullView` makes for full views: one switch somebody already
 * understands beats a second one that says the same thing about manga.
 */
const VIEW_MODE_KEY = "viewMode";

/**
 * Set once, when a shelf that predates the poster grid is carried onto it.
 *
 * Separate from `VIEW_MODE_KEY` on purpose: the mode is an answer that changes
 * every time the toggle is pressed, and this records that the question was
 * asked at all. Reading the mode alone cannot tell "table because they chose
 * it" from "table because that is all there used to be".
 */
const GRID_DEFAULT_MARKER = "viewModeGridDefault";

/** The gap between cards, matching the Library's grid exactly. */
const GRID_GAP = 12;

/** How many category chips a table row shows before it starts counting. */
const CATEGORY_CHIP_LIMIT = 2;

/**
 * Built-in columns the reader has switched off, per shelf.
 *
 * Per shelf for the same reason the custom columns are: books and manga are
 * two libraries, and the modal that edits them is already one per shelf. It
 * records what is HIDDEN, so a built-in added in a later version shows up the
 * moment it exists — see `visibleBuiltInColumns`.
 */
const HIDDEN_COLUMNS_KEY = "hiddenColumns";

interface PersistedViewState {
  query?: string;
  filters?: ReadingFilterState;
  sort?: SortSpec;
  secondarySort?: SortSpec | null;
}

/**
 * The Reading tab, with the same cross-tab handoff the Library has.
 *
 * A chip in a book's detail modal (`author:"Frank Herbert"`) has to land on the
 * Reading tab filtered, not on the Library — so the controller exposes the same
 * `applyQuery` the Library does and `view.ts` routes per domain
 * (SPEC2 §"Surfaces that grow").
 */
export interface ReadingController extends TabController {
  applyQuery(query: string): void;
}

export function mountReadingTab(container: HTMLElement, deps: ReadingDeps): ReadingController {
  const { app, store } = deps;
  const settings: Settings = store.settings;
  const reading = deps.reading ?? createReadingStore(store);

  const el = container.createDiv({ cls: "wl-tab-panel wl-tab-panel-reading" });
  const subTabBar = el.createDiv({ cls: "wl-reading-subtabs" });
  const toolbar = el.createDiv({ cls: "wl-toolbar" });
  const drawerHost = el.createDiv({ cls: "wl-filter-host" });
  const infoBar = el.createDiv({ cls: "wl-infobar" });
  const resultsHost = el.createDiv({ cls: "wl-results wl-reading-results" });

  const posterLoader = createPosterLoader({ rootMargin: "400px" });
  /** Object URLs for proxied Open Library covers; released on every re-render. */
  const covers = new CoverPool();

  // --- view state ---------------------------------------------------------

  let kind: ReadingKind = readKind();
  let viewMode: LibraryViewMode = readViewMode();
  const state = readViewState(kind);
  let query = state.query;
  let filters = state.filters;
  let sort = state.sort;
  let secondarySort = state.secondarySort;
  let rows: ReadingEntry[] = [];
  /** The mounted poster grid, when the tab is in grid mode. */
  let grid: VirtualGridHandle<ReadingEntry> | null = null;
  /** Set on teardown; async work checks it before touching anything. */
  let destroyed = false;
  let drawerOpen = false;

  function readKind(): ReadingKind {
    const raw = readExtra<string>(reading.reading.settings, SUBTAB_KEY);
    return raw === "manga" ? "manga" : "book";
  }

  /**
   * The view mode, and the one-time move to the poster grid.
   *
   * Reading opens as covers, like the Library — that is the point of the grid
   * existing. The first version of this hedged, keeping an existing shelf on
   * the table on the grounds that turning a 300-book list into a wall of covers
   * unasked is a surprise rather than a default. It was asked for.
   *
   * So the grid is simply the default now, and `GRID_DEFAULT_MARKER` carries a
   * shelf that predates it across exactly once — the same guard shape as the
   * `openTitlesInFullView` flip in `data/migrate.ts`, and for the same reason:
   * the *stored* answer would otherwise win forever, so raising the default
   * alone would be invisible to everybody who already has the plugin.
   *
   * The marker, not the stored value, is the guard. Once it is on disk this
   * never runs again, so a later "no, table please" is the reader's own answer
   * and is never overruled.
   */
  function readViewMode(): LibraryViewMode {
    const settings = reading.reading.settings;
    if (readExtra<unknown>(settings, GRID_DEFAULT_MARKER) !== true) {
      writeExtra(settings, GRID_DEFAULT_MARKER, true);
      writeExtra(settings, VIEW_MODE_KEY, "grid");
      store.save("reading-view-mode");
      return "grid";
    }
    const raw = readExtra<string>(settings, VIEW_MODE_KEY);
    if (raw === "grid" || raw === "table") return raw;
    writeExtra(settings, VIEW_MODE_KEY, "grid");
    store.save("reading-view-mode");
    return "grid";
  }

  /**
   * The persisted view, per sub-tab.
   *
   * Books and manga are different libraries with different columns, so they get
   * different saved views — one shared filter state would mean excluding an
   * author on one shelf silently filtering the other.
   */
  function readViewState(forKind: ReadingKind): {
    query: string;
    filters: ReadingFilterState;
    sort: SortSpec;
    secondarySort: SortSpec | null;
  } {
    const all = readExtra<Record<string, PersistedViewState>>(reading.reading.settings, VIEW_STATE_KEY);
    const saved = all?.[forKind];
    const base = createReadingFilterState();
    if (saved?.filters) assignReadingFilters(base, { ...base, ...saved.filters });
    return {
      query: saved?.query ?? "",
      filters: base,
      sort: saved?.sort ?? defaultReadingSort(),
      secondarySort: saved?.secondarySort ?? null,
    };
  }

  function persistViewState(): void {
    const all =
      readExtra<Record<string, PersistedViewState>>(reading.reading.settings, VIEW_STATE_KEY) ?? {};
    all[kind] = {
      query,
      filters: cloneReadingFilters(filters),
      sort: { ...sort },
      secondarySort: secondarySort ? { ...secondarySort } : null,
    };
    writeExtra(reading.reading.settings, VIEW_STATE_KEY, all);
    store.save("reading-view-state");
  }

  function columns(): CustomColumn[] {
    return reading.columns(kind);
  }

  function hiddenColumns(): string[] {
    const all = readExtra<Record<string, string[]>>(reading.reading.settings, HIDDEN_COLUMNS_KEY);
    return all?.[kind] ?? [];
  }

  function setHiddenColumns(next: string[]): void {
    const all =
      readExtra<Record<string, string[]>>(reading.reading.settings, HIDDEN_COLUMNS_KEY) ?? {};
    all[kind] = next;
    writeExtra(reading.reading.settings, HIDDEN_COLUMNS_KEY, all);
    store.save("reading-hidden-columns");
  }

  function pool(): readonly ReadingEntry[] {
    return kind === "book" ? reading.allBooks() : reading.allManga();
  }

  // --- sub-tabs -----------------------------------------------------------

  function buildSubTabs(): void {
    subTabBar.empty();
    const make = (id: ReadingKind, label: string, icon: string): void => {
      const button = subTabBar.createEl("button", {
        cls: "wl-reading-subtab",
        attr: { type: "button", "aria-label": label },
      });
      button.toggleClass("is-active", kind === id);
      const iconEl = button.createSpan({ cls: "wl-reading-subtab-icon" });
      setIcon(iconEl, icon);
      button.createSpan({ cls: "wl-reading-subtab-label", text: label });
      const count = id === "book" ? reading.allBooks().length : reading.allManga().length;
      button.createSpan({ cls: "wl-reading-subtab-count", text: String(count) });
      button.addEventListener("click", () => switchKind(id));
    };
    make("book", "Books", "book-open");
    make("manga", "Manga", "book-marked");
  }

  function switchKind(next: ReadingKind): void {
    if (next === kind) return;
    persistViewState();
    kind = next;
    writeExtra(reading.reading.settings, SUBTAB_KEY, kind);
    const restored = readViewState(kind);
    query = restored.query;
    filters = restored.filters;
    sort = restored.sort;
    secondarySort = restored.secondarySort;
    searchBox.setValue(query);
    store.save("reading-subtab");
    buildSubTabs();
    syncSortButton();
    render();
  }

  // --- toolbar ------------------------------------------------------------

  const searchBox = createSearchBox(toolbar, {
    value: query,
    placeholder: "Search — author:herbert  pages:>300  status:Reading",
    onChange: (value) => {
      query = value;
      persistViewState();
      render();
    },
  });

  const filterButton = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-reading-filter-btn",
    attr: { type: "button", "aria-label": "Filters", title: "Filters" },
  });
  setIcon(filterButton, "sliders-horizontal");
  filterButton.addEventListener("click", () => {
    drawerOpen = !drawerOpen;
    renderDrawer();
  });

  const presets = createPresetButton(toolbar, {
    app,
    getPresets: () => reading.reading.settings.savedPresets ?? [],
    getView: (): PresetView => {
      const preset = toPreset("", { query, filters, sort, secondarySort }, "");
      return {
        query: preset.query,
        filters: preset.filters,
        sort: preset.sort,
        secondarySort: preset.secondarySort,
      };
    },
    onApply: (preset: Preset) => applyPreset(preset),
    onChange: (next) => {
      // The button hands back `Preset[]` built from `getView()`; ids arrive from
      // its own helper, so anything missing one is filled here.
      reading.reading.settings.savedPresets = next.map((preset) =>
        preset.id ? preset : { ...preset, id: makePresetId() },
      );
      store.save("reading-presets");
      presets.refresh();
    },
  });

  const sortButton = toolbar.createEl("button", {
    cls: "wl-btn wl-sort-btn",
    attr: { type: "button", "aria-label": "Sort" },
  });
  const sortIcon = sortButton.createSpan({ cls: "wl-btn-icon" });
  const sortLabel = sortButton.createSpan({ cls: "wl-btn-label" });
  sortButton.addEventListener("click", (event: MouseEvent) => openSortMenu(event));

  /**
   * Grid ↔ table, the Library's control verbatim: same toolbar slot (straight
   * after Sort), same classes, same icon convention — the icon shows the
   * *destination*, not the current mode — and the same two labels.
   */
  const viewToggle = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-view-toggle",
    attr: { type: "button" },
  });
  function syncViewToggle(): void {
    const isGrid = viewMode === "grid";
    viewToggle.empty();
    setIcon(viewToggle, isGrid ? "table" : "layout-grid");
    const label = isGrid ? "Switch to table view" : "Switch to poster grid";
    viewToggle.setAttribute("aria-label", label);
    viewToggle.setAttribute("title", label);
    // Which columns a table shows is a question the grid cannot answer, so the
    // button that asks it is not offered there.
    columnsButton.toggleClass("is-hidden", isGrid);
  }
  viewToggle.addEventListener("click", () => {
    viewMode = viewMode === "grid" ? "table" : "grid";
    writeExtra(reading.reading.settings, VIEW_MODE_KEY, viewMode);
    store.save("reading-view-mode");
    syncViewToggle();
    render();
  });

  const columnsButton = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-reading-columns-btn",
    attr: { type: "button", "aria-label": "Columns", title: "Your columns" },
  });
  setIcon(columnsButton, "table-2");
  columnsButton.addEventListener("click", () => {
    new ReadingColumnsModal(app, {
      kind,
      getColumns: () => [...columns()],
      onChange: (next) => {
        reading.setColumns(kind, next);
        render();
      },
      getHidden: () => hiddenColumns(),
      onToggleBuiltIn: (id) => {
        setHiddenColumns(toggleBuiltInColumn(hiddenColumns(), id));
        render();
      },
    }).open();
  });

  toolbar.createDiv({ cls: "wl-toolbar-spacer" });

  const addButton = toolbar.createEl("button", {
    cls: "wl-btn mod-cta wl-add-btn",
    attr: { type: "button" },
  });
  const addIcon = addButton.createSpan({ cls: "wl-btn-icon" });
  setIcon(addIcon, "plus");
  addButton.createSpan({ cls: "wl-btn-label", text: "Add" });
  addButton.addEventListener("click", () => openAdd());

  const counterEl = infoBar.createDiv({ cls: "wl-results-info" });

  function syncSortButton(): void {
    sortLabel.setText(readingSortLabel(sort.key));
    sortIcon.empty();
    setIcon(sortIcon, sort.direction === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    sortButton.setAttribute(
      "title",
      secondarySort
        ? `Sort: ${readingSortLabel(sort.key)} (${sort.direction}), then ${readingSortLabel(secondarySort.key)}`
        : `Sort: ${readingSortLabel(sort.key)} (${sort.direction})`,
    );
    filterButton.toggleClass("is-on", isReadingFilterActive(filters));
  }

  /**
   * Key and direction in one menu, plus the tiebreaker — the Library's sort menu
   * behaviour over the reading axes. The shared control is not reused because it
   * is bound to the watchlist's key list, half of which (next episode, time
   * left) cannot mean anything for a book.
   */
  function openSortMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Sort by").setDisabled(true).setIsLabel(true));
    for (const key of READING_SORT_KEYS) {
      menu.addItem((item) => {
        const active = key === sort.key;
        const arrow = active ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
        item
          .setTitle(`${readingSortLabel(key)}${arrow}`)
          .setChecked(active)
          .onClick(() => {
            sort = nextReadingSort(sort, key);
            if (secondarySort?.key === sort.key) secondarySort = null;
            persistViewState();
            syncSortButton();
            render();
          });
      });
    }

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Then by").setDisabled(true).setIsLabel(true));
    menu.addItem((item) =>
      item
        .setTitle("None")
        .setChecked(secondarySort === null)
        .onClick(() => {
          secondarySort = null;
          persistViewState();
          syncSortButton();
          render();
        }),
    );
    for (const key of READING_SORT_KEYS) {
      if (key === sort.key) continue;
      menu.addItem((item) => {
        const active = secondarySort?.key === key;
        item
          .setTitle(readingSortLabel(key))
          .setChecked(active)
          .onClick(() => {
            secondarySort = active
              ? { key, direction: secondarySort?.direction === "asc" ? "desc" : "asc" }
              : nextReadingSort({ key: "title", direction: "asc" }, key);
            persistViewState();
            syncSortButton();
            render();
          });
      });
    }

    menu.showAtMouseEvent(event);
  }

  // --- filters drawer -----------------------------------------------------

  function renderDrawer(): void {
    drawerHost.empty();
    filterButton.toggleClass("is-open", drawerOpen);
    if (!drawerOpen) return;

    const panel = drawerHost.createDiv({ cls: "wl-filter-panel" });
    const all = pool();

    const groups: { label: string; field: ReadingFacetField }[] = [
      { label: "Status", field: "status" },
      { label: "Author", field: "author" },
      { label: "Category", field: "category" },
      { label: "Decade", field: "decade" },
    ];
    for (const column of columns()) {
      if (column.type !== "select") continue;
      groups.push({ label: column.name, field: { column } });
    }

    for (const group of groups) {
      const options = readingFacetOptions(all, group.field, filters);
      if (options.length === 0) continue;
      const section = panel.createDiv({ cls: "wl-reading-facet-group" });
      section.createDiv({ cls: "wl-reading-facet-title", text: group.label });
      const chips = section.createDiv({ cls: "wl-filter-chips" });
      for (const option of options) {
        const chip = chips.createEl("button", {
          cls: "wl-reading-chip",
          attr: { type: "button" },
        });
        chip.toggleClass("is-excluded", option.excluded);
        chip.createSpan({ cls: "wl-reading-chip-label", text: option.label });
        chip.createSpan({ cls: "wl-reading-chip-count", text: String(option.count) });
        chip.addEventListener("click", () => {
          toggleReadingFacet(filters, group.field, option.value);
          persistViewState();
          renderDrawer();
          render();
        });
      }
    }

    const extras = panel.createDiv({ cls: "wl-reading-facet-group" });
    extras.createDiv({ cls: "wl-reading-facet-title", text: "Also" });

    const favourite = extras.createEl("button", {
      cls: "wl-reading-chip",
      attr: { type: "button" },
    });
    favourite.toggleClass("is-on", filters.favoritesOnly);
    favourite.createSpan({ cls: "wl-reading-chip-label", text: "Favourites only" });
    favourite.addEventListener("click", () => {
      filters.favoritesOnly = !filters.favoritesOnly;
      persistViewState();
      renderDrawer();
      render();
    });

    const ratingRow = extras.createDiv({ cls: "wl-reading-rating-filter" });
    ratingRow.createSpan({ cls: "wl-reading-chip-label", text: "At least" });
    createStars(ratingRow, {
      value: filters.minRating,
      tiers: settings.ratingSystem,
      allowHalf: settings.halfStarRatings,
      ariaLabel: "Minimum rating",
      onChange: (value) => {
        filters.minRating = value;
        persistViewState();
        renderDrawer();
        render();
      },
    });
    // The rule that surprises people if it is not said out loud.
    ratingRow.createSpan({ cls: "wl-reading-hint", text: "Unrated entries always show." });

    const clear = panel.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Clear filters",
      attr: { type: "button" },
    });
    clear.addEventListener("click", () => {
      clearReadingFilters(filters);
      persistViewState();
      renderDrawer();
      render();
    });
  }

  // --- presets ------------------------------------------------------------

  function applyPreset(preset: Preset): void {
    const view = fromPreset(preset);
    query = view.query;
    assignReadingFilters(filters, view.filters);
    sort = view.sort;
    secondarySort = view.secondarySort;
    searchBox.setValue(query);
    persistViewState();
    syncSortButton();
    renderDrawer();
    render();
  }

  // --- add / open ---------------------------------------------------------

  function openAdd(): void {
    const options: ConstructorParameters<typeof AddReadingModal>[1] = {
      store: reading,
      kind,
      dateFormat: settings.dateFormat as DateFormat,
      onAdded: (entry) => {
        buildSubTabs();
        render();
        openDetail(entry);
      },
    };
    if (deps.openLibrary) options.openLibrary = deps.openLibrary;
    if (deps.googleBooks) options.googleBooks = deps.googleBooks;
    new AddReadingModal(app, options).open();
  }

  /**
   * Open a book — the one entry point every row and every button here calls.
   *
   * Which frame it lands in is `settings.openTitlesInFullView`, the *same*
   * preference that decides it for a film. One switch the user already
   * understands beats a second one that says the same thing about books, and
   * "open detail screens as a full view" is a statement about how somebody
   * likes to work, not about what they are looking at.
   *
   * The leaf is only used when `main.ts` has registered the view; otherwise —
   * and whenever opening it throws — this falls back to the modal, which is a
   * perfectly good screen and the one this tab has always used.
   */
  function openDetail(entry: ReadingEntry): void {
    if (settings.openTitlesInFullView && isBookDetailViewRegistered()) {
      void openBookDetail(app, { kind, id: entry.id }).then((opened) => {
        if (!opened) openDetailModal(entry);
      }).catch((err: unknown) => {
        console.error("[wrl] could not open the book view", err);
        openDetailModal(entry);
      });
      return;
    }
    openDetailModal(entry);
  }

  function openDetailModal(entry: ReadingEntry): void {
    const options: ConstructorParameters<typeof ReadingDetailModal>[1] = {
      store: reading,
      watch: store,
      kind,
      id: entry.id,
      onChanged: () => render(),
      onDeleted: () => {
        buildSubTabs();
        render();
      },
      onJumpToQuery: (next: string) => {
        query = next;
        searchBox.setValue(next);
        render();
      },
    };
    if (deps.onOpenNote) options.onOpenNote = deps.onOpenNote;
    if (deps.openLibrary) options.openLibrary = deps.openLibrary;
    if (deps.googleBooks) options.googleBooks = deps.googleBooks;
    if (deps.imageCache) options.imageCache = deps.imageCache;
    if (deps.onMoreLikeThis) options.onMoreLikeThis = deps.onMoreLikeThis;
    if (deps.onAddSuggestion) options.onAddSuggestion = deps.onAddSuggestion;
    if (deps.onDismissSuggestion) options.onDismissSuggestion = deps.onDismissSuggestion;
    new ReadingDetailModal(app, options).open();
  }

  // --- rendering ----------------------------------------------------------

  function render(): void {
    grid?.destroy();
    grid = null;
    posterLoader.releaseWithin?.(resultsHost);
    // The rows about to be discarded own object URLs; releasing them here is
    // what stops a list scrolled for an hour from pinning every blob it drew.
    covers.releaseAll();
    cellCovers.clear();
    resultsHost.empty();

    const all = pool();
    const faceted = applyReadingFilters(all, filters, columns());
    const searched = new ReadingSearchEngine(faceted, { columns: columns() }).filter(query);
    rows = sortReading(searched, sort, secondarySort);

    renderCounter(all.length);
    syncSortButton();

    if (all.length === 0) {
      renderEmptyState(resultsHost, {
        icon: kind === "book" ? "book-open" : "book-marked",
        title: kind === "book" ? "No books yet" : "No manga yet",
        body:
          kind === "book"
            ? "Search Open Library by title, author or ISBN — no key, no account. Or add one by hand."
            : "Add a series by hand, or search for it — chapters and volumes are tracked separately.",
        actions: [{ label: "Add", onClick: () => openAdd(), cta: true }],
      });
      return;
    }
    if (rows.length === 0) {
      renderEmptyState(resultsHost, {
        icon: "search-x",
        title: "Nothing matches",
        body: "No entry on this shelf matches the search and filters you have on.",
        actions: [
          {
            label: "Clear search and filters",
            onClick: () => {
              query = "";
              searchBox.setValue("");
              clearReadingFilters(filters);
              persistViewState();
              renderDrawer();
              render();
            },
            cta: true,
          },
        ],
      });
      return;
    }

    if (viewMode === "table") renderTable();
    else renderGrid();
  }

  // --- the poster grid ----------------------------------------------------

  /**
   * Cover handles by the poster box that owns them.
   *
   * The grid evicts cells as you scroll, and an evicted cell's object URL has
   * to go with it — an unrevoked one pins its blob for the lifetime of the
   * window. `covers` still holds them too, so a re-render releases the lot;
   * this map is what makes a long scroll cost nothing. Releasing twice is a
   * no-op by design.
   */
  const cellCovers = new Map<HTMLElement, CoverHandle>();

  function coverDeps(): ReadingCoverDeps {
    return {
      posterLoader,
      openLibrary: deps.openLibrary,
      imageCache: deps.imageCache,
      fetchBytes: fetchCoverBytes,
    };
  }

  /** The one place a cover is drawn, in either view. */
  function paintCover(poster: HTMLElement, entry: ReadingEntry): void {
    const handle = renderReadingCover(poster, entry, coverDeps());
    if (!handle) return;
    covers.add(handle);
    cellCovers.set(poster, handle);
  }

  function bookCardContext(): BookCardCtx {
    return {
      settings,
      statusColors: reading.reading.settings.statusColors,
      showActions: true,
      renderPoster: paintCover,
      onOpen: (entry) => openDetail(entry),
      onBump: (entry) => {
        reading.update(kind, entry.id, bumpPatch(entry, 1), "reading-progress");
        render();
      },
      onToggleFavorite: (entry) => {
        reading.update(kind, entry.id, { favorite: !entry.favorite }, "reading-favorite");
        render();
      },
      // Per entry, because the answer is: the linked book file, else the
      // generated note, else nothing at all — and the menu never offers an
      // action the data cannot support.
      canOpenInVault: (entry) =>
        (entry.filePath ?? "").trim() !== "" ||
        ((entry.vaultPage ?? "").trim() !== "" && deps.onOpenNote !== undefined),
      onOpenInVault: openInVault,
      // The same two verbs the table row carries, so a reader who works in the
      // grid is not sent back to the table to take a note.
      onStudy: (entry) => {
        void openStudyShortcut(studyContext(entry), studyCommit(entry), "note");
      },
      onOpenChapterNote: (entry) => {
        void openStudyShortcut(studyContext(entry), studyCommit(entry), "alone");
      },
      onPopOutChapter: (entry) => {
        void openStudyShortcut(studyContext(entry), studyCommit(entry), "alone", true);
      },
    };
  }

  function openInVault(entry: ReadingEntry): void {
    const filePath = (entry.filePath ?? "").trim();
    if (filePath !== "") {
      openBookFile(app, filePath, entry.filePage);
      return;
    }
    deps.onOpenNote?.(entry, kind);
  }

  function renderGrid(): void {
    const ctx = bookCardContext();
    // The Library's own column width, off the same card-size setting: the two
    // grids are the same grid or they are not the same app.
    const minWidth = CARD_SIZE_PX[settings.cardSize + CARD_SIZE_OFFSET] ?? 160;
    const handle = createVirtualGrid<ReadingEntry>(resultsHost, {
      minCellWidth: minWidth,
      gap: GRID_GAP,
      // 2:3 cover, text overlaid on the scrim — the cell is the cover.
      cellHeight: (width) => Math.round(width * 1.5),
      onUnmount: (cell) => {
        const poster = cell.querySelector<HTMLElement>(".wl-poster");
        if (!poster) return;
        posterLoader.unobserve(poster);
        cellCovers.get(poster)?.release();
        cellCovers.delete(poster);
      },
      renderCell: (entry, cell) => {
        buildBookCard(cell, entry, ctx);
      },
    });
    handle.setItems(rows);
    grid = handle;
  }

  function renderCounter(total: number): void {
    const filtered = query.trim() !== "" || countActiveReadingFilters(filters) > 0;
    const noun = kind === "book" ? (total === 1 ? "book" : "books") : "manga";
    counterEl.setText(filtered ? `${rows.length} of ${total} ${noun}` : `${total} ${noun}`);
  }

  /**
   * The "In vault" cell: the book file if one is linked, else the generated
   * note, else nothing. Both open on click; the row's own click handler is
   * suppressed so opening a file never also opens the detail modal.
   */
  function renderVaultLink(cell: HTMLElement, entry: ReadingEntry): void {
    const filePath = (entry.filePath ?? "").trim();
    if (filePath !== "") {
      const button = cell.createEl("button", {
        cls: "wl-reading-file-open",
        attr: { type: "button", "aria-label": "Open the book", title: `Open ${filePath}` },
      });
      setIcon(button, "book-open");
      button.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        openBookFile(app, filePath, entry.filePage);
      });
      return;
    }

    const notePath = (entry.vaultPage ?? "").trim();
    if (notePath !== "" && deps.onOpenNote) {
      const button = cell.createEl("button", {
        cls: "wl-reading-file-open is-note",
        attr: { type: "button", "aria-label": "Open the note", title: `Open ${notePath}` },
      });
      setIcon(button, "file-text");
      button.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        deps.onOpenNote?.(entry, kind);
      });
      return;
    }

    cell.createSpan({ cls: "wl-reading-vault-empty", text: "—" });
  }

  // -------------------------------------------------------------------------
  // Study, from the row
  //
  // "Can I also have shortcuts here for this?" — the study workspace was on the
  // book's own screen, which meant opening a book before you could take a note
  // about it. These are the two verbs worth having a row away: read it beside
  // your notes, and open what you already wrote.
  //
  // Which chapter? `currentChapter` decides — the furthest one indexed, or
  // chapter 1 for a book that has never been given one, created on first use.
  // Reading is the moment notes start; nobody should have to go and configure a
  // chapter list first.
  // -------------------------------------------------------------------------

  function studyContext(entry: ReadingEntry): StudyContext {
    return { app, entry, settings, reading: reading.reading };
  }

  function studyCommit(entry: ReadingEntry): (patch: ReadingPatch) => void {
    return (patch) => {
      reading.update(kind, entry.id, patch, "study-chapter-added");
    };
  }

  /**
   * Two icon buttons in the row's own action column — never a second line and
   * never a second cell. The table is one line per book by hard-won design
   * (`styles/90-reading.css`), and 24px controls beside a 36px cover thumb
   * cannot make it taller.
   */
  function renderStudyActions(host: HTMLElement, entry: ReadingEntry): void {
    const chapter = currentChapter(entry);
    const run = (request: ReadRequest): void => {
      void openStudyShortcut(
        studyContext(entry),
        studyCommit(entry),
        request.layout,
        request.popout,
      );
    };

    // The two side-by-side verbs as their own buttons, exactly as the chapter
    // row carries them — the reader asked for a visible "Read & draw" and a
    // modifier is not one. Both are 24px in a 36px-tall row, so the row's
    // height is unchanged; "Read with both" stays in the right-click menu,
    // which is where the one-line discipline puts the third.
    for (const option of READ_BUTTONS.filter((o) => o.layout !== "both")) {
      const button = host.createEl("button", {
        cls: "wl-btn wl-icon-btn wl-reading-quick",
        attr: {
          type: "button",
          "aria-label": option.title,
          title: `${chapterLabel(chapter)} — ${option.hint}. ${READ_HINT}`,
        },
      });
      setIcon(button, option.icon);
      button.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        const request = readRequestFor(event);
        const layout =
          event.altKey === true || event.shiftKey === true ? request.layout : option.layout;
        run({ layout, popout: request.popout });
      });
      button.addEventListener("contextmenu", (event: MouseEvent) => {
        event.stopPropagation();
        openReadMenu(event, run);
      });
    }

    const note = host.createEl("button", {
      cls: "wl-btn wl-icon-btn wl-reading-quick",
      attr: {
        type: "button",
        "aria-label": "Open the chapter note",
        title: `Open the note for ${chapterLabel(chapter)} — ${POPOUT_HINT}`,
      },
    });
    setIcon(note, "file-text");
    note.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      void openStudyShortcut(
        studyContext(entry),
        studyCommit(entry),
        "alone",
        popoutRequested(event),
      );
    });
  }

  /**
   * Set a total nobody could look up. Clicking swaps in a number field rather
   * than opening a modal — it is one number, and the table is where the gap is
   * visible.
   */
  function renderSetTotal(cell: HTMLElement, entry: ReadingEntry): void {
    const button = cell.createEl("button", {
      cls: "wl-reading-set-total",
      text: "Set pages",
      attr: { type: "button", title: "Say how long this is" },
    });
    button.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      button.remove();
      const input = cell.createEl("input", {
        cls: "wl-reading-set-total-input",
        attr: { type: "number", min: "1", step: "1", placeholder: "pages" },
      });
      input.focus();
      const commit = (): void => {
        const total = Math.floor(Number(input.value));
        if (!Number.isFinite(total) || total <= 0) {
          render();
          return;
        }
        reading.update(kind, entry.id, totalPatchFor(entry, total), "reading-total-pages");
        render();
      };
      input.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Enter") commit();
        if (keyEvent.key === "Escape") render();
      });
      input.addEventListener("blur", commit);
      input.addEventListener("click", (inner: MouseEvent) => inner.stopPropagation());
    });
  }

  function renderTable(): void {
    const wrap = resultsHost.createDiv({ cls: "wl-tablewrap" });
    const table = wrap.createEl("table", { cls: "wl-table wl-reading-table" });
    const head = table.createEl("thead").createEl("tr");

    // Built-ins sit after Author: they answer "what is this", the way the
    // Library's Year sits with its Type and Status rather than off by the
    // progress bar.
    const builtIn = visibleBuiltInColumns(hiddenColumns());
    const labels: { label: string; cls?: string }[] = [
      { label: "" },
      { label: "Title" },
      { label: "Author", cls: "wl-reading-author-head" },
      ...builtIn.map((column) => ({ label: column.name, cls: "wl-reading-builtin-head" })),
      { label: "Category" },
      { label: "Status" },
      { label: "Progress" },
      { label: "Rating" },
      { label: "In vault" },
    ];
    // Every header that a narrow screen drops is CLASSED rather than counted:
    // an `nth-child` rule is a rule that shears the table the first time a
    // column is inserted before it, which is exactly what just happened.
    for (const { label, cls } of labels) {
      head.createEl("th", cls === undefined ? { text: label } : { cls, text: label });
    }
    // Classed so the narrow-screen rule can hide the header and its cells
    // together — hiding one without the other shears the whole table.
    for (const column of columns()) {
      head.createEl("th", { cls: "wl-reading-column-head", text: column.name });
    }
    head.createEl("th", { text: "" });

    const body = table.createEl("tbody");
    const statusColors = reading.reading.settings.statusColors;
    const style = columnStyleClass(
      kind === "book"
        ? reading.reading.settings.bookCustomFieldStyle
        : reading.reading.settings.mangaCustomFieldStyle,
    );

    for (const entry of rows) {
      const row = body.createEl("tr", { cls: "wl-table-row wl-reading-row" });
      row.dataset.readingId = entry.id;
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      // Cover — through the one polite path, the same one the grid draws with,
      // so a shelf of 300 books does not fetch 300 images on mount and none of
      // them goes around the limiter.
      const coverCell = row.createEl("td", { cls: "wl-reading-cover-cell" });
      paintCover(coverCell.createDiv({ cls: "wl-poster wl-reading-thumb" }), entry);

      const titleCell = row.createEl("td", { cls: "wl-table-title" });
      titleCell.createSpan({ text: entry.title });
      row.createEl("td", { cls: "wl-reading-author-cell", text: entry.author || "—" });

      // The facts the row already carries — today just the publication year,
      // read off `releaseDate` rather than stored a second time. A row that
      // cannot answer gets the same em dash Author and In-vault use, never a
      // blank cell and never `NaN` from a half-written date.
      for (const column of builtIn) {
        const value = column.value(entry);
        row.createEl("td", {
          cls: "wl-reading-builtin-cell",
          text: value === "" ? "—" : value,
        });
      }

      // Categories, as chips that filter — the same move the Library's genres
      // make, so "show me the rest of the hacking shelf" is one click.
      //
      // Capped at two, with the rest counted. The Library's table is one line
      // per row, and a book filed under six categories was single-handedly
      // three rows tall; the whole list is still one click away in the detail
      // screen, and the cap is what lets this table share the Library's rhythm.
      const categoryCell = row.createEl("td", { cls: "wl-reading-category-cell" });
      const categories = (entry.categories ?? []).filter((name) => name.trim() !== "");
      if (categories.length === 0) {
        categoryCell.setText("—");
      } else {
        const chips = categoryCell.createDiv({ cls: "wl-reading-category-chips" });
        for (const name of categories.slice(0, CATEGORY_CHIP_LIMIT)) {
          // The SAME `.wl-pill` every type and status in the plugin wears —
          // a light tint with coloured text — rather than the solid grey slab
          // it used to paint for itself. `is-category` is the colour source (a
          // category has none of its own), `wl-reading-category-chip` adds the
          // only two things a pill is not: a button, and a click that filters.
          const chip = chips.createEl("button", {
            cls: "wl-pill is-category wl-reading-category-chip",
            attr: { type: "button", title: `Show everything in ${name}` },
          });
          chip.createSpan({ cls: "wl-pill-text", text: name });
          chip.addEventListener("click", (event: MouseEvent) => {
            event.stopPropagation();
            setQuery(`category:"${name}"`);
          });
        }
        const hidden = categories.length - CATEGORY_CHIP_LIMIT;
        if (hidden > 0) {
          chips.createSpan({
            cls: "wl-reading-category-more",
            text: `+${hidden}`,
            attr: { title: categories.slice(CATEGORY_CHIP_LIMIT).join(", ") },
          });
        }
      }

      const statusCell = row.createEl("td");
      const status = derivedStatus(entry);
      renderPill(statusCell, {
        text: status,
        color: sanitizeColor(statusColors?.[status] ?? ""),
        cls: "is-status",
      });

      // Bar and number on ONE line, the way the Library's Progress column is
      // one line. Stacked, they were the single biggest reason a reading row
      // stood twice as tall as a library row right next to it.
      const progressCell = row.createEl("td", { cls: "wl-reading-progress-cell" });
      const progressLine = progressCell.createDiv({ cls: "wl-reading-progress-line" });
      const bar = progressLine.createDiv({ cls: "wl-reading-bar" });
      bar.createDiv({ cls: "wl-reading-bar-fill" }).style.width = `${readingProgress(entry)}%`;
      progressLine.createSpan({
        cls: "wl-reading-progress-text",
        text: compactProgress(entry) || "—",
      });
      // A book whose total nobody knows — no linked file, no provider data —
      // gets a way to say so rather than a dash that means "ask again never".
      if (progressLabel(entry) === "") renderSetTotal(progressLine, entry);

      const ratingCell = row.createEl("td", { cls: "wl-reading-rating-cell" });
      createStars(ratingCell, {
        value: entry.rating,
        tiers: settings.ratingSystem,
        allowHalf: settings.halfStarRatings,
        unratedPlaceholder: "—",
      });
      // The public's number rides quietly beside the user's own verdict —
      // beside, not under, for the same reason the bar and its number share a
      // line: a second row here is a second row on every rated book.
      if ((entry.communityRating ?? 0) > 0) {
        ratingCell.createSpan({
          cls: "wl-reading-community-cell",
          text: `★ ${formatCommunityRating(entry.communityRating ?? 0, entry.communityVotes ?? 0)}`,
        });
      }

      // Is the thing itself here? A column of its own, because "I own this and
      // can open it right now" is a different question from what it is called.
      const vaultCell = row.createEl("td", { cls: "wl-reading-vault-cell" });
      renderVaultLink(vaultCell, entry);

      for (const column of columns()) {
        const cell = row.createEl("td", { cls: "wl-reading-column-cell" });
        const value = columnDisplay(entry, column);
        if (value === "") {
          cell.setText("");
          continue;
        }
        if (column.type === "select") {
          renderPill(cell, {
            text: value,
            color: sanitizeColor(column.color ?? ""),
            cls: `is-column ${style}`,
          });
        } else {
          cell.setText(value);
        }
      }

      // The one-click actions a reading list is actually used for. All of them
      // share the row's last cell — a second `<td>` would be a second column in
      // a table whose header this loop does not write.
      const actionCell = row.createEl("td", { cls: "wl-reading-action-cell" });
      const actions = actionCell.createDiv({ cls: "wl-reading-rowactions" });
      renderStudyActions(actions, entry);
      const bump = actions.createEl("button", {
        cls: "wl-btn wl-icon-btn wl-reading-bump",
        attr: {
          type: "button",
          "aria-label": isBook(entry) ? "One more page" : "One more chapter",
          title: isBook(entry) ? "One more page" : "One more chapter",
        },
      });
      setIcon(bump, "plus");
      bump.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        reading.update(kind, entry.id, bumpPatch(entry, 1), "reading-progress");
        render();
      });

      const open = (): void => openDetail(entry);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }

  /**
   * Fill in totals nobody had to type.
   *
   * A book with the PDF linked already carries its own page count; neither
   * Open Library nor Google reliably does. Runs once per mount, only for
   * entries whose total is still zero, and writes nothing when the file cannot
   * answer — a guessed total would quietly rescale someone's progress bar.
   *
   * Sequential on purpose: these are tens-of-megabytes files, and a shelf of
   * them read at once is a stutter the user would feel.
   */
  async function fillTotalsFromFiles(): Promise<void> {
    const pending = pool().filter(
      (entry) =>
        primaryCounter(entry).total === 0 &&
        (entry.filePath ?? "").toLowerCase().endsWith(".pdf"),
    );
    if (pending.length === 0) return;

    const byId = new Map(pending.map((entry) => [entry.id, entry]));
    const result = await fillPageCountsFromFiles({
      adapter: app.vault.adapter,
      candidates: pending.map((entry) => ({
        id: entry.id,
        title: entry.title,
        filePath: entry.filePath,
      })),
      cancelled: () => destroyed,
      apply: (id, pages) => {
        const entry = byId.get(id);
        if (entry) {
          reading.update(kind, id, totalPatchFor(entry, pages), "reading-pages-from-file");
        }
      },
    });
    console.log(
      `[wrl] page counts: filled ${result.filled} of ${pending.length} from linked PDFs` +
        (result.unknown.length > 0 ? `; could not tell for ${result.unknown.join(", ")}` : ""),
    );
    if (result.filled > 0 && !destroyed) render();
  }

  /** Put a query in the box and show its results — the handoff every chip uses. */
  function setQuery(next: string): void {
    query = next;
    searchBox.setValue(next);
    render();
  }

  buildSubTabs();
  syncSortButton();
  syncViewToggle();
  render();
  // Reads files, so it never blocks the first paint.
  void fillTotalsFromFiles();

  return {
    id: "reading",
    el,
    applyQuery: setQuery,
    refresh(): void {
      buildSubTabs();
      presets.refresh();
      syncSortButton();
      syncViewToggle();
      renderDrawer();
      render();
    },
    destroy(): void {
      // Stops the file sweep writing into — and re-rendering — a tab that has
      // already been torn down; reading a 30MB PDF outlives a tab switch.
      destroyed = true;
      persistViewState();
      grid?.destroy();
      grid = null;
      searchBox.destroy();
      presets.destroy();
      posterLoader.destroy();
      covers.releaseAll();
      cellCovers.clear();
      el.remove();
    },
  };
}
