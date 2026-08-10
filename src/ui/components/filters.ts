/**
 * The Filters control: a toolbar button with an active dot, a clear ×, and the
 * facet panel behind it.
 *
 * Behaviour ported from foodspot §2b, and the parts that matter are the ones that
 * are easy to leave out:
 *   - **instant apply** — no Apply button; results re-render on every click and
 *     only the disk write is debounced (600 ms, `SAVE_DEBOUNCE_MS`);
 *   - **Start from: Show all / Hide all** — "hide all" turns the exclusion model
 *     into an inclusion workflow, which is the escape hatch that makes exclusion
 *     filtering bearable on a large facet;
 *   - per-section Select all / Deselect all;
 *   - chips toggle their own class instead of rebuilding the panel, so clicking
 *     through eight facets never flickers;
 *   - `(empty)` is a real chip everywhere, and the minimum-rating row says out
 *     loud that unrated titles always pass.
 *
 * ## Two layers
 *
 * `createFacetPanel` is all of the above over **anything** — it knows about
 * sections of chips, single-choice rows and boolean toggles, and nothing about
 * titles. `createFiltersControl` is the Library's adapter onto it: `FilterState`,
 * `buildFacetSections`, the rating row. A surface with different facets (the
 * Upcoming tab's domain / event kind / state / time window) writes its own
 * adapter of a dozen lines instead of a second copy of the panel.
 */
import { setIcon } from "obsidian";
import { SAVE_DEBOUNCE_MS } from "../../constants";
import type { FilterState, Settings, TitleV4 } from "../../types";
import {
  buildFacetSections,
  clearFilters,
  excludedFor,
  isFilterActive,
  setExcludedFor,
  type FacetKey,
} from "./facets";

// ---------------------------------------------------------------------------
// The generic panel
// ---------------------------------------------------------------------------

/** One chip row of excludable values. */
export interface FacetPanelSection {
  key: string;
  label: string;
  options: { value: string; label: string; count: number }[];
}

/** A boolean chip that stands on its own (favourites, wishlist). */
export interface FacetPanelToggle {
  label: string;
  icon?: string;
  get(): boolean;
  set(on: boolean): void;
}

/**
 * A pick-exactly-one row — minimum rating, time window.
 *
 * Not an exclusion list: these are ordinal, and "3+ and 5+ but not 4+" is not a
 * thing anybody means.
 */
export interface FacetPanelChoice {
  label: string;
  options: { value: string; label: string }[];
  get(): string;
  set(value: string): void;
  /** A rule that is surprising unless stated ("Unrated titles are always shown."). */
  note?: string;
}

export interface FacetPanelOptions {
  /** Rebuilt on every open, so the counts are of the live pool. */
  sections: () => FacetPanelSection[];
  excludedFor: (key: string) => string[];
  setExcludedFor: (key: string, values: string[]) => void;
  toggles?: () => FacetPanelToggle[];
  choices?: () => FacetPanelChoice[];
  /** Drives the dot and the × — "is anything being narrowed at all". */
  isActive: () => boolean;
  /** Reset everything this panel owns, in place. */
  clear: () => void;
  /** Re-render results. Called synchronously on every change. */
  onChange: () => void;
  /** Persist. Debounced by this component; never called per click. */
  onPersist: () => void;
  /** Render the panel here instead of inline under the button (drawer form). */
  panelHost?: HTMLElement;
  /** Extra class on the wrapper, for a tab that styles its own toolbar slot. */
  cls?: string;
}

export interface FiltersControlHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createFacetPanel(
  parent: HTMLElement,
  options: FacetPanelOptions,
): FiltersControlHandle {
  const wrap = parent.createDiv({ cls: `wl-filters ${options.cls ?? ""}`.trim() });

  const button = wrap.createEl("button", {
    cls: "wl-btn wl-filters-btn",
    attr: { type: "button", "aria-expanded": "false" },
  });
  const buttonIcon = button.createSpan({ cls: "wl-btn-icon" });
  setIcon(buttonIcon, "sliders-horizontal");
  button.createSpan({ cls: "wl-btn-label", text: "Filters" });
  const dot = button.createSpan({ cls: "wl-filters-dot" });

  const clearButton = wrap.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-filters-clear",
    attr: { type: "button", "aria-label": "Clear all filters", title: "Clear all filters" },
  });
  setIcon(clearButton, "x");

  const panel = (options.panelHost ?? wrap).createDiv({
    cls: options.panelHost ? "wl-filter-panel wl-filter-drawer" : "wl-filter-panel",
  });
  panel.addClass("is-hidden");

  let open = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      options.onPersist();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Instant apply, debounced persist — never the other way round. */
  function commit(): void {
    options.onChange();
    syncButton();
    schedulePersist();
  }

  function syncButton(): void {
    const active = options.isActive();
    button.toggleClass("has-active", active);
    dot.toggleClass("is-visible", active);
    clearButton.toggleClass("is-visible", active);
  }

  // --- panel body ---------------------------------------------------------

  function renderPanel(): void {
    panel.empty();
    const sections = options.sections();

    renderStartFrom(panel, sections);
    renderToggles(panel);
    for (const choice of options.choices?.() ?? []) renderChoiceRow(panel, choice);
    for (const section of sections) renderSection(panel, section);

    const footer = panel.createDiv({ cls: "wl-filter-footer" });
    const reset = footer.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Reset — show all",
      attr: { type: "button" },
    });
    reset.addEventListener("click", () => {
      options.clear();
      renderPanel();
      commit();
    });
  }

  function renderStartFrom(host: HTMLElement, sections: FacetPanelSection[]): void {
    const row = host.createDiv({ cls: "wl-filter-startfrom" });
    row.createSpan({ cls: "wl-filter-startfrom-label", text: "Start from:" });
    const showAll = row.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Show all",
      attr: { type: "button" },
    });
    showAll.addEventListener("click", () => {
      for (const section of sections) options.setExcludedFor(section.key, []);
      renderPanel();
      commit();
    });
    const hideAll = row.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Hide all",
      attr: { type: "button" },
    });
    hideAll.addEventListener("click", () => {
      for (const section of sections) {
        options.setExcludedFor(
          section.key,
          section.options.map((o) => o.value),
        );
      }
      renderPanel();
      commit();
    });
  }

  function renderToggles(host: HTMLElement): void {
    const toggles = options.toggles?.() ?? [];
    if (toggles.length === 0) return;
    const row = host.createDiv({ cls: "wl-filter-chips" });
    for (const toggle of toggles) {
      const chip = chipButton(row, toggle.label, toggle.icon);
      chip.toggleClass("is-on", toggle.get());
      chip.addEventListener("click", () => {
        const next = !toggle.get();
        toggle.set(next);
        chip.toggleClass("is-on", next);
        commit();
      });
    }
  }

  function renderChoiceRow(host: HTMLElement, choice: FacetPanelChoice): void {
    const section = host.createDiv({ cls: "wl-filter-section" });
    section.createDiv({ cls: "wl-filter-section-head" }).createSpan({
      cls: "wl-filter-section-title",
      text: choice.label,
    });
    const row = section.createDiv({ cls: "wl-filter-chips" });
    for (const option of choice.options) {
      const chip = chipButton(row, option.label);
      chip.toggleClass("is-on", choice.get() === option.value);
      chip.addEventListener("click", () => {
        choice.set(option.value);
        for (const sibling of Array.from(row.children)) {
          sibling.toggleClass("is-on", sibling === chip);
        }
        commit();
      });
    }
    // Stating this is part of the pattern — the rule is surprising otherwise.
    if (choice.note) section.createDiv({ cls: "wl-filter-note", text: choice.note });
  }

  function renderSection(host: HTMLElement, section: FacetPanelSection): void {
    if (section.options.length === 0) return;
    const el = host.createDiv({ cls: "wl-filter-section" });
    const head = el.createDiv({ cls: "wl-filter-section-head" });
    head.createSpan({ cls: "wl-filter-section-title", text: section.label });

    const tools = head.createDiv({ cls: "wl-filter-section-tools" });
    const selectAll = tools.createEl("button", {
      cls: "wl-link-btn",
      text: "All",
      attr: { type: "button", title: `Show every ${section.label.toLowerCase()}` },
    });
    const deselectAll = tools.createEl("button", {
      cls: "wl-link-btn",
      text: "None",
      attr: { type: "button", title: `Hide every ${section.label.toLowerCase()}` },
    });

    const row = el.createDiv({ cls: "wl-filter-chips" });
    const chips = new Map<string, HTMLElement>();

    for (const option of section.options) {
      const chip = chipButton(row, option.label, "check");
      chip.createSpan({ cls: "wl-filter-chip-count", text: String(option.count) });
      chip.toggleClass("is-on", !options.excludedFor(section.key).includes(option.value));
      chip.addEventListener("click", () => {
        const excluded = options.excludedFor(section.key);
        const shown = excluded.includes(option.value);
        options.setExcludedFor(
          section.key,
          shown ? excluded.filter((v) => v !== option.value) : [...excluded, option.value],
        );
        chip.toggleClass("is-on", shown);
        commit();
      });
      chips.set(option.value, chip);
    }

    selectAll.addEventListener("click", () => {
      const keep = options
        .excludedFor(section.key)
        .filter((v) => !section.options.some((o) => o.value === v));
      options.setExcludedFor(section.key, keep);
      for (const chip of chips.values()) chip.addClass("is-on");
      commit();
    });

    deselectAll.addEventListener("click", () => {
      const merged = new Set(options.excludedFor(section.key));
      for (const option of section.options) merged.add(option.value);
      options.setExcludedFor(section.key, [...merged]);
      for (const chip of chips.values()) chip.removeClass("is-on");
      commit();
    });
  }

  function chipButton(parentEl: HTMLElement, text: string, icon?: string): HTMLElement {
    const chip = parentEl.createEl("button", {
      cls: "wl-filter-chip",
      attr: { type: "button" },
    });
    if (icon) {
      const iconEl = chip.createSpan({ cls: "wl-filter-chip-icon" });
      setIcon(iconEl, icon);
    }
    chip.createSpan({ cls: "wl-filter-chip-text", text });
    return chip;
  }

  // --- open / close -------------------------------------------------------

  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (wrap.contains(target) || panel.contains(target)) return;
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") setOpen(false);
  };

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    panel.toggleClass("is-hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    button.toggleClass("is-open", open);
    const doc = wrap.ownerDocument;
    if (open) {
      renderPanel();
      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("keydown", onKeyDown, true);
    } else {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    }
  }

  button.addEventListener("click", () => setOpen(!open));
  clearButton.addEventListener("click", () => {
    options.clear();
    if (open) renderPanel();
    commit();
  });

  syncButton();

  return {
    el: wrap,
    refresh(): void {
      syncButton();
      if (open) renderPanel();
    },
    destroy(): void {
      // Flush rather than drop: a filter changed a moment before the tab is
      // torn down is still a change the user made, and a pending save that is
      // simply cancelled is a setting silently lost.
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
        options.onPersist();
      }
      const doc = wrap.ownerDocument;
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      panel.remove();
      wrap.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// The Library's adapter
// ---------------------------------------------------------------------------

export interface FiltersControlOptions {
  state: FilterState;
  settings: Settings;
  /** The unfiltered pool the facet options and counts are derived from. */
  getTitles: () => readonly TitleV4[];
  /** Re-render results. Called synchronously on every change. */
  onChange: () => void;
  /** Persist settings. Debounced by this component; never call it per keystroke. */
  onPersist: () => void;
  /** Render the panel here instead of inline under the button (drawer form). */
  panelHost?: HTMLElement;
}

const RATING_STEPS_WHOLE = [0, 1, 2, 3, 4, 5];
const RATING_STEPS_HALF = [0, 1, 2, 3, 3.5, 4, 4.5, 5];

export function createFiltersControl(
  parent: HTMLElement,
  options: FiltersControlOptions,
): FiltersControlHandle {
  const ratingSteps = (): number[] =>
    options.settings.halfStarRatings ? RATING_STEPS_HALF : RATING_STEPS_WHOLE;

  return createFacetPanel(parent, {
    sections: () =>
      buildFacetSections(options.getTitles(), options.settings).map((section) => ({
        key: section.key,
        label: section.label,
        options: section.options,
      })),
    // Every value written back originates from this section list, so the key is
    // always one of the nine `FacetKey`s the state knows.
    excludedFor: (key) => excludedFor(options.state, key as FacetKey),
    setExcludedFor: (key, values) => setExcludedFor(options.state, key as FacetKey, values),
    toggles: () => [
      {
        label: "Favourites only",
        icon: "heart",
        get: () => options.state.favoritesOnly,
        set: (on) => {
          options.state.favoritesOnly = on;
        },
      },
    ],
    choices: () => [
      {
        label: "Minimum rating",
        options: ratingSteps().map((step) => ({
          value: String(step),
          label: step === 0 ? "Any" : `${step}+`,
        })),
        get: () => String(options.state.minRating),
        set: (value) => {
          options.state.minRating = Number(value);
        },
        note: "Unrated titles are always shown.",
      },
    ],
    isActive: () => isFilterActive(options.state),
    clear: () => clearFilters(options.state),
    onChange: options.onChange,
    onPersist: options.onPersist,
    ...(options.panelHost ? { panelHost: options.panelHost } : {}),
  });
}
