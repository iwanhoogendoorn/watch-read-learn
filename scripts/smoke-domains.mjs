/**
 * Headless mounts of the Reading and Games tabs (W8-integration).
 *
 *   node scripts/smoke-domains.mjs --vault /path/to/Vault [--only reading]
 *   WATCHLOG_VAULT=/path/to/Vault node scripts/smoke-domains.mjs
 *
 * Both tabs are mounted twice: once over a fixture with entries in every state
 * the tab has a branch for, and once over the **real vault's** `data.json` —
 * which today has empty reading and games libraries, and that is exactly the
 * case worth running, because an empty library is where NaN and blank panels
 * live.
 *
 * The four questions are the dashboard smoke's, shared from `smoke-shared.mjs`:
 * did anything throw, did anything render blank, did a number reach the DOM
 * badly, and is any class declared by two partials.
 *
 * SAFETY: the vault file is read once and never written; nothing here touches
 * the network (the `obsidian` shim's `requestUrl` throws).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHarness,
  reportBadNumbers,
  reportBoxes,
  reportCaughtErrors,
  reportStyleCollisions,
} from "./smoke-shared.mjs";
import { resolveDataPath } from "./vault-data.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}

const DATA_PATH = resolveDataPath({
  script: "scripts/smoke-domains.mjs",
  data: flag("data", ""),
  vault: flag("vault", ""),
});
const ONLY = flag("only", "");

const ENTRY = `
export { mountReadingTab } from ${JSON.stringify(join(root, "src/domains/reading/tab.ts"))};
export { mountGamesTab } from ${JSON.stringify(join(root, "src/domains/games/tab.ts"))};
export { migrate } from ${JSON.stringify(join(root, "src/data/migrate.ts"))};
export { createBook, createManga, createGame, createReadingSettings, createGamesSettings } from ${JSON.stringify(join(root, "src/data/schema.ts"))};
export { StubEl, installDomGlobals, createHost } from ${JSON.stringify(join(root, "tests/helpers/dom.ts"))};
`;

const { mod, cleanup } = await loadHarness(root, ENTRY);
const restore = mod.installDomGlobals(900);
let failures = 0;
const log = (line) => console.log(line);

/** A store over a plain data object, enough for a tab to mount and render. */
function storeOf(data) {
  return {
    data,
    settings: data.settings,
    reading: data.reading,
    games: data.games,
    allTitles: () => data.titles,
    getTitle: (id) => data.titles.find((t) => t.id === id),
    getTitleByName: (name) => data.titles.find((t) => t.title === name),
    updateTitle: () => undefined,
    updateCaches: () => undefined,
    addTitle: () => undefined,
    deleteTitle: () => true,
    markEpisodeWatched: () => undefined,
    save: () => undefined,
    logActivity: () => undefined,
    emitChanged: () => undefined,
  };
}

/** The states each tab branches on: finished, in progress, unstarted, unreleased. */
function populate(data) {
  data.reading.books = [
    mod.createBook({
      id: "dune",
      title: "Dune",
      author: "Frank Herbert",
      status: "Completed",
      rating: 5,
      pagesRead: 528,
      totalPages: 528,
      favorite: true,
    }),
    mod.createBook({
      id: "wip",
      title: "Half Read",
      author: "Someone",
      status: "Reading",
      pagesRead: 100,
      totalPages: 400,
    }),
    mod.createBook({
      id: "words",
      title: "Counted In Words",
      status: "Reading",
      progressUnit: "words",
      wordsRead: 12500,
      totalWords: 90000,
    }),
    mod.createBook({ id: "soon", title: "Not Out Yet", status: "Plan to Read", releaseDate: "2027-01-01" }),
    // The hostile one: no pages, no dates, no author — every denominator zero.
    mod.createBook({ id: "bare", title: "Bare" }),
  ];
  data.reading.manga = [
    mod.createManga({
      id: "berserk",
      title: "Berserk",
      author: "Kentaro Miura",
      status: "Reading",
      chaptersRead: 300,
      totalChapters: 374,
      volumesRead: 34,
      totalVolumes: 42,
    }),
    mod.createManga({ id: "bare-manga", title: "Bare Manga" }),
  ];
  data.games.games = [
    mod.createGame({
      id: "hades",
      title: "Hades",
      developer: "Supergiant",
      type: "RPG",
      status: "Finished",
      rating: 5,
      playtimeMinutes: 4210,
      achievementsEarned: 49,
      achievementsTotal: 49,
      platforms: ["Windows PC"],
      favorite: true,
    }),
    mod.createGame({
      id: "playing",
      title: "Mid Playthrough",
      status: "Playing",
      progress: 40,
      playtimeMinutes: 600,
      achievementsEarned: 3,
      achievementsTotal: 40,
    }),
    mod.createGame({ id: "wish", title: "Wishlisted", status: "Not started", wishlist: true }),
    mod.createGame({ id: "tba", title: "No Date", status: "TBA" }),
    // Zero everything.
    mod.createGame({ id: "bare-game", title: "Bare Game" }),
  ];
  return data;
}

function mount(which, data) {
  const host = mod.createHost(900);
  const store = storeOf(data);
  const deps = { app: { workspace: {}, vault: {} }, store };
  const controller =
    which === "reading" ? mod.mountReadingTab(host, deps) : mod.mountGamesTab(host, deps);
  return { host, controller };
}

/** Panels worth resolving a box for: anything that holds content. */
function containersOf(root, which) {
  const out = [];
  for (const el of root.flatten()) {
    for (const cls of el.classes) {
      if (/^wl-(reading|games|game)-(panel|card|section|grid|list|table)$/.test(cls)) {
        out.push({ name: `${which}: .${cls}`, el });
        break;
      }
    }
  }
  // Always report the tab panel itself, so an empty run still says something.
  const panel = root.querySelector(`.wl-tab-panel-${which}`);
  if (panel) out.unshift({ name: `${which}: tab panel`, el: panel });
  return out;
}

function runOne(which, data, label) {
  console.log(`\n=== ${which} tab — ${label} ===`);
  let local = 0;

  let mounted;
  try {
    mounted = mount(which, data);
  } catch (err) {
    console.log(`   ✗ the tab threw while mounting: ${err instanceof Error ? err.stack : err}`);
    return 1;
  }
  const el = mounted.controller.el;

  local += reportCaughtErrors(el, log);

  console.log("B. What rendered");
  const rows = el.flatten().filter((node) =>
    [...node.classes].some((c) => /(row|card|entry|item)$/.test(c)),
  );
  const empty = el.querySelectorAll(".wl-empty").concat(el.querySelectorAll(".wl-chart-empty"));
  if (rows.length === 0 && empty.length === 0) {
    console.log("   ✗ neither rows nor an empty state — a blank tab");
    local += 1;
  } else if (rows.length === 0) {
    console.log(`   ✓ empty state: “${empty[0]?.textContent.slice(0, 60)}…”`);
  } else {
    console.log(`   ✓ ${rows.length} row(s) rendered`);
  }

  local += reportBadNumbers(el, log);

  const containers = containersOf(el, which);
  local += reportBoxes(root, containers, log);

  // The tab has to survive being torn down — the harness catches a destroy that
  // throws, which a real user would only see as a dead pane.
  try {
    mounted.controller.destroy();
  } catch (err) {
    console.log(`   ✗ destroy() threw: ${err instanceof Error ? err.message : err}`);
    local += 1;
  }

  console.log(local === 0 ? "   PASS" : `   FAIL — ${local} problem(s)`);
  return local;
}

try {
  console.log("Watch, Read and Learn v4 — headless Reading and Games render");
  console.log(`  data: ${DATA_PATH} (read-only, no network)`);

  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const vault = mod.migrate(structuredClone(raw)).data;
  console.log(
    `  vault: ${vault.reading.books.length} book(s), ${vault.reading.manga.length} manga, ${vault.games.games.length} game(s)`,
  );

  const fixture = populate(mod.migrate(structuredClone(raw)).data);

  const which = ONLY ? [ONLY] : ["reading", "games"];
  for (const tab of which) {
    failures += runOne(tab, fixture, "fixture with every state");
    failures += runOne(tab, vault, "the real vault, as it is today");
  }

  console.log("");
  failures += reportStyleCollisions(root, log);

  console.log("");
  console.log(failures === 0 ? "  PASS  nothing broken" : `  FAIL  ${failures} problem(s)`);
  if (failures > 0) process.exitCode = 1;
} finally {
  restore();
  await cleanup();
}
