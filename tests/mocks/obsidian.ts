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
export class ItemView {}
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

export const Platform = { isMobile: false, isDesktop: true };

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
