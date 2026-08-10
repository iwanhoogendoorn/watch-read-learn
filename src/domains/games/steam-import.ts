/**
 * Turning a Steam library into games — the pure half of the import.
 *
 * The modal does the asking and the writing; everything that decides *what*
 * would happen lives here, so the preview the user approves and the changes that
 * are applied are computed by the same function rather than by two similar ones.
 *
 * Three rules, and they are all about not overwriting a person's own work:
 *   - an existing game is matched by `steamAppId` first and by name second, so a
 *     game added by hand adopts its Steam id instead of being duplicated;
 *   - **nothing the user owns is touched** — status, rating, priority, notes,
 *     favourite and wishlist are never in a patch;
 *   - playtime only ever goes **up**. Steam knows what Steam knows; a larger
 *     number already in the tracker usually means "and I played it on the Deck
 *     before this account", and silently halving someone's hours is not an
 *     import, it is data loss.
 */
import { steamStoreUrl } from "../../services/steam";
import { createGame } from "../../data/schema";
import { newGameId } from "./store";
import type { Game, GamePatch, SteamOwnedGame } from "../../types";

export type SteamImportAction = "add" | "update" | "skip";

export interface SteamImportRow {
  owned: SteamOwnedGame;
  /** The game this row would update, when one matched. */
  existing?: Game;
  action: SteamImportAction;
  /** Human summary of what would change, for the preview list. */
  changes: string[];
  /** The patch an `update` row would apply. Empty for `add` / `skip`. */
  patch: GamePatch;
  /** Ticked in the preview. `skip` rows start unticked. */
  selected: boolean;
}

export interface SteamImportOptions {
  /** Status a newly added game gets. Defaults to the library's own default. */
  defaultStatus: string;
  /** Ignore games below this many minutes played. `0` imports everything. */
  minPlaytimeMinutes?: number;
}

/** Fold case and punctuation so `Half-Life 2` matches `half life 2`. */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The game a Steam row belongs to: app id first, then name. */
export function findMatch(owned: SteamOwnedGame, games: readonly Game[]): Game | undefined {
  const byId = games.find((game) => game.steamAppId !== "" && game.steamAppId === owned.appId);
  if (byId) return byId;
  const needle = normalizeTitle(owned.title);
  if (needle === "") return undefined;
  return games.find((game) => normalizeTitle(game.title) === needle);
}

/** The later of two `YYYY-MM-DD` dates, tolerating nulls. */
function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * What importing one Steam row would do to the library.
 *
 * `skip` means "already correct" — the row is still shown, so a user looking for
 * a game they own can see that it is there and up to date.
 */
export function planRow(
  owned: SteamOwnedGame,
  games: readonly Game[],
  options: SteamImportOptions,
): SteamImportRow {
  const existing = findMatch(owned, games);
  if (!existing) {
    return {
      owned,
      action: "add",
      changes: [`New — ${owned.playtimeMinutes > 0 ? "with your playtime" : "not played yet"}`],
      patch: {},
      selected: true,
    };
  }

  const patch: GamePatch = {};
  const changes: string[] = [];

  if (owned.playtimeMinutes > existing.playtimeMinutes) {
    patch.playtimeMinutes = owned.playtimeMinutes;
    changes.push(
      `Playtime ${existing.playtimeMinutes} → ${owned.playtimeMinutes} min`,
    );
  }

  const lastPlayed = laterDate(existing.lastPlayed, owned.lastPlayed);
  if (lastPlayed !== existing.lastPlayed) {
    patch.lastPlayed = lastPlayed;
    changes.push(`Last played ${lastPlayed ?? "—"}`);
  }

  if (existing.steamAppId !== owned.appId) {
    patch.steamAppId = owned.appId;
    changes.push("Links to Steam");
  }

  // Only fill a store URL that is empty — a user who pasted GOG's link meant it.
  if (existing.storeUrl.trim() === "") {
    patch.storeUrl = steamStoreUrl(owned.appId);
    changes.push("Adds the store link");
  }

  const action: SteamImportAction = changes.length > 0 ? "update" : "skip";
  return {
    owned,
    existing,
    action,
    changes: changes.length > 0 ? changes : ["Already up to date"],
    patch,
    selected: action === "update",
  };
}

/** The whole preview, newest-played first — the order a person scans it in. */
export function planSteamImport(
  owned: readonly SteamOwnedGame[],
  games: readonly Game[],
  options: SteamImportOptions,
): SteamImportRow[] {
  const floor = Math.max(0, options.minPlaytimeMinutes ?? 0);
  return owned
    .filter((row) => row.playtimeMinutes >= floor)
    .map((row) => planRow(row, games, options))
    .sort((a, b) => {
      if (a.action !== b.action) {
        const rank = { add: 0, update: 1, skip: 2 } as const;
        return rank[a.action] - rank[b.action];
      }
      if (a.owned.playtimeMinutes !== b.owned.playtimeMinutes) {
        return b.owned.playtimeMinutes - a.owned.playtimeMinutes;
      }
      return a.owned.title.localeCompare(b.owned.title);
    });
}

/**
 * A complete `Game` for an `add` row.
 *
 * `takenIds` is passed in rather than derived so a batch of adds cannot collide
 * with each other — ids are slugs, and two games called "Prey" are not a
 * hypothetical.
 */
export function gameFromSteam(
  owned: SteamOwnedGame,
  options: SteamImportOptions,
  takenIds: readonly Game[],
): Game {
  return createGame({
    id: newGameId(owned.title, takenIds),
    title: owned.title,
    status: options.defaultStatus,
    platforms: ["Windows PC"],
    playtimeMinutes: owned.playtimeMinutes,
    lastPlayed: owned.lastPlayed,
    steamAppId: owned.appId,
    storeUrl: steamStoreUrl(owned.appId),
    // Steam only reports playtime here; achievements arrive on a second call and
    // are patched in afterwards by the modal.
    singleplayer: true,
  });
}

/** Rows the user actually asked for. */
export function selectedRows(rows: readonly SteamImportRow[]): SteamImportRow[] {
  return rows.filter((row) => row.selected && row.action !== "skip");
}

export interface SteamImportSummary {
  added: number;
  updated: number;
  skipped: number;
}

export function summarize(rows: readonly SteamImportRow[]): SteamImportSummary {
  const summary: SteamImportSummary = { added: 0, updated: 0, skipped: 0 };
  for (const row of rows) {
    if (row.action === "add") summary.added += 1;
    else if (row.action === "update") summary.updated += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** `12 added, 3 updated, 40 already up to date` — the sentence after an import. */
export function summaryText(summary: SteamImportSummary): string {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} added`);
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} already up to date`);
  return parts.length === 0 ? "Nothing to import" : parts.join(", ");
}
