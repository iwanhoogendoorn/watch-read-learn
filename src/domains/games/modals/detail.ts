/**
 * The game detail / edit modal.
 *
 * One modal, not two: a header that shows where you are with the game, and the
 * fields that change it directly underneath. Every edit is applied the moment it
 * is made (there is no Save button and no cancel) — the same instant-apply rule
 * the filter panel and the star ratings already follow, with only the disk write
 * debounced by the store.
 *
 * The unit conversions live here rather than in the record: `playtimeMinutes` is
 * what v3 stores and what v4 keeps storing, but a person types hours, so the
 * field takes `12h 30m`, `12.5`, `750m` and hands the store minutes.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import { renderDateInput } from "../../../ui/components/dates";
import { renderPosterPlaceholder } from "../../../ui/components/posters";
import { colorFor, renderPill } from "../../../ui/components/pills";
import { createStars } from "../../../ui/components/stars";
import type { Game, GamePatch, GamesStoreApi, Settings } from "../../../types";
import {
  achievementPercent,
  achievementText,
  formatPlaytime,
  gameProgress,
} from "../stats";

export interface GameDetailOptions {
  store: GamesStoreApi;
  settings: Settings;
  gameId: string;
  onOpenNote?: (game: Game) => void;
  onDelete?: (game: Game) => void;
  /** Chip → filtered list handoff. */
  onJumpToQuery?: (query: string) => void;
}

// ---------------------------------------------------------------------------
// Pure: the playtime field
// ---------------------------------------------------------------------------

/**
 * Parse what a person types into minutes.
 *
 * Accepts `90m`, `1h`, `1h 30m`, `1:30`, `1.5` and a bare `90` (hours, because
 * that is what the field says it wants). `null` means "that is not a duration"
 * and the field refuses it rather than storing a zero.
 */
export function parsePlaytime(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return 0;

  const hm = /^(\d+)\s*h(?:ours?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(text);
  if (hm) {
    const hours = Number(hm[1] ?? 0);
    const minutes = Number(hm[2] ?? 0);
    return Math.round(hours * 60 + minutes);
  }

  const minutesOnly = /^(\d+)\s*m(?:in(?:ute)?s?)?$/.exec(text);
  if (minutesOnly) return Math.round(Number(minutesOnly[1] ?? 0));

  const clock = /^(\d+):([0-5]\d)$/.exec(text);
  if (clock) return Math.round(Number(clock[1] ?? 0) * 60 + Number(clock[2] ?? 0));

  const decimal = /^(\d+(?:[.,]\d+)?)$/.exec(text);
  if (decimal) {
    const hours = Number((decimal[1] ?? "0").replace(",", "."));
    if (!Number.isFinite(hours)) return null;
    return Math.round(hours * 60);
  }

  return null;
}

/** What the playtime field shows: hours and minutes, never a raw 4210. */
export function playtimeFieldValue(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "";
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export class GameDetailModal extends Modal {
  private store: GamesStoreApi;
  private settings: Settings;
  private gameId: string;
  private options: GameDetailOptions;

  constructor(app: App, options: GameDetailOptions) {
    super(app);
    this.store = options.store;
    this.settings = options.settings;
    this.gameId = options.gameId;
    this.options = options;
  }

  private get game(): Game | undefined {
    return this.store.getGame(this.gameId);
  }

  private update(patch: GamePatch, reason: string): void {
    this.store.updateGame(this.gameId, patch, reason);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-detail-modal", "wl-game-modal");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const game = this.game;
    if (!game) {
      contentEl.createDiv({ cls: "wl-modal-message", text: "That game is no longer in your library." });
      return;
    }

    this.renderHeader(contentEl, game);
    this.renderStats(contentEl, game);
    this.renderFields(contentEl, game);
    this.renderFooter(contentEl, game);
  }

  private renderHeader(host: HTMLElement, game: Game): void {
    const head = host.createDiv({ cls: "wl-game-detail-head" });

    const coverWrap = head.createDiv({ cls: "wl-game-detail-cover" });
    const cover = coverWrap.createDiv({ cls: "wl-poster" });
    cover.dataset.posterSeed = game.title;
    if (game.coverUrl) {
      const img = cover.createEl("img", { cls: "wl-poster-img is-loaded" });
      img.setAttribute("alt", "");
      img.src = game.coverUrl;
    } else {
      renderPosterPlaceholder(cover, game.title);
    }

    const body = head.createDiv({ cls: "wl-game-detail-headbody" });
    body.createEl("h3", { cls: "wl-modal-title", text: game.title });

    const pills = body.createDiv({ cls: "wl-game-card-pills" });
    const gameSettings = this.store.games.settings;
    if (game.type) {
      const pill = renderPill(pills, {
        text: game.type,
        color: colorFor(gameSettings.types, game.type),
        cls: "is-type",
      });
      this.makeJumpable(pill, `genre:"${game.type}"`);
    }
    if (game.status) {
      renderPill(pills, {
        text: game.status,
        color: colorFor(gameSettings.statuses, game.status),
        cls: "is-status",
      });
    }
    if (game.wishlist) renderPill(pills, { text: "Wishlist", cls: "is-status" });
    for (const platform of game.platforms ?? []) {
      const pill = renderPill(pills, { text: platform, cls: "is-platform" });
      this.makeJumpable(pill, `platform:"${platform}"`);
    }

    const credits = [game.developer, game.publisher].filter((value) => value.trim() !== "");
    if (credits.length > 0) {
      body.createDiv({ cls: "wl-game-card-meta", text: [...new Set(credits)].join(" · ") });
    }

    createStars(body, {
      value: game.rating,
      tiers: this.settings.ratingSystem,
      allowHalf: this.settings.halfStarRatings,
      showTierLabel: true,
      ariaLabel: `${game.title} rating`,
      onChange: (value) => {
        this.update({ rating: value }, "game-rated");
      },
    });
  }

  private makeJumpable(el: HTMLElement, query: string): void {
    if (!this.options.onJumpToQuery) return;
    el.addClass("is-clickable");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const fire = (event: Event): void => {
      event.preventDefault();
      this.options.onJumpToQuery?.(query);
      this.close();
    };
    el.addEventListener("click", fire);
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") fire(event);
    });
  }

  private renderStats(host: HTMLElement, game: Game): void {
    const row = host.createDiv({ cls: "wl-game-detail-stats" });

    const stat = (label: string, value: string, title?: string): void => {
      const cell = row.createDiv({ cls: "wl-game-detail-stat" });
      cell.createDiv({ cls: "wl-game-detail-stat-value", text: value });
      cell.createDiv({ cls: "wl-game-detail-stat-label", text: label });
      if (title) cell.setAttribute("title", title);
    };

    stat("Played", formatPlaytime(game.playtimeMinutes), `${game.playtimeMinutes} minutes`);
    const achievements = achievementText(game);
    // Nothing rather than "0 / 0": a game without achievements has none, which
    // is not the same as none earned.
    if (achievements) {
      stat("Achievements", achievements, `${achievementPercent(game) ?? 0}% earned`);
    }
    stat("Progress", `${gameProgress(game)}%`);
    if (game.lastPlayed) stat("Last played", game.lastPlayed);
  }

  private renderFields(host: HTMLElement, game: Game): void {
    const grid = host.createDiv({ cls: "wl-field-grid" });
    const gameSettings = this.store.games.settings;

    // --- title ---
    const titleField = this.field(grid, "Title");
    const titleInput = titleField.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", "aria-label": "Title" },
    });
    titleInput.value = game.title;
    titleInput.addEventListener("change", () => {
      const next = titleInput.value.trim();
      if (next === "" || next === game.title) {
        titleInput.value = game.title;
        return;
      }
      this.update({ title: next }, "game-renamed");
      this.render();
    });

    // --- genre / status / priority ---
    this.selectField(grid, "Genre", gameSettings.types.map((type) => type.name), game.type, true, (value) => {
      this.update({ type: value }, "game-genre");
    });
    this.selectField(
      grid,
      "Status",
      gameSettings.statuses.map((status) => status.name),
      game.status,
      false,
      (value) => {
        this.update({ status: value }, "game-status");
        this.render();
      },
    );
    this.selectField(
      grid,
      "Priority",
      this.settings.priorities.map((priority) => priority.name),
      game.priority,
      true,
      (value) => {
        this.update({ priority: value }, "game-priority");
      },
    );

    // --- playtime ---
    const playField = this.field(grid, "Time played");
    const playInput = playField.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "12h 30m", "aria-label": "Time played, in hours and minutes" },
    });
    playInput.value = playtimeFieldValue(game.playtimeMinutes);
    const playMsg = playField.createDiv({ cls: "wl-field-msg" });
    playInput.addEventListener("change", () => {
      const minutes = parsePlaytime(playInput.value);
      if (minutes === null) {
        playMsg.setText("Try 12h 30m, 90m or 1.5.");
        return;
      }
      playMsg.setText("");
      this.update({ playtimeMinutes: minutes }, "game-playtime");
      playInput.value = playtimeFieldValue(minutes);
      this.render();
    });

    // --- achievements ---
    const achField = this.field(grid, "Achievements");
    const achRow = achField.createDiv({ cls: "wl-game-field-pair" });
    const earnedInput = achRow.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "0", step: "1", "aria-label": "Achievements earned" },
    });
    earnedInput.value = String(game.achievementsEarned);
    achRow.createSpan({ cls: "wl-game-field-sep", text: "/" });
    const totalInput = achRow.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "0", step: "1", "aria-label": "Achievements in total" },
    });
    totalInput.value = String(game.achievementsTotal);
    const commitAchievements = (): void => {
      const earned = Math.max(0, Math.trunc(Number(earnedInput.value) || 0));
      const total = Math.max(0, Math.trunc(Number(totalInput.value) || 0));
      this.update({ achievementsEarned: Math.min(earned, total || earned), achievementsTotal: total }, "game-achievements");
      this.render();
    };
    earnedInput.addEventListener("change", commitAchievements);
    totalInput.addEventListener("change", commitAchievements);

    // --- progress ---
    const progressField = this.field(grid, "Progress (%)");
    const progressInput = progressField.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "0", max: "100", step: "1", "aria-label": "Progress percentage" },
    });
    progressInput.value = String(game.progress);
    progressInput.addEventListener("change", () => {
      const value = Math.max(0, Math.min(100, Math.trunc(Number(progressInput.value) || 0)));
      this.update({ progress: value }, "game-progress");
      this.render();
    });

    // --- platforms ---
    const platformField = this.field(grid, "Platforms");
    const platformChips = platformField.createDiv({ cls: "wl-filter-chips" });
    const known = new Set([
      ...gameSettings.platforms.map((platform) => platform.name),
      ...(game.platforms ?? []),
    ]);
    for (const platform of known) {
      const chip = platformChips.createEl("button", {
        cls: "wl-filter-chip",
        attr: { type: "button" },
      });
      chip.createSpan({ cls: "wl-filter-chip-text", text: platform });
      chip.toggleClass("is-on", (game.platforms ?? []).includes(platform));
      chip.addEventListener("click", () => {
        const current = game.platforms ?? [];
        const next = current.includes(platform)
          ? current.filter((value) => value !== platform)
          : [...current, platform];
        this.update({ platforms: next }, "game-platforms");
        chip.toggleClass("is-on", next.includes(platform));
      });
    }

    // --- modes ---
    const modeField = this.field(grid, "How it plays");
    const modeChips = modeField.createDiv({ cls: "wl-filter-chips" });
    const modes: { label: string; key: "singleplayer" | "coop" | "multiplayer" }[] = [
      { label: "Singleplayer", key: "singleplayer" },
      { label: "Co-op", key: "coop" },
      { label: "Multiplayer", key: "multiplayer" },
    ];
    for (const mode of modes) {
      const chip = modeChips.createEl("button", { cls: "wl-filter-chip", attr: { type: "button" } });
      chip.createSpan({ cls: "wl-filter-chip-text", text: mode.label });
      chip.toggleClass("is-on", game[mode.key]);
      chip.addEventListener("click", () => {
        const next = !game[mode.key];
        this.update({ [mode.key]: next } as GamePatch, "game-modes");
        chip.toggleClass("is-on", next);
      });
    }

    // --- flags ---
    const flagField = this.field(grid, "Flags");
    const flagChips = flagField.createDiv({ cls: "wl-filter-chips" });
    const favChip = flagChips.createEl("button", { cls: "wl-filter-chip", attr: { type: "button" } });
    favChip.createSpan({ cls: "wl-filter-chip-text", text: "Favourite" });
    favChip.toggleClass("is-on", game.favorite);
    favChip.addEventListener("click", () => {
      // No `dateFavorited` here: books and manga carry one in the v3 shape and
      // games do not, and inventing a field on a record that round-trips is how
      // a parity domain stops being parity.
      const favorite = !game.favorite;
      this.update({ favorite }, "game-favorite");
      favChip.toggleClass("is-on", favorite);
    });
    const wishChip = flagChips.createEl("button", { cls: "wl-filter-chip", attr: { type: "button" } });
    wishChip.createSpan({ cls: "wl-filter-chip-text", text: "Wishlist" });
    wishChip.toggleClass("is-on", game.wishlist);
    wishChip.addEventListener("click", () => {
      const wishlist = !game.wishlist;
      this.update({ wishlist }, "game-wishlist");
      wishChip.toggleClass("is-on", wishlist);
    });

    // --- credits ---
    this.textField(grid, "Developer", game.developer, (value) => {
      this.update({ developer: value }, "game-developer");
    });
    this.textField(grid, "Publisher", game.publisher, (value) => {
      this.update({ publisher: value }, "game-publisher");
    });

    // --- dates ---
    this.dateField(grid, "Release date", game.releaseDate, (value) => {
      this.update({ releaseDate: value }, "game-release-date");
      this.render();
    });
    this.dateField(grid, "Started", game.dateStarted, (value) => {
      this.update({ dateStarted: value }, "game-date-started");
    });
    this.dateField(grid, "Finished", game.dateFinished, (value) => {
      this.update({ dateFinished: value }, "game-date-finished");
    });
    this.dateField(grid, "Last played", game.lastPlayed, (value) => {
      this.update({ lastPlayed: value }, "game-last-played");
      this.render();
    });

    // --- links ---
    this.textField(grid, "Store URL", game.storeUrl, (value) => {
      this.update({ storeUrl: value }, "game-store-url");
      this.render();
    });
    this.textField(grid, "Cover URL", game.coverUrl, (value) => {
      this.update({ coverUrl: value }, "game-cover-url");
      this.render();
    });
  }

  private field(grid: HTMLElement, label: string): HTMLElement {
    const field = grid.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: label });
    return field;
  }

  private textField(
    grid: HTMLElement,
    label: string,
    value: string,
    onCommit: (value: string) => void,
  ): void {
    const field = this.field(grid, label);
    const input = field.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", "aria-label": label },
    });
    input.value = value;
    input.addEventListener("change", () => onCommit(input.value.trim()));
  }

  private selectField(
    grid: HTMLElement,
    label: string,
    values: readonly string[],
    current: string,
    allowEmpty: boolean,
    onCommit: (value: string) => void,
  ): void {
    const field = this.field(grid, label);
    const select = field.createEl("select", { cls: "wl-select" });
    select.setAttribute("aria-label", label);
    if (allowEmpty) select.createEl("option", { value: "", text: "—" });
    const all = values.includes(current) || current === "" ? values : [...values, current];
    for (const value of all) select.createEl("option", { value, text: value });
    select.value = current;
    select.addEventListener("change", () => onCommit(select.value));
  }

  private dateField(
    grid: HTMLElement,
    label: string,
    value: string | null,
    onCommit: (value: string | null) => void,
  ): void {
    const field = this.field(grid, label);
    renderDateInput(field, {
      format: this.settings.dateFormat,
      label,
      value,
      messageHost: field,
      onCommit,
    });
  }

  private renderFooter(host: HTMLElement, game: Game): void {
    const buttons = host.createDiv({ cls: "wl-modal-buttons" });

    if (this.options.onOpenNote) {
      const note = buttons.createEl("button", { cls: "wl-btn", attr: { type: "button" } });
      setIcon(note.createSpan({ cls: "wl-btn-icon" }), "file-text");
      note.createSpan({ cls: "wl-btn-label", text: "Open note" });
      note.addEventListener("click", () => this.options.onOpenNote?.(game));
    }

    const store = game.storeUrl.trim() || game.externalLink.trim();
    // Only offered when there is somewhere to go.
    if (store !== "") {
      const link = buttons.createEl("button", { cls: "wl-btn", attr: { type: "button" } });
      setIcon(link.createSpan({ cls: "wl-btn-icon" }), "external-link");
      link.createSpan({ cls: "wl-btn-label", text: "Store page" });
      link.addEventListener("click", () => {
        window.open(store, "_blank");
      });
    }

    if (this.options.onDelete) {
      const remove = buttons.createEl("button", {
        cls: "wl-btn mod-warning",
        attr: { type: "button" },
      });
      setIcon(remove.createSpan({ cls: "wl-btn-icon" }), "trash-2");
      remove.createSpan({ cls: "wl-btn-label", text: "Delete" });
      remove.addEventListener("click", () => {
        this.options.onDelete?.(game);
        this.close();
      });
    }

    const done = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Done",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => {
      new Notice(`Saved “${game.title}”`);
      this.close();
    });
  }
}
