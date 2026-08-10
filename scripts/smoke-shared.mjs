/**
 * The bits every headless tab smoke run needs (W8-integration).
 *
 * Extracted from `smoke-dashboard.mjs` when Reading and Games got their own
 * runs: three scripts asking the same four questions — did anything throw, did
 * anything render blank, did a number reach the DOM as `NaN`, and is any class
 * declared by two partials — should ask them with one implementation.
 *
 * Everything here is read-only and offline; the callers add their own data.
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

/**
 * An `obsidian` module for Node.
 *
 * Deliberately inert: `requestUrl` throws, because a smoke run that quietly
 * reaches the network is a smoke run that fails differently on a plane.
 */
export const OBSIDIAN_SHIM = `
export function setIcon(el) { if (el && el.addClass) el.addClass("svg-icon-host"); }
export class Notice { constructor(message) { this.message = message; } }
export class Menu {
  addItem(cb) { if (cb) cb({ setTitle: () => this, setIcon: () => this, setWarning: () => this, onClick: () => this }); return this; }
  addSeparator() { return this; }
  showAtMouseEvent() {}
  showAtPosition() {}
}
export class Plugin {}
export class Modal { constructor(app) { this.app = app; } open() {} close() {} }
export class ItemView {}
export class MarkdownRenderChild {}
export class SuggestModal {}
export class FuzzySuggestModal {}
export class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
  addSlider() { return this; }
}
export class PluginSettingTab {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export const Platform = { isMobile: false };
export function normalizePath(p) { return p; }
export function debounce(fn) { return fn; }
export async function requestUrl() {
  throw new Error("smoke runs are offline; nothing here may call the network");
}
`;

/** Bundle an entry that re-exports whatever a caller wants to drive. */
export async function loadHarness(root, exports) {
  const dir = await mkdtemp(join(tmpdir(), "watchlog-smoke-"));
  const shimPath = join(dir, "obsidian-shim.mjs");
  const entryPath = join(dir, "entry.ts");
  const outPath = join(dir, "bundle.mjs");

  await writeFile(shimPath, OBSIDIAN_SHIM, "utf8");
  await writeFile(entryPath, exports, "utf8");

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
// The four questions
// ---------------------------------------------------------------------------

/** Sections whose error wrapper caught a throw. */
export function reportCaughtErrors(root, log) {
  log("A. Sections whose error wrapper caught a throw");
  const broken = root.flatten().filter((el) => el.classes.has("is-broken"));
  if (broken.length === 0) {
    log("   none");
    return 0;
  }
  for (const el of broken) {
    log(`   ✗ ${el.querySelector(".wl-error-panel-head")?.textContent ?? "?"}`);
    log(`       ${el.querySelector(".wl-error-panel-body")?.textContent ?? "(no message)"}`);
  }
  return broken.length;
}

/** Text and attributes that leaked a non-number. */
export function reportBadNumbers(root, log) {
  log("C. Numbers that reached the DOM badly");
  const bad = [];
  for (const el of root.flatten()) {
    if (el.ownText && /\b(NaN|Infinity|-Infinity|undefined)\b/.test(el.ownText)) {
      bad.push(`${[...el.classes].join(".") || el.tag}: “${el.ownText}”`);
    }
    for (const [key, value] of el.attrs) {
      if (/NaN|Infinity|undefined/.test(value)) bad.push(`${el.tag}[${key}]="${value}"`);
    }
    for (const key of ["--wl-bar-pct", "--wl-col-pct", "--wl-progress", "width"]) {
      const value = el.style.getPropertyValue(key);
      if (value && /NaN|Infinity|undefined/.test(value)) bad.push(`${el.tag} ${key}: ${value}`);
    }
  }
  if (bad.length === 0) log("   none");
  else for (const entry of bad) log(`   ✗ ${entry}`);
  return bad.length;
}

// ---------------------------------------------------------------------------
// The stylesheet audit
// ---------------------------------------------------------------------------

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

/** Rules at brace depth 0; `@media` bodies adjust a component declared elsewhere. */
export function topLevelRules(css) {
  const out = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = css.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!selector.startsWith("@")) out.push({ selector, body: css.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return out;
}

/**
 * Bare single-class selectors declared by more than one partial.
 *
 * The check that caught QA4: `.wl-card` meant "poster card" in one partial and
 * "dashboard panel" in another, so a 2:3 aspect-ratio meant for posters applied
 * to every panel on the tab. It flags **any** duplicate, not only ones where
 * both sides look dangerous — the dashboard's copy set nothing but padding, and
 * all the damage came from the other definition.
 */
export function auditStyles(root) {
  const dir = join(root, "styles");
  const byClass = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css")).sort()) {
    const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { selector, body } of topLevelRules(css)) {
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
    collisions.push({ cls, files: [...files], props: [...new Set(entries.flatMap((e) => e.props))] });
  }
  return collisions;
}

export function reportStyleCollisions(root, log) {
  log("D. Layout audit — one class defined by two partials");
  const collisions = auditStyles(root);
  const partials = readdirSync(join(root, "styles")).filter((f) => f.endsWith(".css")).length;
  if (collisions.length === 0) {
    log(`   no class is declared by two partials (${partials} checked)`);
    return 0;
  }
  for (const c of collisions) {
    log(
      `   ✗ .${c.cls} declared by ${c.files.join(" AND ")}${c.props.length ? ` — geometry: ${c.props.join(", ")}` : ""}`,
    );
  }
  return collisions.length;
}

/** Resolve the declarations that apply to a class set, in bundle order. */
export function buildCascade(root) {
  const dir = join(root, "styles");
  const rules = [];
  let order = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css")).sort()) {
    const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const { selector, body } of topLevelRules(css)) {
      for (const part of selector.split(",")) {
        const trimmed = part.trim();
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

export function ratioOf(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(value ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = m[2] === undefined ? 1 : Number(m[2]);
  return h === 0 ? null : w / h;
}

/**
 * Every named container's resolved box.
 *
 * A content panel is as tall as what is in it: **any** fixed aspect-ratio here is
 * wrong, because that is a poster's property and inheriting one is what turned
 * the dashboard into a stack of screen-tall empty rectangles.
 */
export function reportBoxes(root, containers, log, viewport = 900) {
  log("E. Resolved box of every panel, from the real stylesheet");
  const resolve = buildCascade(root);
  let failures = 0;
  for (const { name, el } of containers) {
    const style = resolve(el.classes);
    const ratio = ratioOf(style["aspect-ratio"]?.value);
    const overflow = style["overflow"]?.value ?? "visible";
    const bad = ratio !== null;
    if (bad) failures += 1;
    log(
      `   ${bad ? "✗" : "✓"} ${name} — ${
        ratio
          ? `aspect-ratio ${style["aspect-ratio"].value} from ${style["aspect-ratio"].file} → ${Math.round(viewport / ratio)}px tall at ${viewport}px wide, overflow: ${overflow}`
          : `content-sized, overflow: ${overflow}`
      }`,
    );
  }
  return failures;
}
