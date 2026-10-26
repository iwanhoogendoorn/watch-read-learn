/**
 * A small HTTP server so other tools can read and drive Watch, Read and Learn.
 *
 * Off unless switched on in Settings → Local API, desktop only, and every
 * request needs the bearer token from Settings. By default it listens on
 * 127.0.0.1 plus this Mac's Tailscale address; callers that are not on this
 * machine are read-only unless the user allows remote writes. Address rules
 * live in `addresses.ts`, routing in `router.ts`; this file is only plumbing.
 * Modelled on Food Spot's `src/api/server.ts`.
 *
 * `http` and `os` are required at run time, never imported: the bundle must
 * still load on Obsidian mobile, which never reaches these calls. The bare
 * names, not `node:http`, because those are what `esbuild.config.mjs` marks
 * external (its `builtin-modules` list has no `node:` spellings); a `node:`
 * specifier would make esbuild try to bundle the module and fail.
 */
import { bindPlan, isLoopbackAddress, type ApiHostMode, type BindPlan, type InterfaceMap } from "./addresses";
import { sameToken } from "./auth";
import { API_BASE, handle } from "./router";
import type { ApiDeps, ApiRequest, ApiResponse, RouteHandler } from "./types";

/** A list or a single title is a few kilobytes; anything near this is a mistake or an attack. */
export const MAX_BODY = 1_000_000;

export interface ApiServer {
  /** Resolves once every listener is closed. Open keep-alive sockets are cut, not waited for. */
  close(): Promise<void>;
  /** The port actually bound (differs from the requested one only when that was 0). */
  port: number;
  hosts: string[];
}

export interface DispatchOptions {
  /**
   * Read on every request rather than captured at start, so flipping the
   * setting takes effect on the next request without a restart.
   */
  allowRemoteWrites: () => boolean;
  /** Defaults to the router's registry; tests pass their own. */
  routes?: readonly RouteHandler[];
}

export interface StartApiServerOptions extends DispatchOptions {
  hosts: string[];
  port: number;
  token: string;
  deps: ApiDeps;
  /** Never handed the token or a request's headers. */
  log?: (message: string) => void;
}

function interfaces(): InterfaceMap {
  const os = require("os") as typeof import("node:os");
  return os.networkInterfaces() as InterfaceMap;
}

/** Hosts to bind for a "Listen on" choice, against this machine's interfaces right now. */
export function bindPlanFor(mode: ApiHostMode): BindPlan {
  return bindPlan(mode, interfaces());
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/** A peer that is not on this machine may only read, unless the user has allowed writes. */
export function isWriteForbidden(method: string, remote: boolean, allowRemoteWrites: boolean): boolean {
  return remote && !allowRemoteWrites && !READ_METHODS.has(method.toUpperCase());
}

const REMOTE_WRITE_MESSAGE =
  "Writes from other devices are turned off. Enable \"Allow writes from other devices\" in Watch, Read and Learn → Settings → Local API.";

/**
 * Everything after authentication and body parsing: the remote-write guard,
 * then the router. Exported so the guard can be tested without a socket.
 */
export async function dispatch(req: ApiRequest, deps: ApiDeps, opts: DispatchOptions): Promise<ApiResponse> {
  if (isWriteForbidden(req.method, req.remote, opts.allowRemoteWrites())) {
    return { status: 403, body: { error: REMOTE_WRITE_MESSAGE } };
  }
  return handle(req, deps, opts.routes);
}

/** `/wrl/v1` and `/wrl/v1/…`, but not `/wrl/v1x`. */
function underBase(pathname: string): boolean {
  return pathname === API_BASE || pathname.startsWith(`${API_BASE}/`);
}

function bearer(header: string | string[] | undefined): string {
  if (typeof header !== "string") return "";
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
}

type IncomingMessage = import("node:http").IncomingMessage;
type ServerResponse = import("node:http").ServerResponse;

/**
 * The `request` listener every bound server shares. Exported so a test can
 * hand it a request from a peer that is not on this machine, which a socket
 * opened from the test itself can never be.
 */
export function createRequestListener(
  opts: Omit<StartApiServerOptions, "hosts" | "port">,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let sent = false;
    /**
     * `authed` adds the revision header: an unauthenticated caller learns
     * nothing about the library, not even that it changed.
     */
    const send = (status: number, body: unknown, authed: boolean, extra: Record<string, string> = {}): void => {
      if (sent || res.headersSent) return;
      sent = true;
      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...extra,
      };
      if (authed) headers["x-wrl-revision"] = String(opts.deps.revision());
      res.writeHead(status, headers);
      res.end(JSON.stringify(body ?? null));
    };

    const method = (req.method ?? "GET").toUpperCase();
    // Not this machine: read-only unless allowed, and told nothing about what
    // is listening until it authenticates.
    const remote = !isLoopbackAddress(req.socket.remoteAddress);
    let pathname = "";
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      pathname = url.pathname;
      if (!underBase(url.pathname)) {
        send(404, { error: remote ? "Not found" : `Watch, Read and Learn serves ${API_BASE}` }, false);
        req.resume();
        return;
      }
      if (!sameToken(bearer(req.headers["authorization"]), opts.token)) {
        send(401, { error: "Send the Watch, Read and Learn API token as: Authorization: Bearer <token>" }, false);
        req.resume();
        return;
      }
      // Before the body is read: a refused write should not cost a megabyte.
      if (isWriteForbidden(method, remote, opts.allowRemoteWrites())) {
        send(403, { error: REMOTE_WRITE_MESSAGE }, true);
        req.resume();
        return;
      }
      const tooLarge = (extra: Record<string, string> = {}): void =>
        send(413, { error: `Body larger than ${MAX_BODY} bytes` }, true, extra);
      const declared = Number(req.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY * 16) {
        // Not worth reading even to throw away: answer and hang up.
        tooLarge({ connection: "close" });
        req.resume();
        return;
      }

      // An oversized body is read to the end and discarded before the 413 goes
      // out. Answering mid-upload races the client's remaining writes against
      // the connection closing, and the client sees EPIPE instead of the
      // answer. The server's request timeout bounds the drain.
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = Number.isFinite(declared) && declared > MAX_BODY;
      req.on("data", (chunk: Buffer) => {
        if (overflow) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          overflow = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (overflow) {
          tooLarge();
          return;
        }
        void (async () => {
          let body: unknown;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw.trim() !== "") {
            try {
              body = JSON.parse(raw);
            } catch {
              send(400, { error: "Body must be valid JSON" }, true);
              return;
            }
          }
          let path: string;
          try {
            path = decodeURIComponent(url.pathname.slice(API_BASE.length)) || "/";
          } catch {
            send(400, { error: "Malformed percent-encoding in the path" }, true);
            return;
          }
          const query: Record<string, string> = {};
          url.searchParams.forEach((value, key) => {
            query[key] = value;
          });
          try {
            const r = await dispatch({ method, path, query, body, remote }, opts.deps, opts);
            send(r.status, r.body, true);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // Method and path only: the token is in a header and never logged.
            opts.log?.(`${method} ${url.pathname} failed: ${message}`);
            send(500, { error: message }, true);
          }
        })();
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      opts.log?.(`${method} ${pathname || "(unparsed)"} failed: ${message}`);
      send(500, { error: message }, false);
    }
  };
}

export async function startApiServer(opts: StartApiServerOptions): Promise<ApiServer> {
  const http = require("http") as typeof import("node:http");
  type NodeServer = import("node:http").Server;

  const onRequest = createRequestListener(opts);
  const servers: NodeServer[] = [];
  let closing: Promise<void> | null = null;
  const closeAll = (): Promise<void> =>
    (closing ??= Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            // Keep-alive sockets would otherwise hold close() open indefinitely.
            server.closeAllConnections();
          }),
      ),
    ).then(() => undefined));

  // Port 0 asks the OS for a free port; every further host reuses the one it
  // picked, so all listeners share a port the way they do for a fixed one.
  let port = opts.port;
  try {
    for (const host of opts.hosts) {
      const server = http.createServer(onRequest);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      servers.push(server);
      const address = server.address();
      if (port === 0 && address !== null && typeof address === "object") port = address.port;
    }
  } catch (e) {
    // One address failing (port taken, Tailscale address gone) must not leave
    // the others listening with nothing holding a handle to them.
    await closeAll();
    throw e;
  }
  for (const host of opts.hosts) opts.log?.(`listening on http://${host}:${port}${API_BASE}`);
  return { close: closeAll, port, hosts: [...opts.hosts] };
}
