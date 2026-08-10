/**
 * The anime add-flow modal (SPEC2 D-ANIME).
 *
 * Deliberately the *same* modal as the video one, wearing the same classes and
 * the same async discipline — a debounce plus a generation counter, so a slow
 * answer for "frier" can never overwrite the results for "frieren". What differs
 * is only where the results come from and what a row says about itself: an anime
 * row shows the format and the cour (`TV · Fall 2023 · 28 eps`) because "Movie
 * or TV" is not the distinction that matters in this catalogue.
 *
 * It creates **no new CSS classes**. Every element reuses the add-modal styling
 * that already exists, which keeps the one-class-one-component invariant
 * (`tests/styles.test.ts`) intact without a `93-anime.css` that would only
 * restate `60-modals.css`.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import { STATUS_PLAN_TO_WATCH } from "../../constants";
import { animeTypeNames, TYPE_ANIME, type RoutingSettings } from "../../services/typeroute";
import { renderProviderResult, type ResultFlag } from "../../ui/components/results";
import type { OverseerrSearchResult, TitleV4, WatchLogStoreApi } from "../../types";
import { describeAnimeApiError, isAnimeApiError } from "./errors";
import {
  buildTitleFromAnime,
  findExistingAnime,
  type AnimeEntry,
  type AnimeSearchService,
} from "./search";

const SEARCH_DEBOUNCE_MS = 300;

export interface AnimeAddModalOptions {
  store: WatchLogStoreApi;
  search: AnimeSearchService;
  /** Pre-selected type name; defaults to the user's first anime type. */
  type?: string;
  onAdded?: (title: TitleV4) => void;
}

/** Human format labels. `TV_SHORT` is a real AniList value and reads badly raw. */
const FORMAT_LABELS: Record<string, string> = {
  TV: "TV",
  TV_SHORT: "TV short",
  MOVIE: "Movie",
  OVA: "OVA",
  ONA: "ONA",
  SPECIAL: "Special",
  MUSIC: "Music video",
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format.toUpperCase()] ?? format;
}

/** `Fall 2023`, or just the year when the catalogue has no cour. */
export function seasonLabel(entry: AnimeEntry): string {
  const year = entry.seasonYear;
  if (entry.season && year) {
    return `${entry.season.charAt(0).toUpperCase()}${entry.season.slice(1)} ${year}`;
  }
  return year ? String(year) : "";
}

/**
 * The type an anime is added as.
 *
 * The user's own anime types come first (someone tracking "Donghua" separately
 * meant it), then the built-in `Anime`, then whatever type exists at all — a
 * title has to be *some* type, and refusing to add one because the type list was
 * renamed would be theatre.
 */
export function animeTypeFor(
  settings: RoutingSettings & { types: { name: string }[]; lastAddedType: string },
): string {
  const anime = animeTypeNames(settings.types, settings);
  if (anime.includes(settings.lastAddedType)) return settings.lastAddedType;
  if (anime.length > 0) return anime[0] as string;
  const names = settings.types.map((t) => t.name);
  return names.includes(TYPE_ANIME) ? TYPE_ANIME : (names[0] ?? TYPE_ANIME);
}

/**
 * An anime entry in the shape the shared result renderer reads.
 *
 * The renderer wants an `OverseerrSearchResult`; the two facts it would get
 * wrong for anime — `mediaType`, which it prints as "TV"/"Movie", and `tmdbId`,
 * which anime rarely have — are handled by overwriting the meta line afterwards
 * and by never using the id. Reusing the renderer is what keeps the two add
 * flows looking identical.
 */
export function resultViewFor(entry: AnimeEntry): OverseerrSearchResult {
  return {
    tmdbId: entry.tmdb?.tmdbId ?? 0,
    mediaType: entry.mediaType,
    title: entry.title,
    year: entry.seasonYear ?? null,
    releaseDate: entry.startDate,
    overview: entry.description,
    posterUrl: entry.coverUrl,
    voteAverage: entry.score,
    voteCount: 0,
    genreIds: [],
  };
}

/** `TV · Fall 2023 · 28 eps · ★ 8.6` — the anime meta line. */
export function metaLineFor(entry: AnimeEntry): string {
  const parts = [formatLabel(entry.format)];
  const season = seasonLabel(entry);
  if (season) parts.push(season);
  if (entry.episodes !== undefined && entry.episodes > 0) parts.push(`${entry.episodes} eps`);
  if (entry.status === "RELEASING") parts.push("airing");
  if (entry.score > 0) parts.push(`★ ${entry.score.toFixed(1)}`);
  return parts.join(" · ");
}

export class AnimeAddModal extends Modal {
  private store: WatchLogStoreApi;
  private searchService: AnimeSearchService;
  private type: string | undefined;
  private onAdded: ((title: TitleV4) => void) | undefined;

  private resultsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;

  constructor(app: App, options: AnimeAddModalOptions) {
    super(app);
    this.store = options.store;
    this.searchService = options.search;
    this.type = options.type;
    this.onAdded = options.onAdded;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-add-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Add an anime" });

    const wrap = contentEl.createDiv({ cls: "wl-searchbox wl-add-search" });
    setIcon(wrap.createSpan({ cls: "wl-searchbox-icon" }), "search");
    const input = wrap.createEl("input", {
      cls: "wl-searchbox-input",
      attr: {
        type: "search",
        placeholder: "Search AniList for an anime…",
        "aria-label": "Search for an anime",
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

    this.statusEl = contentEl.createDiv({ cls: "wl-add-status" });
    this.resultsEl = contentEl.createDiv({ cls: "wl-add-results" });

    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.contentEl.empty();
  }

  private setStatus(text: string, tone: "" | "error" = ""): void {
    const el = this.statusEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-hidden", text === "");
  }

  private async runSearch(query: string): Promise<void> {
    const results = this.resultsEl;
    if (!results) return;

    const trimmed = query.trim();
    const generation = ++this.searchGeneration;

    if (trimmed === "") {
      results.empty();
      this.setStatus("");
      return;
    }

    this.setStatus("Searching…");
    try {
      const outcome = await this.searchService.search(trimmed);
      if (generation !== this.searchGeneration) return;
      this.renderResults(outcome.entries);
      if (outcome.fellBackFrom && outcome.entries.length > 0) {
        // Say which catalogue answered. The ids differ between them, and a user
        // who set AniList as primary deserves to know they got MAL data.
        const from = outcome.fellBackFrom.provider === "anilist" ? "AniList" : "Jikan";
        const to = outcome.provider === "anilist" ? "AniList" : "Jikan";
        this.setStatus(`${from} did not answer — these results are from ${to}.`);
      }
    } catch (error) {
      if (generation !== this.searchGeneration) return;
      results.empty();
      this.setStatus(
        isAnimeApiError(error)
          ? `Search failed — ${describeAnimeApiError(error)}`
          : error instanceof Error
            ? `Search failed — ${error.message}`
            : "Search failed.",
        "error",
      );
    }
  }

  private renderResults(entries: AnimeEntry[]): void {
    const host = this.resultsEl;
    if (!host) return;
    host.empty();

    if (entries.length === 0) {
      this.setStatus("Nothing found. Try the romaji title, or fewer words.");
      return;
    }
    this.setStatus("");

    const titles = this.store.allTitles();
    for (const entry of entries) {
      const existing = findExistingAnime(titles, entry);
      const flags: ResultFlag[] = [];
      if (entry.provider === "jikan") flags.push({ text: "MyAnimeList" });
      if (existing) flags.push({ text: "Already tracked", cls: "is-tracked" });

      const row = renderProviderResult(host, resultViewFor(entry), {
        flags,
        disabled: existing !== undefined,
        onPick: () => {
          if (existing) {
            new Notice(`“${existing.title}” is already in your library.`);
            return;
          }
          void this.addEntry(entry);
        },
      });

      // The shared renderer prints "TV"/"Movie"; anime wants format and cour.
      const meta = row.querySelector(".wl-add-result-meta");
      if (meta) meta.textContent = metaLineFor(entry);
    }
  }

  private async addEntry(entry: AnimeEntry): Promise<void> {
    this.setStatus(`Fetching “${entry.title}”…`);
    try {
      const full = await this.searchService.details(entry);
      const settings = this.store.settings;
      const type = this.type ?? animeTypeFor(settings);
      const title = buildTitleFromAnime(full, {
        type,
        status: STATUS_PLAN_TO_WATCH,
        takenIds: this.store.allTitles().map((t) => t.id),
      });
      this.store.addTitle(title);
      settings.lastAddedType = type;
      this.store.save("last-added-type");
      new Notice(`Added “${title.title}”`);
      this.onAdded?.(title);
      this.close();
    } catch (error) {
      this.setStatus(
        isAnimeApiError(error)
          ? `Could not load that entry — ${describeAnimeApiError(error)}`
          : error instanceof Error
            ? `Could not load that entry — ${error.message}`
            : "Could not load that entry.",
        "error",
      );
    }
  }
}
