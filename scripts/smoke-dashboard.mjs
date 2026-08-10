/**
 * "The dashboard looks broken" — a headless reproduction (QA4).
 *
 *   node scripts/smoke-dashboard.mjs [--data /path/to/data.json]
 *
 * Mounts the real Dashboard tab over the real vault's `data.json` (migrated
 * in-memory) and reports the triad that covers what "looks broken" can mean:
 *
 *   A. sections whose error-isolation wrapper caught a throw — name, message,
 *      stack. These render as inline error panels in the app;
 *   B. sections that rendered no content at all — a blank panel is as broken as
 *      an error, and a *named empty state* is the correct answer instead;
 *   C. arithmetic that reached the DOM as `NaN`, `Infinity` or `undefined` —
 *      the classic near-empty-library failure (0/0 rings, averages over none).
 *
 * Plus a static layout audit: no stub can measure a collapsed box (there is no
 * layout engine anywhere in this repo's test surface), but the *class* of bug
 * that collapses one is detectable — a container whose class is styled by two
 * different partials with conflicting geometry. That check is what caught the
 * actual fault behind this report.
 *
 * SAFETY: the vault file is read once, migrated in memory, and never written.
 * No network at all — this script talks to nothing.
 */
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
// The style audit is shared with `smoke-domains.mjs`; three scripts asking the
// same question should ask it once (W8-integration).
import { auditStyles as sharedAuditStyles } from "./smoke-shared.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}

/**
 * Every section `mountDashboardTab` is expected to mount, in order.
 *
 * The user's screenshot showed the hero card and then nothing — so "did it
 * render" is not a question to answer by eye. This list is the answer.
 */
const EXPECTED_SECTIONS = [
  "Overview",
  "By type",
  // Parity (W8-integration): one card per library, then the source filter that
  // decides which library the charts below describe. Both are conditional —
  // "Libraries" only when a parity domain has entries — so the smoke run
  // reports them as optional rather than missing.
  "More statistics",
  "By status",
  "By year",
  "Added over time",
  "Top credits",
  "Continue watching",
  "Up next",
  "Recently watched",
  "Recently added",
];

/** Sections that only appear when the relevant library has something in it. */
const OPTIONAL_SECTIONS = ["Libraries"];

const DATA_PATH = flag(
  "data",
  process.env.WATCHLOG_DATA ??
    "/Users/iwanhoogendoorn/Documents/IWAN-REMOTE-VAULT/.obsidian/plugins/watchlog-v4/data.json",
);

// ---------------------------------------------------------------------------
// Bundle the tab, its model, and the DOM stub the tests use
// ---------------------------------------------------------------------------

const OBSIDIAN_SHIM = `
export function setIcon(el) { if (el && el.addClass) el.addClass("svg-icon-host"); }
export class Notice { constructor(message) { this.message = message; } }
export class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} }
export class Plugin {}
export class Modal {}
export class ItemView {}
export class MarkdownRenderChild {}
export class SuggestModal {}
export class FuzzySuggestModal {}
export class Setting {}
export class PluginSettingTab {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export const Platform = { isMobile: false };
export function normalizePath(p) { return p; }
export async function requestUrl() { throw new Error("smoke-dashboard makes no network calls"); }
`;

const ENTRY = `
export { mountDashboardTab, computeDashboard } from ${JSON.stringify(join(root, "src/ui/tabs/dashboard.ts"))};
export { migrate } from ${JSON.stringify(join(root, "src/data/migrate.ts"))};
export { buildTitleCard } from ${JSON.stringify(join(root, "src/ui/components/card.ts"))};
export { StubEl, installDomGlobals, createHost } from ${JSON.stringify(join(root, "tests/helpers/dom.ts"))};
`;

async function loadHarness() {
  const dir = await mkdtemp(join(tmpdir(), "watchlog-dashboard-"));
  const shimPath = join(dir, "obsidian-shim.mjs");
  const entryPath = join(dir, "entry.ts");
  const outPath = join(dir, "bundle.mjs");

  await writeFile(shimPath, OBSIDIAN_SHIM, "utf8");
  await writeFile(entryPath, ENTRY, "utf8");

  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: outPath,
    logLevel: "warning",
    alias: { obsidian: shimPath },
  });

  const mod = await import(pathToFileURL(outPath).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// The static layout audit
// ---------------------------------------------------------------------------

/**
 * Bare single-class selectors defined by more than one stylesheet partial.
 *
 * One class, two components, two lanes is the shape of the bug behind this
 * report: `.wl-card` meant "poster card" in `20-cards.css` and "dashboard panel"
 * in `50-dashboard.css`, so a 2:3 aspect-ratio meant for posters silently
 * applied to every panel on this tab.
 *
 * The check deliberately flags **any** such duplicate, not only ones where both
 * sides declare geometry: the dashboard's `.wl-card` set nothing but padding and
 * a background — all the damage came from the *other* definition. Requiring both
 * sides to look dangerous is precisely how this shipped.
 */
const GEOMETRY_PROPERTIES = [
  "aspect-ratio",
  "overflow",
  "height",
  "min-height",
  "max-height",
  "position",
  "display",
  "width",
];

function auditStyles() {
  const dir = join(root, "styles");
  const byClass = new Map(); // class -> [{file, props}]
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css")).sort()) {
    const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { selector, body } of topLevelRules(css)) {
      // Only bare single-class selectors: `.wl-card`, not `.wl-card.is-x` or
      // `.a .b`, which are qualified on purpose and cannot collide by accident.
      for (const part of selector.split(",")) {
        const bare = /^\.([a-z0-9-]+)$/i.exec(part.trim());
        if (!bare) continue;
        const props = GEOMETRY_PROPERTIES.filter((p) =>
          new RegExp(`(^|;|\\s)${p}\\s*:`).test(body),
        );
        const list = byClass.get(bare[1]) ?? [];
        list.push({ file, props });
        byClass.set(bare[1], list);
      }
    }
  }

  const collisions = [];
  for (const [cls, entries] of byClass) {
    const files = new Set(entries.map((e) => e.file));
    if (files.size < 2) continue;
    collisions.push({
      cls,
      files: [...files],
      props: [...new Set(entries.flatMap((e) => e.props))],
    });
  }
  return collisions;
}

/**
 * Rules at brace depth 0 only.
 *
 * A class re-declared inside `@media` is the same component being adjusted, not
 * a second component wearing its name — counting those was the check's own false
 * positive.
 */
function topLevelRules(css) {
  const out = [];
  let depth = 0;
  let selectorStart = 0;
  let selector = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = css.slice(selectorStart, i).trim();
        selectorStart = i + 1;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        // `@media`/`@supports` bodies are skipped whole: their inner rules are
        // adjustments to a component declared elsewhere.
        if (!selector.startsWith("@")) {
          out.push({ selector, body: css.slice(selectorStart, i) });
        }
        selectorStart = i + 1;
      }
    }
  }
  return out;
}

/**
 * Resolve the declarations that actually apply to a set of classes.
 *
 * Not a browser, but enough of one for the question that matters here: rules are
 * bundle-ordered, single-class and compound-class selectors only (a descendant
 * selector needs ancestors this does not model), later and more specific wins.
 */
function buildCascade() {
  const dir = join(root, "styles");
  const rules = [];
  let order = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css")).sort()) {
    const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { selector, body } of topLevelRules(css)) {
      for (const part of selector.split(",")) {
        const trimmed = part.trim();
        // `.a` or `.a.b` — no descendants, no pseudo-classes.
        if (!/^(\.[a-z0-9-]+)+$/i.test(trimmed)) continue;
        const classes = trimmed.split(".").filter(Boolean);
        const props = {};
        for (const decl of body.split(";")) {
          const at = decl.indexOf(":");
          if (at < 0) continue;
          props[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
        }
        rules.push({ file, order: order++, classes, props });
      }
    }
  }
  return (classSet) => {
    const matching = rules
      .filter((rule) => rule.classes.every((c) => classSet.has(c)))
      .sort((a, b) => a.classes.length - b.classes.length || a.order - b.order);
    const out = {};
    for (const rule of matching) {
      for (const [key, value] of Object.entries(rule.props)) out[key] = { value, file: rule.file };
    }
    return out;
  };
}

/** `2 / 3` → 0.666…; anything unparseable → null. */
function ratioOf(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(value ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = m[2] === undefined ? 1 : Number(m[2]);
  return h === 0 ? null : w / h;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { mod, cleanup } = await loadHarness();
const restore = mod.installDomGlobals(900);
let failures = 0;

try {
  console.log("Watch, Read and Learn v4 — headless Dashboard render");
  console.log(`  data: ${DATA_PATH} (read-only, no network)`);

  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const { data } = mod.migrate(structuredClone(raw));
  const titles = data.titles;
  console.log(`  titles: ${titles.length}`);
  console.log(
    `  statuses: ${[...new Set(titles.map((t) => t.status))].map((s) => `${s}=${titles.filter((t) => t.status === s).length}`).join(", ")}`,
  );
  console.log(`  rated: ${titles.filter((t) => t.rating > 0).length}, in progress: ${
    titles.filter((t) => t.watchedEpisodes.length > 0 && t.watchedEpisodes.length < t.totalEpisodes).length
  }`);
  console.log("");

  const store = {
    settings: data.settings,
    allTitles: () => titles,
    getTitle: (id) => titles.find((t) => t.id === id),
    getTitleByName: (name) => titles.find((t) => t.title === name),
    updateTitle: () => undefined,
    updateCaches: () => undefined,
    markEpisodeWatched: () => undefined,
    save: () => undefined,
    logActivity: () => undefined,
    emitChanged: () => undefined,
  };

  const host = mod.createHost(900);
  const deps = {
    store,
    buildCard: (parent, title, ctx) => {
      mod.buildTitleCard(parent, title, ctx);
    },
    onOpenTitle: () => undefined,
    onJumpToQuery: () => undefined,
    onGoToTab: () => undefined,
    now: () => new Date(),
  };

  const controller = mod.mountDashboardTab(host, deps);
  const rootEl = controller.el;
  const all = rootEl.flatten();

  // --- A. caught errors ----------------------------------------------------

  console.log("A. Sections whose error wrapper caught a throw");
  const broken = all.filter((el) => el.classes.has("is-broken"));
  if (broken.length === 0) {
    console.log("   none");
  } else {
    failures += broken.length;
    for (const el of broken) {
      const head = el.querySelector(".wl-error-panel-head");
      const body = el.querySelector(".wl-error-panel-body");
      console.log(`   ✗ ${head?.textContent ?? "?"}`);
      console.log(`       ${body?.textContent ?? "(no message)"}`);
    }
  }
  console.log("");

  // --- B. the section list -------------------------------------------------

  console.log("B. Section list — every one must mount, with content or a named empty state");
  const sections = all.filter((el) => el.classes.has("wl-section"));
  const found = sections.map((s) => ({
    el: s,
    name:
      s.querySelector(".wl-section-title")?.textContent ??
      (s.querySelector(".wl-ring") ? "Overview" : "(unnamed)"),
  }));

  for (const expected of [...EXPECTED_SECTIONS, ...OPTIONAL_SECTIONS]) {
    const hit = found.find((f) => f.name === expected);
    if (!hit) {
      if (OPTIONAL_SECTIONS.includes(expected)) {
        console.log(`   · ${expected} — not shown (no entries in that library)`);
        continue;
      }
      failures += 1;
      console.log(`   ✗ ${expected} — MISSING`);
      continue;
    }
    const emptyState = hit.el.querySelector(".wl-chart-empty");
    const contentful = hit.el
      .flatten()
      .filter((el) => el !== hit.el && (el.ownText !== "" || el.tag === "circle" || el.tag === "img"));
    const ok = emptyState !== null || contentful.length > 0;
    if (!ok) failures += 1;
    console.log(
      `   ${ok ? "✓" : "✗"} ${expected} — ${
        emptyState ? `empty state: “${emptyState.textContent.slice(0, 52)}…”` : `${contentful.length} content node(s)`
      }`,
    );
  }
  const unexpected = found.filter((f) => !EXPECTED_SECTIONS.includes(f.name));
  for (const extra of unexpected) console.log(`   · extra section: ${extra.name}`);
  console.log(
    `   ${found.length}/${EXPECTED_SECTIONS.length} expected sections mounted${
      unexpected.length ? ` (+${unexpected.length} unexpected)` : ""
    }`,
  );
  console.log("");

  // --- C. NaN / Infinity / undefined ---------------------------------------

  console.log("C. Numbers that reached the DOM badly");
  const bad = [];
  for (const el of all) {
    if (el.ownText === "") continue;
    if (/\b(NaN|Infinity|-Infinity|undefined|null)\b/.test(el.ownText)) {
      bad.push(`${[...el.classes].join(".") || el.tag}: “${el.ownText}”`);
    }
  }
  for (const el of all) {
    for (const [key, value] of el.attrs) {
      if (/NaN|Infinity|undefined/.test(value)) bad.push(`${el.tag}[${key}]="${value}"`);
    }
    for (const key of ["--wl-bar-pct", "--wl-col-pct"]) {
      const v = el.style.getPropertyValue(key);
      if (v && /NaN|Infinity|undefined/.test(v)) bad.push(`${el.tag} ${key}: ${v}`);
    }
  }
  if (bad.length === 0) console.log("   none");
  else {
    failures += bad.length;
    for (const entry of bad) console.log(`   ✗ ${entry}`);
  }
  console.log("");

  // --- D. layout audit -----------------------------------------------------

  console.log("D. Layout audit — one class defined by two partials");
  const collisions = sharedAuditStyles(root);
  const mounted = new Set();
  for (const el of all) for (const cls of el.classes) mounted.add(cls);
  const relevant = collisions.filter((c) => mounted.has(c.cls));
  if (collisions.length === 0) console.log("   no class is declared by two partials");
  for (const c of relevant) {
    failures += 1;
    const users = all.filter((el) => el.classes.has(c.cls)).length;
    console.log(
      `   ✗ .${c.cls} declared by ${c.files.join(" AND ")}${c.props.length ? ` — geometry: ${c.props.join(", ")}` : ""}`,
    );
    console.log(`       ${users} element(s) on this dashboard carry that class`);
  }
  for (const c of collisions.filter((x) => !mounted.has(x.cls))) {
    failures += 1;
    console.log(
      `   ✗ .${c.cls} declared by ${c.files.join(" AND ")} (not on this tab, but the same trap)`,
    );
  }
  console.log("");

  // --- E. resolved geometry per section ------------------------------------

  console.log("E. Resolved box of every section, from the real stylesheet");
  const resolve = buildCascade();
  const VIEWPORT = 900;
  for (const { name, el } of found) {
    const style = resolve(el.classes);
    const ratio = ratioOf(style["aspect-ratio"]?.value);
    const overflow = style["overflow"]?.value ?? "visible";
    const height = ratio ? Math.round(VIEWPORT / ratio) : null;
    // A section is a text panel: it is as tall as what is in it. **Any** fixed
    // ratio is wrong here — that is a poster's property, and inheriting one is
    // exactly how six screen-tall empty rectangles ended up on this tab. The
    // clipping is the second half: `overflow: hidden` on a content panel hides
    // whatever did not fit.
    const bad = ratio !== null || (overflow === "hidden" && height === null);
    if (bad) failures += 1;
    const note = ratio
      ? `aspect-ratio ${style["aspect-ratio"].value} from ${style["aspect-ratio"].file} → ${height}px tall at ${VIEWPORT}px wide, overflow: ${overflow}`
      : `content-sized, overflow: ${overflow}`;
    console.log(`   ${bad ? "✗" : "✓"} ${name} — ${note}`);
  }
  console.log("");

  console.log(failures === 0 ? "  PASS  nothing broken" : `  FAIL  ${failures} problem(s)`);
  if (failures > 0) process.exitCode = 1;
} finally {
  restore();
  await cleanup();
}
