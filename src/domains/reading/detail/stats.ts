/**
 * The numbers a book is really about, as stat tiles.
 *
 * The same component and the same rule as `ui/detail/stats.ts`, deliberately:
 * the Dashboard's `.wl-stat-grid` / `.wl-stat` in the detail surfaces' own
 * `wl-stat-tiles` variant (`95-detailview.css`), and
 *
 *   **a number we do not have is a tile we do not draw.**
 *
 * A book with no page count is not "0 % read" and not "0 pages left" — it is
 * unmeasured, and `readingProgress` returns 0 for it, which is true of the
 * arithmetic and reads on screen as *not started*. So the tile is omitted and
 * the row shows only what is known; when nothing is known there is no row.
 *
 * **No arithmetic is invented here.** Every figure comes from `progress.ts`, the
 * reading domain's one source of truth for counters and percentages — the same
 * functions the table's bars, the Dashboard's cards and the widget DSL already
 * read. This module only decides which of them are worth a tile.
 */
import type { StatTile } from "../../../ui/detail/stats";
import {
  formatCount,
  isBook,
  primaryCounter,
  readingProgress,
  volumeCounter,
  type ReadingEntry,
} from "../progress";

/** `pages` → `Pages read`. The unit is part of the label, so a figure is never bare. */
function unitLabel(unit: string, suffix: string): string {
  return `${unit.charAt(0).toUpperCase()}${unit.slice(1)} ${suffix}`;
}

export function readingStatTiles(entry: ReadingEntry): StatTile[] {
  const counter = primaryCounter(entry);
  const tiles: StatTile[] = [];

  if (counter.read > 0 || counter.total > 0) {
    tiles.push({ label: unitLabel(counter.unit, "read"), value: formatCount(counter.read) });
  }
  if (counter.total > 0) {
    tiles.push({
      label: unitLabel(counter.unit, "left"),
      value: formatCount(Math.max(0, counter.total - counter.read)),
    });
  }

  // Manga's second axis. A shelf tracks volumes, a reader tracks chapters, and
  // an entry that only has one of the two still deserves the one it has.
  if (!isBook(entry)) {
    const volumes = volumeCounter(entry);
    if (volumes.total > 0) {
      tiles.push({ label: "Volumes", value: `${formatCount(volumes.read)}/${formatCount(volumes.total)}` });
    }
  }

  // `readingProgress` already falls back to volumes for a manga with no chapter
  // count, so the guard is "is there anything to be a fraction of", not "is
  // there a chapter total".
  const measurable = counter.total > 0 || (!isBook(entry) && volumeCounter(entry).total > 0);
  if (measurable) tiles.push({ label: "Progress", value: `${readingProgress(entry)}%` });

  return tiles;
}

/**
 * The tile row, in the detail surfaces' shared component.
 *
 * Returns `null` when there is nothing to say — an empty grid is worse than no
 * grid, and a book with neither a page count nor a page read really does have
 * nothing to put in one.
 */
export function renderReadingStatTiles(
  host: HTMLElement,
  entry: ReadingEntry,
): HTMLElement | null {
  const tiles = readingStatTiles(entry);
  if (tiles.length === 0) return null;
  const row = host.createDiv({ cls: "wl-stat-grid wl-stat-tiles" });
  for (const tile of tiles) {
    const box = row.createDiv({ cls: "wl-stat" });
    box.createDiv({ cls: "wl-stat-value", text: tile.value });
    box.createDiv({ cls: "wl-stat-label", text: tile.label });
  }
  return row;
}
