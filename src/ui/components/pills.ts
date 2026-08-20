/**
 * The small chrome shared by cards, rows, the detail modal and (later) widgets:
 * type/status pills, the Plex badge, the airing chip, the progress bar.
 *
 * Colour discipline (SPEC §6, binding): a pill never hardcodes a colour. The
 * user's configured hex lands on the element as `--wl-pill`, and the stylesheet
 * only ever reads `var(--wl-pill, <obsidian fallback>)`. That is the whole reason
 * dark mode needs no work.
 *
 * The formatters are pure and exported; only the `render*` helpers touch the DOM.
 */
import { setIcon } from "obsidian";
import {
  episodesRemaining,
  expectedEpisodes,
  getEffectiveTotal,
  getNextUnwatchedEpisode,
  getProgress,
  getWatchedCount,
  toSeasonEpisode,
} from "../../data/episodes";
import { STATUS_COMPLETED } from "../../constants";
import type { NamedColor, TitleV4 } from "../../types";
import { dayNumberOf, plexStateOf } from "./facets";

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

/** The configured colour for a named value, or `""` when the user removed it. */
export function colorFor(list: readonly NamedColor[], name: string): string {
  return list.find((entry) => entry.name === name)?.color ?? "";
}

/**
 * A hex colour the DOM may receive. Anything else is dropped rather than written
 * — settings are user data, and `--wl-pill` ends up in a style attribute.
 */
export function sanitizeColor(value: string): string {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value.trim())
    ? value.trim()
    : "";
}

export interface PlexBadge {
  state: "available" | "partial";
  text: string;
}

/**
 * What the corner badge says: `On Plex`, `12/33 eps`, or nothing at all.
 *
 * "Not on Plex" and "unchecked" deliberately render no badge — an absence of a
 * badge is quieter and more honest than a negative one on every card.
 */
export function plexBadge(title: TitleV4): PlexBadge | null {
  const state = plexStateOf(title);
  if (state === "available") return { state: "available", text: "On Plex" };
  if (state !== "partial") return null;
  const have = title.plex?.leafCount ?? title.plex?.episodes?.length ?? 0;
  // The same denominator availability judged the state against — the tracker's
  // own `totalEpisodes` can be a season behind, which is how a partial badge
  // ended up reading `34/33 eps`.
  const total = expectedEpisodes(title);
  return { state: "partial", text: total > 0 ? `${have}/${total} eps` : `${have} eps` };
}

/** `today` / `tomorrow` / `in 3 days` / `3 days ago` / `""` when unparseable. */
export function formatCountdown(date: string, now: Date = new Date()): string {
  const target = dayNumberOf(date);
  if (target === null) return "";
  const days = daysBetween(now, date);
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}

/** Whole days from `now` to `YYYY-MM-DD`, both taken at local midnight. */
export function daysBetween(now: Date, date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  if (!y || !m || !d) return null;
  const target = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** `S03E08 · in 2 days`, or the movie's release countdown. `null` when nothing airs. */
export function airingChipText(title: TitleV4, now: Date = new Date()): string | null {
  const next = title.airing?.nextEpisode;
  if (next?.airDate) {
    const when = formatCountdown(next.airDate, now);
    const code = episodeCode(next.season, next.episode);
    return when ? `${code} · ${when}` : code;
  }
  if (title.releaseDate) {
    const days = daysBetween(now, title.releaseDate);
    if (days !== null && days >= 0) return `Releases ${formatCountdown(title.releaseDate, now)}`;
  }
  return null;
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** `12 / 33` for shows; `""` for a one-episode movie, where it says nothing. */
export function progressText(title: TitleV4): string {
  const total = getEffectiveTotal(title);
  if (total <= 1) return "";
  return `${getWatchedCount(title)} / ${total}`;
}

/**
 * "This show you finished has more to watch" (QA3 fix 3).
 *
 * Seasons now arrive on their own, and a season arriving must NOT rewrite the
 * user's status — flipping a Completed show back to Watching behind their back
 * is exactly the kind of silent edit this plugin does not make. So the card says
 * it instead, and the decision stays theirs.
 *
 * Deliberately narrow: a show is only "new season" when the user had finished it
 * and it now has unwatched episodes. A show they are part-way through has
 * unwatched episodes by definition, and badging that would be noise.
 */
export function hasUnwatchedNewSeason(title: TitleV4): boolean {
  if (title.status !== STATUS_COMPLETED) return false;
  // A single-episode title cannot grow a season, and "remaining > 0" alone
  // could not tell that apart from the common completed-by-status film whose
  // one episode was never ticked in the grid — which put a "New season" chip
  // on a movie. Seasons are a thing only a multi-episode title has.
  if (getEffectiveTotal(title) <= 1) return false;
  return episodesRemaining(title) > 0;
}

/**
 * `S02E01 next` — where you are in a show that has more than one season.
 *
 * The season number is the season's own, never its array index: a tracker that
 * holds only seasons 2–3 must not announce "S01E01".
 */
export function nextUpText(title: TitleV4): string {
  if (getEffectiveTotal(title) <= 1 || title.seasons.length <= 1) return "";
  const next = getNextUnwatchedEpisode(title);
  if (next === null) return "";
  const pair = toSeasonEpisode(title, next);
  if (!pair) return `E${next} next`;
  return `${episodeCode(pair.season.seasonNumber ?? pair.seasonIndex + 1, pair.episode)} next`;
}

/** `4 eps left`, `1 ep left`, or `""` when nothing is left. */
export function episodesLeftText(title: TitleV4): string {
  const left = episodesRemaining(title);
  if (left <= 0) return "";
  return `${left} ep${left === 1 ? "" : "s"} left`;
}

export interface RequestStatus {
  text: string;
  tone: "ok" | "pending" | "warn";
}

/**
 * The request pill's progression: Requested → Approved → Processing → Partly
 * available → Available.
 *
 * `MediaRequestStatus` (the request row) and `MediaStatus` (the media itself) are
 * two different enums with overlapping numbers; mixing them up is the classic
 * Overseerr integration bug, so both are read explicitly here and nowhere else.
 */
export function requestStatus(title: TitleV4): RequestStatus | null {
  const request = title.request;
  if (!request || request.id === undefined) return null;
  const media = request.mediaStatus ?? 0;
  const state = request.status ?? 0;

  if (media === 5) return { text: "Available", tone: "ok" };
  if (media === 4) return { text: "Partly available", tone: "ok" };
  if (state === 3) return { text: "Declined", tone: "warn" };
  if (state === 4) return { text: "Failed", tone: "warn" };
  if (media === 3) return { text: "Processing", tone: "pending" };
  if (state === 2 || state === 5) return { text: "Approved", tone: "pending" };
  return { text: "Requested", tone: "pending" };
}

/** today / yesterday / N d ago / N w ago / N mo ago / N y ago. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} d ago`;
  if (days < 30) return `${Math.floor(days / 7)} w ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface PillOptions {
  text: string;
  /** User-configured hex; anything non-hex is ignored and the theme takes over. */
  color?: string;
  cls?: string;
  icon?: string;
  title?: string;
}

export function renderPill(parent: HTMLElement, options: PillOptions): HTMLElement {
  const pill = parent.createSpan({ cls: `wl-pill ${options.cls ?? ""}`.trim() });
  const color = sanitizeColor(options.color ?? "");
  if (color) pill.style.setProperty("--wl-pill", color);
  if (options.icon) {
    const icon = pill.createSpan({ cls: "wl-pill-icon" });
    setIcon(icon, options.icon);
  }
  pill.createSpan({ cls: "wl-pill-text", text: options.text });
  if (options.title) pill.setAttribute("title", options.title);
  return pill;
}

export function renderPlexBadge(parent: HTMLElement, title: TitleV4): HTMLElement | null {
  const badge = plexBadge(title);
  if (!badge) return null;
  const el = parent.createSpan({ cls: `wl-plex-badge is-${badge.state}` });
  const icon = el.createSpan({ cls: "wl-plex-badge-icon" });
  setIcon(icon, badge.state === "available" ? "check-circle-2" : "circle-dashed");
  el.createSpan({ cls: "wl-plex-badge-text", text: badge.text });
  el.setAttribute(
    "title",
    badge.state === "available" ? "Available on Plex" : "Partly available on Plex",
  );
  return el;
}

export function renderAiringChip(
  parent: HTMLElement,
  title: TitleV4,
  now: Date = new Date(),
): HTMLElement | null {
  const text = airingChipText(title, now);
  if (!text) return null;
  const chip = parent.createSpan({ cls: "wl-airing-chip" });
  const icon = chip.createSpan({ cls: "wl-airing-chip-icon" });
  setIcon(icon, "calendar-clock");
  chip.createSpan({ cls: "wl-airing-chip-text", text });
  return chip;
}

/**
 * The two multi-season chips: "New season" for a finished show with more to
 * watch, and "S02E01 next" for where you are in one you have not finished.
 * Never both — they answer the same question.
 */
export function renderSeasonChips(parent: HTMLElement, title: TitleV4): boolean {
  if (hasUnwatchedNewSeason(title)) {
    const chip = parent.createSpan({ cls: "wl-airing-chip is-new-season" });
    setIcon(chip.createSpan({ cls: "wl-airing-chip-icon" }), "sparkles");
    chip.createSpan({ cls: "wl-airing-chip-text", text: "New season" });
    chip.setAttribute("title", `${episodesRemaining(title)} unwatched episode(s) since you finished it`);
    return true;
  }
  const next = nextUpText(title);
  if (next === "") return false;
  const chip = parent.createSpan({ cls: "wl-airing-chip is-next-up" });
  setIcon(chip.createSpan({ cls: "wl-airing-chip-icon" }), "play");
  chip.createSpan({ cls: "wl-airing-chip-text", text: next });
  return true;
}

export function renderProgressBar(parent: HTMLElement, title: TitleV4): HTMLElement | null {
  const total = getEffectiveTotal(title);
  if (total <= 1) return null;
  const percent = getProgress(title);
  const bar = parent.createDiv({ cls: "wl-progress" });
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent));
  bar.setAttribute("aria-label", `${progressText(title)} episodes watched`);
  const fill = bar.createDiv({ cls: "wl-progress-fill" });
  fill.style.width = `${percent}%`;
  return bar;
}

/** Up to `max` chips plus a `+N` overflow chip. Each chip can jump to a query. */
export function renderChipRow(
  parent: HTMLElement,
  values: readonly string[],
  options: { max?: number; cls?: string; onClick?: (value: string) => void } = {},
): HTMLElement | null {
  const list = values.filter((v) => v.trim() !== "");
  if (list.length === 0) return null;
  const max = options.max ?? list.length;
  const row = parent.createDiv({ cls: `wl-chips ${options.cls ?? ""}`.trim() });
  for (const value of list.slice(0, max)) {
    const chip = row.createSpan({ cls: "wl-chip", text: value });
    if (options.onClick) {
      chip.addClass("is-clickable");
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      const fire = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        options.onClick?.(value);
      };
      chip.addEventListener("click", fire);
      chip.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") fire(event);
      });
    }
  }
  if (list.length > max) {
    row.createSpan({ cls: "wl-chip is-overflow", text: `+${list.length - max}` });
  }
  return row;
}
