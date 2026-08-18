/**
 * Open Library's author endpoints (`/authors/{key}.json`,
 * `/authors/{key}/works.json`, `/search/authors.json`).
 *
 * Every body below is a fixture in the shape the live API returns, and the fake
 * transport throws loudly on an unrouted URL — no test in this repo touches the
 * network.
 *
 * What is worth pinning is the set of facts that are cheap to lose in a refactor
 * and expensive to notice in production:
 *
 *   - **Every author request goes through the limiter.** The counting limiter
 *     below fails the test if a single call reaches the transport outside
 *     `run()`. Open Library's 3 req/s is enforced upstream, and a bibliography
 *     page is the exact shape of request burst that trips it.
 *   - **The User-Agent goes with it**, which is what buys 3 req/s over 1.
 *   - **`title=`/`author=`, never a pasted `q`.** Free text returns nothing
 *     useful here; the field params match first time.
 *   - Author keys arrive in two forms (`OL79034A` and `/authors/OL79034A`) and
 *     only one is ever stored.
 */
import { describe, expect, it } from "vitest";
import { createFakeHttp } from "../mocks/http";
import type { RateLimiter } from "../../src/services/ratelimit";
import {
  DEFAULT_OPEN_LIBRARY_UA,
  authorKeyOf,
  createOpenLibraryClient,
  normalizeAuthor,
  normalizeAuthorWork,
  openLibraryAuthorPhotoUrl,
} from "../../src/services/openlibrary";

// --- fixtures ---------------------------------------------------------------

const AUTHOR_BODY = {
  key: "/authors/OL79034A",
  name: "Frank Herbert",
  personal_name: "Frank Patrick Herbert",
  birth_date: "8 October 1920",
  death_date: "11 February 1986",
  bio: { type: "/type/text", value: "American science fiction writer, best known for Dune." },
  alternate_names: ["HERBERT FRANK", "Frank Patrick Herbert"],
  photos: [6157281],
  links: [{ title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Frank_Herbert" }],
  type: { key: "/type/author" },
};

const WORKS_BODY = {
  size: 231,
  entries: [
    {
      type: { key: "/type/work" },
      key: "/works/OL893414W",
      title: "Dune",
      covers: [8231990],
      first_publish_date: "1965",
      subjects: ["Science fiction", "Desert"],
      description: { type: "/type/text", value: "A desert planet." },
    },
    {
      key: "/works/OL27448W",
      title: "Dune Messiah",
      covers: [-1, 240727],
      first_publish_date: "October 1969",
    },
    // Same work, listed twice — re-issues repeat in this endpoint.
    { key: "/works/OL893414W", title: "Dune", covers: [8231990] },
    // No title: debris, and never a blank cover on screen.
    { key: "/works/OL1W", covers: [1] },
    // No date at all, which is most of a long bibliography.
    { key: "/works/OL9W", title: "The Dragon in the Sea" },
  ],
};

const AUTHOR_SEARCH_BODY = {
  numFound: 2,
  docs: [
    {
      key: "OL118060A",
      name: "John Williams",
      birth_date: "1922",
      death_date: "1994",
      top_work: "Stoner",
      work_count: 34,
      alternate_names: ["John Edward Williams"],
    },
    {
      key: "OL234297A",
      name: "John Williams",
      birth_date: "1932",
      top_work: "Star Wars",
      work_count: 118,
    },
  ],
};

const SEARCH_BODY = {
  numFound: 1,
  docs: [{ author_key: ["OL79034A"], author_name: ["Frank Herbert"] }],
};

/**
 * A limiter that counts, and a flag saying whether the transport is currently
 * being called from inside one.
 *
 * This is the whole proof: `unlimited` above zero means a request reached the
 * network without passing the 334 ms gap.
 */
function countingLimiter() {
  const state = { runs: 0, depth: 0, unlimited: 0 };
  const limiter: RateLimiter = {
    pending: 0,
    idle: () => Promise.resolve(),
    run<T>(fn: () => Promise<T>): Promise<T> {
      state.runs += 1;
      state.depth += 1;
      return fn().finally(() => {
        state.depth -= 1;
      });
    },
  };
  return { limiter, state };
}

function openLibrary(routes: Record<string, unknown>) {
  const { limiter, state } = countingLimiter();
  const inner = createFakeHttp(routes as never);
  const fake = {
    ...inner,
    http: ((options) => {
      if (state.depth === 0) state.unlimited += 1;
      return inner.http(options);
    }) as typeof inner.http,
  };
  const client = createOpenLibraryClient(() => ({ userAgent: DEFAULT_OPEN_LIBRARY_UA }), {
    http: fake.http,
    limiter,
  });
  return { client, fake: inner, state };
}

// ---------------------------------------------------------------------------

describe("author keys", () => {
  it("reads both forms the API hands back, and stores one", () => {
    expect(authorKeyOf("OL79034A")).toBe("OL79034A");
    expect(authorKeyOf("/authors/OL79034A")).toBe("OL79034A");
    expect(authorKeyOf("ol79034a")).toBe("OL79034A");
  });

  it("refuses anything that is not one rather than passing it into a URL", () => {
    expect(authorKeyOf("")).toBe("");
    expect(authorKeyOf("Frank Herbert")).toBe("");
    expect(authorKeyOf("/works/OL893414W")).toBe("");
    expect(authorKeyOf(undefined)).toBe("");
  });
});

describe("author photos", () => {
  it("uses the /a/ path and carries ?default=false", () => {
    expect(openLibraryAuthorPhotoUrl("id", "6157281")).toBe(
      "https://covers.openlibrary.org/a/id/6157281-M.jpg?default=false",
    );
    expect(openLibraryAuthorPhotoUrl("olid", "OL79034A", "L")).toBe(
      "https://covers.openlibrary.org/a/olid/OL79034A-L.jpg?default=false",
    );
  });

  it("is empty for an author with no photo, rather than a URL that 404s", () => {
    expect(openLibraryAuthorPhotoUrl("id", "  ")).toBe("");
    // `photos: [-1]` is how a removed photo is recorded.
    expect(normalizeAuthor({ name: "X", photos: [-1] }, "OL1A").photoUrl).toBe("");
    expect(normalizeAuthor({ name: "X" }, "OL1A").photoUrl).toBe("");
  });
});

describe("author normalisation", () => {
  it("flattens the record the endpoint actually returns", () => {
    const author = normalizeAuthor(AUTHOR_BODY, "OL79034A");
    expect(author).toMatchObject({
      key: "OL79034A",
      name: "Frank Herbert",
      personalName: "Frank Patrick Herbert",
      biography: "American science fiction writer, best known for Dune.",
      birthDate: "8 October 1920",
      deathDate: "11 February 1986",
      alternateNames: ["HERBERT FRANK", "Frank Patrick Herbert"],
    });
    expect(author.links).toEqual([
      { title: "Wikipedia", url: "https://en.wikipedia.org/wiki/Frank_Herbert" },
    ]);
    expect(author.photoUrl).toContain("/a/id/6157281-M.jpg");
  });

  it("takes a bio that is a plain string as readily as one that is a text node", () => {
    expect(normalizeAuthor({ name: "X", bio: "Plain." }, "OL1A").biography).toBe("Plain.");
  });

  it("leaves free-text dates exactly as the catalogue wrote them", () => {
    // Reformatting "8 October 1920" into a date would be stating a precision the
    // record does not have.
    const author = normalizeAuthor({ name: "X", birth_date: "ca. 1200" }, "OL1A");
    expect(author.birthDate).toBe("ca. 1200");
    expect(author.deathDate).toBe("");
  });

  it("degrades to an empty author rather than throwing on a bare record", () => {
    const author = normalizeAuthor({}, "OL5A");
    expect(author).toMatchObject({
      key: "OL5A",
      name: "",
      biography: "",
      birthDate: "",
      deathDate: "",
      alternateNames: [],
      links: [],
      photoUrl: "",
    });
  });
});

describe("work normalisation", () => {
  it("produces the same shape the add flow already takes", () => {
    const work = normalizeAuthorWork(WORKS_BODY.entries[0] as never, "Frank Herbert");
    expect(work).toMatchObject({
      id: "/works/OL893414W",
      source: "openlibrary",
      title: "Dune",
      authors: ["Frank Herbert"],
      firstPublishYear: 1965,
      description: "A desert planet.",
      categories: ["Science fiction", "Desert"],
    });
    expect(work?.coverUrl).toBe(
      "https://covers.openlibrary.org/b/id/8231990-M.jpg?default=false",
    );
  });

  it("trusts only a four-digit year out of free-text publish dates", () => {
    expect(normalizeAuthorWork({ key: "/works/A", title: "T", first_publish_date: "October 1969" }, "")?.firstPublishYear).toBe(1969);
    expect(normalizeAuthorWork({ key: "/works/A", title: "T", first_publish_date: "n.d." }, "")?.firstPublishYear).toBeUndefined();
  });

  it("drops an entry with no title instead of drawing a blank cover", () => {
    expect(normalizeAuthorWork({ key: "/works/A", covers: [1] }, "")).toBeUndefined();
  });
});

describe("the author client", () => {
  it("fetches an author through the limiter, with the User-Agent that buys 3 req/s", async () => {
    const { client, fake, state } = openLibrary({ "/authors/OL79034A.json": { body: AUTHOR_BODY } });
    const author = await client.author("/authors/OL79034A");

    expect(author.name).toBe("Frank Herbert");
    expect(fake.urls[0]).toBe("https://openlibrary.org/authors/OL79034A.json");
    expect(fake.calls[0]?.headers?.["User-Agent"]).toBe(DEFAULT_OPEN_LIBRARY_UA);
    expect(state.runs).toBe(1);
    expect(state.unlimited).toBe(0);
  });

  it("refuses to build a URL out of something that is not a key", async () => {
    const { client, fake } = openLibrary({ "/authors/": { body: AUTHOR_BODY } });
    await expect(client.author("Frank Herbert")).rejects.toThrow();
    // And it did not spend a request finding that out.
    expect(fake.calls).toHaveLength(0);
  });

  it("returns a bibliography with the repeats collapsed and the debris dropped", async () => {
    const { client, state } = openLibrary({ "/works.json": { body: WORKS_BODY } });
    const works = await client.authorWorks("OL79034A");

    // Endpoint order, untouched — ordering a bibliography is the service's job
    // (`sortWorks`), so it happens in exactly one place.
    expect(works.map((w) => w.title)).toEqual(["Dune", "Dune Messiah", "The Dragon in the Sea"]);
    // `covers: [-1, 240727]` — the sentinel is skipped, the real id is used.
    expect(works[1]?.coverUrl).toContain("/b/id/240727-");
    expect(state.unlimited).toBe(0);
  });

  it("asks for a bounded page of works rather than the whole shelf", async () => {
    const { client, fake } = openLibrary({ "/works.json": { body: WORKS_BODY } });
    await client.authorWorks("OL79034A", 25);
    expect(fake.urls[0]).toContain("/authors/OL79034A/works.json?limit=25");
  });

  it("searches authors by name and keeps what tells two apart", async () => {
    const { client, fake, state } = openLibrary({
      "/search/authors.json": { body: AUTHOR_SEARCH_BODY },
    });
    const hits = await client.searchAuthors("John Williams");

    expect(fake.urls[0]).toContain("/search/authors.json?q=John%20Williams");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ key: "OL118060A", topWork: "Stoner", workCount: 34 });
    expect(hits[1]).toMatchObject({ key: "OL234297A", topWork: "Star Wars", workCount: 118 });
    expect(state.unlimited).toBe(0);
  });

  it("asks for a book's author key with title= and author=, never a pasted q", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    const refs = await client.authorKeysFor("Dune", "Frank Herbert");

    const url = fake.urls[0] ?? "";
    expect(url).toContain("title=Dune");
    expect(url).toContain("author=Frank%20Herbert");
    expect(url).not.toContain("q=");
    // And it asks for two fields, not the 60-ISBN default doc.
    expect(url).toContain("fields=author_key%2Cauthor_name");
    expect(refs).toEqual([{ key: "OL79034A", name: "Frank Herbert" }]);
  });

  it("spends no request at all on a lookup that cannot succeed", async () => {
    const { client, fake } = openLibrary({ "/search.json": { body: SEARCH_BODY } });
    expect(await client.authorKeysFor("Dune", "  ")).toEqual([]);
    expect(await client.searchAuthors("  ")).toEqual([]);
    expect(await client.authorWorks("nonsense")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("hands back an empty bibliography rather than throwing on a strange body", async () => {
    const { client } = openLibrary({ "/works.json": { body: { entries: "nope" } } });
    expect(await client.authorWorks("OL79034A")).toEqual([]);
  });
});
