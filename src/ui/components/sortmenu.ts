/**
 * The sort button — key *and* direction in one menu (foodspot §2d, conventions
 * 7 and 8).
 *
 * Picking a new key adopts that key's natural direction; picking the key that is
 * already active flips it. There is no separate direction control, and there does
 * not need to be. Below a separator, "Then by" configures the tiebreaker, with
 * the current primary excluded from the list.
 *
 * The comparator itself lives in `engine.ts`; this file is only the menu.
 *
 * **The axes are a parameter.** The Library's keys are the default, but nothing
 * in the menu's behaviour depends on them, so a surface with its own axes (the
 * Upcoming tab sorts by air date, domain and announcement) passes its own
 * `keys` / `labels` / `defaultDirection` rather than forking the file. Reading
 * and Games predate this and still have their own copies; new surfaces should
 * not add a fourth.
 */
import { Menu, setIcon } from "obsidian";
import type { SortDirection, SortKey, SortSpec } from "../../types";
import { SORT_DEFAULT_DIR, SORT_KEYS, SORT_LABELS, nextSortSpec } from "./engine";

/** `SortSpec`, with the key vocabulary left open. */
export interface SortSpecOf<K extends string> {
  key: K;
  direction: SortDirection;
}

export interface SortButtonOptions<K extends string = SortKey> {
  getSort: () => SortSpecOf<K>;
  getSecondary: () => SortSpecOf<K> | null;
  onChange: (sort: SortSpecOf<K>, secondary: SortSpecOf<K> | null) => void;
  /** The axes offered, in menu order. Defaults to the Library's `SORT_KEYS`. */
  keys?: readonly K[];
  /** Human label per key. Defaults to the Library's `SORT_LABELS`. */
  labels?: (key: K) => string;
  /** The direction a *newly picked* key adopts. Defaults to the Library's. */
  defaultDirection?: (key: K) => SortDirection;
}

export interface SortButtonHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createSortButton<K extends string = SortKey>(
  parent: HTMLElement,
  options: SortButtonOptions<K>,
): SortButtonHandle {
  // The defaults are the Library's, which is what `K = SortKey` means; the casts
  // are the price of letting one component serve both and are contained here.
  const keys: readonly K[] = options.keys ?? (SORT_KEYS as unknown as readonly K[]);
  const labelOf = options.labels ?? ((key: K): string => SORT_LABELS[key as unknown as SortKey] ?? key);
  const defaultDirOf =
    options.defaultDirection ??
    ((key: K): SortDirection => SORT_DEFAULT_DIR[key as unknown as SortKey] ?? "asc");

  /** Same key → flip; new key → its natural direction (convention 8). */
  const next = (current: SortSpecOf<K>, key: K): SortSpecOf<K> => {
    if (options.keys === undefined && options.defaultDirection === undefined) {
      // The Library's exact helper, so its behaviour has one home.
      return nextSortSpec(current as unknown as SortSpec, key as unknown as SortKey) as unknown as SortSpecOf<K>;
    }
    if (current.key === key) {
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    }
    return { key, direction: defaultDirOf(key) };
  };

  const button = parent.createEl("button", {
    cls: "wl-btn wl-sort-btn",
    attr: { type: "button", "aria-label": "Sort" },
  });
  const iconEl = button.createSpan({ cls: "wl-btn-icon" });
  const labelEl = button.createSpan({ cls: "wl-btn-label" });

  function sync(): void {
    const sort = options.getSort();
    labelEl.setText(labelOf(sort.key));
    iconEl.empty();
    setIcon(
      iconEl,
      sort.direction === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow",
    );
    const secondary = options.getSecondary();
    button.setAttribute(
      "title",
      secondary
        ? `Sort: ${labelOf(sort.key)} (${sort.direction}), then ${labelOf(secondary.key)}`
        : `Sort: ${labelOf(sort.key)} (${sort.direction})`,
    );
  }

  button.addEventListener("click", (event: MouseEvent) => {
    const sort = options.getSort();
    const secondary = options.getSecondary();
    const menu = new Menu();

    menu.addItem((item) => item.setTitle("Sort by").setDisabled(true).setIsLabel(true));
    for (const key of keys) {
      menu.addItem((item) => {
        const active = key === sort.key;
        const arrow = active ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
        item
          .setTitle(`${labelOf(key)}${arrow}`)
          .setChecked(active)
          .onClick(() => {
            // A key can never be both levels at once.
            const nextSecondary = secondary?.key === key ? null : secondary;
            options.onChange(next(sort, key), nextSecondary);
            sync();
          });
      });
    }

    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Then by").setDisabled(true).setIsLabel(true));
    menu.addItem((item) =>
      item
        .setTitle("None")
        .setChecked(secondary === null)
        .onClick(() => {
          options.onChange(sort, null);
          sync();
        }),
    );
    for (const key of keys) {
      if (key === sort.key) continue;
      menu.addItem((item) => {
        const active = secondary?.key === key;
        const arrow = active ? (secondary?.direction === "asc" ? " ↑" : " ↓") : "";
        item
          .setTitle(`${labelOf(key)}${arrow}`)
          .setChecked(active)
          .onClick(() => {
            const spec: SortSpecOf<K> = active
              ? { key, direction: secondary?.direction === "asc" ? "desc" : "asc" }
              : { key, direction: defaultDirOf(key) };
            options.onChange(sort, spec);
            sync();
          });
      });
    }

    menu.showAtMouseEvent(event);
  });

  sync();

  return {
    el: button,
    refresh: sync,
    destroy(): void {
      button.remove();
    },
  };
}
