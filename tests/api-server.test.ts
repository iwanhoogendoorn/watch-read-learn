/**
 * The local API's HTTP plumbing (`src/api/server.ts`, `router.ts`,
 * `revision.ts`, `auth.ts`), against a real server on 127.0.0.1 and an
 * OS-assigned port. No network beyond loopback.
 *
 * A socket opened from this test is always loopback, so the rules that only
 * apply to other devices (the bare 404, the remote-write 403) are driven
 * through `createRequestListener` with a fake peer address, and through
 * `dispatch` at handler level.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sameToken, randomToken } from "../src/api/auth";
import { createApiRevision, type ApiRevision } from "../src/api/revision";
import { API_BASE, ROUTE_MODULES } from "../src/api/router";
import {
  MAX_BODY,
  createRequestListener,
  dispatch,
  startApiServer,
  type ApiServer,
} from "../src/api/server";
import { ApiError, type ApiDeps, type ApiRequest, type RouteHandler } from "../src/api/types";
import type { ReadingStore } from "../src/domains/reading/store";
import { createTitle } from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import { DATA_CHANGED_EVENT } from "../src/types";

const TOKEN = "a".repeat(48);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let doc: EventTarget;
let revision: ApiRevision;
let store: WatchLogStore;
let server: ApiServer | null = null;

beforeEach(() => {
  // The store dispatches its change event on `document`; a bare EventTarget is
  // all of a document it needs.
  doc = new EventTarget();
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  revision = createApiRevision(doc);
  store = new WatchLogStore({ loadData: async () => null, saveData: async () => undefined } as never);
  store.data.titles.push(
    createTitle({ id: "m1", title: "Heat", type: "Movie", tmdbMediaType: "movie" }),
    createTitle({ id: "m2", title: "Alien", type: "Movie", tmdbMediaType: "movie" }),
    createTitle({ id: "s1", title: "The Wire", type: "TV Show", tmdbMediaType: "tv", totalEpisodes: 60 }),
  );
});

afterEach(async () => {
  await server?.close();
  server = null;
  revision.dispose();
  Reflect.deleteProperty(globalThis, "document");
});

function deps(): ApiDeps {
  const books = [
    { id: "b1", title: "Dune" },
    { id: "b2", title: "Neuromancer", format: "epub" },
    { id: "b3", title: "Project Hail Mary", format: "audiobook" },
  ];
  return {
    store,
    reading: { allBooks: () => books } as unknown as ReadingStore,
    version: "9.9.9",
    revision: () => revision.current(),
    now: () => new Date(2026, 9, 26),
  };
}

async function start(
  extra: { allowRemoteWrites?: () => boolean; routes?: RouteHandler[]; log?: (m: string) => void; token?: string } = {},
): Promise<ApiServer> {
  server = await startApiServer({
    hosts: ["127.0.0.1"],
    port: 0,
    token: extra.token ?? TOKEN,
    deps: deps(),
    allowRemoteWrites: extra.allowRemoteWrites ?? (() => false),
    routes: extra.routes,
    log: extra.log,
  });
  return server;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
}

function call(
  port: number,
  opts: {
    method?: string;
    path?: string;
    token?: string | null;
    body?: string;
    /** Send the body chunked, with no content-length to check up front. */
    chunked?: boolean;
    agent?: http.Agent;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      if (!opts.chunked) headers["content-length"] = String(Buffer.byteLength(opts.body));
    }
    let answered = false;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? `${API_BASE}/health`,
        headers,
        agent: opts.agent,
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = text === "" ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    // A server that answers 413 and closes may reset the socket while the
    // client is still writing; once the answer is in, that is expected.
    req.on("error", (e) => {
      if (!answered) reject(e);
    });
    if (opts.body !== undefined && opts.chunked) {
      // Several writes, so the server sees the size grow past the cap.
      for (let i = 0; i < opts.body.length; i += 256_000) req.write(opts.body.slice(i, i + 256_000));
    } else if (opts.body !== undefined) {
      req.write(opts.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("auth", () => {
  it("answers 401 with no token, and says nothing about the revision", async () => {
    const { port } = await start();
    const r = await call(port, { token: null });
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.headers["x-wrl-revision"]).toBeUndefined();
    expect(r.json).toEqual({ error: expect.stringContaining("Bearer") });
  });

  it("answers 401 to a wrong token, including one of a different length", async () => {
    const { port } = await start();
    expect((await call(port, { token: "b".repeat(48) })).status).toBe(401);
    expect((await call(port, { token: "short" })).status).toBe(401);
    expect((await call(port, { token: "" })).status).toBe(401);
  });

  it("answers 401 to everyone while the configured token is empty", async () => {
    const { port } = await start({ token: "" });
    expect((await call(port, { token: "" })).status).toBe(401);
    expect((await call(port, { token: null })).status).toBe(401);
  });

  it("sameToken is exact and never matches an empty secret; randomToken is 48 hex chars", () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(sameToken("", "")).toBe(false);
    const a = randomToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(randomToken()).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Health, headers, revision
// ---------------------------------------------------------------------------

describe("GET /wrl/v1/health", () => {
  it("answers 200 JSON with counts and the hardening headers", async () => {
    const { port } = await start();
    const r = await call(port);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-wrl-revision"]).toBe("0");
    expect(r.json).toEqual({
      ok: true,
      version: "9.9.9",
      ready: true,
      revision: 0,
      counts: { films: 2, shows: 1, books: 2, audiobooks: 1 },
    });
  });

  it("answers HEAD with the headers and no body", async () => {
    const { port } = await start();
    const r = await call(port, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers["x-wrl-revision"]).toBe("0");
    expect(r.text).toBe("");
  });

  it("bumps x-wrl-revision on store.emitChanged() and on a raw DATA_CHANGED_EVENT", async () => {
    const { port } = await start();
    expect((await call(port)).headers["x-wrl-revision"]).toBe("0");

    store.emitChanged({ reason: "test" });
    const one = await call(port);
    expect(one.headers["x-wrl-revision"]).toBe("1");
    expect((one.json as { revision: number }).revision).toBe(1);

    // An external data.json reload arrives on the same bus.
    doc.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { reason: "external-change" } }));
    expect((await call(port)).headers["x-wrl-revision"]).toBe("2");
  });

  it("revision.dispose() stops counting", () => {
    const r = createApiRevision(doc);
    doc.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    expect(r.current()).toBe(1);
    r.dispose();
    doc.dispatchEvent(new Event(DATA_CHANGED_EVENT));
    expect(r.current()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Routing errors
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("answers JSON 404 for an unknown path under the base, with the revision header", async () => {
    const { port } = await start();
    const r = await call(port, { path: `${API_BASE}/nope` });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: expect.stringContaining("/wrl/v1/nope") });
    expect(r.headers["x-wrl-revision"]).toBe("0");
  });

  it("answers 405 to a wrong method on a known path", async () => {
    const { port } = await start();
    const r = await call(port, { method: "DELETE" });
    expect(r.status).toBe(405);
    expect(r.json).toEqual({ error: expect.any(String) });
  });

  it("answers 404 outside /wrl/v1 before checking the token, and does not mistake /wrl/v1x for the base", async () => {
    const { port } = await start();
    const outside = await call(port, { path: "/", token: null });
    expect(outside.status).toBe(404);
    expect(outside.headers["x-wrl-revision"]).toBeUndefined();
    expect((await call(port, { path: "/wrl/v1x/health" })).status).toBe(404);
  });

  it("maps ApiError to its status, other throws to a 500 that names the error and never logs the token", async () => {
    const logs: string[] = [];
    const routes: RouteHandler[] = [
      (req) => {
        if (req.path === "/teapot") throw new ApiError(418, "short and stout");
        if (req.path === "/boom") throw new Error("kaboom");
        if (req.path === "/echo") return { status: 200, body: { body: req.body, query: req.query } };
        return undefined;
      },
    ];
    const { port } = await start({ routes, log: (m) => logs.push(m) });
    const teapot = await call(port, { path: `${API_BASE}/teapot` });
    expect(teapot.status).toBe(418);
    expect(teapot.json).toEqual({ error: "short and stout" });
    const boom = await call(port, { path: `${API_BASE}/boom` });
    expect(boom.status).toBe(500);
    expect(boom.json).toEqual({ error: "kaboom" });
    expect(logs.some((l) => l.includes("kaboom"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);

    const echo = await call(port, { method: "POST", path: `${API_BASE}/echo?x=1`, body: '{"a":[1,2]}' });
    expect(echo.status).toBe(200);
    expect(echo.json).toEqual({ body: { a: [1, 2] }, query: { x: "1" } });
  });

  it("starts with an empty route registry until T5 wires the modules in", () => {
    expect(ROUTE_MODULES).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

describe("request bodies", () => {
  it("answers 413 to a body over 1 MB", async () => {
    const { port } = await start();
    const r = await call(port, { method: "POST", path: `${API_BASE}/anything`, body: "x".repeat(MAX_BODY + 1) });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: expect.stringContaining("larger") });
  });

  it("answers 413 to a chunked body that grows past 1 MB, and the connection stays usable", async () => {
    const { port } = await start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const r = await call(port, {
        method: "POST",
        path: `${API_BASE}/anything`,
        body: "x".repeat(MAX_BODY + 1),
        chunked: true,
        agent,
      });
      expect(r.status).toBe(413);
      expect((await call(port, { agent })).status).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  it("accepts a body of exactly 1 MB", async () => {
    const { port } = await start({ routes: [(req) => (req.path === "/big" ? { status: 200, body: { n: (req.body as string).length } } : undefined)] });
    const payload = JSON.stringify("y".repeat(MAX_BODY - 2));
    const r = await call(port, { method: "POST", path: `${API_BASE}/big`, body: payload });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ n: MAX_BODY - 2 });
  });

  it("answers 400 to malformed JSON", async () => {
    const { port } = await start();
    const r = await call(port, { method: "POST", path: `${API_BASE}/anything`, body: "{not json" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "Body must be valid JSON" });
  });
});

// ---------------------------------------------------------------------------
// Remote-write guard
// ---------------------------------------------------------------------------

describe("remote-write guard", () => {
  const created: RouteHandler = (req) =>
    req.path === "/things" && req.method === "POST" ? { status: 201, body: { ok: true } } : undefined;
  const post = (remote: boolean): ApiRequest => ({ method: "POST", path: "/things", query: {}, body: {}, remote });

  it("handler level: a remote POST is 403 while writes are off, and not once they are on", async () => {
    let allow = false;
    const opts = { allowRemoteWrites: () => allow, routes: [created] };
    const refused = await dispatch(post(true), deps(), opts);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: expect.stringContaining("Allow writes from other devices") });

    // Read live: no restart between the two.
    allow = true;
    expect((await dispatch(post(true), deps(), opts)).status).toBe(201);
  });

  it("handler level: a loopback POST is never 403, and a remote GET always passes", async () => {
    const opts = { allowRemoteWrites: () => false, routes: [created] };
    expect((await dispatch(post(false), deps(), opts)).status).toBe(201);
    const get: ApiRequest = { method: "GET", path: "/health", query: {}, body: undefined, remote: true };
    expect((await dispatch(get, deps(), opts)).status).toBe(200);
    const head: ApiRequest = { ...get, method: "HEAD" };
    expect((await dispatch(head, deps(), opts)).status).toBe(200);
  });

  it("over the socket: a POST from this machine is never 403 with writes off", async () => {
    const { port } = await start({ routes: [created] });
    const r = await call(port, { method: "POST", path: `${API_BASE}/things`, body: "{}" });
    expect(r.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The listener, as another device sees it
// ---------------------------------------------------------------------------

/** A request from `peer`, shaped like the parts of IncomingMessage the listener reads. */
function fakeRequest(peer: string | undefined, method: string, url: string, token: string | null, body = "") {
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    socket: { remoteAddress: peer },
    resume() {
      return req;
    },
  });
  // Emitted after the listener has attached its handlers.
  setImmediate(() => {
    if (body !== "") req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeResponse(): { res: object; done: Promise<{ status: number; headers: Record<string, string>; body: string }> } {
  let resolve!: (v: { status: number; headers: Record<string, string>; body: string }) => void;
  const done = new Promise<{ status: number; headers: Record<string, string>; body: string }>((r) => (resolve = r));
  let status = 0;
  let headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(s: number, h: Record<string, string>) {
      status = s;
      headers = h;
      res.headersSent = true;
    },
    end(text: string) {
      resolve({ status, headers, body: text });
    },
  };
  return { res, done };
}

async function fromPeer(
  peer: string | undefined,
  method: string,
  url: string,
  token: string | null = TOKEN,
  allowRemoteWrites = false,
) {
  const listener = createRequestListener({
    token: TOKEN,
    deps: deps(),
    allowRemoteWrites: () => allowRemoteWrites,
    routes: [(req) => (req.path === "/things" ? { status: 201, body: { ok: true } } : undefined)],
  });
  const { res, done } = fakeResponse();
  listener(fakeRequest(peer, method, url, token) as never, res as never);
  return done;
}

describe("requests from another device", () => {
  it("gets a bare 404 outside the base, without auth and without naming the service", async () => {
    const r = await fromPeer("100.67.202.68", "GET", "/", null);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: "Not found" });
    expect(r.headers["x-wrl-revision"]).toBeUndefined();
  });

  it("this machine gets a helpful 404 outside the base instead", async () => {
    const r = await fromPeer("127.0.0.1", "GET", "/", null);
    expect(JSON.parse(r.body)).toEqual({ error: expect.stringContaining(API_BASE) });
  });

  it("a remote POST is 403 with writes off and passes with them on; a remote GET is served", async () => {
    expect((await fromPeer("100.67.202.68", "POST", `${API_BASE}/things`)).status).toBe(403);
    expect((await fromPeer("100.67.202.68", "POST", `${API_BASE}/things`, TOKEN, true)).status).toBe(201);
    expect((await fromPeer("::ffff:192.168.1.20", "GET", `${API_BASE}/health`)).status).toBe(200);
  });

  it("an unknown peer address is treated as remote (fail closed)", async () => {
    expect((await fromPeer(undefined, "POST", `${API_BASE}/things`)).status).toBe(403);
    expect((await fromPeer("::1", "POST", `${API_BASE}/things`)).status).toBe(201);
    expect((await fromPeer("::ffff:127.0.0.1", "POST", `${API_BASE}/things`)).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  it("close() resolves while a keep-alive connection is still open", async () => {
    const s = await start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect((await call(s.port, { agent })).status).toBe(200);
      // The socket is now idle in the agent's pool, still connected.
      const closed = s.close().then(() => "closed");
      const timeout = new Promise((r) => setTimeout(() => r("timed out"), 2000));
      expect(await Promise.race([closed, timeout])).toBe("closed");
      server = null;
    } finally {
      agent.destroy();
    }
  });

  it("a partial start closes the listeners it already opened, and close() is idempotent", async () => {
    // The second listener asks for the port the first one just took.
    await expect(
      startApiServer({
        hosts: ["127.0.0.1", "127.0.0.1"],
        port: 0,
        token: TOKEN,
        deps: deps(),
        allowRemoteWrites: () => false,
      }),
    ).rejects.toThrow(/EADDRINUSE/);

    // Nothing is left holding a port: a fresh server can start and close twice.
    const s = await start();
    await s.close();
    await s.close();
    server = null;
    await expect(call(s.port)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("the port the failed start had taken is free again", async () => {
    const probe = await start();
    const port = probe.port;
    await probe.close();
    server = null;
    await expect(
      startApiServer({
        hosts: ["127.0.0.1", "127.0.0.1"],
        port,
        token: TOKEN,
        deps: deps(),
        allowRemoteWrites: () => false,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
    server = await startApiServer({
      hosts: ["127.0.0.1"],
      port,
      token: TOKEN,
      deps: deps(),
      allowRemoteWrites: () => false,
    });
    expect((await call(port)).status).toBe(200);
  });
});
