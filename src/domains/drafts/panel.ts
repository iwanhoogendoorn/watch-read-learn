/**
 * The Drafts panel — a triage queue inside the Library (SPEC2-PARITY.md
 * §D-EXTRAS, item 2, and the tab-count decision in `types.ts` §9).
 *
 * v3 gave drafts a whole tab. It is not a place to be: it is a short list of
 * things you wrote down somewhere else and now have to file. So it is a panel
 * behind the Library's toolbar button, with the pending count as a badge, and it
 * drops into the same host the filter drawer uses.
 *
 * Two halves live here:
 *
 *   - `DraftsService`, owned by the composition root. It scans the vault, keeps
 *     `data.drafts` current, caches the entries, and re-scans 500 ms after
 *     `metadataCache.changed` — the debounce matters because typing inside a
 *     tagged note fires that event on every keystroke.
 *   - `renderDraftsPanel`, which draws the cached entries. Rendering never
 *     waits on a scan; a panel opened before the first sweep says so.
 */
import { Notice, setIcon, type App, type EventRef } from "obsidian";
import type { DraftsState, WatchLogStoreApi } from "../../types";
import { addDraftToDomain, DraftTargetModal } from "./add";
import { DraftMatcher, matchLabel } from "./match";
import { collectCandidates, type ScannedCandidate } from "./scan";
import {
  buildEntries,
  dismiss,
  markAdded,
  normalizeDraftsState,
  pendingCount,
  rememberSeen,
  restore,
  type DraftEntry,
} from "./state";

/** v3's debounce. Long enough that typing in a tagged note is not a rescan storm. */
export const RESCAN_DEBOUNCE_MS = 500;

export interface DraftsServiceOptions {
  app: App;
  store: WatchLogStoreApi;
  /** The composition root's Add modal, pre-filled. Absent = manual entry only. */
  onAddToWatchlist?: (title: string, onAdded: () => void) => void;
}

export class DraftsService {
  private readonly app: App;
  private readonly store: WatchLogStoreApi;
  private readonly options: DraftsServiceOptions;
  private entries: DraftEntry[] = [];
  private pending = 0;
  private scanned = false;
  private scanning: Promise<void> | null = null;
  /** A change arrived mid-sweep; one more pass is owed once this one ends. */
  private rescanRequested = false;
  private eventRef: EventRef | null = null;
  private debounce: number | null = null;
  private destroyed = false;
  private readonly listeners = new Set<() => void>();

  constructor(options: DraftsServiceOptions) {
    this.app = options.app;
    this.store = options.store;
    this.options = options;
  }

  /** Pending drafts as of the last scan. Synchronous, for the toolbar badge. */
  count(): number {
    return this.pending;
  }

  hasScanned(): boolean {
    return this.scanned;
  }

  current(): readonly DraftEntry[] {
    return this.entries;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * First scan plus the live watcher.
   *
   * Guarded twice (W8 review P2-1). A destroyed service must not attach a
   * vault-wide listener — `onLayoutReady` can fire *after* teardown, and the
   * `eventRef` from that registration would never be released, leaving a dead
   * service listening for the rest of the session. And a second `start()` must
   * not attach a second listener over the first, which would leak the earlier
   * ref just as permanently.
   */
  start(): void {
    if (this.destroyed || this.eventRef !== null) return;
    void this.scan();
    this.eventRef = this.app.metadataCache.on("changed", () => this.scheduleScan());
  }

  destroy(): void {
    this.destroyed = true;
    this.rescanRequested = false;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = null;
    if (this.eventRef) this.app.metadataCache.offref(this.eventRef);
    this.eventRef = null;
    this.listeners.clear();
  }

  scheduleScan(): void {
    if (this.destroyed) return;
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      void this.scan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private state(): DraftsState {
    const data = this.store.data;
    const state = normalizeDraftsState(data.drafts);
    data.drafts = state;
    return state;
  }

  /**
   * Sweep every markdown file for the tag. Coalesced: one scan at a time.
   *
   * A request that arrives *during* a sweep is remembered rather than dropped
   * (W8 review P1-4). Returning the in-flight promise was almost right — one
   * scan at a time is correct — but on a large vault the active sweep may
   * already have read the note that just changed, so its edit would not appear
   * until something else happened to trigger a rescan. Any number of mid-scan
   * events coalesce into exactly one rerun.
   */
  async scan(): Promise<void> {
    if (this.destroyed) return;
    if (this.scanning) {
      this.rescanRequested = true;
      return this.scanning;
    }
    this.scanning = this.runScan().finally(() => {
      this.scanning = null;
      if (this.rescanRequested && !this.destroyed) {
        this.rescanRequested = false;
        // Not awaited: the caller asked for *a* sweep and got one. This is the
        // follow-up that makes the result current.
        void this.scan();
      }
    });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    const tag = this.store.settings.draftsVaultTag.trim();
    const scanned = tag === "" ? [] : await this.sweep(tag);
    if (this.destroyed) return;

    const state = this.state();
    if (rememberSeen(state, scanned, new Date().toISOString())) {
      this.store.save("drafts-seen");
    }
    this.rebuild(scanned);
    this.scanned = true;
  }

  private async sweep(tag: string): Promise<ScannedCandidate[]> {
    const accumulator = new Map<string, ScannedCandidate>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      // The metadata cache knows which files carry the tag without reading them;
      // only those are opened. On a large vault that is the whole cost saving.
      const cache = this.app.metadataCache.getFileCache(file);
      const tagged =
        cache?.tags?.some((entry) => entry.tag === tag) === true ||
        (Array.isArray(cache?.frontmatter?.tags) &&
          (cache.frontmatter.tags as unknown[]).some(
            (entry) => `#${String(entry)}` === tag || String(entry) === tag,
          ));
      if (!tagged) continue;
      try {
        collectCandidates(accumulator, await this.app.vault.cachedRead(file), tag, file.basename);
      } catch {
        // An unreadable note is skipped, not fatal — one bad file must not cost
        // the user the rest of their queue.
      }
    }
    return [...accumulator.values()];
  }

  /** Recompute entries + count from a scan result, and tell the UI if it moved. */
  private rebuild(scanned: readonly ScannedCandidate[]): void {
    const matcher = new DraftMatcher({
      titles: this.store.allTitles(),
      books: this.store.reading.books,
      manga: this.store.reading.manga,
      games: this.store.games.games,
    });
    this.entries = buildEntries(
      this.state(),
      scanned,
      (display) => matcher.find(display),
      new Date().toISOString(),
    );
    const next = pendingCount(this.entries);
    const moved = next !== this.pending;
    this.pending = next;
    for (const listener of this.listeners) listener();
    // The badge lives in the Library toolbar, which only redraws on the data
    // bus. Emitting only on a real change keeps a quiet vault quiet — and stops
    // a rescan triggered by a render from turning into a render loop.
    if (moved) this.store.emitChanged({ reason: "drafts-rescanned" });
  }

  /** The tag being scanned for, for the panel's empty state. */
  tag(): string {
    return this.store.settings.draftsVaultTag;
  }

  /** How many drafts the user has waved away. Dismissal has to be undoable. */
  dismissedCount(): number {
    return this.state().dismissed.length;
  }

  /** Undo every dismissal at once — the only way back, so it is not hidden. */
  restoreAll(): void {
    const state = this.state();
    if (state.dismissed.length === 0) return;
    state.dismissed = [];
    this.store.save("drafts-restored");
    void this.scan();
  }

  /** Re-run matching against the current libraries without re-reading the vault. */
  refreshMatches(): void {
    this.rebuild(
      this.entries.map((entry) => ({
        key: entry.key,
        display: entry.display,
        sources: entry.sources,
      })),
    );
  }

  dismiss(key: string): void {
    dismiss(this.state(), key);
    this.store.save("draft-dismissed");
    this.refreshMatches();
  }

  restore(key: string): void {
    restore(this.state(), key);
    this.store.save("draft-restored");
    void this.scan();
  }

  /** Post-add bookkeeping, honouring `settings.draftsAfterAdding`. */
  afterAdded(key: string): void {
    if (this.store.settings.draftsAfterAdding === "dismiss") {
      this.dismiss(key);
      return;
    }
    markAdded(this.state(), key);
    this.store.save("draft-added");
    this.refreshMatches();
  }

  add(entry: DraftEntry): void {
    new DraftTargetModal(this.app, entry.display, (target) => {
      if (target === "watchlist") {
        const open = this.options.onAddToWatchlist;
        if (!open) {
          new Notice("The Add dialog is not available here.");
          return;
        }
        open(entry.display, () => this.afterAdded(entry.key));
        return;
      }
      if (addDraftToDomain(this.store, target, entry.display)) this.afterAdded(entry.key);
    }).open();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface DraftsPanelHandle {
  destroy(): void;
}

/**
 * Draw the panel into `host`. Returns a handle whose `destroy` unsubscribes —
 * the Library toggles the panel, so this is mounted and torn down repeatedly.
 */
export function renderDraftsPanel(
  host: HTMLElement,
  service: DraftsService,
  app: App,
): DraftsPanelHandle {
  const panel = host.createDiv({ cls: "wl-drafts-panel" });
  const unsubscribe = service.onChange(() => draw());

  function draw(): void {
    panel.empty();

    const head = panel.createDiv({ cls: "wl-drafts-head" });
    head.createDiv({ cls: "wl-drafts-title", text: "Drafts" });
    const refresh = head.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": "Rescan the vault", title: "Rescan the vault" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void service.scan());

    const entries = service.current();
    const pending = service.count();
    head.createDiv({
      cls: "wl-drafts-count",
      text: service.hasScanned()
        ? `${pending} waiting`
        : "scanning…",
    });

    if (!service.hasScanned()) {
      panel.createDiv({ cls: "wl-drafts-note", text: "Reading your notes…" });
      return;
    }

    if (entries.length === 0) {
      panel.createDiv({
        cls: "wl-drafts-note",
        text: `Nothing queued. Write ${service.tag()} followed by a title in any note — commas separate several — and it turns up here.`,
      });
    } else {
      const cards = panel.createDiv({ cls: "wl-drafts-cards" });
      for (const entry of entries) drawCard(cards, entry);
    }

    drawDismissedFoot();
  }

  /**
   * The way back out of a dismissal.
   *
   * v3 had none: pressing × removed a draft from the queue forever, with the
   * only record a string in `data.json`. One mis-aimed click on a phone is not
   * a decision, so the count is shown and it is reversible.
   */
  function drawDismissedFoot(): void {
    const dismissed = service.dismissedCount();
    if (dismissed === 0) return;
    const foot = panel.createDiv({ cls: "wl-drafts-foot" });
    foot.createSpan({
      cls: "wl-drafts-foot-label",
      text: `${dismissed} dismissed`,
    });
    const restore = foot.createEl("button", {
      cls: "wl-btn wl-small-btn",
      attr: { type: "button" },
    });
    restore.createSpan({ cls: "wl-btn-label", text: "Bring them back" });
    restore.addEventListener("click", () => service.restoreAll());
  }

  function drawCard(parent: HTMLElement, entry: DraftEntry): void {
    const resolved = entry.added || entry.match !== null;
    const card = parent.createDiv({
      cls: `wl-drafts-card${resolved ? " is-resolved" : ""}`,
    });
    card.createDiv({ cls: "wl-drafts-card-title", text: entry.display });

    const meta = card.createDiv({ cls: "wl-drafts-card-meta" });
    const first = entry.sources[0];
    if (first !== undefined) {
      const link = meta.createSpan({ cls: "wl-drafts-source", text: `[[${first}]]` });
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      const open = (): void => {
        void app.workspace.openLinkText(first, "");
      };
      link.addEventListener("click", open);
      link.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") open();
      });
      if (entry.sources.length > 1) {
        meta.createSpan({
          cls: "wl-drafts-source-more",
          text: `+${entry.sources.length - 1}`,
          attr: { title: entry.sources.join("\n") },
        });
      }
    }
    if (entry.match) {
      meta.createSpan({
        cls: "wl-drafts-match",
        text: matchLabel(entry.match),
        attr: { title: `Closest match: “${entry.match.title}”` },
      });
    }

    const actions = card.createDiv({ cls: "wl-drafts-card-actions" });
    if (entry.added) {
      actions.createSpan({ cls: "wl-drafts-added", text: "Added" });
    } else {
      const add = actions.createEl("button", {
        cls: entry.match ? "wl-btn" : "wl-btn mod-cta",
        attr: { type: "button" },
      });
      add.createSpan({ cls: "wl-btn-label", text: entry.match ? "Add anyway" : "Add" });
      add.addEventListener("click", () => service.add(entry));
    }

    const dismissButton = actions.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button", "aria-label": "Dismiss", title: "Dismiss this draft" },
    });
    setIcon(dismissButton, "x");
    dismissButton.addEventListener("click", () => service.dismiss(entry.key));
  }

  draw();

  return {
    destroy(): void {
      unsubscribe();
      panel.remove();
    },
  };
}
