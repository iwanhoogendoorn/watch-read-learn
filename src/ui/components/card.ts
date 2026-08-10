/**
 * `buildTitleCard` — the one card component (SPEC §4.6).
 *
 * Library, Dashboard, Upcoming and every embedded code block call this same
 * function; the **context**, not the component, decides what is interactive. That
 * is why widgets feel native instead of like a cut-down second implementation.
 *
 * Three variants:
 *   - `full`    2:3 poster, gradient scrim, pills, rating, progress, hover actions
 *   - `compact` a row: thumb + title + meta + rating
 *   - `mini`    thumb + title, for shelves and dense lists
 *
 * Accessibility: the card is `role="button"` with `tabindex=0` and opens on
 * Enter/Space. Every hover action stops propagation so it can never also open the
 * detail modal, and every one of them carries an `aria-label`.
 */
import { Menu, setIcon } from "obsidian";
import {
  episodesRemaining,
  getNextUnwatchedEpisode,
  getProgress,
  toSeasonEpisode,
} from "../../data/episodes";
import type { CardContext, TitleV4 } from "../../types";
import {
  colorFor,
  episodeCode,
  progressText,
  renderAiringChip,
  renderPill,
  renderPlexBadge,
  renderProgressBar,
  renderSeasonChips,
} from "./pills";
import { plexStateOf, yearOf } from "./facets";
import { needsTmdbBackfill } from "../../services/match";
import { posterUrlFor, renderPosterPlaceholder } from "./posters";
import { createStars } from "./stars";

/**
 * Card callbacks beyond the frozen `CardContext`.
 *
 * `types.ts` is a frozen contract, so the ⋮-menu entries that need services this
 * lane does not own arrive as optional callbacks instead. An entry whose callback
 * is absent simply does not appear in the menu — the foodspot rule that a menu
 * never shows an action the data cannot support.
 */
export interface CardExtras {
  onOpenNote?: (title: TitleV4) => void;
  /** Open the manual TMDB picker. Only ever shown for an unmatched title. */
  onFindMatch?: (title: TitleV4) => void;
  onEdit?: (title: TitleV4) => void;
  onTogglePin?: (title: TitleV4) => void;
  onOpenInPlex?: (title: TitleV4) => void;
  onOpenInOverseerr?: (title: TitleV4) => void;
  onRefreshMetadata?: (title: TitleV4) => void;
  onDelete?: (title: TitleV4) => void;
}

export type CardCtx = CardContext & CardExtras;

export function buildTitleCard(
  parent: HTMLElement,
  title: TitleV4,
  ctx: CardCtx,
): HTMLElement {
  switch (ctx.variant) {
    case "compact":
      return buildCompactCard(parent, title, ctx);
    case "mini":
      return buildMiniCard(parent, title, ctx);
    default:
      return buildFullCard(parent, title, ctx);
  }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function buildPoster(parent: HTMLElement, title: TitleV4, ctx: CardCtx): HTMLElement {
  const poster = parent.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = title.title;
  const url = posterUrlFor(title);
  if (ctx.posterLoader) ctx.posterLoader.observe(poster, url);
  else renderPosterPlaceholder(poster, title.title);
  return poster;
}

function makeActivatable(
  el: HTMLElement,
  title: TitleV4,
  ctx: CardCtx,
  label: string,
): void {
  el.dataset.titleId = title.id;
  if (!ctx.onOpen) return;
  el.addClass("is-clickable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", label);
  el.addEventListener("click", () => ctx.onOpen?.(title));
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    ctx.onOpen?.(title);
  });
}

function metaLine(title: TitleV4): string {
  const parts: string[] = [];
  const year = yearOf(title);
  if (year !== null) parts.push(String(year));
  // The type is NOT repeated here: the pill row directly above already says
  // "TV Show", and printing it twice was what pushed this line onto a second
  // row on a normal-width card — which is most of why no two captions were the
  // same height.
  const progress = progressText(title);
  // `progressText` already counts every season the title holds — a show is one
  // thing, so its progress is across the whole thing (QA3). The percentage is
  // what makes that legible at a glance on a long-runner.
  if (progress) parts.push(`${progress} · ${getProgress(title)}%`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Full card
// ---------------------------------------------------------------------------

function buildFullCard(parent: HTMLElement, title: TitleV4, ctx: CardCtx): HTMLElement {
  const card = parent.createDiv({ cls: "wl-card" });
  card.toggleClass("is-favorite", title.favorite);
  if (title.pinned) card.addClass("is-pinned");
  makeActivatable(card, title, ctx, `${title.title} — open details`);

  const posterWrap = card.createDiv({ cls: "wl-card-poster" });
  buildPoster(posterWrap, title, ctx);
  posterWrap.createDiv({ cls: "wl-card-scrim" });

  if (ctx.showPlexBadge) {
    const badges = posterWrap.createDiv({ cls: "wl-card-badges" });
    renderPlexBadge(badges, title);
    if (badges.childElementCount === 0) badges.remove();
  }

  if (title.favorite) {
    const fav = posterWrap.createDiv({ cls: "wl-card-fav" });
    setIcon(fav, "heart");
    fav.setAttribute("aria-label", "Favourite");
  }

  if (ctx.showActions) buildActions(posterWrap, title, ctx);

  const body = posterWrap.createDiv({ cls: "wl-card-body" });
  body.createDiv({ cls: "wl-card-title", text: title.title });

  const pills = body.createDiv({ cls: "wl-card-pills" });
  if (title.type) {
    renderPill(pills, {
      text: title.type,
      color: colorFor(ctx.store.settings.types, title.type),
      cls: "is-type",
    });
  }
  if (title.status) {
    renderPill(pills, {
      text: title.status,
      color: colorFor(ctx.store.settings.statuses, title.status),
      cls: "is-status",
    });
  }
  if (pills.childElementCount === 0) pills.remove();

  const meta = metaLine(title);
  if (meta) body.createDiv({ cls: "wl-card-meta", text: meta });

  if (ctx.showAiringChip) {
    const chips = body.createDiv({ cls: "wl-card-airing" });
    // Where you are in a multi-season show, or that a finished one has grown
    // another season (QA3): the card carries it so nothing has to be opened.
    const seasonChip = renderSeasonChips(chips, title);
    const airingChip = renderAiringChip(chips, title);
    if (!seasonChip && !airingChip) chips.remove();
  }

  if (ctx.showRating && title.rating > 0) {
    createStars(body, {
      value: title.rating,
      tiers: ctx.store.settings.ratingSystem,
      allowHalf: ctx.store.settings.halfStarRatings,
      ariaLabel: `${title.title} rating`,
    });
  }

  if (ctx.showProgress) renderProgressBar(body, title);

  return card;
}

// ---------------------------------------------------------------------------
// Hover actions
// ---------------------------------------------------------------------------

function buildActions(parent: HTMLElement, title: TitleV4, ctx: CardCtx): HTMLElement {
  const row = parent.createDiv({ cls: "wl-card-actions" });

  const next = getNextUnwatchedEpisode(title);
  if (next !== null && episodesRemaining(title) > 0) {
    const pair = toSeasonEpisode(title, next);
    // The season's own number, not its array index: a tracker holding only
    // Season 2 has it at index 0, and announcing "S01E01" for it is a lie.
    const label = pair
      ? `Mark ${episodeCode(pair.season.seasonNumber ?? pair.seasonIndex + 1, pair.episode)} as watched`
      : `Mark episode ${next} as watched`;
    actionButton(row, "plus", label, () => {
      ctx.store.markEpisodeWatched(title.id, next, true);
    });
  }

  const trailer = title.manualTrailerUrl.trim() || title.trailerUrl.trim();
  if (ctx.onPlayTrailer && trailer && trailer !== "none") {
    actionButton(row, "play", `Play the ${title.title} trailer`, () => {
      ctx.onPlayTrailer?.(title);
    });
  }

  if (ctx.onRequest && plexStateOf(title) !== "available") {
    actionButton(row, "download", `Request ${title.title}`, () => {
      ctx.onRequest?.(title);
    });
  }

  actionButton(
    row,
    title.favorite ? "heart-off" : "heart",
    title.favorite ? "Remove from favourites" : "Mark as favourite",
    () => {
      const favorite = !title.favorite;
      ctx.store.updateTitle(
        title.id,
        favorite
          ? { favorite, dateFavorited: new Date().toISOString() }
          : { favorite, dateFavorited: undefined },
        "favorite-toggled",
      );
    },
  );

  const menuButton = actionButton(row, "more-vertical", `More actions for ${title.title}`, (
    event,
  ) => {
    openCardMenu(event, title, ctx);
  });
  // Right-clicking the card opens the same menu — one handler, two entry points.
  parent.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openCardMenu(event, title, ctx);
  });
  menuButton.addClass("wl-card-menu");

  return row;
}

function actionButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLElement {
  const button = parent.createEl("button", {
    cls: "wl-card-action",
    attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(button, icon);
  button.addEventListener("click", (event: MouseEvent) => {
    // Never let an action also open the detail modal.
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function openCardMenu(event: MouseEvent, title: TitleV4, ctx: CardCtx): void {
  const menu = new Menu();

  if (ctx.onOpen) {
    menu.addItem((item) =>
      item
        .setTitle("Open details")
        .setIcon("panel-right-open")
        .onClick(() => ctx.onOpen?.(title)),
    );
  }
  if (ctx.onOpenNote) {
    menu.addItem((item) =>
      item
        .setTitle("Open note")
        .setIcon("file-text")
        .onClick(() => ctx.onOpenNote?.(title)),
    );
  }
  if (ctx.onEdit) {
    menu.addItem((item) =>
      item
        .setTitle("Edit")
        .setIcon("pencil")
        .onClick(() => ctx.onEdit?.(title)),
    );
  }
  if (ctx.onTogglePin) {
    menu.addItem((item) =>
      item
        .setTitle(title.pinned ? "Unpin" : "Pin")
        .setIcon("pin")
        .onClick(() => ctx.onTogglePin?.(title)),
    );
  }

  menu.addSeparator();

  if (ctx.onOpenInPlex && title.plex?.ratingKey) {
    menu.addItem((item) =>
      item
        .setTitle("Open in Plex")
        .setIcon("external-link")
        .onClick(() => ctx.onOpenInPlex?.(title)),
    );
  }
  if (ctx.onOpenInOverseerr && title.tmdbId) {
    menu.addItem((item) =>
      item
        .setTitle("Open on Overseerr")
        .setIcon("external-link")
        .onClick(() => ctx.onOpenInOverseerr?.(title)),
    );
  }
  if (ctx.onRefreshMetadata) {
    menu.addItem((item) =>
      item
        .setTitle("Refresh metadata")
        .setIcon("refresh-cw")
        .onClick(() => ctx.onRefreshMetadata?.(title)),
    );
  }
  // The "needs match" affordance (QA2 report 1): a title with no TMDB id gets
  // no airing data and no reliable Plex match, so the menu says so out loud
  // rather than leaving it looking tracked.
  if (ctx.onFindMatch && needsTmdbBackfill(title)) {
    menu.addItem((item) =>
      item
        .setTitle("Match on Overseerr…")
        .setIcon("link")
        .onClick(() => ctx.onFindMatch?.(title)),
    );
  }

  if (ctx.onDelete) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => ctx.onDelete?.(title)),
    );
  }

  menu.showAtMouseEvent(event);
}

// ---------------------------------------------------------------------------
// Compact + mini
// ---------------------------------------------------------------------------

function buildCompactCard(parent: HTMLElement, title: TitleV4, ctx: CardCtx): HTMLElement {
  const row = parent.createDiv({ cls: "wl-card-row" });
  row.toggleClass("is-favorite", title.favorite);
  makeActivatable(row, title, ctx, `${title.title} — open details`);

  buildPoster(row.createDiv({ cls: "wl-card-row-poster" }), title, ctx);

  const body = row.createDiv({ cls: "wl-card-row-body" });
  body.createDiv({ cls: "wl-card-row-title", text: title.title });
  const meta = metaLine(title);
  if (meta) body.createDiv({ cls: "wl-card-row-meta", text: meta });
  if (ctx.showAiringChip) {
    renderSeasonChips(body, title);
    renderAiringChip(body, title);
  }
  if (ctx.showProgress) renderProgressBar(body, title);

  const side = row.createDiv({ cls: "wl-card-row-side" });
  if (ctx.showPlexBadge) renderPlexBadge(side, title);
  if (ctx.showRating && title.rating > 0) {
    createStars(side, {
      value: title.rating,
      tiers: ctx.store.settings.ratingSystem,
      allowHalf: ctx.store.settings.halfStarRatings,
      ariaLabel: `${title.title} rating`,
    });
  }
  if (side.childElementCount === 0) side.remove();

  return row;
}

function buildMiniCard(parent: HTMLElement, title: TitleV4, ctx: CardCtx): HTMLElement {
  const card = parent.createDiv({ cls: "wl-card-mini" });
  makeActivatable(card, title, ctx, `${title.title} — open details`);
  const posterWrap = card.createDiv({ cls: "wl-card-mini-poster" });
  buildPoster(posterWrap, title, ctx);
  if (ctx.showPlexBadge) renderPlexBadge(posterWrap, title);
  card.createDiv({ cls: "wl-card-mini-title", text: title.title });
  if (ctx.showProgress) renderProgressBar(card, title);
  return card;
}
