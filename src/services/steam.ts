/**
 * Steam Web API — the optional library import (SPEC2-PARITY.md §D-GAMES).
 *
 * Two endpoints and nothing else:
 *   - `IPlayerService/GetOwnedGames` — every owned game with `playtime_forever`
 *     in **minutes** and `rtime_last_played` as Unix seconds;
 *   - `ISteamUserStats/GetPlayerAchievements` — per-app achievements, one row
 *     per achievement with `achieved: 0 | 1`.
 *
 * Both need the user's own Web API key *and* their 64-bit Steam ID, and both
 * answer with a body-level failure rather than an HTTP one in the two cases that
 * happen most: a private profile (empty `response`) and a game with no
 * achievement schema (`400` with `playerstats.success: false`). Neither is an
 * error worth shouting about, so both are read explicitly.
 *
 * Everything goes through the shared `requestUrl` transport — same reason as
 * every other client (see `services/http.ts`).
 */
import { queryString, type HttpFn } from "./http";
import { createRateLimiter, type RateLimiter } from "./ratelimit";
import { GameApiError, defaultGameHttp, toGameApiError } from "./igdb";
import type { DateString, SteamClient, SteamOwnedGame } from "../types";
import type { ApiSource } from "../types";

export const STEAM_BASE = "https://api.steampowered.com";

/** Steam is generous, but a library sweep is a lot of calls; 200 ms is polite. */
export const STEAM_MIN_GAP_MS = 200;

/** Same widening note as `services/igdb.ts` — errors never leave with it. */
function asApiSource(): ApiSource {
  return "steam" as unknown as ApiSource;
}

// ---------------------------------------------------------------------------
// Raw payloads
// ---------------------------------------------------------------------------

interface RawOwnedGame {
  appid?: number;
  name?: string;
  playtime_forever?: number;
  rtime_last_played?: number;
}

interface OwnedGamesPayload {
  response?: {
    game_count?: number;
    games?: RawOwnedGame[];
  };
}

interface RawAchievement {
  apiname?: string;
  achieved?: number;
}

interface AchievementsPayload {
  playerstats?: {
    success?: boolean;
    error?: string;
    achievements?: RawAchievement[];
  };
}

/**
 * Unix **seconds** → `YYYY-MM-DD`, or `null`.
 *
 * Steam writes `0` for "never launched", and a naive conversion turns that into
 * 1970-01-01 — a date the Upcoming list and the "last played" sort would both
 * take seriously.
 */
export function steamTimestampToDate(seconds: number | undefined): DateString | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** One `GetOwnedGames` row → the frozen `SteamOwnedGame`. `null` if unusable. */
export function mapOwnedGame(raw: RawOwnedGame): SteamOwnedGame | null {
  const appId = typeof raw?.appid === "number" ? String(raw.appid) : "";
  const title = raw?.name?.trim() ?? "";
  if (appId === "" || title === "") return null;
  const minutes = typeof raw.playtime_forever === "number" ? Math.max(0, Math.round(raw.playtime_forever)) : 0;
  return {
    appId,
    title,
    playtimeMinutes: minutes,
    lastPlayed: steamTimestampToDate(raw.rtime_last_played),
  };
}

/** Achievement rows → the earned/total pair a `Game` stores. */
export function countAchievements(rows: RawAchievement[] | undefined): {
  earned: number;
  total: number;
} {
  if (!Array.isArray(rows)) return { earned: 0, total: 0 };
  let earned = 0;
  for (const row of rows) if (row?.achieved === 1) earned += 1;
  return { earned, total: rows.length };
}

/** The Steam store page for an app — what `Game.storeUrl` gets on import. */
export function steamStoreUrl(appId: string): string {
  const id = appId.trim();
  return id === "" ? "" : `https://store.steampowered.com/app/${id}/`;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface SteamCredentials {
  apiKey: string;
  steamId: string;
}

export interface SteamClientOptions {
  /** Read live, so a key typed in Settings works without a reload. */
  credentials: () => SteamCredentials;
  http?: HttpFn;
  limiter?: RateLimiter;
}

export function createSteamClient(options: SteamClientOptions): SteamClient {
  const limiter = options.limiter ?? createRateLimiter(STEAM_MIN_GAP_MS);
  const http = options.http ?? defaultGameHttp;

  function credentials(): SteamCredentials {
    const raw = options.credentials();
    return { apiKey: raw.apiKey.trim(), steamId: raw.steamId.trim() };
  }

  function configured(): boolean {
    const { apiKey, steamId } = credentials();
    return apiKey !== "" && steamId !== "";
  }

  return {
    configured,

    async ownedGames(): Promise<SteamOwnedGame[]> {
      const { apiKey, steamId } = credentials();
      if (apiKey === "" || steamId === "") {
        throw new GameApiError({ source: "steam", reason: "no-key" });
      }
      const url =
        `${STEAM_BASE}/IPlayerService/GetOwnedGames/v1/` +
        queryString({
          key: apiKey,
          steamid: steamId,
          include_appinfo: 1,
          include_played_free_games: 1,
          format: "json",
        });

      let payload: OwnedGamesPayload | undefined;
      try {
        const response = await limiter.run(() =>
          http<OwnedGamesPayload>({ url, source: asApiSource() }),
        );
        payload = response.json;
      } catch (err) {
        throw toGameApiError(err, "steam");
      }

      const games = payload?.response?.games;
      if (!Array.isArray(games)) {
        // Steam answers 200 with `{"response":{}}` for a profile whose game
        // details are private. That is a permissions problem the user can fix,
        // not an empty library, and saying so is the difference between a
        // useful message and "found 0 games".
        throw new GameApiError({
          source: "steam",
          reason: "auth",
          message:
            "Steam returned no games. Set “Game details” to Public in your Steam privacy settings, then try again.",
        });
      }

      const out: SteamOwnedGame[] = [];
      for (const raw of games) {
        const mapped = mapOwnedGame(raw);
        if (mapped) out.push(mapped);
      }
      return out;
    },

    async achievements(appId: string): Promise<{ earned: number; total: number } | undefined> {
      const { apiKey, steamId } = credentials();
      if (apiKey === "" || steamId === "" || appId.trim() === "") return undefined;
      const url =
        `${STEAM_BASE}/ISteamUserStats/GetPlayerAchievements/v1/` +
        queryString({ key: apiKey, steamid: steamId, appid: appId.trim(), format: "json" });

      try {
        // A game with no achievement schema answers 400, and a game the user
        // has never launched answers 403 — both mean "no achievements here",
        // not "the import failed".
        const response = await limiter.run(() =>
          http<AchievementsPayload>({
            url,
            source: asApiSource(),
            allowStatuses: [400, 403],
          }),
        );
        const stats = response.json?.playerstats;
        if (!stats || stats.success === false || !Array.isArray(stats.achievements)) {
          return undefined;
        }
        const counted = countAchievements(stats.achievements);
        return counted.total === 0 ? undefined : counted;
      } catch (err) {
        const error = toGameApiError(err, "steam");
        // Credentials being wrong is worth reporting; one game's stats being
        // unavailable is not, and a 3,000-game library must not stop on it.
        if (error.reason === "auth" || error.reason === "no-key") throw error;
        return undefined;
      }
    },
  };
}
