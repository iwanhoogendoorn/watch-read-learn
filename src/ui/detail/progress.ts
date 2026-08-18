/**
 * The per-season accordion and its episode grid — one implementation, shared.
 *
 * The modal and the workspace view differ only in the words on the bulk button
 * and in what sits above the blocks; the grid itself, the skip menu, the Plex
 * dots and the collapse state are identical, so they are written once.
 *
 * Nothing here writes directly: every episode toggle goes through the store's
 * own `markEpisodeWatched`/`markSeasonWatched`, and the skip edit is handed back
 * to the surface, which owns the repaint.
 */
import { Menu, Notice, setIcon } from "obsidian";
import { episodeAirState } from "../../data/aired";
import { seasonEpisodes, seasonRange, isEpisodeSkipped } from "../../data/episodes";
import { mediaTypeOf } from "../../services/requests";
import type { Season, TitlePatch, TitleV4, WatchLogStoreApi } from "../../types";
import { episodeCode } from "../components/pills";

/**
 * What the Progress section of a detail surface offers.
 *
 *   - `movie-toggle`  one "Mark as watched" button — **films only**;
 *   - `season-grid`   the per-episode grid, for any show that has seasons;
 *   - `needs-seasons` a show whose seasons are not filled in yet: a nudge to the
 *                     season editor, and deliberately *no* watched toggle.
 *
 * Exported and pure because this is the decision QA1 B2 got wrong: it was keyed
 * off `totalEpisodes <= 1`, which is also what an un-filled show looks like.
 */
export type ProgressAffordance = "movie-toggle" | "season-grid" | "needs-seasons";

export function progressAffordance(title: TitleV4): ProgressAffordance {
  if (title.seasons.length > 0) return "season-grid";
  return mediaTypeOf(title) === "movie" ? "movie-toggle" : "needs-seasons";
}

/** `"2x5"` keys for every episode Plex says it has on disk. */
export function plexEpisodeKeys(title: TitleV4): Set<string> {
  return new Set((title.plex?.episodes ?? []).map((entry) => `${entry.s}x${entry.e}`));
}

/**
 * The film's single watched toggle.
 *
 * `onWrote` is not optional in spirit, only in the signature: episode writes go
 * through the store's own methods rather than `surface.patch`, so the surface
 * would otherwise be repainted only by the `watchlog-data-changed` bus — and
 * that bus only reaches a surface whose document is the store's document. It is
 * not, in a popout window; it is not, in a harness. That assumption is precisely
 * why the rating looked frozen for three releases, so the repaint is explicit.
 */
export function renderSingleToggle(
  host: HTMLElement,
  title: TitleV4,
  store: WatchLogStoreApi,
  onWrote?: () => void,
): HTMLElement {
  const watched = title.watchedEpisodes.includes(1);
  const button = host.createEl("button", {
    cls: `wl-ep ${watched ? "is-watched" : ""}`.trim(),
    attr: { type: "button", "aria-pressed": String(watched) },
    text: watched ? "Watched" : "Mark as watched",
  });
  button.addEventListener("click", () => {
    store.markEpisodeWatched(title.id, 1, !watched);
    onWrote?.();
  });
  return button;
}

export interface SeasonBlockOptions {
  title: TitleV4;
  store: WatchLogStoreApi;
  season: Season;
  index: number;
  collapsed: boolean;
  plexEpisodes: ReadonlySet<string>;
  /**
   * Bulk button copy. The modal says "Watch all"/"Unwatch all" in a dense head;
   * the view has room for "Mark season watched"/"Unmark season".
   */
  bulkLabels?: { mark: string; unmark: string };
  onToggleCollapse: () => void;
  /** `(seasonIndex, seasonRelativeEpisode)`; the surface writes and repaints. */
  onToggleSkipped: (seasonIndex: number, relative: number) => void;
  /** Repaint after an episode or season write — see `renderSingleToggle`. */
  onWrote?: () => void;
  /**
   * Mark an explicit set of absolute episodes, as one write.
   *
   * Only used when a season is **part-aired**, where `markSeasonWatched` would
   * over-mark. Looping `markEpisodeWatched` would be correct and would also put
   * one activity-log line on screen per episode, so the surface applies a single
   * `watchedEpisodes` patch instead — see `markEpisodesPatch`.
   */
  onMarkEpisodes?: (episodes: number[], watched: boolean) => void;
  /** Injectable clock, so the air-date guard is testable. */
  now?: Date;
}

/**
 * The patch that ticks or unticks an explicit set of absolute episodes.
 *
 * Goes through `updateTitle`, which re-sanitises the list and re-applies the
 * auto-complete rules — the same guarantees `markSeasonWatched` gives.
 */
export function markEpisodesPatch(
  title: TitleV4,
  episodes: readonly number[],
  watched: boolean,
): TitlePatch {
  const set = new Set(title.watchedEpisodes);
  for (const episode of episodes) {
    if (watched) set.add(episode);
    else set.delete(episode);
  }
  return { watchedEpisodes: [...set].sort((a, b) => a - b) };
}

export function renderSeasonBlock(host: HTMLElement, options: SeasonBlockOptions): HTMLElement {
  const { title, store, season, index, collapsed, plexEpisodes } = options;
  const labels = options.bulkLabels ?? { mark: "Watch all", unmark: "Unwatch all" };

  const block = host.createDiv({ cls: "wl-season" });
  const head = block.createDiv({ cls: "wl-season-head" });

  const toggle = head.createEl("button", {
    cls: "wl-icon-btn wl-season-collapse",
    attr: { type: "button", "aria-label": `Collapse ${season.name}` },
  });
  setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
  toggle.addEventListener("click", () => options.onToggleCollapse());

  head.createSpan({ cls: "wl-season-name", text: season.name });

  const seasonNumber = season.seasonNumber ?? index + 1;
  const now = options.now ?? new Date();
  const episodes = seasonEpisodes(title, index);
  const watchedHere = episodes.filter((ep) => title.watchedEpisodes.includes(ep)).length;
  // The ceiling for a bulk mark is what has actually **aired**, not the season's
  // eventual episode count — otherwise a season halfway through its run can be
  // marked 100% watched, which is a false statement the progress maths then
  // believes. `unknown` counts as aired, so a title with no upstream schedule
  // behaves exactly as it did before.
  const aired = episodes.filter(
    (ep) => episodeAirState(title, seasonNumber, ep - season.offset, now) !== "unaired",
  );
  head.createSpan({
    cls: "wl-season-count",
    text: episodes.length > 0 ? `${watchedHere}/${episodes.length}` : "—",
  });

  if (aired.length > 0) {
    const allWatched = aired.every((ep) => title.watchedEpisodes.includes(ep));
    const bulk = head.createEl("button", {
      cls: "wl-link-btn",
      text: allWatched ? labels.unmark : labels.mark,
      attr: { type: "button" },
    });
    bulk.addEventListener("click", () => {
      if (aired.length === episodes.length) {
        // Fully aired: the store's own path, which logs the season by name.
        store.markSeasonWatched(title.id, index, !allWatched);
      } else {
        options.onMarkEpisodes?.(aired, !allWatched);
      }
      options.onWrote?.();
    });
    if (aired.length < episodes.length) {
      head.createSpan({
        cls: "wl-season-aired",
        text: `${aired.length} aired`,
      });
    }
  } else if (episodes.length > 0) {
    // Nothing in it has happened yet, so there is nothing to mark and a button
    // saying otherwise would only be a trap.
    head.createSpan({ cls: "wl-season-aired", text: "Not aired yet" });
  }

  if (collapsed) return block;

  const grid = block.createDiv({ cls: "wl-ep-grid" });
  const { first, last } = seasonRange(season);

  for (let absolute = first; absolute <= Math.min(last, title.totalEpisodes); absolute += 1) {
    const relative = absolute - season.offset;
    const skipped = isEpisodeSkipped(title, absolute);
    const watched = title.watchedEpisodes.includes(absolute);
    const onPlex = plexEpisodes.has(`${seasonNumber}x${relative}`);
    const unaired = episodeAirState(title, seasonNumber, relative, now) === "unaired";

    const code = episodeCode(seasonNumber, relative);
    const cell = grid.createEl("button", {
      cls: "wl-ep",
      attr: {
        type: "button",
        "aria-pressed": String(watched),
        "aria-label": `${code}${skipped ? " (skipped)" : ""}${unaired ? " (not aired yet)" : ""}`,
        title: unaired
          ? `${code} — has not aired yet.`
          : skipped
            ? `${code} — skipped. Right-click to unskip.`
            : `${code}${onPlex ? " — on Plex" : ""}. Right-click to skip.`,
      },
    });
    cell.toggleClass("is-watched", watched);
    cell.toggleClass("is-skipped", skipped);
    // Dimmed and inert, **not** `disabled`: three soft signals (faded, no hover
    // affordance, a sentence if you click anyway) read as "not yet", where a
    // greyed-out disabled control reads as "broken". The right-click skip menu
    // still works, because deciding in advance to skip an episode is a perfectly
    // reasonable thing to do before it airs.
    cell.toggleClass("is-unaired", unaired);
    if (unaired) cell.setAttribute("aria-disabled", "true");
    cell.createSpan({ cls: "wl-ep-num", text: String(relative) });
    if (onPlex) cell.createSpan({ cls: "wl-ep-plex" });

    cell.addEventListener("click", () => {
      if (unaired) {
        // The whole point of the guard: the tracker will not record that you
        // watched something that has not happened.
        new Notice(`${code} has not aired yet.`);
        return;
      }
      if (skipped) {
        new Notice("That episode is skipped — right-click it to unskip first.");
        return;
      }
      store.markEpisodeWatched(title.id, absolute, !watched);
      options.onWrote?.();
    });

    cell.addEventListener("contextmenu", (event: MouseEvent) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle(skipped ? "Unskip this episode" : "Skip this episode")
          .setIcon(skipped ? "rotate-ccw" : "skip-forward")
          .onClick(() => options.onToggleSkipped(index, relative)),
      );
      menu.showAtMouseEvent(event);
    });
  }

  return block;
}

/**
 * The seasons a skip toggle produces.
 *
 * Skipping is a season-level edit: it changes the denominator, so the caller
 * hands the result to `updateTitle`, which re-sanitises `watchedEpisodes` and
 * drops the episode from the watched list if it was ticked.
 */
export function seasonsWithSkipToggled(
  title: TitleV4,
  seasonIndex: number,
  relative: number,
): Season[] {
  return title.seasons.map((season, index) => {
    if (index !== seasonIndex) return { ...season, skippedEpisodes: [...season.skippedEpisodes] };
    const set = new Set(season.skippedEpisodes);
    if (set.has(relative)) set.delete(relative);
    else set.add(relative);
    return { ...season, skippedEpisodes: [...set].sort((a, b) => a - b) };
  });
}
