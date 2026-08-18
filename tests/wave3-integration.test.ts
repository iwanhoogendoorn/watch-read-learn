/**
 * The Wave-3 integration pass: three new settings, two new workspace views.
 *
 * The load-bearing file here is the first block. Iwan has a real library in a
 * real `data.json`, and the way a settings migration destroys one is not by
 * throwing — it is by rebuilding `settings` from a literal, so that every key
 * the current `Settings` interface does not happen to declare (`omdbApiKey`,
 * `airtime`, an experiment from v3, a key a *future* version writes) quietly
 * stops existing. `types.ts` says this in as many words at the top of the file.
 * So the assertions below are mostly negative: after loading a file that has
 * none of the new keys, every old key must still be there, byte for byte, and
 * the new ones must land on the values that reproduce the old behaviour —
 * artwork cache off, sweep on its documented cadence. The one deliberate
 * exception is `openTitlesInFullView`, which is *moved* rather than preserved;
 * `full-view-default.test.ts` owns the once-and-only-once rule behind that.
 *
 * The second block proves the two views are registered under the ids Obsidian
 * writes into a saved workspace layout, that registering is lazy, and that a
 * leaf restored from a previous session — state and all, including a title id
 * that has since been deleted — comes back without throwing.
 */
import { describe, expect, it } from "vitest";
import { migrate } from "../src/data/migrate";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { WatchLogStore } from "../src/data/store";
import { readExtra, type Settings, type WatchLogData } from "../src/types";
import {
  DEFAULT_IMAGE_CACHE_FOLDER,
  normalizeCacheFolder,
} from "../src/services/imagecache";
import {
  SWEEP_TTL_DISABLED,
  SWEEP_TTL_HOURS_DEFAULT,
  SWEEP_TTL_SETTING_KEY,
} from "../src/services/sweep";
import {
  PersonView,
  registerPersonView,
  VIEW_TYPE_PERSON,
  type PersonScreenDeps,
  type PersonViewHost,
} from "../src/ui/views/person";
import {
  registerTitleDetailView,
  TitleDetailView,
  VIEW_TYPE_TITLE_DETAIL,
  type TitleDetailDeps,
} from "../src/ui/views/title-detail";
import { createHost } from "./helpers/dom";
import type { PersonService } from "../src/services/tmdb-person";

// ---------------------------------------------------------------------------
// A v4 data.json from before any of this existed
// ---------------------------------------------------------------------------

/**
 * Deliberately hand-built rather than derived from `createDefaultSettings()`:
 * a fixture built from today's defaults would grow the new keys automatically
 * and this whole file would assert nothing.
 */
function legacyFile(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    titles: [
      {
        id: "dune",
        title: "Dune",
        type: "Movie",
        status: "Completed",
        priority: "",
        review: "Great",
        rating: 5,
        notes: "Watched on the big screen.",
        tmdbId: 438631,
      },
    ],
    groups: [],
    history: [],
    settings: {
      // A representative slice of what a real file carries, with values the
      // user changed away from the defaults so a reset would be obvious.
      rootFolder: "Media/Watching",
      dateFormat: "iso",
      halfStarRatings: true,
      airingTtlHours: 6,
      plexTtlHours: 24,
      requestPollMinutes: 15,
      generateNotes: false,
      dashboardTopCredits: 12,
      overseerrUrl: "https://seerr.example.test",
      overseerrApiKey: "secret-key",
      // Keys v4 has never declared. These are the canary.
      omdbApiKey: "an-old-v3-key",
      someFutureToggle: true,
    },
    // Top-level keys the core does not own.
    airtime: { "dune": "20:00" },
    drafts: { dismissed: ["a-note"] },
    recommendedDaily: { date: "2026-01-01", ids: ["dune"] },
  };
}

describe("an existing data.json with none of the new keys", () => {
  const before = legacyFile();
  const { data } = migrate(legacyFile());
  const settings = data.settings;

  it("loads without resetting anything", () => {
    expect(data.titles).toHaveLength(1);
    expect(data.titles[0]?.title).toBe("Dune");
    expect(data.titles[0]?.rating).toBe(5);
  });

  it.each([
    ["rootFolder", "Media/Watching"],
    ["dateFormat", "iso"],
    ["halfStarRatings", true],
    ["airingTtlHours", 6],
    ["plexTtlHours", 24],
    ["requestPollMinutes", 15],
    ["generateNotes", false],
    ["dashboardTopCredits", 12],
    ["overseerrUrl", "https://seerr.example.test"],
    ["overseerrApiKey", "secret-key"],
  ])("leaves the existing setting %s exactly as it was", (key, value) => {
    expect((settings as unknown as Record<string, unknown>)[key]).toEqual(value);
  });

  it("keeps settings keys the Settings interface does not declare", () => {
    // The whole reason `readExtra` exists. A rebuilt-from-literal `settings`
    // loses both of these and TypeScript cannot see it happen.
    expect(readExtra(settings, "omdbApiKey")).toBe("an-old-v3-key");
    expect(readExtra(settings, "someFutureToggle")).toBe(true);
  });

  it.each(["airtime", "recommendedDaily"])(
    "keeps the top-level %s subtree byte-identically",
    (key) => {
      const original = (before as Record<string, unknown>)[key];
      const after = readExtra(data as unknown as object, key);
      expect(JSON.stringify(after)).toBe(JSON.stringify(original));
    },
  );

  it("keeps what the user put in drafts, which v4 normalises rather than copies", () => {
    // `drafts` is one of the three domains v4 owns, so it gains the keys the
    // current shape declares. What must not change is the part the user wrote.
    expect(data.drafts?.dismissed).toEqual(["a-note"]);
  });

  it("defaults the artwork cache to OFF, in the default folder", () => {
    // The one setting where the wrong default writes files into somebody's
    // vault without them asking.
    expect(settings.cacheImagesLocally).toBe(false);
    expect(settings.imageCacheFolder).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
  });

  it("moves a file that never had the key onto the full-tab default", () => {
    expect(settings.openTitlesInFullView).toBe(true);
  });

  it("defaults the metadata sweep to its documented cadence, not to off", () => {
    expect(settings.metadataSweepTtlHours).toBe(SWEEP_TTL_HOURS_DEFAULT);
  });
});

describe("the new settings, once they are on disk", () => {
  function migrated(over: Record<string, unknown>): Settings {
    const raw = legacyFile();
    Object.assign(raw.settings as Record<string, unknown>, over);
    return migrate(raw).data.settings;
  }

  it("keeps an explicit 0 — the sweep's off switch survives a reload", () => {
    expect(migrated({ metadataSweepTtlHours: SWEEP_TTL_DISABLED }).metadataSweepTtlHours).toBe(
      SWEEP_TTL_DISABLED,
    );
  });

  it("keeps a TTL the user chose", () => {
    expect(migrated({ metadataSweepTtlHours: 72 }).metadataSweepTtlHours).toBe(72);
  });

  it("falls back rather than carrying a nonsense TTL through", () => {
    expect(migrated({ metadataSweepTtlHours: "weekly" }).metadataSweepTtlHours).toBe(
      SWEEP_TTL_HOURS_DEFAULT,
    );
    expect(migrated({ metadataSweepTtlHours: -5 }).metadataSweepTtlHours).toBe(0);
  });

  it("keeps the cache on, and the folder, once the user opts in", () => {
    const settings = migrated({ cacheImagesLocally: true, imageCacheFolder: "Art/Posters" });
    expect(settings.cacheImagesLocally).toBe(true);
    expect(settings.imageCacheFolder).toBe("Art/Posters");
  });

  it("never lets a hand-edited folder escape the vault", () => {
    // Migration carries the string verbatim — it is not migration's job to
    // decide what a path means. `normalizeCacheFolder` is what the plugin and
    // the settings tab both put in front of every single use of it, and what it
    // guarantees is that no traversal survives: the result is always a plain
    // vault-relative folder with no `..` in it.
    const settings = migrated({ imageCacheFolder: "../../../.ssh" });
    const folder = normalizeCacheFolder(settings.imageCacheFolder);
    expect(folder).toBe(".ssh");
    expect(folder.split("/")).not.toContain("..");
    expect(folder.startsWith("/")).toBe(false);
    expect(normalizeCacheFolder("/etc/../../passwd")).toBe("etc/passwd");
    expect(normalizeCacheFolder("")).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
  });

  it("keeps the full-view choice", () => {
    expect(migrated({ openTitlesInFullView: true }).openTitlesInFullView).toBe(true);
  });
});

describe("defaults for a brand-new install", () => {
  const defaults = createDefaultSettings();

  it("matches what the sweep service expects to read", () => {
    // If these two ever disagree, the setting exists and the sweep silently
    // ignores it. The service names the key; this is the only place that
    // proves the field on `Settings` is spelled the same way.
    expect(SWEEP_TTL_SETTING_KEY).toBe("metadataSweepTtlHours");
    expect(readExtra(defaults, SWEEP_TTL_SETTING_KEY)).toBe(defaults.metadataSweepTtlHours);
    expect(defaults.metadataSweepTtlHours).toBe(SWEEP_TTL_HOURS_DEFAULT);
  });

  it("ships the artwork cache off, in an already-normal folder", () => {
    expect(defaults.cacheImagesLocally).toBe(false);
    expect(defaults.imageCacheFolder).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
    expect(normalizeCacheFolder(defaults.imageCacheFolder)).toBe(defaults.imageCacheFolder);
  });

  it("ships titles in a full tab", () => {
    expect(defaults.openTitlesInFullView).toBe(true);
  });
});

describe("the store's own load path", () => {
  it("gives a file with no new keys the same defaults migration does", async () => {
    const saved: unknown[] = [];
    const store = new WatchLogStore({
      loadData: async () => legacyFile(),
      saveData: async (data: unknown) => {
        saved.push(data);
      },
    } as never);
    await store.load();

    expect(store.settings.cacheImagesLocally).toBe(false);
    expect(store.settings.imageCacheFolder).toBe(DEFAULT_IMAGE_CACHE_FOLDER);
    expect(store.settings.openTitlesInFullView).toBe(true);
    expect(store.settings.metadataSweepTtlHours).toBe(SWEEP_TTL_HOURS_DEFAULT);
    // And the user's own values are still there afterwards.
    expect(store.settings.rootFolder).toBe("Media/Watching");
    expect(readExtra(store.settings, "omdbApiKey")).toBe("an-old-v3-key");
    // Loading must not have written anything on its own.
    expect(saved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The two workspace views
// ---------------------------------------------------------------------------

interface Registration {
  type: string;
  create: (leaf: unknown) => unknown;
}

function recorder(): { registered: Registration[]; host: PersonViewHost } {
  const registered: Registration[] = [];
  const host = {
    app: {} as never,
    registerView(type: string, create: (leaf: never) => never): void {
      registered.push({ type, create: create as unknown as (leaf: unknown) => unknown });
    },
  };
  return { registered, host: host as unknown as PersonViewHost };
}

/** A person service that fails loudly: nothing in these tests may reach it. */
function stubPeople(): PersonService {
  const boom = (): never => {
    throw new Error("the view must not touch the person service on registration");
  };
  return {
    configured: () => false,
    cached: () => undefined,
    isStale: () => false,
    cachedResolution: () => undefined,
    resolve: boom,
    load: boom,
    rememberChoice: boom,
  } as unknown as PersonService;
}

function personDeps(): PersonScreenDeps {
  return {
    people: stubPeople(),
    titles: () => [],
    onOpenTitle: () => undefined,
    onAdd: async () => undefined,
  };
}

function storeWithTitle(): WatchLogStore {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  (store as unknown as { _data: WatchLogData })._data = migrate(null).data;
  store.data.titles.push(createTitle({ id: "dune", title: "Dune", type: "Movie" }));
  return store;
}

describe("registering the person view", () => {
  it("registers under the id a saved layout writes, and does not build one yet", () => {
    const { registered, host } = recorder();
    registerPersonView(host, personDeps());

    expect(registered).toHaveLength(1);
    expect(registered[0]?.type).toBe(VIEW_TYPE_PERSON);
    // Lazy: the factory has not run, so nothing here has touched a store, a
    // setting or the network. This is what makes it safe to register in
    // `onload` before `store.load()`.
    expect(registered[0]?.create).toBeTypeOf("function");
  });

  it("builds a view that answers for its own type", () => {
    const { registered, host } = recorder();
    registerPersonView(host, personDeps());
    const view = registered[0]?.create({}) as PersonView;

    expect(view).toBeInstanceOf(PersonView);
    expect(view.getViewType()).toBe(VIEW_TYPE_PERSON);
    expect(view.getIcon()).toBeTypeOf("string");
    expect(view.getDisplayText()).toBeTypeOf("string");
  });

  it("survives a stale leaf restored from a previous session", async () => {
    const { registered, host } = recorder();
    registerPersonView(host, personDeps());
    const view = registered[0]?.create({}) as PersonView;

    // Exactly what Obsidian does on startup: recreate the view, then hand it
    // back whatever `getState` returned last time — including, here, nothing
    // useful at all.
    await expect(view.setState({ personId: 525, name: "Christopher Nolan" }, {} as never))
      .resolves.toBeUndefined();
    await expect(view.setState(null, {} as never)).resolves.toBeUndefined();
    await expect(view.setState({ personId: "not-a-number" }, {} as never))
      .resolves.toBeUndefined();
    expect(view.getState()).toBeTypeOf("object");
    // No screen is mounted (no `onOpen`), so the state has nowhere to go — and
    // that is the point: it must not throw looking for one.
    await expect(view.onClose()).resolves.toBeUndefined();
  });
});

describe("registering the title detail view", () => {
  it("registers under its own id, not the tab's", () => {
    const registered: Registration[] = [];
    const plugin = {
      registerView(type: string, create: (leaf: never) => never): void {
        registered.push({ type, create: create as unknown as (leaf: unknown) => unknown });
      },
    };
    const store = storeWithTitle();
    const deps = (): TitleDetailDeps => ({ app: {} as never, store });

    registerTitleDetailView(plugin as never, deps);

    expect(registered).toHaveLength(1);
    // A saved layout holds `watchlog-view` for the tab bar; this must never
    // collide with it or an existing user's layout opens the wrong thing.
    expect(registered[0]?.type).toBe(VIEW_TYPE_TITLE_DETAIL);
    expect(VIEW_TYPE_TITLE_DETAIL).not.toBe("watchlog-view");
  });

  it("restores a leaf whose title still exists, and one whose title is gone", async () => {
    const registered: Registration[] = [];
    const plugin = {
      registerView(type: string, create: (leaf: never) => never): void {
        registered.push({ type, create: create as unknown as (leaf: unknown) => unknown });
      },
    };
    const store = storeWithTitle();
    registerTitleDetailView(plugin as never, () => ({ app: {} as never, store }));

    const view = registered[0]?.create({}) as TitleDetailView;
    expect(view).toBeInstanceOf(TitleDetailView);
    expect(view.getViewType()).toBe(VIEW_TYPE_TITLE_DETAIL);

    // `contentEl` is Obsidian's; a headless leaf gets the same stub host every
    // tab in this suite is mounted into.
    (view as unknown as { contentEl: unknown }).contentEl = createHost(1200);

    await view.setState({ titleId: "dune" }, {} as never);
    expect(view.getState()).toEqual({ titleId: "dune" });
    expect(view.getDisplayText()).toBe("Dune");

    // The interesting one: a layout saved before the user deleted that title.
    // "Title" rather than a crash, and the pane still mounts.
    await view.setState({ titleId: "deleted-last-week" }, {} as never);
    expect(view.getDisplayText()).toBe("Title");

    // And a leaf with no state at all, which is what a corrupt layout hands over.
    await expect(view.setState(null, {} as never)).resolves.toBeUndefined();
    await expect(view.onClose()).resolves.toBeUndefined();
  });
});
