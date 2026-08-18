/**
 * Render the real Dashboard tab to a real browser, the way
 * `preview-cards.mjs` renders cards: mount over the real vault's `data.json`
 * (read-only, migrated in memory), serialize the DOM stub to HTML, wrap it in
 * the built stylesheet, and write ONE self-contained file with light and dark
 * side by side. A layout question is answered by looking.
 *
 *   node scripts/preview-dashboard.mjs --vault /path/to/Vault [--out /tmp/x.html]
 *   WATCHLOG_VAULT=/path/to/Vault node scripts/preview-dashboard.mjs
 *
 * It is a **preview**, not a test. Read it with your eyes.
 *
 * SAFETY: the vault file is read once and never written. No network calls of
 * its own — the browser fetches poster images, exactly as Obsidian does.
 */
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDataPath } from "./vault-data.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return argv[i + 1] ?? fallback;
}

const DATA_PATH = resolveDataPath({
  script: "scripts/preview-dashboard.mjs",
  data: flag("data", ""),
  vault: flag("vault", ""),
});
const OUT = flag("out", join(tmpdir(), "watchlog-dashboard-preview.html"));

// Same shim as smoke-dashboard, except setIcon leaves a marker the preview CSS
// can draw, so icon-shaped gaps look like icons instead of nothing.
const OBSIDIAN_SHIM = `
export function setIcon(el, name) {
  if (el && el.addClass) el.addClass("svg-icon-host");
  if (el && el.attrs) el.attrs.set("data-preview-icon", name ?? "");
}
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
export async function requestUrl() { throw new Error("preview-dashboard makes no network calls"); }
`;

const ENTRY = `
export { mountDashboardTab } from ${JSON.stringify(join(root, "src/ui/tabs/dashboard.ts"))};
export { migrate } from ${JSON.stringify(join(root, "src/data/migrate.ts"))};
export { buildTitleCard } from ${JSON.stringify(join(root, "src/ui/components/card.ts"))};
export { StubEl, installDomGlobals, createHost } from ${JSON.stringify(join(root, "tests/helpers/dom.ts"))};
`;

async function loadHarness() {
  const dir = await mkdtemp(join(tmpdir(), "watchlog-dashpreview-"));
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
// StubEl → HTML
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(["img", "br", "hr", "input"]);

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toHtml(el) {
  const attrs = [];
  if (el.classes.size > 0) attrs.push(`class="${esc([...el.classes].join(" "))}"`);
  for (const [name, value] of el.attrs) attrs.push(`${esc(name)}="${esc(value)}"`);
  for (const [name, value] of Object.entries(el.dataset)) attrs.push(`data-${esc(name)}="${esc(value)}"`);
  if (el.styleText) attrs.push(`style="${esc(el.styleText)}"`);
  if (el.src) attrs.push(`src="${esc(el.src)}"`);
  if (el.tag === "input" && el.value) attrs.push(`value="${esc(el.value)}"`);
  const open = `<${el.tag}${attrs.length > 0 ? " " + attrs.join(" ") : ""}>`;
  if (VOID_TAGS.has(el.tag)) return open;
  const inner = esc(el.ownText) + el.children.map(toHtml).join("");
  return `${open}${inner}</${el.tag}>`;
}

// ---------------------------------------------------------------------------
// Theme vars — the stylesheet's whole vocabulary (10-base.css policy).
// ---------------------------------------------------------------------------

const TYPE_SCALE = `
    --font-ui-smaller: 12px;
    --font-ui-small: 13px;
    --font-ui-medium: 15px;
    --font-ui-large: 20px;
    --font-semibold: 600;
    --font-medium: 500;
    --font-bold: 700;
    --input-height: 30px;
    font-size: 16px;
`;

const THEMES = {
  light: `
    --background-primary: #ffffff;
    --background-primary-alt: #f5f6f8;
    --background-secondary: #f2f3f5;
    --background-secondary-alt: #e9eaee;
    --background-modifier-border: #e0e0e0;
    --background-modifier-hover: rgba(0, 0, 0, 0.05);
    --background-modifier-box-shadow: rgba(0, 0, 0, 0.1);
    --background-modifier-error-hover: #e68787;
    --text-normal: #222222;
    --text-muted: #5c5c5c;
    --text-faint: #999999;
    --text-error: #b34747;
    --text-accent: #5b7cfa;
    --text-on-accent: #ffffff;
    --interactive-normal: #f2f3f5;
    --interactive-hover: #e9eaee;
    --interactive-accent: #5b7cfa;
    --interactive-accent-hover: #4a6af0;
    --color-green: #3aa25c;
    --color-yellow: #d0a215;
    --color-red: #d04255;
  `,
  dark: `
    --background-primary: #1e1e1e;
    --background-primary-alt: #161616;
    --background-secondary: #252525;
    --background-secondary-alt: #2d2d2d;
    --background-modifier-border: #333333;
    --background-modifier-hover: rgba(255, 255, 255, 0.06);
    --background-modifier-box-shadow: rgba(0, 0, 0, 0.3);
    --background-modifier-error-hover: #932525;
    --text-normal: #dadada;
    --text-muted: #b3b3b3;
    --text-faint: #666666;
    --text-error: #ff6b6b;
    --text-accent: #7f6df2;
    --text-on-accent: #ffffff;
    --interactive-normal: #2a2a2a;
    --interactive-hover: #333333;
    --interactive-accent: #7f6df2;
    --interactive-accent-hover: #8f7ff5;
    --color-green: #4caf7d;
    --color-yellow: #e0a83c;
    --color-red: #e5484d;
  `,
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { mod, cleanup } = await loadHarness();
const restore = mod.installDomGlobals(1200);
try {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const { data } = mod.migrate(structuredClone(raw));
  const titles = data.titles;

  const store = {
    settings: data.settings,
    reading: data.reading,
    games: data.games,
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

  const render = () => {
    const host = mod.createHost(1200);
    const controller = mod.mountDashboardTab(host, {
      store,
      buildCard: (parent, title, ctx) => mod.buildTitleCard(parent, title, ctx),
      onOpenTitle: () => undefined,
      onJumpToQuery: () => undefined,
      onGoToTab: () => undefined,
      now: () => new Date(),
    });
    return toHtml(controller.el);
  };

  const body = render();
  const css = await readFile(join(root, "build/styles.css"), "utf8");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Watch, Read and Learn dashboard — ${titles.length} title(s) from the real vault</title>
<style>
${css}

/* Harness only. Nothing below is part of the plugin. */
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.preview { padding: 24px; background: var(--background-primary); color: var(--text-normal); }
.preview h2 { margin: 0 0 12px; font: 600 13px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.preview .wl-view { max-width: 1100px; }
[data-preview-icon] { display: inline-flex; width: 16px; height: 16px; border-radius: 3px; background: currentColor; opacity: .35; }
</style>
${["light", "dark"]
  .map(
    (theme) => `
<section class="preview is-${theme}" style="${THEMES[theme]}${TYPE_SCALE}">
  <h2>${theme}</h2>
  <div class="wl-view">${body}</div>
</section>`,
  )
  .join("")}
`;

  await writeFile(OUT, html, "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(`  ${titles.length} title(s), styles.css ${css.length} bytes, light + dark`);
} finally {
  restore();
  await cleanup();
}
