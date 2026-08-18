/**
 * "Choose visible shelves" — the Dashboard's shelf strip, as a checklist.
 *
 * The Dashboard opens with a strip of poster rails, and how many of them are
 * worth having is a matter of taste that no default can settle: a library of
 * forty films wants all of them, a library of two thousand wants two. So the
 * strip is configurable, and this is the screen that configures it.
 *
 * Three disciplines, all of them about not letting this screen drift from the
 * thing it configures:
 *
 *   1. **Nothing here is a list.** Both groups come from `shelfToggles()` in
 *      `domains/shelves.ts`, which derives them from `CURATED_SHELF_IDS` and
 *      from `settings.statuses`. A hand-kept copy of either would eventually
 *      offer a switch for a shelf that no longer exists, or — worse — silently
 *      stop offering one for a status the user just invented.
 *   2. **Statuses are the user's, not ours.** There is no hardcoded five here.
 *      A vault with one status gets one toggle; a vault with twelve gets twelve.
 *   3. **Every toggle saves itself.** No OK button, no Cancel: flipping a switch
 *      writes the setting and repaints the tab behind the modal, so the effect
 *      of the change is visible while the change is being made. `onChange` owns
 *      both halves of that.
 *
 * `renderShelfSettings` is a plain DOM function, like every other renderer in
 * this plugin, so it can be mounted headlessly in a test; `ShelfSettingsModal`
 * is only the Obsidian frame around it and holds no logic of its own.
 */
import { Modal, type App } from "obsidian";
import {
  setShelfVisible,
  shelfToggles,
  type ShelfToggle,
  type ShelfToggleGroups,
} from "../../domains/shelves";
import type { Settings } from "../../types";

export interface ShelfSettingsOptions {
  /**
   * The live settings object. Mutated in place by `setShelfVisible` — never
   * rebuilt, because `Settings` carries keys TypeScript cannot see (see the
   * header of `types.ts`).
   */
  settings: Settings;
  /**
   * Persist and repaint, in that order, after every single toggle.
   *
   * One hook rather than two: a save that does not repaint leaves the user
   * looking at the old strip, and a repaint that does not save loses the choice
   * the moment Obsidian restarts. Neither half is ever wanted alone.
   */
  onChange: () => void;
}

/** Rendered when the user has somehow ended up with no statuses at all. */
const NO_STATUSES =
  "You have no statuses configured, so there are no status shelves to show or hide.";

function renderRow(parent: HTMLElement, toggle: ShelfToggle, options: ShelfSettingsOptions): void {
  // A `<label>` wrapping the box, so the whole row — name and description
  // included — is the hit target rather than a 13px square.
  const row = parent.createEl("label", { cls: "wl-modal-check wl-shelfset-row" });

  const box = row.createEl("input", { attr: { type: "checkbox" } });
  box.checked = toggle.visible;
  box.addEventListener("change", () => {
    setShelfVisible(options.settings, toggle.id, box.checked);
    options.onChange();
  });

  const text = row.createDiv({ cls: "wl-shelfset-text" });
  text.createDiv({ cls: "wl-shelfset-name", text: toggle.label });
  text.createDiv({ cls: "wl-shelfset-desc", text: toggle.description });
}

interface GroupOptions {
  heading: string;
  /** A sentence under the heading, for a group whose default needs explaining. */
  note?: string;
  /** Shown instead of the rows when there are none. */
  emptyText: string;
}

function renderGroup(
  parent: HTMLElement,
  group: GroupOptions,
  toggles: readonly ShelfToggle[],
  options: ShelfSettingsOptions,
): void {
  parent.createEl("h4", { cls: "wl-shelfset-group", text: group.heading });
  if (group.note) parent.createEl("p", { cls: "wl-modal-detail", text: group.note });
  if (toggles.length === 0) {
    parent.createEl("p", { cls: "wl-modal-detail", text: group.emptyText });
    return;
  }
  for (const toggle of toggles) renderRow(parent, toggle, options);
}

/**
 * Paint the checklist into any container. Returns the groups it drew, so a
 * caller (or a test) can see what was offered without re-deriving it.
 */
export function renderShelfSettings(
  container: HTMLElement,
  options: ShelfSettingsOptions,
): ShelfToggleGroups {
  const groups = shelfToggles(options.settings);

  container.createEl("h3", { cls: "wl-modal-title", text: "Choose visible shelves" });
  container.createEl("p", {
    cls: "wl-modal-message",
    text: "Which poster rows appear at the top of the Dashboard. A row with nothing on it is never drawn, whatever you pick here.",
  });

  renderGroup(
    container,
    { heading: "Curated shelves", emptyText: "" },
    groups.curated,
    options,
  );
  renderGroup(
    container,
    {
      heading: "Status shelves",
      // The two groups have opposite defaults, so the second one has to say so
      // — a group of switches that are all off reads as broken otherwise.
      note: "One row per status, off until you turn it on. A status with nothing in it stays hidden either way.",
      emptyText: NO_STATUSES,
    },
    groups.statuses,
    options,
  );

  return groups;
}

class ShelfSettingsModal extends Modal {
  private options: ShelfSettingsOptions;

  constructor(app: App, options: ShelfSettingsOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-shelfset-modal");
    contentEl.empty();
    renderShelfSettings(contentEl, this.options);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Open the checklist. Every change is already saved by the time it closes. */
export function openShelfSettings(app: App, options: ShelfSettingsOptions): void {
  new ShelfSettingsModal(app, options).open();
}
