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
  type GoogleBooksClient,
  type OpenLibraryClient,
  type Preset,
  type ReadingKind,
  type Settings,
  type SortSpec,
  type TabController,
  type WatchLogStoreApi,
} from "../../types";
import { createSearchBox } from "../../ui/components/searchbox";
import { createPosterLoader, renderPosterPlaceholder } from "../../ui/components/posters";
import { CoverPool, coverIsbn, loadCover, needsProxy } from "./covers";
import { fetchCoverBytes } from "./coverfetch";
import { openBookFile } from "./bookfile";
import { formatCommunityRating } from "./community";
import { createStars } from "../../ui/components/stars";
import { renderEmptyState } from "../../ui/components/empty";
import { renderPill, sanitizeColor } from "../../ui/components/pills";
import { createPresetButton, makePresetId, type PresetView } from "../../ui/modals/preset";
import { columnDisplay, columnStyleClass } from "./columns";
import { ReadingColumnsModal } from "./modals/columns";
import { AddReadingModal } from "./modals/add";
import { ReadingDetailModal } from "./modals/detail";
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
  /** Open (creating if needed) the generated note. Absent when notes are off. */
  onOpenNote?: (entry: ReadingEntry, kind: ReadingKind) => void;
}

/** Where the two view keys live inside the round-tripped reading settings. */
const SUBTAB_KEY = "activeSubTab";
const VIEW_STATE_KEY = "viewState";

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
  const state = readViewState(kind);
  let query = state.query;
  let filters = state.filters;
  let sort = state.sort;
  let secondarySort = state.secondarySort;
  let rows: ReadingEntry[] = [];
  /** Set on teardown; async work checks it before touching anything. */
  let destroyed = false;
  let drawerOpen = false;

  function readKind(): ReadingKind {
    const raw = readExtra<string>(reading.reading.settings, SUBTAB_KEY);
    return raw === "manga" ? "manga" : "book";
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

  function openDetail(entry: ReadingEntry): void {
    const options: ConstructorParameters<typeof ReadingDetailModal>[1] = {
      store: reading,
      kind,
      id: entry.id,
      dateFormat: settings.dateFormat as DateFormat,
      ratingTiers: settings.ratingSystem,
      halfStars: settings.halfStarRatings,
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
    new ReadingDetailModal(app, options).open();
  }

  // --- rendering ----------------------------------------------------------

  function render(): void {
    posterLoader.releaseWithin?.(resultsHost);
    // The rows about to be discarded own object URLs; releasing them here is
    // what stops a list scrolled for an hour from pinning every blob it drew.
    covers.releaseAll();
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

    renderTable();
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

    const labels = ["", "Title", "Author", "Category", "Status", "Progress", "Rating", "In vault"];
    for (const label of labels) head.createEl("th", { text: label });
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

      // Cover — lazy, through the shared poster pipeline, so a shelf of 300
      // books does not fetch 300 images on mount.
      const coverCell = row.createEl("td", { cls: "wl-reading-cover-cell" });
      const poster = coverCell.createDiv({ cls: "wl-poster wl-reading-thumb" });
      poster.dataset.posterSeed = entry.title;
      const cover = (entry.coverUrl ?? "").trim();
      const isbn = coverIsbn(entry);
      if ((cover === "" || cover === "none") && isbn === "") {
        renderPosterPlaceholder(poster, entry.title);
      } else if (cover === "" || cover === "none" || needsProxy(cover)) {
        // Open Library covers go through the client: same User-Agent, same
        // limiter as the API, because covers share its allowance and an
        // unidentified caller gets a third of it (W8 review P1-5). The shared
        // lazy loader cannot help here — it ends in an `<img src>`, which is
        // Chromium's request rather than ours. When Open Library has no image
        // for the book (niche titles routinely 404), the loader falls back to
        // Google's keyless cover CDN by ISBN before settling for a placeholder.
        const img = poster.createEl("img", { cls: "wl-poster-img" });
        img.setAttribute("alt", "");
        img.setAttribute("decoding", "async");
        covers.add(
          loadCover(img, cover === "none" ? "" : cover, {
            client: deps.openLibrary,
            fallbackIsbn: isbn,
            fetchBytes: fetchCoverBytes,
            onMissing: () => {
              img.remove();
              renderPosterPlaceholder(poster, entry.title);
            },
          }),
        );
      } else {
        posterLoader.observe(poster, cover);
      }

      const titleCell = row.createEl("td", { cls: "wl-table-title" });
      titleCell.createSpan({ text: entry.title });
      row.createEl("td", { text: entry.author || "—" });

      // Categories, as chips that filter — the same move the Library's genres
      // make, so "show me the rest of the hacking shelf" is one click.
      const categoryCell = row.createEl("td", { cls: "wl-reading-category-cell" });
      const categories = (entry.categories ?? []).filter((name) => name.trim() !== "");
      if (categories.length === 0) {
        categoryCell.setText("—");
      } else {
        const chips = categoryCell.createDiv({ cls: "wl-reading-category-chips" });
        for (const name of categories) {
          const chip = chips.createEl("button", {
            cls: "wl-reading-category-chip",
            text: name,
            attr: { type: "button", title: `Show everything in ${name}` },
          });
          chip.addEventListener("click", (event: MouseEvent) => {
            event.stopPropagation();
            setQuery(`category:"${name}"`);
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

      const progressCell = row.createEl("td", { cls: "wl-reading-progress-cell" });
      const bar = progressCell.createDiv({ cls: "wl-reading-bar" });
      bar.createDiv({ cls: "wl-reading-bar-fill" }).style.width = `${readingProgress(entry)}%`;
      progressCell.createDiv({
        cls: "wl-reading-progress-text",
        text: progressLabel(entry) || "—",
      });
      // A book whose total nobody knows — no linked file, no provider data —
      // gets a way to say so rather than a dash that means "ask again never".
      if (progressLabel(entry) === "") renderSetTotal(progressCell, entry);

      const ratingCell = row.createEl("td");
      createStars(ratingCell, {
        value: entry.rating,
        tiers: settings.ratingSystem,
        allowHalf: settings.halfStarRatings,
        unratedPlaceholder: "—",
      });
      // The public's number rides quietly under the user's own verdict.
      if ((entry.communityRating ?? 0) > 0) {
        ratingCell.createDiv({
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

      // The one-click action a reading list is actually used for.
      const actionCell = row.createEl("td", { cls: "wl-reading-action-cell" });
      const bump = actionCell.createEl("button", {
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
      renderDrawer();
      render();
    },
    destroy(): void {
      // Stops the file sweep writing into — and re-rendering — a tab that has
      // already been torn down; reading a 30MB PDF outlives a tab switch.
      destroyed = true;
      persistViewState();
      searchBox.destroy();
      presets.destroy();
      posterLoader.destroy();
      covers.releaseAll();
      el.remove();
    },
  };
}
