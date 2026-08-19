/**
 * Minimal `obsidian` stand-in for vitest.
 *
 * Modules under test are meant to stay obsidian-free; this exists so a test can
 * still import a module that only *type*-imports the API, and so later waves can
 * unit-test thin wrappers without booting Obsidian.
 *
 * Nothing here talks to the network. `requestUrl` throws by default — a test that
 * needs HTTP must stub it explicitly.
 */

export class Plugin {}
export class PluginSettingTab {}
/**
 * Enough of `ItemView` to drive a leaf's lifecycle headlessly.
 *
 * The three members here are the ones a view actually inherits rather than
 * overrides: the leaf it was constructed with, and the `getState`/`setState`
 * pair every subclass chains up to. Without them, `await super.setState(...)`
 * throws, and the one thing worth testing about a workspace view — that a stale
 * leaf restored from a saved layout does not explode — cannot be tested at all.
 *
 * `contentEl` is deliberately not created here: a test supplies its own stub
 * host from `helpers/dom.ts`, which is the only kind that can be asserted about.
 */
export class ItemView {
  constructor(public leaf: unknown = null) {}

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: unknown): Promise<void> {
    /* no-op */
  }
}
export class Modal {
  /** Inert: enough for code that constructs and opens one, no rendering. */
  open(): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}
export class Notice {
  constructor(public message: string) {}
  /** The real one is dismissible; code that holds a Notice open calls this. */
  hide(): void {
    /* no-op */
  }
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
}
export class Setting {}

/**
 * Base classes a module may `extend` at import time. A test that only exercises
 * pure helpers still evaluates the whole module, so these have to exist even
 * when nothing constructs them.
 */
export class MarkdownRenderChild {
  constructor(public containerEl: unknown) {}
  onunload(): void {
    /* no-op */
  }
}

export class SuggestModal {}

/**
 * Obsidian's context menu, recorded rather than shown.
 *
 * A menu is a real part of a control's contract — the reading card's ⋮ and the
 * study section's Read button both put actions *only* there — so a test has to
 * be able to say which items a menu offered and to fire one. `items` is the
 * whole point; `showAtMouseEvent` is a no-op because there is nothing to show.
 */
export class MenuItem {
  title = "";
  icon = "";
  warning = false;
  click: () => void = () => undefined;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setWarning(warning: boolean): this {
    this.warning = warning;
    return this;
  }
  onClick(fn: () => void): this {
    this.click = fn;
    return this;
  }
}

export class Menu {
  readonly items: MenuItem[] = [];
  /** Every menu built since the last reset — how a test finds the one it fired. */
  static opened: Menu[] = [];

  addItem(build: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    build(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    return this;
  }

  showAtMouseEvent(_event: unknown): this {
    Menu.opened.push(this);
    return this;
  }

  showAtPosition(_position: unknown): this {
    Menu.opened.push(this);
    return this;
  }
}

/**
 * Vault file/folder stand-ins. `data/notes.ts` uses `instanceof` on these, so a
 * test that hands the writer a plain object gets the same "not a file" branch
 * production takes for a missing path.
 */
export class TAbstractFile {
  constructor(public path = "") {}
}
export class TFile extends TAbstractFile {
  extension = "md";
}
export class TFolder extends TAbstractFile {}

/** Obsidian collapses `//`, strips a leading `/` and normalises unicode. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

export class FuzzySuggestModal {
  setPlaceholder(): void {
    /* no-op */
  }
  open(): void {
    /* no-op */
  }
}

/**
 * `isMacOS` is mutable and defaults to false: the popout modifier is Cmd on a
 * Mac and Ctrl elsewhere, and a test has to be able to stand in both places.
 */
export const Platform = { isMobile: false, isDesktop: true, isMacOS: false };

export function setIcon(): void {
  /* no-op */
}

export function requestUrl(): Promise<never> {
  return Promise.reject(new Error("requestUrl is not available in tests — stub it explicitly"));
}

export type App = unknown;
export type DataAdapter = unknown;
export type WorkspaceLeaf = unknown;
export type RequestUrlParam = unknown;
export type RequestUrlResponse = unknown;
export type Editor = unknown;
export type FuzzyMatch<T> = { item: T; match: unknown };
export type MarkdownPostProcessorContext = unknown;
