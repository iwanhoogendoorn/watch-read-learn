/**
 * The Add-title modal — **search first** (SPEC §4.6).
 *
 * You type a name, Overseerr answers with real results, and each result already
 * knows whether the thing is on Plex and whether you are already tracking it.
 * Picking one fills in poster, overview, cast, seasons and episode counts, so the
 * manual form is the fallback rather than the default path.
 *
 * `OverseerrClient` is injected as an interface — this lane does not own
 * `services/overseerr.ts`, and the modal never needs to know how it is built. No
 * client configured means the manual form, said plainly, with no dead search box.
 *
 * Async discipline: a **generation counter** guards every search, so a slow
 * response for "dex" can never overwrite the results for "dexter".
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import { recomputeOffsets, totalFromSeasons } from "../../data/episodes";
import { createTitle, uniqueId } from "../../data/schema";
import { DEFAULT_ADD_TYPE_LAST_USED, STATUS_PLAN_TO_WATCH, TYPE_MOVIE } from "../../constants";
import type {
  MediaType,
  OverseerrClient,
  OverseerrDetails,
  OverseerrMediaInfo,
  OverseerrSearchResult,
  Season,
  TitleV4,
  WatchLogStoreApi,
} from "../../types";
import { renderPosterPlaceholder } from "../components/posters";
import { renderProviderResult, type ResultFlag } from "../components/results";
import { renderDateInput } from "../components/dates";

const SEARCH_DEBOUNCE_MS = 300;

/** What was added, plus what the provider already told us about it. */
export interface AddResult {
  title: TitleV4;
  /**
   * Overseerr's availability object for the chosen result, when there was one.
   *
   * Carrying it out of the modal is the whole point: `mediaInfo.ratingKey` is
   * the Plex item id, so the new card can show a verified badge immediately
   * instead of waiting for a GUID-index sweep (report §1.3, SPEC §4.1).
   */
  mediaInfo?: OverseerrMediaInfo;
}

export interface AddModalOptions {
  store: WatchLogStoreApi;
  /** Omit (or pass an unconfigured client) to get the manual form only. */
  client?: OverseerrClient;
  onAdded?: (result: AddResult) => void;
  /**
   * Seed the search box (and the manual form's name) — used when the title is
   * already known, as it is for a draft picked out of a note. Searched
   * immediately, because the user has already typed it once somewhere else.
   */
  initialQuery?: string;
}

// ---------------------------------------------------------------------------
// Pure: turning provider data into a title
// ---------------------------------------------------------------------------

/** Upstream seasons → tracker seasons. Specials (season 0) are dropped. */
export function seasonsFromDetails(details: OverseerrDetails): Season[] {
  const seasons: Season[] = (details.seasons ?? [])
    .filter((season) => season.seasonNumber > 0 && season.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .map((season) => ({
      name: season.name || `Season ${season.seasonNumber}`,
      episodes: season.episodeCount,
      offset: 0,
      skippedEpisodes: [],
      seasonNumber: season.seasonNumber,
      airDate: season.airDate,
    }));
  recomputeOffsets(seasons);
  return seasons;
}

/**
 * The type name to use for a provider hit.
 *
 * **`mediaType` is not a hint, it is the answer.** The preference (`defaultAddType`,
 * or the last-used type behind its sentinel) only ever picks *between* type names
 * that agree with what the provider says the thing is — otherwise adding a show
 * and then a film labelled Spider-Man (2002) "TV Show", complete with a movie
 * runtime and no season grid, which is QA1 B2.
 *
 * "Movie" is the one type name v3 and v4 both treat as semantic (see
 * `constants.ts`), so it is the only one that can be classified: `Movie` is the
 * movie type, every other configured name (Anime, TV Show, Korean TV Show, …) is
 * an episodic one.
 */
export function defaultTypeFor(
  mediaType: MediaType,
  settings: { defaultAddType: string; lastAddedType: string; types: { name: string }[] },
): string {
  const names = settings.types.map((t) => t.name);
  const fits = (name: string): boolean =>
    names.includes(name) && (name === TYPE_MOVIE) === (mediaType === "movie");

  const preferred =
    settings.defaultAddType === DEFAULT_ADD_TYPE_LAST_USED
      ? settings.lastAddedType
      : settings.defaultAddType;
  if (preferred && fits(preferred)) return preferred;

  if (mediaType === "movie") {
    return names.includes(TYPE_MOVIE) ? TYPE_MOVIE : (names[0] ?? TYPE_MOVIE);
  }
  // A show: the first configured type that is not the movie one.
  return names.find((name) => name !== TYPE_MOVIE) ?? names[0] ?? TYPE_MOVIE;
}

/**
 * The type the **manual** form starts on.
 *
 * Nothing has told us what the thing is here, so the user's raw preference wins
 * outright — unlike `defaultTypeFor`, which has a provider `mediaType` to answer
 * to.
 */
export function manualDefaultType(settings: {
  defaultAddType: string;
  lastAddedType: string;
  types: { name: string }[];
}): string {
  const names = settings.types.map((t) => t.name);
  const preferred =
    settings.defaultAddType === DEFAULT_ADD_TYPE_LAST_USED
      ? settings.lastAddedType
      : settings.defaultAddType;
  if (preferred && names.includes(preferred)) return preferred;
  return names[0] ?? TYPE_MOVIE;
}

export interface BuildTitleOptions {
  type: string;
  status: string;
  takenIds: Iterable<string>;
}

/**
 * `OverseerrDetails` → a complete `TitleV4`.
 *
 * Everything unknown stays `""` / `[]`; the v3 `"none"` sentinel is never
 * written, per the sentinel policy in `types.ts`.
 */
export function buildTitleFromDetails(
  details: OverseerrDetails,
  options: BuildTitleOptions,
): TitleV4 {
  // `mediaType` decides the shape, never the runtime or the season array that
  // happens to be on the payload: a movie is one episode with no seasons, a show
  // is its seasons — and a show whose seasons upstream did not enumerate still
  // gets one, so the detail modal has a grid to draw (QA1 B2).
  const isMovie = details.mediaType === "movie";
  const seasons = isMovie ? [] : seasonsFromDetails(details);
  if (!isMovie && seasons.length === 0 && (details.numberOfEpisodes ?? 0) > 0) {
    seasons.push({
      name: "Season 1",
      episodes: details.numberOfEpisodes ?? 0,
      offset: 0,
      skippedEpisodes: [],
      seasonNumber: 1,
      ...(details.releaseDate ? { airDate: details.releaseDate } : {}),
    });
    recomputeOffsets(seasons);
  }
  const totalEpisodes = isMovie ? 1 : Math.max(1, totalFromSeasons(seasons));
  const year = details.releaseDate
    ? Number.parseInt(details.releaseDate.slice(0, 4), 10) || undefined
    : undefined;

  return createTitle({
    id: uniqueId(details.title, options.takenIds),
    title: details.title,
    type: options.type,
    status: options.status,
    tmdbId: details.tmdbId,
    tmdbMediaType: details.mediaType,
    imdbId: details.imdbId,
    overview: details.overview,
    genres: details.genres,
    year,
    releaseDate: details.releaseDate,
    posterUrl: details.posterUrl,
    trailerUrl: details.trailerUrl,
    director: details.director,
    cast: details.cast,
    studio: details.studio,
    communityRating: details.voteAverage,
    communityVotes: details.voteCount,
    communitySource: "tmdb",
    communityRatingLastFetched: new Date().toISOString(),
    totalEpisodes,
    episodeDuration: Math.max(0, Math.round(details.runtime)),
    seasons,
    airing: {
      showStatus: details.showStatus,
      inProduction: details.inProduction,
      seasonCount: details.numberOfSeasons,
      episodeCount: details.numberOfEpisodes,
      nextEpisode: details.nextEpisodeToAir
        ? {
            season: details.nextEpisodeToAir.seasonNumber,
            episode: details.nextEpisodeToAir.episodeNumber,
            airDate: details.nextEpisodeToAir.airDate ?? "",
            name: details.nextEpisodeToAir.name,
          }
        : undefined,
      checkedAt: new Date().toISOString(),
    },
  });
}

/**
 * The whole "a search result became a title" step, in one pure function.
 *
 * The modal calls exactly this, so the mapping the tests pin is the mapping the
 * Add button performs — the two used to be the same three lines written inline,
 * which is where the movie/TV chimera hid (QA1 B2).
 */
export function buildTitleForHit(
  details: OverseerrDetails,
  settings: { defaultAddType: string; lastAddedType: string; types: { name: string }[] },
  takenIds: Iterable<string>,
  status: string = STATUS_PLAN_TO_WATCH,
): TitleV4 {
  return buildTitleFromDetails(details, {
    type: defaultTypeFor(details.mediaType, settings),
    status,
    takenIds,
  });
}

/** Already tracked? Matched on TMDB id first, then on name. */
export function findExisting(
  store: WatchLogStoreApi,
  result: { tmdbId: number; title: string },
): TitleV4 | undefined {
  const byId = store.allTitles().find((t) => t.tmdbId === result.tmdbId);
  return byId ?? store.getTitleByName(result.title);
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export class AddTitleModal extends Modal {
  private store: WatchLogStoreApi;
  private client: OverseerrClient | undefined;
  private onAdded: ((result: AddResult) => void) | undefined;

  private resultsEl: HTMLElement | null = null;
  private manualEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per search; a stale response whose generation lost is discarded. */
  private searchGeneration = 0;
  private manualOpen = false;
  private initialQuery: string | undefined;

  constructor(app: App, options: AddModalOptions) {
    super(app);
    this.store = options.store;
    this.client = options.client;
    this.onAdded = options.onAdded;
    this.initialQuery = options.initialQuery;
  }

  private get searchable(): boolean {
    return this.client?.configured() === true;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-add-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Add a title" });

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
    const icon = wrap.createSpan({ cls: "wl-searchbox-icon" });
    setIcon(icon, "search");
    const input = wrap.createEl("input", {
      cls: "wl-searchbox-input",
      attr: {
        type: "search",
        placeholder: "Search for a movie or show…",
        "aria-label": "Search for a movie or show",
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

    const seed = this.initialQuery?.trim() ?? "";
    if (seed !== "") {
      input.value = seed;
      void this.runSearch(seed);
    }

    window.setTimeout(() => input.focus(), 0);
  }

  private renderNoSearchNotice(host: HTMLElement): void {
    const note = host.createDiv({ cls: "wl-add-notice" });
    const icon = note.createSpan({ cls: "wl-add-notice-icon" });
    setIcon(icon, "info");
    note.createSpan({
      text: "No Overseerr server configured, so search is off. Settings → Integrations turns it on; until then, add titles by hand.",
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

  private renderResults(hits: OverseerrSearchResult[]): void {
    const host = this.resultsEl;
    if (!host) return;
    host.empty();

    if (hits.length === 0) {
      this.setStatus("Nothing found. Try fewer words, or add it by hand below.");
      return;
    }
    this.setStatus("");

    for (const hit of hits) {
      const existing = findExisting(this.store, hit);
      const onPlex = (hit.mediaInfo?.status ?? 0) === 5;
      const flags: ResultFlag[] = [];
      if (onPlex) flags.push({ text: "On Plex", cls: "is-ok" });
      if (existing) flags.push({ text: "Already tracked", cls: "is-tracked" });

      renderProviderResult(host, hit, {
        flags,
        disabled: existing !== undefined,
        onPick: () => {
          if (existing) {
            new Notice(`“${existing.title}” is already in your library.`);
            return;
          }
          void this.addFromHit(hit);
        },
      });
    }
  }

  private async addFromHit(hit: OverseerrSearchResult): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.setStatus(`Fetching “${hit.title}”…`);
    try {
      const details = await client.details(hit.tmdbId, hit.mediaType);
      const settings = this.store.settings;
      const title = buildTitleForHit(
        details,
        settings,
        this.store.allTitles().map((t) => t.id),
      );
      const type = title.type;
      this.store.addTitle(title);
      settings.lastAddedType = type;
      this.store.save("last-added-type");
      new Notice(`Added “${title.title}”`);
      // Details first, search result second: both carry `mediaInfo`, and the
      // details call is the fresher of the two.
      const mediaInfo = details.mediaInfo ?? hit.mediaInfo;
      this.onAdded?.(mediaInfo ? { title, mediaInfo } : { title });
      this.close();
    } catch (error) {
      this.setStatus(
        error instanceof Error
          ? `Could not load that title — ${error.message}`
          : "Could not load that title.",
        "error",
      );
    }
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

    const settings = this.store.settings;
    const grid = host.createDiv({ cls: "wl-field-grid" });

    const nameField = grid.createDiv({ cls: "wl-field" });
    nameField.createDiv({ cls: "wl-field-label", text: "Title" });
    const nameInput = nameField.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", "aria-label": "Title" },
    });
    // A caller that already knows the name (a draft from a note) supplies it;
    // with no search configured this form is the whole flow.
    nameInput.value = this.initialQuery?.trim() ?? "";
    const nameMsg = nameField.createDiv({ cls: "wl-field-msg" });

    const typeField = grid.createDiv({ cls: "wl-field" });
    typeField.createDiv({ cls: "wl-field-label", text: "Type" });
    const typeSelect = typeField.createEl("select", { cls: "wl-select" });
    typeSelect.setAttribute("aria-label", "Type");
    for (const type of settings.types) {
      typeSelect.createEl("option", { value: type.name, text: type.name });
    }
    typeSelect.value = manualDefaultType(settings);

    const statusField = grid.createDiv({ cls: "wl-field" });
    statusField.createDiv({ cls: "wl-field-label", text: "Status" });
    const statusSelect = statusField.createEl("select", { cls: "wl-select" });
    statusSelect.setAttribute("aria-label", "Status");
    for (const status of settings.statuses) {
      statusSelect.createEl("option", { value: status.name, text: status.name });
    }
    statusSelect.value = STATUS_PLAN_TO_WATCH;

    const epField = grid.createDiv({ cls: "wl-field" });
    epField.createDiv({ cls: "wl-field-label", text: "Episodes" });
    const epInput = epField.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "1", step: "1", "aria-label": "Episodes" },
    });
    epInput.value = "1";

    const durField = grid.createDiv({ cls: "wl-field" });
    durField.createDiv({ cls: "wl-field-label", text: "Minutes per episode" });
    const durInput = durField.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "0", step: "1", "aria-label": "Minutes per episode" },
    });
    durInput.value = "0";

    const dateField = grid.createDiv({ cls: "wl-field" });
    dateField.createDiv({ cls: "wl-field-label", text: "Release date" });
    // The user's own format, not the host locale's picker (QA1 B5).
    let releaseDate: string | null = null;
    renderDateInput(dateField, {
      format: settings.dateFormat,
      label: "Release date",
      value: null,
      messageHost: dateField,
      onCommit: (value) => {
        releaseDate = value;
      },
    });

    const buttons = host.createDiv({ cls: "wl-modal-buttons" });
    const submit = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Add title",
      attr: { type: "button" },
    });

    const commit = (): void => {
      const name = nameInput.value.trim();
      if (name === "") {
        // Inline field validation, never a Notice wall (foodspot §4).
        nameMsg.setText("A title needs a name.");
        nameInput.focus();
        return;
      }
      const episodes = Math.max(1, Math.trunc(Number(epInput.value) || 1));
      const type = typeSelect.value;
      const title = createTitle({
        id: uniqueId(name, this.store.allTitles().map((t) => t.id)),
        title: name,
        type,
        status: statusSelect.value,
        totalEpisodes: episodes,
        episodeDuration: Math.max(0, Math.trunc(Number(durInput.value) || 0)),
        releaseDate,
        seasons:
          episodes > 1
            ? [
                {
                  name: "Season 1",
                  episodes,
                  offset: 0,
                  skippedEpisodes: [],
                  seasonNumber: 1,
                  airDate: releaseDate,
                },
              ]
            : [],
      });
      this.store.addTitle(title);
      settings.lastAddedType = type;
      this.store.save("last-added-type");
      new Notice(`Added “${title.title}”`);
      this.onAdded?.({ title });
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
