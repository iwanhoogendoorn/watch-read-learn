/**
 * The games half of the store (`GamesStoreApi` in the frozen contract).
 *
 * It is an adapter, not a second store: every write lands on the live
 * `data.games` object that `WatchLogStore` already owns, then goes out through
 * the same debounced writer and the same `watchlog-data-changed` bus. Nothing
 * here has its own persistence, its own timers, or its own copy of anything.
 *
 * **The rule this file exists to honour**: a `Game` in a real vault carries keys
 * v4 has never heard of (`howLongToBeat`, `modsInstalled`, …), so every mutation
 * is `Object.assign` onto the stored object. Rebuilding one from a literal —
 * even a complete-looking one — deletes whatever v3 wrote and v4 does not
 * declare. See the runtime preservation contract at the top of `types.ts`.
 */
import { uniqueId } from "../../data/schema";
import { readExtra, writeExtra } from "../../types";
import type {
  Game,
  GameGroup,
  GamePatch,
  GamesData,
  GamesStoreApi,
  WatchLogStoreApi,
} from "../../types";
import {
  createGameFilterState,
  normalizeGameFilterState,
  type GameFilterState,
} from "./facets";
import {
  createGameSortSpec,
  normalizeGameSortSpec,
  type GameSortSpec,
} from "./sort";

/** v3's activity-log source string for this domain. */
export const GAMES_ACTIVITY_SOURCE = "Games";

export type GamesViewMode = "grid" | "table";

/**
 * The Games tab's own view state.
 *
 * `GamesSettings` is frozen and has nowhere to put a filter state, a sort or a
 * view mode — so they live beside it under keys of their own, through the
 * documented escape hatch. Unknown keys round-trip, which is precisely the
 * property being used here rather than worked around.
 */
export interface GamesViewState {
  filters: GameFilterState;
  sort: GameSortSpec;
  secondarySort: GameSortSpec | null;
  mode: GamesViewMode;
}

const VIEW_STATE_KEY = "v4ViewState";

export function readGamesViewState(games: GamesData): GamesViewState {
  const raw = readExtra<Record<string, unknown>>(games.settings, VIEW_STATE_KEY);
  if (typeof raw !== "object" || raw === null) {
    return {
      filters: createGameFilterState(),
      sort: createGameSortSpec(),
      secondarySort: null,
      mode: "grid",
    };
  }
  return {
    filters: normalizeGameFilterState(raw.filters),
    sort: normalizeGameSortSpec(raw.sort),
    secondarySort: raw.secondarySort == null ? null : normalizeGameSortSpec(raw.secondarySort),
    mode: raw.mode === "table" ? "table" : "grid",
  };
}

export function writeGamesViewState(games: GamesData, state: GamesViewState): void {
  writeExtra(games.settings, VIEW_STATE_KEY, {
    filters: state.filters,
    sort: state.sort,
    secondarySort: state.secondarySort,
    mode: state.mode,
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface GamesStoreOptions {
  store: WatchLogStoreApi;
  /** Injected by tests; production stamps the real clock. */
  now?: () => string;
  /**
   * Mutation sink for the markdown-note mirror, mirroring `onTitlesChanged`.
   *
   * A direct sink rather than the DOM event, for the same reason: notes must be
   * written even when the change came from a pop-out window whose
   * `activeDocument` is not the one the plugin listens on.
   */
  onMutated?: (gameIds: string[], reason: string) => void;
}

export function createGamesStore(options: GamesStoreOptions): GamesStoreApi {
  const { store } = options;
  const now = options.now ?? ((): string => new Date().toISOString());

  const data = (): GamesData => store.games;

  function commit(reason: string, gameIds: string[] = []): void {
    store.save(reason);
    store.emitChanged({ reason, ...(gameIds.length > 0 ? { titleIds: gameIds } : {}) });
    if (gameIds.length === 0 || !options.onMutated) return;
    // After the save and the event: `data.json` is the record, notes are
    // downstream of it, and a vault that refuses a write must not cost the edit.
    try {
      options.onMutated(gameIds, reason);
    } catch (err) {
      console.error("[wrl] game note sync failed", err);
    }
  }

  return {
    get games(): GamesData {
      return data();
    },

    allGames(): readonly Game[] {
      return data().games;
    },

    getGame(id: string): Game | undefined {
      return data().games.find((game) => game.id === id);
    },

    addGame(game: Game): void {
      data().games.push(game);
      store.logActivity({
        message: `Added “${game.title}” to your games`,
        source: GAMES_ACTIVITY_SOURCE,
        action: "added",
        titleName: game.title,
        titleId: game.id,
      });
      commit("game-added", [game.id]);
    },

    updateGame(id: string, patch: GamePatch, reason = "game-updated"): Game | undefined {
      const game = data().games.find((entry) => entry.id === id);
      if (!game) return undefined;

      // Assign onto the stored object: the user's unknown v3 keys live on it.
      const before = { status: game.status, rating: game.rating };
      Object.assign(game, patch);
      game.dateModified = now();

      // The two edits worth a line in the activity log, matching what the
      // watchlist logs: finishing something, and rating it.
      if (patch.status !== undefined && patch.status !== before.status) {
        store.logActivity({
          message: `“${game.title}” is now ${game.status}`,
          source: GAMES_ACTIVITY_SOURCE,
          action: game.status === "Finished" ? "completed" : "status",
          titleName: game.title,
          titleId: game.id,
        });
      }
      if (patch.rating !== undefined && patch.rating !== before.rating && game.rating > 0) {
        store.logActivity({
          message: `Rated “${game.title}” ${game.rating}★`,
          source: GAMES_ACTIVITY_SOURCE,
          action: "rating",
          titleName: game.title,
          titleId: game.id,
        });
      }

      commit(reason, [id]);
      return game;
    },

    deleteGame(id: string): boolean {
      const games = data().games;
      const index = games.findIndex((game) => game.id === id);
      if (index < 0) return false;
      const [removed] = games.splice(index, 1);
      // A deleted game must not linger in a group's id list.
      for (const group of data().groups) {
        group.gameIds = group.gameIds.filter((gameId) => gameId !== id);
      }
      if (removed) {
        store.logActivity({
          message: `Deleted “${removed.title}” from your games`,
          source: GAMES_ACTIVITY_SOURCE,
          action: "deleted",
          titleName: removed.title,
          titleId: id,
        });
      }
      commit("game-deleted", [id]);
      return true;
    },

    addGameGroup(name: string): GameGroup {
      const groups = data().groups;
      const group: GameGroup = {
        id: uniqueId(`group-${name}`, groups.map((entry) => entry.id)),
        name,
        gameIds: [],
        dateAdded: now(),
      };
      groups.push(group);
      commit("game-group-added");
      return group;
    },

    updateGameGroup(
      id: string,
      patch: Partial<Omit<GameGroup, "id">>,
    ): GameGroup | undefined {
      const group = data().groups.find((entry) => entry.id === id);
      if (!group) return undefined;
      Object.assign(group, patch);
      commit("game-group-updated");
      return group;
    },

    deleteGameGroup(id: string): boolean {
      const groups = data().groups;
      const index = groups.findIndex((group) => group.id === id);
      if (index < 0) return false;
      groups.splice(index, 1);
      commit("game-group-deleted");
      return true;
    },
  };
}

/** A fresh id for a new game, unique against everything already stored. */
export function newGameId(title: string, games: readonly Game[]): string {
  return uniqueId(title, games.map((game) => game.id));
}
