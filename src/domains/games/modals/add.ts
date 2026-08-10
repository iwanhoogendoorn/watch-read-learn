/**
 * The Add-game modal — search first, manual always (SPEC2-PARITY.md §D-GAMES).
 *
 * You type a name, IGDB answers with covers, release dates, platforms, genres
 * and the studio, and picking one fills the record in. With no Twitch client ID
 * configured the modal says so once and shows the manual form instead — the
 * whole domain is usable with no keys at all, which is the parity ground rule.
 *
 * Async discipline is the Add-title modal's: a **generation counter** guards
 * every search, so a slow response for "hal" can never overwrite the results for
 * "halo".
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import { createGame } from "../../../data/schema";
import { unixSecondsToDate } from "../../../services/igdb";
import { renderDateInput } from "../../../ui/components/dates";
import { renderPosterPlaceholder } from "../../../ui/components/posters";
import type {
  Game,
  GameSearchResult,
  GamesSettings,
  GamesStoreApi,
  IgdbClient,
  Settings,
} from "../../../types";
import { newGameId } from "../store";
import { isUnreleased } from "../upcoming";
import { GAME_STATUS_TO_BE_RELEASED } from "../stats";

const SEARCH_DEBOUNCE_MS = 300;

export interface AddGameOptions {
  store: GamesStoreApi;
  settings: Settings;
  /** Omit (or pass an unconfigured client) to get the manual form only. */
  client?: IgdbClient;
  onAdded?: (game: Game) => void;
}

// ---------------------------------------------------------------------------
// Pure: an IGDB result becomes a game
// ---------------------------------------------------------------------------

/**
 * The genre to record.
 *
 * IGDB hands back its own taxonomy ("Role-playing (RPG)", "Shooter"); the user
 * has a configured list. A configured name that matches wins, so the colour and
 * the filter chip work straight away, and anything else is kept verbatim rather
 * than dropped — an unconfigured genre still filters, it just has no colour.
 */
export function pickGameGenre(genres: readonly string[], configured: readonly string[]): string {
  // IGDB's own order is a ranking, so the *first* genre wins whether it matches
  // exactly ("Indie") or by name ("Role-playing (RPG)" → "RPG"). Scanning all
  // genres for an exact match first would label Hades "Indie".
  for (const genre of genres) {
    const lower = genre.toLowerCase();
    const exact = configured.find((name) => name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = configured.find((name) => {
      const candidate = name.toLowerCase();
      return lower.includes(candidate) || candidate.includes(lower);
    });
    if (partial) return partial;
  }
  return genres[0] ?? "";
}

/**
 * IGDB's platform names, folded onto the configured ones where they agree.
 *
 * "PC (Microsoft Windows)" and a configured "Windows PC" are the same machine,
 * and a platform facet with both in it is a filter that lies.
 */
export function foldPlatforms(
  platforms: readonly string[],
  configured: readonly string[],
): string[] {
  const words = (value: string): string[] =>
    value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");

  const out: string[] = [];
  for (const platform of platforms) {
    const theirs = new Set(words(platform));
    // A configured name matches when **all** of its words appear in the
    // provider's — "Windows PC" is inside "PC (Microsoft Windows)". The
    // direction matters: the other way round, "Nintendo Switch" from IGDB
    // would be folded into a configured "Nintendo Switch 2", which is a
    // different console.
    const match = configured.find((name) => {
      const ours = words(name);
      return ours.length > 0 && ours.every((word) => theirs.has(word));
    });
    const value = match ?? platform;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export interface BuildGameOptions {
  settings: GamesSettings;
  takenIds: readonly Game[];
  status?: string;
  now?: Date;
}

/** `GameSearchResult` → a complete `Game`. Everything unknown stays `""` / `[]`. */
export function buildGameFromResult(
  result: GameSearchResult,
  options: BuildGameOptions,
): Game {
  const releaseDate = unixSecondsToDate(result.firstReleaseDate);
  const game = createGame({
    id: newGameId(result.title, options.takenIds),
    title: result.title,
    type: pickGameGenre(result.genres, options.settings.types.map((entry) => entry.name)),
    status: options.status ?? options.settings.defaultStatus,
    developer: result.developer ?? "",
    publisher: result.publisher ?? "",
    platforms: foldPlatforms(result.platforms, options.settings.platforms.map((p) => p.name)),
    coverUrl: result.coverUrl,
    apiSource: "igdb",
    apiId: result.id,
    releaseDate,
  });
  // A game that has not come out yet says so, the same way a title does — and
  // this is set at creation, not enforced afterwards, so a status the user
  // changes later stays changed.
  if (options.status === undefined && isUnreleased(game, options.now ?? new Date())) {
    const configured = options.settings.statuses.map((entry) => entry.name);
    game.status = configured.includes(GAME_STATUS_TO_BE_RELEASED)
      ? GAME_STATUS_TO_BE_RELEASED
      : game.status;
  }
  return game;
}

/** Already tracked? IGDB id first, then name. */
export function findExistingGame(
  games: readonly Game[],
  result: { id: string; title: string },
): Game | undefined {
  const byId = games.find((game) => game.apiSource === "igdb" && game.apiId === result.id);
  if (byId) return byId;
  const needle = result.title.trim().toLowerCase();
  return games.find((game) => game.title.trim().toLowerCase() === needle);
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export class AddGameModal extends Modal {
  private store: GamesStoreApi;
  private settings: Settings;
  private client: IgdbClient | undefined;
  private onAdded: ((game: Game) => void) | undefined;

  private resultsEl: HTMLElement | null = null;
  private manualEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;
  private manualOpen = false;

  constructor(app: App, options: AddGameOptions) {
    super(app);
    this.store = options.store;
    this.settings = options.settings;
    this.client = options.client;
    this.onAdded = options.onAdded;
  }

  private get searchable(): boolean {
    return this.client?.configured() === true;
  }

  private get gameSettings(): GamesSettings {
    return this.store.games.settings;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-add-modal", "wl-game-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Add a game" });

    if (this.searchable) this.renderSearch(contentEl);
    else this.renderNoSearchNotice(contentEl);

    this.statusEl = contentEl.createDiv({ cls: "wl-add-status" });
    this.resultsEl = contentEl.createDiv({ cls: "wl-add-results" });
    this.manualEl = contentEl.createDiv({ cls: "wl-add-manual" });

    this.manualOpen = !this.searchable;
    this.renderManualToggle(contentEl);
    this.renderManual();
  }

  override onClose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.contentEl.empty();
  }

  // --- search -------------------------------------------------------------

  private renderSearch(host: HTMLElement): void {
    const wrap = host.createDiv({ cls: "wl-searchbox wl-add-search" });
    setIcon(wrap.createSpan({ cls: "wl-searchbox-icon" }), "search");
    const input = wrap.createEl("input", {
      cls: "wl-searchbox-input",
      attr: {
        type: "search",
        placeholder: "Search IGDB for a game…",
        "aria-label": "Search IGDB for a game",
        spellcheck: "false",
      },
    });

    input.addEventListener("input", () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.runSearch(input.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      void this.runSearch(input.value);
    });

    window.setTimeout(() => input.focus(), 0);
  }

  private renderNoSearchNotice(host: HTMLElement): void {
    const note = host.createDiv({ cls: "wl-add-notice" });
    setIcon(note.createSpan({ cls: "wl-add-notice-icon" }), "info");
    note.createSpan({
      text: "No IGDB credentials configured, so search is off. Settings → Games turns it on with a Twitch client ID and secret; until then, add games by hand.",
    });
  }

  private setStatus(text: string, tone: "" | "error" = ""): void {
    const el = this.statusEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-hidden", text === "");
  }

  private async runSearch(query: string): Promise<void> {
    const client = this.client;
    const results = this.resultsEl;
    if (!client || !results) return;

    const trimmed = query.trim();
    const generation = ++this.searchGeneration;

    if (trimmed === "") {
      results.empty();
      this.setStatus("");
      return;
    }

    this.setStatus("Searching…");
    try {
      const hits = await client.search(trimmed);
      if (generation !== this.searchGeneration) return; // a newer search won
      this.renderResults(hits);
    } catch (error) {
      if (generation !== this.searchGeneration) return;
      results.empty();
      this.setStatus(
        error instanceof Error ? `Search failed — ${error.message}` : "Search failed.",
        "error",
      );
    }
  }

  private renderResults(hits: GameSearchResult[]): void {
    const host = this.resultsEl;
    if (!host) return;
    host.empty();

    if (hits.length === 0) {
      this.setStatus("Nothing found. Try fewer words, or add it by hand below.");
      return;
    }
    this.setStatus("");

    for (const hit of hits) {
      const existing = findExistingGame(this.store.allGames(), hit);
      this.renderResultRow(host, hit, existing);
    }
  }

  private renderResultRow(
    host: HTMLElement,
    hit: GameSearchResult,
    existing: Game | undefined,
  ): void {
    const row = host.createDiv({ cls: "wl-add-result" });
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.toggleClass("is-disabled", existing !== undefined);

    const coverWrap = row.createDiv({ cls: "wl-add-result-poster" });
    const cover = coverWrap.createDiv({ cls: "wl-poster" });
    cover.dataset.posterSeed = hit.title;
    if (hit.coverUrl) {
      const img = cover.createEl("img", { cls: "wl-poster-img is-loaded" });
      img.setAttribute("alt", "");
      img.setAttribute("decoding", "async");
      img.src = hit.coverUrl;
    } else {
      renderPosterPlaceholder(cover, hit.title);
    }

    const body = row.createDiv({ cls: "wl-add-result-body" });
    body.createDiv({ cls: "wl-add-result-title", text: hit.title });

    const meta: string[] = [];
    const released = unixSecondsToDate(hit.firstReleaseDate);
    if (released) meta.push(released.slice(0, 4));
    if (hit.genres.length > 0) meta.push(hit.genres.slice(0, 2).join(", "));
    if (hit.developer) meta.push(hit.developer);
    if (typeof hit.rating === "number" && hit.rating > 0) meta.push(`★ ${hit.rating.toFixed(1)}`);
    body.createDiv({ cls: "wl-add-result-meta", text: meta.join(" · ") });
    if (hit.platforms.length > 0) {
      body.createDiv({ cls: "wl-add-result-meta", text: hit.platforms.slice(0, 4).join(" · ") });
    }
    if (hit.summary) {
      body.createDiv({ cls: "wl-add-result-overview", text: hit.summary });
    }

    if (existing) {
      const flags = row.createDiv({ cls: "wl-add-result-flags" });
      flags.createSpan({ cls: "wl-flag is-tracked", text: "Already tracked" });
    }

    const pick = (): void => {
      if (existing) {
        new Notice(`“${existing.title}” is already in your games.`);
        return;
      }
      this.addFromResult(hit);
    };
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      pick();
    });
  }

  private addFromResult(hit: GameSearchResult): void {
    const game = buildGameFromResult(hit, {
      settings: this.gameSettings,
      takenIds: this.store.allGames(),
    });
    this.store.addGame(game);
    new Notice(`Added “${game.title}”`);
    this.onAdded?.(game);
    this.close();
  }

  // --- manual -------------------------------------------------------------

  private renderManualToggle(host: HTMLElement): void {
    if (!this.searchable) return;
    const toggle = host.createEl("button", {
      cls: "wl-link-btn wl-add-manual-toggle",
      text: this.manualOpen ? "Hide manual entry" : "Add it by hand instead",
      attr: { type: "button" },
    });
    toggle.addEventListener("click", () => {
      this.manualOpen = !this.manualOpen;
      toggle.setText(this.manualOpen ? "Hide manual entry" : "Add it by hand instead");
      this.renderManual();
    });
  }

  private renderManual(): void {
    const host = this.manualEl;
    if (!host) return;
    host.empty();
    host.toggleClass("is-hidden", !this.manualOpen);
    if (!this.manualOpen) return;

    const settings = this.gameSettings;
    const grid = host.createDiv({ cls: "wl-field-grid" });

    const nameField = grid.createDiv({ cls: "wl-field" });
    nameField.createDiv({ cls: "wl-field-label", text: "Title" });
    const nameInput = nameField.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", "aria-label": "Title" },
    });
    const nameMsg = nameField.createDiv({ cls: "wl-field-msg" });

    const genreField = grid.createDiv({ cls: "wl-field" });
    genreField.createDiv({ cls: "wl-field-label", text: "Genre" });
    const genreSelect = genreField.createEl("select", { cls: "wl-select" });
    genreSelect.setAttribute("aria-label", "Genre");
    genreSelect.createEl("option", { value: "", text: "—" });
    for (const type of settings.types) {
      genreSelect.createEl("option", { value: type.name, text: type.name });
    }

    const statusField = grid.createDiv({ cls: "wl-field" });
    statusField.createDiv({ cls: "wl-field-label", text: "Status" });
    const statusSelect = statusField.createEl("select", { cls: "wl-select" });
    statusSelect.setAttribute("aria-label", "Status");
    for (const status of settings.statuses) {
      statusSelect.createEl("option", { value: status.name, text: status.name });
    }
    statusSelect.value = settings.defaultStatus;

    const platformField = grid.createDiv({ cls: "wl-field" });
    platformField.createDiv({ cls: "wl-field-label", text: "Platform" });
    const platformSelect = platformField.createEl("select", { cls: "wl-select" });
    platformSelect.setAttribute("aria-label", "Platform");
    platformSelect.createEl("option", { value: "", text: "—" });
    for (const platform of settings.platforms) {
      platformSelect.createEl("option", { value: platform.name, text: platform.name });
    }

    const dateField = grid.createDiv({ cls: "wl-field" });
    dateField.createDiv({ cls: "wl-field-label", text: "Release date" });
    let releaseDate: string | null = null;
    // The user's own date format, not the host locale's picker.
    renderDateInput(dateField, {
      format: this.settings.dateFormat,
      label: "Release date",
      value: null,
      messageHost: dateField,
      onCommit: (value) => {
        releaseDate = value;
      },
    });

    const wishlistField = grid.createDiv({ cls: "wl-field" });
    wishlistField.createDiv({ cls: "wl-field-label", text: "Wishlist" });
    const wishlistInput = wishlistField.createEl("input", {
      cls: "wl-checkbox",
      attr: { type: "checkbox", "aria-label": "On my wishlist" },
    });

    const buttons = host.createDiv({ cls: "wl-modal-buttons" });
    const submit = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Add game",
      attr: { type: "button" },
    });

    const commit = (): void => {
      const name = nameInput.value.trim();
      if (name === "") {
        // Inline field validation, never a Notice wall.
        nameMsg.setText("A game needs a name.");
        nameInput.focus();
        return;
      }
      const platform = platformSelect.value;
      const game = createGame({
        id: newGameId(name, this.store.allGames()),
        title: name,
        type: genreSelect.value,
        status: statusSelect.value,
        platforms: platform === "" ? [] : [platform],
        wishlist: wishlistInput.checked,
        releaseDate,
      });
      this.store.addGame(game);
      new Notice(`Added “${game.title}”`);
      this.onAdded?.(game);
      this.close();
    };

    nameInput.addEventListener("input", () => nameMsg.setText(""));
    nameInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    submit.addEventListener("click", commit);
  }
}
