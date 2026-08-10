/**
 * "Do I already have this?" — the fuzzy check behind every draft card.
 *
 * A draft is a thing scribbled in a note, so it arrives misspelled, abbreviated
 * and inconsistently punctuated. Comparing it to the four libraries with `===`
 * would tell the user to add *Blade Runner 2049* on top of *Blade runner 2049*.
 * So it goes through Fuse at threshold **0.35** — v3's number, kept because the
 * behaviour people learned is calibrated to it: close enough to catch casing,
 * punctuation and a dropped article, tight enough that *Dune* does not match
 * *Dune: Part Two*.
 *
 * All four catalogues are searched at once (watchlist, books, manga, games), and
 * the caller is told *which* one hit — "already in Books" is a different sentence
 * from "already in your Watchlist", and both are more useful than "duplicate".
 *
 * Pure: it is handed arrays, not a store.
 */
import Fuse from "fuse.js";
import type { IFuseOptions } from "fuse.js";
import type {
  Book,
  Game,
  Manga,
  TitleV4,
  WidgetDomain,
} from "../../types";

/** v3's threshold. Changing it changes which drafts look like duplicates. */
export const DRAFT_MATCH_THRESHOLD = 0.35;

/** Which shelf a match came off. Finer than `WidgetDomain` on purpose. */
export type DraftLibrary = "Watchlist" | "Books" | "Manga" | "Games";

const DOMAIN_OF: Record<DraftLibrary, WidgetDomain> = {
  Watchlist: "watchlist",
  Books: "reading",
  Manga: "reading",
  Games: "games",
};

export interface DraftMatch {
  library: DraftLibrary;
  domain: WidgetDomain;
  id: string;
  title: string;
  score: number;
}

interface MatchDoc {
  title: string;
  id: string;
  library: DraftLibrary;
}

export interface DraftLibraries {
  titles: readonly TitleV4[];
  books: readonly Book[];
  manga: readonly Manga[];
  games: readonly Game[];
}

const FUSE_OPTIONS: IFuseOptions<MatchDoc> = {
  keys: ["title"],
  threshold: DRAFT_MATCH_THRESHOLD,
  includeScore: true,
  ignoreLocation: true,
};

export class DraftMatcher {
  private readonly fuse: Fuse<MatchDoc>;
  private readonly empty: boolean;

  constructor(libraries: DraftLibraries) {
    const docs: MatchDoc[] = [
      ...libraries.titles.map((t) => ({ title: t.title, id: t.id, library: "Watchlist" as const })),
      ...libraries.books.map((b) => ({ title: b.title, id: b.id, library: "Books" as const })),
      ...libraries.manga.map((m) => ({ title: m.title, id: m.id, library: "Manga" as const })),
      ...libraries.games.map((g) => ({ title: g.title, id: g.id, library: "Games" as const })),
    ];
    this.empty = docs.length === 0;
    this.fuse = new Fuse(docs, FUSE_OPTIONS);
  }

  /**
   * The best hit, or `null` when nothing is close enough.
   *
   * Fuse's own threshold already filters, but its score is re-checked here: a
   * configuration change upstream must not silently loosen what counts as
   * "already tracked".
   */
  find(text: string): DraftMatch | null {
    const needle = text.trim();
    if (this.empty || needle === "") return null;
    const best = this.fuse.search(needle)[0];
    if (!best) return null;
    const score = best.score ?? 1;
    if (score > DRAFT_MATCH_THRESHOLD) return null;
    return {
      library: best.item.library,
      domain: DOMAIN_OF[best.item.library],
      id: best.item.id,
      title: best.item.title,
      score,
    };
  }
}

/** Human sentence for a match, used on the card and in its tooltip. */
export function matchLabel(match: DraftMatch): string {
  return match.library === "Watchlist" ? "In your Watchlist" : `In ${match.library}`;
}
