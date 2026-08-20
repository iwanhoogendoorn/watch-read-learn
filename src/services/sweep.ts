/**
 * The library-wide metadata sweep.
 *
 * Nothing in this plugin ever re-pulled metadata across the whole library.
 * `refreshTitleMetadata` is per-title and manual: you click a button on one
 * card and that one card gets a fresh poster, overview, cast and runtime.
 * Everything you never clicked stays exactly as it was the day it was added —
 * a poster that upstream replaced two years ago, a cast list from before the
 * recasting, an overview written for the pilot.
 *
 * This is the loop that was missing. It is modelled on the two engines that
 * already exist rather than invented next to them: a TTL, a catch-up on load
 * and on view open (`integration.ts` `catchUp`), a single min-gap limiter for
 * provider politeness (`services/ratelimit.ts`), and per-title failures that
 * are counted rather than thrown.
 *
 * Four rules this module exists to enforce, in descending order of how bad it
 * would be to get them wrong:
 *
 *   1. **A sweep never writes a field the user owns.** Not `rating`, not
 *      `review`, not `notes`, not `status`, not `tags`, not `favorite`, not
 *      `watchedEpisodes`, and above all not any `manual*` override — those
 *      fields exist *precisely* to beat the API, so a background job that
 *      overwrote them would be destroying the one thing the user did by hand to
 *      say "no, this one". The patch is whitelisted through
 *      `providerOnlyPatch`, so this holds even if the patch builder grows a
 *      field tomorrow.
 *   2. **`autoStatus: false` on every write.** A background refresh is not a
 *      user action; it must not trip the auto-complete rules and reshuffle
 *      statuses behind the user's back (`types.ts` on `updateTitle`).
 *   3. **It skips what cannot change.** Dropped titles, and *watched films* —
 *      a finished film's metadata is done. Watched **shows** keep being
 *      refreshed, because a new season announcing itself on a show you finished
 *      is the single best thing this sweep can find.
 *   4. **One title failing does not end the run.** A 404 on one row is normal;
 *      it is counted and the sweep moves on.
 *
 * The statuses are matched through the constants in `constants.ts` — the same
 * mechanism `domains/shelves.ts` and the dashboard already use — never through
 * a literal list invented here. See `isSweepEligible`.
 */
import { STATUS_COMPLETED, STATUS_DROPPED } from "../constants";
import { isFullyWatched } from "../data/episodes";
import { mediaTypeForTitle } from "./airing";
import { describeApiError, isApiError } from "./http";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";
import type {
  MediaType,
  OverseerrDetails,
  TitlePatch,
  TitleV4,
  WatchLogStoreApi,
} from "../types";

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * Default sweep TTL, in hours. Weekly.
 *
 * Modelled on `settings.airingTtlHours` (12) but an order of magnitude slower,
 * because it is answering a much slower question. An airing schedule changes
 * within a week; a poster or a cast list changes within a year. A weekly sweep
 * over a 300-title library is roughly forty provider calls a day.
 */
export const SWEEP_TTL_HOURS_DEFAULT = 24 * 7;

/** Floor, so a mistyped setting cannot turn the sweep into a hot loop. */
export const SWEEP_TTL_HOURS_MIN = 1;

/** `0` in the setting means "never sweep" — the off switch. */
export const SWEEP_TTL_DISABLED = 0;

/**
 * One provider request per second.
 *
 * The same stagger the airing queue uses, and for the same reason: this is the
 * one job in the plugin that touches *every* title, so it is also the one job
 * that can look like an attack. TMDB's documented ceiling is far higher; the
 * point is not to approach it.
 */
export const SWEEP_STAGGER_MS = 1000;

/**
 * Titles refreshed in a single run.
 *
 * A first-ever sweep over a large library would otherwise run for the better
 * part of an hour. Capping it means the first run takes a couple of minutes and
 * the rest are still stale afterwards — so the next run picks them up. Nothing
 * is lost, the work is just spread.
 */
export const SWEEP_MAX_PER_RUN = 150;

/**
 * Where the user-configurable TTL lives on `Settings`.
 *
 * `types.ts` is a frozen cross-module contract, so until the field is declared
 * there this is read through `readExtra`. The key is named here so both the
 * reader and the settings control agree on one spelling.
 */
export const SWEEP_TTL_SETTING_KEY = "metadataSweepTtlHours";

// ---------------------------------------------------------------------------
// Which titles
// ---------------------------------------------------------------------------

/**
 * Has the user finished with this title?
 *
 * The same two signals every other surface uses — the configured `Watched`
 * status, and "every non-skipped episode is ticked" — rather than a third
 * definition invented here.
 */
function isFinished(title: TitleV4): boolean {
  return title.status === STATUS_COMPLETED || isFullyWatched(title);
}

/**
 * Is this title worth refreshing at all, ever?
 *
 * Three exclusions, and the third is the interesting one:
 *
 *   - **No TMDB id** — there is nothing to look up. The backfill in
 *     `services/match.ts` is what fixes that, and it runs first in `catchUp`.
 *   - **Dropped** — the user said they are done with it. Spending a request on
 *     it every week is the definition of pointless traffic.
 *   - **A finished film** — a released film's poster, cast and runtime are
 *     settled facts, and the user has already watched it. A finished *show* is
 *     the opposite case: it is the exact shape of title that gets renewed, and
 *     "Season 5 announced on the show you finished in 2021" is the headline
 *     result of this whole feature. So `Watched` alone is never a reason to
 *     skip — only `Watched` **and** a film.
 *
 * Statuses are user-configurable, so this reads them through the constants in
 * `constants.ts` (the mechanism `shelves.ts` documents) and never through a
 * literal invented here. A status the user makes up tomorrow is swept, which is
 * the only safe default — inventing a status must not silently switch
 * refreshing off.
 */
export function isSweepEligible(title: TitleV4): boolean {
  if (!title.tmdbId) return false;
  if (title.status === STATUS_DROPPED) return false;
  if (mediaTypeForTitle(title) === "movie" && isFinished(title)) return false;
  return true;
}

/**
 * Has this title's metadata aged past the TTL?
 *
 * `communityRatingLastFetched` is the timestamp every metadata refresh already
 * stamps (`metadataPatch`), so the sweep needs no new persisted field and
 * inherits the manual "Refresh" button's writes for free: refresh a title by
 * hand today and the sweep leaves it alone for a week.
 *
 * An empty or unparseable stamp means "never refreshed", which is due.
 */
export function needsMetadataSweep(
  title: TitleV4,
  ttlHours: number,
  now: Date = new Date(),
): boolean {
  const stamp = title.communityRatingLastFetched;
  if (!stamp) return true;
  const age = now.getTime() - new Date(stamp).getTime();
  if (!Number.isFinite(age)) return true;
  return age >= Math.max(SWEEP_TTL_HOURS_MIN, ttlHours) * 3600_000;
}

export interface SelectSweepOptions {
  ttlHours: number;
  now?: Date;
  /** Refresh regardless of age — the manual "sweep now" command. */
  force?: boolean;
  /** Cap for one run. Defaults to `SWEEP_MAX_PER_RUN`. */
  limit?: number;
}

/**
 * The titles this run will refresh, oldest first.
 *
 * Oldest-first matters once the cap bites: it makes successive capped runs
 * cover the whole library in order rather than re-refreshing whichever titles
 * happen to sort first.
 */
export function selectSweepTitles(
  titles: readonly TitleV4[],
  options: SelectSweepOptions,
): TitleV4[] {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SWEEP_MAX_PER_RUN;
  const due = titles.filter(
    (title) =>
      isSweepEligible(title) &&
      (options.force === true || needsMetadataSweep(title, options.ttlHours, now)),
  );
  due.sort((a, b) => (a.communityRatingLastFetched || "").localeCompare(b.communityRatingLastFetched || ""));
  return limit > 0 ? due.slice(0, limit) : due;
}

// ---------------------------------------------------------------------------
// What may be written
// ---------------------------------------------------------------------------

/**
 * The only fields a sweep may write.
 *
 * A whitelist rather than a blacklist, deliberately. A blacklist has to be
 * updated every time `TitleV4` grows a user-owned field, and the failure mode of
 * forgetting is silent destruction of the user's own data. A whitelist's
 * failure mode is a field not being refreshed, which is a shrug.
 *
 * Note what is *not* here: `rating`, `review`, `notes`, `favorite`, `status`,
 * `priority`, `tags`, `watchedEpisodes`, every `manual*` override, and every
 * date the user sets. `seasons`/`totalEpisodes` are on the list because the
 * patch builder only ever fills them for a show that has none at all — it
 * refuses to overwrite a season structure, because that is where skipped
 * episodes live.
 */
export const SWEEP_PROVIDER_FIELDS = [
  "overview",
  "genres",
  "director",
  "cast",
  "studio",
  "communityRating",
  "communityVotes",
  "communitySource",
  "communityRatingLastFetched",
  "posterUrl",
  "trailerUrl",
  "imdbId",
  "releaseDate",
  "year",
  "episodeDuration",
  "seasons",
  "totalEpisodes",
] as const satisfies readonly (keyof TitlePatch)[];

const SWEEP_FIELD_SET = new Set<string>(SWEEP_PROVIDER_FIELDS);

/**
 * Strip everything from a patch that a background job has no business writing.
 *
 * The last line of defence, and the one that is actually tested: even handed a
 * patch that sets `rating: 5` and `manualPosterUrl: ""`, a sweep writes neither.
 */
export function providerOnlyPatch(patch: TitlePatch): TitlePatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SWEEP_FIELD_SET.has(key)) out[key] = value;
  }
  return out as TitlePatch;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SweepDeps {
  store: WatchLogStoreApi;
  /** Is any metadata provider configured? Nothing runs when not. */
  configured: () => boolean;
  /** One provider lookup. Rejects with an `ApiError` on a provider failure. */
  details: (tmdbId: number, mediaType: MediaType) => Promise<OverseerrDetails>;
  /**
   * The provider-sourced patch for one title.
   *
   * Injected rather than imported so this module never depends on the
   * composition root — and so a test can prove the whitelist by handing it a
   * builder that returns a patch full of user fields.
   */
  buildPatch: (title: TitleV4, details: OverseerrDetails) => TitlePatch;
  /** Live TTL in hours, read per run so a settings change takes effect. */
  getTtlHours: () => number;
  now?: () => Date;
  limiter?: RateLimiter;
  clock?: LimiterClock;
}

export interface SweepRunOptions {
  /** Ignore the TTL. The manual command. */
  force?: boolean;
  /** Cap for this run; defaults to `SWEEP_MAX_PER_RUN`. */
  limit?: number;
  /** Called before each title, so a Notice can count up. */
  onProgress?: (done: number, total: number, title: TitleV4) => void;
}

export interface SweepResult {
  /** How many titles this run set out to refresh. */
  total: number;
  /** Refreshed successfully. */
  refreshed: number;
  /** Failed and were skipped. A network blip is not a reason to stop. */
  failed: number;
  /** True when `cancel()` cut the run short. */
  cancelled: boolean;
  /** True when a run was already in flight and this call did nothing. */
  skipped: boolean;
  /** One sentence, for a Notice. */
  message: string;
}

export interface MetadataSweep {
  run(options?: SweepRunOptions): Promise<SweepResult>;
  /** Ask the in-flight run to stop after the title it is on. */
  cancel(): void;
  readonly running: boolean;
  /** How many titles a run *would* pick right now. Drives the settings blurb. */
  dueCount(options?: { force?: boolean; limit?: number }): number;
}

function idleResult(message: string, extra: Partial<SweepResult> = {}): SweepResult {
  return {
    total: 0,
    refreshed: 0,
    failed: 0,
    cancelled: false,
    skipped: false,
    message,
    ...extra,
  };
}

export function createMetadataSweep(deps: SweepDeps): MetadataSweep {
  const now = deps.now ?? ((): Date => new Date());
  const limiter = deps.limiter ?? createRateLimiter(SWEEP_STAGGER_MS, deps.clock ?? realClock);

  /**
   * Re-entry guard.
   *
   * The sweep is reachable from three places at once — plugin load, opening the
   * view, and the command palette — and two overlapping passes would double
   * every request for no benefit whatsoever. The second caller is told so and
   * returns immediately; it does not queue.
   */
  let running = false;
  let cancelled = false;

  function dueCount(options: { force?: boolean; limit?: number } = {}): number {
    return selectSweepTitles([...deps.store.allTitles()], {
      ttlHours: deps.getTtlHours(),
      now: now(),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }).length;
  }

  async function refreshOne(title: TitleV4): Promise<void> {
    const details = await limiter.run(() =>
      deps.details(title.tmdbId as number, mediaTypeForTitle(title)),
    );
    // Re-read: the run is minutes long and the user may have edited this title
    // while it was queued. Patching the stale copy would write back whatever it
    // was holding.
    const live = deps.store.getTitle(title.id) ?? title;
    const patch = providerOnlyPatch(deps.buildPatch(live, details));

    // `silent: true` is not available on `updateTitle` — only `updateCaches`
    // has it — so the repaint per title is the price of writing real fields.
    // `autoStatus: false` is the part that matters: this is not the user.
    const modified = live.dateModified;
    deps.store.updateTitle(live.id, patch, "metadata-swept", { autoStatus: false });

    // `updateTitle` stamps `dateModified` unconditionally, and for a user edit
    // that is right. For this it is not: `types.ts` says in as many words that
    // "the 'Last updated' sort must not reshuffle because a poll ran", and a
    // sweep is a poll over the *whole library* — it would restamp every title
    // to the same minute, flattening that sort and scrambling the dashboard's
    // "Recently watched" shelf, which reads the same field. So the stamp is put
    // back. The save is debounced, so the restored value is what reaches disk.
    const written = deps.store.getTitle(live.id);
    if (written) written.dateModified = modified;
  }

  async function run(options: SweepRunOptions = {}): Promise<SweepResult> {
    if (running) {
      return idleResult("A metadata sweep is already running.", { skipped: true });
    }
    if (!deps.configured()) {
      return idleResult("No metadata provider is configured, so nothing can be refreshed.");
    }
    const ttlHours = deps.getTtlHours();
    if (ttlHours === SWEEP_TTL_DISABLED && options.force !== true) {
      return idleResult("The metadata sweep is switched off.");
    }

    const due = selectSweepTitles([...deps.store.allTitles()], {
      ttlHours,
      now: now(),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    if (due.length === 0) {
      return idleResult("Every title's metadata is already up to date.");
    }

    running = true;
    cancelled = false;
    let refreshed = 0;
    let failed = 0;
    let done = 0;
    try {
      for (const title of due) {
        if (cancelled) break;
        options.onProgress?.(done, due.length, title);
        try {
          await refreshOne(title);
          refreshed += 1;
        } catch (err) {
          // Partial failure is the normal case over hundreds of titles: a 404
          // on a title whose id moved, a timeout on a flaky link. Counted, and
          // the run continues — the alternative is one bad row costing the
          // other 149 their refresh.
          failed += 1;
          const detail = isApiError(err)
            ? describeApiError(err)
            : err instanceof Error
              ? err.message
              : String(err);
          console.warn(`[wrl] metadata sweep skipped «${title.title}»: ${detail}`);
        }
        done += 1;
      }
    } finally {
      running = false;
    }

    const tail = failed > 0 ? `, ${failed} skipped` : "";
    const message = cancelled
      ? `Metadata sweep stopped after ${refreshed} of ${due.length} title(s)${tail}.`
      : `Refreshed ${refreshed} of ${due.length} title(s)${tail}.`;
    return { total: due.length, refreshed, failed, cancelled, skipped: false, message };
  }

  return {
    run,
    cancel(): void {
      if (running) cancelled = true;
    },
    get running(): boolean {
      return running;
    },
    dueCount,
  };
}
