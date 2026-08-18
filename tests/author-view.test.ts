/**
 * The author screen.
 *
 * The load-bearing assertions here are about what the screen *does not* do:
 *
 *   - it does not touch the network for an author it has already seen (the
 *     service stub throws from `resolve` and `load`, so a single call fails the
 *     test rather than merely slowing it down);
 *   - it does not offer `+ Add` for something already on the shelf;
 *   - it does not choose between two authors who share a name;
 *   - it does not point an `<img>` at `covers.openlibrary.org` — every cover
 *     goes through the client, which is where the User-Agent and the 334 ms gap
 *     live.
 *
 * Rendering goes into the hand-rolled DOM from `helpers/dom.ts`, the same one
 * the tabs are mounted into.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StubEl } from "./helpers/dom";
import { createBook } from "../src/data/schema";
import type { Book, BookSearchResult, OpenLibraryClient } from "../src/types";
import type { AuthorCandidate, OpenLibraryAuthor } from "../src/services/openlibrary";
import type {
  AuthorCacheEntry,
  AuthorResolution,
  AuthorService,
} from "../src/services/openlibrary-author";
import { clearCoverCaches } from "../src/domains/reading/covers";
import {
  bindAuthorLink,
  lifespan,
  mountAuthorScreen,
  VIEW_TYPE_AUTHOR,
  type AuthorScreenDeps,
} from "../src/ui/views/author";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HERBERT: OpenLibraryAuthor = {
  key: "OL79034A",
  name: "Frank Herbert",
  personalName: "Frank Patrick Herbert",
  biography: "An American science fiction writer.",
  birthDate: "8 October 1920",
  deathDate: "11 February 1986",
  alternateNames: ["Frank Patrick Herbert"],
  links: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Frank_Herbert" }],
  photoUrl: "https://covers.openlibrary.org/a/id/6157281-M.jpg?default=false",
  wikipedia: "",
  workCount: 231,
};

function work(title: string, year: number | undefined, id: string, coverUrl = ""): BookSearchResult {
  const result: BookSearchResult = {
    id,
    source: "openlibrary",
    title,
    authors: ["Frank Herbert"],
    coverUrl,
  };
  if (year !== undefined) result.firstPublishYear = year;
  return result;
}

const WORKS: BookSearchResult[] = [
  work("Dune Messiah", 1969, "/works/OL27448W"),
  work("Dune", 1965, "/works/OL893414W", "https://covers.openlibrary.org/b/id/8231990-M.jpg?default=false"),
  work("The Dragon in the Sea", undefined, "/works/OL9W"),
];

function entry(overrides: Partial<AuthorCacheEntry> = {}): AuthorCacheEntry {
  return {
    author: HERBERT,
    works: WORKS,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(key: string, name: string, topWork: string, workCount: number): AuthorCandidate {
  return { key, name, alternateNames: [], birthDate: "", deathDate: "", topWork, workCount };
}

function book(id: string, title: string): Book {
  return createBook({ id, title, author: "Frank Herbert" });
}

/**
 * A service whose async halves throw.
 *
 * Any screen path that reaches for the network in a test that supplies a cached
 * answer fails loudly, which is the only way to prove "opening an author twice
 * is free" rather than assert it in a comment.
 */
function offlineService(overrides: Partial<AuthorService> = {}): AuthorService {
  return {
    configured: () => true,
    cached: () => undefined,
    isStale: () => false,
    cachedResolution: () => undefined,
    resolve: () => {
      throw new Error("resolve must not be called");
    },
    load: () => {
      throw new Error("load must not be called");
    },
    rememberChoice: () => undefined,
    ...overrides,
  };
}

interface Harness {
  host: StubEl;
  deps: AuthorScreenDeps;
  added: BookSearchResult[];
  opened: Book[];
  notices: string[];
  queries: string[];
}

function harness(
  service: AuthorService,
  books: Book[] = [],
  onAdd?: (work: BookSearchResult) => Promise<Book | undefined>,
  covers?: OpenLibraryClient,
): Harness {
  const host = new StubEl("div", "wl-author-host");
  const added: BookSearchResult[] = [];
  const opened: Book[] = [];
  const notices: string[] = [];
  const queries: string[] = [];
  const shelf = [...books];

  const deps: AuthorScreenDeps = {
    authors: service,
    books: () => shelf,
    onOpenBook: (b) => opened.push(b),
    onAdd: async (hit) => {
      added.push(hit);
      if (onAdd) return onAdd(hit);
      const created = book(hit.title.toLowerCase(), hit.title);
      shelf.push(created);
      return created;
    },
    onJumpToQuery: (query) => queries.push(query),
    onOpenUrl: () => undefined,
    covers,
    notify: (message) => notices.push(message),
  };
  return { host, deps, added, opened, notices, queries };
}

function texts(host: StubEl, selector: string): string[] {
  return host.querySelectorAll(selector).map((el) => el.textContent.trim());
}

const TODAY = () => "2026-08-18";

/** Drain the microtask queue, however many promise layers a path went through. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // The cover caches in `domains/reading/covers.ts` are module-level and outlive
  // a test: without this, bytes fetched by one case are repainted from memory in
  // the next and the "no image" path is never exercised.
  clearCoverCaches();
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:test-${(n += 1)}`,
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal("Blob", class {});
});

// ---------------------------------------------------------------------------

describe("the author screen", () => {
  it("renders a cached author with no network call at all", () => {
    const service = offlineService({
      cachedResolution: (): AuthorResolution => ({
        state: "resolved",
        key: "OL79034A",
        name: "Frank Herbert",
        source: "cache",
      }),
      cached: () => entry(),
    });
    const { host, deps } = harness(service, [book("dune", "Dune")]);

    const screen = mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "Frank Herbert" });

    expect(texts(host, ".wl-author-name")).toEqual(["Frank Herbert"]);
    expect(host.querySelector(".wl-author-bio")?.textContent).toContain("science fiction writer");
    // The dates are the catalogue's own free text, not a date this screen made up.
    expect(texts(host, ".wl-author-fact-value")).toContain("8 October 1920");
    expect(texts(host, ".wl-author-fact-value")).toContain("11 February 1986");
    expect(texts(host, ".wl-author-fact-value")).toContain("Frank Patrick Herbert");
    expect(host.querySelector(".wl-author-life")?.textContent).toBe(
      "8 October 1920 – 11 February 1986",
    );
  });

  it("lists the bibliography newest first, as the service ordered it", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });

    expect(texts(host, ".wl-author-work-title")).toEqual([
      "Dune Messiah",
      "Dune",
      "The Dragon in the Sea",
    ]);
    // The undated one still draws its line, so its neighbours stay aligned.
    expect(texts(host, ".wl-author-work-year")).toEqual(["1969", "1965", ""]);
  });

  it("marks what is already on the shelf instead of offering it back", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, opened } = harness(service, [book("dune", "Dune")]);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });

    const owned = host.querySelectorAll(".wl-author-work.is-owned");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.querySelector(".wl-author-work-title")?.textContent).toBe("Dune");
    // No second way to add something you already have.
    expect(owned[0]?.querySelector(".wl-author-add")).toBeNull();
    expect(owned[0]?.querySelector(".wl-author-work-badge")).not.toBeNull();

    // And it is a way *into* the book, not a dead cover.
    owned[0]?.fire("click");
    expect(opened.map((b) => b.id)).toEqual(["dune"]);

    // Everything else is still addable.
    expect(host.querySelectorAll(".wl-author-add")).toHaveLength(2);
  });

  it("adds through the caller's add path and redraws that one tile as owned", async () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, added, notices } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    expect(host.querySelectorAll(".wl-author-work.is-owned")).toHaveLength(0);

    const dune = host
      .querySelectorAll(".wl-author-work")
      .find((el) => el.dataset["workId"] === "/works/OL893414W");
    dune?.querySelector(".wl-author-add")?.fire("click", {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await flush();

    // The whole search result goes to the add path — the same shape
    // `seedFromHit` takes, so there is one mapping, not two.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: "/works/OL893414W", title: "Dune", source: "openlibrary" });
    expect(notices).toEqual(["Added «Dune»."]);

    const owned = host.querySelectorAll(".wl-author-work.is-owned");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.dataset["workId"]).toBe("/works/OL893414W");
    // Redrawn in place: the other two tiles kept their order.
    expect(texts(host, ".wl-author-work-title")).toEqual([
      "Dune Messiah",
      "Dune",
      "The Dragon in the Sea",
    ]);
  });

  it("says so when the add path could not create the book", async () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, notices } = harness(service, [], async () => undefined);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    host.querySelector(".wl-author-add")?.fire("click", {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await flush();

    expect(notices).toEqual(["Could not add «Dune Messiah»."]);
    expect(host.querySelectorAll(".wl-author-work.is-owned")).toHaveLength(0);
  });

  it("keeps the filter that the author chip used to be", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, queries } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    const button = host
      .querySelectorAll(".wl-btn")
      .find((el) => el.textContent.trim() === "In my library");
    button?.fire("click");

    expect(queries).toEqual(['author:"Frank Herbert"']);
  });

  it("asks which author rather than picking one, and remembers the answer", () => {
    const candidates = [
      candidate("OL118060A", "John Williams", "Stoner", 34),
      candidate("OL234297A", "John Williams", "Star Wars", 118),
    ];
    const remembered = vi.fn();
    const service = offlineService({
      cachedResolution: (): AuthorResolution => ({
        state: "ambiguous",
        name: "John Williams",
        candidates,
      }),
      cached: (key) =>
        key === "OL118060A"
          ? entry({ author: { ...HERBERT, key: "OL118060A", name: "John Williams" } })
          : undefined,
      rememberChoice: remembered,
    });
    const { host, deps } = harness(service);

    const screen = mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "John Williams" });

    const choices = host.querySelectorAll(".wl-author-choice");
    expect(choices).toHaveLength(2);
    // What tells them apart is what each one wrote — that has to be on screen.
    expect(texts(host, ".wl-author-choice-meta")).toEqual([
      "Stoner · 34 works",
      "Star Wars · 118 works",
    ]);
    expect(host.querySelector(".wl-author-name")).toBeNull();

    choices[0]?.fire("click");
    expect(remembered).toHaveBeenCalledWith("John Williams", "OL118060A");
    expect(texts(host, ".wl-author-name")).toEqual(["John Williams"]);
  });

  it("paints a stale entry immediately and tops it up behind the page", async () => {
    let loads = 0;
    const service = offlineService({
      cached: () => entry(),
      isStale: () => true,
      load: async () => {
        loads += 1;
        return entry({ author: { ...HERBERT, biography: "A fresher biography." } });
      },
    });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });

    // Painted from cache first — no spinner in front of a finished page.
    expect(host.querySelector(".wl-author-bio")?.textContent).toContain("science fiction");
    await flush();
    expect(loads).toBe(1);
    expect(host.querySelector(".wl-author-bio")?.textContent).toContain("fresher");
  });

  it("keeps the page when a background top-up fails", async () => {
    const service = offlineService({
      cached: () => entry(),
      isStale: () => true,
      load: async () => {
        throw new Error("upstream is down");
      },
    });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    await flush();

    expect(texts(host, ".wl-author-name")).toEqual(["Frank Herbert"]);
  });

  it("resolves an unseen name once, then draws the author", async () => {
    let resolves = 0;
    const service = offlineService({
      resolve: async () => {
        resolves += 1;
        return { state: "resolved", key: "OL79034A", name: "Frank Herbert", source: "books" };
      },
      cached: () => entry(),
    });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ name: "Frank Herbert" });
    expect(host.querySelector(".wl-author-message-title")?.textContent).toContain("Looking up");

    await flush();
    expect(resolves).toBe(1);
    expect(texts(host, ".wl-author-name")).toEqual(["Frank Herbert"]);
  });

  it("says nothing was found rather than showing an empty author", async () => {
    const service = offlineService({
      resolve: async () => ({ state: "unknown", name: "Made Up Author" }),
    });
    const { host, deps } = harness(service);
    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ name: "Made Up Author" });
    await flush();
    expect(host.querySelector(".wl-author-message-title")?.textContent).toContain(
      "Nothing on Open Library",
    );
  });

  it("drops the answer for an author the user has already navigated away from", async () => {
    let resolveFirst: ((r: AuthorResolution) => void) | undefined;
    const service = offlineService({
      resolve: (name: string) =>
        name === "Slow Author"
          ? new Promise<AuthorResolution>((done) => {
              resolveFirst = done;
            })
          : Promise.resolve({
              state: "resolved",
              key: "OL79034A",
              name: "Frank Herbert",
              source: "search",
            } as AuthorResolution),
      cached: () => entry(),
    });
    const { host, deps } = harness(service);

    const screen = mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "Slow Author" });
    screen.open({ name: "Frank Herbert" });
    await flush();
    expect(texts(host, ".wl-author-name")).toEqual(["Frank Herbert"]);

    // The abandoned lookup lands late and must not repaint over the new author.
    resolveFirst?.({ state: "unknown", name: "Slow Author" });
    await flush();
    expect(texts(host, ".wl-author-name")).toEqual(["Frank Herbert"]);
  });

  it("degrades cleanly for an author with no biography, no dates and no works", () => {
    const bare: OpenLibraryAuthor = {
      key: "OL5A",
      name: "A Nameless Compiler",
      personalName: "",
      biography: "",
      birthDate: "",
      deathDate: "",
      alternateNames: [],
      links: [],
      photoUrl: "",
      wikipedia: "",
      workCount: 0,
    };
    const service = offlineService({ cached: () => entry({ author: bare, works: [] }) });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL5A" });

    expect(texts(host, ".wl-author-name")).toEqual(["A Nameless Compiler"]);
    expect(host.querySelector(".wl-author-bio")?.textContent).toBe(
      "Open Library has no biography for this author.",
    );
    // No empty fact column, no empty date line, no empty grid.
    expect(host.querySelector(".wl-author-facts")).toBeNull();
    expect(host.querySelector(".wl-author-life")).toBeNull();
    expect(host.querySelector(".wl-author-shelf")).toBeNull();
    expect(host.querySelector(".wl-author-bibliography")?.textContent).toContain(
      "no works for this author",
    );
    // And the portrait is the tinted initial rather than a broken image.
    expect(host.querySelector(".wl-author-photo")?.hasClass("is-placeholder")).toBe(true);
  });

  it("empties itself on destroy", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service);
    const screen = mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ key: "OL79034A" });
    expect(host.children.length).toBeGreaterThan(0);
    screen.destroy();
    expect(host.children).toEqual([]);
    expect(host.hasClass("wl-author")).toBe(false);
  });

  it("keeps its view type stable — a workspace remembers leaves by it", () => {
    expect(VIEW_TYPE_AUTHOR).toBe("watchlog-author-view");
  });
});

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

describe("bibliography covers", () => {
  /**
   * A client that records what was asked of it. `null` is "Open Library has no
   * image for this" — spelled out rather than passed as `undefined`, which would
   * silently take the default and hand back bytes.
   */
  function coverClient(bytes: ArrayBuffer | null = new Uint8Array([1, 2, 3]).buffer) {
    const asked: string[] = [];
    const client = {
      configured: () => true,
      coverBytes: async (url: string) => {
        asked.push(url);
        return bytes ?? undefined;
      },
    } as unknown as OpenLibraryClient;
    return { client, asked };
  }

  it("fetches every Open Library cover through the client, never through img.src", async () => {
    const { client, asked } = coverClient();
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service, [], undefined, client);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    await flush();

    // The author photo and the one work that has a cover — and nothing was ever
    // assigned the cover-CDN URL directly, which is the request the limiter and
    // the User-Agent would both miss.
    expect(asked).toEqual([
      "https://covers.openlibrary.org/a/id/6157281-M.jpg?default=false",
      "https://covers.openlibrary.org/b/id/8231990-M.jpg?default=false",
    ]);
    for (const img of host.querySelectorAll(".wl-poster-img")) {
      expect(img.src).not.toContain("covers.openlibrary.org");
    }
  });

  it("draws the placeholder rather than fetching impolitely with no client", async () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    await flush();

    expect(host.querySelectorAll(".wl-poster-img")).toHaveLength(0);
    expect(host.querySelectorAll(".wl-poster.is-placeholder").length).toBeGreaterThan(0);
  });

  it("falls back to the placeholder when Open Library has no image", async () => {
    const { client } = coverClient(null);
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service, [], undefined, client);

    mountAuthorScreen(host as unknown as HTMLElement, deps, TODAY).open({ key: "OL79034A" });
    await flush();

    const dune = host
      .querySelectorAll(".wl-author-work")
      .find((el) => el.dataset["workId"] === "/works/OL893414W");
    expect(dune?.querySelector(".wl-poster")?.hasClass("is-placeholder")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The name as a link
// ---------------------------------------------------------------------------

describe("an author name as a link", () => {
  it("opens on a click and filters on Alt-click, and says so", () => {
    const opened: string[] = [];
    const filtered: string[] = [];
    const el = new StubEl("button");

    const binding = bindAuthorLink(el as unknown as HTMLElement, {
      name: "Frank Herbert",
      openAuthor: (name) => opened.push(name),
      onFilter: (query) => filtered.push(query),
    });

    expect(binding).toEqual({ opens: true, filters: true });
    // Word for word what a cast chip says, because it is the same gesture.
    expect(el.getAttribute("title")).toBe(
      "Open Frank Herbert — Alt-click to filter the library by them instead",
    );

    el.fire("click", { preventDefault: () => undefined, stopPropagation: () => undefined });
    expect(opened).toEqual(["Frank Herbert"]);
    expect(filtered).toEqual([]);

    el.fire("click", {
      altKey: true,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    expect(filtered).toEqual(['author:"Frank Herbert"']);
  });

  it("still filters when there is no author view to open — today's behaviour", () => {
    const filtered: string[] = [];
    const el = new StubEl("button");
    const binding = bindAuthorLink(el as unknown as HTMLElement, {
      name: "Frank Herbert",
      onFilter: (query) => filtered.push(query),
    });

    expect(binding).toEqual({ opens: false, filters: true });
    expect(el.getAttribute("title")).toBe("Show everything by Frank Herbert");
    el.fire("click", { preventDefault: () => undefined, stopPropagation: () => undefined });
    expect(filtered).toEqual(['author:"Frank Herbert"']);
  });

  it("wires nothing at all when neither destination exists", () => {
    const el = new StubEl("span");
    expect(bindAuthorLink(el as unknown as HTMLElement, { name: "Frank Herbert" })).toEqual({
      opens: false,
      filters: false,
    });
    expect(el.getAttribute("title")).toBeNull();
    expect(el.getAttribute("role")).toBeNull();
  });

  it("makes a non-button reachable by keyboard", () => {
    const opened: string[] = [];
    const el = new StubEl("span");
    bindAuthorLink(el as unknown as HTMLElement, {
      name: "Frank Herbert",
      openAuthor: (name) => opened.push(name),
    });
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    el.fire("keydown", { key: "Enter", preventDefault: () => undefined });
    expect(opened).toEqual(["Frank Herbert"]);
  });
});

describe("lifespan", () => {
  it("says what is known and nothing more", () => {
    expect(lifespan("1920", "1986")).toBe("1920 – 1986");
    expect(lifespan("1920", "")).toBe("born 1920");
    expect(lifespan("", "1986")).toBe("died 1986");
    expect(lifespan("", "")).toBe("");
  });
});
