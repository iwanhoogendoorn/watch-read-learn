/**
 * Fixture router standing in for `services/http.ts`'s transport.
 *
 * **No test in this repo may touch the network.** Clients take an `http`
 * dependency precisely so it can be replaced here, and an unmatched URL throws
 * loudly rather than falling through to anything real.
 *
 * The status handling mirrors `httpRequest` exactly — 2xx and `allowStatuses`
 * return, everything else throws an `ApiError` with the same reason mapping — so
 * a client that behaves here behaves in Obsidian. `tests/services/http.test.ts`
 * pins the real implementation against the same rules.
 */
import { ApiError, reasonForStatus } from "../../src/services/http";
import type { HttpFn } from "../../src/services/http";
import type { HttpRequestOptions } from "../../src/types";

export interface FakeResponse {
  status?: number;
  /** Serialised as JSON. Use `text` for a non-JSON body (Plex 404s send HTML). */
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type FakeRoute = FakeResponse | ((request: HttpRequestOptions) => FakeResponse);

export interface FakeHttp {
  http: HttpFn;
  /** Every request in call order, for asserting on method, body and headers. */
  calls: HttpRequestOptions[];
  urls: string[];
}

/**
 * Routes are matched by substring, longest key first, so
 * `"/request/count"` wins over `"/request"` regardless of declaration order.
 */
export function createFakeHttp(routes: Record<string, FakeRoute>): FakeHttp {
  const calls: HttpRequestOptions[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length || a.localeCompare(b));

  const http: HttpFn = async <T>(options: HttpRequestOptions) => {
    calls.push(options);

    const key = keys.find((k) => options.url.includes(k));
    if (key === undefined) {
      throw new Error(`No fixture route for ${options.method ?? "GET"} ${options.url}`);
    }

    const route = routes[key] as FakeRoute;
    const result = typeof route === "function" ? route(options) : route;
    const status = result.status ?? 200;
    const text = result.text ?? (result.body === undefined ? "" : JSON.stringify(result.body));

    let json: T | undefined;
    let parseFailed = false;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text) as T;
      } catch {
        parseFailed = true;
      }
    }

    const allowed = options.allowStatuses ?? [];
    const ok = (status >= 200 && status < 300) || allowed.includes(status);
    if (!ok) {
      const providerMessage =
        json && typeof json === "object" && json !== null && typeof (json as Record<string, unknown>)["message"] === "string"
          ? ((json as Record<string, unknown>)["message"] as string)
          : undefined;
      throw new ApiError({
        source: options.source,
        reason: reasonForStatus(status),
        status,
        url: options.url,
        ...(providerMessage !== undefined ? { providerMessage } : {}),
      });
    }

    if (parseFailed && status >= 200 && status < 300 && status !== 204) {
      throw new ApiError({
        source: options.source,
        reason: "parse",
        status,
        url: options.url,
        detail: text.slice(0, 300),
      });
    }

    return { status, headers: result.headers ?? {}, text, json };
  };

  return {
    http,
    calls,
    get urls() {
      return calls.map((c) => c.url);
    },
  };
}

/** A clock the tests drive by hand — `sleep` resolves instantly but is recorded. */
export function createTestClock(start = 0) {
  let current = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => current,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        current += ms;
        await Promise.resolve();
      },
    },
    advance(ms: number) {
      current += ms;
    },
  };
}
