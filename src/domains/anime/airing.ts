/**
 * Anime airing → the **same** airing cache the TV engine writes (SPEC2 D-ANIME).
 *
 * There is no second Upcoming list and no anime-shaped cache. `AiringCache` is
 * the contract, `services/airing.ts` owns its semantics, and this file is one
 * more producer of it — which is why an anime episode lands in the Upcoming tab,
 * the status bar and the widgets without any of them knowing AniList exists.
 *
 * Three decisions worth stating outright:
 *
 * **1. `airingAt` in, calendar day out.** AniList gives a Unix second, which is
 * more precision than `AiringCache.nextEpisode.airDate` carries — and more than
 * is honest, since every countdown in this plugin is a whole number of local
 * calendar days. The timestamp is converted at the boundary and the countdown is
 * derived at render, never stored. AniList's own `timeUntilAiring` is never used
 * at all: it is computed server-side and is stale on arrival (report §1.2).
 *
 * **2. Provider structure wins on seasons.** An AniList entry *is* one cour —
 * "Season 2" of an anime is a different `mediaId`, not season 2 of the same one.
 * So this never announces a new season, never writes `pendingSeason`, and never
 * appends a season to a title. It only ever fills in an episode count the user
 * left at zero, and stops the moment they have typed a number themselves. The
 * TV auto-sync would otherwise fight the catalogue it is reading from.
 *
 * **3. Jikan cannot date an episode, so it does not pretend to.** It publishes a
 * weekly broadcast slot ("Fridays at 23:00 (JST)") with no episode number
 * attached. Turning that into "episode 7 airs Friday" means inventing the
 * episode number, so the Jikan path fills in status and counts and leaves
 * `nextEpisode` alone. That is why AniList leads.
 */
import {
  describeAiringChange,
  isTerminalShowStatus,
  toDateString,
  type SeasonSyncPlan,
} from "../../services/airing";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "../../services/ratelimit";
import type { AniListClientEx, AniListMediaFull } from "../../services/anilist";
import type { JikanClientEx } from "../../services/jikan";
import { animeIdsOf, providerForTitle, type RoutingSettings } from "../../services/typeroute";
import type {
  AiringCache,
  AniListAiring,
  AniListStatus,
  DateString,
  JikanAnime,
  TitleV4,
} from "../../types";

/** One request per second, matching the TV refresh queue's stagger. */
export const ANIME_AIRING_STAGGER_MS = 1000;

/** How far back a schedule query looks, for `lastEpisode`. */
export const ANIME_AIRING_PAST_DAYS = 14;
/** How far ahead it looks. A cour is 13 weeks; 120 days covers one comfortably. */
export const ANIME_AIRING_FUTURE_DAYS = 120;

const DAY_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * AniList status → the `AiringCache.showStatus` vocabulary (TMDB's).
 *
 * `CANCELLED` becomes TMDB's one-L `"Canceled"` deliberately: every other
 * surface in the plugin reads TMDB spelling, and `isTerminalShowStatus` accepts
 * both, so writing the house spelling keeps chips and filters consistent.
 * `HIATUS` maps to `"In Production"` — a show on break is paused, not finished,
 * and marking it terminal would drop it out of the refresh queue for good.
 */
export function showStatusForAniList(status: AniListStatus): string {
  switch (status) {
    case "RELEASING":
      return "Returning Series";
    case "FINISHED":
      return "Ended";
    case "CANCELLED":
      return "Canceled";
    case "HIATUS":
      return "In Production";
    case "NOT_YET_RELEASED":
    default:
      return "Planned";
  }
}

/** Jikan's three-value enum, mapped onto the same vocabulary. */
export function showStatusForJikan(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "currently airing") return "Returning Series";
  if (normalized === "finished airing") return "Ended";
  if (normalized === "not yet aired") return "Planned";
  return "";
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * A Unix second → the local calendar day it falls on.
 *
 * Local, not UTC: an episode that drops at 01:30 Tokyo time is a *Friday* for a
 * viewer in Tokyo and a *Thursday* for one in Amsterdam, and the countdown the
 * user reads is against their own calendar.
 */
export function airDateFromUnix(airingAt: number): DateString {
  return toDateString(new Date(airingAt * 1000));
}

/**
 * The local season an AniList entry's episodes belong to.
 *
 * An entry is one cour, so a title tracking a single season is that season. A
 * title the user has split into several seasons by hand is followed to its
 * newest one — that is the cour still airing.
 */
export function animeSeasonNumber(title: TitleV4): number {
  const numbers = title.seasons.map((season, i) => season.seasonNumber ?? i + 1).filter((n) => n > 0);
  return numbers.length > 0 ? Math.max(...numbers) : 1;
}

// ---------------------------------------------------------------------------
// Cache construction
// ---------------------------------------------------------------------------

export interface ComputeAnimeAiringOptions {
  now?: Date;
  /** Per-episode schedules for this media, in any order. */
  schedules?: readonly AniListAiring[];
}

/**
 * `AniListMediaFull` (+ optional schedules) → `AiringCache`.
 *
 * `nextEpisode` prefers the schedule list, because it carries every upcoming
 * episode rather than just the next one, and falls back to `nextAiringEpisode`
 * from the media payload. `lastEpisode` can only come from the schedule list.
 */
export function computeAnimeAiring(
  title: TitleV4,
  media: AniListMediaFull,
  options: ComputeAnimeAiringOptions = {},
): AiringCache {
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const season = animeSeasonNumber(title);

  const airing: AiringCache = {
    checkedAt: now.toISOString(),
    showStatus: showStatusForAniList(media.status),
    inProduction: media.status === "RELEASING" || media.status === "HIATUS",
  };

  if (media.episodes !== undefined && media.episodes > 0) airing.episodeCount = media.episodes;

  const mine = (options.schedules ?? []).filter((entry) => entry.mediaId === media.id);
  const upcoming = mine
    .filter((entry) => entry.airingAt >= nowSeconds)
    .sort((a, b) => a.airingAt - b.airingAt);
  const past = mine
    .filter((entry) => entry.airingAt < nowSeconds)
    .sort((a, b) => b.airingAt - a.airingAt);

  const next = upcoming[0] ?? (media.nextAiring && media.nextAiring.airingAt >= nowSeconds ? media.nextAiring : undefined);
  if (next) {
    airing.nextEpisode = {
      season,
      episode: next.episode,
      airDate: airDateFromUnix(next.airingAt),
    };
  }

  const last = past[0];
  if (last) {
    airing.lastEpisode = {
      season,
      episode: last.episode,
      airDate: airDateFromUnix(last.airingAt),
    };
  }

  // No `seasonCount`, no `pendingSeason`, no `newSeasonDetected` — see the
  // per-cour note in the file header. A sequel cour is a different mediaId, so
  // there is nothing here that could honestly answer "how many seasons".
  return airing;
}

/**
 * `JikanAnime` → `AiringCache`.
 *
 * Status and counts only. See the header for why no episode date is invented.
 */
export function computeAnimeAiringFromJikan(
  anime: JikanAnime,
  options: { now?: Date } = {},
): AiringCache {
  const now = options.now ?? new Date();
  const airing: AiringCache = { checkedAt: now.toISOString() };

  const status = showStatusForJikan(anime.status);
  if (status) airing.showStatus = status;
  airing.inProduction = anime.airing;
  if (anime.episodes !== undefined && anime.episodes > 0) airing.episodeCount = anime.episodes;
  return airing;
}

/**
 * Season work for an anime title — deliberately the narrow version.
 *
 * `added` is always empty: appending "Season 2" from a per-cour catalogue would
 * invent a season that entry does not describe. `grown` fills a season the user
 * left at zero episodes, and only that: a season with a number in it is a
 * decision, and this does not overrule decisions.
 */
export function animeSeasonSyncPlan(title: TitleV4, media: AniListMediaFull): SeasonSyncPlan {
  const plan: SeasonSyncPlan = { added: [], grown: [] };
  const episodes = media.episodes ?? 0;
  if (episodes <= 0) return plan;

  const season = animeSeasonNumber(title);
  const local = title.seasons.find((s, i) => (s.seasonNumber ?? i + 1) === season);
  if (local && local.episodes === 0) {
    plan.grown.push({ seasonNumber: season, episodes });
  }
  return plan;
}

/** Does this title still deserve a request? Mirrors `shouldTrackAiring` for anime. */
export function shouldTrackAnimeAiring(title: TitleV4): boolean {
  const ids = animeIdsOf(title);
  if (ids.anilistId === undefined && ids.malId === undefined) return false;
  // A scheduled episode outranks a terminal status, exactly as the TV engine has
  // it: the schedule is evidence, the status is a label.
  if (title.airing?.nextEpisode?.airDate) return true;
  return !isTerminalShowStatus(title.airing?.showStatus);
}

// ---------------------------------------------------------------------------
// The refresh service
// ---------------------------------------------------------------------------

export interface AnimeAiringResult {
  titleId: string;
  airing?: AiringCache;
  error?: string;
  change?: string;
  seasonSync?: SeasonSyncPlan;
}

export interface AnimeAiringDeps {
  anilist: AniListClientEx;
  jikan?: JikanClientEx;
  settings: () => RoutingSettings;
  now?: () => Date;
  clock?: LimiterClock;
  limiter?: RateLimiter;
}

export interface AnimeRefreshOptions {
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export function createAnimeAiringService(deps: AnimeAiringDeps) {
  const now = deps.now ?? (() => new Date());
  const limiter = deps.limiter ?? createRateLimiter(ANIME_AIRING_STAGGER_MS, deps.clock ?? realClock);

  function windowFor(at: Date): { from: number; to: number } {
    const nowSeconds = Math.floor(at.getTime() / 1000);
    return {
      from: nowSeconds - ANIME_AIRING_PAST_DAYS * DAY_SECONDS,
      to: nowSeconds + ANIME_AIRING_FUTURE_DAYS * DAY_SECONDS,
    };
  }

  function resultFor(
    title: TitleV4,
    airing: AiringCache,
    plan?: SeasonSyncPlan,
  ): AnimeAiringResult {
    const change = describeAiringChange(title, title.airing, airing);
    const hasPlan = plan !== undefined && (plan.added.length > 0 || plan.grown.length > 0);
    return {
      titleId: title.id,
      airing,
      ...(change ? { change } : {}),
      ...(hasPlan ? { seasonSync: plan } : {}),
    };
  }

  /** Jikan path: MAL id required, and it can only answer status and counts. */
  async function refreshViaJikan(title: TitleV4, malId: number): Promise<AnimeAiringResult> {
    if (!deps.jikan?.configured()) {
      return { titleId: title.id, error: "Jikan is not available" };
    }
    const anime = await limiter.run(() => (deps.jikan as JikanClientEx).full(malId));
    return resultFor(title, computeAnimeAiringFromJikan(anime, { now: now() }));
  }

  /**
   * One title.
   *
   * AniList first when the title has an AniList id, whatever the preference
   * says — the id names the catalogue, and a MAL id cannot be looked up on
   * AniList without a search that might land somewhere else (see `typeroute`).
   * A failed AniList call falls through to Jikan when the title also has a MAL
   * id, which is the whole point of storing both.
   */
  async function refreshTitle(title: TitleV4): Promise<AnimeAiringResult> {
    const ids = animeIdsOf(title);
    if (ids.anilistId === undefined && ids.malId === undefined) {
      return { titleId: title.id, error: "no AniList or MAL id" };
    }

    const preferJikan =
      ids.anilistId === undefined ||
      (ids.malId !== undefined && providerForTitle(title, deps.settings()) === "jikan");

    if (!preferJikan && ids.anilistId !== undefined) {
      try {
        const at = now();
        const media = await limiter.run(() =>
          deps.anilist.detailsFull(ids.anilistId as number),
        );
        const schedules = await limiter.run(() =>
          deps.anilist.airingSchedules({ mediaIds: [ids.anilistId as number], ...windowFor(at) }),
        );
        const airing = computeAnimeAiring(title, media, { now: at, schedules });
        return resultFor(title, airing, animeSeasonSyncPlan(title, media));
      } catch (err) {
        if (ids.malId === undefined) {
          return { titleId: title.id, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    try {
      if (ids.malId !== undefined) return await refreshViaJikan(title, ids.malId);
      // Preference said Jikan but there is no MAL id — AniList is the only way.
      const at = now();
      const media = await limiter.run(() => deps.anilist.detailsFull(ids.anilistId as number));
      const schedules = await limiter.run(() =>
        deps.anilist.airingSchedules({ mediaIds: [ids.anilistId as number], ...windowFor(at) }),
      );
      return resultFor(
        title,
        computeAnimeAiring(title, media, { now: at, schedules }),
        animeSeasonSyncPlan(title, media),
      );
    } catch (err) {
      return { titleId: title.id, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Refresh a whole library inside a 30-requests-per-minute budget.
   *
   * The naive shape — one details call plus one schedule call per title — costs
   * two requests each and blows the budget at fifteen titles. `mediaBatch` and a
   * `mediaId_in` schedule query answer for fifty titles at a time, so two
   * hundred anime cost eight requests rather than four hundred.
   */
  async function refreshAll(
    titles: readonly TitleV4[],
    options: AnimeRefreshOptions = {},
  ): Promise<AnimeAiringResult[]> {
    const at = now();
    const due = titles.filter((title) => {
      const ids = animeIdsOf(title);
      if (ids.anilistId === undefined && ids.malId === undefined) return false;
      return options.force === true || shouldTrackAnimeAiring(title);
    });
    if (due.length === 0) return [];

    const withAniList = due.filter((title) => animeIdsOf(title).anilistId !== undefined);
    const results = new Map<string, AnimeAiringResult>();

    if (withAniList.length > 0 && deps.anilist.configured()) {
      const ids = withAniList.map((title) => animeIdsOf(title).anilistId as number);
      try {
        const media = await limiter.run(() => deps.anilist.mediaBatch(ids));
        const byId = new Map(media.map((entry) => [entry.id, entry]));
        const schedules = await limiter.run(() =>
          deps.anilist.airingSchedules({ mediaIds: ids, ...windowFor(at) }),
        );
        for (const title of withAniList) {
          const entry = byId.get(animeIdsOf(title).anilistId as number);
          if (!entry) continue;
          results.set(
            title.id,
            resultFor(
              title,
              computeAnimeAiring(title, entry, { now: at, schedules }),
              animeSeasonSyncPlan(title, entry),
            ),
          );
        }
      } catch (err) {
        // The batch is an optimisation, not a requirement: on failure every
        // title falls through to the per-title path below, which can still reach
        // Jikan for the ones that have a MAL id.
        const message = err instanceof Error ? err.message : String(err);
        for (const title of withAniList) {
          if (animeIdsOf(title).malId === undefined) {
            results.set(title.id, { titleId: title.id, error: message });
          }
        }
      }
    }

    let done = results.size;
    const total = due.length;
    options.onProgress?.(done, total);

    for (const title of due) {
      if (results.has(title.id)) continue;
      results.set(title.id, await refreshTitle(title));
      done += 1;
      options.onProgress?.(done, total);
    }

    return due.map((title) => results.get(title.id) as AnimeAiringResult);
  }

  return { refreshTitle, refreshAll, limiter };
}

export type AnimeAiringService = ReturnType<typeof createAnimeAiringService>;
