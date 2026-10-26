/**
 * The whole local API, end to end: a real server on 127.0.0.1 and an
 * OS-assigned port, the real router and route modules, and a real
 * `WatchLogStore` + reading store loaded from the v3 parity fixture. Only
 * `loadData`/`saveData` are faked, so what reaches `saveData` is exactly what
 * would reach `data.json`.
 *
 * One scenario walks every route `docs/api.md` lists, in order, and then:
 * - checks the docs' route table against the routes the walk exercised, so a
 *   route cannot be documented without being served (or the reverse);
 * - deep-compares the last save with the library as it loaded, and insists
 *   that every difference sits inside a record the walk meant to change, and
 *   that no key anywhere was lost.
 *
 * A socket opened from here is always loopback, so the remote-write rule is
 * driven through `createRequestListener` with a peer on the tailnet.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiRevision, type ApiRevision } from "../src/api/revision";
import { API_BASE } from "../src/api/router";
import { createRequestListener, startApiServer, type ApiServer } from "../src/api/server";
import type { ApiDeps } from "../src/api/types";
import { WatchLogStore } from "../src/data/store";
import { createReadingStore } from "../src/domains/reading/store";
import { installDomGlobals } from "./helpers/dom";

type Json = Record<string, unknown>;

const TOKEN = "e2e-".padEnd(48, "0");
const NOW = new Date(2026, 9, 26, 21, 0);
const DOCS = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");

/** The parity fixture, plus keys v4 never declared on the two rows the walk edits in place. */
function input(): Json {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/data-v3-parity.json", import.meta.url), "utf8")) as Json;
  const titles = raw.titles as Json[];
  Object.assign(titles.find((t) => t.id === "dexter") as Json, {
    rewatchCount: 2,
    legacyNotes: { source: "v2", flags: ["imported", "checked"] },
  });
  const books = (raw.reading as Json).books as Json[];
  Object.assign(books.find((b) => b.id === "half-filled") as Json, { lentTo: "Sam", shelfLocation: "bedside" });
  return raw;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let restoreDom: () => void;
let revision: ApiRevision;
let store: WatchLogStore;
let deps: ApiDeps;
let server: ApiServer;
let agent: http.Agent;
const saves: Json[] = [];
/** The library as it loaded: what a save with no edits would write. */
let baseline: Json;
const original = input();

/** `METHOD /template` for every request the walk made, to check against the docs. */
const exercised = new Set<string>();

beforeAll(async () => {
  restoreDom = installDomGlobals();
  // The store dispatches its change event on `document`, and the revision
  // counter listens there: it has to be a real event target.
  const doc = Object.assign(new EventTarget(), { body: (globalThis as unknown as { document: Json }).document.body });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: doc });
  revision = createApiRevision(doc);

  store = new WatchLogStore({
    loadData: async () => JSON.parse(JSON.stringify(original)) as unknown,
    saveData: async (data: unknown) => {
      // A write that takes a moment, so "flushed" and "merely queued" differ.
      await new Promise((resolve) => setTimeout(resolve, 2));
      saves.push(JSON.parse(JSON.stringify(data)) as Json);
    },
  } as never);
  await store.load();
  await store.flush();
  baseline = JSON.parse(JSON.stringify(store.data)) as Json;
  deps = {
    store,
    reading: createReadingStore(store),
    version: "1.34.0-test",
    revision: () => revision.current(),
    now: () => NOW,
  };
  agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  server = await startApiServer({ hosts: ["127.0.0.1"], port: 0, token: TOKEN, deps, allowRemoteWrites: () => false });
});

afterAll(async () => {
  agent?.destroy();
  await server?.close();
  revision?.dispose();
  restoreDom?.();
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  /** `x-wrl-revision`, or undefined when the response did not carry one. */
  rev: number | undefined;
}

/**
 * One request. `template` is the route as `docs/api.md` writes it; `:name`
 * placeholders are filled from `params`.
 */
function api(
  method: string,
  template: string,
  opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; token?: string | null } = {},
): Promise<Reply> {
  exercised.add(`${method} ${template}`);
  let path = template.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(opts.params?.[name] ?? `:${name}`));
  if (opts.query) path += `?${new URLSearchParams(opts.query).toString()}`;
  return raw(method, path, opts.body, opts.token === undefined ? TOKEN : opts.token);
}

function raw(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (text !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(text));
    }
    const req = http.request(
      { host: "127.0.0.1", port: server.port, method, path: `${API_BASE}${path}`, headers, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const out = Buffer.concat(chunks).toString("utf8");
          const header = res.headers["x-wrl-revision"];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: out === "" ? undefined : JSON.parse(out),
            rev: typeof header === "string" ? Number(header) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

/** The revision the last authenticated answer carried; every write must move it on. */
let lastRev = -1;

async function read(method: string, template: string, opts: Parameters<typeof api>[2] = {}, status = 200): Promise<Json> {
  const r = await api(method, template, opts);
  expect(r.status, `${method} ${template} → ${JSON.stringify(r.body)}`).toBe(status);
  expect(r.rev).toBeTypeOf("number");
  lastRev = r.rev as number;
  return r.body as Json;
}

async function write(method: string, template: string, opts: Parameters<typeof api>[2] = {}, status = 200): Promise<Json> {
  const before = lastRev;
  const savesBefore = saves.length;
  const r = await api(method, template, opts);
  expect(r.status, `${method} ${template} → ${JSON.stringify(r.body)}`).toBe(status);
  expect(r.rev, `${method} ${template} moves x-wrl-revision on`).toBeGreaterThan(before);
  // Flushed before the 2xx: the change is already in a completed save.
  expect(saves.length).toBeGreaterThan(savesBefore);
  lastRev = r.rev as number;
  return r.body as Json;
}

/** A refused request: the status, and a body that is `{ error }` and nothing else. */
async function refused(method: string, template: string, opts: Parameters<typeof api>[2], status: number): Promise<Reply> {
  const r = await api(method, template, opts);
  expect(r.status, `${method} ${template} → ${JSON.stringify(r.body)}`).toBe(status);
  expectErrorBody(r.body);
  return r;
}

function expectErrorBody(body: unknown): void {
  expect(body).toEqual({ error: expect.any(String) });
  expect((body as { error: string }).error).not.toBe("");
}

function expectPage(body: Json): { items: Json[]; total: number } {
  expect(Object.keys(body).sort()).toEqual(["items", "total"]);
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.total).toBeTypeOf("number");
  return body as { items: Json[]; total: number };
}

const idsOf = (body: Json): string[] => expectPage(body).items.map((item) => item.id as string);

/** Every write lands in the saves; the latest one is what `data.json` holds now. */
const lastSave = (): Json => saves[saves.length - 1] as Json;
const savedTitle = (id: string): Json | undefined => (lastSave().titles as Json[]).find((t) => t.id === id);
const savedBook = (id: string): Json | undefined =>
  ((lastSave().reading as Json).books as Json[]).find((b) => b.id === id);

// ---------------------------------------------------------------------------
// Deep compare
// ---------------------------------------------------------------------------

/**
 * Every path at which `a` and `b` differ. Arrays of objects that all carry an
 * `id` are matched by id (`titles[id=dune]`), so an insertion does not shift
 * every later element into a "difference".
 */
function differences(a: unknown, b: unknown, path = ""): { path: string; kind: "lost" | "added" | "changed" }[] {
  if (a === b) return [];
  const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
  const byId = (v: unknown): v is Json[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === "string");
  if (Array.isArray(a) && Array.isArray(b) && (byId(a) || a.length === 0) && (byId(b) || b.length === 0) && (a.length || b.length)) {
    const left = new Map((a as Json[]).map((x) => [x.id as string, x]));
    const right = new Map((b as Json[]).map((x) => [x.id as string, x]));
    const out: ReturnType<typeof differences> = [];
    for (const [id, x] of left) {
      out.push(...(right.has(id) ? differences(x, right.get(id), `${path}[id=${id}]`) : [{ path: `${path}[id=${id}]`, kind: "lost" as const }]));
    }
    for (const id of right.keys()) if (!left.has(id)) out.push({ path: `${path}[id=${id}]`, kind: "added" });
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out: ReturnType<typeof differences> = [];
    for (const key of Object.keys(a)) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in b)) out.push({ path: p, kind: "lost" });
      else out.push(...differences(a[key], b[key], p));
    }
    for (const key of Object.keys(b)) if (!(key in a)) out.push({ path: path ? `${path}.${key}` : key, kind: "added" });
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, kind: "changed" }];
}

/** Every key path in a value, arrays of id'd objects keyed by id. */
function keyPaths(value: unknown, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((x, i) => {
      const id = typeof x === "object" && x !== null && typeof (x as Json).id === "string" ? `id=${(x as Json).id}` : String(i);
      keyPaths(x, `${path}[${id}]`, out);
    });
  } else if (typeof value === "object" && value !== null) {
    for (const [key, x] of Object.entries(value)) {
      const p = path ? `${path}.${key}` : key;
      out.add(p);
      keyPaths(x, p, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** Records the walk created, edited or deleted on purpose; any other difference is a bug. */
const touched = { titles: new Set<string>(), books: new Set<string>(), deletedTitles: new Set<string>(), deletedBooks: new Set<string>() };

describe("local API end to end", () => {
  it("serves /health before anything else, and refuses a caller without the token", async () => {
    const health = await read("GET", "/health");
    expect(health).toMatchObject({ ok: true, version: "1.34.0-test", ready: true, revision: lastRev });
    expect(health.counts).toEqual({ films: 0, shows: 1, books: 2, audiobooks: 0 });

    for (const token of [null, "", "wrong-token"]) {
      const r = await refused("GET", "/films", { token }, 401);
      // An unauthenticated caller learns nothing, not even that something changed.
      expect(r.rev).toBeUndefined();
    }
    const write401 = await refused("POST", "/films", { token: null, body: { title: "Sneaky" } }, 401);
    expect(write401.rev).toBeUndefined();
    expect(store.getTitle("sneaky")).toBeUndefined();
  });

  it("films: list, add, read, update, log watched, delete", async () => {
    expect(idsOf(await read("GET", "/films"))).toEqual([]);

    const made = await write("POST", "/films", {
      body: { title: "Arrival", ids: { tmdb: 329865, imdb: "tt2543164" }, tags: ["sci-fi"] },
    }, 201);
    expect(made).toMatchObject({ id: "arrival", kind: "film", title: "Arrival" });
    touched.titles.add("arrival");
    expect(savedTitle("arrival")).toMatchObject({ title: "Arrival", tmdbId: 329865 });

    // Same name, or the same TMDB film: a conflict with the library.
    await refused("POST", "/films", { body: { title: " ARRIVAL " } }, 409);
    await refused("POST", "/films", { body: { title: "Story of Your Life", ids: { tmdb: 329865 } } }, 409);

    expect(await read("GET", "/films/:id", { params: { id: "arrival" } })).toEqual(made);
    const patched = await write("PATCH", "/films/:id", { params: { id: "arrival" }, body: { notes: "Heptapods" } });
    expect(patched.notes).toBe("Heptapods");

    const watched = await write("POST", "/films/:id/watched", {
      params: { id: "arrival" },
      body: { date: "2026-10-25", rating: 4 },
    });
    expect(watched).toMatchObject({ rating: 4, dates: { finished: "2026-10-25" } });
    expect(savedTitle("arrival")).toMatchObject({ dateFinished: "2026-10-25", rating: 4 });

    const temp = await write("POST", "/films", { body: { title: "Heat" } }, 201);
    expect(await write("DELETE", "/films/:id", { params: { id: temp.id as string } })).toEqual({ deleted: true, id: "heat" });
    touched.deletedTitles.add("heat");
    expect(savedTitle("heat")).toBeUndefined();
    await refused("GET", "/films/:id", { params: { id: "heat" } }, 404);

    // Most recently modified first: Arrival was touched before Heat came and went.
    const listed = expectPage(await read("GET", "/films", { query: { limit: "5000" } }));
    expect(listed).toMatchObject({ total: 1, items: [{ id: "arrival" }] });
  });

  it("shows: add, list, update, episodes, seasons, progress, log watched, delete", async () => {
    const made = await write("POST", "/shows", {
      body: { title: "The Expanse", seasons: [{ episodes: 3 }, { episodes: 2 }] },
    }, 201);
    expect(made).toMatchObject({ id: "the-expanse", kind: "show" });
    touched.titles.add("the-expanse");

    const shows = expectPage(await read("GET", "/shows"));
    expect(shows.items.map((t) => t.id)).toEqual(["the-expanse", "dexter"]);
    expect(shows.total).toBe(2);
    expect(idsOf(await read("GET", "/shows", { query: { offset: "1", limit: "1" } }))).toEqual(["dexter"]);

    expect(await read("GET", "/shows/:id", { params: { id: "the-expanse" } })).toMatchObject({ id: "the-expanse" });
    await write("PATCH", "/shows/:id", { params: { id: "the-expanse" }, body: { favorite: true } });
    await write("POST", "/shows/:id/episodes", { params: { id: "the-expanse" }, body: { season: 1, episode: 2 } });
    await write("POST", "/shows/:id/seasons/:n", { params: { id: "the-expanse", n: "2" }, body: { watched: true } });
    expect(savedTitle("the-expanse")?.watchedEpisodes).toEqual([2, 4, 5]);

    const progress = await read("GET", "/shows/:id/progress", { params: { id: "the-expanse" } });
    expect(progress).toMatchObject({ id: "the-expanse" });
    expect(JSON.stringify(progress)).toContain("seasons");

    // A record from the fixture, with keys v4 never declared.
    await write("POST", "/shows/:id/watched", { params: { id: "dexter" }, body: { date: "2026-10-24" } });
    touched.titles.add("dexter");
    expect(savedTitle("dexter")).toMatchObject({ rewatchCount: 2, legacyNotes: { source: "v2", flags: ["imported", "checked"] } });

    const temp = await write("POST", "/shows", { body: { title: "Pilot Season", totalEpisodes: 2 } }, 201);
    expect(await write("DELETE", "/shows/:id", { params: { id: temp.id as string } })).toEqual({
      deleted: true,
      id: "pilot-season",
    });
    touched.deletedTitles.add("pilot-season");
  });

  it("books: list, add, read, update, log read, delete", async () => {
    const before = expectPage(await read("GET", "/books"));
    expect(before.items.map((b) => b.id).sort()).toEqual(["dune", "half-filled"]);

    const made = await write("POST", "/books", {
      body: { title: "Piranesi", author: "Susanna Clarke", openLibraryKey: "/works/OL20893680W", totalPages: 272 },
    }, 201);
    const id = made.id as string;
    touched.books.add(id);
    await refused("POST", "/books", { body: { title: "piranesi" } }, 409);

    expect(await read("GET", "/books/:id", { params: { id } })).toMatchObject({ title: "Piranesi" });
    // A fixture row with keys v4 never declared.
    await write("PATCH", "/books/:id", { params: { id: "half-filled" }, body: { wordsRead: 30000 } });
    touched.books.add("half-filled");
    expect(savedBook("half-filled")).toMatchObject({ wordsRead: 30000, lentTo: "Sam", shelfLocation: "bedside" });

    const logged = await write("POST", "/books/:id/read", {
      params: { id },
      body: { date: "2026-10-20", rating: 5, review: "A house of endless halls" },
    });
    expect(logged).toMatchObject({ status: "Completed", review: "A house of endless halls" });
    expect(savedBook(id)).toMatchObject({ review: "A house of endless halls", openLibraryKey: "/works/OL20893680W" });

    expect(idsOf(await read("GET", "/books"))[0]).toBe(id);
    expect(idsOf(await read("GET", "/books", { query: { status: "Completed" } })).sort()).toEqual(["dune", id].sort());

    const temp = await write("POST", "/books", { body: { title: "Scratch Book" } }, 201);
    expect(await write("DELETE", "/books/:id", { params: { id: temp.id as string } })).toEqual({ deleted: true, id: temp.id });
    touched.deletedBooks.add(temp.id as string);
  });

  it("audiobooks: add, list, read, update, log listened, delete — never mixed with books", async () => {
    const made = await write("POST", "/audiobooks", {
      body: { title: "Project Hail Mary", totalMinutes: 970, listenedMinutes: 60 },
    }, 201);
    const id = made.id as string;
    touched.books.add(id);
    expect(savedBook(id)).toMatchObject({ format: "audiobook", totalMinutes: 970, listenedMinutes: 60 });

    expect(idsOf(await read("GET", "/audiobooks"))).toEqual([id]);
    expect(idsOf(await read("GET", "/books"))).not.toContain(id);
    await refused("GET", "/books/:id", { params: { id } }, 404);

    expect(await read("GET", "/audiobooks/:id", { params: { id } })).toMatchObject({ title: "Project Hail Mary" });
    await write("PATCH", "/audiobooks/:id", { params: { id }, body: { listenedMinutes: 180 } });
    const logged = await write("POST", "/audiobooks/:id/read", { params: { id }, body: { date: "2026-10-21" } });
    expect(logged).toMatchObject({ status: "Completed" });
    expect(savedBook(id)).toMatchObject({ listenedMinutes: 970, dateFinished: "2026-10-21" });

    const temp = await write("POST", "/audiobooks", { body: { title: "Scratch Audio", totalMinutes: 10 } }, 201);
    expect(await write("DELETE", "/audiobooks/:id", { params: { id: temp.id as string } })).toEqual({
      deleted: true,
      id: temp.id,
    });
    touched.deletedBooks.add(temp.id as string);
  });

  it("search, lookup and items answer { items, total } across every kind", async () => {
    const search = expectPage(await read("GET", "/search", { query: { q: "pir" } }));
    expect(search.items.map((i) => [i.kind, i.title])).toEqual([["book", "Piranesi"]]);
    expect(search.total).toBe(1);

    const byGuid = expectPage(await read("GET", "/lookup", { query: { plexGuid: "tmdb://329865" } }));
    expect(byGuid).toMatchObject({ total: 1, items: [{ id: "arrival", kind: "film" }] });
    const byWork = expectPage(await read("GET", "/lookup", { query: { openLibrary: "OL20893680W" } }));
    expect(byWork.items.map((i) => i.title)).toEqual(["Piranesi"]);
    expect(await read("GET", "/lookup", { query: { tmdb: "1" } })).toEqual({ items: [], total: 0 });
    await refused("GET", "/lookup", { query: { plexGuid: "plex://movie/5d776" } }, 400);

    const october = expectPage(
      await read("GET", "/items", { query: { from: "2026-10-01", to: "2026-10-31", limit: "2" } }),
    );
    // Arrival, Dexter, Piranesi and Project Hail Mary; The Expanse is not finished.
    expect(october.total).toBe(4);
    // Newest first on dateFinished.
    expect(october.items.map((i) => i.id)).toEqual(["arrival", "dexter"]);
  });

  it("answers every refusal as { error } with the right status", async () => {
    await refused("GET", "/films", { query: { limit: "0" } }, 400);
    await refused("GET", "/films/:id", { params: { id: "nope" } }, 404);
    expectErrorBody((await raw("GET", "/nowhere")).body);
    expect((await raw("GET", "/nowhere")).status).toBe(404);
    const put = await raw("PUT", "/films", {});
    expect(put.status).toBe(405);
    expectErrorBody(put.body);
    const outOfRange = await raw("POST", "/shows/the-expanse/episodes", { season: 1, episode: 99 });
    expect(outOfRange.status).toBe(400);
    expectErrorBody(outOfRange.body);
  });

  it("keeps a write from another device out with 403 while remote writes are off", async () => {
    const listener = createRequestListener({ token: TOKEN, deps, allowRemoteWrites: () => false });
    const fromTailnet = (method: string, path: string, body = ""): Promise<{ status: number; body: Json; headers: Json }> =>
      new Promise((resolve) => {
        const req = Object.assign(new EventEmitter(), {
          method,
          url: `${API_BASE}${path}`,
          headers: { authorization: `Bearer ${TOKEN}`, "content-length": String(body.length) },
          socket: { remoteAddress: "100.94.212.24" },
          resume: () => req,
        });
        setImmediate(() => {
          if (body) req.emit("data", Buffer.from(body));
          req.emit("end");
        });
        let status = 0;
        let headers: Json = {};
        const res = {
          headersSent: false,
          writeHead(s: number, h: Json) {
            status = s;
            headers = h;
            res.headersSent = true;
          },
          end: (text: string) => resolve({ status, headers, body: JSON.parse(text) as Json }),
        };
        listener(req as never, res as never);
      });

    const savesBefore = saves.length;
    const revBefore = revision.current();
    for (const [method, path] of [
      ["POST", "/films"],
      ["PATCH", "/films/arrival"],
      ["DELETE", "/films/arrival"],
      ["POST", "/books/dune/read"],
    ] as const) {
      const r = await fromTailnet(method, path, JSON.stringify({ title: "From the phone" }));
      expect(r.status, `${method} ${path}`).toBe(403);
      expectErrorBody(r.body);
    }
    expect(saves.length).toBe(savesBefore);
    expect(revision.current()).toBe(revBefore);
    expect(store.getTitle("arrival")).toBeDefined();

    // Reads from the tailnet are served with the token alone.
    const health = await fromTailnet("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.headers["x-wrl-revision"]).toBe(String(revBefore));
  });

  it("documents exactly the routes it serves", () => {
    const documented = new Set(
      [...DOCS.matchAll(/^\| `(GET|POST|PATCH|DELETE|PUT|HEAD) (\/[^`]*)` \|/gm)].map((m) => `${m[1]} ${m[2]}`),
    );
    expect(documented.size).toBeGreaterThan(30);
    expect([...documented].filter((route) => !exercised.has(route))).toEqual([]);
    expect([...exercised].filter((route) => !documented.has(route))).toEqual([]);
  });

  it("loses no key: the last save differs from the loaded library only where the walk wrote", async () => {
    // Nothing the v3 fixture carried was dropped by loading it.
    const migrated = keyPaths(baseline);
    const inputPaths = [...keyPaths(original)];
    const unknownTopLevel = ["maybe", "reading.legacyImportedFrom", "titles[id=dexter].rewatchCount", "titles[id=dexter].legacyNotes.flags"];
    for (const path of unknownTopLevel) expect(migrated.has(path), path).toBe(true);
    expect(inputPaths.filter((p) => p.startsWith("reading.books") && !migrated.has(p))).toEqual([]);

    const diffs = differences(baseline, lastSave());
    // The comparison can see a change at all: the walk's own records show up.
    expect(diffs).toEqual(
      expect.arrayContaining([
        { path: "titles[id=arrival]", kind: "added" },
        { path: "titles[id=dexter].dateFinished", kind: "changed" },
        { path: "reading.books[id=half-filled].wordsRead", kind: "changed" },
      ]),
    );
    const intended = ({ path, kind }: { path: string; kind: string }): boolean => {
      const title = /^titles\[id=([^\]]+)\]/.exec(path)?.[1];
      if (title !== undefined) return touched.titles.has(title);
      const book = /^reading\.books\[id=([^\]]+)\]/.exec(path)?.[1];
      if (book !== undefined) return touched.books.has(book);
      // The activity log gains whole entries; an existing one never changes.
      return kind === "added" && /^history\[id=[^\]]+\]$/.test(path);
    };

    // Not a single key of the loaded library is gone, deleted records aside
    // (and they were created by the walk, so the baseline never held them).
    expect(diffs.filter((d) => d.kind === "lost")).toEqual([]);
    expect(diffs.filter((d) => !intended(d))).toEqual([]);

    // And the walk did reach the records it meant to.
    for (const id of touched.titles) expect(savedTitle(id), id).toBeDefined();
    for (const id of touched.books) expect(savedBook(id), id).toBeDefined();
    for (const id of touched.deletedTitles) expect(savedTitle(id), id).toBeUndefined();
    for (const id of touched.deletedBooks) expect(savedBook(id), id).toBeUndefined();
  });

  it("closes promptly with a keep-alive connection still open", async () => {
    // The agent holds its socket open between requests; close() must cut it.
    await read("GET", "/health");
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(raw("GET", "/health")).rejects.toThrow();
  });
});
