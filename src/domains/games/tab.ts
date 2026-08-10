/**
 * The Games tab (SPEC2-PARITY.md §D-GAMES).
 *
 * The same one-line pipeline the Library runs, over games:
 *
 *     results = sortGames(searchGames(facetFiltered, query), sort, secondary)
 *
 * Everything else here is chrome around it: the standard toolbar (search with
 * its tips modal, the facet drawer, two-level sort, a grid/table toggle, Steam
 * import when it is configured, Add), the virtualised card grid, and the two
 * distinct empty states.
 *
 * View state — filters, sort, view mode — persists inside `data.games.settings`
 * under a key of its own (see `store.ts`), so it survives a reload without the
 * frozen `GamesSettings` shape having to grow a field.
 */
import { Notice, setIcon, type App } from "obsidian";
import { CARD_SIZE_OFFSET, CARD_SIZE_PX } from "../../constants";
import { renderEmptyState } from "../../ui/components/empty";
import { colorFor, renderPill } from "../../ui/components/pills";
import { createPosterLoader } from "../../ui/components/posters";
import { createSearchBox } from "../../ui/components/searchbox";
import { createVirtualGrid, type VirtualGridHandle } from "../../ui/components/virtual";
import { confirmAction } from "../../ui/modals/confirm";
import type {
  Game,
  GamesStoreApi,
  IgdbClient,
  SteamClient,
  TabController,
  WatchLogStoreApi,
} from "../../types";
import { buildGameCard, type GameCardContext } from "./card";
import { createGameFilters } from "./filters";
import { isGameFilterActive, matchesGameFilters } from "./facets";
import { AddGameModal } from "./modals/add";
import { GameDetailModal } from "./modals/detail";
import { SteamImportModal } from "./modals/steam";
import { GameSearchTipsModal } from "./modals/tips";
import { GameSearchEngine } from "./query";
import { createGameSortButton } from "./sortmenu";
import { sortGames } from "./sort";
import {
  achievementText,
  formatPlaytime,
  gameProgress,
  timePlayedStat,
} from "./stats";
import {
  createGamesStore,
  readGamesViewState,
  writeGamesViewState,
  type GamesViewState,
} from "./store";

const GRID_GAP = 12;

export interface GamesDeps {
  app: App;
  store: WatchLogStoreApi;
  /** Defaults to the adapter over `store`. Injected by tests. */
  games?: GamesStoreApi;
  /** Absent or unconfigured means manual entry only — never a dead search box. */
  igdb?: IgdbClient;
  /** Absent or unconfigured means no import button at all. */
  steam?: SteamClient;
  /** Open (creating if needed) the game's markdown note. */
  onOpenNote?: (game: Game) => void;
}

export interface GamesController extends TabController {
  /** Cross-tab handoff: a chip elsewhere hands us a scoped query. */
  applyQuery(query: string): void;
}

export function mountGamesTab(container: HTMLElement, deps: GamesDeps): GamesController {
  const { app, store } = deps;
  const games = deps.games ?? createGamesStore({ store });
  const settings = store.settings;

  const el = container.createDiv({ cls: "wl-tab-panel wl-tab-panel-games wl-games" });
  const toolbar = el.createDiv({ cls: "wl-games-toolbar" });
  const drawerHost = el.createDiv({ cls: "wl-filter-host" });
  const infoBar = el.createDiv({ cls: "wl-infobar" });
  const resultsHost = el.createDiv({ cls: "wl-results" });

  const view: GamesViewState = readGamesViewState(games.games);
  let query = "";
  let results: Game[] = [];

  const posterLoader = createPosterLoader({ rootMargin: "400px" });

  function persistView(): void {
    writeGamesViewState(games.games, view);
    store.save("games-view-state");
  }

  // --- toolbar ------------------------------------------------------------

  const searchBox = createSearchBox(toolbar, {
    value: query,
    placeholder: "Search your games…",
    onChange: (value) => {
      query = value;
      render();
    },
    onTips: () => new GameSearchTipsModal(app).open(),
  });

  const filters = createGameFilters(toolbar, {
    state: view.filters,
    settings: games.games.settings,
    priorities: settings.priorities,
    halfStarRatings: settings.halfStarRatings,
    getGames: () => games.allGames(),
    onChange: () => render(),
    onPersist: () => persistView(),
    panelHost: drawerHost,
  });

  const sortButton = createGameSortButton(toolbar, {
    getSort: () => view.sort,
    getSecondary: () => view.secondarySort,
    onChange: (sort, secondary) => {
      view.sort = sort;
      view.secondarySort = secondary;
      persistView();
      render();
    },
  });

  const viewToggle = toolbar.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-view-toggle",
    attr: { type: "button" },
  });
  function syncViewToggle(): void {
    const grid = view.mode === "grid";
    viewToggle.empty();
    // The icon shows the *destination*, not the current mode.
    setIcon(viewToggle, grid ? "table" : "layout-grid");
    const label = grid ? "Switch to table view" : "Switch to cover grid";
    viewToggle.setAttribute("aria-label", label);
    viewToggle.setAttribute("title", label);
  }
  viewToggle.addEventListener("click", () => {
    view.mode = view.mode === "grid" ? "table" : "grid";
    persistView();
    syncViewToggle();
    render();
  });
  syncViewToggle();

  toolbar.createDiv({ cls: "wl-toolbar-spacer" });

  // Only shown when Steam is actually configured — an import button that can
  // only ever say "add a key first" is a button that lies about being available.
  if (deps.steam?.configured()) {
    const importButton = toolbar.createEl("button", {
      cls: "wl-btn wl-game-import-btn",
      attr: { type: "button", title: "Import your Steam library" },
    });
    setIcon(importButton.createSpan({ cls: "wl-btn-icon" }), "download");
    importButton.createSpan({ cls: "wl-btn-label", text: "Steam" });
    importButton.addEventListener("click", () => {
      const client = deps.steam;
      if (!client) return;
      new SteamImportModal(app, {
        store: games,
        client,
        onImported: () => render(),
      }).open();
    });
  }

  const addButton = toolbar.createEl("button", {
    cls: "wl-btn mod-cta wl-add-btn",
    attr: { type: "button" },
  });
  setIcon(addButton.createSpan({ cls: "wl-btn-icon" }), "plus");
  addButton.createSpan({ cls: "wl-btn-label", text: "Add" });
  addButton.addEventListener("click", () => openAdd());

  const counterEl = infoBar.createDiv({ cls: "wl-results-info" });
  const playedEl = infoBar.createDiv({ cls: "wl-games-played" });

  // --- actions ------------------------------------------------------------

  function openAdd(): void {
    new AddGameModal(app, {
      store: games,
      settings,
      ...(deps.igdb ? { client: deps.igdb } : {}),
      onAdded: (game) => {
        render();
        openDetail(game);
      },
    }).open();
  }

  function openDetail(game: Game): void {
    new GameDetailModal(app, {
      store: games,
      settings,
      gameId: game.id,
      ...(deps.onOpenNote ? { onOpenNote: deps.onOpenNote } : {}),
      onDelete: (target) => {
        void confirmDelete(target);
      },
      onJumpToQuery: (next) => applyQuery(next),
    }).open();
  }

  async function confirmDelete(game: Game): Promise<void> {
    const result = await confirmAction(app, {
      title: `Delete “${game.title}”?`,
      message: "It is removed from your games and from any group it belongs to.",
      details: ["The note in your vault is left where it is."],
      confirmText: "Delete",
      danger: true,
    });
    if (!result.confirmed) return;
    games.deleteGame(game.id);
    render();
  }

  function cardContext(): GameCardContext {
    return {
      settings: games.games.settings,
      ratingTiers: settings.ratingSystem,
      halfStars: settings.halfStarRatings,
      variant: "full",
      posterLoader,
      showActions: true,
      onOpen: (game) => openDetail(game),
      onEdit: (game) => openDetail(game),
      ...(deps.onOpenNote ? { onOpenNote: deps.onOpenNote } : {}),
      onToggleFavorite: (game) => {
        games.updateGame(game.id, { favorite: !game.favorite }, "game-favorite");
        render();
      },
      onToggleWishlist: (game) => {
        games.updateGame(game.id, { wishlist: !game.wishlist }, "game-wishlist");
        render();
      },
      onOpenStore: (game) => {
        const url = game.storeUrl.trim() || game.externalLink.trim();
        if (url === "") return;
        window.open(url, "_blank");
      },
      onDelete: (game) => {
        void confirmDelete(game);
      },
      onJumpToQuery: (next) => applyQuery(next),
    };
  }

  function applyQuery(next: string): void {
    query = next;
    searchBox.setValue(next);
    render();
  }

  function clearEverything(): void {
    query = "";
    searchBox.setValue("");
    view.filters.excludedStatuses = [];
    view.filters.excludedGenres = [];
    view.filters.excludedPlatforms = [];
    view.filters.excludedPriorities = [];
    view.filters.excludedDecades = [];
    view.filters.minRating = 0;
    view.filters.favoritesOnly = false;
    view.filters.wishlistOnly = false;
    filters.refresh();
    persistView();
    render();
  }

  // --- rendering ----------------------------------------------------------

  let grid: VirtualGridHandle<Game> | null = null;

  function render(): void {
    grid?.destroy();
    grid = null;
    posterLoader.releaseWithin?.(resultsHost);
    resultsHost.empty();

    const all = games.allGames();
    const faceted = all.filter((game) => matchesGameFilters(game, view.filters));
    const matched =
      query.trim() === "" ? [...faceted] : new GameSearchEngine(faceted).filter(query);
    results = sortGames(matched, view.sort, view.secondarySort, {
      statuses: games.games.settings.statuses,
      priorities: settings.priorities,
    });

    renderCounter(all.length);

    if (all.length === 0) {
      // First run and no-match are different situations with different fixes.
      renderEmptyState(resultsHost, {
        cls: "is-first-run",
        icon: "gamepad-2",
        title: "No games tracked yet",
        body: deps.igdb?.configured()
          ? "Add a game to start. Search pulls the cover, platforms, genre and release date from IGDB."
          : "Add a game to start. IGDB search and Steam import are optional — Settings → Games turns them on.",
        actions: [{ label: "Add your first game", onClick: () => openAdd(), cta: true }],
      });
      return;
    }
    if (results.length === 0) {
      renderEmptyState(resultsHost, {
        cls: "is-no-match",
        icon: "search-x",
        title: "No games match",
        body: "Your search or filters rule everything out. Clearing both brings the whole library back.",
        actions: [{ label: "Clear search & filters", onClick: () => clearEverything(), cta: true }],
      });
      return;
    }

    if (view.mode === "table") renderTable();
    else renderGrid();
  }

  function renderCounter(total: number): void {
    const filtered = query.trim() !== "" || isGameFilterActive(view.filters);
    const noun = total === 1 ? "game" : "games";
    counterEl.setText(filtered ? `${results.length} of ${total} ${noun}` : `${total} ${noun}`);

    // The one number a games library is for, over whatever is on screen.
    const played = timePlayedStat(results);
    playedEl.setText(
      played.games === 0
        ? ""
        : `${played.label} played across ${played.games} game${played.games === 1 ? "" : "s"}`,
    );
  }

  function renderGrid(): void {
    const ctx = cardContext();
    const minWidth = CARD_SIZE_PX[settings.cardSize + CARD_SIZE_OFFSET] ?? 160;
    const handle = createVirtualGrid<Game>(resultsHost, {
      minCellWidth: minWidth,
      gap: GRID_GAP,
      cellHeight: (width) => Math.round(width * 1.5),
      onUnmount: (cell) => {
        const poster = cell.querySelector<HTMLElement>(".wl-poster");
        if (poster) posterLoader.unobserve(poster);
      },
      renderCell: (game, cell) => {
        buildGameCard(cell, game, ctx);
      },
    });
    handle.setItems(results);
    grid = handle;
  }

  function renderTable(): void {
    const gameSettings = games.games.settings;
    const wrap = resultsHost.createDiv({ cls: "wl-tablewrap" });
    const table = wrap.createEl("table", { cls: "wl-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of [
      "Game",
      "Genre",
      "Status",
      "Platforms",
      "Played",
      "Achievements",
      "Progress",
      "Rating",
    ]) {
      head.createEl("th", { text: label });
    }
    const body = table.createEl("tbody");

    for (const game of results) {
      const row = body.createEl("tr", { cls: "wl-table-row" });
      row.dataset.gameId = game.id;
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      row.createEl("td", { cls: "wl-table-title", text: game.title });

      const genreCell = row.createEl("td");
      if (game.type) {
        renderPill(genreCell, {
          text: game.type,
          color: colorFor(gameSettings.types, game.type),
          cls: "is-type",
        });
      }

      const statusCell = row.createEl("td");
      if (game.status) {
        renderPill(statusCell, {
          text: game.status,
          color: colorFor(gameSettings.statuses, game.status),
          cls: "is-status",
        });
      }

      const platforms = (game.platforms ?? []).filter((platform) => platform.trim() !== "");
      row.createEl("td", { text: platforms.length === 0 ? "—" : platforms.join(", ") });
      row.createEl("td", {
        text: game.playtimeMinutes > 0 ? formatPlaytime(game.playtimeMinutes) : "—",
      });
      row.createEl("td", { text: achievementText(game) || "—" });
      row.createEl("td", { text: `${gameProgress(game)}%` });
      row.createEl("td", { text: game.rating > 0 ? `★ ${game.rating}` : "—" });

      const open = (): void => openDetail(game);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      });
    }
  }

  render();

  return {
    id: "games",
    el,
    applyQuery,
    refresh(): void {
      filters.refresh();
      sortButton.refresh();
      syncViewToggle();
      render();
    },
    destroy(): void {
      grid?.destroy();
      grid = null;
      searchBox.destroy();
      filters.destroy();
      sortButton.destroy();
      posterLoader.destroy();
      el.remove();
    },
  };
}

/** A game's own "open the store page" behaviour, exported for the command palette. */
export function openGameStore(game: Game): void {
  const url = game.storeUrl.trim() || game.externalLink.trim();
  if (url === "") {
    new Notice(`“${game.title}” has no store link yet.`);
    return;
  }
  window.open(url, "_blank");
}
