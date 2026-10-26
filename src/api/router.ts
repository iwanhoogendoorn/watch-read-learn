/**
 * Routing for the local API, below the HTTP layer.
 *
 * `server.ts` owns the socket, auth, body parsing and the remote-write guard;
 * by the time a request gets here it is an `ApiRequest` whose `path` is
 * relative to `API_BASE` (`/health`, `/films/abc`). This file serves
 * `GET /health` itself and offers everything else to the route modules in
 * order. The first handler that returns a response wins; a handler returns
 * `undefined` for a path that is not its own.
 *
 * The route modules
 * -----------------
 * `ROUTE_MODULES` is `[titleRoutes, searchRoutes, readingRoutes]`: `/films`
 * and `/shows`, then `/search`, `/lookup` and `/items`, then `/books` and
 * `/audiobooks`. Their paths do not overlap, so the order only decides who is
 * asked first. `server.ts` and `main.ts` call `handle()` without a route
 * list, so they pick the registry up as it is.
 *
 * Conventions every route module follows:
 * - throw `ApiError(status, message)` for an expected failure; it is sent as
 *   `{"error": message}` with that status. Anything else thrown is a 500.
 * - a known path with an unsupported method throws `ApiError(405, …)`.
 * - writes are already past the remote-write guard; they must still
 *   `await deps.store.flush()` before returning a 2xx.
 */
import { isSingleSitting } from "../data/review";
import { readExtra } from "../types";
import { readingRoutes } from "./routes/reading";
import { searchRoutes } from "./routes/search";
import { titleRoutes } from "./routes/titles";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse, type RouteHandler } from "./types";

/** Every API path lives under this prefix. */
export const API_BASE = "/wrl/v1";

/** The route modules, in the order they are offered a request. */
export const ROUTE_MODULES: readonly RouteHandler[] = [titleRoutes, searchRoutes, readingRoutes];

/** `Book.format` (an extra key) marks an audiobook; a book without it is a printed or e-book. */
export const AUDIOBOOK_FORMAT = "audiobook";

export interface HealthBody {
  ok: true;
  version: string;
  /** False while the store has not finished loading; nothing else should be trusted until it is true. */
  ready: boolean;
  revision: number;
  counts: { films: number; shows: number; books: number; audiobooks: number };
}

export function healthBody(deps: ApiDeps): HealthBody {
  let films = 0;
  let shows = 0;
  let books = 0;
  let audiobooks = 0;
  let ready = true;
  try {
    for (const title of deps.store.allTitles()) {
      // Anime, documentaries and everything else that is not one sitting is a show.
      if (isSingleSitting(title)) films += 1;
      else shows += 1;
    }
    for (const book of deps.reading.allBooks()) {
      if (readExtra<unknown>(book, "format") === AUDIOBOOK_FORMAT) audiobooks += 1;
      else books += 1;
    }
  } catch {
    // A store that cannot be read yet (mid-load, or gated on a failed backup)
    // is "not ready", not a server error: health is what a client polls to
    // find that out.
    ready = false;
    films = shows = books = audiobooks = 0;
  }
  return {
    ok: true,
    version: deps.version,
    ready,
    revision: deps.revision(),
    counts: { films, shows, books, audiobooks },
  };
}

const READ_METHODS = new Set(["GET", "HEAD"]);

function error(status: number, message: string): ApiResponse {
  return { status, body: { error: message } };
}

/**
 * Route one request. Always answers: an unknown path is a 404 and an
 * `ApiError` becomes its status. Any other exception propagates to the caller
 * (the server turns it into a 500).
 */
export async function handle(
  req: ApiRequest,
  deps: ApiDeps,
  routes: readonly RouteHandler[] = ROUTE_MODULES,
): Promise<ApiResponse> {
  const method = req.method.toUpperCase();
  try {
    if (req.path === "/health") {
      if (!READ_METHODS.has(method)) return error(405, `${method} is not allowed on /health`);
      return { status: 200, body: healthBody(deps) };
    }
    for (const route of routes) {
      const res = await route(req, deps);
      if (res !== undefined) return res;
    }
    return error(404, `No route for ${method} ${API_BASE}${req.path}`);
  } catch (e) {
    if (e instanceof ApiError) return error(e.status, e.message);
    throw e;
  }
}
