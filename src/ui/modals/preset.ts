/**
 * Saved presets — a **named list**, not v3's single unnamed slot (SPEC §4.5).
 *
 * A preset captures the whole view: query text, every facet, and both sort
 * levels. That completeness is the point — applying one restores exactly what you
 * were looking at, in one click.
 *
 * This file owns the name-entry modal and the bookmark menu that drives them.
 */
import { Menu, Modal, Notice, setIcon, type App } from "obsidian";
import type { FilterState, Preset, SortSpec } from "../../types";
import { confirmAction } from "./confirm";

/** The view state a preset stores. Cloned on the way in and on the way out. */
export interface PresetView {
  query: string;
  filters: FilterState;
  sort: SortSpec;
  secondarySort: SortSpec | null;
}

export function makePresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Deep-enough clone: every field is a primitive or an array of primitives. */
export function clonePresetView(view: PresetView): PresetView {
  return {
    query: view.query,
    filters: {
      ...view.filters,
      excludedTypes: [...view.filters.excludedTypes],
      excludedStatuses: [...view.filters.excludedStatuses],
      excludedPriorities: [...view.filters.excludedPriorities],
      excludedGenres: [...view.filters.excludedGenres],
      excludedTags: [...view.filters.excludedTags],
      excludedDecades: [...view.filters.excludedDecades],
      excludedPlexStates: [...view.filters.excludedPlexStates],
      excludedRequestStates: [...view.filters.excludedRequestStates],
      excludedAiringStates: [...view.filters.excludedAiringStates],
    },
    sort: { ...view.sort },
    secondarySort: view.secondarySort ? { ...view.secondarySort } : null,
  };
}

export function createPreset(name: string, view: PresetView): Preset {
  const cloned = clonePresetView(view);
  return {
    id: makePresetId(),
    name,
    query: cloned.query,
    filters: cloned.filters,
    sort: cloned.sort,
    secondarySort: cloned.secondarySort,
  };
}

// ---------------------------------------------------------------------------
// Name entry
// ---------------------------------------------------------------------------

export class PresetNameModal extends Modal {
  private heading: string;
  private initial: string;
  private submitLabel: string;
  private onSubmit: (name: string) => void;

  constructor(
    app: App,
    options: { heading: string; initial?: string; submitLabel?: string },
    onSubmit: (name: string) => void,
  ) {
    super(app);
    this.heading = options.heading;
    this.initial = options.initial ?? "";
    this.submitLabel = options.submitLabel ?? "Save";
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-preset-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: this.heading });

    const input = contentEl.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "Preset name", "aria-label": "Preset name" },
    });
    input.value = this.initial;

    const message = contentEl.createDiv({ cls: "wl-field-msg" });

    const submit = (): void => {
      const name = input.value.trim();
      if (name === "") {
        // Inline validation, never a Notice wall.
        message.setText("Give the preset a name so you can find it again.");
        input.focus();
        return;
      }
      this.onSubmit(name);
      this.close();
    };

    input.addEventListener("input", () => message.setText(""));
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", {
        cls: "wl-btn mod-cta",
        text: this.submitLabel,
        attr: { type: "button" },
      })
      .addEventListener("click", submit);

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// The bookmark button
// ---------------------------------------------------------------------------

/** The minimum a preset must carry for the menu to name and manage it. */
export interface NamedPreset {
  id: string;
  name: string;
}

/**
 * The bookmark menu, over any preset shape.
 *
 * The Library and Reading store watchlist-shaped `Preset`s and get the default
 * `makePreset` / `mergeView`; a surface whose view does not fit that shape (the
 * Upcoming tab's domains, time window and its own sort axes) supplies the two
 * functions and keeps the menu, the name modal and the delete confirmation.
 */
export interface PresetButtonOptions<P extends NamedPreset = Preset, V = PresetView> {
  app: App;
  getPresets: () => P[];
  /** The view state to capture when saving or overwriting. */
  getView: () => V;
  /** Build a new preset. Defaults to the watchlist `Preset` shape. */
  makePreset?: (name: string, view: V) => P;
  /** Overwrite an existing preset's view, keeping its id and name. */
  mergeView?: (preset: P, view: V) => P;
  onApply: (preset: P) => void;
  /** Persist the mutated list. */
  onChange: (presets: P[]) => void;
}

export interface PresetButtonHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createPresetButton<P extends NamedPreset = Preset, V = PresetView>(
  parent: HTMLElement,
  options: PresetButtonOptions<P, V>,
): PresetButtonHandle {
  // The defaults are the watchlist's, which is what the type defaults mean; the
  // casts are contained here so no caller sees them.
  const makePreset =
    options.makePreset ??
    ((name: string, view: V): P => createPreset(name, view as unknown as PresetView) as unknown as P);
  const mergeView =
    options.mergeView ??
    ((preset: P, view: V): P => ({
      ...preset,
      ...clonePresetView(view as unknown as PresetView),
    }));
  const button = parent.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-preset-btn",
    attr: { type: "button", "aria-label": "Saved views", title: "Saved views" },
  });
  setIcon(button, "bookmark");

  function sync(): void {
    button.toggleClass("is-active", options.getPresets().length > 0);
  }

  button.addEventListener("click", (event: MouseEvent) => {
    const presets = options.getPresets();
    const menu = new Menu();

    if (presets.length > 0) {
      menu.addItem((item) => item.setTitle("Apply").setDisabled(true).setIsLabel(true));
      for (const preset of presets) {
        menu.addItem((item) =>
          item
            .setTitle(preset.name)
            .setIcon("bookmark")
            .onClick(() => options.onApply(preset)),
        );
      }
      menu.addSeparator();
    }

    menu.addItem((item) =>
      item
        .setTitle("Save current view as…")
        .setIcon("bookmark-plus")
        .onClick(() => {
          new PresetNameModal(
            options.app,
            { heading: "Save this view", submitLabel: "Save" },
            (name) => {
              const next = [...options.getPresets(), makePreset(name, options.getView())];
              options.onChange(next);
              sync();
              new Notice(`Saved view “${name}”`);
            },
          ).open();
        }),
    );

    if (presets.length > 0) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Manage").setDisabled(true).setIsLabel(true));

      for (const preset of presets) {
        menu.addItem((item) =>
          item
            .setTitle(`Overwrite “${preset.name}”`)
            .setIcon("save")
            .onClick(() => {
              const next = options
                .getPresets()
                .map((p) => (p.id === preset.id ? mergeView(p, options.getView()) : p));
              options.onChange(next);
              new Notice(`Updated “${preset.name}”`);
            }),
        );
      }

      for (const preset of presets) {
        menu.addItem((item) =>
          item
            .setTitle(`Rename “${preset.name}”`)
            .setIcon("pencil")
            .onClick(() => {
              new PresetNameModal(
                options.app,
                { heading: "Rename view", initial: preset.name, submitLabel: "Rename" },
                (name) => {
                  const next = options
                    .getPresets()
                    .map((p) => (p.id === preset.id ? { ...p, name } : p));
                  options.onChange(next);
                },
              ).open();
            }),
        );
      }

      for (const preset of presets) {
        menu.addItem((item) =>
          item
            .setTitle(`Delete “${preset.name}”`)
            .setIcon("trash-2")
            .setWarning(true)
            .onClick(() => {
              void confirmAction(options.app, {
                title: "Delete this saved view?",
                message: `“${preset.name}” will be removed. Your titles are not affected.`,
                confirmText: "Delete",
                danger: true,
              }).then((result) => {
                if (!result.confirmed) return;
                options.onChange(options.getPresets().filter((p) => p.id !== preset.id));
                sync();
              });
            }),
        );
      }
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
