/**
 * Code blocks that read the reading or games library (SPEC2 §"Surfaces that
 * grow": `domain: watchlist|reading|games` on every view).
 *
 * Why a separate module rather than making the watchlist renderer polymorphic:
 * the three libraries share a *vocabulary*, not a shape. A book has pages and no
 * episodes, a game has playtime and no cast, and each lane already owns a search
 * engine, a sort and a card for its own entities. Bending `selectTitles` and the
 * card factory over three entity types would fork every branch inside them;
 * dispatching once, here, keeps each domain's own code in charge of its own data
 * and leaves the watchlist path untouched.
 *
 * What a domain block supports is deliberately the subset that means something:
 * `cards`/`list`/`table`/`random`/`shortlist` (rows), `stat` (its own numbers)
 * and `upcoming` (its release rows). `now` is a watchlist idea — "what am I
 * mid-episode on" — and says so rather than rendering an empty box.
 */
import { setIcon } from "obsidian";
import type {
  Book,
  Game,
  GamesData,
  Manga,
  ReadingData,
  WidgetSpec,
  WidgetStat,
} from "../types";
import { derivedStatus, readingProgress } from "../domains/reading/progress";
import { searchReading } from "../domains/reading/query";
import { bookStats, computeReadingStats, mangaStats } from "../domains/reading/stats";
import { searchGames } from "../domains/games/query";
import {
  achievementText,
  formatPlaytime,
  gameProgress,
  gamesCompletedStat,
  timePlayedStat,
} from "../domains/games/stats";

export type ReadingEntryLike = Book | Manga;

/** One row, flattened so the renderer does not branch per entity type. */
export interface DomainRow {
  id: string;
  title: string;
  /** Author, developer — the line under the name. */
  subtitle: string;
  status: string;
  /** 0–100. */
  percent: number;
  /** The domain's own headline number: `312 pages`, `70 h`, `12/24 chapters`. */
  metric: string;
  coverUrl: string;
  favorite: boolean;
  rating: number;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function matchesFilters(row: { status: string; favorite: boolean; rating: number }, spec: WidgetSpec): boolean {
  if (spec.statuses.length > 0 && !spec.statuses.some((s) => s.toLowerCase() === row.status.toLowerCase())) {
    return false;
  }
  if (spec.favorite !== undefined && row.favorite !== spec.favorite) return false;
  // Unrated entries always pass a minimum, exactly as on the watchlist: a `0`
  // means "not rated", not "rated zero".
  if (spec.minRating !== undefined && row.rating > 0 && row.rating < spec.minRating) return false;
  return true;
}

function pinnedFilter<T extends { id: string; title: string }>(pool: readonly T[], spec: WidgetSpec): T[] {
  if (spec.ids.length === 0 && spec.titles.length === 0) return [...pool];
  const ids = new Set(spec.ids.map((id) => id.toLowerCase()));
  const titles = new Set(spec.titles.map((t) => t.toLowerCase()));
  return pool.filter(
    (entry) => ids.has(entry.id.toLowerCase()) || titles.has(entry.title.toLowerCase()),
  );
}

export interface DomainSelectOptions {
  now?: Date;
  /** Ignore `spec.limit` — the stat and random views need the whole pool. */
  unlimited?: boolean;
}

/** Reading entries a block selects, in the spec's order, capped by its limit. */
export function selectReading(
  reading: ReadingData,
  spec: WidgetSpec,
  options: DomainSelectOptions = {},
): ReadingEntryLike[] {
  const now = options.now ?? new Date();
  const kind = spec.readingKind;
  const pool: ReadingEntryLike[] = [
    ...(kind === "manga" ? [] : reading.books),
    ...(kind === "book" ? [] : reading.manga),
  ];

  let rows = pinnedFilter(pool, spec);
  // The lane's own engine, so a block understands `author:` exactly as the tab does.
  if (spec.authors && spec.authors.length > 0) {
    rows = searchReading(rows, spec.authors.map((a) => `author:"${a}"`).join(" "), {
      columns: [...reading.bookColumns, ...reading.mangaColumns],
    }) as ReadingEntryLike[];
  }
  rows = rows.filter((entry) =>
    matchesFilters(
      { status: derivedStatus(entry, now), favorite: entry.favorite, rating: entry.rating },
      spec,
    ),
  );

  rows.sort((a, b) => {
    if (spec.sort === "title") return a.title.localeCompare(b.title);
    if (spec.sort === "rating") return b.rating - a.rating;
    if (spec.sort === "progress") return readingProgress(b) - readingProgress(a);
    if (spec.sort === "releaseDate") return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    return (b.dateAdded ?? "").localeCompare(a.dateAdded ?? "");
  });
  if (spec.direction === "asc" && spec.sort !== "title") rows.reverse();

  return options.unlimited ? rows : rows.slice(0, Math.max(1, spec.limit));
}

export function selectGames(
  games: GamesData,
  spec: WidgetSpec,
  options: DomainSelectOptions = {},
): Game[] {
  let rows = pinnedFilter(games.games, spec);

  const terms: string[] = [];
  for (const platform of spec.platforms ?? []) terms.push(`platform:"${platform}"`);
  for (const genre of spec.genres) terms.push(`genre:"${genre}"`);
  if (terms.length > 0) rows = searchGames(rows, terms.join(" "));

  rows = rows.filter((game) =>
    matchesFilters({ status: game.status, favorite: game.favorite, rating: game.rating }, spec),
  );

  rows.sort((a, b) => {
    if (spec.sort === "title") return a.title.localeCompare(b.title);
    if (spec.sort === "rating") return b.rating - a.rating;
    if (spec.sort === "progress") return gameProgress(b) - gameProgress(a);
    if (spec.sort === "releaseDate") return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
    if (spec.sort === "timeLeft") return b.playtimeMinutes - a.playtimeMinutes;
    return (b.dateAdded ?? "").localeCompare(a.dateAdded ?? "");
  });
  if (spec.direction === "asc" && spec.sort !== "title") rows.reverse();

  return options.unlimited ? rows : rows.slice(0, Math.max(1, spec.limit));
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

function isBook(entry: ReadingEntryLike): entry is Book {
  return "totalPages" in entry;
}

export function readingRow(entry: ReadingEntryLike, now: Date = new Date()): DomainRow {
  const metric = isBook(entry)
    ? entry.progressUnit === "words"
      ? `${entry.wordsRead.toLocaleString()} of ${entry.totalWords.toLocaleString()} words`
      : `${entry.pagesRead} of ${entry.totalPages} pages`
    : `${entry.chaptersRead} of ${entry.totalChapters} chapters`;
  return {
    id: entry.id,
    title: entry.title,
    subtitle: entry.author,
    status: derivedStatus(entry, now),
    percent: readingProgress(entry),
    metric,
    coverUrl: entry.coverUrl,
    favorite: entry.favorite,
    rating: entry.rating,
  };
}

export function gameRow(game: Game): DomainRow {
  const parts: string[] = [];
  if (game.playtimeMinutes > 0) parts.push(formatPlaytime(game.playtimeMinutes));
  const achievements = achievementText(game);
  if (achievements) parts.push(achievements);
  return {
    id: game.id,
    title: game.title,
    subtitle: game.developer || game.type,
    status: game.status,
    percent: gameProgress(game),
    metric: parts.join(" · "),
    coverUrl: game.coverUrl,
    favorite: game.favorite,
    rating: game.rating,
  };
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export interface DomainStat {
  value: string;
  label: string;
  /** The smaller line under the number. */
  detail?: string;
}

/** What a `view: stat` block resolves to for a parity library. */
export function domainStat(
  stat: WidgetStat,
  reading: ReadingData,
  games: GamesData,
  now: Date = new Date(),
): DomainStat {
  switch (stat) {
    case "pages-read": {
      const books = bookStats(reading.books, now);
      return {
        value: books.pagesRead.toLocaleString(),
        label: "Pages read",
        detail: books.pagesTotal > 0 ? `of ${books.pagesTotal.toLocaleString()}` : undefined,
      };
    }
    case "reading-completed": {
      const stats = computeReadingStats(reading, now);
      return {
        value: String(stats.totalCompleted),
        label: "Finished",
        detail: `${stats.percent}% of ${stats.totalEntries}`,
      };
    }
    case "time-played": {
      const played = timePlayedStat(games.games);
      return {
        value: played.label,
        label: "Time played",
        detail: `across ${played.games} game${played.games === 1 ? "" : "s"}`,
      };
    }
    case "games-completed": {
      const done = gamesCompletedStat(games.games);
      return {
        value: String(done.finished),
        label: "Finished",
        detail: `${done.percent}% of ${done.counted}`,
      };
    }
    case "completed": {
      const stats = computeReadingStats(reading, now);
      return { value: String(stats.totalCompleted), label: "Finished" };
    }
    case "counts":
    default: {
      const manga = mangaStats(reading.manga, now);
      const books = bookStats(reading.books, now);
      return {
        value: String(books.total + manga.total),
        label: "Entries",
        detail: `${books.total} books · ${manga.total} manga`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface DomainRenderDeps {
  onOpen?: (domain: "reading" | "games", id: string) => void;
}

function renderRow(parent: HTMLElement, row: DomainRow, deps: DomainRenderDeps, domain: "reading" | "games"): void {
  const el = parent.createDiv({ cls: "wl-widget-domain-row" });

  const cover = el.createDiv({ cls: "wl-widget-domain-cover" });
  if (row.coverUrl) {
    const img = cover.createEl("img", { cls: "wl-widget-domain-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.src = row.coverUrl;
  } else {
    cover.createSpan({ cls: "wl-widget-domain-initial", text: (row.title[0] ?? "?").toUpperCase() });
  }

  const body = el.createDiv({ cls: "wl-widget-domain-body" });
  body.createDiv({ cls: "wl-widget-domain-name", text: row.title });
  const meta = [row.subtitle, row.metric].filter((part) => part !== "").join(" · ");
  if (meta) body.createDiv({ cls: "wl-widget-domain-meta", text: meta });

  if (row.percent > 0 && row.percent < 100) {
    const track = body.createDiv({ cls: "wl-progress" });
    track.createDiv({ cls: "wl-progress-fill" }).style.setProperty("--wl-progress", `${row.percent}%`);
  }

  el.createSpan({ cls: "wl-widget-domain-status", text: row.status });

  if (deps.onOpen) {
    el.addClass("is-clickable");
    el.setAttr("role", "button");
    el.tabIndex = 0;
    const open = (): void => deps.onOpen?.(domain, row.id);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }
}

function renderEmpty(parent: HTMLElement, text: string): void {
  const el = parent.createDiv({ cls: "wl-widget-empty" });
  setIcon(el.createSpan({ cls: "wl-widget-empty-icon" }), "info");
  el.createSpan({ text });
}

/**
 * Render a block that reads a parity library.
 *
 * Returns `false` when the view has no meaning for this domain, so the caller
 * can say so rather than drawing an empty container.
 */
export function renderDomainBlock(
  el: HTMLElement,
  spec: WidgetSpec,
  reading: ReadingData,
  games: GamesData,
  deps: DomainRenderDeps = {},
  now: Date = new Date(),
): boolean {
  const domain = spec.domain === "games" ? "games" : "reading";

  if (spec.view === "now") {
    // "Now" is a watchlist idea: the episode you are mid-way through. Books and
    // games have progress but no next-episode, so the honest answer is to say
    // which view to use instead.
    renderEmpty(
      el,
      `“now” only makes sense for the watchlist. For ${domain}, try view: list with status: ${
        domain === "reading" ? "Reading" : "Playing"
      }.`,
    );
    return true;
  }

  if (spec.view === "stat") {
    const stat = domainStat(spec.stat ?? (domain === "games" ? "time-played" : "pages-read"), reading, games, now);
    const block = el.createDiv({ cls: "wl-widget-stat" });
    block.createDiv({ cls: "wl-widget-stat-value", text: stat.value });
    block.createDiv({ cls: "wl-widget-stat-label", text: stat.label });
    if (stat.detail) block.createDiv({ cls: "wl-widget-stat-detail", text: stat.detail });
    return true;
  }

  const rows =
    domain === "games"
      ? selectGames(games, spec, { now, unlimited: spec.view === "random" }).map(gameRow)
      : selectReading(reading, spec, { now, unlimited: spec.view === "random" }).map((entry) =>
          readingRow(entry, now),
        );

  if (rows.length === 0) {
    renderEmpty(
      el,
      domain === "games"
        ? "No games match this block."
        : "No books or manga match this block.",
    );
    return true;
  }

  // `random` picks one from the whole pool; every other view is a list.
  const shown = spec.view === "random" ? [rows[Math.floor(Math.random() * rows.length)] as DomainRow] : rows;
  const list = el.createDiv({ cls: `wl-widget-domain-list is-${spec.view}` });
  for (const row of shown) renderRow(list, row, deps, domain);
  return true;
}
