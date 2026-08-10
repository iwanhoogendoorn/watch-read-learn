/**
 * The game card.
 *
 * Same anatomy as `ui/components/card.ts` — cover, scrim, pills, hover actions,
 * a body that answers "where am I with this" — with the two numbers a games
 * library exists for on the front: **time played** and **achievements**. Titles
 * and games are different enough (no episodes, no Plex, no request) that sharing
 * the implementation would mean a context object of mostly-absent callbacks; the
 * shared pieces (pills, stars, the poster loader, the placeholder) *are* reused.
 *
 * Class namespace is `wl-game-*`, which is what keeps the one-class-one-component
 * invariant in `tests/styles.test.ts` true across partials.
 */
import { Menu, setIcon } from "obsidian";
import { colorFor, renderPill } from "../../ui/components/pills";
import { renderPosterPlaceholder } from "../../ui/components/posters";
import { createStars } from "../../ui/components/stars";
import type { Game, GamesSettings, PosterLoader, RatingTier } from "../../types";
import {
  achievementPercent,
  achievementText,
  formatPlaytime,
  gameProgress,
  gameYear,
} from "./stats";

export interface GameCardContext {
  settings: GamesSettings;
  ratingTiers: readonly RatingTier[];
  halfStars: boolean;
  variant: "full" | "compact";
  posterLoader?: PosterLoader;
  showActions?: boolean;
  onOpen?: (game: Game) => void;
  onEdit?: (game: Game) => void;
  onToggleFavorite?: (game: Game) => void;
  onToggleWishlist?: (game: Game) => void;
  onOpenStore?: (game: Game) => void;
  onOpenNote?: (game: Game) => void;
  onDelete?: (game: Game) => void;
  /** Chip → filtered list, e.g. `platform:"Windows PC"`. */
  onJumpToQuery?: (query: string) => void;
}

export function buildGameCard(
  parent: HTMLElement,
  game: Game,
  ctx: GameCardContext,
): HTMLElement {
  return ctx.variant === "compact"
    ? buildCompactCard(parent, game, ctx)
    : buildFullCard(parent, game, ctx);
}

function buildCover(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  // `wl-poster` is the shared poster element — same loader, same placeholder,
  // same negative-result cache. IGDB's `t_cover_big` URLs are absolute, so they
  // pass straight through `resolvePosterUrl`.
  const poster = parent.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = game.title;
  if (ctx.posterLoader) ctx.posterLoader.observe(poster, game.coverUrl);
  else renderPosterPlaceholder(poster, game.title);
  return poster;
}

function makeActivatable(el: HTMLElement, game: Game, ctx: GameCardContext): void {
  el.dataset.gameId = game.id;
  if (!ctx.onOpen) return;
  el.addClass("is-clickable");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", `${game.title} — open details`);
  el.addEventListener("click", () => ctx.onOpen?.(game));
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    ctx.onOpen?.(game);
  });
}

/** `2020 · RPG · Windows PC` — what the card says under the name. */
export function gameMetaLine(game: Game): string {
  const parts: string[] = [];
  const year = gameYear(game);
  if (year !== null) parts.push(String(year));
  if (game.type) parts.push(game.type);
  const platforms = (game.platforms ?? []).filter((platform) => platform.trim() !== "");
  if (platforms.length > 0) {
    parts.push(platforms.length > 2 ? `${platforms[0]} +${platforms.length - 1}` : platforms.join(", "));
  }
  return parts.join(" · ");
}

function renderStats(host: HTMLElement, game: Game): void {
  const playtime = game.playtimeMinutes > 0 ? formatPlaytime(game.playtimeMinutes) : "";
  if (playtime) {
    const el = host.createSpan({ cls: "wl-game-playtime" });
    setIcon(el.createSpan({ cls: "wl-game-stat-icon" }), "timer");
    el.createSpan({ text: playtime });
    el.setAttribute("title", `${game.playtimeMinutes} minutes played`);
  }
  const achievements = achievementText(game);
  if (achievements) {
    const percent = achievementPercent(game);
    const el = host.createSpan({ cls: "wl-game-achievements" });
    setIcon(el.createSpan({ cls: "wl-game-stat-icon" }), "trophy");
    el.createSpan({ text: achievements });
    el.setAttribute("title", `${percent ?? 0}% of achievements earned`);
  }
}

function renderProgress(host: HTMLElement, game: Game): HTMLElement | null {
  const percent = gameProgress(game);
  if (percent <= 0) return null;
  const bar = host.createDiv({ cls: "wl-game-progress" });
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent));
  bar.setAttribute("aria-label", `${percent}% through ${game.title}`);
  const fill = bar.createDiv({ cls: "wl-game-progress-fill" });
  fill.style.width = `${percent}%`;
  return bar;
}

function buildFullCard(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const card = parent.createDiv({ cls: "wl-game-card" });
  card.toggleClass("is-favorite", game.favorite);
  card.toggleClass("is-wishlist", game.wishlist);
  makeActivatable(card, game, ctx);

  const coverWrap = card.createDiv({ cls: "wl-game-card-cover" });
  buildCover(coverWrap, game, ctx);
  coverWrap.createDiv({ cls: "wl-game-card-scrim" });

  if (game.wishlist) {
    const badge = coverWrap.createDiv({ cls: "wl-game-badge" });
    setIcon(badge.createSpan({ cls: "wl-game-badge-icon" }), "gift");
    badge.createSpan({ cls: "wl-game-badge-text", text: "Wishlist" });
    badge.setAttribute("title", "On your wishlist");
  }

  if (game.favorite) {
    const fav = coverWrap.createDiv({ cls: "wl-game-fav" });
    setIcon(fav, "heart");
    fav.setAttribute("aria-label", "Favourite");
  }

  if (ctx.showActions !== false) buildActions(coverWrap, game, ctx);

  const body = coverWrap.createDiv({ cls: "wl-game-card-body" });
  body.createDiv({ cls: "wl-game-card-title", text: game.title });

  const pills = body.createDiv({ cls: "wl-game-card-pills" });
  if (game.type) {
    renderPill(pills, {
      text: game.type,
      color: colorFor(ctx.settings.types, game.type),
      cls: "is-type",
    });
  }
  if (game.status) {
    renderPill(pills, {
      text: game.status,
      color: colorFor(ctx.settings.statuses, game.status),
      cls: "is-status",
    });
  }
  if (pills.childElementCount === 0) pills.remove();

  const meta = gameMetaLine(game);
  if (meta) body.createDiv({ cls: "wl-game-card-meta", text: meta });

  const stats = body.createDiv({ cls: "wl-game-card-stats" });
  renderStats(stats, game);
  if (stats.childElementCount === 0) stats.remove();

  if (game.rating > 0) {
    createStars(body, {
      value: game.rating,
      tiers: ctx.ratingTiers,
      allowHalf: ctx.halfStars,
      ariaLabel: `${game.title} rating`,
    });
  }

  renderProgress(body, game);
  return card;
}

function buildCompactCard(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const row = parent.createDiv({ cls: "wl-game-row" });
  row.toggleClass("is-favorite", game.favorite);
  makeActivatable(row, game, ctx);

  buildCover(row.createDiv({ cls: "wl-game-row-cover" }), game, ctx);

  const body = row.createDiv({ cls: "wl-game-row-body" });
  body.createDiv({ cls: "wl-game-row-title", text: game.title });
  const meta = gameMetaLine(game);
  if (meta) body.createDiv({ cls: "wl-game-card-meta", text: meta });
  const stats = body.createDiv({ cls: "wl-game-card-stats" });
  renderStats(stats, game);
  if (stats.childElementCount === 0) stats.remove();
  renderProgress(body, game);

  const side = row.createDiv({ cls: "wl-game-row-side" });
  if (game.status) {
    renderPill(side, {
      text: game.status,
      color: colorFor(ctx.settings.statuses, game.status),
      cls: "is-status",
    });
  }
  if (game.rating > 0) {
    createStars(side, {
      value: game.rating,
      tiers: ctx.ratingTiers,
      allowHalf: ctx.halfStars,
      ariaLabel: `${game.title} rating`,
    });
  }
  if (side.childElementCount === 0) side.remove();

  return row;
}

// ---------------------------------------------------------------------------
// Hover actions
// ---------------------------------------------------------------------------

function actionButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: (event: MouseEvent) => void,
): HTMLElement {
  const button = parent.createEl("button", {
    cls: "wl-game-action",
    attr: { type: "button", "aria-label": label, title: label },
  });
  setIcon(button, icon);
  button.addEventListener("click", (event: MouseEvent) => {
    // An action must never also open the detail modal.
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function buildActions(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const row = parent.createDiv({ cls: "wl-game-actions" });

  if (ctx.onToggleFavorite) {
    actionButton(
      row,
      game.favorite ? "heart-off" : "heart",
      game.favorite ? "Remove from favourites" : "Mark as favourite",
      () => ctx.onToggleFavorite?.(game),
    );
  }

  // Only offered when there is somewhere to go — an affordance the data cannot
  // support is not shown.
  const store = game.storeUrl.trim() || game.externalLink.trim();
  if (ctx.onOpenStore && store !== "") {
    actionButton(row, "external-link", `Open the store page for ${game.title}`, () => {
      ctx.onOpenStore?.(game);
    });
  }

  const menuButton = actionButton(row, "more-vertical", `More actions for ${game.title}`, (event) => {
    openGameMenu(event, game, ctx);
  });
  menuButton.addClass("wl-game-menu");
  parent.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openGameMenu(event, game, ctx);
  });

  return row;
}

function openGameMenu(event: MouseEvent, game: Game, ctx: GameCardContext): void {
  const menu = new Menu();

  if (ctx.onOpen) {
    menu.addItem((item) =>
      item.setTitle("Open details").setIcon("panel-right-open").onClick(() => ctx.onOpen?.(game)),
    );
  }
  if (ctx.onEdit) {
    menu.addItem((item) => item.setTitle("Edit").setIcon("pencil").onClick(() => ctx.onEdit?.(game)));
  }
  if (ctx.onOpenNote) {
    menu.addItem((item) =>
      item.setTitle("Open note").setIcon("file-text").onClick(() => ctx.onOpenNote?.(game)),
    );
  }
  if (ctx.onToggleWishlist) {
    menu.addItem((item) =>
      item
        .setTitle(game.wishlist ? "Remove from wishlist" : "Add to wishlist")
        .setIcon("gift")
        .onClick(() => ctx.onToggleWishlist?.(game)),
    );
  }

  const store = game.storeUrl.trim() || game.externalLink.trim();
  if (ctx.onOpenStore && store !== "") {
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Open store page").setIcon("external-link").onClick(() => ctx.onOpenStore?.(game)),
    );
  }

  if (ctx.onDelete) {
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => ctx.onDelete?.(game)),
    );
  }

  menu.showAtMouseEvent(event);
}
