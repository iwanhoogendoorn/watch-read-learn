/**
 * Airing / next-season engine (SPEC §4.4).
 *
 * Answers three questions for every tracked title: when is the next episode,
 * has a season been announced that the tracker does not know about, and — for
 * films — how long until it is gettable.
 *
 * Design notes:
 *
 * - **`nextEpisodeToAir === null` is the signal**, not `status`. TMDB keeps a
 *   show at "Returning Series" long after the last episode aired; a null next
 *   episode is the reliable "nothing scheduled" (report §3.5).
 * - **Dates are day-granular.** `air_date` has no time and no timezone, so every
 *   countdown here is a whole number of calendar days. Pretending to know that
 *   an episode drops at 03:00 would be a lie with a decimal point on it.
 * - **Countdowns are never stored.** Only `airDate` is cached; "in 2 days" is
 *   computed at render. v3 cached the countdown and went stale overnight.
 * - **The queue is staggered at 1 req/s** through the shared min-gap limiter, so
 *   a catch-up refresh of 200 titles cannot hammer the server.
 */
import { TYPE_MOVIE } from "../constants";
import {
  type AiringCache,
  type DateString,
  type MediaStatus,
  type MediaType,
  type OverseerrClient,
  type OverseerrDetails,
  type TitleV4,
  type TmdbClient,
} from "../types";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";

/** Deliberate stagger for the refresh queue: one request per second. */
export const AIRING_STAGGER_MS = 1000;

/** TTL collapses to an hour once something is due today (SPEC §4.4). */
export const AIR_DAY_TTL_HOURS = 1;

/** Default region for digital release dates. */
export const DEFAULT_RELEASE_REGION = "NL";

/**
 * TMDB spells it `"Canceled"` (one L); AniList and half the internet spell it
 * `"Cancelled"`. Accept both rather than silently keeping a dead show in the
 * refresh queue forever.
 */
const TERMINAL_STATUSES = new Set(["ended", "canceled", "cancelled"]);

export function isTerminalShowStatus(showStatus: string | undefined): boolean {
  return showStatus !== undefined && TERMINAL_STATUSES.has(showStatus.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Dates and countdowns
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for a local calendar day — never `toISOString`, which is UTC. */
export function toDateString(date: Date): DateString {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole calendar days from `now` to `date`. Negative for the past, `0` today.
 *
 * Both sides are pinned to local midnight, so the answer does not flip because
 * the user opened Obsidian in the evening.
 */
export function daysUntil(date: DateString, now: Date): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const target = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** `today` · `tomorrow` · `in 3 days` · `yesterday` · `12 days ago`. */
export function countdownLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

export type ReleaseState = "unknown" | "upcoming" | "today" | "released";

export interface ReleaseCountdown {
  state: ReleaseState;
  /** Days until `releaseDate`; absent when there is no date to count to. */
  days?: number;
  label: string;
  /** The date the countdown is against — digital release wins when known. */
  date?: DateString;
}

/**
 * Movie release countdown.
 *
 * The **digital** release date wins when the airing cache has one: theatrical
 * dates are months of noise for a home-media tracker (report §3.6).
 */
export function releaseCountdown(title: TitleV4, now: Date = new Date()): ReleaseCountdown {
  const date = title.airing?.digitalReleaseDate ?? title.releaseDate;
  if (!date) return { state: "unknown", label: "" };
  const days = daysUntil(date, now);
  if (days === undefined) return { state: "unknown", label: "" };
  const state: ReleaseState = days > 0 ? "upcoming" : days === 0 ? "today" : "released";
  return { state, days, label: countdownLabel(days), date };
}

// ---------------------------------------------------------------------------
// What to refresh, and when
// ---------------------------------------------------------------------------

export function mediaTypeForTitle(title: TitleV4): MediaType {
  if (title.tmdbMediaType) return title.tmdbMediaType;
  if (title.type === TYPE_MOVIE) return "movie";
  return title.totalEpisodes > 1 || title.seasons.length > 1 ? "tv" : "movie";
}

/**
 * Is this title worth a request at all?
 *
 * Shows that have ended and films that came out are static — refreshing them
 * every twelve hours forever is how v3's queue turned into a treadmill. A show
 * with a scheduled next episode is always refreshed, even if TMDB claims it
 * ended, because the schedule contradicts the status.
 *
 * **The user's own status is deliberately not consulted** (QA2 report 1). The
 * headline case for this whole engine is a show you finished and marked
 * Completed announcing another season; gating the queue on "am I still watching
 * it" would switch the feature off for exactly the titles it exists to serve.
 * The only thing that decides is what *upstream* says: a non-terminal show is
 * tracked, whatever the local row looks like.
 */
export function shouldTrackAiring(title: TitleV4, now: Date = new Date()): boolean {
  if (!title.tmdbId) return false;

  if (mediaTypeForTitle(title) === "tv") {
    if (title.airing?.nextEpisode?.airDate) return true;
    return !isTerminalShowStatus(title.airing?.showStatus);
  }

  const release = releaseCountdown(title, now);
  // Keep a film in the queue for a week past release: that is the window in
  // which "released & on Plex" actually flips.
  return release.state !== "released" || (release.days ?? -999) >= -7;
}

/** Something this title is waiting on lands today (or is overdue). */
export function isAirDay(title: TitleV4, now: Date = new Date()): boolean {
  const next = title.airing?.nextEpisode?.airDate;
  if (next) {
    const days = daysUntil(next, now);
    if (days !== undefined && days <= 0) return true;
  }
  const release = title.airing?.digitalReleaseDate ?? title.releaseDate;
  if (release) {
    const days = daysUntil(release, now);
    if (days !== undefined && days === 0) return true;
  }
  return false;
}

/** TTL in hours for this title right now: 12 normally, 1 on an air day. */
export function airingTtlFor(title: TitleV4, ttlHours: number, now: Date = new Date()): number {
  return isAirDay(title, now) ? Math.min(AIR_DAY_TTL_HOURS, ttlHours) : ttlHours;
}

export function needsAiringRefresh(title: TitleV4, ttlHours: number, now: Date = new Date()): boolean {
  const checkedAt = title.airing?.checkedAt;
  if (!checkedAt) return true;
  const age = now.getTime() - new Date(checkedAt).getTime();
  if (!Number.isFinite(age)) return true;
  return age >= Math.max(0, airingTtlFor(title, ttlHours, now)) * 3600_000;
}

// ---------------------------------------------------------------------------
// The cache itself
// ---------------------------------------------------------------------------

/**
 * Season numbers the tracker already knows about, **specials excluded**.
 *
 * Season 0 is not a season anywhere in this codebase: `normalizeSeasons` drops
 * it from every upstream payload, so counting a locally-kept specials row would
 * compare two different things and make an up-to-date tracker look one season
 * ahead of upstream — which is how a real announcement went missing (QA2).
 */
function localSeasonNumbers(title: TitleV4): Set<number> {
  const out = new Set<number>();
  title.seasons.forEach((season, i) => {
    const number = season.seasonNumber ?? i + 1;
    if (number > 0) out.add(number);
  });
  return out;
}

/**
 * The newest season that exists upstream but not in the tracker — the
 * "Season 4 announced" badge.
 *
 * Two guards, both deliberate:
 *
 *   - The count test from SPEC §4.4 (`upstream seasonCount > local
 *     seasons.length`) gates the whole thing.
 *   - The answer must be **higher** than every season already tracked. A user
 *     who deliberately follows only seasons 2–3 of a long-runner has not had
 *     "Season 1 announced"; the badge is about something new appearing, not
 *     about gaps they chose.
 */
export function detectNewSeason(title: TitleV4, details: OverseerrDetails): number | undefined {
  const known = localSeasonNumbers(title);

  const upstreamNumbers = (details.seasons ?? [])
    .map((s) => s.seasonNumber)
    .filter((n) => n > 0)
    .sort((a, b) => b - a);

  // Both sides counted the same way: real seasons only. The enumerated list wins
  // over `numberOfSeasons`, which some servers compute with specials included —
  // trusting that number against a specials-free local count invents a season
  // that does not exist, and ignoring specials locally hides one that does.
  const upstreamCount = upstreamNumbers.length > 0 ? upstreamNumbers.length : (details.numberOfSeasons ?? 0);
  if (upstreamCount <= known.size) return undefined;

  const highestKnown = known.size > 0 ? Math.max(...known) : 0;

  for (const number of upstreamNumbers) {
    if (!known.has(number) && number > highestKnown) return number;
  }

  // No season list came back, but the count grew — name the next one along.
  if (upstreamNumbers.length === 0 && upstreamCount > highestKnown) return upstreamCount;
  return undefined;
}

/**
 * Local seasons that are still empty and which upstream can now fill in.
 *
 * A season announced before its episode list exists is added to the tracker with
 * zero episodes (that is the whole point — you can follow it before TMDB has
 * enumerated it), so something has to notice when the count lands. Only seasons
 * at exactly 0 are ever touched: a user who trimmed a season to what they
 * actually own must not have it "corrected" behind their back.
 */
export function seasonLengthUpdates(
  title: TitleV4,
  details: OverseerrDetails,
): { seasonNumber: number; episodes: number }[] {
  const upstream = new Map(
    (details.seasons ?? []).filter((s) => s.seasonNumber > 0).map((s) => [s.seasonNumber, s.episodeCount]),
  );
  const out: { seasonNumber: number; episodes: number }[] = [];
  title.seasons.forEach((season, index) => {
    if (season.episodes !== 0) return;
    const number = season.seasonNumber ?? index + 1;
    const episodes = upstream.get(number) ?? 0;
    if (episodes > 0) out.push({ seasonNumber: number, episodes });
  });
  return out;
}

/**
 * The newest upstream season that has not started airing yet.
 *
 * "Has not started" means: no episodes enumerated, no air date, a future air
 * date, or simply later than the season the last aired episode belongs to. This
 * is what the Upcoming tab reports about a show you follow — as opposed to
 * `detectNewSeason`, which asks the narrower "is something missing from my
 * tracker" question that stops mattering once seasons are adopted for you.
 */
export function detectPendingSeason(
  details: OverseerrDetails,
  now: Date = new Date(),
): { number: number; episodes: number; airDate?: DateString } | undefined {
  if (details.mediaType !== "tv") return undefined;
  const seasons = (details.seasons ?? []).filter((s) => s.seasonNumber > 0);
  if (seasons.length === 0) return undefined;

  const lastAired = details.lastEpisodeToAir?.seasonNumber ?? 0;
  const candidates = seasons.filter((season) => {
    if (season.seasonNumber <= lastAired) return false;
    if (season.episodeCount <= 0) return true;
    if (!season.airDate) return true;
    const days = daysUntil(season.airDate, now);
    return days === undefined || days > 0;
  });
  if (candidates.length === 0) return undefined;

  // The *next* one, not the furthest out: a show with seasons 3 and 4 both
  // unaired is telling you about season 3.
  const next = candidates.reduce((a, b) => (a.seasonNumber <= b.seasonNumber ? a : b));
  return {
    number: next.seasonNumber,
    episodes: Math.max(0, next.episodeCount),
    ...(next.airDate ? { airDate: next.airDate } : {}),
  };
}

/**
 * Seasons to append to a followed show, and empty ones upstream can now size
 * (QA3 — "why do all seasons of one show need a separate tracker?").
 *
 * Only seasons **newer** than the highest one tracked are ever appended. A user
 * who deliberately follows seasons 2–3 of a long-runner has not asked for
 * season 1 to appear, and the same restraint that keeps `detectNewSeason` from
 * nagging about chosen gaps applies when the adoption is automatic — more so,
 * because nothing asks first.
 */
export interface SeasonSyncPlan {
  added: { seasonNumber: number; episodes: number; name: string; airDate: DateString | null }[];
  grown: { seasonNumber: number; episodes: number }[];
}

export function seasonSyncPlan(title: TitleV4, details: OverseerrDetails): SeasonSyncPlan {
  const plan: SeasonSyncPlan = { added: [], grown: seasonLengthUpdates(title, details) };
  if (details.mediaType !== "tv") return plan;

  const known = localSeasonNumbers(title);
  const highestKnown = known.size > 0 ? Math.max(...known) : 0;

  for (const season of (details.seasons ?? []).filter((s) => s.seasonNumber > 0)) {
    if (known.has(season.seasonNumber)) continue;
    if (season.seasonNumber <= highestKnown) continue;
    plan.added.push({
      seasonNumber: season.seasonNumber,
      episodes: Math.max(0, season.episodeCount),
      name: season.name || `Season ${season.seasonNumber}`,
      airDate: season.airDate ?? null,
    });
  }
  plan.added.sort((a, b) => a.seasonNumber - b.seasonNumber);
  return plan;
}

export function isEmptySyncPlan(plan: SeasonSyncPlan | undefined): boolean {
  return !plan || (plan.added.length === 0 && plan.grown.length === 0);
}

export interface ComputeAiringOptions {
  now?: Date;
  /** From TMDB `/movie/{id}/release_dates`; movies only. */
  digitalReleaseDate?: DateString | undefined;
}

export function computeAiring(
  title: TitleV4,
  details: OverseerrDetails,
  options: ComputeAiringOptions = {},
): AiringCache {
  const now = options.now ?? new Date();
  const airing: AiringCache = { checkedAt: now.toISOString() };

  if (details.mediaType === "tv") {
    if (details.showStatus) airing.showStatus = details.showStatus;
    if (details.inProduction !== undefined) airing.inProduction = details.inProduction;

    const next = details.nextEpisodeToAir;
    if (next?.airDate) {
      airing.nextEpisode = {
        season: next.seasonNumber,
        episode: next.episodeNumber,
        airDate: next.airDate,
        ...(next.name ? { name: next.name } : {}),
      };
    }

    const last = details.lastEpisodeToAir;
    if (last?.airDate) {
      airing.lastEpisode = {
        season: last.seasonNumber,
        episode: last.episodeNumber,
        airDate: last.airDate,
      };
    }

    // Specials are already filtered out of `details.seasons`.
    const seasonCount = details.numberOfSeasons ?? details.seasons?.length;
    if (seasonCount !== undefined) airing.seasonCount = seasonCount;
    if (details.numberOfEpisodes !== undefined) airing.episodeCount = details.numberOfEpisodes;

    const pending = detectPendingSeason(details, now);
    if (pending) airing.pendingSeason = pending;

    const newSeason = detectNewSeason(title, details);
    if (newSeason !== undefined) {
      airing.newSeasonDetected = newSeason;
      // Carry the season's own episode count so the "add it to my tracker"
      // action can create the season with the right length and offset without
      // a second round trip (SPEC §4.4).
      const summary = details.seasons?.find((season) => season.seasonNumber === newSeason);
      if (summary && summary.episodeCount > 0) airing.newSeasonEpisodes = summary.episodeCount;
    }
  }

  if (options.digitalReleaseDate) airing.digitalReleaseDate = options.digitalReleaseDate;

  return airing;
}

/**
 * A one-line description of what changed, or `undefined` when nothing did.
 * Wave 2 turns this into an Activity entry and a Notice.
 */
export function describeAiringChange(
  title: TitleV4,
  previous: AiringCache | undefined,
  next: AiringCache,
): string | undefined {
  if (next.newSeasonDetected !== undefined && previous?.newSeasonDetected !== next.newSeasonDetected) {
    return `Season ${next.newSeasonDetected} of «${title.title}» was announced`;
  }
  if (
    !isTerminalShowStatus(previous?.showStatus) &&
    isTerminalShowStatus(next.showStatus) &&
    next.showStatus
  ) {
    return `«${title.title}» is now marked ${next.showStatus}`;
  }
  const before = previous?.nextEpisode;
  const after = next.nextEpisode;
  if (after && (!before || before.airDate !== after.airDate || before.episode !== after.episode)) {
    const code = `S${String(after.season).padStart(2, "0")}E${String(after.episode).padStart(2, "0")}`;
    return `«${title.title}» ${code} airs ${after.airDate}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The refresh queue
// ---------------------------------------------------------------------------

export interface AiringDeps {
  overseerr: OverseerrClient;
  /** Optional direct-TMDB fallback and digital-release source. */
  tmdb?: TmdbClient;
  /** Per-title TTL in hours; read live so a settings change takes effect. */
  getTtlHours: () => number;
  /** Region for digital release dates. */
  getRegion?: () => string;
  now?: () => Date;
  clock?: LimiterClock;
  limiter?: RateLimiter;
}

export interface AiringRefreshResult {
  titleId: string;
  airing?: AiringCache;
  /** Set when the refresh failed; the previous cache must be left alone. */
  error?: string;
  /** Human sentence for the Activity log, when something actually changed. */
  change?: string;
  /**
   * Seasons to append and empty ones to size. Not part of the cache — these are
   * real data changes, so the caller writes them through `updateTitle`.
   */
  seasonSync?: SeasonSyncPlan;
  /**
   * `mediaInfo.status` — what Overseerr knows about the *media*, as opposed to
   * about a request row.
   *
   * This is the answer to "is Radarr/Sonarr already on it?" without asking
   * Radarr or Sonarr: Overseerr's own service scans import whatever those
   * instances hold, so a show somebody added straight to Sonarr — never
   * requested through Overseerr, therefore with no request row anywhere — still
   * reports `PROCESSING` here. Absent means Overseerr has never tracked the
   * title at all, which is a different thing from `UNKNOWN` (§ the header).
   *
   * The details call that produces the airing cache already carries it, so
   * reading it costs nothing extra.
   */
  mediaStatus?: MediaStatus | number;
}

export interface RefreshAllOptions {
  /** Refresh even when the TTL has not expired. The "refresh all" command. */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export function createAiringService(deps: AiringDeps) {
  const now = deps.now ?? (() => new Date());
  const limiter = deps.limiter ?? createRateLimiter(AIRING_STAGGER_MS, deps.clock ?? realClock);
  const region = deps.getRegion ?? (() => DEFAULT_RELEASE_REGION);

  /** Overseerr first (SPEC D4); direct TMDB only when it is not configured. */
  async function fetchDetails(tmdbId: number, mediaType: MediaType): Promise<OverseerrDetails> {
    if (deps.overseerr.configured()) return deps.overseerr.details(tmdbId, mediaType);
    if (deps.tmdb?.configured()) return deps.tmdb.details(tmdbId, mediaType);
    throw new Error("No metadata provider configured");
  }

  /** Digital release date, when TMDB is available and the film is unreleased. */
  async function fetchDigitalDate(title: TitleV4): Promise<DateString | undefined> {
    if (!deps.tmdb?.configured() || !title.tmdbId) return undefined;
    const release = releaseCountdown(title, now());
    if (release.state === "released") return undefined;
    try {
      return await deps.tmdb.digitalReleaseDate(title.tmdbId, region());
    } catch {
      return undefined;
    }
  }

  /** One title, queued behind the 1 req/s stagger. */
  async function refreshTitle(title: TitleV4): Promise<AiringRefreshResult> {
    if (!title.tmdbId) return { titleId: title.id, error: "no TMDB id" };
    const mediaType = mediaTypeForTitle(title);

    try {
      const details = await limiter.run(() => fetchDetails(title.tmdbId as number, mediaType));
      const digital = mediaType === "movie" ? await fetchDigitalDate(title) : undefined;
      const airing = computeAiring(title, details, {
        now: now(),
        ...(digital ? { digitalReleaseDate: digital } : {}),
      });
      const change = describeAiringChange(title, title.airing, airing);
      const plan = seasonSyncPlan(title, details);
      return {
        titleId: title.id,
        airing,
        ...(change ? { change } : {}),
        ...(isEmptySyncPlan(plan) ? {} : { seasonSync: plan }),
        ...(details.mediaInfo?.status !== undefined
          ? { mediaStatus: details.mediaInfo.status }
          : {}),
      };
    } catch (err) {
      return {
        titleId: title.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Refresh everything that is due.
   *
   * Requests are queued all at once and released one per second by the limiter,
   * so the caller gets a single promise and the server gets a polite trickle.
   */
  async function refreshAll(
    titles: readonly TitleV4[],
    options: RefreshAllOptions = {},
  ): Promise<AiringRefreshResult[]> {
    const at = now();
    const due = titles.filter((title) => {
      if (!title.tmdbId) return false;
      // `force` is the user pressing Refresh. It bypasses the tracking filter as
      // well as the TTL, so a show upstream had marked Ended — and which a
      // revival has un-ended — is reachable at all. Without that the button
      // would silently do nothing for precisely the title being investigated.
      if (options.force) return true;
      return shouldTrackAiring(title, at) && needsAiringRefresh(title, deps.getTtlHours(), at);
    });

    let done = 0;
    const total = due.length;
    return Promise.all(
      due.map(async (title) => {
        const result = await refreshTitle(title);
        done += 1;
        options.onProgress?.(done, total);
        return result;
      }),
    );
  }

  return { refreshTitle, refreshAll, limiter };
}

export type AiringService = ReturnType<typeof createAiringService>;
