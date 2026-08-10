/**
 * B1 — the collapsed Library grid.
 *
 * `createVirtualGrid` sized every cell's *width* from the measured column
 * geometry and left its height to the content. A full card's children (poster,
 * scrim, body) are all absolutely positioned, so the card has no content height
 * at all: `height: 100%` resolved against an auto-height parent and the whole
 * grid flattened into a strip of scrims. That is invisible to jsdom — it has no
 * layout engine, every `clientWidth` is 0 and every box is zero-sized — so the
 * regression is pinned here with a tiny DOM stub whose geometry we control,
 * asserting the two things the real browser cared about:
 *
 *   1. every mounted cell carries an explicit pixel height equal to
 *      `cellHeight(cellWidth)`;
 *   2. a first layout pass against a not-yet-laid-out (0 px wide) host mounts
 *      nothing and *retries*, rather than caching a row height of 0 forever.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVirtualGrid } from "../src/ui/components/virtual";

// ---------------------------------------------------------------------------
// The smallest DOM that `createVirtualGrid` can run against
// ---------------------------------------------------------------------------

interface StubStyle {
  width?: string;
  height?: string;
  transform?: string;
}

class StubElement {
  children: StubElement[] = [];
  parentElement: StubElement | null = null;
  style: StubStyle = {};
  cls: string;
  /** What `clientWidth` reports; the harness sets it like a layout engine would. */
  width = 0;
  height = 0;
  ownerDocument = { defaultView: null };

  constructor(cls = "") {
    this.cls = cls;
  }

  get clientWidth(): number {
    return this.width;
  }

  get clientHeight(): number {
    return this.height;
  }

  createDiv(options: { cls?: string } = {}): StubElement {
    const child = new StubElement(options.cls ?? "");
    child.parentElement = this;
    child.width = this.width;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  querySelector(): null {
    return null;
  }

  getBoundingClientRect(): { top: number } {
    return { top: 0 };
  }
}

/** rAF callbacks queued by the grid; `flush()` runs one frame's worth. */
const frames: (() => void)[] = [];

function flush(times = 1): void {
  for (let i = 0; i < times; i += 1) {
    const pending = frames.splice(0, frames.length);
    for (const fn of pending) fn();
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};

beforeEach(() => {
  saved = {
    requestAnimationFrame: globals["requestAnimationFrame"],
    cancelAnimationFrame: globals["cancelAnimationFrame"],
    window: globals["window"],
  };
  frames.length = 0;
  globals["requestAnimationFrame"] = (fn: () => void): number => {
    frames.push(fn);
    return frames.length;
  };
  globals["cancelAnimationFrame"] = (): void => {
    /* the harness drains explicitly */
  };
  globals["window"] = {
    innerHeight: 900,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function harness(hostWidth: number) {
  const host = new StubElement("host");
  host.width = hostWidth;
  const grid = createVirtualGrid<string>(host as unknown as HTMLElement, {
    minCellWidth: 160,
    gap: 12,
    cellHeight: (width) => Math.round(width * 1.5),
    renderCell: (item, cell) => {
      (cell as unknown as StubElement).createDiv({ cls: `card-${item}` });
    },
  });
  const el = host.children[0] as StubElement;
  // The grid's own element inherits the host width, the way a block-level child
  // of a laid-out pane does.
  el.width = hostWidth;
  return { host, grid, el };
}

// ---------------------------------------------------------------------------

describe("createVirtualGrid — cell box geometry (B1)", () => {
  it("gives every mounted cell an explicit pixel height, not just a width", () => {
    const { grid, el } = harness(1000);
    grid.setItems(["a", "b", "c", "d", "e"]);
    flush();

    const cells = el.children.filter((c) => c.cls === "wl-vgrid-cell");
    expect(cells.length).toBe(5);

    // 1000px, 12px gaps, 160px minimum → 5 columns of 190.4px.
    const expectedWidth = (1000 - 12 * 4) / 5;
    const expectedHeight = Math.round(expectedWidth * 1.5);
    for (const cell of cells) {
      expect(cell.style.width).toBe(`${expectedWidth}px`);
      expect(cell.style.height).toBe(`${expectedHeight}px`);
    }
  });

  it("keeps the cell height in step with the column width after a resize", () => {
    const { grid, el } = harness(1000);
    grid.setItems(["a", "b", "c"]);
    flush();

    el.width = 400; // pane dragged narrower: 2 columns of 194px
    grid.refresh();
    flush();

    const cells = el.children.filter((c) => c.cls === "wl-vgrid-cell");
    const expectedWidth = (400 - 12) / 2;
    expect(cells[0]?.style.width).toBe(`${expectedWidth}px`);
    expect(cells[0]?.style.height).toBe(`${Math.round(expectedWidth * 1.5)}px`);
  });

  it("mounts nothing while the host has no width, then lays out once it does", () => {
    const { grid, el } = harness(0);
    grid.setItems(["a", "b"]);
    flush();

    expect(el.children.filter((c) => c.cls === "wl-vgrid-cell").length).toBe(0);
    // The pass re-scheduled itself rather than settling on a row height of 0.
    expect(frames.length).toBe(1);

    el.width = 500; // the pane finished laying out
    flush();

    const cells = el.children.filter((c) => c.cls === "wl-vgrid-cell");
    expect(cells.length).toBe(2);
    const expectedWidth = (500 - 12) / 2;
    expect(cells[0]?.style.height).toBe(`${Math.round(expectedWidth * 1.5)}px`);
  });

  it("stops retrying eventually so a hidden panel cannot spin forever", () => {
    const { grid } = harness(0);
    grid.setItems(["a"]);
    flush(200);
    expect(frames.length).toBe(0);
  });

  it("sets the spacer height from the measured row geometry", () => {
    const { grid, el } = harness(1000);
    grid.setItems(["a", "b", "c", "d", "e", "f", "g"]); // 5 columns → 2 rows
    flush();

    const cellWidth = (1000 - 12 * 4) / 5;
    const rowHeight = Math.round(cellWidth * 1.5) + 12;
    expect(el.style.height).toBe(`${rowHeight * 2 - 12}px`);
  });
});
