/**
 * The the plugin view — tab bar plus a content host.
 *
 * Behaviour ported from foodspot §3: every pane is declared as data, the active
 * tab is persisted, and switching tabs tears the old controller down rather than
 * hiding it — the grids own IntersectionObservers, and a hidden observer is a
 * leak with a nice view.
 *
 * All four tabs are real. Each is built from `plugin.tabDeps()`, which is the
 * single place services are injected, so no tab imports a service client.
 *
 * This is also where the **cross-tab query handoff** lives (foodspot's
 * `pendingQuery`): a chip in the detail modal, a genre on a card, or the "Search
 * title" command can call `jumpToQuery()` and land on a filtered Library whether
 * or not that tab is currently mounted. `plugin.pendingLibraryQuery` covers the
 * case where the *view itself* is not open yet.
 */
import { ItemView, Platform, setIcon, type WorkspaceLeaf } from "obsidian";
import { VIEW_DISPLAY_NAME, VIEW_ICON, VIEW_TYPE_WATCHLOG } from "../constants";
import {
  DATA_CHANGED_EVENT,
  readExtra,
  writeExtra,
  type TabController,
  type TabId,
} from "../types";
import { mountLibraryTab, type LibraryController } from "./tabs/library";
import { mountDashboardTab } from "./tabs/dashboard";
import { mountUpcomingTab } from "./tabs/upcoming";
import { mountActivityTab } from "./tabs/activity";
import { mountStubTab } from "./tabs/stub";
import { mountReadingTab } from "../domains/reading";
import { mountGamesTab } from "../domains/games/tab";
import { mountListsTab } from "../domains/lists/tab";
import type WatchLogPlugin from "../main";

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

/**
 * The seven tabs, in order (SPEC2-PARITY.md).
 *
 * v3's eighth — Drafts — is a panel inside the Library here rather than a tab
 * of its own: it is a triage queue, not a place to be. Icons match v3's so the
 * mobile icon-only bar stays recognisable.
 */
const TABS: TabDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "layout-dashboard" },
  { id: "library", label: "Library", icon: "tv" },
  { id: "reading", label: "Reading", icon: "book-open" },
  { id: "games", label: "Games", icon: "gamepad-2" },
  { id: "upcoming", label: "Upcoming", icon: "calendar" },
  { id: "lists", label: "Lists", icon: "list" },
  { id: "activity", label: "Activity", icon: "history" },
];

export class WatchLogView extends ItemView {
  private plugin: WatchLogPlugin;
  private activeTab: TabId = "library";
  private tabBarEl: HTMLElement | null = null;
  private contentHostEl: HTMLElement | null = null;
  private controller: TabController | null = null;
  private pendingQuery: string | null = null;
  /** Which tab the parked query belongs to. */
  private pendingDomain: TabId = "library";

  /** Bound so it can be removed again; the data bus is a plain DOM listener. */
  private onDataChanged = (): void => {
    this.controller?.refresh();
  };

  constructor(leaf: WorkspaceLeaf, plugin: WatchLogPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_WATCHLOG;
  }

  override getDisplayText(): string {
    return VIEW_DISPLAY_NAME;
  }

  override getIcon(): string {
    return VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("wl-view");
    root.toggleClass("wl-mobile", Platform.isMobile);

    this.tabBarEl = root.createDiv({ cls: "wl-tab-bar" });
    this.contentHostEl = root.createDiv({ cls: "wl-tab-content" });

    this.buildTabBar();

    // A query parked before the view existed (the "Search title" command, or a
    // chip clicked from a note) decides which tab opens.
    const parked = this.plugin.takePendingLibraryQuery();
    if (parked !== null) this.pendingQuery = parked;
    this.setActiveTab(parked !== null ? "library" : this.readActiveTab());

    // `registerDomEvent` only accepts events from the built-in event maps, and
    // ours is a custom one — wire it by hand and unregister on close.
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.register(() => doc.removeEventListener(DATA_CHANGED_EVENT, this.onDataChanged));

    // Request polling runs only while a view is on screen (SPEC §4.2), and the
    // catch-up pass behind this is throttled, so tab-flipping is free.
    this.plugin.integrations?.viewOpened();
    this.register(() => this.plugin.integrations?.viewClosed());
  }

  override async onClose(): Promise<void> {
    this.controller?.destroy();
    this.controller = null;
    this.contentEl.empty();
    this.contentEl.removeClass("wl-view", "wl-mobile");
  }

  private buildTabBar(): void {
    const bar = this.tabBarEl;
    if (!bar) return;
    bar.empty();

    for (const tab of TABS) {
      const button = bar.createEl("button", { cls: "wl-tab", attr: { type: "button" } });
      button.dataset.tab = tab.id;
      button.setAttribute("aria-label", tab.label);
      const icon = button.createSpan({ cls: "wl-tab-icon" });
      setIcon(icon, tab.icon);
      // Labels are dropped on mobile by CSS; the aria-label above keeps them
      // available to assistive tech either way.
      button.createSpan({ cls: "wl-tab-label", text: tab.label });
      button.addEventListener("click", () => this.setActiveTab(tab.id));
    }
  }

  // -------------------------------------------------------------------------
  // Tab state
  // -------------------------------------------------------------------------

  /**
   * The persisted tab. `activeTab` is not a declared `Settings` key — it lives in
   * the round-tripped remainder of `data.json`, which is exactly what
   * `readExtra`/`writeExtra` exist for. Anything unreadable falls back to Library.
   */
  private readActiveTab(): TabId {
    const raw = readExtra<string>(this.plugin.store.settings, "activeTab");
    return TABS.some((t) => t.id === raw) ? (raw as TabId) : this.activeTab;
  }

  private writeActiveTab(id: TabId): void {
    writeExtra(this.plugin.store.settings, "activeTab", id);
    this.plugin.store.save("active-tab");
  }

  setActiveTab(id: TabId): void {
    this.activeTab = id;
    this.writeActiveTab(id);

    const bar = this.tabBarEl;
    if (bar) {
      for (const el of Array.from(bar.children)) {
        el.toggleClass("is-active", el instanceof HTMLElement && el.dataset.tab === id);
      }
    }

    this.controller?.destroy();
    this.controller = null;

    const host = this.contentHostEl;
    if (!host) return;
    host.empty();
    this.controller = this.buildTab(id, host);
    this.drainPendingQuery();
  }

  /**
   * Cross-tab handoff. Works whether or not the Library is mounted: if it is not,
   * the query is parked and drained the moment it is.
   */
  /**
   * Cross-tab handoff, per library.
   *
   * A chip is only useful if it lands somewhere that can answer it: `genre:` in
   * a film's modal belongs on the Library, `author:` in a book's belongs on
   * Reading, `platform:` in a game's on Games. Same parking mechanism as before,
   * one extra question — which tab (SPEC2 §"Surfaces that grow").
   */
  jumpToQuery(query: string, domain: TabId = "library"): void {
    this.pendingQuery = query;
    this.pendingDomain = domain;
    if (this.activeTab === domain) this.drainPendingQuery();
    else this.setActiveTab(domain);
  }

  private drainPendingQuery(): void {
    if (this.pendingQuery === null) return;
    const controller = this.controller;
    if (!controller || controller.id !== this.pendingDomain) return;
    // Every tab that can receive a query implements the same one-method
    // interface; a tab that cannot simply never gets one parked for it.
    const target = controller as Partial<LibraryController>;
    if (typeof target.applyQuery !== "function") {
      this.pendingQuery = null;
      return;
    }
    const query = this.pendingQuery;
    this.pendingQuery = null;
    target.applyQuery(query);
  }

  private buildTab(id: TabId, host: HTMLElement): TabController {
    switch (id) {
      case "library":
        return mountLibraryTab(host, this.plugin.libraryDeps());
      case "dashboard":
        return mountDashboardTab(host, this.plugin.tabDeps());
      case "upcoming":
        return mountUpcomingTab(host, this.plugin.tabDeps());
      case "activity":
        return mountActivityTab(host, this.plugin.tabDeps());
      case "reading":
        return mountReadingTab(host, this.plugin.readingDeps());
      case "games":
        return mountGamesTab(host, this.plugin.gamesDeps());
      case "lists":
        return mountListsTab(host, { app: this.app, store: this.plugin.store });
    }
  }
}
