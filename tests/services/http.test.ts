/**
 * The real `requestUrl` wrapper, with a stubbed `obsidian` module.
 *
 * This is the only place the production transport is exercised; every client
 * test runs against `tests/mocks/http.ts`, which mirrors the rules pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl: requestUrlMock }));

import {
  ApiError,
  describeApiError,
  getJson,
  httpRequest,
  isApiError,
  joinUrl,
  queryString,
  reasonForStatus,
} from "../../src/services/http";

function respond(status: number, text: string, headers: Record<string, string> = {}) {
  return Promise.resolve({ status, text, headers, json: undefined, arrayBuffer: new ArrayBuffer(0) });
}

describe("httpRequest", () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  it("always passes throw:false so we handle statuses ourselves", async () => {
    requestUrlMock.mockReturnValue(respond(200, `{"ok":true}`));
    await httpRequest({ url: "http://x/y", source: "plex" });
    expect(requestUrlMock.mock.calls[0]?.[0]).toMatchObject({ throw: false });
  });

  it("parses the body from text, never from the throwing `json` getter", async () => {
    requestUrlMock.mockReturnValue(respond(200, `{"MediaContainer":{"size":0}}`));
    const response = await httpRequest<{ MediaContainer: { size: number } }>({
      url: "http://x/identity",
      source: "plex",
    });
    expect(response.json?.MediaContainer.size).toBe(0);
  });

  it("throws an ApiError with the mapped reason for a 401", async () => {
    requestUrlMock.mockReturnValue(respond(401, `{"message":"Unauthorized"}`));
    await expect(httpRequest({ url: "http://x/y", source: "overseerr" })).rejects.toMatchObject({
      name: "ApiError",
      reason: "auth",
      status: 401,
      providerMessage: "Unauthorized",
    });
  });

  it("returns allowed statuses instead of throwing — 202 and 409 are answers", async () => {
    requestUrlMock.mockReturnValue(respond(202, `{"message":"No seasons available to request"}`));
    const response = await httpRequest({
      url: "http://x/api/v1/request",
      source: "overseerr",
      allowStatuses: [202, 409],
    });
    expect(response.status).toBe(202);
  });

  it("turns a 2xx HTML body into a parse error — Plex answers HTML on odd paths", async () => {
    requestUrlMock.mockReturnValue(respond(200, "<html>nope</html>"));
    await expect(httpRequest({ url: "http://x/y", source: "plex" })).rejects.toMatchObject({
      reason: "parse",
    });
  });

  it("returns an allowed non-2xx even when its body is not JSON — Plex 404s send HTML", async () => {
    requestUrlMock.mockReturnValue(respond(404, "<html>Not Found</html>"));
    const response = await httpRequest({
      url: "http://plex/library/metadata/99999999",
      source: "plex",
      allowStatuses: [404],
    });
    expect(response.status).toBe(404);
    expect(response.json).toBeUndefined();
  });

  it("tolerates an empty body on 204", async () => {
    requestUrlMock.mockReturnValue(respond(204, ""));
    const response = await httpRequest({ url: "http://x/y", source: "overseerr" });
    expect(response.json).toBeUndefined();
  });

  it("times out rather than hanging forever", async () => {
    requestUrlMock.mockReturnValue(new Promise(() => {}));
    await expect(
      httpRequest({ url: "http://x/y", source: "plex", timeoutMs: 10 }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("maps a thrown transport error to `network`", async () => {
    requestUrlMock.mockReturnValue(Promise.reject(new Error("ECONNREFUSED")));
    await expect(httpRequest({ url: "http://x/y", source: "plex" })).rejects.toMatchObject({
      reason: "network",
      detail: "ECONNREFUSED",
    });
  });

  it("sends a JSON body with the right content type", async () => {
    requestUrlMock.mockReturnValue(respond(201, `{"id":1}`));
    await httpRequest({
      url: "http://x/api/v1/request",
      method: "POST",
      source: "overseerr",
      json: { mediaType: "movie", mediaId: 550 },
    });
    expect(requestUrlMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      body: `{"mediaType":"movie","mediaId":550}`,
      contentType: "application/json",
    });
  });

  it("getJson rejects an empty 200 rather than returning undefined", async () => {
    requestUrlMock.mockReturnValue(respond(200, ""));
    await expect(getJson("http://x/y", "tmdb")).rejects.toMatchObject({ reason: "parse" });
  });
});

describe("error taxonomy", () => {
  it("maps statuses onto reasons", () => {
    expect(reasonForStatus(401)).toBe("auth");
    expect(reasonForStatus(403)).toBe("auth");
    expect(reasonForStatus(404)).toBe("not-found");
    expect(reasonForStatus(429)).toBe("rate-limited");
    expect(reasonForStatus(500)).toBe("server");
    expect(reasonForStatus(418)).toBe("http");
  });

  it("says something human for every reason", () => {
    const reasons = [
      "no-key",
      "auth",
      "not-enabled",
      "rate-limited",
      "server",
      "not-found",
      "parse",
      "network",
      "timeout",
      "http",
    ] as const;
    for (const reason of reasons) {
      const message = describeApiError(new ApiError({ source: "plex", reason }));
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("undefined");
    }
  });

  it("isApiError narrows", () => {
    expect(isApiError(new ApiError({ source: "tmdb", reason: "auth" }))).toBe(true);
    expect(isApiError(new Error("nope"))).toBe(false);
  });
});

describe("url helpers", () => {
  it("joins around trailing and leading slashes", () => {
    expect(joinUrl("http://host:5055/", "/api/v1/status")).toBe("http://host:5055/api/v1/status");
    expect(joinUrl("http://host:5055", "api/v1/status")).toBe("http://host:5055/api/v1/status");
  });

  it("encodes params and skips undefined", () => {
    expect(queryString({ query: "Fire and Ash", page: 1, language: undefined })).toBe(
      "?query=Fire%20and%20Ash&page=1",
    );
    expect(queryString({})).toBe("");
  });
});
