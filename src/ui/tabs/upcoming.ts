/**
 * Upcoming tab — SPEC §4.4.
 *
 * One chronological list of everything that is about to happen: the next
 * episode of every returning show, movie/digital releases, and newly announced
 * seasons. Replaces v3's `airtime` tracker, which could only ever surface a
 * single `once` schedule and lost recurring items entirely.
 *
 * This module is the bottom of the aux-lane import chain (Dashboard and Activity
 * both import from it and it imports from neither), so the handful of helpers
 * every aux surface needs live here: the error-isolating `section()` wrapper
 * ported from foodspot, the countdown/date maths, the state pills, and the
 * fallback card used until `ui/components/card.ts` lands.
 *
 * Everything above `mountUpcomingTab` is pure and unit-tested; only the mount
 * functions touch the DOM.
 */
import { Notice, setIcon, type App } from "obsidian";
import type {
  CardContext,
  CardVariant,
  DateFormat,
  OverseerrSearchResult,
  PosterLoader,
  TabController,
  TabId,
  TitleV4,
  WatchLogStoreApi,
} from "../../types";
import { MediaStatus } from "../../types";
import { episodesRemaining, getNextUnwatchedEpisode, toSeasonEpisode } from "../../data/episodes";
import { posterUrlFor, resolvePosterUrl } from "../components/posters";
import { formatDate } from "../components/dates";
import { createFacetPanel } from "../components/filters";
import { createSearchBox } from "../components/searchbox";
import { createSortButton } from "../components/sortmenu";
import { renderEmptyState as renderSharedEmptyState } from "../components/empty";
import { createPresetButton } from "../modals/preset";
import {
  buildUnifiedUpcoming,
  upcomingStateOf,
  type UnifiedRow,
} from "../../domains/upcoming/unified";
import {
  applyUpcomingFilters,
  assignUpcomingFilters,
  availabilityOfTitle,
  buildUpcomingFacetSections,
  clearUpcomingFilters,
  excludedForUpcoming,
  fromUpcomingPreset,
  hasArrived,
  isUpcomingFilterActive,
  makeUpcomingPresetId,
  readUpcomingViewState,
  setExcludedForUpcoming,
  sortUpcomingRows,
  toUpcomingPreset,
  upcomingSortLabel,
  writeUpcomingViewState,
  UPCOMING_SORT_DEFAULT_DIR,
  UPCOMING_SORT_KEYS,
  UPCOMING_WINDOWS,
  UPCOMING_WINDOW_LABELS,
  type UpcomingFacetKey,
  type UpcomingPreset,
  type UpcomingSortKey,
  type UpcomingSortSpec,
  type UpcomingWindow,
} from "../../domains/upcoming/filters";
import { UpcomingSearchEngine } from "../../domains/upcoming/query";
import { UpcomingSearchTipsModal } from "../../domains/upcoming/tips";

// ---------------------------------------------------------------------------
// Shared aux-lane contracts
// ---------------------------------------------------------------------------

/** Signature of `ui/components/card.ts`'s `buildTitleCard`. */
export type CardFactory = (parent: HTMLElement, title: TitleV4, ctx: CardContext) => void;

/**
 * Everything an aux tab needs, injected rather than imported.
 *
 * The card component, the poster loader and the modals belong to other lanes;
 * a tab that is handed none of them still renders — with a plain fallback card
 * and inert affordances — which is what keeps this lane independently testable.
 */
/** The slice of a ranked suggestion the dashboard renders. */
export interface SuggestionLite {
  result: OverseerrSearchResult;
  reasons: string[];
}

export interface TabDeps {
  store: WatchLogStoreApi;
  /**
   * Needed only by the surfaces that open a modal of their own — the Upcoming
   * toolbar's search-syntax tips and its saved views. Absent (tests, and any
   * host that wires no root) means those two affordances are simply not offered;
   * everything else on the tab works unchanged.
   */
  app?: App;
  /** `buildTitleCard`. Omitted until the components lane merges. */
  buildCard?: CardFactory;
  posterLoader?: PosterLoader;
  onOpenTitle?: (title: TitleV4) => void;
  /** Chip → filtered Library handoff, e.g. `genre:"Sci-Fi"`. */
  onJumpToQuery?: (query: string) => void;
  onRequest?: (title: TitleV4) => void;
  onPlayTrailer?: (title: TitleV4) => void;
  onGoToTab?: (tab: TabId) => void;
  /**
   * Suggestions built from the library, for the dashboard's panel. Returns the
   * ranked list plus a sentence about where it came from. Absent means the
   * panel is simply not offered — as it is not when no provider is configured.
   */
  onSuggest?: () => Promise<{ suggestions: SuggestionLite[]; note: string }>;
  /** Open the wizard. `fromLibrary` skips the questions. */
  onOpenSuggestWizard?: (fromLibrary: boolean) => void;
  /** Add a suggested title to the library. */
  onAddSuggestion?: (result: OverseerrSearchResult) => Promise<TitleV4 | undefined>;
  onDismissSuggestion?: (tmdbId: number) => void;
  /**
   * "Season N announced" → create it on the tracker (SPEC §4.4). Supplied by
   * the composition root, which knows the upstream episode count (or can fetch
   * it) and owns the single write.
   */
  onAddSeason?: (title: TitleV4, seasonNumber: number) => void;
  /** Deep-link to the Plex item. Only offered when it is actually on Plex. */
  onOpenInPlex?: (title: TitleV4) => void;
  /**
   * "Got it" on an aired/released row — the acknowledgement that clears it from
   * the due count. The root owns the write so this lane stays store-agnostic.
   */
  onAcknowledge?: (title: TitleV4, entry: UpcomingEntry) => void;
  /**
   * Ask upstream for fresh airing/availability data.
   *
   * `announce: false` is the quiet pass the tab runs on mount (throttled and
   * TTL-respecting on the other side); `true` is the user pressing the button,
   * which reports what happened. Absent means no refresh affordance is shown.
   */
  onRefresh?: (announce: boolean) => Promise<string>;
  /** Write the feed as an .ics into the vault. Absent means no button. */
  onExportCalendar?: () => void;
  /** Open a reading or games entry — the other libraries' Upcoming rows. */
  onOpenDomainEntry?: (domain: "reading" | "games", id: string) => void;
  /** Injectable clock; tests pin it, production leaves it out. */
  now?: () => Date;
}

export function depsNow(deps: Pick<TabDeps, "now">): Date {
  return deps.now ? deps.now() : new Date();
}

// ---------------------------------------------------------------------------
// Dates and countdowns
// ---------------------------------------------------------------------------

/**
 * Parse a `YYYY-MM-DD` string as a **local** calendar date.
 *
 * `new Date("2026-08-03")` parses as UTC midnight, which is the previous day in
 * every timezone west of Greenwich — that is how v3 managed to say "in 0 days".
 */
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole calendar days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: Date, to: Date): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Human countdown. `null` days means "date unknown" — an announced season that
 * upstream has not scheduled yet.
 */
export function formatCountdown(days: number | null): string {
  if (days === null) return "date TBA";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) {
    if (days < 30) return `in ${days} days`;
    const months = Math.round(days / 30);
    return months <= 1 ? `in ${days} days` : `in ${months} months`;
  }
  const ago = Math.abs(days);
  if (ago < 30) return `${ago} days ago`;
  const months = Math.round(ago / 30);
  return months <= 1 ? `${ago} days ago` : `${months} months ago`;
}

/**
 * Re-exported so the aux tabs keep importing dates from one place; the rules
 * themselves live in `components/dates.ts` next to the parser the editable
 * fields need (QA1 B5).
 */
export { formatDate };

/** `S03E08`, or `E8` for a show with no season data. */
export function formatEpisodeCode(season: number | undefined, episode: number): string {
  const ep = `E${String(episode).padStart(2, "0")}`;
  if (season === undefined || season <= 0) return ep;
  return `S${String(season).padStart(2, "0")}${ep}`;
}

// ---------------------------------------------------------------------------
// The upcoming model
// ---------------------------------------------------------------------------

export type UpcomingKind = "episode" | "release" | "season";

export interface UpcomingEntry {
  kind: UpcomingKind;
  title: TitleV4;
  /** `null` for an announced season upstream has not dated yet. */
  date: string | null;
  /** Calendar days from "today"; `null` when `date` is null. */
  daysUntil: number | null;
  /** Short what-airs label: `S03E08`, `Season 4`, `Release`. */
  label: string;
  /** Longer human sentence for the row's second line. May be empty. */
  detail: string;
  /**
   * For a season row: is that season already on the tracker?
   *
   * `true` — and it is the normal case now — means the row is reporting what the
   * show is doing, not asking the user to do anything.
   */
  tracked?: boolean;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Does the tracker already hold this season number? */
export function hasSeason(title: TitleV4, seasonNumber: number): boolean {
  return title.seasons.some((season, index) => (season.seasonNumber ?? index + 1) === seasonNumber);
}

/** How far back an already-aired item stays on the list. */
export const UPCOMING_PAST_WINDOW_DAYS = 7;

export interface UpcomingOptions {
  /** Days of already-aired history to keep. Defaults to `UPCOMING_PAST_WINDOW_DAYS`. */
  pastWindowDays?: number;
}

/**
 * Build the chronological list.
 *
 * Sources, in priority order per title:
 *   - `airing.newSeasonDetected` → a "Season N announced" row;
 *   - `airing.nextEpisode` → the next-episode row, unless the season row above
 *     already covers exactly that date and season (which would be the same news
 *     printed twice);
 *   - a `releaseDate` (or `airing.digitalReleaseDate` once the theatrical date
 *     has passed) → a release row.
 *
 * Dated rows sort ascending; undated announcements land at the end.
 */
export function buildUpcomingEntries(
  titles: readonly TitleV4[],
  now: Date = new Date(),
  options: UpcomingOptions = {},
): UpcomingEntry[] {
  const pastWindow = options.pastWindowDays ?? UPCOMING_PAST_WINDOW_DAYS;
  const out: UpcomingEntry[] = [];

  const push = (entry: UpcomingEntry): void => {
    if (entry.daysUntil !== null && entry.daysUntil < -pastWindow) return;
    if (isAcknowledged(entry.title, entry.kind, entry.date)) return;
    out.push(entry);
  };

  for (const title of titles) {
    const airing = title.airing;
    const next = airing?.nextEpisode;
    const nextDate = parseDateOnly(next?.airDate);

    // The season row.
    //
    // Two very different things used to share it: "a season exists upstream that
    // your tracker lacks" (a chore) and "this show's next season" (news). With
    // seasons adopted automatically the first stops happening, so `pendingSeason`
    // — the next season that has not started airing — is the primary source, and
    // `newSeasonDetected` only still matters when auto-sync is off (QA3).
    const pending = airing?.pendingSeason;
    const season = pending?.number ?? airing?.newSeasonDetected;

    if (season !== undefined && season > 0) {
      // Once episodes of that season are scheduled, the normal next-episode row
      // says everything the season row would and says it with a real date, so
      // the season row stands down rather than duplicating it (QA3).
      const covers = next !== undefined && next.season === season && nextDate !== null;
      if (!covers) {
        const tracked = hasSeason(title, season);
        const date = pending?.airDate ?? null;
        push({
          kind: "season",
          title,
          date,
          daysUntil: date ? daysBetween(now, parseDateOnly(date) as Date) : null,
          label: `Season ${season}`,
          // A followed show's next season is a status line, not a task. The
          // nag survives only for the case where it is still true.
          detail: tracked
            ? (pending?.episodes ?? 0) > 0
              ? `${pending?.episodes} episodes announced`
              : ""
            : `Season ${season} announced — not on your tracker yet`,
          tracked,
          seasonNumber: season,
        });
      }
    }

    if (next && nextDate) {
      push({
        kind: "episode",
        title,
        date: next.airDate,
        daysUntil: daysBetween(now, nextDate),
        label: formatEpisodeCode(next.season, next.episode),
        detail: next.name ? next.name : "New episode",
        seasonNumber: next.season,
        episodeNumber: next.episode,
      });
    }

    // Releases: the theatrical/first-air date until it passes, then the digital
    // date when Overseerr/TMDB gave us one.
    const theatrical = parseDateOnly(title.releaseDate);
    const digital = parseDateOnly(airing?.digitalReleaseDate);
    let releaseDate: Date | null = null;
    let digitalRelease = false;
    if (theatrical && daysBetween(now, theatrical) >= -pastWindow) {
      releaseDate = theatrical;
    } else if (digital && daysBetween(now, digital) >= -pastWindow) {
      releaseDate = digital;
      digitalRelease = true;
    }
    if (releaseDate && !next) {
      const days = daysBetween(now, releaseDate);
      // One label per row, in one tense. "Release" in the label plus "Released"
      // in the detail was the same word twice with different endings (QA1 B4);
      // the row already carries the date and the countdown, so the second line
      // only earns its place while the release is still ahead.
      const out = days < 0;
      push({
        kind: "release",
        title,
        date: `${releaseDate.getFullYear()}-${String(releaseDate.getMonth() + 1).padStart(2, "0")}-${String(releaseDate.getDate()).padStart(2, "0")}`,
        daysUntil: days,
        label: out ? (digitalRelease ? "Released digitally" : "Released") : digitalRelease ? "Digital release" : "Release",
        detail: out ? "" : `${title.type} release`,
      });
    }
  }

  out.sort((a, b) => {
    if (a.date === null && b.date === null) return a.title.title.localeCompare(b.title.title);
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.title.title.localeCompare(b.title.title);
  });

  return out;
}

/** Rows that have aired or air today — the status-bar number (SPEC §4.11). */
export function countDue(entries: readonly UpcomingEntry[]): number {
  return entries.filter((e) => isDue(e)).length;
}

/** Aired, released, or happening today: the rows that want an action from you. */
export function isDue(entry: UpcomingEntry): boolean {
  return entry.daysUntil !== null && entry.daysUntil <= 0;
}

/**
 * Has the user already ticked this exact row off?
 *
 * Matched on kind **and** date, so acknowledging "released 2026-07-31" clears
 * that row and nothing else — a later episode or a digital release with its own
 * date is new news and comes back.
 */
export function isAcknowledged(
  title: TitleV4,
  kind: UpcomingKind,
  date: string | null,
): boolean {
  const ack = title.upcomingAcknowledged;
  if (!ack) return false;
  return ack.kind === kind && (ack.date ?? null) === (date ?? null);
}

/** The patch that clears a row from "due". */
export function acknowledgePatch(
  entry: UpcomingEntry,
  at: Date = new Date(),
): Pick<TitleV4, "upcomingAcknowledged"> {
  return {
    upcomingAcknowledged: { kind: entry.kind, date: entry.date, at: at.toISOString() },
  };
}

/**
 * The header counts.
 *
 * "1 scheduled · 1 due" for a single released film counted the same row twice
 * (QA1 B4). The three states are disjoint now — still to come, wants attention,
 * announced but undated — and a state with nothing in it is not mentioned.
 */
export interface UpcomingCounts {
  upcoming: number;
  due: number;
  announced: number;
}

export function countEntries(
  // Only the countdown matters, so a unified row from another library counts
  // exactly as a watchlist entry does — one header, one set of numbers.
  entries: readonly Pick<UpcomingEntry, "daysUntil">[],
): UpcomingCounts {
  let upcoming = 0;
  let due = 0;
  let announced = 0;
  for (const entry of entries) {
    // One definition of the three states, shared with the State facet — see
    // `upcomingStateOf`. Counting them a second time here is how the header and
    // the chips would drift apart.
    switch (upcomingStateOf(entry.daysUntil)) {
      case "announced":
        announced += 1;
        break;
      case "due":
        due += 1;
        break;
      default:
        upcoming += 1;
    }
  }
  return { upcoming, due, announced };
}

export function summarizeCounts(counts: UpcomingCounts): string {
  const parts: string[] = [];
  if (counts.upcoming > 0) parts.push(`${counts.upcoming} scheduled`);
  if (counts.due > 0) parts.push(`${counts.due} due`);
  if (counts.announced > 0) parts.push(`${counts.announced} announced`);
  return parts.join(" · ");
}

export type UpcomingBucket = "aired" | "today" | "tomorrow" | "week" | "later" | "tba";

export function bucketFor(entry: UpcomingEntry): UpcomingBucket {
  const days = entry.daysUntil;
  if (days === null) return "tba";
  if (days < 0) return "aired";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

export const BUCKET_LABELS: Record<UpcomingBucket, string> = {
  aired: "Already aired",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
  tba: "Announced — no date yet",
};

const BUCKET_ORDER: UpcomingBucket[] = ["aired", "today", "tomorrow", "week", "later", "tba"];

/** Group in display order, dropping empty buckets. */
export function groupByBucket(
  entries: readonly UpcomingEntry[],
): { bucket: UpcomingBucket; entries: UpcomingEntry[] }[] {
  const map = new Map<UpcomingBucket, UpcomingEntry[]>();
  for (const entry of entries) {
    const bucket = bucketFor(entry);
    const list = map.get(bucket);
    if (list) list.push(entry);
    else map.set(bucket, [entry]);
  }
  const out: { bucket: UpcomingBucket; entries: UpcomingEntry[] }[] = [];
  for (const bucket of BUCKET_ORDER) {
    const list = map.get(bucket);
    if (list && list.length > 0) out.push({ bucket, entries: list });
  }
  return out;
}

// ---------------------------------------------------------------------------
// State labels (Plex / request), shared by every aux surface
// ---------------------------------------------------------------------------

export interface StatePill {
  text: string;
  /** Drives `.wl-pill.is-ok` / `.is-warn` / `.is-muted`. */
  tone: "ok" | "warn" | "muted";
}

export function plexPill(title: TitleV4): StatePill | null {
  const plex = title.plex;
  if (!plex || plex.state === "unknown") return null;
  if (plex.state === "available") return { text: "On Plex", tone: "ok" };
  if (plex.state === "partial") {
    const have = plex.leafCount ?? plex.episodes?.length ?? 0;
    const total = title.totalEpisodes;
    return { text: total > 0 ? `${have}/${total} eps` : `${have} eps`, tone: "warn" };
  }
  return { text: "Not on Plex", tone: "muted" };
}

/**
 * Request progression pill (SPEC §4.2). `mediaStatus` describes the media,
 * `status` describes the request row — they are different enums and this is the
 * one place that keeps them apart.
 */
export function requestPill(title: TitleV4): StatePill | null {
  const request = title.request;
  if (!request || (request.id === undefined && request.mediaStatus === undefined)) return null;
  switch (request.mediaStatus) {
    case MediaStatus.AVAILABLE:
      return { text: "Available", tone: "ok" };
    case MediaStatus.PARTIALLY_AVAILABLE:
      return { text: "Partially available", tone: "warn" };
    case MediaStatus.PROCESSING:
      return { text: "Processing", tone: "warn" };
    default:
      break;
  }
  if (request.status === 2) return { text: "Approved", tone: "warn" };
  if (request.status === 3) return { text: "Declined", tone: "muted" };
  if (request.status === 4) return { text: "Request failed", tone: "muted" };
  return { text: "Requested", tone: "warn" };
}

/** `12 of 33 · 4 left` style progress sentence, or `""` for a single-episode title. */
export function progressSentence(title: TitleV4): string {
  if (title.totalEpisodes <= 1) return "";
  const left = episodesRemaining(title);
  const next = getNextUnwatchedEpisode(title);
  if (left === 0) return "All episodes watched";
  if (next === null) return `${left} left`;
  const pair = toSeasonEpisode(title, next);
  const code = pair
    ? formatEpisodeCode(pair.season.seasonNumber ?? pair.seasonIndex + 1, pair.episode)
    : `E${next}`;
  return `Next up ${code} · ${left} left`;
}

// ---------------------------------------------------------------------------
// Small DOM helpers shared by the aux tabs
// ---------------------------------------------------------------------------

/**
 * foodspot's `section()`: a render error inside one block must never blank the
 * whole tab. The panel says which section broke and prints the message.
 */
export function section(parent: HTMLElement, label: string, render: (el: HTMLElement) => void): HTMLElement {
  const el = parent.createDiv({ cls: "wl-section" });
  try {
    render(el);
  } catch (err) {
    el.empty();
    el.addClass("is-broken");
    const panel = el.createDiv({ cls: "wl-error-panel" });
    const head = panel.createDiv({ cls: "wl-error-panel-head" });
    setIcon(head.createSpan({ cls: "wl-error-panel-icon" }), "alert-triangle");
    head.createSpan({ text: `${label} could not be rendered` });
    panel.createDiv({
      cls: "wl-error-panel-body",
      text: err instanceof Error ? err.message : String(err),
    });
    console.error(`[wrl] section "${label}" failed`, err);
  }
  return el;
}

export function sectionHeader(parent: HTMLElement, title: string, meta?: string): HTMLElement {
  const head = parent.createDiv({ cls: "wl-section-head" });
  head.createDiv({ cls: "wl-section-title", text: title });
  if (meta) head.createDiv({ cls: "wl-section-meta", text: meta });
  return head;
}

export interface EmptyStateOptions {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}

export function renderEmptyState(parent: HTMLElement, options: EmptyStateOptions): HTMLElement {
  const el = parent.createDiv({ cls: "wl-empty" });
  setIcon(el.createDiv({ cls: "wl-empty-icon" }), options.icon);
  el.createDiv({ cls: "wl-empty-title", text: options.title });
  el.createDiv({ cls: "wl-empty-body", text: options.body });
  if (options.action) {
    const button = el.createEl("button", {
      cls: "wl-empty-action mod-cta",
      text: options.action.label,
      attr: { type: "button" },
    });
    button.addEventListener("click", options.action.onClick);
  }
  return el;
}

/**
 * The poster URL for a thumb, resolved against the TMDB CDN.
 *
 * Delegated to `components/posters.ts` rather than re-derived: that is where the
 * `"none"`-sentinel filtering and the bare-path (`/abc.jpg` → `image.tmdb.org/
 * t/p/w342/abc.jpg`) expansion live, and two copies of that rule is exactly how
 * one surface ends up rendering a broken image the others don't.
 */
export function posterSrc(title: TitleV4): string {
  return resolvePosterUrl(posterUrlFor(title));
}

/** Deterministic tint so a poster-less thumb still reads as a distinct object. */
export function placeholderTint(title: TitleV4): string {
  let hash = 0;
  for (const char of title.id || title.title) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  const strength = 8 + (hash % 4) * 6;
  return `color-mix(in srgb, var(--interactive-accent) ${strength}%, var(--background-secondary))`;
}

/**
 * A 2:3 poster thumb. Uses the shared lazy loader when one was injected, and a
 * tinted initial when there is no poster at all — never a broken image.
 */
export function renderPosterThumb(
  parent: HTMLElement,
  title: TitleV4,
  deps: Pick<TabDeps, "posterLoader">,
  cls = "wl-thumb",
): HTMLElement {
  const el = parent.createDiv({ cls });
  const src = posterSrc(title);
  if (!src) {
    el.addClass("is-placeholder");
    el.style.setProperty("--wl-tint", placeholderTint(title));
    el.createSpan({ cls: "wl-thumb-initial", text: (title.title[0] ?? "?").toUpperCase() });
    return el;
  }
  if (deps.posterLoader) {
    // The loader reads this when a fetch fails, so the fallback tint matches
    // the one a poster-less thumb would have had.
    el.dataset.posterSeed = title.title;
    deps.posterLoader.observe(el, src);
    return el;
  }
  el.createEl("img", {
    cls: "wl-thumb-img",
    attr: { src, alt: title.title, loading: "lazy", decoding: "async" },
  });
  return el;
}

/**
 * Compact stand-in for `buildTitleCard`, used only until the components lane
 * merges. Deliberately plain: poster, title, one meta line, click-to-open.
 */
export function renderFallbackCard(parent: HTMLElement, title: TitleV4, ctx: CardContext): void {
  const card = parent.createDiv({ cls: `wl-fallback-card is-${ctx.variant}` });
  const src = posterSrc(title);
  const poster = card.createDiv({ cls: "wl-fallback-poster" });
  if (src) {
    poster.createEl("img", {
      attr: { src, alt: title.title, loading: "lazy", decoding: "async" },
    });
  } else {
    poster.addClass("is-placeholder");
    poster.style.setProperty("--wl-tint", placeholderTint(title));
    poster.createSpan({ cls: "wl-thumb-initial", text: (title.title[0] ?? "?").toUpperCase() });
  }
  const body = card.createDiv({ cls: "wl-fallback-body" });
  body.createDiv({ cls: "wl-fallback-title", text: title.title });
  const meta = [title.type, title.status].filter(Boolean).join(" · ");
  body.createDiv({ cls: "wl-fallback-meta", text: meta });
  if (ctx.showProgress && title.totalEpisodes > 1) {
    const sentence = progressSentence(title);
    if (sentence) body.createDiv({ cls: "wl-fallback-meta", text: sentence });
  }
  if (ctx.onOpen) {
    card.addClass("is-clickable");
    card.setAttr("role", "button");
    card.tabIndex = 0;
    const open = (): void => ctx.onOpen?.(title);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        open();
      }
    });
  }
}

/** `deps.buildCard` when the components lane is present, the fallback otherwise. */
export function cardRenderer(deps: Pick<TabDeps, "buildCard">): CardFactory {
  return deps.buildCard ?? renderFallbackCard;
}

export function cardContext(
  deps: TabDeps,
  variant: CardVariant,
  overrides: Partial<CardContext> = {},
): CardContext {
  const ctx: CardContext = {
    store: deps.store,
    variant,
    showActions: variant === "full",
    showPlexBadge: true,
    showAiringChip: true,
    showProgress: variant !== "mini",
    showRating: variant !== "mini",
    embedded: false,
    ...overrides,
  };
  if (deps.onOpenTitle && !overrides.onOpen) ctx.onOpen = deps.onOpenTitle;
  if (deps.onJumpToQuery && !overrides.onJumpToQuery) ctx.onJumpToQuery = deps.onJumpToQuery;
  if (deps.onRequest && !overrides.onRequest) ctx.onRequest = deps.onRequest;
  if (deps.onPlayTrailer && !overrides.onPlayTrailer) ctx.onPlayTrailer = deps.onPlayTrailer;
  if (deps.posterLoader && !overrides.posterLoader) ctx.posterLoader = deps.posterLoader;
  return ctx;
}

export function renderPill(parent: HTMLElement, pill: StatePill): HTMLElement {
  return parent.createSpan({ cls: `wl-pill is-${pill.tone}`, text: pill.text });
}

/** A row action. Always labelled, always stops the row's own open handler. */
function miniButton(
  parent: HTMLElement,
  label: string,
  ariaLabel: string,
  onClick: () => void,
): HTMLElement {
  const button = parent.createEl("button", {
    cls: "wl-mini-btn",
    text: label,
    attr: { type: "button", "aria-label": ariaLabel },
  });
  button.addEventListener("click", (evt: MouseEvent) => {
    evt.stopPropagation();
    onClick();
  });
  return button;
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

/**
 * The heading over the past-window tail.
 *
 * The same words as the `Recently released` time-window chip, deliberately: the
 * chip shows exactly this section and nothing else.
 */
export const RECENTLY_RELEASED_LABEL = "Recently released";

/**
 * The Upcoming tab.
 *
 * One list of everything that is about to happen, across every library, with the
 * same toolbar the other three tabs have — search, facets, sort, saved views —
 * and one axis none of them needs: a **time window**. The pipeline is the same
 * one line the Library runs, over unified rows:
 *
 *     results = sort(search(facetFilter(all)))
 *
 * Two decisions worth stating:
 *
 *   - **the three libraries are one list**, not three sections. They always were
 *     three sections stapled together, which made "what is happening this week"
 *     a question you had to answer twice; a Library facet does that job now and
 *     the chronology is unbroken.
 *   - **buckets only under the default sort.** "Today / Tomorrow / This week" is
 *     a chronological reading aid; under `Title A→Z` it would be a lie about the
 *     order, so the list goes flat and the countdown on each row carries it.
 */
export function mountUpcomingTab(host: HTMLElement, deps: TabDeps): TabController {
  const settings = deps.store.settings;
  const el = host.createDiv({ cls: "wl-tab-panel wl-tab-panel-upcoming" });
  const toolbar = el.createDiv({ cls: "wl-upcoming-toolbar" });
  const drawerHost = el.createDiv({ cls: "wl-filter-host" });
  const infoBar = el.createDiv({ cls: "wl-infobar" });
  const resultsHost = el.createDiv({ cls: "wl-upcoming-results" });

  // The whole view — query, facets, both sort levels and the saved views — comes
  // off `settings` under one round-tripped key, exactly as the Games tab's does.
  const view = readUpcomingViewState(settings);
  let refreshing = false;

  function persist(reason: string): void {
    writeUpcomingViewState(settings, view);
    deps.store.save(reason);
  }

  /** Every library's rows, unfiltered — the pool the facets count over. */
  function pool(): UnifiedRow[] {
    return buildUnifiedUpcoming(deps.store.allTitles(), deps.store.reading, deps.store.games, {
      now: depsNow(deps),
    });
  }

  /**
   * Ask upstream what has changed (QA2 report 1, fix 4).
   *
   * The schedule was only ever refreshed on plugin load and on the *view*
   * opening, both silent and both easy to miss — a user who left Obsidian open
   * for a day and switched to Upcoming saw yesterday's answer with no way to say
   * "check again". This is that way, and it also runs once on mount.
   */
  const runRefresh = async (announce: boolean): Promise<void> => {
    if (!deps.onRefresh || refreshing) return;
    refreshing = true;
    syncRefreshButton();
    try {
      const message = await deps.onRefresh(announce);
      if (announce && message) new Notice(message);
    } catch (err) {
      if (announce) {
        new Notice(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.warn("[wrl] upcoming refresh failed", err);
    } finally {
      refreshing = false;
      syncRefreshButton();
      render();
    }
  };

  // --- toolbar ------------------------------------------------------------

  const searchBox = createSearchBox(toolbar, {
    value: view.query,
    // Plain words, because plain words work (QA2 report 2). The grammar lives
    // behind the `?`.
    placeholder: "Search upcoming…",
    onChange: (value) => {
      view.query = value;
      persist("upcoming-query");
      render();
    },
    ...(deps.app ? { onTips: (): void => new UpcomingSearchTipsModal(deps.app as App).open() } : {}),
  });

  const filters = createFacetPanel(toolbar, {
    cls: "wl-upcoming-filters",
    // Rebuilt per open over the *unfiltered* pool, so a chip's count says what
    // excluding it would cost, and a facet nothing produces is not offered.
    sections: () =>
      buildUpcomingFacetSections(pool(), view.filters).map((section) => ({
        key: section.key,
        label: section.label,
        options: section.options,
      })),
    excludedFor: (key) => excludedForUpcoming(view.filters, key as UpcomingFacetKey),
    setExcludedFor: (key, values) =>
      setExcludedForUpcoming(view.filters, key as UpcomingFacetKey, values),
    toggles: () => [
      {
        label: "Favourites only",
        icon: "heart",
        get: () => view.filters.favoritesOnly,
        set: (on) => {
          view.filters.favoritesOnly = on;
        },
      },
    ],
    choices: () => [
      {
        label: "Time window",
        options: UPCOMING_WINDOWS.map((window) => ({
          value: window,
          label: UPCOMING_WINDOW_LABELS[window],
        })),
        get: () => view.filters.window,
        set: (value) => {
          view.filters.window = value as UpcomingWindow;
        },
        note: "A window looks forward; “Recently released” is the section below, on its own. Rows with no date yet appear under “All”.",
      },
    ],
    isActive: () => isUpcomingFilterActive(view.filters),
    clear: () => clearUpcomingFilters(view.filters),
    // The panel debounces only the *disk* write, so the in-memory settings
    // object is stamped on every click — otherwise a tab torn down mid-debounce
    // would come back having forgotten what you just filtered by.
    onChange: () => {
      writeUpcomingViewState(settings, view);
      render();
    },
    onPersist: () => deps.store.save("upcoming-filters"),
    panelHost: drawerHost,
  });

  const presets = deps.app
    ? createPresetButton<UpcomingPreset, ReturnType<typeof currentView>>(toolbar, {
        app: deps.app,
        getPresets: () => view.presets,
        getView: () => currentView(),
        makePreset: (name, captured) => toUpcomingPreset(name, captured, makeUpcomingPresetId()),
        mergeView: (preset, captured) => ({
          ...toUpcomingPreset(preset.name, captured, preset.id),
        }),
        onApply: (preset) => applyPreset(preset),
        onChange: (next) => {
          view.presets = next;
          persist("upcoming-presets");
          presets?.refresh();
        },
      })
    : null;

  const sortButton = createSortButton<UpcomingSortKey>(toolbar, {
    getSort: () => view.sort,
    getSecondary: () => view.secondarySort,
    keys: UPCOMING_SORT_KEYS,
    labels: (key) => upcomingSortLabel(key),
    defaultDirection: (key) => UPCOMING_SORT_DEFAULT_DIR[key],
    onChange: (sort, secondary) => {
      view.sort = sort as UpcomingSortSpec;
      view.secondarySort = secondary as UpcomingSortSpec | null;
      persist("upcoming-sort");
      render();
    },
  });

  toolbar.createDiv({ cls: "wl-toolbar-spacer" });

  if (deps.onExportCalendar) {
    const exportButton = toolbar.createEl("button", {
      cls: "wl-btn wl-icon-btn wl-upcoming-export",
      attr: {
        type: "button",
        "aria-label": "Export this feed as a calendar (.ics)",
        title: "Export this feed as a calendar (.ics)",
      },
    });
    setIcon(exportButton, "calendar-plus");
    exportButton.addEventListener("click", () => deps.onExportCalendar?.());
  }

  const refreshButton = deps.onRefresh
    ? toolbar.createEl("button", {
        cls: "wl-btn wl-icon-btn wl-upcoming-refresh",
        attr: {
          type: "button",
          "aria-label": "Check upstream for new episodes and seasons",
          title: "Check upstream for new episodes and seasons",
        },
      })
    : null;
  if (refreshButton) {
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", () => void runRefresh(true));
  }

  function syncRefreshButton(): void {
    if (!refreshButton) return;
    refreshButton.toggleClass("is-spinning", refreshing);
    refreshButton.disabled = refreshing;
  }

  const counterEl = infoBar.createDiv({ cls: "wl-results-info" });
  const summaryEl = infoBar.createDiv({ cls: "wl-upcoming-summary" });

  // --- view state ---------------------------------------------------------

  function currentView(): {
    query: string;
    filters: typeof view.filters;
    sort: UpcomingSortSpec;
    secondarySort: UpcomingSortSpec | null;
  } {
    return {
      query: view.query,
      filters: view.filters,
      sort: view.sort,
      secondarySort: view.secondarySort,
    };
  }

  function applyPreset(preset: UpcomingPreset): void {
    const restored = fromUpcomingPreset(preset);
    view.query = restored.query;
    // In place: the filter panel holds this exact object.
    assignUpcomingFilters(view.filters, restored.filters);
    view.sort = restored.sort;
    view.secondarySort = restored.secondarySort;
    searchBox.setValue(view.query);
    filters.refresh();
    sortButton.refresh();
    persist("upcoming-preset-applied");
    render();
  }

  function clearEverything(): void {
    view.query = "";
    searchBox.setValue("");
    clearUpcomingFilters(view.filters);
    filters.refresh();
    persist("upcoming-filters-cleared");
    render();
  }

  // --- rendering ----------------------------------------------------------

  function render(): void {
    // Emptying detaches the thumbs while the shared observer still holds
    // them, so hand them back first — otherwise every data-changed event
    // strands another batch of detached DOM.
    deps.posterLoader?.releaseWithin?.(resultsHost);
    resultsHost.empty();
    syncRefreshButton();

    const now = depsNow(deps);
    const all = pool();
    const faceted = applyUpcomingFilters(all, view.filters, now);
    const matched =
      view.query.trim() === "" ? faceted : new UpcomingSearchEngine(faceted).filter(view.query);
    const results = sortUpcomingRows(matched, view.sort, view.secondarySort);

    renderCounter(all, results);

    // Two different situations with two different fixes (foodspot convention
    // 10): nothing is scheduled at all, versus nothing survives the filters.
    if (all.length === 0) {
      const hasEntries =
        deps.store.allTitles().length > 0 ||
        (deps.store.reading?.books.length ?? 0) + (deps.store.reading?.manga.length ?? 0) > 0 ||
        (deps.store.games?.games.length ?? 0) > 0;
      renderSharedEmptyState(resultsHost, {
        cls: "is-first-run",
        icon: "calendar",
        title: hasEntries ? "Nothing scheduled" : "Nothing to look forward to yet",
        body: hasEntries
          ? "Nothing you track has a known next episode, announced season or release date. Checking upstream is the fastest way to find out whether that is still true."
          : "Add a show, a book or a game and the plugin will track its next episode and release date here.",
        // The CTA only appears when there is something it could actually fix.
        actions:
          hasEntries && deps.onRefresh
            ? [
                {
                  label: refreshing ? "Checking…" : "Check for updates",
                  onClick: () => void runRefresh(true),
                  cta: true,
                },
              ]
            : [],
      });
      return;
    }

    if (results.length === 0) {
      renderSharedEmptyState(resultsHost, {
        cls: "is-no-match",
        icon: "search-x",
        title: "Nothing matches",
        body: `Your search or filters rule out all ${all.length} scheduled item${all.length === 1 ? "" : "s"}. Clearing both brings the whole schedule back.`,
        actions: [
          { label: "Clear search & filters", onClick: () => clearEverything(), cta: true },
        ],
      });
      return;
    }

    // The tab is a list of what is still to COME. What landed in the past week
    // is real news too, but it is a different question ("did I miss anything?"),
    // so it gets its own section underneath rather than the top of the list.
    const ahead = results.filter((row) => !hasArrived(row));
    const arrived = results.filter((row) => hasArrived(row));

    renderAhead(ahead);
    renderArrived(arrived);
  }

  function renderAhead(rows: readonly UnifiedRow[]): void {
    if (rows.length === 0) return;
    // Buckets are a chronological aid, so they are offered only while the list
    // is actually chronological.
    if (view.sort.key === "date" && view.sort.direction === "asc") {
      for (const group of groupUnifiedByBucket(rows)) {
        section(resultsHost, BUCKET_LABELS[group.bucket], (sectionEl) => {
          sectionEl.addClass("wl-upcoming-group");
          sectionEl.createDiv({
            cls: "wl-upcoming-group-label",
            text: BUCKET_LABELS[group.bucket],
          });
          const list = sectionEl.createDiv({ cls: "wl-upcoming-list" });
          for (const row of group.rows) renderRow(list, row);
        });
      }
      return;
    }

    section(resultsHost, "Upcoming", (sectionEl) => {
      sectionEl.addClass("wl-upcoming-group");
      const list = sectionEl.createDiv({ cls: "wl-upcoming-list" });
      for (const row of rows) renderRow(list, row);
    });
  }

  /**
   * What has already landed, in the past-window tail.
   *
   * Newest first while the list above is in its default soonest-first order:
   * the two lists then read outward from today in both directions, and the
   * thing that just came out is the first one you see. Any other sort is the
   * user's explicit instruction, so this section follows it.
   */
  function renderArrived(rows: readonly UnifiedRow[]): void {
    if (rows.length === 0) return;
    const sorted =
      view.sort.key === "date" && view.sort.direction === "asc"
        ? sortUpcomingRows(rows, { key: "date", direction: "desc" }, view.secondarySort)
        : rows;

    section(resultsHost, RECENTLY_RELEASED_LABEL, (sectionEl) => {
      sectionEl.addClass("wl-upcoming-group", "is-released");
      sectionEl.createDiv({
        cls: "wl-upcoming-group-label",
        text: `${RECENTLY_RELEASED_LABEL} · ${sorted.length}`,
      });
      const list = sectionEl.createDiv({ cls: "wl-upcoming-list" });
      for (const row of sorted) renderRow(list, row);
    });
  }

  /**
   * A watchlist row keeps its own renderer — the season, request and "got it"
   * affordances only mean anything for a title — and the other libraries keep
   * the compact one. Same shape, same buckets, different verbs.
   */
  function renderRow(list: HTMLElement, row: UnifiedRow): HTMLElement {
    if (row.entry.source === "watchlist") {
      return renderUpcomingRow(list, row.entry.value, deps);
    }
    return renderUnifiedRow(list, row, deps);
  }

  /**
   * "3 of 7 upcoming · 2 recently released".
   *
   * The headline number counts what is still to come, because that is what the
   * tab is; the released tail is named separately rather than folded into a
   * total that would then have to be called something vaguer.
   */
  function renderCounter(pool: readonly UnifiedRow[], results: readonly UnifiedRow[]): void {
    const narrowed = view.query.trim() !== "" || isUpcomingFilterActive(view.filters);
    const total = pool.filter((row) => !hasArrived(row)).length;
    const ahead = results.filter((row) => !hasArrived(row));
    const arrived = results.length - ahead.length;
    const head = narrowed ? `${ahead.length} of ${total} upcoming` : `${total} upcoming`;
    counterEl.setText(
      arrived === 0 ? head : `${head} · ${arrived} recently released`,
    );
    // The same three disjoint states the header has always used, over whatever
    // is on screen.
    summaryEl.setText(summarizeCounts(countEntries(results)));
  }

  render();
  // Opening the tab is the moment a user most expects the schedule to be
  // current. Quiet: throttled and TTL-respecting on the integration side.
  void runRefresh(false);

  return {
    id: "upcoming",
    el,
    refresh(): void {
      filters.refresh();
      presets?.refresh();
      sortButton.refresh();
      render();
    },
    destroy(): void {
      // The loader is shared with every other surface, so this tab has to hand
      // its own thumbs back before the DOM goes away.
      deps.posterLoader?.releaseWithin?.(el);
      searchBox.destroy();
      filters.destroy();
      presets?.destroy();
      sortButton.destroy();
      el.remove();
    },
  };
}

export function renderUpcomingRow(parent: HTMLElement, entry: UpcomingEntry, deps: TabDeps): HTMLElement {
  const { title } = entry;
  const row = parent.createDiv({ cls: `wl-upcoming-row is-${entry.kind}` });

  renderPosterThumb(row, title, deps);

  const body = row.createDiv({ cls: "wl-upcoming-body" });
  const titleRow = body.createDiv({ cls: "wl-upcoming-titlerow" });
  titleRow.createSpan({ cls: "wl-upcoming-name", text: title.title });
  titleRow.createSpan({ cls: "wl-upcoming-label", text: entry.label });

  // Always rendered, empty or not. Some rows genuinely have no detail (see the
  // release rows in `buildUpcomingEntries`) — and a row that drops the line is
  // a row shorter than the one above it, which is what makes a list ragged.
  // The gap is the point: it holds the date line at the same height on every row.
  body.createDiv({ cls: "wl-upcoming-detail", text: entry.detail ?? "" });

  const meta = body.createDiv({ cls: "wl-upcoming-meta" });
  const dateText = formatDate(entry.date, deps.store.settings.dateFormat);
  if (dateText) meta.createSpan({ cls: "wl-upcoming-date", text: dateText });
  meta.createSpan({
    cls: `wl-countdown is-${bucketFor(entry)}`,
    text: formatCountdown(entry.daysUntil),
  });

  const states = row.createDiv({ cls: "wl-upcoming-states" });

  // An announced season the tracker does not have yet: the action that matters
  // is "add it", not "request it" — you cannot tick episodes that do not exist.
  if (
    entry.kind === "season" &&
    entry.tracked !== true &&
    deps.onAddSeason &&
    entry.seasonNumber !== undefined
  ) {
    const seasonNumber = entry.seasonNumber;
    const add = states.createEl("button", {
      cls: "wl-mini-btn is-primary",
      text: `Add season ${seasonNumber}`,
      attr: { type: "button", "aria-label": `Add season ${seasonNumber} of ${title.title} to your tracker` },
    });
    add.addEventListener("click", (evt) => {
      evt.stopPropagation();
      deps.onAddSeason?.(title, seasonNumber);
    });
  }

  /**
   * **One** state pill, in the same words as the Availability facet.
   *
   * A row used to be able to say "Not on Plex" and "Processing" side by side —
   * both true, together nonsense: the first is why you might act and the second
   * is why you should not. So the row states the answer ("Queued for download")
   * and keeps Overseerr's own word in the tooltip, where it explains rather than
   * competes. Only a *negative* request state survives as a second pill, because
   * "Declined" is news the availability word cannot carry.
   */
  const availability = availabilityOfTitle(title);
  const request = requestPill(title);
  if (availability === "plex") {
    // Partial keeps its precision — "12/22 eps" says more than "On Plex".
    const plex = plexPill(title);
    if (plex) renderPill(states, plex);
  } else if (availability === "queued") {
    const pill = renderPill(states, { text: "Queued for download", tone: "warn" });
    pill.setAttr(
      "title",
      request
        ? `Radarr/Sonarr has this — Overseerr says “${request.text}”`
        : "Radarr/Sonarr has this; it is not on Plex yet",
    );
  } else {
    renderPill(states, { text: "Not on Plex", tone: "muted" });
    // Declined, failed — the reason nothing is coming.
    if (request) renderPill(states, request);
  }

  if (availability === "plex" && deps.onOpenInPlex) {
    miniButton(states, "Open in Plex", `Open ${title.title} in Plex`, () =>
      deps.onOpenInPlex?.(title),
    );
  }
  // Not on Plex and nothing on the way — including a title nobody could scan,
  // and one whose earlier request was declined or failed. Asking again is the
  // whole point of the button.
  if (availability === "not-plex" && deps.onRequest) {
    miniButton(states, "Request", `Request ${title.title}`, () => deps.onRequest?.(title));
  }

  // A released film that is not on Plex and was never requested would otherwise
  // sit in "due" until the past window closed over it. This is the way out, and
  // it clears exactly this row (QA1 B4).
  if (isDue(entry) && deps.onAcknowledge) {
    miniButton(
      states,
      "Got it",
      `Clear ${title.title} — ${entry.label.toLowerCase()} — from what needs attention`,
      () => deps.onAcknowledge?.(title, entry),
    );
  }

  if (deps.onOpenTitle) {
    row.addClass("is-clickable");
    row.setAttr("role", "button");
    row.tabIndex = 0;
    const open = (): void => deps.onOpenTitle?.(title);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        open();
      }
    });
  }

  return row;
}

// ---------------------------------------------------------------------------
// The other libraries' rows (W8-integration)
// ---------------------------------------------------------------------------

/** The same buckets the watchlist rows use, over unified rows. */
export function groupUnifiedByBucket(
  rows: readonly UnifiedRow[],
): { bucket: UpcomingBucket; rows: UnifiedRow[] }[] {
  const map = new Map<UpcomingBucket, UnifiedRow[]>();
  for (const row of rows) {
    const bucket = bucketFor({ daysUntil: row.daysUntil } as UpcomingEntry);
    const list = map.get(bucket);
    if (list) list.push(row);
    else map.set(bucket, [row]);
  }
  const out: { bucket: UpcomingBucket; rows: UnifiedRow[] }[] = [];
  for (const bucket of ["aired", "today", "tomorrow", "week", "later", "tba"] as UpcomingBucket[]) {
    const list = map.get(bucket);
    if (list && list.length > 0) out.push({ bucket, rows: list });
  }
  return out;
}

/**
 * A reading or games row.
 *
 * Deliberately plainer than `renderUpcomingRow`: no poster observer, no season
 * affordances, no request button — none of which mean anything for a book. What
 * it keeps is the shape (name, label, date, countdown) so the list reads as one
 * list, and the library's own noun so it is obvious which is which.
 */
export function renderUnifiedRow(
  parent: HTMLElement,
  row: UnifiedRow,
  deps: TabDeps,
): HTMLElement {
  const el = parent.createDiv({ cls: `wl-upcoming-row is-${row.source}` });

  const coverUrl =
    row.entry.source === "reading"
      ? row.entry.value.coverUrl
      : row.entry.source === "games"
        ? row.entry.value.game.coverUrl
        : "";
  if (coverUrl) {
    const img = el.createEl("img", { cls: "wl-thumb wl-thumb-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.src = coverUrl;
  } else {
    const cover = el.createDiv({ cls: "wl-thumb is-placeholder" });
    cover.createSpan({ cls: "wl-thumb-initial", text: (row.name[0] ?? "?").toUpperCase() });
  }

  const body = el.createDiv({ cls: "wl-upcoming-body" });
  const titleRow = body.createDiv({ cls: "wl-upcoming-titlerow" });
  titleRow.createSpan({ cls: "wl-upcoming-name", text: row.name });
  titleRow.createSpan({ cls: "wl-upcoming-label", text: row.label });
  body.createDiv({ cls: "wl-upcoming-detail", text: row.detail ?? "" });

  const meta = body.createDiv({ cls: "wl-upcoming-meta" });
  const dateText = formatDate(row.date, deps.store.settings.dateFormat);
  if (dateText) meta.createSpan({ cls: "wl-upcoming-date", text: dateText });
  meta.createSpan({
    cls: `wl-countdown is-${bucketFor({ daysUntil: row.daysUntil } as UpcomingEntry)}`,
    text: formatCountdown(row.daysUntil),
  });
  // Which library this came from, in that library's own words.
  meta.createSpan({ cls: "wl-upcoming-source", text: row.noun.next });

  if (deps.onOpenDomainEntry) {
    el.addClass("is-clickable");
    el.setAttr("role", "button");
    el.tabIndex = 0;
    const open = (): void => deps.onOpenDomainEntry?.(row.source === "games" ? "games" : "reading", row.id);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      open();
    });
  }

  return el;
}
