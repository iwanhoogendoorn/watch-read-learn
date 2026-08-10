/**
 * Empty states. Never a bare "No results" — foodspot's convention 10: the
 * first-run state and the no-match state are different situations with different
 * fixes, and showing one when you mean the other is actively misleading.
 */
import { setIcon } from "obsidian";

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /** One action per empty state may be accent-styled as the obvious next step. */
  cta?: boolean;
}

export interface EmptyStateOptions {
  icon: string;
  title: string;
  body: string;
  actions?: EmptyAction[];
  cls?: string;
}

export function renderEmptyState(parent: HTMLElement, options: EmptyStateOptions): HTMLElement {
  const el = parent.createDiv({ cls: `wl-empty ${options.cls ?? ""}`.trim() });
  const icon = el.createDiv({ cls: "wl-empty-icon" });
  setIcon(icon, options.icon);
  el.createDiv({ cls: "wl-empty-title", text: options.title });
  el.createDiv({ cls: "wl-empty-body", text: options.body });

  if (options.actions?.length) {
    const row = el.createDiv({ cls: "wl-empty-actions" });
    for (const action of options.actions) {
      const button = row.createEl("button", {
        cls: `wl-btn ${action.cta ? "mod-cta" : ""}`.trim(),
        text: action.label,
        attr: { type: "button" },
      });
      button.addEventListener("click", action.onClick);
    }
  }
  return el;
}

/** Nothing tracked at all. The fix is to add something. */
export function renderFirstRunEmpty(parent: HTMLElement, onAdd: () => void): HTMLElement {
  return renderEmptyState(parent, {
    cls: "is-first-run",
    icon: "tv",
    title: "Nothing tracked yet",
    body: "Add a movie or show to start your library. Search pulls posters, cast and seasons in automatically.",
    actions: [{ label: "Add your first title", onClick: onAdd, cta: true }],
  });
}

/** Plenty tracked, nothing matching. The fix is to widen the query. */
export function renderNoMatchEmpty(parent: HTMLElement, onClear: () => void): HTMLElement {
  return renderEmptyState(parent, {
    cls: "is-no-match",
    icon: "search-x",
    title: "No titles match",
    body: "Your search or filters rule everything out. Clearing both brings the whole library back.",
    actions: [{ label: "Clear search & filters", onClick: onClear, cta: true }],
  });
}
