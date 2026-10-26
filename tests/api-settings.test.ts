/**
 * Local API settings: defaults, and normalisation of a `data.json` written
 * before the API existed (`src/data/schema.ts`, `src/data/migrate.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/data/migrate";
import { createDefaultSettings, DEFAULT_API_PORT } from "../src/data/schema";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/data-v3.json", import.meta.url));
const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

const API_DEFAULTS = {
  apiEnabled: false,
  apiPort: 27129,
  apiToken: "",
  apiHost: "tailscale",
  apiAllowRemoteWrites: false,
} as const;
const API_KEYS = Object.keys(API_DEFAULTS);

/** A data.json in the current schema, as 1.33.0 wrote it: everything but the API keys. */
function currentFileWithoutApiKeys(): Record<string, unknown> {
  const data = clone(migrate(fixture()).data) as unknown as Record<string, unknown>;
  const settings = data.settings as Record<string, unknown>;
  for (const key of API_KEYS) delete settings[key];
  // Keys this version knows nothing about must ride along untouched.
  settings.someFutureSetting = { nested: [1, "two"] };
  data.someFutureTopLevelKey = "kept";
  return data;
}

describe("API settings defaults", () => {
  it("a fresh install is off, on 27129, Tailscale, read-only from other devices, with no token", () => {
    const settings = createDefaultSettings();
    expect(DEFAULT_API_PORT).toBe(27129);
    expect({
      apiEnabled: settings.apiEnabled,
      apiPort: settings.apiPort,
      apiToken: settings.apiToken,
      apiHost: settings.apiHost,
      apiAllowRemoteWrites: settings.apiAllowRemoteWrites,
    }).toEqual(API_DEFAULTS);
  });
});

describe("loading a data.json without API keys", () => {
  it("adds exactly the API defaults and leaves every other key deep-equal", () => {
    const before = currentFileWithoutApiKeys();
    const { data } = migrate(clone(before));
    expect(data).toEqual({
      ...before,
      settings: { ...(before.settings as object), ...API_DEFAULTS },
    });
  });

  it("an old v3 file gets the defaults and keeps every settings key it had", () => {
    const raw = fixture();
    const oldSettingKeys = Object.keys(raw.settings as object);
    const { data } = migrate(raw);
    for (const key of API_KEYS) expect(data.settings).toHaveProperty(key, API_DEFAULTS[key as keyof typeof API_DEFAULTS]);
    for (const key of oldSettingKeys) expect(data.settings, key).toHaveProperty(key);
  });

  it("keeps API values the user chose", () => {
    const raw = currentFileWithoutApiKeys();
    Object.assign(raw.settings as object, {
      apiEnabled: true,
      apiPort: 30123,
      apiToken: "f".repeat(48),
      apiHost: "all",
      apiAllowRemoteWrites: true,
    });
    const { data } = migrate(raw);
    expect(data.settings.apiEnabled).toBe(true);
    expect(data.settings.apiPort).toBe(30123);
    expect(data.settings.apiToken).toBe("f".repeat(48));
    expect(data.settings.apiHost).toBe("all");
    expect(data.settings.apiAllowRemoteWrites).toBe(true);
  });

  it("repairs malformed API values without ever widening exposure", () => {
    const raw = currentFileWithoutApiKeys();
    Object.assign(raw.settings as object, {
      apiEnabled: "yes",
      apiPort: 70000,
      apiToken: 42,
      apiHost: "everywhere",
      apiAllowRemoteWrites: 1,
    });
    const { data } = migrate(raw);
    expect(data.settings.apiEnabled).toBe(false);
    expect(data.settings.apiPort).toBe(27129);
    expect(data.settings.apiToken).toBe("");
    // An unreadable choice narrows to this Mac rather than taking the wider default.
    expect(data.settings.apiHost).toBe("loopback");
    expect(data.settings.apiAllowRemoteWrites).toBe(false);

    for (const port of [0, -1, 27129.5, "27129", null]) {
      const r = currentFileWithoutApiKeys();
      (r.settings as Record<string, unknown>).apiPort = port;
      expect(migrate(r).data.settings.apiPort, String(port)).toBe(27129);
    }
  });
});
