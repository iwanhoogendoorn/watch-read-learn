/**
 * The person screen.
 *
 * The load-bearing assertions here are about what the screen *does not* do:
 *
 *   - it does not touch the network for a person it has already seen (the
 *     service stub throws from `resolve` and `load`, so a single call fails the
 *     test rather than merely slowing it down);
 *   - it does not offer "+ Add" for something already in the library;
 *   - it does not choose between two people who share a name.
 *
 * Rendering goes into the hand-rolled DOM from `helpers/dom.ts`, the same one
 * the tabs are mounted into.
 */
import { describe, expect, it, vi } from "vitest";
import { StubEl } from "./helpers/dom";
import { createTitle } from "../src/data/schema";
import type { TitleV4 } from "../src/types";
import {
  mountPersonScreen,
  VIEW_TYPE_PERSON,
  type PersonScreenDeps,
} from "../src/ui/views/person";
import type {
  PersonCacheEntry,
  PersonCandidate,
  PersonCredit,
  PersonResolution,
  PersonService,
  TmdbPerson,
} from "../src/services/tmdb-person";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOLAN: TmdbPerson = {
  id: 525,
  name: "Christopher Nolan",
  biography: "A British-American film director.",
  birthday: "1970-07-30",
  deathday: null,
  placeOfBirth: "London, England, UK",
  profileUrl: "https://image.tmdb.org/t/p/h632/nolan.jpg",
  knownForDepartment: "Directing",
  alsoKnownAs: ["Chris Nolan"],
  gender: "Male",
  imdbId: "nm0634240",
  homepage: "",
  popularity: 12,
};

function credit(
  tmdbId: number,
  title: string,
  department: string,
  role: string,
  releaseDate: string | null,
): PersonCredit {
  return {
    result: {
      tmdbId,
      mediaType: "movie",
      title,
      year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
      releaseDate,
      overview: "",
      posterUrl: "",
      voteAverage: 0,
      voteCount: 0,
      genreIds: [],
    },
    department,
    role,
  };
}

const CREDITS: PersonCredit[] = [
  credit(27205, "Inception", "Directing", "Director", "2010-07-15"),
  credit(577922, "Tenet", "Directing", "Director", "2020-08-22"),
  credit(1, "Following", "Acting", "Man in the Alley", "1998-11-05"),
];

function entry(overrides: Partial<PersonCacheEntry> = {}): PersonCacheEntry {
  return {
    person: NOLAN,
    credits: CREDITS,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function title(id: string, name: string, tmdbId?: number): TitleV4 {
  return createTitle({
    id,
    title: name,
    type: "Movie",
    ...(tmdbId === undefined ? {} : { tmdbId, tmdbMediaType: "movie" as const }),
  });
}

/**
 * A service whose async halves throw.
 *
 * Any screen path that reaches for the network in a test that supplies a cached
 * answer fails loudly, which is the only way to prove "opening a person twice is
 * free" rather than assert it in a comment.
 */
function offlineService(overrides: Partial<PersonService> = {}): PersonService {
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
  deps: PersonScreenDeps;
  added: PersonCredit["result"][];
  opened: TitleV4[];
  notices: string[];
}

function harness(
  service: PersonService,
  titles: TitleV4[] = [],
  onAdd?: (result: PersonCredit["result"]) => Promise<TitleV4 | undefined>,
): Harness {
  const host = new StubEl("div", "wl-person-host");
  const added: PersonCredit["result"][] = [];
  const opened: TitleV4[] = [];
  const notices: string[] = [];
  const library = [...titles];

  const deps: PersonScreenDeps = {
    people: service,
    titles: () => library,
    onOpenTitle: (t) => opened.push(t),
    onAdd: async (result) => {
      added.push(result);
      if (onAdd) return onAdd(result);
      const created = title(result.title.toLowerCase(), result.title, result.tmdbId);
      library.push(created);
      return created;
    },
    notify: (message) => notices.push(message),
  };
  return { host, deps, added, opened, notices };
}

function texts(host: StubEl, selector: string): string[] {
  return host.querySelectorAll(selector).map((el) => el.textContent.trim());
}

const TODAY = () => "2026-08-18";

/** Drain the microtask queue, however many promise layers a path went through. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------

describe("the person screen", () => {
  it("renders a cached person with no network call at all", () => {
    const service = offlineService({
      cachedResolution: (): PersonResolution => ({
        state: "resolved",
        personId: 525,
        name: "Christopher Nolan",
        source: "cache",
      }),
      cached: () => entry(),
    });
    const { host, deps } = harness(service, [title("inception", "Inception", 27205)]);

    const screen = mountPersonScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "Christopher Nolan" });

    expect(texts(host, ".wl-person-name")).toEqual(["Christopher Nolan"]);
    expect(host.querySelector(".wl-person-bio")?.textContent).toContain("film director");
    // Age is computed against the injected date, not the wall clock.
    expect(texts(host, ".wl-person-fact-value")).toContain("1970-07-30 (age 56)");
    expect(texts(host, ".wl-person-fact-value")).toContain("London, England, UK");
    expect(texts(host, ".wl-person-fact-value")).toContain("Chris Nolan");
  });

  it("leads the filmography with the person's own department, newest work first", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });

    expect(texts(host, ".wl-person-section-heading")).toEqual(["Directing", "Acting"]);
    expect(texts(host, ".wl-person-credit-title")).toEqual(["Tenet", "Inception", "Following"]);
    expect(texts(host, ".wl-person-credit-role")).toEqual([
      "Director",
      "Director",
      "Man in the Alley",
    ]);
  });

  it("marks what is already in the library instead of offering it back", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, opened } = harness(service, [title("inception", "Inception", 27205)]);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });

    const owned = host.querySelectorAll(".wl-person-credit.is-owned");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.querySelector(".wl-person-credit-title")?.textContent).toBe("Inception");
    // No second way to add something you already have.
    expect(owned[0]?.querySelector(".wl-person-add")).toBeNull();
    expect(owned[0]?.querySelector(".wl-person-credit-badge")).not.toBeNull();

    // And it is a way *into* the title, not a dead poster.
    owned[0]?.fire("click");
    expect(opened.map((t) => t.id)).toEqual(["inception"]);

    // Everything else is still addable.
    expect(host.querySelectorAll(".wl-person-add")).toHaveLength(2);
  });

  it("adds through the caller's add path and redraws that one tile as owned", async () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, added, notices } = harness(service);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });
    expect(host.querySelectorAll(".wl-person-credit.is-owned")).toHaveLength(0);

    const tenet = host
      .querySelectorAll(".wl-person-credit")
      .find((el) => el.dataset["tmdbId"] === "577922");
    tenet?.querySelector(".wl-person-add")?.fire("click", {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await flush();

    // The whole search result goes to the add path — the same shape the
    // suggestion wizard hands it, so there is one mapping, not two.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ tmdbId: 577922, mediaType: "movie", title: "Tenet" });
    expect(notices).toEqual(["Added «Tenet»."]);

    const owned = host.querySelectorAll(".wl-person-credit.is-owned");
    expect(owned).toHaveLength(1);
    expect(owned[0]?.dataset["tmdbId"]).toBe("577922");
    // Redrawn in place: the other two tiles were not touched.
    expect(texts(host, ".wl-person-credit-title")).toEqual(["Tenet", "Inception", "Following"]);
  });

  it("says so when the add path could not create the title", async () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps, notices } = harness(service, [], async () => undefined);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });
    host.querySelector(".wl-person-add")?.fire("click", {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await flush();

    expect(notices).toEqual(["Could not add «Tenet»."]);
    expect(host.querySelectorAll(".wl-person-credit.is-owned")).toHaveLength(0);
  });

  it("asks which person rather than picking one, and remembers the answer", () => {
    const candidates: PersonCandidate[] = [
      { id: 21449, name: "Michael Jordan", profileUrl: "", knownForDepartment: "Acting", knownFor: ["Space Jam"], popularity: 9 },
      { id: 999999, name: "Michael Jordan", profileUrl: "", knownForDepartment: "Acting", knownFor: ["Home Front"], popularity: 1 },
    ];
    const remembered = vi.fn();
    const service = offlineService({
      cachedResolution: (): PersonResolution => ({
        state: "ambiguous",
        name: "Michael Jordan",
        candidates,
      }),
      cached: (id) => (id === 21449 ? entry({ person: { ...NOLAN, id: 21449, name: "Michael Jordan" } }) : undefined),
      rememberChoice: remembered,
    });
    const { host, deps } = harness(service);

    const screen = mountPersonScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "Michael Jordan" });

    const choices = host.querySelectorAll(".wl-person-choice");
    expect(choices).toHaveLength(2);
    // What tells them apart is what each one is in — that has to be on screen.
    expect(texts(host, ".wl-person-choice-meta")).toEqual(["Space Jam", "Home Front"]);
    expect(host.querySelector(".wl-person-name")).toBeNull();

    choices[0]?.fire("click");
    expect(remembered).toHaveBeenCalledWith("Michael Jordan", 21449);
    expect(texts(host, ".wl-person-name")).toEqual(["Michael Jordan"]);
  });

  it("paints a stale entry immediately and tops it up behind the page", async () => {
    let loads = 0;
    const service = offlineService({
      cached: () => entry(),
      isStale: () => true,
      load: async () => {
        loads += 1;
        return entry({ person: { ...NOLAN, biography: "A fresher biography." } });
      },
    });
    const { host, deps } = harness(service);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });

    // Painted from cache first — no spinner in front of a finished page.
    expect(host.querySelector(".wl-person-bio")?.textContent).toContain("film director");
    await flush();
    expect(loads).toBe(1);
    expect(host.querySelector(".wl-person-bio")?.textContent).toContain("fresher");
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

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ personId: 525 });
    await flush();

    expect(texts(host, ".wl-person-name")).toEqual(["Christopher Nolan"]);
  });

  it("resolves an unseen name once, then draws the person", async () => {
    let resolves = 0;
    const service = offlineService({
      resolve: async () => {
        resolves += 1;
        return { state: "resolved", personId: 525, name: "Christopher Nolan", source: "credits" };
      },
      cached: () => entry(),
    });
    const { host, deps } = harness(service);

    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ name: "Christopher Nolan" });
    expect(host.querySelector(".wl-person-message-title")?.textContent).toContain("Looking up");

    await flush();
    expect(resolves).toBe(1);
    expect(texts(host, ".wl-person-name")).toEqual(["Christopher Nolan"]);
  });

  it("degrades to a plain explanation without a TMDB token", () => {
    const { host, deps } = harness(offlineService({ configured: () => false }));
    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ name: "Anyone" });
    expect(host.querySelector(".wl-person-message-title")?.textContent).toBe(
      "TMDB is not configured",
    );
  });

  it("says nothing was found rather than showing an empty person", async () => {
    const service = offlineService({
      resolve: async () => ({ state: "unknown", name: "Made Up Person" }),
    });
    const { host, deps } = harness(service);
    mountPersonScreen(host as unknown as HTMLElement, deps, TODAY).open({ name: "Made Up Person" });
    await flush();
    expect(host.querySelector(".wl-person-message-title")?.textContent).toContain(
      "Nothing on TMDB",
    );
  });

  it("drops the answer for a person the user has already navigated away from", async () => {
    let resolveFirst: ((r: PersonResolution) => void) | undefined;
    const service = offlineService({
      resolve: (name: string) =>
        name === "Slow Person"
          ? new Promise<PersonResolution>((done) => {
              resolveFirst = done;
            })
          : Promise.resolve({
              state: "resolved",
              personId: 525,
              name: "Christopher Nolan",
              source: "search",
            } as PersonResolution),
      cached: () => entry(),
    });
    const { host, deps } = harness(service);

    const screen = mountPersonScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ name: "Slow Person" });
    screen.open({ name: "Christopher Nolan" });
    await flush();
    expect(texts(host, ".wl-person-name")).toEqual(["Christopher Nolan"]);

    // The abandoned lookup lands late and must not repaint over the new person.
    resolveFirst?.({ state: "unknown", name: "Slow Person" });
    await flush();
    expect(texts(host, ".wl-person-name")).toEqual(["Christopher Nolan"]);
  });

  it("empties itself on destroy", () => {
    const service = offlineService({ cached: () => entry() });
    const { host, deps } = harness(service);
    const screen = mountPersonScreen(host as unknown as HTMLElement, deps, TODAY);
    screen.open({ personId: 525 });
    expect(host.children.length).toBeGreaterThan(0);
    screen.destroy();
    expect(host.children).toEqual([]);
    expect(host.hasClass("wl-person")).toBe(false);
  });

  it("keeps its view type stable — a workspace remembers leaves by it", () => {
    expect(VIEW_TYPE_PERSON).toBe("watchlog-person-view");
  });
});
