/**
 * The full-view default, and the one-shot that moves an existing library onto it.
 *
 * Raising a default is easy. Raising one that has *already been written to
 * every user's disk* is the part that goes wrong: 1.25.0 shipped
 * `openTitlesInFullView: false`, and `migrateSettings` faithfully reads whatever
 * is stored, so changing `createDefaultSettings` alone would have changed
 * nothing for anybody who already had the plugin.
 *
 * So there is a flip, and a flip is a thing that must happen exactly once. Three
 * properties, and each one is a real way to get this wrong:
 *
 *   1. **It moves a stored `false`.** The user who has never touched this
 *      setting gets the new surface.
 *   2. **It is not idempotent by accident, it is idempotent by marker.**
 *      `migrate()` runs on *every* load (`data/store.ts`), not only on a schema
 *      bump, so "we already migrated to v4" proves nothing. Only
 *      `FULL_VIEW_DEFAULT_MARKER` does.
 *   3. **A later "off" is final.** Turning the setting off after the flip must
 *      survive every subsequent load, or the plugin is arguing with its user.
 *      The same holds on a *fresh* install, which is why the marker is stamped
 *      by `createDefaultSettings` too and not only by the flip.
 *
 * And underneath all three, the rule from the `types.ts` header: the marker is
 * an undeclared key, so a settings object that has been through migration must
 * still carry every other undeclared key it arrived with.
 */
import { describe, expect, it } from "vitest";
import { migrate } from "../src/data/migrate";
import {
  FULL_VIEW_DEFAULT_MARKER,
  createDefaultSettings,
  createTitle,
} from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import { readExtra, writeExtra, type Settings } from "../src/types";

/** A v4 file as it sits on disk, with whatever settings the case needs. */
function fileWith(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 4,
    titles: [createTitle({ id: "t", title: "The Thing", type: "Movie" })],
    groups: [],
    history: [],
    settings: {
      // A key v4 does not declare, riding along the whole way through.
      omdbApiKey: "an-old-v3-key",
      ...settings,
    },
  };
}

function migratedSettings(settings: Record<string, unknown>): Settings {
  return migrate(fileWith(settings)).data.settings;
}

function marked(settings: Settings): boolean {
  return readExtra<unknown>(settings, FULL_VIEW_DEFAULT_MARKER) === true;
}

describe("the one-shot flip", () => {
  it("moves a stored false to the full view and marks the install", () => {
    // Iwan's actual file: 1.25.0 wrote `false` into it the first time it ran.
    const settings = migratedSettings({ openTitlesInFullView: false });
    expect(settings.openTitlesInFullView).toBe(true);
    expect(marked(settings)).toBe(true);
  });

  it("moves a file that predates the key at all", () => {
    const settings = migratedSettings({});
    expect(settings.openTitlesInFullView).toBe(true);
    expect(marked(settings)).toBe(true);
  });

  it("leaves an install that had already opted in exactly where it was", () => {
    const settings = migratedSettings({ openTitlesInFullView: true });
    expect(settings.openTitlesInFullView).toBe(true);
    expect(marked(settings)).toBe(true);
  });

  it("never runs twice: an off after the flip survives every later load", () => {
    // The user is handed the new default, dislikes it, and turns it off. The
    // marker is on disk beside their answer by then, so the next load — and the
    // ten after it — must read the answer, not the default.
    const first = migratedSettings({ openTitlesInFullView: false });
    expect(first.openTitlesInFullView).toBe(true);

    first.openTitlesInFullView = false;
    let file = fileWith({ ...(first as unknown as Record<string, unknown>) });
    for (let i = 0; i < 10; i += 1) {
      const settings = migrate(file).data.settings;
      expect(settings.openTitlesInFullView).toBe(false);
      expect(marked(settings)).toBe(true);
      file = fileWith({ ...(settings as unknown as Record<string, unknown>) });
    }
  });

  it("respects a marker that arrives with the value already false", () => {
    // The shape a saved file has after the user turned it off: both keys, one
    // load apart from each other. Nothing may touch it.
    const raw: Record<string, unknown> = { openTitlesInFullView: false };
    raw[FULL_VIEW_DEFAULT_MARKER] = true;
    const settings = migratedSettings(raw);
    expect(settings.openTitlesInFullView).toBe(false);
  });

  it("is not fooled by a marker that is not `true`", () => {
    // A hand-edited or half-written marker means "not done", not "done".
    for (const bogus of [false, "yes", 1, null]) {
      const raw: Record<string, unknown> = { openTitlesInFullView: false };
      raw[FULL_VIEW_DEFAULT_MARKER] = bogus;
      expect(migratedSettings(raw).openTitlesInFullView).toBe(true);
    }
  });

  it("keeps every key it does not own, marker or no marker", () => {
    const settings = migratedSettings({ openTitlesInFullView: false });
    expect(readExtra(settings, "omdbApiKey")).toBe("an-old-v3-key");
  });
});

describe("a fresh install", () => {
  it("ships the full view on, and already marked", () => {
    const defaults = createDefaultSettings();
    expect(defaults.openTitlesInFullView).toBe(true);
    // Without the marker here, a user who turns the full view off on day one
    // would be overruled by the flip on their second load.
    expect(marked(defaults)).toBe(true);
  });

  it("keeps a day-one 'off' off", () => {
    const defaults = createDefaultSettings();
    defaults.openTitlesInFullView = false;
    const settings = migratedSettings({ ...(defaults as unknown as Record<string, unknown>) });
    expect(settings.openTitlesInFullView).toBe(false);
  });
});

describe("the marker as the settings tab writes it", () => {
  it("survives the store's load path with the value the user chose", async () => {
    const stored = fileWith({ openTitlesInFullView: false });
    writeExtra(stored.settings as object, FULL_VIEW_DEFAULT_MARKER, true);

    const saved: unknown[] = [];
    const store = new WatchLogStore({
      loadData: async () => stored,
      saveData: async (data: unknown) => {
        saved.push(data);
      },
    } as never);
    await store.load();

    expect(store.settings.openTitlesInFullView).toBe(false);
    expect(readExtra(store.settings, "omdbApiKey")).toBe("an-old-v3-key");
    // Loading is not a write. The store has never been allowed to save on load.
    expect(saved).toHaveLength(0);
  });

  it("hands an unmarked file the flip through the same path", async () => {
    const store = new WatchLogStore({
      loadData: async () => fileWith({ openTitlesInFullView: false }),
      saveData: async () => undefined,
    } as never);
    await store.load();
    expect(store.settings.openTitlesInFullView).toBe(true);
    expect(marked(store.settings)).toBe(true);
  });
});
