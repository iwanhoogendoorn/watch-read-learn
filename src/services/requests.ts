/**
 * The Overseerr request flow and its feedback loop (SPEC §4.2).
 *
 * Two halves, both here so the state machine lives in one file:
 *
 *   1. **Submit.** Movies go straight through; TV goes through a season picker
 *      whose default selection is "the seasons Plex does not already have".
 *      Overseerr answers 201 / 409 / 202 / 403 and each one means something
 *      different to a human, so `RequestOutcome` is mapped to a sentence rather
 *      than to a boolean.
 *   2. **Poll.** While the view is open, every tracked request is re-read on an
 *      interval. When one flips to AVAILABLE the plugin fires a Notice, writes
 *      an Activity entry and asks for a Plex badge refresh — that is the whole
 *      point of the feature, and v3's version silently lost it on reload.
 *
 * Two enums, never conflated: `MediaRequestStatus` (1–5) is what the *request*
 * is doing; `MediaStatus` (1–6) is whether the *media* is on the server. Only
 * the second one can say "available".
 *
 * Everything above `createRequestService` is pure and DOM-free, so the season
 * defaults and the transition detection are unit-tested without a server.
 */
import {
  MediaRequestStatus,
  MediaStatus,
  type IsoTimestamp,
  type MediaType,
  type OverseerrClient,
  type OverseerrRequest,
  type RequestCache,
  type RequestOutcome,
  type TitleV4,
  type WatchLogStoreApi,
} from "../types";
import { TYPE_MOVIE } from "../constants";

// ---------------------------------------------------------------------------
// Pure: seasons
// ---------------------------------------------------------------------------

/** TMDB season numbers for a title, falling back to 1-based position. */
export function seasonNumbersOf(title: TitleV4): number[] {
  return title.seasons.map((season, index) => season.seasonNumber ?? index + 1);
}

/** Episodes present on Plex, per season number. */
export function plexEpisodesBySeason(title: TitleV4): Map<number, number> {
  const counts = new Map<number, number>();
  for (const episode of title.plex?.episodes ?? []) {
    counts.set(episode.s, (counts.get(episode.s) ?? 0) + 1);
  }
  return counts;
}

/** The exact episode numbers Plex holds for one season number. */
export function plexEpisodeNumbers(title: TitleV4, seasonNumber: number): Set<number> {
  const out = new Set<number>();
  for (const episode of title.plex?.episodes ?? []) {
    if (episode.s === seasonNumber) out.add(episode.e);
  }
  return out;
}

/**
 * Is this season already fully on Plex?
 *
 * Measured against **every real episode** of the season and against the exact
 * `{season, episode}` coordinates Plex reported — not against a count, and never
 * net of skipped episodes. A skip says the user does not intend to watch it; it
 * says nothing about whether the file exists, so counting it as "have it" let a
 * library missing episode 8 pass as complete because it happened to hold the
 * skipped episode 9.
 */
export function seasonOnPlex(title: TitleV4, seasonIndex: number): boolean {
  const season = title.seasons[seasonIndex];
  if (!season || season.episodes <= 0) return false;
  const number = season.seasonNumber ?? seasonIndex + 1;
  const present = plexEpisodeNumbers(title, number);
  if (present.size === 0) return false;
  for (let episode = 1; episode <= season.episodes; episode += 1) {
    if (!present.has(episode)) return false;
  }
  return true;
}

/**
 * The picker's pre-checked set: every season Plex does not already hold.
 *
 * A show with no Plex data at all pre-checks everything — "unknown" is not
 * "have it", and the user can always uncheck.
 */
export function defaultSeasonSelection(title: TitleV4): number[] {
  const numbers = seasonNumbersOf(title);
  const missing = numbers.filter((_, index) => !seasonOnPlex(title, index));
  return missing.length > 0 ? missing : numbers;
}

/** Movies never reach the picker; everything else does. */
export function needsSeasonPicker(title: TitleV4): boolean {
  return mediaTypeOf(title) === "tv" && title.seasons.length > 0;
}

export function mediaTypeOf(title: TitleV4): MediaType {
  if (title.tmdbMediaType) return title.tmdbMediaType;
  if (title.type === TYPE_MOVIE) return "movie";
  return title.totalEpisodes > 1 || title.seasons.length > 1 ? "tv" : "movie";
}

// ---------------------------------------------------------------------------
// Pure: outcomes and transitions
// ---------------------------------------------------------------------------

/** The `TitleV4.request` cache an Overseerr request row implies. */
export function cacheFromRequest(
  request: OverseerrRequest,
  at: IsoTimestamp,
  previous?: RequestCache,
): RequestCache {
  const cache: RequestCache = {
    ...previous,
    id: request.id,
    status: request.status,
    checkedAt: at,
  };
  if (request.media?.status !== undefined) cache.mediaStatus = request.media.status;
  if (request.seasons.length > 0) cache.seasons = [...request.seasons].sort((a, b) => a - b);
  if (!cache.requestedAt) cache.requestedAt = request.createdAt || at;
  return cache;
}

export interface SubmitResult {
  /** The cache to write, or `undefined` when nothing about the title changed. */
  cache?: RequestCache;
  /** What to tell the user. Always present. */
  message: string;
  /** False for denials and "nothing to request" — the UI styles those as warnings. */
  ok: boolean;
}

/**
 * `RequestOutcome` → what the user sees and what gets stored.
 *
 * A 409 is a success from the user's point of view — the thing they wanted is
 * already on its way — so it adopts the existing request rather than reporting
 * an error at them.
 */
export function interpretOutcome(
  title: TitleV4,
  outcome: RequestOutcome,
  at: IsoTimestamp,
): SubmitResult {
  switch (outcome.kind) {
    case "created":
      return {
        cache: cacheFromRequest(outcome.request, at, title.request),
        message: `Requested «${title.title}».`,
        ok: true,
      };
    case "duplicate":
      return {
        ...(outcome.request
          ? { cache: cacheFromRequest(outcome.request, at, title.request) }
          : {}),
        message: outcome.message || `«${title.title}» was already requested.`,
        ok: true,
      };
    case "nothing-to-request":
      return {
        message: outcome.message || `Nothing left to request for «${title.title}».`,
        ok: false,
      };
    case "denied":
      return {
        message: outcome.message || `Overseerr refused the request for «${title.title}».`,
        ok: false,
      };
  }
}

/** Terminal for polling: no further update can arrive. */
export function isRequestSettled(cache: RequestCache | undefined): boolean {
  if (!cache || cache.id === undefined) return true;
  if (cache.mediaStatus === MediaStatus.AVAILABLE) return true;
  return (
    cache.status === MediaRequestStatus.DECLINED || cache.status === MediaRequestStatus.FAILED
  );
}

/** Titles worth polling: tracked, and not already finished. */
export function trackedRequests(titles: readonly TitleV4[]): TitleV4[] {
  return titles.filter((title) => !isRequestSettled(title.request));
}

/**
 * Did this update cross the line into "on the server"?
 *
 * Only a *transition* fires the Notice. Re-reading an already-available request
 * — which happens on every view open until the user clears it — must not
 * announce itself again.
 */
export function becameAvailable(
  previous: RequestCache | undefined,
  next: RequestCache,
): boolean {
  if (next.mediaStatus !== MediaStatus.AVAILABLE) return false;
  return previous?.mediaStatus !== MediaStatus.AVAILABLE;
}

/** Did anything the UI renders actually move? `checkedAt` alone does not count. */
export function requestChanged(
  previous: RequestCache | undefined,
  next: RequestCache,
): boolean {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.mediaStatus !== next.mediaStatus ||
    (previous.seasons ?? []).join(",") !== (next.seasons ?? []).join(",")
  );
}

/** Partial → the show is landing season by season; also worth a nudge. */
export function becamePartiallyAvailable(
  previous: RequestCache | undefined,
  next: RequestCache,
): boolean {
  if (next.mediaStatus !== MediaStatus.PARTIALLY_AVAILABLE) return false;
  return previous?.mediaStatus !== MediaStatus.PARTIALLY_AVAILABLE;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface RequestServiceDeps {
  overseerr: OverseerrClient;
  store: WatchLogStoreApi;
  now?: () => Date;
  /** Fired for the user; the plugin routes this to a `Notice`. */
  notify?: (message: string) => void;
  /**
   * A tracked title just landed on the server — refresh its Plex badge. Kept
   * as a callback so this module never depends on the availability service.
   */
  onAvailable?: (title: TitleV4) => void | Promise<void>;
}

export interface PollTransition {
  titleId: string;
  titleName: string;
  kind: "available" | "partial";
}

export function createRequestService(deps: RequestServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? ((): void => {});

  /** Submit one request and write the result through to the store. */
  async function submit(
    title: TitleV4,
    seasons?: number[] | "all",
  ): Promise<SubmitResult> {
    if (!deps.overseerr.configured()) {
      return {
        message: "Overseerr is not configured — add its URL and API key in the plugin's settings.",
        ok: false,
      };
    }
    if (!title.tmdbId) {
      return {
        message: `«${title.title}» has no TMDB id, so Overseerr has nothing to look up. Re-add it from search, or set the id in the detail modal.`,
        ok: false,
      };
    }

    const at = now().toISOString();
    let outcome: RequestOutcome;
    try {
      outcome = await deps.overseerr.request(title.tmdbId, mediaTypeOf(title), seasons);
    } catch (err) {
      return {
        message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
      };
    }

    const result = interpretOutcome(title, outcome, at);
    if (result.cache) {
      deps.store.updateCaches(title.id, { request: result.cache }, { reason: "request-submitted" });
      deps.store.logActivity({
        action: "requested",
        message: result.message,
        titleId: title.id,
        titleName: title.title,
        source: "Watchlist",
      });
    }
    return result;
  }

  /**
   * Re-read every tracked request once.
   *
   * Failures are swallowed per title: one unreachable request must not stop the
   * others, and a network blip is not evidence that anything changed.
   */
  async function pollOnce(): Promise<PollTransition[]> {
    if (!deps.overseerr.configured()) return [];
    const pending = trackedRequests(deps.store.allTitles());
    if (pending.length === 0) return [];

    const transitions: PollTransition[] = [];
    const at = now().toISOString();

    for (const title of pending) {
      const id = title.request?.id;
      if (id === undefined) continue;

      let request: OverseerrRequest | undefined;
      try {
        request = await deps.overseerr.getRequest(id);
      } catch (err) {
        console.warn(`[wrl] could not poll request ${id}`, err);
        continue;
      }
      // A deleted request row: stop asking, keep what we knew.
      if (!request) continue;

      const previous = title.request;
      const next = cacheFromRequest(request, at, previous);
      const available = becameAvailable(previous, next);
      const partial = becamePartiallyAvailable(previous, next);

      // The pill's whole job is to show progression, so any status movement
      // repaints. A poll that learned nothing repaints nothing.
      deps.store.updateCaches(
        title.id,
        { request: next },
        { reason: "request-polled", silent: !requestChanged(previous, next) },
      );

      if (!available && !partial) continue;

      const kind: PollTransition["kind"] = available ? "available" : "partial";
      const message = available
        ? `«${title.title}» is now on Plex`
        : `«${title.title}» is partly available on Plex`;

      transitions.push({ titleId: title.id, titleName: title.title, kind });
      notify(message);
      deps.store.logActivity({
        action: "available",
        message,
        titleId: title.id,
        titleName: title.title,
        source: "Watchlist",
      });

      // The Plex badge is the other half of the answer; refresh it now rather
      // than leaving the card claiming "not on Plex" next to "Available".
      const fresh = deps.store.getTitle(title.id);
      if (fresh) await deps.onAvailable?.(fresh);
    }

    return transitions;
  }

  return { submit, pollOnce };
}

export type RequestService = ReturnType<typeof createRequestService>;
