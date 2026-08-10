/**
 * The only HTTP entry point in the plugin.
 *
 * Everything goes through Obsidian's `requestUrl`, never `fetch` — it runs in the
 * Electron main process, so it bypasses CORS and the mixed-content rule, which
 * is what makes a plain `http://192.168.1.10:32400` Plex call work at all.
 *
 * Three rules, from `docs/research/report-overseerr-tmdb.md` §0:
 *
 *   1. `throw` defaults to **true**. We always pass `throw: false` and handle
 *      status codes ourselves, because several of these APIs use non-obvious
 *      codes — Overseerr returns 202 for "nothing to request" and 409 for
 *      "already requested", both of which are answers, not failures.
 *   2. `response.json` is a **getter that throws** on a non-JSON body. Plex 404s
 *      return HTML. Always check `status` before touching `.json`.
 *   3. `RequestUrlParam` has no timeout field, so we race the request ourselves.
 */
import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { HTTP_TIMEOUT_MS } from "../constants";
import type {
  ApiErrorInit,
  ApiErrorReason,
  ApiSource,
  HttpRequestOptions,
  HttpResponse,
} from "../types";

/** Normalised failure from any provider. The UI has exactly one formatter for it. */
export class ApiError extends Error {
  readonly source: ApiSource;
  readonly reason: ApiErrorReason;
  readonly status?: number;
  readonly detail?: string;
  readonly providerMessage?: string;
  readonly url?: string;

  constructor(init: ApiErrorInit) {
    super(init.providerMessage || init.detail || `${init.source}: ${init.reason}`);
    this.name = "ApiError";
    this.source = init.source;
    this.reason = init.reason;
    if (init.status !== undefined) this.status = init.status;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.providerMessage !== undefined) this.providerMessage = init.providerMessage;
    if (init.url !== undefined) this.url = init.url;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** HTTP status → error reason. Provider clients may refine this afterwards. */
export function reasonForStatus(status: number): ApiErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  if (status >= 400) return "http";
  return "http";
}

/** Human sentences. One place, so every surface says the same thing. */
export function describeApiError(err: ApiError): string {
  const provider =
    err.source === "overseerr" ? "Overseerr" : err.source === "plex" ? "Plex" : "TMDB";
  switch (err.reason) {
    case "no-key":
      return `${provider} is not configured yet — add the URL and key in Settings → Integrations.`;
    case "auth":
      return `${provider} rejected the credentials. Check the API key in Settings → Integrations.`;
    case "not-enabled":
      return `${provider} is reachable but this feature is not enabled on the server.`;
    case "rate-limited":
      return `${provider} is rate-limiting us. Try again in a moment.`;
    case "not-found":
      return `${provider} has no record of that item.`;
    case "server":
      return `${provider} returned a server error${err.status ? ` (${err.status})` : ""}.`;
    case "parse":
      return `${provider} sent a response the plugin could not read.`;
    case "timeout":
      return `${provider} did not answer in time. Is the server reachable from this machine?`;
    case "network":
      return `Could not reach ${provider}. Check the URL and that the server is up.`;
    case "http":
    default:
      return err.providerMessage || `${provider} request failed${err.status ? ` (${err.status})` : ""}.`;
  }
}

/** Pull a usable message out of a provider's error body without trusting its shape. */
function extractProviderMessage(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim().length > 0 && body.length < 500) return body.trim();
  if (typeof body !== "object" || body === null) return undefined;
  const rec = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "status_message"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** `requestUrl` has no timeout, so race it. The request itself keeps running. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Perform a request and return the parsed body.
 *
 * Throws `ApiError` for anything outside 2xx, except statuses listed in
 * `allowStatuses`, which are returned to the caller to interpret.
 */
export async function httpRequest<T = unknown>(
  options: HttpRequestOptions,
): Promise<HttpResponse<T>> {
  const {
    url,
    method = "GET",
    headers = {},
    source,
    timeoutMs = HTTP_TIMEOUT_MS,
    allowStatuses = [],
    binary = false,
  } = options;

  const params: RequestUrlParam = {
    url,
    method,
    headers: { Accept: binary ? "image/*" : "application/json", ...headers },
    throw: false,
  };

  if (options.json !== undefined) {
    params.body = JSON.stringify(options.json);
    params.contentType = "application/json";
    params.headers = { ...params.headers, "Content-Type": "application/json" };
  } else if (options.body !== undefined) {
    params.body = options.body;
    if (options.contentType) params.contentType = options.contentType;
  }

  let response: RequestUrlResponse;
  try {
    response = await withTimeout(
      requestUrl(params),
      timeoutMs,
      () => new ApiError({ source, reason: "timeout", url, detail: `timed out after ${timeoutMs}ms` }),
    );
  } catch (err) {
    if (isApiError(err)) throw err;
    throw new ApiError({
      source,
      reason: "network",
      url,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Rule 2: read `status` and `text` before ever touching the `json` getter.
  const status = response.status;
  const text = typeof response.text === "string" ? response.text : "";

  let json: T | undefined;
  let parseFailed = false;
  // A binary fetch has no JSON to find and a body that is not text; trying to
  // parse it would throw the "unreadable 2xx" error below on every image.
  if (!binary && text.trim().length > 0) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      parseFailed = true;
    }
  }

  const ok = (status >= 200 && status < 300) || allowStatuses.includes(status);
  if (!ok) {
    throw new ApiError({
      source,
      reason: reasonForStatus(status),
      status,
      url,
      detail: text.slice(0, 300),
      ...(extractProviderMessage(json ?? text) !== undefined
        ? { providerMessage: extractProviderMessage(json ?? text) as string }
        : {}),
    });
  }

  // An unreadable body is only a failure on a *success* status. A caller that
  // opted into a non-2xx via `allowStatuses` is asking to interpret it, and
  // those bodies are routinely not JSON — a Plex 404 answers with HTML.
  if (parseFailed && status >= 200 && status < 300 && status !== 204) {
    // A 2xx with an unreadable body — Plex sometimes answers HTML on odd paths.
    throw new ApiError({
      source,
      reason: "parse",
      status,
      url,
      detail: text.slice(0, 300),
    });
  }

  return {
    status,
    headers: response.headers ?? {},
    text,
    json,
    ...(binary ? { bytes: response.arrayBuffer } : {}),
  };
}

/** Convenience wrapper for the common "GET some JSON" case. */
export async function getJson<T>(
  url: string,
  source: ApiSource,
  init: Omit<HttpRequestOptions, "url" | "source" | "method"> = {},
): Promise<T> {
  const response = await httpRequest<T>({ ...init, url, source, method: "GET" });
  if (response.json === undefined) {
    throw new ApiError({ source, reason: "parse", status: response.status, url, detail: "empty body" });
  }
  return response.json;
}

/**
 * The transport every service client talks to.
 *
 * `httpRequest` is the only production implementation; the indirection exists so
 * unit tests can hand a client a fixture router instead of a network stack. No
 * test in this repo may reach the real one — see `tests/mocks/http.ts`.
 */
export type HttpFn = <T = unknown>(options: HttpRequestOptions) => Promise<HttpResponse<T>>;

export const defaultHttp: HttpFn = httpRequest;

/** Join a user-entered base URL with a path, tolerating trailing slashes. */
export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.startsWith("/") ? path : `/${path}`;
  return `${left}${right}`;
}

/** `?a=1&b=two`, skipping undefined values. Empty when nothing is set. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
