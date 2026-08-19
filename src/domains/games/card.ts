/**
 * The game card — the Games tab's half of the plugin's signature grid.
 *
 * ## Not a third card
 *
 * The frame is `buildPosterCard` from `ui/components/card.ts`: the same 2:3
 * poster, the same dark scrim caption, the same badge and heart corners, the
 * same hover action column, the same focus and selection outlines, the same
 * `@media (hover: none)` and reduced-motion handling. Every class the card wears
 * — `.wl-card`, `.wl-card-poster`, `.wl-poster`, `.wl-card-badges`,
 * `.wl-card-fav`, `.wl-card-actions`, `.wl-card-action`, `.wl-card-body`,
 * `.wl-card-title`, `.wl-card-pills`, `.wl-card-meta`, `.wl-card-rating-empty`,
 * `.wl-progress` — is declared exactly once, in `styles/20-cards.css`, and is
 * the *same* declaration the Library's and the Reading tab's cards read.
 *
 * This card used to build its own caption furniture in the `.wl-game-*`
 * namespace, which predated the scrim rework and therefore stopped matching the
 * day that landed: same grid, same cell size, different-looking component. The
 * book card (`domains/reading/card.ts`) is the worked example of adapting a
 * non-title record onto the shared classes without forking them, and this is the
 * same move again.
 *
 * ## What a game card says, and what it does not
 *
 * Cover, title, genre, status, year, playtime, achievements, progress, rating,
 * and a wishlist badge in the corner. No episode counter, no Plex badge, no
 * airing chip: a game has no next episode and is not on anyone's Plex, and an
 * empty pill is worse than no pill. The caption rows a game *does* have hold
 * their height whether or not they are filled, for the same reason a title
 * card's do — a row that collapses is a poster cropped on a different line from
 * its neighbour, and a grid of those reads as ragged however good each card is.
 *
 * The two numbers a games library exists for — time played and achievements —
 * used to have a row of their own. They are on the meta line now, keeping their
 * timer and trophy icons, because a row of their own is exactly what made this
 * caption a different height from every other caption in the plugin. The line is
 * one line and truncates rather than wrapping, so what it carries is rationed:
 * see `gameMetaLine`.
 *
 * The only `.wl-game-*` classes left are the three the caption genuinely needs
 * and the shared set does not have — the two stat spans and their icon — plus
 * the wishlist badge that rides in the shared badge slot. They are declared in
 * `styles/91-games.css` and re-declare nothing from `20-cards.css`.
 */
import { Menu, setIcon } from "obsidian";
import {
  buildPosterCard,
  cardActionButton,
  type PosterCardSpec,
} from "../../ui/components/card";
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

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

/**
 * Point an existing `.wl-poster` box at the game's cover.
 *
 * IGDB's `t_cover_big` is 264×374 — 1:1.417 against the frame's 1:1.5 — and the
 * shared `.wl-poster-img` is `object-fit: cover`, so the ratio is preserved and
 * about 5% comes off the sides. No distortion, no letterboxing, and *no change*
 * from what this card did before: the old `.wl-game-card-cover` was `inset: 0`
 * on a grid cell that is already `width × 1.5`, so the crop is identical.
 * A pasted cover of any other shape is cropped rather than squashed, which is
 * the same bargain every poster in the plugin makes.
 */
function fillCover(poster: HTMLElement, game: Game, ctx: GameCardContext): void {
  poster.dataset.posterSeed = game.title;
  // IGDB's URLs are absolute, so they pass straight through `resolvePosterUrl`.
  if (ctx.posterLoader) ctx.posterLoader.observe(poster, game.coverUrl);
  else renderPosterPlaceholder(poster, game.title);
}

function buildCover(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const poster = parent.createDiv({ cls: "wl-poster" });
  fillCover(poster, game, ctx);
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

// ---------------------------------------------------------------------------
// The caption's own small pieces
// ---------------------------------------------------------------------------

/** `Windows PC`, `PS5, Switch`, `Windows PC +2`. `""` when none are recorded. */
export function platformSummary(game: Game): string {
  const platforms = (game.platforms ?? []).filter((platform) => platform.trim() !== "");
  if (platforms.length === 0) return "";
  return platforms.length > 2
    ? `${platforms[0]} +${platforms.length - 1}`
    : platforms.join(", ");
}

/** Whether the game has either of the two numbers the meta line prints. */
function hasNumbers(game: Game): boolean {
  return game.playtimeMinutes > 0 || achievementText(game) !== "";
}

/**
 * The text half of the meta line — everything before the numbers.
 *
 * `2020`, or `2020 · Windows PC` for a game with nothing played and nothing
 * earned. The line is one line at `--font-ui-smaller` inside a caption that is
 * 144px wide on a default card, which is about 24 characters: year, playtime and
 * achievements together already spend all of it, and appending a platform on top
 * would push the achievements — the number a card is most often *for* — off the
 * end behind an ellipsis. So the platform takes the space the numbers are not
 * using, and on a played game it stays where it is already legible: the table's
 * Platforms column, the detail modal's platform pills, and the platform filter.
 *
 * The genre is NOT repeated here. The pill directly above already says it, and
 * printing it twice is the same mistake the title card's meta line was fixed for
 * — it is what pushed this line onto a second row on a normal-width card.
 */
export function gameMetaLine(game: Game): string {
  const parts: string[] = [];
  const year = gameYear(game);
  if (year !== null) parts.push(String(year));
  if (!hasNumbers(game)) {
    const platforms = platformSummary(game);
    if (platforms !== "") parts.push(platforms);
  }
  return parts.join(" · ");
}

/**
 * Draw the meta line into an existing row: the text, then the numbers.
 *
 * Spans rather than one string, because the two stats keep their icons — a timer
 * and a trophy are read faster than the words would be, and they are what tells
 * `70 h` apart from `49 / 49` when the line truncates. They carry no colour and
 * no size of their own: on a card they inherit the scrim's ink from
 * `.wl-card-meta`, in a compact row the theme's muted from `.wl-card-row-meta`.
 */
export function renderGameMeta(host: HTMLElement, game: Game): void {
  let written = false;
  const separate = (): void => {
    if (written) host.createSpan({ text: " · " });
    written = true;
  };

  const text = gameMetaLine(game);
  if (text !== "") {
    separate();
    host.createSpan({ text });
  }

  if (game.playtimeMinutes > 0) {
    separate();
    const el = host.createSpan({ cls: "wl-game-playtime" });
    setIcon(el.createSpan({ cls: "wl-game-stat-icon" }), "timer");
    el.createSpan({ text: formatPlaytime(game.playtimeMinutes) });
    el.setAttribute("title", `${game.playtimeMinutes} minutes played`);
  }

  const achievements = achievementText(game);
  if (achievements !== "") {
    separate();
    const el = host.createSpan({ cls: "wl-game-achievements" });
    setIcon(el.createSpan({ cls: "wl-game-stat-icon" }), "trophy");
    el.createSpan({ text: achievements });
    el.setAttribute("title", `${achievementPercent(game) ?? 0}% of achievements earned`);
  }
}

/**
 * The filmstrip at the bottom of the caption — the same `.wl-progress` the
 * Library's and the Reading tab's cards draw, so it gets the same sprocket-hole
 * treatment from `.wl-card-body .wl-progress`.
 *
 * `null` at zero. A game you have not started is not "0% through", and a bar
 * pinned at nothing says the wrong thing; the strip is reserved by the caption's
 * padding either way, so leaving it out costs no alignment.
 */
export function renderGameBar(host: HTMLElement, game: Game): HTMLElement | null {
  const percent = gameProgress(game);
  if (percent <= 0) return null;
  const bar = host.createDiv({ cls: "wl-progress" });
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(percent));
  bar.setAttribute("aria-label", `${percent}% through ${game.title}`);
  bar.createDiv({ cls: "wl-progress-fill" }).style.width = `${percent}%`;
  return bar;
}

// ---------------------------------------------------------------------------
// Full card
// ---------------------------------------------------------------------------

function buildFullCard(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const spec: PosterCardSpec = {
    ariaLabel: `${game.title} — open details`,
    favorite: game.favorite,
    renderPoster: (poster) => fillCover(poster, game, ctx),
    renderBody: (body) => buildGameBody(body, game, ctx),
  };
  if (ctx.onOpen) spec.onActivate = () => ctx.onOpen?.(game);
  // The corner badge is Plex availability on a title and nothing at all on a
  // book. On a game it is the one thing a *cover* cannot tell you: that you do
  // not own this yet. The shell removes the row again if nothing goes in it.
  if (game.wishlist) spec.renderBadges = (badges) => renderWishlistBadge(badges);
  // `!== false`, not truthiness: this card has always shown its actions unless
  // a caller explicitly turned them off.
  if (ctx.showActions !== false) {
    spec.renderActions = (row) => buildActions(row, game, ctx);
    spec.onContextMenu = (event) => openGameMenu(event, game, ctx);
  }

  const card = buildPosterCard(parent, spec);
  card.dataset.gameId = game.id;
  card.toggleClass("is-wishlist", game.wishlist);
  return card;
}

function renderWishlistBadge(badges: HTMLElement): HTMLElement {
  const badge = badges.createDiv({ cls: "wl-game-badge" });
  setIcon(badge.createSpan({ cls: "wl-game-badge-icon" }), "gift");
  badge.createSpan({ cls: "wl-game-badge-text", text: "Wishlist" });
  badge.setAttribute("title", "On your wishlist");
  return badge;
}

function buildGameBody(body: HTMLElement, game: Game, ctx: GameCardContext): void {
  body.createDiv({ cls: "wl-card-title", text: game.title });

  // Genre first, status second — the same order and the same two settings-backed
  // colours a title card's type and status pills carry. The row is capped at one
  // line and the CSS pins `:first-child`, so the short, fixed genre keeps its
  // name and a long status ("To be released") is the one that gives way.
  const pills = body.createDiv({ cls: "wl-card-pills" });
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
  // The row is kept even when a game has neither — every caption row holds its
  // height so that every poster in the grid crops on the same line.

  renderGameMeta(body.createDiv({ cls: "wl-card-meta" }), game);

  if (game.rating > 0) {
    createStars(body, {
      value: game.rating,
      tiers: ctx.ratingTiers,
      allowHalf: ctx.halfStars,
      ariaLabel: `${game.title} rating`,
    });
  } else {
    // Holds the line an unrated game would otherwise not occupy. Empty rather
    // than a row of grey stars: "not rated" should read as absence, not as a
    // score of zero.
    body.createDiv({ cls: "wl-card-rating-empty" });
  }

  renderGameBar(body, game);
}

// ---------------------------------------------------------------------------
// Compact row
// ---------------------------------------------------------------------------

function buildCompactCard(parent: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
  const row = parent.createDiv({ cls: "wl-card-row" });
  row.toggleClass("is-favorite", game.favorite);
  makeActivatable(row, game, ctx);

  buildCover(row.createDiv({ cls: "wl-card-row-poster" }), game, ctx);

  const body = row.createDiv({ cls: "wl-card-row-body" });
  body.createDiv({ cls: "wl-card-row-title", text: game.title });
  renderGameMeta(body.createDiv({ cls: "wl-card-row-meta" }), game);
  renderGameBar(body, game);

  const side = row.createDiv({ cls: "wl-card-row-side" });
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

/** The card's own name for the shared button, kept so the call sites read short. */
const actionButton = cardActionButton;

function buildActions(row: HTMLElement, game: Game, ctx: GameCardContext): HTMLElement {
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

  const menuButton = actionButton(row, "more-vertical", `More actions for ${game.title}`, (
    event,
  ) => {
    openGameMenu(event, game, ctx);
  });
  // The right-click half of the same menu lives on the shell — see the
  // `onContextMenu` this card hands it.
  menuButton.addClass("wl-card-menu");

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
