/**
 * The Games tab's Filters control — the Library's, with games' facets.
 *
 * Every behaviour that makes the Library's panel usable is kept, because they
 * are the ones that are easy to leave out: instant apply with only the disk
 * write debounced, "Start from: Show all / Hide all" so exclusion filtering can
 * be used as inclusion, per-section All/None, chips that toggle their own class
 * instead of rebuilding the panel, and a stated rule that unrated games always
 * pass.
 */
import { setIcon } from "obsidian";
import { SAVE_DEBOUNCE_MS } from "../../constants";
import type { Game, GamesSettings, NamedColor } from "../../types";
import {
  buildGameFacetSections,
  clearGameFilters,
  excludedForGames,
  hideAllGameFacets,
  isGameFacetShown,
  isGameFilterActive,
  setExcludedForGames,
  showAllGameFacets,
  toggleGameFacetValue,
  type GameFacetSection,
  type GameFilterState,
} from "./facets";

export interface GameFiltersOptions {
  state: GameFilterState;
  settings: GamesSettings;
  /** The watchlist's priority list — games reuse the same names (v3 did too). */
  priorities: readonly NamedColor[];
  halfStarRatings: boolean;
  /** The unfiltered pool the options and counts come from. */
  getGames: () => readonly Game[];
  /** Re-render results. Called synchronously on every change. */
  onChange: () => void;
  /** Persist. Debounced here; never called per click. */
  onPersist: () => void;
  panelHost?: HTMLElement;
}

export interface GameFiltersHandle {
  el: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const RATING_STEPS_WHOLE = [0, 1, 2, 3, 4, 5];
const RATING_STEPS_HALF = [0, 1, 2, 3, 3.5, 4, 4.5, 5];

export function createGameFilters(
  parent: HTMLElement,
  options: GameFiltersOptions,
): GameFiltersHandle {
  const wrap = parent.createDiv({ cls: "wl-game-filters" });

  const button = wrap.createEl("button", {
    cls: "wl-btn wl-filters-btn",
    attr: { type: "button", "aria-expanded": "false" },
  });
  setIcon(button.createSpan({ cls: "wl-btn-icon" }), "sliders-horizontal");
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

  function commit(): void {
    options.onChange();
    syncButton();
    schedulePersist();
  }

  function syncButton(): void {
    const active = isGameFilterActive(options.state);
    button.toggleClass("has-active", active);
    dot.toggleClass("is-visible", active);
    clearButton.toggleClass("is-visible", active);
  }

  function sections(): GameFacetSection[] {
    return buildGameFacetSections(
      options.getGames(),
      options.settings,
      options.priorities.map((priority) => priority.name),
    );
  }

  function chipButton(host: HTMLElement, text: string, icon?: string): HTMLElement {
    const chip = host.createEl("button", { cls: "wl-filter-chip", attr: { type: "button" } });
    if (icon) setIcon(chip.createSpan({ cls: "wl-filter-chip-icon" }), icon);
    chip.createSpan({ cls: "wl-filter-chip-text", text });
    return chip;
  }

  function renderPanel(): void {
    panel.empty();
    const built = sections();

    const startFrom = panel.createDiv({ cls: "wl-filter-startfrom" });
    startFrom.createSpan({ cls: "wl-filter-startfrom-label", text: "Start from:" });
    const showAll = startFrom.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Show all",
      attr: { type: "button" },
    });
    showAll.addEventListener("click", () => {
      showAllGameFacets(options.state, built);
      renderPanel();
      commit();
    });
    const hideAll = startFrom.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Hide all",
      attr: { type: "button" },
    });
    hideAll.addEventListener("click", () => {
      hideAllGameFacets(options.state, built);
      renderPanel();
      commit();
    });

    const toggles = panel.createDiv({ cls: "wl-filter-chips" });
    const favChip = chipButton(toggles, "Favourites only", "heart");
    favChip.toggleClass("is-on", options.state.favoritesOnly);
    favChip.addEventListener("click", () => {
      options.state.favoritesOnly = !options.state.favoritesOnly;
      favChip.toggleClass("is-on", options.state.favoritesOnly);
      commit();
    });
    const wishChip = chipButton(toggles, "Wishlist only", "gift");
    wishChip.toggleClass("is-on", options.state.wishlistOnly);
    wishChip.addEventListener("click", () => {
      options.state.wishlistOnly = !options.state.wishlistOnly;
      wishChip.toggleClass("is-on", options.state.wishlistOnly);
      commit();
    });

    renderRatingRow(panel);
    for (const section of built) renderSection(panel, section);

    const footer = panel.createDiv({ cls: "wl-filter-footer" });
    const reset = footer.createEl("button", {
      cls: "wl-btn wl-small-btn",
      text: "Reset — show all",
      attr: { type: "button" },
    });
    reset.addEventListener("click", () => {
      clearGameFilters(options.state);
      renderPanel();
      commit();
    });
  }

  function renderRatingRow(host: HTMLElement): void {
    const section = host.createDiv({ cls: "wl-filter-section" });
    section
      .createDiv({ cls: "wl-filter-section-head" })
      .createSpan({ cls: "wl-filter-section-title", text: "Minimum rating" });
    const row = section.createDiv({ cls: "wl-filter-chips" });
    const steps = options.halfStarRatings ? RATING_STEPS_HALF : RATING_STEPS_WHOLE;
    for (const step of steps) {
      const chip = chipButton(row, step === 0 ? "Any" : `${step}+`);
      chip.toggleClass("is-on", options.state.minRating === step);
      chip.addEventListener("click", () => {
        options.state.minRating = step;
        for (const sibling of Array.from(row.children)) sibling.toggleClass("is-on", sibling === chip);
        commit();
      });
    }
    section.createDiv({ cls: "wl-filter-note", text: "Unrated games are always shown." });
  }

  function renderSection(host: HTMLElement, section: GameFacetSection): void {
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
      chip.toggleClass("is-on", isGameFacetShown(options.state, section.key, option.value));
      chip.addEventListener("click", () => {
        const shown = toggleGameFacetValue(options.state, section.key, option.value);
        chip.toggleClass("is-on", shown);
        commit();
      });
      chips.set(option.value, chip);
    }

    selectAll.addEventListener("click", () => {
      const keep = excludedForGames(options.state, section.key).filter(
        (value) => !section.options.some((option) => option.value === value),
      );
      setExcludedForGames(options.state, section.key, keep);
      for (const chip of chips.values()) chip.addClass("is-on");
      commit();
    });

    deselectAll.addEventListener("click", () => {
      const merged = new Set(excludedForGames(options.state, section.key));
      for (const option of section.options) merged.add(option.value);
      setExcludedForGames(options.state, section.key, [...merged]);
      for (const chip of chips.values()) chip.removeClass("is-on");
      commit();
    });
  }

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
    clearGameFilters(options.state);
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
      if (persistTimer !== null) clearTimeout(persistTimer);
      const doc = wrap.ownerDocument;
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      panel.remove();
      wrap.remove();
    },
  };
}
