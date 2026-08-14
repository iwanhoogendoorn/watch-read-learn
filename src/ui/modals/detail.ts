/**
 * The detail modal — **live-bound, no Save button** (SPEC §4.6, foodspot §3).
 *
 * Every control writes through to the store the moment it changes, and the modal
 * re-renders off the same `watchlog-data-changed` bus everything else listens to.
 * Two disciplines keep that from being obnoxious:
 *
 *   - a store-driven re-render is **deferred while focus is inside an input**,
 *     resuming 120 ms after `focusout`, so a background refresh cannot eat what
 *     you are typing;
 *   - free-text fields commit on a 600 ms debounce, so the store is not asked to
 *     write on every keystroke.
 *
 * Chips (genre, cast, director, studio, tag) are links: clicking one hands a
 * scoped query back to the Library and closes the modal — foodspot's
 * `pendingQuery` handoff, which is what makes every chip in the app functional
 * rather than decorative.
 */
import { Menu, Modal, Notice, setIcon, type App } from "obsidian";
import {
  calcTimeRemaining,
  episodesRemaining,
  formatMinutes,
  getEffectiveTotal,
  getProgress,
  getWatchedCount,
  isEpisodeSkipped,
  recomputeOffsets,
  seasonEpisodes,
  seasonRange,
} from "../../data/episodes";
import { SAVE_DEBOUNCE_MS, STATUS_COMPLETED } from "../../constants";
import {
  DATA_CHANGED_EVENT,
  type OverseerrSearchResult,
  type Season,
  type TitlePatch,
  type TitleV4,
  type WatchLogStoreApi,
} from "../../types";
import {
  colorFor,
  episodeCode,
  renderAiringChip,
  renderPill,
  renderPlexBadge,
  renderProgressBar,
  renderSeasonChips,
  requestStatus,
} from "../components/pills";
import { plexStateOf, yearOf } from "../components/facets";
import { renderDateInput } from "../components/dates";
import { openWatchedWizard } from "./watched";
import { imdbUrl, isSingleSitting, ratingForReview, reviewForRating } from "../../data/review";
// The one classifier for "is this a film?" — `tmdbMediaType` first, the type
// name second, the episode shape last. Re-deriving it here is how a movie ends
// up with a season grid and a show with a "Mark as watched" button.
import { mediaTypeOf } from "../../services/requests";
import { needsTmdbBackfill } from "../../services/match";
import {
  isPosterFailed,
  markPosterFailed,
  posterUrlFor,
  renderPosterPlaceholder,
  resolvePosterUrl,
} from "../components/posters";
import { createStars } from "../components/stars";
import { confirmAction } from "./confirm";
import { SeasonEditorModal } from "./seasons";
import {
  renderTrailerEmbed,
  safeExternalUrl,
  trailerUrlOf,
  youtubeKey,
  youtubeWatchUrl,
} from "./trailer";

/** How long after leaving an input before a deferred refresh is allowed through. */
const REFRESH_RESUME_MS = 120;

/** A debounced field edit that has not reached the store yet. */
interface PendingCommit {
  timer: ReturnType<typeof setTimeout>;
  /** Re-read the field and produce the patch. Called again on flush. */
  read: () => Parameters<WatchLogStoreApi["updateTitle"]>[1];
}

/**
 * What the Progress section of the detail modal offers.
 *
 *   - `movie-toggle`  one "Mark as watched" button — **films only**;
 *   - `season-grid`   the per-episode grid, for any show that has seasons;
 *   - `needs-seasons` a show whose seasons are not filled in yet: a nudge to the
 *                     season editor, and deliberately *no* watched toggle.
 *
 * Exported and pure because this is the decision QA1 B2 got wrong: it was keyed
 * off `totalEpisodes <= 1`, which is also what an un-filled show looks like.
 */
export type ProgressAffordance = "movie-toggle" | "season-grid" | "needs-seasons";

export function progressAffordance(title: TitleV4): ProgressAffordance {
  if (title.seasons.length > 0) return "season-grid";
  return mediaTypeOf(title) === "movie" ? "movie-toggle" : "needs-seasons";
}

/**
 * The modal's poster — **eagerly loaded, never observed** (QA1 B3).
 *
 * A detail modal is by definition the thing you are looking at, so lazy loading
 * buys nothing here and costs everything: the modal used to fall back to the
 * letter placeholder whenever no `PosterLoader` was injected, which is exactly
 * what the Library's own `openDetail` does — a title whose card showed a poster
 * opened onto a placeholder.
 *
 * The same resolution rules as everywhere else (`posterUrlFor` for the manual
 * override, `resolvePosterUrl` for a bare TMDB path), the same negative cache,
 * and the same tinted-initial fallback when the image fails.
 */
export function renderModalPoster(host: HTMLElement, title: TitleV4): HTMLElement {
  const poster = host.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = title.title;

  const url = resolvePosterUrl(posterUrlFor(title));
  if (url === "" || isPosterFailed(url)) {
    renderPosterPlaceholder(poster, title.title);
    return poster;
  }

  const img = poster.createEl("img", { cls: "wl-poster-img" });
  img.setAttribute("decoding", "async");
  img.setAttribute("alt", "");
  img.addEventListener("load", () => {
    img.addClass("is-loaded");
    poster.addClass("has-poster");
  });
  img.addEventListener("error", () => {
    markPosterFailed(url);
    img.remove();
    poster.removeClass("has-poster");
    renderPosterPlaceholder(poster, title.title);
  });
  img.src = url;
  return poster;
}

export interface DetailModalOptions {
  store: WatchLogStoreApi;
  titleId: string;
  /** Chip → filtered Library. The modal closes itself before handing over. */
  onJumpToQuery?: (query: string) => void;
  onPlayTrailer?: (title: TitleV4) => void;
  onRequest?: (title: TitleV4) => void;
  onOpenNote?: (title: TitleV4) => void;
  onOpenInPlex?: (title: TitleV4) => void;
  onRefreshMetadata?: (title: TitleV4) => void;
  /** Open the manual TMDB picker for an unmatched title. */
  onFindMatch?: (title: TitleV4) => void;
  /**
   * "More like this" for the title being looked at.
   *
   * Absent means the section is simply not drawn — which is what happens with
   * no metadata provider configured, or for a title with no upstream id to ask
   * about. Returns the ranked list; the modal knows nothing about how.
   */
  onMoreLikeThis?: (title: TitleV4) => Promise<MoreLikeThis[]>;
  /** Add one of those to the library. */
  onAddSuggestion?: (result: OverseerrSearchResult) => Promise<TitleV4 | undefined>;
  onDismissSuggestion?: (tmdbId: number) => void;
}

/** One "more like this" row: the result, and why it is here. */
export interface MoreLikeThis {
  result: OverseerrSearchResult;
  reasons: string[];
}

export class DetailModal extends Modal {
  private store: WatchLogStoreApi;
  private titleId: string;
  private options: DetailModalOptions;

  private bodyEl: HTMLElement | null = null;
  private pendingRefresh = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * One entry per free-text field with an uncommitted edit. The *patch reader*
   * is kept next to its timer, not just the timer, so closing the modal can
   * apply what is pending instead of throwing it away.
   */
  private commitTimers = new Map<string, PendingCommit>();
  /** Seasons the user collapsed, by index; survives re-render. */
  private collapsed = new Set<number>();

  private onDataChanged = (): void => this.requestRefresh();
  private onFocusIn = (): void => {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  };
  private onFocusOut = (): void => {
    if (!this.pendingRefresh) return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.render();
    }, REFRESH_RESUME_MS);
  };

  constructor(app: App, options: DetailModalOptions) {
    super(app);
    this.store = options.store;
    this.titleId = options.titleId;
    this.options = options;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-detail-modal");
    contentEl.empty();
    this.bodyEl = contentEl.createDiv({ cls: "wl-detail" });

    const doc = contentEl.ownerDocument;
    doc.addEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    contentEl.addEventListener("focusin", this.onFocusIn);
    contentEl.addEventListener("focusout", this.onFocusOut);

    this.render();
  }

  override onClose(): void {
    // FIRST, before anything is torn down: a field edited less than
    // `SAVE_DEBOUNCE_MS` ago still has its patch pending. Dropping the timer
    // without applying it is silent data loss, so every pending edit is
    // committed here while the inputs it reads from still exist.
    this.flushPendingCommits();

    const doc = this.contentEl.ownerDocument;
    doc.removeEventListener(DATA_CHANGED_EVENT, this.onDataChanged);
    this.contentEl.removeEventListener("focusin", this.onFocusIn);
    this.contentEl.removeEventListener("focusout", this.onFocusOut);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.contentEl.empty();
  }

  // -------------------------------------------------------------------------
  // Write-through plumbing
  // -------------------------------------------------------------------------

  private title(): TitleV4 | undefined {
    return this.store.getTitle(this.titleId);
  }

  private patch(patch: Parameters<WatchLogStoreApi["updateTitle"]>[1], reason: string): void {
    this.store.updateTitle(this.titleId, patch, reason);
  }

  /** Debounced write for free-text fields; keystrokes never hit the store. */
  private debouncedPatch(
    key: string,
    read: () => Parameters<WatchLogStoreApi["updateTitle"]>[1],
  ): void {
    const existing = this.commitTimers.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.commitTimers.delete(key);
      this.patch(read(), `detail-${key}`);
    }, SAVE_DEBOUNCE_MS);
    this.commitTimers.set(key, { timer, read });
  }

  /**
   * Apply every pending debounced edit right now.
   *
   * Called from `onClose()`. Each patch is isolated: one field that throws must
   * not take the rest of the session's edits down with it.
   */
  private flushPendingCommits(): void {
    const pending = [...this.commitTimers.entries()];
    this.commitTimers.clear();
    for (const [key, entry] of pending) {
      clearTimeout(entry.timer);
      try {
        this.patch(entry.read(), `detail-${key}`);
      } catch (err) {
        console.error(`[wrl] could not commit the ${key} field`, err);
      }
    }
  }

  /** A refresh asked for while an input has focus waits until focus leaves. */
  private requestRefresh(): void {
    const active = this.contentEl.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.contentEl.contains(active) && isEditable(active)) {
      this.pendingRefresh = true;
      return;
    }
    this.render();
  }

  private jump(query: string): void {
    if (!this.options.onJumpToQuery) return;
    this.close();
    this.options.onJumpToQuery(query);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private render(): void {
    this.pendingRefresh = false;
    const host = this.bodyEl;
    if (!host) return;
    const title = this.title();
    host.empty();

    if (!title) {
      host.createDiv({
        cls: "wl-empty-body",
        text: "This title is no longer in your library.",
      });
      return;
    }

    this.renderHeader(host, title);
    this.renderMatchNotice(host, title);
    this.renderOverview(host, title);
    this.renderTrailerSlot(host, title);
    this.renderRequest(host, title);
    this.renderSeasons(host, title);
    this.renderMoreLikeThis(host, title);
    this.renderFields(host, title);
    this.renderNotes(host, title);
    this.renderFooter(host, title);
  }

  // --- header -------------------------------------------------------------

  private renderHeader(host: HTMLElement, title: TitleV4): void {
    const header = host.createDiv({ cls: "wl-detail-header" });

    const posterWrap = header.createDiv({ cls: "wl-detail-poster" });
    renderModalPoster(posterWrap, title);

    const main = header.createDiv({ cls: "wl-detail-head-main" });

    // Click-to-rename: Enter commits, Escape restores.
    const nameEl = main.createDiv({ cls: "wl-detail-title", text: title.title });
    nameEl.setAttribute("role", "textbox");
    nameEl.setAttribute("tabindex", "0");
    nameEl.setAttribute("title", "Click to rename");
    nameEl.addEventListener("click", () => {
      nameEl.contentEditable = "true";
      nameEl.focus();
      nameEl.addClass("is-editing");
    });
    nameEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        nameEl.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        nameEl.setText(title.title);
        nameEl.blur();
      }
    });
    nameEl.addEventListener("blur", () => {
      nameEl.contentEditable = "false";
      nameEl.removeClass("is-editing");
      const next = (nameEl.textContent ?? "").trim();
      if (next === "" || next === title.title) {
        nameEl.setText(title.title);
        return;
      }
      this.patch({ title: next }, "detail-rename");
    });

    const pills = main.createDiv({ cls: "wl-detail-pills" });
    if (title.type) {
      renderPill(pills, {
        text: title.type,
        color: colorFor(this.store.settings.types, title.type),
        cls: "is-type",
      });
    }
    if (title.status) {
      renderPill(pills, {
        text: title.status,
        color: colorFor(this.store.settings.statuses, title.status),
        cls: "is-status",
      });
    }
    const year = yearOf(title);
    if (year !== null) pills.createSpan({ cls: "wl-detail-year", text: String(year) });
    renderPlexBadge(pills, title);
    renderSeasonChips(pills, title);
    renderAiringChip(pills, title);

    const ratingRow = main.createDiv({ cls: "wl-detail-rating" });
    ratingRow.createSpan({ cls: "wl-field-label", text: "My rating" });
    createStars(ratingRow, {
      value: title.rating,
      tiers: this.store.settings.ratingSystem,
      allowHalf: this.store.settings.halfStarRatings,
      showTierLabel: true,
      ariaLabel: `${title.title} rating`,
      onChange: (value) => this.patch(this.ratingPatch(title, value), "detail-rating"),
    });

    if (title.communityRating > 0) {
      const community = main.createDiv({ cls: "wl-detail-community" });
      const icon = community.createSpan({ cls: "wl-detail-community-icon" });
      setIcon(icon, "users");
      const source = title.communitySource ? ` · ${title.communitySource}` : "";
      const votes = title.communityVotes > 0 ? ` (${title.communityVotes} votes)` : "";
      community.createSpan({
        text: `${title.communityRating.toFixed(1)}${votes}${source}`,
      });
    }

    const actions = main.createDiv({ cls: "wl-detail-actions" });
    const favButton = actions.createEl("button", {
      cls: `wl-btn ${title.favorite ? "is-on" : ""}`.trim(),
      attr: { type: "button" },
    });
    const favIcon = favButton.createSpan({ cls: "wl-btn-icon" });
    setIcon(favIcon, title.favorite ? "heart-off" : "heart");
    favButton.createSpan({
      cls: "wl-btn-label",
      text: title.favorite ? "Favourited" : "Favourite",
    });
    favButton.addEventListener("click", () => {
      const favorite = !title.favorite;
      this.patch(
        favorite
          ? { favorite, dateFavorited: new Date().toISOString() }
          : { favorite, dateFavorited: undefined },
        "detail-favorite",
      );
    });

    if (this.options.onOpenNote) {
      this.textButton(actions, "file-text", "Open note", () =>
        this.options.onOpenNote?.(title),
      );
    }
    if (this.options.onOpenInPlex && title.plex?.ratingKey) {
      this.textButton(actions, "external-link", "Open in Plex", () =>
        this.options.onOpenInPlex?.(title),
      );
    }
    // IMDb, when the title is actually linked to one. A search URL built from
    // the name would look the same and be wrong often enough to matter.
    const imdb = imdbUrl(title);
    if (imdb !== "") {
      this.textButton(actions, "external-link", "IMDb", () => {
        window.open(imdb, "_blank");
      });
    }
    if (this.options.onRefreshMetadata) {
      this.textButton(actions, "refresh-cw", "Refresh metadata", () =>
        this.options.onRefreshMetadata?.(title),
      );
    }
    // The same wizard the status change opens, reachable on purpose — for the
    // film you watched last week and are only now filling in.
    this.textButton(actions, "check-check", "Watched…", () => this.askWatched(title));
  }

  private textButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const button = parent.createEl("button", { cls: "wl-btn", attr: { type: "button" } });
    const iconEl = button.createSpan({ cls: "wl-btn-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ cls: "wl-btn-label", text: label });
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * "This title is not matched upstream" (QA2 report 1).
   *
   * A migrated v3 row has no TMDB id, which means no next episode, no
   * new-season alert and a Plex match that can only be guessed from the name.
   * That used to be invisible — the title simply never appeared in Upcoming.
   * Now it says so, and offers the picker.
   */
  private renderMatchNotice(host: HTMLElement, title: TitleV4): void {
    if (!needsTmdbBackfill(title)) return;

    const notice = host.createDiv({ cls: "wl-detail-notice wl-match-notice" });
    const head = notice.createDiv({ cls: "wl-detail-notice-head" });
    setIcon(head.createSpan({ cls: "wl-detail-notice-icon" }), "unlink");
    head.createSpan({
      text:
        title.tmdbMatch?.state === "ambiguous"
          ? "More than one title upstream could be this one."
          : "Not matched to a title upstream yet.",
    });
    notice.createDiv({
      cls: "wl-detail-note",
      text: "Until it is matched there is no release schedule, no new-season alert and no reliable Plex match.",
    });
    if (this.options.onFindMatch) {
      const row = notice.createDiv({ cls: "wl-detail-actions" });
      this.textButton(row, "link", "Match on Overseerr…", () =>
        this.options.onFindMatch?.(title),
      );
    }
  }

  // --- overview + chips ---------------------------------------------------

  private renderOverview(host: HTMLElement, title: TitleV4): void {
    if (title.overview && title.overview.trim() !== "") {
      host.createDiv({ cls: "wl-detail-overview", text: title.overview });
    }

    this.chipSection(host, "Genres", title.genres ?? [], (value) =>
      this.jump(`genre:"${value}"`),
    );
    this.chipSection(host, "Cast", [...title.cast, ...title.manualCast], (value) =>
      this.jump(`cast:"${value}"`),
    );
    this.chipSection(
      host,
      "Director",
      [...title.director, ...title.manualDirector],
      (value) => this.jump(`director:"${value}"`),
    );
    this.chipSection(host, "Studio", [...title.studio, ...title.manualStudio], (value) =>
      this.jump(`studio:"${value}"`),
    );
    this.chipSection(host, "Tags", title.tags, (value) => this.jump(`tag:"${value}"`));
  }

  private chipSection(
    host: HTMLElement,
    label: string,
    values: readonly string[],
    onClick: (value: string) => void,
  ): void {
    const list = [...new Set(values.filter((v) => v.trim() !== ""))];
    if (list.length === 0) return;
    const section = host.createDiv({ cls: "wl-detail-chipsection" });
    section.createSpan({ cls: "wl-field-label", text: label });
    const row = section.createDiv({ cls: "wl-chips" });
    for (const value of list) {
      const chip = row.createSpan({ cls: "wl-chip is-clickable", text: value });
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      chip.setAttribute("title", `Show every title with ${label.toLowerCase()} “${value}”`);
      const fire = (event: Event): void => {
        event.preventDefault();
        onClick(value);
      };
      chip.addEventListener("click", fire);
      chip.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") fire(event);
      });
    }
  }

  // --- trailer ------------------------------------------------------------

  /**
   * The trailer section (SPEC §4.3).
   *
   * On `embed` the player is inline — you are already looking at the title, so
   * a second modal on top of this one would be one click for nothing. `link-only`
   * and `off` degrade to the button and the link, and the "open on YouTube"
   * escape hatch is rendered in all three cases because embeds fail silently for
   * region blocks and embedding-disabled uploads.
   *
   * The iframe is created lazily on click rather than on render: a detail modal
   * that autoplayed a trailer every time you opened it would be intolerable.
   */
  /**
   * "More like this", where you are actually standing when the question occurs
   * to you.
   *
   * Loads when the section is drawn rather than behind a button: the answer is
   * the point of the section, and the request is the same one the dashboard
   * panel caches. Failure prints a sentence — a section that silently stays
   * empty is indistinguishable from one that found nothing.
   */
  private renderMoreLikeThis(host: HTMLElement, title: TitleV4): void {
    const fetch = this.options.onMoreLikeThis;
    if (!fetch || !title.tmdbId) return;

    const section = host.createDiv({ cls: "wl-detail-section wl-detail-more" });
    section.createDiv({ cls: "wl-detail-section-title", text: "More like this" });
    const list = section.createDiv({ cls: "wl-suggest-mini-list" });
    list.createDiv({ cls: "wl-suggest-empty", text: "Looking…" });

    void fetch(title)
      .then((results) => {
        list.empty();
        if (results.length === 0) {
          list.createDiv({
            cls: "wl-suggest-empty",
            text: "Nothing to suggest from this one — everything it points at is already yours.",
          });
          return;
        }
        for (const entry of results.slice(0, 6)) this.renderMoreRow(list, entry);
      })
      .catch((err) => {
        list.empty();
        list.createDiv({
          cls: "wl-suggest-empty",
          text: `Could not ask for similar titles — ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }

  private renderMoreRow(parent: HTMLElement, entry: MoreLikeThis): void {
    const { result } = entry;
    const row = parent.createDiv({ cls: "wl-recent-row wl-suggest-mini" });

    const poster = row.createDiv({ cls: "wl-thumb" });
    if (result.posterUrl) {
      const img = poster.createEl("img", { cls: "wl-thumb-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.src = result.posterUrl;
    } else {
      renderPosterPlaceholder(poster, result.title);
    }

    const body = row.createDiv({ cls: "wl-recent-body" });
    body.createDiv({
      cls: "wl-recent-name",
      text: result.year ? `${result.title} (${result.year})` : result.title,
    });
    const rating = result.voteAverage > 0 ? `★ ${result.voteAverage.toFixed(1)}` : "";
    const reason = entry.reasons[0] ?? "";
    body.createDiv({
      cls: "wl-recent-meta",
      text: [rating, reason].filter(Boolean).join(" · "),
    });

    const actions = row.createDiv({ cls: "wl-suggest-mini-actions" });
    if (this.options.onAddSuggestion) {
      const add = actions.createEl("button", {
        cls: "wl-mini-btn",
        text: "Add",
        attr: { type: "button", title: `Add ${result.title} to your library` },
      });
      add.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        add.disabled = true;
        void this.options.onAddSuggestion?.(result).then((added) => {
          if (added) {
            new Notice(`Added «${result.title}».`);
            row.remove();
          } else {
            add.disabled = false;
          }
        });
      });
    }
    if (this.options.onDismissSuggestion) {
      const no = actions.createEl("button", {
        cls: "wl-icon-btn",
        attr: { type: "button", "aria-label": "Not interested", title: "Not interested" },
      });
      setIcon(no, "x");
      no.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        this.options.onDismissSuggestion?.(result.tmdbId);
        row.remove();
      });
    }
  }

  private renderTrailerSlot(host: HTMLElement, title: TitleV4): void {
    const url = trailerUrlOf(title);
    if (!url) return;
    const mode = this.store.settings.trailerMode;
    if (mode === "off") return;

    const section = host.createDiv({ cls: "wl-detail-section wl-detail-trailer" });
    const head = section.createDiv({ cls: "wl-detail-section-head" });
    head.createSpan({ cls: "wl-field-label", text: "Trailer" });
    const slot = section.createDiv({ cls: "wl-trailer-slot" });

    const key = youtubeKey(url);
    const row = section.createDiv({ cls: "wl-detail-actions" });

    if (mode === "embed" && key) {
      this.textButton(row, "play", "Play trailer", () => {
        slot.empty();
        renderTrailerEmbed(slot, key, `${title.title} trailer`);
      });
    } else if (this.options.onPlayTrailer) {
      this.textButton(row, "play", "Play trailer", () =>
        this.options.onPlayTrailer?.(title),
      );
    }

    // Same allowlist as the trailer modal: a stored `javascript:`/`file:` URL
    // never reaches an `href`.
    const external = key ? youtubeWatchUrl(key) : safeExternalUrl(url);
    if (external) {
      const link = row.createEl("a", {
        cls: "wl-btn",
        text: "Open on YouTube",
        href: external,
        attr: { target: "_blank", rel: "noopener noreferrer" },
      });
      link.setAttribute("aria-label", `Open the ${title.title} trailer on YouTube`);
    } else {
      section.createDiv({
        cls: "wl-detail-note is-error",
        text: "That trailer link is not an http(s) address, so the plugin will not open it.",
      });
    }
  }

  // --- request ------------------------------------------------------------

  private renderRequest(host: HTMLElement, title: TitleV4): void {
    const status = requestStatus(title);
    const plex = plexStateOf(title);
    if (!status && (plex === "available" || !this.options.onRequest)) return;

    const section = host.createDiv({ cls: "wl-detail-section wl-detail-request" });
    section.createSpan({ cls: "wl-field-label", text: "Request" });

    if (status) {
      const pill = section.createSpan({ cls: `wl-request-pill is-${status.tone}` });
      const icon = pill.createSpan({ cls: "wl-request-pill-icon" });
      setIcon(icon, status.tone === "ok" ? "check-circle-2" : "loader");
      pill.createSpan({ text: status.text });
      const seasons = title.request?.seasons ?? [];
      if (seasons.length > 0) {
        section.createSpan({
          cls: "wl-detail-note",
          text: `Seasons ${seasons.join(", ")}`,
        });
      }
    }

    if (this.options.onRequest && plex !== "available") {
      this.textButton(section, "download", status ? "Request more" : "Request", () =>
        this.options.onRequest?.(title),
      );
    }
  }

  // --- seasons ------------------------------------------------------------

  private renderSeasons(host: HTMLElement, title: TitleV4): void {
    const affordance = progressAffordance(title);
    const section = host.createDiv({ cls: "wl-detail-section wl-detail-seasons" });
    section.toggleClass("is-movie", affordance === "movie-toggle");
    const head = section.createDiv({ cls: "wl-detail-section-head" });
    head.createSpan({ cls: "wl-field-label", text: "Progress" });
    this.textButton(head, "list-tree", "Edit seasons", () => {
      new SeasonEditorModal(this.app, this.store, title).open();
    });

    const total = getEffectiveTotal(title);
    const summary = section.createDiv({ cls: "wl-detail-progress-summary" });
    summary.createSpan({
      text:
        total <= 1
          ? title.watchedEpisodes.length > 0
            ? "Watched"
            : "Not watched yet"
          : `${getWatchedCount(title)} of ${total} episodes · ${getProgress(title)}%`,
    });
    const left = calcTimeRemaining(title);
    if (left > 0) {
      summary.createSpan({
        cls: "wl-detail-note",
        text: `${formatMinutes(left)} left · ${episodesRemaining(title)} episode(s)`,
      });
    }
    renderProgressBar(section, title);

    if (affordance !== "season-grid") {
      // A film, or a show whose seasons were never filled in. Which of the two
      // it is comes from `mediaTypeOf`, not from the episode count: an unfilled
      // show also has one "episode", and keying the film affordance off that is
      // what put "Mark as watched" on a series (QA1 B2).
      const row = section.createDiv({ cls: "wl-detail-note" });
      row.setText(
        affordance === "movie-toggle"
          ? "Single entry — use the button below to mark it watched."
          : "No seasons defined yet. “Edit seasons” gives this show a per-episode grid.",
      );
      if (affordance === "movie-toggle") this.renderSingleToggle(section, title);
      return;
    }

    const plexEpisodes = new Set(
      (title.plex?.episodes ?? []).map((entry) => `${entry.s}x${entry.e}`),
    );

    title.seasons.forEach((season, index) => {
      this.renderSeasonBlock(section, title, season, index, plexEpisodes);
    });
  }

  private renderSingleToggle(host: HTMLElement, title: TitleV4): void {
    const watched = title.watchedEpisodes.includes(1);
    const button = host.createEl("button", {
      cls: `wl-ep ${watched ? "is-watched" : ""}`.trim(),
      attr: { type: "button", "aria-pressed": String(watched) },
      text: watched ? "Watched" : "Mark as watched",
    });
    button.addEventListener("click", () => {
      this.store.markEpisodeWatched(title.id, 1, !watched);
    });
  }

  private renderSeasonBlock(
    host: HTMLElement,
    title: TitleV4,
    season: Season,
    index: number,
    plexEpisodes: Set<string>,
  ): void {
    const block = host.createDiv({ cls: "wl-season" });
    const head = block.createDiv({ cls: "wl-season-head" });

    const toggle = head.createEl("button", {
      cls: "wl-icon-btn wl-season-collapse",
      attr: { type: "button", "aria-label": `Collapse ${season.name}` },
    });
    const isCollapsed = this.collapsed.has(index);
    setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
    toggle.addEventListener("click", () => {
      if (this.collapsed.has(index)) this.collapsed.delete(index);
      else this.collapsed.add(index);
      this.render();
    });

    head.createSpan({ cls: "wl-season-name", text: season.name });

    const episodes = seasonEpisodes(title, index);
    const watchedHere = episodes.filter((ep) => title.watchedEpisodes.includes(ep)).length;
    head.createSpan({
      cls: "wl-season-count",
      text: episodes.length > 0 ? `${watchedHere}/${episodes.length}` : "—",
    });

    if (episodes.length > 0) {
      const allWatched = watchedHere === episodes.length;
      const bulk = head.createEl("button", {
        cls: "wl-link-btn",
        text: allWatched ? "Unwatch all" : "Watch all",
        attr: { type: "button" },
      });
      bulk.addEventListener("click", () => {
        this.store.markSeasonWatched(title.id, index, !allWatched);
      });
    }

    if (isCollapsed) return;

    const grid = block.createDiv({ cls: "wl-ep-grid" });
    const seasonNumber = season.seasonNumber ?? index + 1;
    const { first, last } = seasonRange(season);

    for (let absolute = first; absolute <= Math.min(last, title.totalEpisodes); absolute += 1) {
      const relative = absolute - season.offset;
      const skipped = isEpisodeSkipped(title, absolute);
      const watched = title.watchedEpisodes.includes(absolute);
      const onPlex = plexEpisodes.has(`${seasonNumber}x${relative}`);

      const cell = grid.createEl("button", {
        cls: "wl-ep",
        attr: {
          type: "button",
          "aria-pressed": String(watched),
          "aria-label": `${episodeCode(seasonNumber, relative)}${skipped ? " (skipped)" : ""}`,
          title: skipped
            ? `${episodeCode(seasonNumber, relative)} — skipped. Right-click to unskip.`
            : `${episodeCode(seasonNumber, relative)}${onPlex ? " — on Plex" : ""}. Right-click to skip.`,
        },
      });
      cell.toggleClass("is-watched", watched);
      cell.toggleClass("is-skipped", skipped);
      cell.createSpan({ cls: "wl-ep-num", text: String(relative) });
      if (onPlex) cell.createSpan({ cls: "wl-ep-plex" });

      cell.addEventListener("click", () => {
        if (skipped) {
          new Notice("That episode is skipped — right-click it to unskip first.");
          return;
        }
        this.store.markEpisodeWatched(title.id, absolute, !watched);
      });

      cell.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle(skipped ? "Unskip this episode" : "Skip this episode")
            .setIcon(skipped ? "rotate-ccw" : "skip-forward")
            .onClick(() => this.toggleSkipped(title, index, relative)),
        );
        menu.showAtMouseEvent(event);
      });
    }
  }

  /**
   * Skipping is a season-level edit: it changes the denominator, so it goes
   * through `updateTitle`, which re-sanitises `watchedEpisodes` and drops the
   * episode from the watched list if it was ticked.
   */
  private toggleSkipped(title: TitleV4, seasonIndex: number, relative: number): void {
    const seasons = title.seasons.map((season, index) => {
      if (index !== seasonIndex) return { ...season, skippedEpisodes: [...season.skippedEpisodes] };
      const set = new Set(season.skippedEpisodes);
      if (set.has(relative)) set.delete(relative);
      else set.add(relative);
      return { ...season, skippedEpisodes: [...set].sort((a, b) => a - b) };
    });
    recomputeOffsets(seasons);
    this.patch({ seasons }, "detail-skip-toggled");
  }

  // --- fields -------------------------------------------------------------

  private renderFields(host: HTMLElement, title: TitleV4): void {
    const section = host.createDiv({ cls: "wl-detail-section wl-detail-fields" });
    const grid = section.createDiv({ cls: "wl-field-grid" });

    this.selectField(
      grid,
      "Status",
      this.store.settings.statuses.map((s) => s.name),
      title.status,
      (value) => {
        this.patch({ status: value }, "detail-status");
        // Finishing something is the one status change that knows three other
        // things — when, how good, what you thought — so it asks for them.
        if (value === STATUS_COMPLETED && title.status !== STATUS_COMPLETED) {
          this.askWatched(title);
        }
      },
    );
    this.selectField(
      grid,
      "Priority",
      ["", ...this.store.settings.priorities.map((p) => p.name)],
      title.priority,
      (value) => this.patch({ priority: value }, "detail-priority"),
    );
    this.selectField(
      grid,
      "Review",
      ["", ...this.store.settings.reviews.map((r) => r.name)],
      title.review,
      (value) => this.patch(this.reviewPatch(title, value), "detail-review"),
    );
    this.selectField(grid, "Type", this.store.settings.types.map((t) => t.name), title.type, (value) =>
      this.patch({ type: value }, "detail-type"),
    );

    // A film is watched in an evening. Two date fields for one sitting is a
    // question nobody has an interesting answer to, so films get one — and it
    // writes both, keeping every "started/finished" reader working unchanged.
    if (isSingleSitting(title)) {
      this.dateField(grid, "Watched on", title.dateFinished ?? title.dateStarted, (value) =>
        this.patch({ dateStarted: value, dateFinished: value }, "detail-watched-on"),
      );
    } else {
      this.dateField(grid, "Started", title.dateStarted, (value) =>
        this.patch({ dateStarted: value }, "detail-started"),
      );
      this.dateField(grid, "Finished", title.dateFinished, (value) =>
        this.patch({ dateFinished: value }, "detail-finished"),
      );
    }
    this.dateField(grid, "Released", title.releaseDate, (value) =>
      this.patch({ releaseDate: value }, "detail-released"),
    );

    this.numberField(grid, "Minutes per episode", title.episodeDuration, (value) =>
      this.patch({ episodeDuration: value }, "detail-duration"),
    );

    this.textField(grid, "Tags", title.tags.join(", "), "tags", () => ({
      tags: readTagList(this.fieldValue("tags")),
    }));

  }

  private fieldValues = new Map<string, string>();

  private fieldValue(key: string): string {
    return this.fieldValues.get(key) ?? "";
  }

  private selectField(
    host: HTMLElement,
    label: string,
    values: string[],
    current: string,
    onChange: (value: string) => void,
  ): void {
    const field = host.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: label });
    const select = field.createEl("select", { cls: "wl-select" });
    select.setAttribute("aria-label", label);
    for (const value of values) {
      const option = select.createEl("option", { value, text: value === "" ? "—" : value });
      if (value === current) option.selected = true;
    }
    select.addEventListener("change", () => onChange(select.value));
  }

  /**
   * A date field in the user's own format (QA1 B5).
   *
   * `<input type="date">` renders whatever the host locale wants — `dd.mm.yyyy`
   * here — and ignores `settings.dateFormat` completely, which is both wrong and
   * visually foreign to the rest of the form. This is a plain text field that
   * shows, advertises and parses the configured format, and refuses to commit
   * text that is not a date instead of quietly writing a wrong one.
   */
  /**
   * Ask the three things finishing something tells you, then write them.
   *
   * Only the fields the wizard actually returns are written: leaving the
   * rating alone in there must leave the rating alone here.
   */
  /**
   * Rating and review, kept in step.
   *
   * They are two ways of saying the same thing, so changing one should move
   * the other — but only while they still agree. The moment someone sets a
   * review that is not the one their rating implies, they have said something
   * deliberate, and from then on the two are left alone. Empty counts as
   * agreeing: there is nothing there to contradict.
   */
  private ratingPatch(title: TitleV4, rating: number): TitlePatch {
    const patch: TitlePatch = { rating };
    const reviews = this.store.settings.reviews;
    const inStep =
      title.review.trim() === "" || title.review === reviewForRating(title.rating, reviews);
    if (!inStep) return patch;
    const proposed = reviewForRating(rating, reviews);
    if (proposed !== "" && proposed !== title.review) patch.review = proposed;
    return patch;
  }

  private reviewPatch(title: TitleV4, review: string): TitlePatch {
    const patch: TitlePatch = { review };
    const reviews = this.store.settings.reviews;
    // Only fills a rating nobody has given: a star count is finer-grained than
    // a label, so overwriting 4.5 with the middle of a band would lose detail
    // the user actually entered.
    if (title.rating > 0 || review.trim() === "") return patch;
    const implied = ratingForReview(review, reviews);
    if (implied > 0) patch.rating = implied;
    return patch;
  }

  private askWatched(title: TitleV4): void {
    openWatchedWizard(this.app, {
      title,
      dateFormat: this.store.settings.dateFormat,
      ratingTiers: this.store.settings.ratingSystem,
      halfStars: this.store.settings.halfStarRatings,
      reviews: this.store.settings.reviews,
      onConfirm: (result) => {
        const patch: TitlePatch = { status: STATUS_COMPLETED };
        if (result.date) {
          patch.dateFinished = result.date;
          // A film's two dates are one date; a series keeps whatever start it
          // already had rather than being told it began the night it ended.
          if (isSingleSitting(title) || !title.dateStarted) patch.dateStarted = result.date;
        }
        if (result.rating > 0) patch.rating = result.rating;
        if (result.review !== "") patch.review = result.review;
        this.patch(patch, "detail-watched");
      },
    });
  }

  private dateField(
    host: HTMLElement,
    label: string,
    current: string | null,
    onChange: (value: string | null) => void,
  ): void {
    const field = host.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: label });
    renderDateInput(field, {
      format: this.store.settings.dateFormat,
      label,
      value: current,
      messageHost: field,
      onCommit: onChange,
    });
  }

  private numberField(
    host: HTMLElement,
    label: string,
    current: number,
    onChange: (value: number) => void,
  ): void {
    const field = host.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: label });
    const input = field.createEl("input", {
      cls: "wl-input",
      attr: { type: "number", min: "0", step: "1" },
    });
    input.setAttribute("aria-label", label);
    input.value = String(current);
    input.addEventListener("change", () => onChange(Math.max(0, Number(input.value) || 0)));
  }

  private textField(
    host: HTMLElement,
    label: string,
    current: string,
    key: string,
    read: () => Parameters<WatchLogStoreApi["updateTitle"]>[1],
  ): void {
    const field = host.createDiv({ cls: "wl-field" });
    field.createDiv({ cls: "wl-field-label", text: label });
    const input = field.createEl("input", { cls: "wl-input", attr: { type: "text" } });
    input.setAttribute("aria-label", label);
    input.value = current;
    this.fieldValues.set(key, current);
    input.addEventListener("input", () => {
      this.fieldValues.set(key, input.value);
      this.debouncedPatch(key, read);
    });
  }

  // --- notes --------------------------------------------------------------

  private renderNotes(host: HTMLElement, title: TitleV4): void {
    const section = host.createDiv({ cls: "wl-detail-section wl-detail-notes" });
    section.createDiv({ cls: "wl-field-label", text: "Notes" });
    const area = section.createEl("textarea", {
      cls: "wl-textarea",
      attr: { rows: "4", placeholder: "Anything worth remembering about this one…" },
    });
    area.setAttribute("aria-label", "Notes");
    area.value = title.notes;
    area.addEventListener("input", () => {
      this.fieldValues.set("notes", area.value);
      this.debouncedPatch("notes", () => ({ notes: this.fieldValue("notes") }));
    });
  }

  // --- footer -------------------------------------------------------------

  private renderFooter(host: HTMLElement, title: TitleV4): void {
    const footer = host.createDiv({ cls: "wl-detail-footer" });
    // Icon *and* label: a destructive action never renders as a bare coloured
    // rectangle, whatever a theme does to `.mod-warning` (QA1 B6).
    const del = footer.createEl("button", {
      cls: "wl-btn mod-warning",
      attr: { type: "button", "aria-label": `Delete ${title.title}` },
    });
    setIcon(del.createSpan({ cls: "wl-btn-icon" }), "trash-2");
    del.createSpan({ cls: "wl-btn-label", text: "Delete title" });
    del.addEventListener("click", () => {
      const watched = getWatchedCount(title);
      void confirmAction(this.app, {
        title: `Delete “${title.title}”?`,
        message: "It is removed from your library and from any groups it belongs to.",
        details:
          watched > 0
            ? [`${watched} watched episode(s) and its rating go with it.`]
            : undefined,
        confirmText: "Delete",
        danger: true,
      }).then((result) => {
        if (!result.confirmed) return;
        this.store.deleteTitle(title.id);
        this.close();
      });
    });
  }
}

function isEditable(el: HTMLElement): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.isContentEditable
  );
}

/** `sci-fi, rewatch , ,cosy` → `["sci-fi","rewatch","cosy"]`. */
export function readTagList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}
