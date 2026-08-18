/**
 * The author screen — the reading-side sibling of `ui/views/person.ts`.
 *
 * An author name on a book used to do one thing: run `author:"Frank Herbert"`,
 * which can only ever show you what you already own. A cast name stopped doing
 * that when the person screen landed; this is the same lift for the other half
 * of the plugin. Who they are, and **everything else they wrote**, with the
 * books you do not have carrying a `+ Add`.
 *
 * It holds to the person screen's three rules, and to two more that belong to
 * this provider:
 *
 *   - **Cached opens are offline.** An author opened once renders from
 *     `data.json` with no request at all (`services/openlibrary-author.ts` owns
 *     the cache). A stale entry still paints immediately and refreshes behind
 *     the screen; the network is never between the user and the page.
 *   - **Owned is owned.** A work already on the shelf is drawn as such and opens
 *     its detail modal. It is never offered back as `+ Add`.
 *   - **Adding goes through the one add path.** `+ Add` hands a
 *     `BookSearchResult` to the caller's add closure — the same shape
 *     `seedFromHit` in `domains/reading/modals/add.ts` takes, so there is no
 *     second way to create a book here.
 *   - **Every cover goes through `domains/reading/covers.ts`.** An
 *     `<img src="https://covers.openlibrary.org/…">` is Chromium's request: it
 *     carries none of our headers and passes through none of our limiter, and a
 *     bibliography is forty of them at once. See that file's header.
 *   - **Nothing here picks between two authors of the same name.** Resolution,
 *     including the ambiguous case, is the service's job and is not second-
 *     guessed on screen.
 *
 * The renderer (`mountAuthorScreen`) is a plain DOM function so it can be
 * mounted headlessly in tests; `AuthorView` is the Obsidian shell around it and
 * holds no rendering logic of its own.
 */
import {
  ItemView,
  Notice,
  setIcon,
  type App,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type { Book, BookSearchResult, MountHandle, OpenLibraryClient } from "../../types";
import type { AuthorCandidate, OpenLibraryAuthor } from "../../services/openlibrary";
import {
  ownedBookFor,
  type AuthorCacheEntry,
  type AuthorService,
} from "../../services/openlibrary-author";
import { CoverPool, loadCover, type CoverCache } from "../../domains/reading/covers";
import { relativeTime } from "../components/pills";
import { renderPosterPlaceholder } from "../components/posters";

export const VIEW_TYPE_AUTHOR = "watchlog-author-view";
export const AUTHOR_VIEW_ICON = "pen-line";
export const AUTHOR_VIEW_DISPLAY_NAME = "Author";

/**
 * Who to open.
 *
 * A `key` is an identity and needs no resolving. A bare `name` is what the rest
 * of the plugin has — `Book.author` is a string — and has to be turned into one,
 * which is where the ambiguous case lives.
 */
export interface AuthorTarget {
  key?: string;
  name?: string;
}

export interface AuthorScreenDeps {
  authors: AuthorService;
  /** Library books, for the owned/not-owned decision. Read fresh every render. */
  books(): readonly Book[];
  /** Open a book already on the shelf. */
  onOpenBook(book: Book): void;
  /** The plugin's one add path. Resolves to the created book, or undefined. */
  onAdd(work: BookSearchResult): Promise<Book | undefined>;
  /** Jump to Reading filtered by this author, for "show only what I own". */
  onJumpToQuery?(query: string): void;
  /** Open an external URL (Open Library, Wikipedia). Omit to hide those links. */
  onOpenUrl?(url: string): void;
  /**
   * The Open Library client, for cover *bytes* only. Absent means Open Library
   * covers are not fetched at all — an unidentified burst is not a better answer
   * than a placeholder.
   */
  covers?: OpenLibraryClient | undefined;
  /** The user's local artwork cache, when they have it on. */
  imageCache?: CoverCache | undefined;
  /** Notify. Defaults to Obsidian's `Notice`; overridden in tests. */
  notify?(message: string): void;
}

export interface AuthorScreenHandle extends MountHandle {
  /** Point the screen at someone. Safe to call repeatedly. */
  open(target: AuthorTarget): void;
  /** Re-fetch from Open Library and repaint. */
  refresh(): void;
}

/** What the screen is currently able to show. */
type ScreenState =
  | { kind: "empty" }
  | { kind: "loading"; label: string }
  | { kind: "unconfigured" }
  | { kind: "unknown"; name: string }
  | { kind: "ambiguous"; name: string; candidates: AuthorCandidate[] }
  | { kind: "error"; message: string }
  | { kind: "author"; entry: AuthorCacheEntry; name: string };

export function mountAuthorScreen(
  host: HTMLElement,
  deps: AuthorScreenDeps,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): AuthorScreenHandle {
  host.addClass("wl-author");
  let state: ScreenState = { kind: "empty" };
  let target: AuthorTarget = {};
  /** Bumped on every `open`; a slow answer for an author we left is dropped. */
  let generation = 0;
  let destroyed = false;
  /** Object URLs from the last paint. Released before the next one. */
  const covers = new CoverPool();

  function set(next: ScreenState, forGeneration: number): void {
    if (destroyed || forGeneration !== generation) return;
    state = next;
    render();
  }

  function open(next: AuthorTarget): void {
    target = next;
    generation += 1;
    const mine = generation;

    if (!deps.authors.configured()) {
      set({ kind: "unconfigured" }, mine);
      return;
    }
    if (next.key !== undefined && next.key.trim() !== "") {
      show(next.key.trim(), next.name ?? "", mine);
      return;
    }
    const name = (next.name ?? "").trim();
    if (name === "") {
      set({ kind: "empty" }, mine);
      return;
    }

    // The synchronous path first, and only then the network. This is what makes
    // a second visit free: a name already resolved and an author already cached
    // render without a single request.
    const known = deps.authors.cachedResolution(name);
    if (known?.state === "resolved") {
      show(known.key, known.name, mine);
      return;
    }
    if (known?.state === "ambiguous") {
      set({ kind: "ambiguous", name, candidates: known.candidates }, mine);
      return;
    }

    set({ kind: "loading", label: `Looking up ${name}…` }, mine);
    void deps.authors
      .resolve(name)
      .then((outcome) => {
        if (outcome.state === "resolved") show(outcome.key, outcome.name, mine);
        else if (outcome.state === "ambiguous") set({ kind: "ambiguous", ...outcome }, mine);
        else set({ kind: "unknown", name }, mine);
      })
      .catch((err: unknown) => set({ kind: "error", message: messageOf(err) }, mine));
  }

  /** Paint from cache if we can, fetch only when we cannot. */
  function show(key: string, name: string, mine: number): void {
    const entry = deps.authors.cached(key);
    if (entry) {
      set({ kind: "author", entry, name: entry.author.name || name }, mine);
      // Stale is still worth showing; the top-up happens behind the finished
      // page rather than in front of a spinner.
      if (deps.authors.isStale(entry)) void reload(key, name, mine, false);
      return;
    }
    set({ kind: "loading", label: name === "" ? "Loading…" : `Loading ${name}…` }, mine);
    void reload(key, name, mine, true);
  }

  async function reload(
    key: string,
    name: string,
    mine: number,
    reportFailure: boolean,
  ): Promise<void> {
    try {
      const entry = await deps.authors.load(key, { force: !reportFailure });
      set({ kind: "author", entry, name: entry.author.name || name }, mine);
    } catch (err) {
      if (reportFailure) set({ kind: "error", message: messageOf(err) }, mine);
    }
  }

  function refresh(): void {
    if (state.kind !== "author") {
      open(target);
      return;
    }
    const key = state.entry.author.key;
    const name = state.name;
    generation += 1;
    const mine = generation;
    set({ kind: "loading", label: `Refreshing ${name}…` }, mine);
    void deps.authors
      .load(key, { force: true })
      .then((entry) => set({ kind: "author", entry, name: entry.author.name || name }, mine))
      .catch((err: unknown) => set({ kind: "error", message: messageOf(err) }, mine));
  }

  function render(): void {
    // Every repaint drops the previous paint's blobs. Without this a
    // bibliography re-rendered on each add pins one object URL per cover, per
    // render, for the life of the window.
    covers.releaseAll();
    host.empty();
    // Snapshot: `state` is a mutable binding, so a narrowing does not survive
    // into the callbacks the picker installs.
    const current = state;
    switch (current.kind) {
      case "empty":
        renderMessage(host, "Nobody selected", "Open an author to see who they are.");
        return;
      case "unconfigured":
        renderMessage(
          host,
          "Open Library is not reachable",
          "Author pages come from Open Library, which needs no account — check this machine's connection.",
        );
        return;
      case "loading":
        renderMessage(host, current.label, "");
        return;
      case "unknown":
        renderMessage(
          host,
          `Nothing on Open Library for “${current.name}”`,
          "The name may be spelled differently upstream, or this author may have been typed in by hand.",
        );
        return;
      case "error":
        renderMessage(host, "Could not load this author", current.message);
        return;
      case "ambiguous":
        renderPicker(host, current.name, current.candidates, (candidate) => {
          deps.authors.rememberChoice(current.name, candidate.key);
          open({ key: candidate.key, name: candidate.name });
        });
        return;
      default:
        renderAuthor(host, current.entry, deps, today(), refresh, covers);
    }
  }

  render();

  return {
    el: host,
    open,
    refresh,
    destroy() {
      destroyed = true;
      generation += 1;
      covers.releaseAll();
      host.empty();
      host.removeClass("wl-author");
    },
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Open Library did not answer.";
}

// ---------------------------------------------------------------------------
// States that are not an author
// ---------------------------------------------------------------------------

function renderMessage(host: HTMLElement, headline: string, detail: string): void {
  const box = host.createDiv({ cls: "wl-author-message" });
  box.createDiv({ cls: "wl-author-message-title", text: headline });
  if (detail) box.createDiv({ cls: "wl-author-message-body", text: detail });
}

/**
 * Two authors, one name.
 *
 * Picking for the user is the one thing this screen must not do: the whole
 * bibliography would be wrong and nothing on the page would say so. So it asks,
 * and remembers the answer.
 *
 * No photos, deliberately. Open Library's author search does not return one, so
 * a portrait per candidate would be one extra request each against a 3 req/s
 * budget — and what actually tells two `John Williams` apart is the book each is
 * known for, which is text the search already gave us.
 */
function renderPicker(
  host: HTMLElement,
  name: string,
  candidates: readonly AuthorCandidate[],
  onPick: (candidate: AuthorCandidate) => void,
): void {
  const box = host.createDiv({ cls: "wl-author-message" });
  box.createDiv({ cls: "wl-author-message-title", text: `More than one “${name}”` });
  box.createDiv({
    cls: "wl-author-message-body",
    text: "Open Library knows several authors by this name. Which one did you mean?",
  });

  const list = host.createDiv({ cls: "wl-author-choices" });
  for (const candidate of candidates) {
    const row = list.createEl("button", {
      cls: "wl-author-choice",
      attr: { type: "button" },
    });
    const photo = row.createDiv({ cls: "wl-poster wl-author-choice-photo" });
    photo.dataset.posterSeed = candidate.name;
    renderPosterPlaceholder(photo, candidate.name);

    const body = row.createDiv({ cls: "wl-author-choice-body" });
    body.createDiv({ cls: "wl-author-choice-name", text: candidate.name });
    body.createDiv({ cls: "wl-author-choice-meta", text: candidateMeta(candidate) });
    row.addEventListener("click", () => onPick(candidate));
  }
}

/** What separates one candidate from another, in one line. */
export function candidateMeta(candidate: AuthorCandidate): string {
  const parts: string[] = [];
  if (candidate.topWork !== "") parts.push(candidate.topWork);
  const life = lifespan(candidate.birthDate, candidate.deathDate);
  if (life !== "") parts.push(life);
  if (candidate.workCount > 0) {
    parts.push(candidate.workCount === 1 ? "1 work" : `${candidate.workCount} works`);
  }
  return parts.length === 0 ? "No other details listed" : parts.join(" · ");
}

/** `1920–1986` / `born 1920` / `died 1986` / `""`. Dates are upstream's text. */
export function lifespan(birthDate: string, deathDate: string): string {
  const born = birthDate.trim();
  const died = deathDate.trim();
  if (born !== "" && died !== "") return `${born} – ${died}`;
  if (born !== "") return `born ${born}`;
  if (died !== "") return `died ${died}`;
  return "";
}

// ---------------------------------------------------------------------------
// The author
// ---------------------------------------------------------------------------

function renderAuthor(
  host: HTMLElement,
  entry: AuthorCacheEntry,
  deps: AuthorScreenDeps,
  today: string,
  onRefresh: () => void,
  covers: CoverPool,
): void {
  const { author } = entry;

  const head = host.createDiv({ cls: "wl-author-head" });
  renderPhoto(head, author, deps, covers);

  const heading = head.createDiv({ cls: "wl-author-heading" });
  heading.createEl("h2", { cls: "wl-author-name", text: author.name });
  const life = lifespan(author.birthDate, author.deathDate);
  if (life !== "") heading.createDiv({ cls: "wl-author-life", text: life });

  // When this page was last told anything by Open Library. Without it the
  // Refresh button is an offer with no reason attached.
  const sync = heading.createDiv({ cls: "wl-author-syncrow" });
  const when = relativeTime(entry.fetchedAt, new Date(`${today}T12:00:00`));
  sync.createSpan({
    cls: "wl-author-synclabel",
    text: when === "" ? "Never updated" : `Updated ${when}`,
  });

  const actions = heading.createDiv({ cls: "wl-author-actions" });
  const refresh = actions.createEl("button", {
    cls: "wl-btn",
    text: "Refresh",
    attr: { type: "button", title: "Re-fetch this author from Open Library" },
  });
  refresh.addEventListener("click", () => onRefresh());

  if (deps.onJumpToQuery) {
    const owned = actions.createEl("button", {
      cls: "wl-btn",
      text: "In my library",
      attr: { type: "button", title: "Filter Reading by this author" },
    });
    owned.addEventListener("click", () => deps.onJumpToQuery?.(`author:"${author.name}"`));
  }
  if (deps.onOpenUrl && author.key !== "") {
    const external = actions.createEl("button", {
      cls: "wl-btn",
      text: "Open Library",
      attr: { type: "button", title: "Open this author on Open Library" },
    });
    external.addEventListener("click", () =>
      deps.onOpenUrl?.(`https://openlibrary.org/authors/${author.key}`),
    );
  }

  const body = host.createDiv({ cls: "wl-author-body" });

  // --- the fact column ------------------------------------------------------
  const facts = body.createDiv({ cls: "wl-author-facts" });
  fact(facts, "Born", author.birthDate);
  fact(facts, "Died", author.deathDate);
  fact(facts, "Full name", author.personalName === author.name ? "" : author.personalName);
  fact(facts, "Also known as", author.alternateNames.join(", "));
  fact(facts, "Works", entry.works.length === 0 ? "" : String(entry.works.length));
  renderLinks(facts, author, deps);
  if (facts.childElementCount === 0) facts.remove();

  // --- biography + bibliography ---------------------------------------------
  const main = body.createDiv({ cls: "wl-author-main" });
  main.createDiv({
    cls: "wl-author-bio",
    text: author.biography || "Open Library has no biography for this author.",
  });

  const shelf = main.createDiv({ cls: "wl-author-bibliography" });
  shelf.createEl("h3", { cls: "wl-author-bibliography-heading", text: "Bibliography" });
  if (entry.works.length === 0) {
    shelf.createDiv({
      cls: "wl-author-message-body",
      text: "Open Library lists no works for this author.",
    });
    return;
  }
  const grid = shelf.createDiv({ cls: "wl-author-shelf" });
  for (const work of entry.works) renderWork(grid, work, deps, covers);
}

/**
 * The author portrait.
 *
 * `covers.openlibrary.org/a/…` is an Open Library URL like any other, so it goes
 * down the same polite path as the book covers below rather than into an
 * `<img src>` the limiter never sees.
 */
function renderPhoto(
  head: HTMLElement,
  author: OpenLibraryAuthor,
  deps: AuthorScreenDeps,
  covers: CoverPool,
): void {
  const photo = head.createDiv({ cls: "wl-poster wl-author-photo" });
  photo.dataset.posterSeed = author.name;
  if (author.photoUrl === "") {
    renderPosterPlaceholder(photo, author.name);
    return;
  }
  const img = photo.createEl("img", { cls: "wl-poster-img" });
  img.setAttribute("alt", "");
  covers.add(
    loadCover(img as unknown as { src: string; addClass?: (cls: string) => void }, author.photoUrl, {
      client: deps.covers,
      cache: deps.imageCache,
      cacheId: author.key === "" ? undefined : `author-${author.key}`,
      onMissing: () => {
        img.remove();
        renderPosterPlaceholder(photo, author.name);
      },
    }),
  );
}

function fact(parent: HTMLElement, label: string, value: string): void {
  if (value.trim() === "") return;
  const row = parent.createDiv({ cls: "wl-author-fact" });
  row.createDiv({ cls: "wl-author-fact-label", text: label });
  row.createDiv({ cls: "wl-author-fact-value", text: value });
}

/** Open Library's own off-site links, plus the Wikipedia one it keeps separately. */
function renderLinks(parent: HTMLElement, author: OpenLibraryAuthor, deps: AuthorScreenDeps): void {
  const open = deps.onOpenUrl;
  if (!open) return;
  const links = [...author.links];
  if (author.wikipedia !== "" && !links.some((link) => link.url === author.wikipedia)) {
    links.push({ title: "Wikipedia", url: author.wikipedia });
  }
  if (links.length === 0) return;

  const row = parent.createDiv({ cls: "wl-author-fact" });
  row.createDiv({ cls: "wl-author-fact-label", text: "Links" });
  const value = row.createDiv({ cls: "wl-author-fact-value" });
  for (const link of links) {
    const button = value.createEl("button", {
      cls: "wl-author-link",
      text: link.title || link.url,
      attr: { type: "button", title: link.url },
    });
    button.addEventListener("click", () => open(link.url));
  }
}

/**
 * One bibliography cover.
 *
 * Deliberately **not** the reading table's row component: that takes a
 * `ReadingEntry`, and a work the user does not own is not one — inventing a row
 * to satisfy it is exactly what the runtime-preservation contract forbids, and
 * every affordance it would then draw (progress, rating, status) is meaningless
 * for a book that is not on the shelf yet.
 */
function renderWork(
  parent: HTMLElement,
  work: BookSearchResult,
  deps: AuthorScreenDeps,
  covers: CoverPool,
): void {
  const tile = parent.createDiv({ cls: "wl-author-work" });
  tile.dataset.workId = work.id;

  let owned = ownedBookFor(work, deps.books());
  const activate = (): void => {
    if (owned) deps.onOpenBook(owned);
  };
  // Bound once, on the tile that never gets replaced: adding something repaints
  // this tile's contents in place, so the shelf keeps its order and its scroll.
  tile.addEventListener("click", activate);
  tile.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!owned || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    activate();
  });

  const paint = (): void => {
    tile.empty();
    tile.toggleClass("is-owned", owned !== undefined);
    tile.toggleClass("is-clickable", owned !== undefined);
    if (owned) {
      tile.setAttribute("role", "button");
      tile.setAttribute("tabindex", "0");
      tile.setAttribute("aria-label", `${work.title} — open details`);
    }

    const poster = tile.createDiv({ cls: "wl-poster wl-author-work-poster" });
    poster.dataset.posterSeed = work.title;
    if (work.coverUrl === "") {
      renderPosterPlaceholder(poster, work.title);
    } else {
      const img = poster.createEl("img", { cls: "wl-poster-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      // The polite path: local copy, this session's bytes, then the rate-limited
      // client. Never an `<img src>` pointed at the cover CDN.
      covers.add(
        loadCover(img as unknown as { src: string; addClass?: (cls: string) => void }, work.coverUrl, {
          client: deps.covers,
          onMissing: () => {
            img.remove();
            renderPosterPlaceholder(poster, work.title);
          },
        }),
      );
    }

    if (owned) {
      // Owned is a state, not an action: the badge says so and the tile opens it.
      const badge = poster.createDiv({
        cls: "wl-author-work-badge",
        attr: { "aria-label": `${work.title} is on your shelf` },
      });
      setIcon(badge, "check");
    } else {
      const add = poster.createEl("button", {
        cls: "wl-author-add",
        text: "+ Add",
        attr: {
          type: "button",
          "aria-label": `Add ${work.title} to your library`,
          title: `Add ${work.title} to your library`,
        },
      });
      add.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        add.disabled = true;
        void deps
          .onAdd(work)
          .then((book) => {
            notify(deps, book ? `Added «${work.title}».` : `Could not add «${work.title}».`);
            if (book) {
              owned = book;
              paint();
            }
          })
          .catch((err: unknown) => notify(deps, `Could not add: ${messageOf(err)}`))
          .finally(() => {
            add.disabled = false;
          });
      });
    }

    const caption = tile.createDiv({ cls: "wl-author-work-body" });
    caption.createDiv({ cls: "wl-author-work-title", text: work.title });
    // Always drawn, even when empty: a tile that drops the line is a tile whose
    // cover sits on a different row from its neighbours.
    caption.createDiv({
      cls: "wl-author-work-year",
      text: work.firstPublishYear === undefined ? "" : String(work.firstPublishYear),
    });
  };

  paint();
}

function notify(deps: AuthorScreenDeps, message: string): void {
  if (deps.notify) deps.notify(message);
  else new Notice(message);
}

// ---------------------------------------------------------------------------
// The author name as a link
// ---------------------------------------------------------------------------

export type AuthorOpener = (name: string) => void;

/**
 * The opener a surface hands to `bindAuthorLink`, built from its `App`.
 *
 * Returns `undefined` without one — a headless host or a test — and every link
 * then degrades to the Reading search it had before, which is why no surface
 * needs to know whether the author view is reachable.
 */
export function authorOpener(app: App | undefined | null): AuthorOpener | undefined {
  if (!app) return undefined;
  return (name: string): void => {
    // Never throw out of a click handler, and never leave a rejected promise
    // behind: the author leaf failing to open is a sentence, not a crash.
    void openAuthorView(app, { name }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] could not open the author view", err);
      new Notice(`Could not open that author — ${detail}`, 8000);
    });
  };
}

export interface AuthorLinkOptions {
  /** The author exactly as stored. The only identity a book's author has. */
  name: string;
  /** Open the author screen. */
  openAuthor?: AuthorOpener | undefined;
  /** Hand a scoped query back to Reading. */
  onFilter?: ((query: string) => void) | undefined;
}

/** What a bound link ended up able to do, so a surface can style or skip it. */
export interface AuthorLinkBinding {
  opens: boolean;
  filters: boolean;
}

/**
 * Give `el` the credit-link behaviour, for an author.
 *
 * The same two destinations, the same one control, the same tooltip wording as
 * `ui/detail/people.ts` gives a cast name — because "click a name" has to mean
 * one thing across the plugin. It is a separate function only because that one
 * is gated by `isPersonField`, and an author is not a TMDB person: the two
 * fields resolve against different catalogues entirely.
 *
 *   - **Plain click opens the author.** `author:"…"` can only ever show what is
 *     already on the shelf, which is the limitation this screen lifts.
 *   - **Alt-click filters Reading**, which is what the author chip did before.
 *     Losing it would be a regression, so it keeps a binding, and the tooltip
 *     says so on every link that offers both.
 */
export function bindAuthorLink(el: HTMLElement, options: AuthorLinkOptions): AuthorLinkBinding {
  const { name } = options;
  const query = `author:"${name}"`;
  const open = options.openAuthor;
  const filter = options.onFilter;
  const binding: AuthorLinkBinding = { opens: open !== undefined, filters: filter !== undefined };
  if (!open && !filter) return binding;

  el.setAttribute(
    "title",
    open
      ? filter
        ? `Open ${name} — Alt-click to filter the library by them instead`
        : `Open ${name}`
      : `Show everything by ${name}`,
  );
  if (el.tagName !== "BUTTON") {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
  }

  const fire = (event: { altKey?: boolean }): void => {
    if (event.altKey === true && filter) {
      filter(query);
      return;
    }
    if (open) open(name);
    else filter?.(query);
  };

  el.addEventListener("click", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    fire(event);
  });
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    fire(event);
  });
  return binding;
}

// ---------------------------------------------------------------------------
// The Obsidian shell
// ---------------------------------------------------------------------------

/**
 * The leaf.
 *
 * A view rather than a modal because a bibliography is a place you browse and
 * come back to — and because a modal cannot be opened next to Reading.
 */
export class AuthorView extends ItemView {
  private screen: AuthorScreenHandle | null = null;
  private target: AuthorTarget = {};

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: AuthorScreenDeps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_AUTHOR;
  }

  override getDisplayText(): string {
    return this.target.name ? `Author — ${this.target.name}` : AUTHOR_VIEW_DISPLAY_NAME;
  }

  override getIcon(): string {
    return AUTHOR_VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    this.screen = mountAuthorScreen(root, this.deps);
    this.screen.open(this.target);
  }

  override async onClose(): Promise<void> {
    this.screen?.destroy();
    this.screen = null;
  }

  /** Workspace state, so a reopened tab lands on the same author. */
  override getState(): Record<string, unknown> {
    return { ...super.getState(), ...this.target };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const raw = (state ?? {}) as Record<string, unknown>;
    const next: AuthorTarget = {};
    if (typeof raw["key"] === "string") next.key = raw["key"];
    if (typeof raw["name"] === "string") next.name = raw["name"];
    this.target = next;
    this.screen?.open(next);
  }

  /** Point an already-open leaf at somebody else. */
  show(target: AuthorTarget): void {
    this.target = target;
    this.screen?.open(target);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * What registering needs from the plugin, structurally.
 *
 * Declared rather than imported so this module never depends on `main.ts` — the
 * import would be circular.
 */
export interface AuthorViewHost {
  app: App;
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => AuthorView): void;
}

/** One call in `onload`. The factory is lazy, so it costs nothing until opened. */
export function registerAuthorView(host: AuthorViewHost, deps: AuthorScreenDeps): void {
  host.registerView(VIEW_TYPE_AUTHOR, (leaf: WorkspaceLeaf) => new AuthorView(leaf, deps));
}

/**
 * Open (or re-point) the author leaf.
 *
 * One leaf is reused rather than a tab per author: this is a place you pass
 * through on the way to adding something, not a set of pinned reference pages.
 */
export async function openAuthorView(app: App, target: AuthorTarget): Promise<void> {
  const { workspace } = app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_AUTHOR);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_AUTHOR, active: true, state: { ...target } });
  workspace.revealLeaf(leaf);
  if (leaf.view instanceof AuthorView) leaf.view.show(target);
}
