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
import { Modal, Notice, setIcon, type App } from "obsidian";
import {
  calcTimeRemaining,
  episodesRemaining,
  formatMinutes,
  getEffectiveTotal,
  getProgress,
  getWatchedCount,
  recomputeOffsets,
} from "../../data/episodes";
import { SAVE_DEBOUNCE_MS, STATUS_COMPLETED, STATUS_PLAN_TO_WATCH } from "../../constants";
import {
  DATA_CHANGED_EVENT,
  type OverseerrSearchResult,
  type TitlePatch,
  type TitleV4,
  type WatchLogStoreApi,
} from "../../types";
import {
  colorFor,
  renderAiringChip,
  renderPill,
  renderPlexBadge,
  renderProgressBar,
  renderSeasonChips,
  requestStatus,
} from "../components/pills";
import { plexStateOf, yearOf } from "../components/facets";
import { imdbUrl, isSingleSitting } from "../../data/review";
import { needsTmdbBackfill } from "../../services/match";
import { renderPosterPlaceholder } from "../components/posters";
import { SeasonEditorModal } from "./seasons";
import { askDelete, askUnwatch, askWatched } from "../detail/actions";
// The controls themselves live in `ui/detail/` because the workspace view uses
// the same ones. One implementation each is not a tidiness preference here: two
// copies of the rating/review binding is the bug that got reported four times.
import {
  iconTextButton,
  renderDateField,
  renderNotesField,
  renderNumberField,
  renderSelectField,
  renderStatusField,
  renderTextField,
} from "../detail/fields";
import {
  renderCommunityRating,
  renderRatingField,
  renderReviewField,
} from "../detail/judgement";
import {
  markEpisodesPatch,
  plexEpisodeKeys,
  progressAffordance,
  renderSeasonBlock,
  renderSingleToggle,
  seasonsWithSkipToggled,
} from "../detail/progress";
import { renderDetailPoster } from "../detail/poster";
import { renderStatTiles } from "../detail/stats";
import { isEditable, readTagList, type DetailSurface } from "../detail/surface";
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

// Both of these moved to `ui/detail/` when the workspace view started using
// them; re-exported here because this is the path callers and tests already
// know, and moving a symbol is not a reason to break them.
export { progressAffordance, type ProgressAffordance } from "../detail/progress";
export { readTagList } from "../detail/surface";
export { renderDetailPoster as renderModalPoster } from "../detail/poster";

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

export class DetailModal extends Modal implements DetailSurface {
  readonly store: WatchLogStoreApi;
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

  /**
   * Write, then repaint.
   *
   * The repaint used to be left to the `watchlog-data-changed` listener, on the
   * theory that a write emits an event and the event redraws. That holds only
   * while the modal's document and the store's are the same object — not in a
   * popout window, not in a harness — and when it does not hold the modal
   * writes correctly and shows the old value forever. Rating and review looked
   * "not connected" for three releases because of it: the data moved every
   * time, the screen never did.
   *
   * `requestRefresh` still defers while a text field has focus, so this cannot
   * interrupt typing.
   */
  patch(patch: TitlePatch, reason: string): void {
    this.store.updateTitle(this.titleId, patch, reason);
    this.requestRefresh();
  }

  /** Debounced write for free-text fields; keystrokes never hit the store. */
  debouncedPatch(key: string, read: () => TitlePatch): void {
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
    const active = this.contentEl.ownerDocument?.activeElement as
      | { tagName?: string; isContentEditable?: boolean }
      | null
      | undefined;
    if (active && isEditable(active)) {
      // Something is being typed into: repaint when the field is left, or the
      // caret jumps and half a sentence goes with it.
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
    renderDetailPoster(posterWrap, title);

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

    renderRatingField(main, title, this);

    renderCommunityRating(main, title);

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
    // …and the way back out. Offered only when there is something to undo, so
    // it does not sit there on a film nobody has started.
    if (title.status === STATUS_COMPLETED || title.watchedEpisodes.length > 0) {
      this.textButton(actions, "rotate-ccw", "Not watched", () => this.askUnwatch(title));
    }
  }

  private textButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    return iconTextButton(parent, icon, label, onClick);
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

    // The Dashboard's stat tiles, which this surface had never used: it said the
    // same things in one line of muted grey and never showed *watched* at all.
    renderStatTiles(section, title);
    const left = calcTimeRemaining(title);
    if (left > 0) {
      section.createDiv({
        cls: "wl-detail-note",
        text: `${episodesRemaining(title)} episode(s) to go`,
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
      if (affordance === "movie-toggle") {
        renderSingleToggle(section, title, this.store, () => this.requestRefresh());
      }
      return;
    }

    const plexEpisodes = plexEpisodeKeys(title);

    title.seasons.forEach((season, index) => {
      renderSeasonBlock(section, {
        title,
        store: this.store,
        season,
        index,
        collapsed: this.collapsed.has(index),
        plexEpisodes,
        onToggleCollapse: () => {
          if (this.collapsed.has(index)) this.collapsed.delete(index);
          else this.collapsed.add(index);
          this.render();
        },
        onToggleSkipped: (seasonIndex, relative) =>
          this.toggleSkipped(title, seasonIndex, relative),
        onWrote: () => this.requestRefresh(),
        onMarkEpisodes: (episodes, watched) =>
          this.patch(markEpisodesPatch(title, episodes, watched), "detail-season-aired"),
      });
    });
  }

  /**
   * Skipping is a season-level edit: it changes the denominator, so it goes
   * through `updateTitle`, which re-sanitises `watchedEpisodes` and drops the
   * episode from the watched list if it was ticked.
   */
  private toggleSkipped(title: TitleV4, seasonIndex: number, relative: number): void {
    const seasons = seasonsWithSkipToggled(title, seasonIndex, relative);
    recomputeOffsets(seasons);
    this.patch({ seasons }, "detail-skip-toggled");
  }

  // --- fields -------------------------------------------------------------

  private renderFields(host: HTMLElement, title: TitleV4): void {
    const section = host.createDiv({ cls: "wl-detail-section wl-detail-fields" });
    const grid = section.createDiv({ cls: "wl-field-grid" });

    renderStatusField(grid, title, this, (value) => {
      // Finishing something is the one status change that knows three other
      // things — when, how good, what you thought — so it asks for them.
      if (value === STATUS_COMPLETED && title.status !== STATUS_COMPLETED) {
        this.askWatched(title);
      }
    });
    renderSelectField(grid, {
      label: "Priority",
      values: ["", ...this.store.settings.priorities.map((p) => p.name)],
      current: title.priority,
      onChange: (value) => this.patch({ priority: value }, "detail-priority"),
    });
    renderReviewField(grid, title, this);
    renderSelectField(grid, {
      label: "Type",
      values: this.store.settings.types.map((t) => t.name),
      current: title.type,
      onChange: (value) => this.patch({ type: value }, "detail-type"),
    });

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

    renderNumberField(grid, {
      label: "Minutes per episode",
      current: title.episodeDuration,
      onChange: (value) => this.patch({ episodeDuration: value }, "detail-duration"),
    });

    this.fieldValues.set("tags", title.tags.join(", "));
    renderTextField(grid, {
      label: "Tags",
      key: "tags",
      current: title.tags.join(", "),
      surface: this,
      onInput: (value) => this.fieldValues.set("tags", value),
      read: () => ({ tags: readTagList(this.fieldValue("tags")) }),
    });
  }

  private fieldValues = new Map<string, string>();

  private fieldValue(key: string): string {
    return this.fieldValues.get(key) ?? "";
  }

  /** Both of these are shared with the workspace view — see `detail/actions`. */
  private askUnwatch(title: TitleV4): void {
    askUnwatch(this.app, title, this);
  }

  private askWatched(title: TitleV4): void {
    askWatched(this.app, title, this);
  }

  private dateField(
    host: HTMLElement,
    label: string,
    current: string | null,
    onChange: (value: string | null) => void,
  ): void {
    renderDateField(host, {
      label,
      format: this.store.settings.dateFormat,
      current,
      onChange,
    });
  }

  // --- notes --------------------------------------------------------------

  private renderNotes(host: HTMLElement, title: TitleV4): void {
    renderNotesField(host, {
      current: title.notes,
      surface: this,
      onInput: (value) => this.fieldValues.set("notes", value),
      read: () => ({ notes: this.fieldValue("notes") }),
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
      askDelete(this.app, title, this, getWatchedCount(title), () => this.close());
    });
  }
}
