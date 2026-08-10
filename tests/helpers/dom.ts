/**
 * A DOM small enough to hand-roll, complete enough to mount a tab into.
 *
 * Why not jsdom: it has **no layout engine**, so every `clientWidth` is 0 and
 * every box is zero-sized — it cannot show a geometry bug and cannot prove one
 * fixed (see `ui-virtual-dom.test.ts`). What it *would* buy is DOM breadth, and
 * that turns out to be cheap to write, because the surface these tabs touch is
 * mostly Obsidian's own `createDiv`/`createEl`/`addClass` extensions rather than
 * the standard API.
 *
 * So this is that surface, plus a controllable geometry, plus the two things the
 * checks need: a recursive `textContent` and a class-aware `querySelectorAll`.
 */

export interface StubStyle {
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  /** The star widget clears `--wl-rating` for an unrated entry. */
  removeProperty(name: string): void;
  [key: string]: unknown;
}

export class StubEl {
  tag: string;
  children: StubEl[] = [];
  parentElement: StubEl | null = null;
  classes = new Set<string>();
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((event: unknown) => void)[]>();
  ownText = "";
  tabIndex = 0;
  disabled = false;
  src = "";
  value = "";
  /** Set by the harness the way a layout engine would. */
  width = 0;
  height = 0;

  private props = new Map<string, string>();
  style: StubStyle;

  /**
   * A document, because real code reaches for one.
   *
   * `findScrollParent` walks `ownerDocument.defaultView.getComputedStyle`, and a
   * tab's `destroy` removes listeners from `ownerDocument` — both perfectly
   * ordinary, both undefined on a stub that only models elements. Without this
   * the virtual grid cannot be mounted headlessly at all.
   */
  ownerDocument: {
    defaultView: { getComputedStyle: (el: StubEl) => { overflowY: string } } | null;
    addEventListener: () => void;
    removeEventListener: () => void;
    createElement: (tag: string) => StubEl;
    body: StubEl | null;
  } = {
    defaultView: {
      // No layout engine, so nothing scrolls: `findScrollParent` walks to the
      // top and falls back to the window, which is what a mounted-but-unsized
      // pane does anyway.
      getComputedStyle: () => ({ overflowY: "visible" }),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tag: string) => new StubEl(tag),
    body: null,
  };

  constructor(tag = "div", cls = "") {
    this.tag = tag;
    for (const name of cls.split(" ").filter(Boolean)) this.classes.add(name);
    const props = this.props;
    this.style = new Proxy(
      {
        setProperty(name: string, value: string): void {
          props.set(name, value);
        },
        getPropertyValue(name: string): string {
          return props.get(name) ?? "";
        },
        removeProperty(name: string): void {
          props.delete(name);
        },
      } as StubStyle,
      {
        get(target, key: string) {
          if (key in target) return (target as Record<string, unknown>)[key];
          return props.get(key) ?? "";
        },
        set(_target, key: string, value: unknown) {
          props.set(key, String(value));
          return true;
        },
      },
    );
  }

  // --- Obsidian's DOM extensions -------------------------------------------

  createDiv(options: ElOptions = {}): StubEl {
    return this.createEl("div", options);
  }

  createSpan(options: ElOptions = {}): StubEl {
    return this.createEl("span", options);
  }

  createEl(tag: string, options: ElOptions = {}): StubEl {
    const child = new StubEl(tag, options.cls ?? "");
    if (options.text !== undefined) child.ownText = options.text;
    if (options.href !== undefined) child.attrs.set("href", options.href);
    if (options.value !== undefined) child.value = options.value;
    for (const [key, value] of Object.entries(options.attr ?? {})) {
      child.attrs.set(key, String(value));
    }
    child.parentElement = this;
    child.width = this.width;
    this.children.push(child);
    return child;
  }

  createSvg(tag: string, options: ElOptions = {}): StubEl {
    return this.createEl(tag, options);
  }

  addClass(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  removeClass(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggleClass(names: string | string[], on: boolean): void {
    for (const name of Array.isArray(names) ? names : [names]) {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
    }
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  setText(text: string): void {
    this.children = [];
    this.ownText = text;
  }

  setAttr(name: string, value: string | number | boolean): void {
    this.attrs.set(name, String(value));
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  empty(): void {
    this.children = [];
    this.ownText = "";
  }

  detach(): void {
    this.remove();
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  appendChild(child: StubEl): StubEl {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  // --- standard-ish API the tabs use ---------------------------------------

  get childElementCount(): number {
    return this.children.length;
  }

  get clientWidth(): number {
    return this.width;
  }

  get clientHeight(): number {
    return this.height;
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)]
      .filter((part) => part !== "")
      .join(" ");
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  /** The inline `style="…"` a real element would carry — for HTML serializers. */
  get styleText(): string {
    return [...this.props.entries()].map(([name, value]) => `${name}: ${value}`).join("; ");
  }

  addEventListener(name: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, fn: (event: unknown) => void): void {
    const list = (this.listeners.get(name) ?? []).filter((entry) => entry !== fn);
    this.listeners.set(name, list);
  }

  /** Fire every handler for `name`; the harness drives clicks with it. */
  fire(name: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }

  getBoundingClientRect(): { top: number; left: number; width: number; height: number } {
    return { top: 0, left: 0, width: this.width, height: this.height };
  }

  /** Class selectors only (`.a`, `.a.b`) plus a bare tag name — enough here. */
  querySelectorAll(selector: string): StubEl[] {
    const out: StubEl[] = [];
    this.walk((el) => {
      if (el !== this && matches(el, selector)) out.push(el);
    });
    return out;
  }

  querySelector(selector: string): StubEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(other: StubEl): boolean {
    let found = false;
    this.walk((el) => {
      if (el === other) found = true;
    });
    return found;
  }

  walk(visit: (el: StubEl) => void): void {
    visit(this);
    for (const child of [...this.children]) child.walk(visit);
  }

  /** Every element in tree order, self first. */
  flatten(): StubEl[] {
    const out: StubEl[] = [];
    this.walk((el) => out.push(el));
    return out;
  }
}

export interface ElOptions {
  cls?: string;
  text?: string;
  href?: string;
  value?: string;
  attr?: Record<string, string | number | boolean>;
}

function matches(el: StubEl, selector: string): boolean {
  const parts = selector.trim().split(".").filter(Boolean);
  if (selector.startsWith(".")) return parts.every((name) => el.classes.has(name));
  const [tag, ...classes] = parts;
  if (tag !== undefined && tag !== el.tag) return false;
  return classes.every((name) => el.classes.has(name));
}

/**
 * Install the globals a mounted tab expects, and hand back a teardown.
 *
 * `requestAnimationFrame` runs callbacks synchronously: the ring's double-rAF
 * reveal is the only user, and a test that has to await two frames to see a
 * number is a test nobody will keep.
 */
export function installDomGlobals(width = 900): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    requestAnimationFrame: globals["requestAnimationFrame"],
    cancelAnimationFrame: globals["cancelAnimationFrame"],
    window: globals["window"],
    document: globals["document"],
    CustomEvent: globals["CustomEvent"],
    IntersectionObserver: globals["IntersectionObserver"],
    ResizeObserver: globals["ResizeObserver"],
  };

  globals["requestAnimationFrame"] = (fn: () => void): number => {
    fn();
    return 1;
  };
  globals["cancelAnimationFrame"] = (): void => undefined;
  globals["window"] = {
    innerHeight: 900,
    innerWidth: width,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    open: () => null,
  };
  globals["document"] = {
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: new StubEl("body"),
  };
  if (typeof globals["CustomEvent"] !== "function") {
    globals["CustomEvent"] = class {
      constructor(
        public type: string,
        public init?: unknown,
      ) {}
    };
  }
  // Left undefined on purpose: the poster loader falls back to eager loading,
  // which is what a headless render should do anyway.
  delete globals["IntersectionObserver"];
  delete globals["ResizeObserver"];

  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  };
}

/** A host element with a believable width, ready to mount into. */
export function createHost(width = 900): StubEl {
  const host = new StubEl("div", "wl-view");
  host.width = width;
  return host;
}
