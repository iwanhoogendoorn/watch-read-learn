/**
 * A hand-rolled virtualised grid — no library, same approach as foodspot
 * (`report-foodspot.md` §4 "Virtualization").
 *
 * Why bother for a media library: a poster grid at 140 px columns puts ~60 cards
 * on screen but a 500-title library would otherwise mount 500 `<img>` elements
 * and 500 observer registrations. Only the visible window plus two overscan rows
 * exist in the DOM at any moment.
 *
 * Three details that make it behave:
 *   - every layout pass is coalesced into **one** `requestAnimationFrame`;
 *   - a `ResizeObserver` only forces a full rebuild when the column count or the
 *     width actually changed, not on every resize tick;
 *   - `onUnmount` fires per evicted cell, which is where poster observers are
 *     released — the leak this whole file exists to prevent.
 *
 * `computeColumns` and `visibleRowRange` are pure and tested directly.
 */

/** How many columns fit, honouring the minimum cell width. Never below 1. */
export function computeColumns(width: number, minCellWidth: number, gap: number): number {
  if (!(width > 0) || !(minCellWidth > 0)) return 1;
  const columns = Math.floor((width + gap) / (minCellWidth + gap));
  return Math.max(1, columns);
}

export interface RowRange {
  first: number;
  /** Exclusive. */
  last: number;
}

/** The rows to keep mounted, expanded by `overscan` rows on each side. */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 2,
): RowRange {
  if (rowCount <= 0 || rowHeight <= 0) return { first: 0, last: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;
  const last = Math.min(rowCount, first + visibleRows);
  return { first, last };
}

/** Nearest ancestor that actually scrolls; `null` means "the page does". */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const overflow = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY ?? "";
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export interface VirtualGridOptions<T> {
  /** Minimum column width in px; the card-size setting feeds this. */
  minCellWidth: number;
  gap: number;
  /** Cell height for a given cell width — posters are 2:3 plus a text block. */
  cellHeight: (cellWidth: number) => number;
  renderCell: (item: T, cell: HTMLElement, index: number) => void;
  /** Release per-cell resources (poster observers) when a cell is evicted. */
  onUnmount?: (cell: HTMLElement) => void;
  overscanRows?: number;
  /** Explicit scroll container; auto-detected when omitted. */
  scrollParent?: HTMLElement | null;
}

export interface VirtualGridHandle<T> {
  el: HTMLElement;
  setItems(items: readonly T[]): void;
  /** Re-render the mounted window in place (data changed, same list length). */
  refresh(): void;
  destroy(): void;
}

export function createVirtualGrid<T>(
  parent: HTMLElement,
  options: VirtualGridOptions<T>,
): VirtualGridHandle<T> {
  const el = parent.createDiv({ cls: "wl-vgrid" });
  const mounted = new Map<number, HTMLElement>();

  let items: readonly T[] = [];
  let columns = 1;
  let cellWidth = options.minCellWidth;
  let cellHeight = 0;
  let rowHeight = 0;
  let lastWidth = -1;
  let frame: number | null = null;
  /**
   * Layout passes that found a zero-width host.
   *
   * A pane that is still being laid out (a fresh Obsidian leaf, a tab switch)
   * reports `clientWidth === 0`, and a grid that gives up there stays empty
   * until something else happens to resize it. `ResizeObserver` normally
   * delivers that "something", but it is absent on older webviews and does not
   * fire at all when the host never changes box size — so the first real
   * measurement is retried explicitly for a few frames. Bounded, because a grid
   * inside a `display: none` panel is legitimately 0 wide forever.
   */
  let measureRetries = 0;
  const MAX_MEASURE_RETRIES = 60;

  const scrollParent = options.scrollParent ?? findScrollParent(el);
  const scroller: EventTarget = scrollParent ?? window;

  function unmountAll(): void {
    for (const cell of mounted.values()) {
      options.onUnmount?.(cell);
      cell.remove();
    }
    mounted.clear();
  }

  /** True once the host has a real width; `false` means "nothing to lay out yet". */
  function measured(): boolean {
    return lastWidth > 0;
  }

  function measure(): boolean {
    const width = el.clientWidth;
    if (width <= 0) return false;
    const nextColumns = computeColumns(width, options.minCellWidth, options.gap);
    const changed = nextColumns !== columns || width !== lastWidth;
    columns = nextColumns;
    lastWidth = width;
    cellWidth = (width - options.gap * (columns - 1)) / columns;
    cellHeight = options.cellHeight(cellWidth);
    rowHeight = cellHeight + options.gap;
    return changed;
  }

  /** Scroll offset of the grid's own top edge inside the scrolling viewport. */
  function windowMetrics(): { scrollTop: number; viewportHeight: number } {
    if (scrollParent) {
      const top = el.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
      return {
        scrollTop: Math.max(0, -top),
        viewportHeight: scrollParent.clientHeight,
      };
    }
    const top = el.getBoundingClientRect().top;
    return { scrollTop: Math.max(0, -top), viewportHeight: window.innerHeight };
  }

  function layout(): void {
    frame = null;
    const geometryChanged = measure();
    if (!measured()) {
      // Nothing has a usable width yet. Keep asking for a few frames rather
      // than mounting cells against a rowHeight of 0 — that is what collapsed
      // the whole grid to the height of its scrim.
      if (items.length > 0 && measureRetries < MAX_MEASURE_RETRIES) {
        measureRetries += 1;
        schedule();
      }
      return;
    }
    measureRetries = 0;
    if (geometryChanged) unmountAll();

    const rowCount = Math.ceil(items.length / columns);
    el.style.height = `${Math.max(0, rowCount * rowHeight - options.gap)}px`;

    if (items.length === 0) {
      unmountAll();
      return;
    }

    const { scrollTop, viewportHeight } = windowMetrics();
    const { first, last } = visibleRowRange(
      scrollTop,
      viewportHeight,
      rowHeight,
      rowCount,
      options.overscanRows ?? 2,
    );

    const wanted = new Set<number>();
    for (let row = first; row < last; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        if (index >= items.length) break;
        wanted.add(index);
      }
    }

    for (const [index, cell] of mounted) {
      if (!wanted.has(index)) {
        options.onUnmount?.(cell);
        cell.remove();
        mounted.delete(index);
      }
    }

    for (const index of wanted) {
      if (mounted.has(index)) continue;
      const item = items[index];
      if (item === undefined) continue;
      const row = Math.floor(index / columns);
      const col = index % columns;
      const cell = el.createDiv({ cls: "wl-vgrid-cell" });
      cell.style.width = `${cellWidth}px`;
      // The height matters as much as the width: an absolutely positioned cell
      // whose only children are themselves absolutely positioned (the card's
      // poster, scrim and body all are) has **no** content height, so a card
      // asking for `height: 100%` resolved against auto and collapsed to a few
      // pixels. The row geometry already knows the answer — apply it.
      cell.style.height = `${cellHeight}px`;
      cell.style.transform = `translate(${col * (cellWidth + options.gap)}px, ${row * rowHeight}px)`;
      options.renderCell(item, cell, index);
      mounted.set(index, cell);
    }
  }

  /** Every trigger funnels here, so a scroll storm still costs one layout. */
  function schedule(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(layout);
  }

  const onScroll = (): void => schedule();
  scroller.addEventListener("scroll", onScroll, { passive: true });

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => schedule());
    resizeObserver.observe(el);
  }

  return {
    el,
    setItems(next: readonly T[]): void {
      items = next;
      measureRetries = 0;
      unmountAll();
      schedule();
    },
    refresh(): void {
      unmountAll();
      schedule();
    },
    destroy(): void {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      scroller.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      resizeObserver = null;
      unmountAll();
      el.remove();
    },
  };
}
