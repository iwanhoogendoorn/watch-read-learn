/**
 * The Games sort button — key *and* direction in one menu, exactly like the
 * Library's (`ui/components/sortmenu.ts`).
 *
 * Picking a new key adopts its natural direction, re-picking flips it, and
 * "Then by" configures the tiebreaker with the current primary excluded. A
 * separate implementation only because the key union is games' own; the
 * behaviour is deliberately identical, down to the arrows in the labels.
 */
import { Menu, setIcon } from "obsidian";
import {
  GAME_SORT_DEFAULT_DIR,
  GAME_SORT_KEYS,
  GAME_SORT_LABELS,
  nextGameSortSpec,
  type GameSortSpec,
} from "./sort";

export interface GameSortButtonOptions {
  getSort: () => GameSortSpec;
  getSecondary: () => GameSortSpec | null;
  onChange: (sort: GameSortSpec, secondary: GameSortSpec | null) => void;
}

export interface GameSortButtonHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createGameSortButton(
  parent: HTMLElement,
  options: GameSortButtonOptions,
): GameSortButtonHandle {
  const button = parent.createEl("button", {
    cls: "wl-btn wl-sort-btn",
    attr: { type: "button", "aria-label": "Sort" },
  });
  const iconEl = button.createSpan({ cls: "wl-btn-icon" });
  const labelEl = button.createSpan({ cls: "wl-btn-label" });

  function sync(): void {
    const sort = options.getSort();
    labelEl.setText(GAME_SORT_LABELS[sort.key]);
    iconEl.empty();
    setIcon(iconEl, sort.direction === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow");
    const secondary = options.getSecondary();
    button.setAttribute(
      "title",
      secondary
        ? `Sort: ${GAME_SORT_LABELS[sort.key]} (${sort.direction}), then ${GAME_SORT_LABELS[secondary.key]}`
        : `Sort: ${GAME_SORT_LABELS[sort.key]} (${sort.direction})`,
    );
  }

  button.addEventListener("click", (event: MouseEvent) => {
    const sort = options.getSort();
    const secondary = options.getSecondary();
    const menu = new Menu();

    menu.addItem((item) => item.setTitle("Sort by").setDisabled(true).setIsLabel(true));
    for (const key of GAME_SORT_KEYS) {
      menu.addItem((item) => {
        const active = key === sort.key;
        const arrow = active ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
        item
          .setTitle(`${GAME_SORT_LABELS[key]}${arrow}`)
          .setChecked(active)
          .onClick(() => {
            // A key can never be both levels at once.
            options.onChange(nextGameSortSpec(sort, key), secondary?.key === key ? null : secondary);
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
    for (const key of GAME_SORT_KEYS) {
      if (key === sort.key) continue;
      menu.addItem((item) => {
        const active = secondary?.key === key;
        const arrow = active ? (secondary?.direction === "asc" ? " ↑" : " ↓") : "";
        item
          .setTitle(`${GAME_SORT_LABELS[key]}${arrow}`)
          .setChecked(active)
          .onClick(() => {
            const next: GameSortSpec = active
              ? { key, direction: secondary?.direction === "asc" ? "desc" : "asc" }
              : { key, direction: GAME_SORT_DEFAULT_DIR[key] };
            options.onChange(sort, next);
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
