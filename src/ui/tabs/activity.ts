/**
 * Activity tab — SPEC §4.8.
 *
 * The v3 activity log, migrated verbatim, plus the v4 event kinds (`requested`,
 * `available`, `airing`). Newest first, grouped by day, filterable by kind, with
 * per-entry delete and a guarded "clear all".
 *
 * The store appends newest **last** (it is a plain array with a cap on the head),
 * so every read path here reverses first. Pure helpers on top, DOM below.
 */
import { Notice, setIcon } from "obsidian";
import type { HistoryEntry, TabController } from "../../types";
import {
  depsNow,
  renderEmptyState,
  section,
  sectionHeader,
  startOfDay,
  type TabDeps,
} from "./upcoming";

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

export interface ActivityFilter {
  /** `""` is the synthetic "all kinds" option. */
  id: string;
  label: string;
  icon: string;
}

/**
 * Filter chips, in display order. `action` values that migration carried over
 * from v3 but v4 never writes still render — they just fall into "Other".
 */
export const ACTIVITY_FILTERS: ActivityFilter[] = [
  { id: "", label: "All", icon: "history" },
  { id: "added", label: "Added", icon: "plus" },
  { id: "watched", label: "Episodes", icon: "check" },
  { id: "season", label: "Seasons", icon: "layers" },
  { id: "completed", label: "Completed", icon: "flag" },
  { id: "rating", label: "Ratings", icon: "star" },
  { id: "requested", label: "Requests", icon: "download" },
  { id: "available", label: "Available", icon: "tv" },
  { id: "airing", label: "Airing", icon: "calendar" },
  { id: "deleted", label: "Deleted", icon: "trash-2" },
];

const ACTION_ICONS: Record<string, string> = {
  added: "plus",
  watched: "check",
  season: "layers",
  completed: "flag",
  rating: "star",
  requested: "download",
  available: "tv",
  airing: "calendar",
  deleted: "trash-2",
};

export function activityIcon(action: string | undefined): string {
  return (action && ACTION_ICONS[action]) || "dot";
}

/** Newest first, filtered by kind and by a case-insensitive substring. */
export function filterActivity(
  entries: readonly HistoryEntry[],
  kind: string,
  query = "",
): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const out: HistoryEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (kind && (entry.action ?? "") !== kind) continue;
    if (needle) {
      const haystack = `${entry.message} ${entry.titleName ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    out.push(entry);
  }
  return out;
}

export interface ActivityDay {
  /** `YYYY-MM-DD` of the entry's local day. */
  key: string;
  /** `Today` / `Yesterday` / `12 March 2026`. */
  label: string;
  entries: HistoryEntry[];
}

export function dayLabel(date: Date, now: Date): string {
  const diff = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

/** Group an already-sorted (newest-first) list into day buckets. */
export function groupActivityByDay(
  entries: readonly HistoryEntry[],
  now: Date = new Date(),
): ActivityDay[] {
  const out: ActivityDay[] = [];
  let current: ActivityDay | null = null;
  for (const entry of entries) {
    const date = new Date(entry.timestamp);
    const valid = !Number.isNaN(date.getTime());
    const key = valid
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "unknown";
    if (!current || current.key !== key) {
      current = { key, label: valid ? dayLabel(date, now) : "Undated", entries: [] };
      out.push(current);
    }
    current.entries.push(entry);
  }
  return out;
}

export function formatClock(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Kinds actually present in the log, so the chip row hides dead filters. */
export function usedKinds(entries: readonly HistoryEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) out.add(entry.action ?? "");
  return out;
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function mountActivityTab(host: HTMLElement, deps: TabDeps): TabController {
  const el = host.createDiv({ cls: "wl-tab-panel wl-tab-panel-activity" });
  let kind = "";
  let query = "";

  /**
   * Delete one entry. The store has no single-entry remove, and the history
   * array is part of the live data object, so splice it and go through the
   * store's own save/emit pair — never a bare mutation.
   */
  const deleteEntry = (entry: HistoryEntry): void => {
    const history = deps.store.data.history;
    const index = history.findIndex((e) => e.id === entry.id);
    if (index < 0) return;
    history.splice(index, 1);
    deps.store.save("activity-entry-deleted");
    deps.store.emitChanged({ reason: "activity-entry-deleted" });
  };

  const render = (): void => {
    el.empty();
    const all = deps.store.data.history;

    if (all.length === 0) {
      renderEmptyState(el, {
        icon: "history",
        title: "No activity yet",
        body: "Adding titles, ticking episodes and requesting downloads all get logged here.",
      });
      return;
    }

    const entries = filterActivity(all, kind, query);
    sectionHeader(el, "Activity", `${entries.length} of ${all.length} entries`);

    // --- toolbar -----------------------------------------------------------
    const toolbar = el.createDiv({ cls: "wl-activity-toolbar" });

    const search = toolbar.createEl("input", {
      cls: "wl-activity-search",
      attr: { type: "search", placeholder: "Search activity…", value: query },
    });
    search.addEventListener("input", () => {
      query = search.value;
      render();
      // Re-rendering blows the field away; put the caret back where it was.
      const next = el.querySelector<HTMLInputElement>(".wl-activity-search");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    });

    const present = usedKinds(all);
    const chips = toolbar.createDiv({ cls: "wl-activity-chips" });
    for (const filter of ACTIVITY_FILTERS) {
      if (filter.id && !present.has(filter.id)) continue;
      const chip = chips.createEl("button", { cls: "wl-chip", attr: { type: "button" } });
      chip.toggleClass("is-active", kind === filter.id);
      setIcon(chip.createSpan({ cls: "wl-chip-icon" }), filter.icon);
      chip.createSpan({ text: filter.label });
      chip.addEventListener("click", () => {
        kind = filter.id;
        render();
      });
    }

    const clear = toolbar.createEl("button", {
      cls: "wl-mini-btn is-danger",
      text: "Clear log",
      attr: { type: "button" },
    });
    clear.addEventListener("click", () => {
      if (clear.dataset.armed === "1") {
        deps.store.clearActivity();
        new Notice("Watch, Read and Learn activity log cleared.");
        return;
      }
      // Two-step confirm in place — no modal dependency, no accidental wipe.
      clear.dataset.armed = "1";
      clear.setText("Really clear?");
      window.setTimeout(() => {
        if (!clear.isConnected) return;
        delete clear.dataset.armed;
        clear.setText("Clear log");
      }, 4000);
    });

    // --- list --------------------------------------------------------------
    if (entries.length === 0) {
      renderEmptyState(el, {
        icon: "search-x",
        title: "No matching activity",
        body: "Nothing in the log matches this filter. Clear it to see everything again.",
        action: {
          label: "Clear filter",
          onClick: () => {
            kind = "";
            query = "";
            render();
          },
        },
      });
      return;
    }

    section(el, "Activity log", (s) => {
      const now = depsNow(deps);
      for (const day of groupActivityByDay(entries, now)) {
        const group = s.createDiv({ cls: "wl-activity-day" });
        group.createDiv({ cls: "wl-activity-daylabel", text: day.label });
        const list = group.createDiv({ cls: "wl-activity-list" });
        for (const entry of day.entries) renderActivityRow(list, entry, deleteEntry);
      }
    });
  };

  render();

  return {
    id: "activity",
    el,
    refresh: render,
    destroy: () => {
      el.remove();
    },
  };
}

function renderActivityRow(
  parent: HTMLElement,
  entry: HistoryEntry,
  onDelete: (entry: HistoryEntry) => void,
): HTMLElement {
  const row = parent.createDiv({ cls: `wl-activity-row is-${entry.action ?? "other"}` });
  setIcon(row.createDiv({ cls: "wl-activity-icon" }), activityIcon(entry.action));
  const body = row.createDiv({ cls: "wl-activity-body" });
  body.createDiv({ cls: "wl-activity-message", text: entry.message });
  const clock = formatClock(entry.timestamp);
  if (clock) body.createDiv({ cls: "wl-activity-time", text: clock });

  const remove = row.createEl("button", {
    cls: "wl-icon-btn",
    attr: { type: "button", "aria-label": "Delete this entry" },
  });
  setIcon(remove, "x");
  remove.addEventListener("click", (evt) => {
    evt.stopPropagation();
    onDelete(entry);
  });
  return row;
}
