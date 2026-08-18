/**
 * People — the client, the resolver, the cache and the arithmetic.
 *
 * The two things worth pinning hardest:
 *
 *   - **Ambiguity is reported, never guessed.** Two people share a name far more
 *     often than a filmography screen can afford; a resolver that silently takes
 *     the first hit puts a stranger's entire body of work on the page and says
 *     nothing about it.
 *   - **A second open is free.** Everything fetched lands in `data.json`, so the
 *     screen has no reason to touch the network twice. Several tests here assert
 *     the *absence* of calls rather than their result.
 *
 * No network, ever: the HTTP transport is the fixture router, and the resolver
 * tests use a client whose methods count their calls.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeHttp, createTestClock, type FakeRoute } from "./mocks/http";
import { createTitle } from "../src/data/schema";
import type { TitleV4, WatchLogData, WatchLogStoreApi } from "../src/types";
import {
  ageFacts,
  birthdayLabel,
  createPersonService,
  createTmdbPersonClient,
  dedupeCredits,
  evictPeople,
  exactNameHits,
  groupFilmography,
  mediaTypeFor,
  normalizeCombinedCredits,
  normalizePerson,
  normalizeTitleCredits,
  ownedTitleFor,
  personCacheOf,
  personIdsNamed,
  personNameKey,
  PERSON_CACHE_KEY,
  resolvePersonByName,
  sameName,
  titlesCrediting,
  type PersonCandidate,
  type PersonCredit,
  type PersonStoreLike,
  type TitleCreditPerson,
  type TmdbPersonClient,
  type TmdbPerson,
} from "../src/services/tmdb-person";

const CONFIG = { token: "eyJhbGciOiJIUzI1NiJ9.fake" };

/**
 * The real store must keep satisfying the slice the service asks for.
 *
 * `PersonStoreLike` is declared structurally so this module never imports the
 * store; this line is what stops that from quietly drifting apart from
 * `WatchLogStoreApi`, since nothing else in the tree connects the two.
 */
const _storeFits: PersonStoreLike = undefined as unknown as WatchLogStoreApi;
void _storeFits;

function client(routes: Record<string, FakeRoute>, config = CONFIG) {
  const fake = createFakeHttp(routes);
  const { clock } = createTestClock();
  return { fake, api: createTmdbPersonClient(() => config, { http: fake.http, clock }) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PERSON_RESPONSE = {
  id: 525,
  name: "Christopher Nolan",
  biography: "A British-American film director.",
  birthday: "1970-07-30",
  deathday: null,
  place_of_birth: "London, England, UK",
  profile_path: "/xuAIuYSmsUzKlUMBFGVZaWsY3DZ.jpg",
  known_for_department: "Directing",
  also_known_as: ["Chris Nolan", "  ", "克里斯托弗·诺兰"],
  gender: 2,
  imdb_id: "nm0634240",
  homepage: "",
  popularity: 12.5,
  combined_credits: {
    cast: [
      {
        id: 1,
        media_type: "movie",
        title: "Following",
        character: "Man in the Alley",
        release_date: "1998-11-05",
        poster_path: "/a.jpg",
        vote_average: 7.1,
        vote_count: 900,
      },
    ],
    crew: [
      {
        id: 27205,
        media_type: "movie",
        title: "Inception",
        job: "Director",
        department: "Directing",
        release_date: "2010-07-15",
        poster_path: "/b.jpg",
        vote_average: 8.4,
        vote_count: 34000,
      },
      {
        id: 27205,
        media_type: "movie",
        title: "Inception",
        job: "Writer",
        department: "Writing",
        release_date: "2010-07-15",
        poster_path: "/b.jpg",
        vote_average: 8.4,
        vote_count: 34000,
      },
      {
        // Debris: a media type this plugin has no screen for.
        id: 9,
        media_type: "person",
        name: "Someone",
        job: "Thanks",
        department: "Crew",
      },
    ],
  },
};

function person(overrides: Partial<TmdbPerson> = {}): TmdbPerson {
  return {
    id: 1,
    name: "Someone",
    biography: "",
    birthday: null,
    deathday: null,
    placeOfBirth: "",
    profileUrl: "",
    knownForDepartment: "Acting",
    alsoKnownAs: [],
    gender: "",
    imdbId: "",
    homepage: "",
    popularity: 0,
    ...overrides,
  };
}

function credit(
  tmdbId: number,
  title: string,
  department: string,
  role: string,
  releaseDate: string | null = null,
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

function titleWith(overrides: Partial<TitleV4> & { id: string; title: string }): TitleV4 {
  return createTitle({ type: "Movie", ...overrides });
}

/** A store stub. Cast because the test only owns the keys the service reads. */
function storeStub(titles: TitleV4[] = []) {
  const data = { schemaVersion: 4, titles, groups: [], history: [] } as unknown as WatchLogData;
  const save = vi.fn();
  return { data, allTitles: () => titles, save };
}

/** A client that fails the test if a method it was not given is reached. */
function fakeClient(overrides: Partial<TmdbPersonClient> = {}): TmdbPersonClient & {
  calls: string[];
} {
  const calls: string[] = [];
  const guard = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };
  return {
    calls,
    configured: () => true,
    person: overrides.person
      ? (id) => {
          calls.push("person");
          return (overrides.person as TmdbPersonClient["person"])(id);
        }
      : (guard("person") as unknown as TmdbPersonClient["person"]),
    searchPeople: overrides.searchPeople
      ? (query) => {
          calls.push("searchPeople");
          return (overrides.searchPeople as TmdbPersonClient["searchPeople"])(query);
        }
      : (guard("searchPeople") as unknown as TmdbPersonClient["searchPeople"]),
    titleCredits: overrides.titleCredits
      ? (id, type) => {
          calls.push("titleCredits");
          return (overrides.titleCredits as TmdbPersonClient["titleCredits"])(id, type);
        }
      : (guard("titleCredits") as unknown as TmdbPersonClient["titleCredits"]),
  };
}

function titleCredit(
  id: number,
  name: string,
  department = "Acting",
  role = "",
): TitleCreditPerson {
  return { id, name, department, role, profileUrl: "", order: 0 };
}

function candidate(id: number, name: string, popularity = 0): PersonCandidate {
  return { id, name, profileUrl: "", knownForDepartment: "Acting", knownFor: [], popularity };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

describe("the person client", () => {
  it("refuses to call out without a token", async () => {
    const { api, fake } = client({}, { token: "" });
    expect(api.configured()).toBe(false);
    await expect(api.person(525)).rejects.toMatchObject({ reason: "no-key" });
    expect(fake.calls).toHaveLength(0);
  });

  it("fetches person and filmography in one round trip, token in the header", async () => {
    const { api, fake } = client({ "/person/525": { body: PERSON_RESPONSE } });
    const { person: p, credits } = await api.person(525);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toContain("append_to_response=combined_credits");
    expect(fake.calls[0]?.url).not.toContain("api_key");
    expect(fake.calls[0]?.headers).toMatchObject({ Authorization: `Bearer ${CONFIG.token}` });
    expect(p.name).toBe("Christopher Nolan");
    expect(credits).toHaveLength(3);
  });

  it("retries once after a 429 rather than giving up", async () => {
    let call = 0;
    const { api, fake } = client({
      "/person/525": () => {
        call += 1;
        return call === 1 ? { status: 429, body: {} } : { body: PERSON_RESPONSE };
      },
    });
    expect((await api.person(525)).person.id).toBe(525);
    expect(fake.calls).toHaveLength(2);
  });

  it("flattens the person payload and never leaves a raw enum in it", () => {
    const p = normalizePerson(PERSON_RESPONSE as unknown as Record<string, unknown>, 0);
    expect(p).toMatchObject({
      id: 525,
      gender: "Male",
      birthday: "1970-07-30",
      deathday: null,
      placeOfBirth: "London, England, UK",
      knownForDepartment: "Directing",
      imdbId: "nm0634240",
    });
    // The blank alias is dropped rather than rendered as an empty chip.
    expect(p.alsoKnownAs).toEqual(["Chris Nolan", "克里斯托弗·诺兰"]);
    expect(p.profileUrl).toBe(
      "https://image.tmdb.org/t/p/h632/xuAIuYSmsUzKlUMBFGVZaWsY3DZ.jpg",
    );
  });

  it("tags cast as Acting, crew by department, and drops what it cannot render", () => {
    const credits = normalizeCombinedCredits(PERSON_RESPONSE.combined_credits);
    expect(credits.map((c) => [c.department, c.role])).toEqual([
      ["Acting", "Man in the Alley"],
      ["Directing", "Director"],
      ["Writing", "Writer"],
    ]);
    // `media_type: person` is not a movie or a show and is not guessed at.
    expect(credits.some((c) => c.result.title === "Someone")).toBe(false);
    expect(credits[0]?.result.year).toBe(1998);
  });

  it("reads person ids out of a title's own credits", () => {
    const credits = normalizeTitleCredits({
      cast: [{ id: 6193, name: "Leonardo DiCaprio", character: "Cobb", order: 0 }],
      crew: [{ id: 525, name: "Christopher Nolan", job: "Director", department: "Directing" }],
      // No id: unusable as an identity, so it is not offered as one.
      extra: [{ name: "Nobody" }],
    });
    expect(credits).toEqual([
      {
        id: 6193,
        name: "Leonardo DiCaprio",
        department: "Acting",
        role: "Cobb",
        profileUrl: "",
        order: 0,
      },
      {
        id: 525,
        name: "Christopher Nolan",
        department: "Directing",
        role: "Director",
        profileUrl: "",
        order: Number.MAX_SAFE_INTEGER,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("name matching", () => {
  it("ignores diacritics, punctuation and case", () => {
    expect(sameName("Penélope Cruz", "Penelope Cruz")).toBe(true);
    expect(sameName("Samuel L. Jackson", "samuel l jackson")).toBe(true);
    expect(personNameKey("  Zoë   Saldaña ")).toBe("zoe saldana");
    expect(sameName("Chris Evans", "Chris Evanson")).toBe(false);
    // An empty name matches nothing, including another empty one.
    expect(sameName("", "")).toBe(false);
  });

  it("finds the titles that credit a name, newest activity first", () => {
    const titles = [
      titleWith({ id: "a", title: "A", cast: ["Penelope Cruz"], dateModified: "2020-01-01" }),
      titleWith({ id: "b", title: "B", manualDirector: ["Penélope Cruz"], dateModified: "2026-01-01" }),
      titleWith({ id: "c", title: "C", cast: ["Someone Else"] }),
    ];
    expect(titlesCrediting(titles, "penelope cruz").map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("counts only exact hits from a search, most popular first", () => {
    const hits = [
      candidate(1, "Chris Evanson", 90),
      candidate(2, "Chris Evans", 10),
      candidate(3, "Chris Evans", 40),
    ];
    expect(exactNameHits(hits, "Chris Evans").map((h) => h.id)).toEqual([3, 2]);
  });

  it("collects the distinct ids a name maps to inside one credit list", () => {
    const credits = [
      titleCredit(1, "John Williams", "Sound", "Original Music Composer"),
      titleCredit(1, "John Williams", "Sound", "Conductor"),
      titleCredit(2, "John Williams", "Acting", "Guitarist"),
      titleCredit(3, "Someone Else"),
    ];
    expect(personIdsNamed(credits, "John Williams")).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolving a name to a person", () => {
  it("prefers the library's own credits, which give an exact id", async () => {
    const titles = [titleWith({ id: "inception", title: "Inception", tmdbId: 27205, tmdbMediaType: "movie", director: ["Christopher Nolan"] })];
    const api = fakeClient({
      titleCredits: async () => [titleCredit(525, "Christopher Nolan", "Directing", "Director")],
    });

    const outcome = await resolvePersonByName("Christopher Nolan", { client: api, titles });

    expect(outcome).toMatchObject({ state: "resolved", personId: 525, source: "credits" });
    // Search is the fallback, not the first move — it never ran.
    expect(api.calls).toEqual(["titleCredits"]);
  });

  it("reports two same-named people in the library as ambiguous, with what places them", async () => {
    const titles = [
      titleWith({ id: "a", title: "Space Jam", tmdbId: 2300, tmdbMediaType: "movie", cast: ["Michael Jordan"], dateModified: "2026-02-01" }),
      titleWith({ id: "b", title: "Home Front", tmdbId: 111, tmdbMediaType: "movie", cast: ["Michael Jordan"], dateModified: "2026-01-01" }),
    ];
    const byTitle: Record<number, TitleCreditPerson[]> = {
      2300: [titleCredit(21449, "Michael Jordan")],
      111: [titleCredit(999999, "Michael Jordan")],
    };
    const api = fakeClient({ titleCredits: async (id) => byTitle[id] ?? [] });

    const outcome = await resolvePersonByName("Michael Jordan", { client: api, titles });

    expect(outcome.state).toBe("ambiguous");
    if (outcome.state !== "ambiguous") throw new Error("unreachable");
    expect(outcome.candidates.map((c) => c.id).sort()).toEqual([21449, 999999]);
    // The candidate carries the title that places them, which is the only thing
    // that lets a human tell the two apart.
    expect(outcome.candidates.find((c) => c.id === 21449)?.knownFor).toEqual(["Space Jam"]);
    expect(outcome.candidates.find((c) => c.id === 999999)?.knownFor).toEqual(["Home Front"]);
  });

  it("falls back to search when the library has no TMDB-matched title for the name", async () => {
    const titles = [titleWith({ id: "a", title: "A", cast: ["Greta Gerwig"] })]; // no tmdbId
    const api = fakeClient({
      searchPeople: async () => [candidate(45400, "Greta Gerwig", 30), candidate(1, "Greta Gerwigson", 99)],
    });

    const outcome = await resolvePersonByName("Greta Gerwig", { client: api, titles });

    expect(outcome).toMatchObject({ state: "resolved", personId: 45400, source: "search" });
    expect(api.calls).toEqual(["searchPeople"]);
  });

  it("asks rather than picks when the search itself is ambiguous", async () => {
    const api = fakeClient({
      searchPeople: async () => [candidate(1, "David Thompson", 2), candidate(2, "David Thompson", 8)],
    });
    const outcome = await resolvePersonByName("David Thompson", { client: api, titles: [] });

    expect(outcome.state).toBe("ambiguous");
    if (outcome.state !== "ambiguous") throw new Error("unreachable");
    // Ordered by popularity, so the likely one leads — but neither is chosen.
    expect(outcome.candidates.map((c) => c.id)).toEqual([2, 1]);
  });

  it("says so plainly when TMDB knows nobody by that name", async () => {
    const api = fakeClient({ searchPeople: async () => [candidate(1, "Someone Else")] });
    expect(await resolvePersonByName("Made Up Person", { client: api, titles: [] })).toEqual({
      state: "unknown",
      name: "Made Up Person",
    });
  });

  it("survives one title's credits failing and still resolves from the others", async () => {
    const titles = [
      titleWith({ id: "a", title: "A", tmdbId: 1, tmdbMediaType: "movie", cast: ["Ana de Armas"], dateModified: "2026-02-01" }),
      titleWith({ id: "b", title: "B", tmdbId: 2, tmdbMediaType: "movie", cast: ["Ana de Armas"], dateModified: "2026-01-01" }),
    ];
    const api = fakeClient({
      titleCredits: async (id) => {
        if (id === 1) throw new Error("upstream is down");
        return [titleCredit(224513, "Ana de Armas")];
      },
    });
    expect(await resolvePersonByName("Ana de Armas", { client: api, titles })).toMatchObject({
      state: "resolved",
      personId: 224513,
    });
  });

  it("asks the right endpoint for a title that never recorded its media type", async () => {
    const asked: [number, string][] = [];
    const titles = [
      titleWith({
        id: "show",
        title: "Fargo",
        tmdbId: 60622,
        seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [] }],
        totalEpisodes: 10,
        cast: ["Billy Bob Thornton"],
      }),
    ];
    const api = fakeClient({
      titleCredits: async (id, type) => {
        asked.push([id, type]);
        return [titleCredit(1234, "Billy Bob Thornton")];
      },
    });

    await resolvePersonByName("Billy Bob Thornton", { client: api, titles });
    // `/movie/60622/credits` would answer happily, about a different film.
    expect(asked).toEqual([[60622, "tv"]]);
    expect(mediaTypeFor(titleWith({ id: "f", title: "F", tmdbId: 1 }))).toBe("movie");
  });

  it("treats a blank name as nobody without calling anything", async () => {
    const api = fakeClient();
    expect(await resolvePersonByName("   ", { client: api, titles: [] })).toMatchObject({
      state: "unknown",
    });
    expect(api.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filmography shaping
// ---------------------------------------------------------------------------

describe("filmography shaping", () => {
  it("merges a title credited twice into one poster with both roles", () => {
    const merged = dedupeCredits([
      credit(1, "Inception", "Directing", "Director", "2010-07-15"),
      credit(1, "Inception", "Directing", "Producer", "2010-07-15"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.role).toBe("Director / Producer");
  });

  it("leads with the person's own department and puts newest work first", () => {
    const sections = groupFilmography(
      [
        credit(1, "Old Film", "Directing", "Director", "1998-01-01"),
        credit(2, "New Film", "Directing", "Director", "2023-01-01"),
        credit(3, "A Cameo", "Acting", "Himself", "2010-01-01"),
        credit(4, "Announced", "Directing", "Director", null),
      ],
      "Directing",
    );

    expect(sections.map((s) => s.department)).toEqual(["Directing", "Acting"]);
    expect(sections[0]?.credits.map((c) => c.result.title)).toEqual([
      "New Film",
      "Old Film",
      // Undated work is announced, not released — it sorts last, not first.
      "Announced",
    ]);
  });

  it("recognises a credit already in the library by id and by name", () => {
    const titles = [
      titleWith({ id: "inception", title: "Inception", tmdbId: 27205, tmdbMediaType: "movie" }),
      titleWith({ id: "following", title: "Following" }),
    ];
    expect(ownedTitleFor(credit(27205, "Inception", "Directing", "Director"), titles)?.id).toBe(
      "inception",
    );
    // Added before it had an id: still owned, still not offered back as "+ Add".
    expect(ownedTitleFor(credit(1, "Following", "Acting", "Man"), titles)?.id).toBe("following");
    expect(ownedTitleFor(credit(999, "Tenet", "Directing", "Director"), titles)).toBeUndefined();
  });

  it("does not confuse a film with a show of the same TMDB id", () => {
    const titles = [titleWith({ id: "x", title: "Fargo", tmdbId: 60622, tmdbMediaType: "tv" })];
    const film = credit(60622, "Something Else", "Acting", "Self");
    expect(ownedTitleFor(film, titles)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

describe("age", () => {
  it("counts the birthday that has not happened yet as not counted", () => {
    const p = person({ birthday: "1970-07-30" });
    expect(ageFacts(p, "2026-07-29").age).toBe(55);
    expect(ageFacts(p, "2026-07-30").age).toBe(56);
    expect(birthdayLabel(ageFacts(p, "2026-08-18"))).toBe("1970-07-30 (age 56)");
  });

  it("stops the clock at death rather than reporting an age they never reached", () => {
    const p = person({ birthday: "1930-08-25", deathday: "2022-09-06" });
    const facts = ageFacts(p, "2026-08-18");
    expect(facts).toMatchObject({ age: 92, atDeath: true, deathday: "2022-09-06" });
    expect(birthdayLabel(facts)).toBe("1930-08-25 (aged 92 at death)");
  });

  it("has no age at all when TMDB has no birthday, rather than a confident zero", () => {
    expect(ageFacts(person(), "2026-08-18")).toMatchObject({ age: null, birthday: "" });
    expect(birthdayLabel(ageFacts(person(), "2026-08-18"))).toBe("");

    // Dead, but with no birthday on file: the death date is still a fact.
    const facts = ageFacts(person({ deathday: "1999-01-01" }), "2026-08-18");
    expect(facts).toMatchObject({ age: null, deathday: "1999-01-01", atDeath: true });
  });

  it("refuses to compute an age from a date it cannot read", () => {
    expect(ageFacts(person({ birthday: "circa 1900" }), "2026-08-18").age).toBeNull();
    expect(birthdayLabel(ageFacts(person({ birthday: "circa 1900" }), "2026-08-18"))).toBe(
      "circa 1900",
    );
  });
});

// ---------------------------------------------------------------------------
// The cache and the service
// ---------------------------------------------------------------------------

describe("the person cache", () => {
  it("lives under a preserved data key and is created on first use", () => {
    const store = storeStub();
    const cache = personCacheOf(store.data);
    expect(cache).toEqual({ version: 1, byId: {}, names: {} });
    expect((store.data as unknown as Record<string, unknown>)[PERSON_CACHE_KEY]).toBe(cache);
  });

  it("discards a cache written by a version it cannot read", () => {
    const store = storeStub();
    (store.data as unknown as Record<string, unknown>)[PERSON_CACHE_KEY] = {
      version: 99,
      byId: { "1": {} },
    };
    expect(personCacheOf(store.data).byId).toEqual({});
  });

  it("evicts the oldest people at the cap", () => {
    const cache = personCacheOf(storeStub().data);
    for (const [id, at] of [
      ["1", "2026-01-01T00:00:00.000Z"],
      ["2", "2026-03-01T00:00:00.000Z"],
      ["3", "2026-02-01T00:00:00.000Z"],
    ] as [string, string][]) {
      cache.byId[id] = { person: person({ id: Number(id) }), credits: [], fetchedAt: at };
    }
    evictPeople(cache, 2);
    expect(Object.keys(cache.byId).sort()).toEqual(["2", "3"]);
  });
});

describe("the person service", () => {
  const fetched = { person: person({ id: 525, name: "Christopher Nolan" }), credits: [] };

  it("fetches once and serves every later open from data.json", async () => {
    const store = storeStub();
    let calls = 0;
    const api = fakeClient({
      person: async () => {
        calls += 1;
        return fetched;
      },
    });
    const service = createPersonService({ store, client: api, now: () => 1_000 });

    const first = await service.load(525);
    expect(first.person.name).toBe("Christopher Nolan");
    expect(calls).toBe(1);
    expect(store.save).toHaveBeenCalled();

    // The whole point: a second open is not a request.
    await service.load(525);
    expect(calls).toBe(1);
    expect(service.cached(525)?.person.id).toBe(525);
  });

  it("refetches when forced, and when the entry has aged past its TTL", async () => {
    const store = storeStub();
    let calls = 0;
    let now = 1_000;
    const api = fakeClient({
      person: async () => {
        calls += 1;
        return fetched;
      },
    });
    const service = createPersonService({ store, client: api, now: () => now, ttlMs: 10_000 });

    await service.load(525);
    await service.load(525, { force: true });
    expect(calls).toBe(2);

    const entry = service.cached(525) as NonNullable<ReturnType<typeof service.cached>>;
    expect(service.isStale(entry)).toBe(false);
    now += 20_000;
    expect(service.isStale(entry)).toBe(true);
    await service.load(525);
    expect(calls).toBe(3);
  });

  it("serves the stale copy when the refetch fails, and only errors with nothing to show", async () => {
    const store = storeStub();
    let fail = false;
    const api = fakeClient({
      person: async () => {
        if (fail) throw new Error("upstream is down");
        return fetched;
      },
    });
    const service = createPersonService({ store, client: api, now: () => 0, ttlMs: 1 });

    await service.load(525);
    fail = true;
    // Last month's filmography is very nearly this month's; a blank screen is not.
    expect((await service.load(525)).person.id).toBe(525);
    await expect(service.load(999)).rejects.toThrow("upstream is down");
  });

  it("remembers what a name resolved to, so the lookup runs exactly once", async () => {
    const titles = [
      titleWith({ id: "a", title: "Inception", tmdbId: 27205, tmdbMediaType: "movie", director: ["Christopher Nolan"] }),
    ];
    const store = storeStub(titles);
    let lookups = 0;
    const api = fakeClient({
      titleCredits: async () => {
        lookups += 1;
        return [titleCredit(525, "Christopher Nolan", "Directing", "Director")];
      },
    });
    const service = createPersonService({ store, client: api, now: () => 0 });

    expect(await service.resolve("Christopher Nolan")).toMatchObject({ personId: 525 });
    expect(await service.resolve("christopher  nolan")).toMatchObject({
      personId: 525,
      source: "cache",
    });
    expect(lookups).toBe(1);
    // And a cold render can read it back with no promise at all.
    expect(service.cachedResolution("Christopher Nolan")).toMatchObject({ personId: 525 });
  });

  it("remembers an ambiguous name as ambiguous, and the user's answer as final", async () => {
    const store = storeStub();
    const api = fakeClient({
      searchPeople: async () => [candidate(1, "David Thompson", 5), candidate(2, "David Thompson", 9)],
    });
    const service = createPersonService({ store, client: api, now: () => 0 });

    expect((await service.resolve("David Thompson")).state).toBe("ambiguous");
    expect(service.cachedResolution("David Thompson")?.state).toBe("ambiguous");

    service.rememberChoice("David Thompson", 2);
    expect(service.cachedResolution("David Thompson")).toMatchObject({
      state: "resolved",
      personId: 2,
    });
  });
});
