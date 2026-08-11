/**
 * The suggestion wizard — "I want a comedy, something like Ace Ventura".
 *
 * Three questions and a list of answers. The questions are in order of how
 * much they narrow: a mood (genres), then optionally a title to be *like*,
 * then the limits worth having (era, rating). Every step is skippable, because
 * a wizard that insists on all three is slower than scrolling.
 *
 * Two things it will not do:
 *
 *   - **Suggest what you already have.** The library's TMDB ids are excluded
 *     before ranking, so a recommendation list is a list of things to get, not
 *     a mirror.
 *   - **Suggest what you already refused.** "Not interested" is persisted; a
 *     dismissal that lasts until the next reload is not an answer.
 *
 * The engine is `services/suggest.ts` and the network is `Integrations` — this
 * file is the shell around them, and holds no ranking logic of its own.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type { GenreOption, MediaType, OverseerrSearchResult, TitleV4 } from "../../types";
import type { Suggestion } from "../../services/suggest";
import type { GuidedQuery, SuggestionResult } from "../../integration";
import { renderPosterPlaceholder } from "../components/posters";

/** What the wizard needs from the outside world. */
export interface SuggestDeps {
  genreOptions(mediaType: MediaType): Promise<GenreOption[]>;
  search(query: string): Promise<OverseerrSearchResult[]>;
  suggest(query: GuidedQuery): Promise<SuggestionResult>;
  /** Library-driven suggestions, for the "surprise me" entry point. */
  fromLibrary(): Promise<SuggestionResult>;
  /** Add a suggestion to the library. Returns the title it created. */
  onAdd(result: OverseerrSearchResult): Promise<TitleV4 | undefined>;
  onRequest?(result: OverseerrSearchResult): void;
  onDismiss(tmdbId: number): void;
}

type Step = "mood" | "like" | "limits" | "results";

/** Eras worth offering. Open-ended at both ends so nothing is unreachable. */
const ERAS: { label: string; fromYear?: number; toYear?: number }[] = [
  { label: "Any era" },
  { label: "This decade", fromYear: 2020 },
  { label: "2010s", fromYear: 2010, toYear: 2019 },
  { label: "2000s", fromYear: 2000, toYear: 2009 },
  { label: "The 90s", fromYear: 1990, toYear: 1999 },
  { label: "Older", toYear: 1989 },
];

const RATINGS: { label: string; min: number }[] = [
  { label: "Any rating", min: 0 },
  { label: "Good (6+)", min: 6 },
  { label: "Great (7+)", min: 7 },
  { label: "Best only (8+)", min: 8 },
];

export class SuggestModal extends Modal {
  private step: Step = "mood";
  private mediaType: MediaType = "movie";
  private genres: GenreOption[] = [];
  private chosenGenres = new Set<number>();
  private seed: { tmdbId: number; title: string } | null = null;
  private era = 0;
  private rating = 0;
  private results: Suggestion[] = [];
  private note = "";
  private loading = false;

  constructor(
    app: App,
    private readonly deps: SuggestDeps,
    /** Skip the questions and open straight on library-based picks. */
    private readonly startFromLibrary = false,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("wl-modal", "wl-suggest-modal");
    if (this.startFromLibrary) {
      this.step = "results";
      void this.runLibrary();
    } else {
      void this.loadGenres();
    }
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async loadGenres(): Promise<void> {
    this.genres = await this.deps.genreOptions(this.mediaType);
    if (this.step === "mood") this.render();
  }

  // -------------------------------------------------------------------------
  // Running the query
  // -------------------------------------------------------------------------

  private currentQuery(): GuidedQuery {
    const era = ERAS[this.era] ?? ERAS[0];
    const query: GuidedQuery = {
      mediaType: this.mediaType,
      genres: [...this.chosenGenres],
      // With both a seed and a mood, the mood is a filter on the seed's
      // answers: "like Ace Ventura" and "a comedy" should not return its
      // thrillers just because the same people liked them.
      strictGenre: this.chosenGenres.size > 0,
      minRating: RATINGS[this.rating]?.min ?? 0,
    };
    if (this.seed) query.seed = this.seed;
    if (era?.fromYear !== undefined) query.fromYear = era.fromYear;
    if (era?.toYear !== undefined) query.toYear = era.toYear;
    return query;
  }

  private async run(): Promise<void> {
    this.step = "results";
    this.loading = true;
    this.render();
    const outcome = await this.deps.suggest(this.currentQuery());
    this.results = outcome.suggestions;
    this.note = outcome.note;
    this.loading = false;
    this.render();
  }

  private async runLibrary(): Promise<void> {
    this.loading = true;
    this.render();
    const outcome = await this.deps.fromLibrary();
    this.results = outcome.suggestions;
    this.note =
      outcome.note ||
      (outcome.seeds && outcome.seeds.length > 0
        ? `Based on ${outcome.seeds.slice(0, 3).join(", ")}${outcome.seeds.length > 3 ? " and more" : ""}.`
        : "");
    this.loading = false;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "wl-suggest-head" });
    head.createEl("h3", { cls: "wl-modal-title", text: this.headline() });
    if (this.step !== "results") {
      head.createDiv({ cls: "wl-suggest-steps", text: this.stepLabel() });
    }

    switch (this.step) {
      case "mood":
        this.renderMood(contentEl);
        break;
      case "like":
        this.renderLike(contentEl);
        break;
      case "limits":
        this.renderLimits(contentEl);
        break;
      case "results":
        this.renderResults(contentEl);
        break;
    }
  }

  private headline(): string {
    if (this.step === "results") return "What about one of these?";
    if (this.step === "mood") return "What are you in the mood for?";
    if (this.step === "like") return "Anything like something you know?";
    return "Any limits?";
  }

  private stepLabel(): string {
    const order: Step[] = ["mood", "like", "limits"];
    return `Step ${order.indexOf(this.step) + 1} of 3 — every step is skippable`;
  }

  private renderMood(parent: HTMLElement): void {
    const types = parent.createDiv({ cls: "wl-suggest-types" });
    for (const [value, label] of [
      ["movie", "Films"],
      ["tv", "TV"],
    ] as [MediaType, string][]) {
      const button = types.createEl("button", {
        cls: `wl-chip-toggle${this.mediaType === value ? " is-active" : ""}`,
        text: label,
        attr: { type: "button" },
      });
      button.addEventListener("click", () => {
        if (this.mediaType === value) return;
        this.mediaType = value;
        this.chosenGenres.clear();
        this.genres = [];
        void this.loadGenres();
        this.render();
      });
    }

    const grid = parent.createDiv({ cls: "wl-suggest-genres" });
    if (this.genres.length === 0) {
      grid.createDiv({ cls: "wl-suggest-empty", text: "Loading genres…" });
    }
    for (const genre of this.genres) {
      const chip = grid.createEl("button", {
        cls: `wl-chip-toggle${this.chosenGenres.has(genre.id) ? " is-active" : ""}`,
        text: genre.name,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        if (this.chosenGenres.has(genre.id)) this.chosenGenres.delete(genre.id);
        else this.chosenGenres.add(genre.id);
        this.render();
      });
    }

    this.renderNav(parent, { next: "like", nextLabel: "Next" });
  }

  private renderLike(parent: HTMLElement): void {
    parent.createDiv({
      cls: "wl-modal-message",
      text: "Name something you liked and the suggestions will lean towards it. Skip if you have nothing in mind.",
    });

    if (this.seed) {
      const chosen = parent.createDiv({ cls: "wl-suggest-seed" });
      chosen.createSpan({ text: `Like ${this.seed.title}` });
      const clear = chosen.createEl("button", {
        cls: "wl-mini-btn",
        text: "Change",
        attr: { type: "button" },
      });
      clear.addEventListener("click", () => {
        this.seed = null;
        this.render();
      });
    } else {
      const search = parent.createEl("input", {
        cls: "wl-suggest-search",
        attr: { type: "text", placeholder: "e.g. Ace Ventura" },
      });
      const hits = parent.createDiv({ cls: "wl-suggest-hits" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      search.addEventListener("input", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void this.searchSeeds(search.value, hits);
        }, 350);
      });
      search.focus();
    }

    this.renderNav(parent, { back: "mood", next: "limits", nextLabel: this.seed ? "Next" : "Skip" });
  }

  private async searchSeeds(query: string, host: HTMLElement): Promise<void> {
    host.empty();
    if (query.trim().length < 2) return;
    host.createDiv({ cls: "wl-suggest-empty", text: "Searching…" });
    const results = await this.deps.search(query);
    host.empty();
    if (results.length === 0) {
      host.createDiv({ cls: "wl-suggest-empty", text: "Nothing found by that name." });
      return;
    }
    for (const result of results.slice(0, 6)) {
      const row = host.createEl("button", { cls: "wl-suggest-hit", attr: { type: "button" } });
      row.createSpan({ cls: "wl-suggest-hit-name", text: result.title });
      if (result.year) row.createSpan({ cls: "wl-suggest-hit-year", text: `${result.year}` });
      row.addEventListener("click", () => {
        this.seed = { tmdbId: result.tmdbId, title: result.title };
        this.mediaType = result.mediaType;
        this.render();
      });
    }
  }

  private renderLimits(parent: HTMLElement): void {
    const eras = parent.createDiv({ cls: "wl-suggest-genres" });
    ERAS.forEach((era, index) => {
      const chip = eras.createEl("button", {
        cls: `wl-chip-toggle${this.era === index ? " is-active" : ""}`,
        text: era.label,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        this.era = index;
        this.render();
      });
    });

    const ratings = parent.createDiv({ cls: "wl-suggest-genres" });
    RATINGS.forEach((rating, index) => {
      const chip = ratings.createEl("button", {
        cls: `wl-chip-toggle${this.rating === index ? " is-active" : ""}`,
        text: rating.label,
        attr: { type: "button" },
      });
      chip.addEventListener("click", () => {
        this.rating = index;
        this.render();
      });
    });

    this.renderNav(parent, { back: "like", run: true, nextLabel: "Show me" });
  }

  private renderResults(parent: HTMLElement): void {
    if (this.loading) {
      parent.createDiv({ cls: "wl-suggest-empty", text: "Asking around…" });
      return;
    }
    if (this.note) parent.createDiv({ cls: "wl-suggest-note", text: this.note });

    if (this.results.length === 0) {
      parent.createDiv({
        cls: "wl-suggest-empty",
        text: "Nothing came back. Widen the era or drop the rating floor.",
      });
    }

    const list = parent.createDiv({ cls: "wl-suggest-results" });
    for (const suggestion of this.results) this.renderResult(list, suggestion);

    const nav = parent.createDiv({ cls: "wl-modal-buttons" });
    const again = nav.createEl("button", {
      cls: "wl-btn",
      text: "Start over",
      attr: { type: "button" },
    });
    again.addEventListener("click", () => {
      this.step = "mood";
      this.seed = null;
      this.results = [];
      this.note = "";
      if (this.genres.length === 0) void this.loadGenres();
      this.render();
    });
    const close = nav.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Done",
      attr: { type: "button" },
    });
    close.addEventListener("click", () => this.close());
  }

  private renderResult(parent: HTMLElement, suggestion: Suggestion): void {
    const { result } = suggestion;
    const row = parent.createDiv({ cls: "wl-suggest-row" });

    const poster = row.createDiv({ cls: "wl-thumb" });
    if (result.posterUrl) {
      const img = poster.createEl("img", { cls: "wl-thumb-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.src = result.posterUrl;
    } else {
      renderPosterPlaceholder(poster, result.title);
    }

    const body = row.createDiv({ cls: "wl-suggest-body" });
    const titleRow = body.createDiv({ cls: "wl-suggest-titlerow" });
    titleRow.createSpan({ cls: "wl-suggest-name", text: result.title });
    if (result.year) titleRow.createSpan({ cls: "wl-suggest-year", text: `${result.year}` });
    if (result.voteAverage > 0) {
      titleRow.createSpan({
        cls: "wl-suggest-score",
        text: `★ ${result.voteAverage.toFixed(1)}`,
      });
    }
    // Always rendered: a row that drops its reason line is a row shorter than
    // the one above it, and the list stops lining up.
    body.createDiv({ cls: "wl-suggest-reason", text: suggestion.reasons[0] ?? "" });
    if (result.overview) {
      body.createDiv({ cls: "wl-suggest-overview", text: result.overview });
    }

    const actions = row.createDiv({ cls: "wl-suggest-actions" });
    const add = actions.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Add",
      attr: { type: "button", title: "Add to your library" },
    });
    add.addEventListener("click", () => {
      add.disabled = true;
      void this.deps
        .onAdd(result)
        .then((title) => {
          new Notice(title ? `Added «${result.title}».` : `Could not add «${result.title}».`);
          if (title) row.addClass("is-added");
        })
        .finally(() => {
          add.disabled = false;
        });
    });

    if (this.deps.onRequest) {
      const request = actions.createEl("button", {
        cls: "wl-btn",
        text: "Request",
        attr: { type: "button", title: "Ask Overseerr for it" },
      });
      request.addEventListener("click", () => this.deps.onRequest?.(result));
    }

    const no = actions.createEl("button", {
      cls: "wl-icon-btn",
      attr: { type: "button", "aria-label": "Not interested", title: "Not interested" },
    });
    setIcon(no, "x");
    no.addEventListener("click", () => {
      this.deps.onDismiss(result.tmdbId);
      this.results = this.results.filter((s) => s.result.tmdbId !== result.tmdbId);
      this.render();
    });
  }

  private renderNav(
    parent: HTMLElement,
    options: { back?: Step; next?: Step; run?: boolean; nextLabel: string },
  ): void {
    const nav = parent.createDiv({ cls: "wl-modal-buttons" });
    if (options.back) {
      const back = nav.createEl("button", {
        cls: "wl-btn",
        text: "Back",
        attr: { type: "button" },
      });
      back.addEventListener("click", () => {
        this.step = options.back as Step;
        this.render();
      });
    }
    const next = nav.createEl("button", {
      cls: "wl-btn mod-cta",
      text: options.nextLabel,
      attr: { type: "button" },
    });
    next.addEventListener("click", () => {
      if (options.run) {
        void this.run();
        return;
      }
      if (options.next) {
        this.step = options.next;
        this.render();
      }
    });
  }
}

export function openSuggestWizard(app: App, deps: SuggestDeps, fromLibrary = false): void {
  new SuggestModal(app, deps, fromLibrary).open();
}
