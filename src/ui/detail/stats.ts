/**
 * The numbers a title is really about, as stat tiles.
 *
 * **No maths and no CSS is invented here.** Every figure comes from
 * `data/episodes.ts`, the single source of truth for progress and every time
 * statistic in the plugin — the same functions the Dashboard's "Time watched" /
 * "Time remaining" and every progress bar already read. And the tiles are the
 * Dashboard's own `.wl-stat-grid` / `.wl-stat` component (`50-dashboard.css`),
 * which the detail surfaces had simply never used: until now they said the same
 * things in one line of muted grey text.
 *
 * **A number we do not have is a tile we do not draw.** `calcTimeRemaining`
 * answers "0 minutes" for a title with no `episodeDuration`, which is true of the
 * arithmetic and a lie on screen — "0m Left" reads as *finished*. An em dash
 * would be honest but still occupies a tile with nothing in it. So the tile is
 * omitted, and the row shows only what is known.
 */
import {
  calcTimeRemaining,
  calcTimeWatched,
  formatMinutes,
  getEffectiveTotal,
  getProgress,
  getWatchedCount,
} from "../../data/episodes";
import { STATUS_COMPLETED } from "../../constants";
import { mediaTypeOf } from "../../services/requests";
import type { TitleV4 } from "../../types";

export interface StatTile {
  /** The word underneath: `Left`, `Watched`, `Episodes`, `Progress`, `Runtime`. */
  label: string;
  value: string;
}

export function titleStatTiles(title: TitleV4): StatTile[] {
  const knownDuration = title.episodeDuration > 0;

  // A film is one sitting, so "12/25 episodes" and "48% progress" are questions
  // about it that have no interesting answer. It gets the two that do.
  if (mediaTypeOf(title) === "movie") {
    const tiles: StatTile[] = [];
    if (knownDuration) {
      tiles.push({ label: "Runtime", value: formatMinutes(title.episodeDuration) });
    }
    const watched = title.status === STATUS_COMPLETED || title.watchedEpisodes.length > 0;
    tiles.push({ label: "Watched", value: watched ? "Yes" : "No" });
    return tiles;
  }

  const tiles: StatTile[] = [];
  if (knownDuration) {
    tiles.push({ label: "Left", value: formatMinutes(calcTimeRemaining(title)) });
    tiles.push({ label: "Watched", value: formatMinutes(calcTimeWatched(title)) });
  }

  const total = getEffectiveTotal(title);
  // `1` is what a show whose seasons were never filled in looks like, and
  // "0/1 Episodes" is a guess dressed as a count.
  if (total > 1) {
    tiles.push({ label: "Episodes", value: `${getWatchedCount(title)}/${total}` });
  }
  if (total > 0) {
    tiles.push({ label: "Progress", value: `${getProgress(title)}%` });
  }
  return tiles;
}

/**
 * The tile row, in the Dashboard's own component.
 *
 * Returns `null` when there is nothing to say — an empty grid is worse than no
 * grid, and a title with neither a duration nor an episode count really does
 * have nothing to put in one.
 */
export function renderStatTiles(host: HTMLElement, title: TitleV4): HTMLElement | null {
  const tiles = titleStatTiles(title);
  if (tiles.length === 0) return null;
  // `wl-stat-tiles` is the detail surfaces' variant of the Dashboard's row. The
  // tile — `.wl-stat` and its value/label — is shared unchanged; only the
  // *container* differs, because the Dashboard's is built for a flex row that
  // wants its columns to fill a panel, and both detail surfaces are flex
  // columns that want the tiles to be their own size. See `95-detailview.css`.
  const row = host.createDiv({ cls: "wl-stat-grid wl-stat-tiles" });
  for (const tile of tiles) {
    const box = row.createDiv({ cls: "wl-stat" });
    box.createDiv({ cls: "wl-stat-value", text: tile.value });
    box.createDiv({ cls: "wl-stat-label", text: tile.label });
  }
  return row;
}
