/**
 * Render the real poster cards to a real browser, so a layout question can be
 * answered by looking rather than by guessing.
 *
 *   node scripts/preview-cards.mjs [--data /path/to/data.json] [--out /tmp/x.html]
 *
 * Nothing in this repo has a layout engine — that is stated in three places and
 * it is why `styles.test.ts` can only assert rules, never boxes. This closes
 * that gap the cheap way: it emits ONE self-contained HTML file carrying the
 * built `styles.css` verbatim, the card markup `components/card.ts` produces,
 * and the real vault's titles and poster URLs, in both themes side by side.
 * Open it in any browser and the cards are the cards.
 *
 * It is a **preview**, not a test: it proves what a stylesheet does, not that a
 * change is correct. Read it with your eyes.
 *
 * SAFETY: the vault file is read once and never written. No network calls of
 * its own — the browser fetches the poster images, exactly as Obsidian does.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}

const DATA_PATH = flag(
  "data",
  process.env.WATCHLOG_DATA ??
    "/Users/iwanhoogendoorn/Documents/IWAN-REMOTE-VAULT/.obsidian/plugins/watchlog-v4/data.json",
);
const OUT = flag("out", join(tmpdir(), "watchlog-cards.html"));

const escape = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** `progressText` + `getProgress`, the two numbers `metaLine` joins. */
function progress(title) {
  const total = Math.max(0, title.totalEpisodes ?? 0);
  const watched = (title.watchedEpisodes ?? []).length;
  if (total <= 1) return { text: "", percent: 0, hasBar: false };
  return {
    text: `${watched} / ${total}`,
    percent: Math.min(100, Math.round((watched / total) * 100)),
    hasBar: true,
  };
}

function metaLine(title) {
  const parts = [];
  const year = title.year ?? (Number((title.releaseDate ?? "").slice(0, 4)) || null);
  if (year) parts.push(String(year));
  // The pill row already says the type — `metaLine` deliberately does not.
  const p = progress(title);
  if (p.text) parts.push(`${p.text} · ${p.percent}%`);
  return parts.join(" · ");
}

function colorOf(list, name) {
  return (list ?? []).find((entry) => entry.name === name)?.color ?? "";
}

/** The markup `buildFullCard` produces, by hand and in the same order. */
function card(title, settings) {
  const p = progress(title);
  const pills = [
    title.type
      ? `<span class="wl-pill is-type" style="--wl-pill:${escape(colorOf(settings.types, title.type))}"><span class="wl-pill-text">${escape(title.type)}</span></span>`
      : "",
    title.status
      ? `<span class="wl-pill is-status" style="--wl-pill:${escape(colorOf(settings.statuses, title.status))}"><span class="wl-pill-text">${escape(title.status)}</span></span>`
      : "",
  ].join("");

  const meta = metaLine(title);
  // `renderSeasonChips` + `renderAiringChip`: the only rows some cards have and
  // others do not, which is exactly why they are worth previewing.
  const chips = [];
  const next = title.airing?.nextEpisode;
  if (next) {
    const code = `S${String(next.season).padStart(2, "0")}E${String(next.episode).padStart(2, "0")}`;
    chips.push(`<span class="wl-airing-chip is-next-up"><span class="wl-airing-chip-text">${escape(code)} next</span></span>`);
    chips.push(`<span class="wl-airing-chip"><span class="wl-airing-chip-text">${escape(code)} · soon</span></span>`);
  }
  const poster = title.posterUrl
    ? `<div class="wl-poster"><img class="wl-poster-img is-loaded" src="${escape(title.posterUrl)}" alt=""></div>`
    : `<div class="wl-poster is-placeholder" style="--wl-tint:14%"><span class="wl-poster-initial">${escape((title.title ?? "?")[0])}</span></div>`;

  return `
<div class="wl-card is-clickable" data-title-id="${escape(title.id)}">
  <div class="wl-card-poster">
    ${poster}
    <div class="wl-card-scrim"></div>
    <div class="wl-card-body">
      <div class="wl-card-title">${escape(title.title)}</div>
      ${pills ? `<div class="wl-card-pills">${pills}</div>` : ""}
      ${meta ? `<div class="wl-card-meta">${escape(meta)}</div>` : ""}
      ${chips.length ? `<div class="wl-card-airing">${chips.join("")}</div>` : ""}
      ${
        p.hasBar
          ? `<div class="wl-progress" role="progressbar"><div class="wl-progress-fill" style="width:${p.percent}%"></div></div>`
          : ""
      }
    </div>
  </div>
</div>`;
}

/**
 * Obsidian's own variables, at the values its default themes ship.
 *
 * The stylesheet under test uses nothing else — that is the theming policy in
 * `10-base.css` — so defining them here is enough to render it faithfully.
 */
const TYPE_SCALE = `
    --font-ui-smaller: 12px;
    --font-ui-small: 13px;
    --font-ui-medium: 15px;
    --font-ui-large: 20px;
    --font-semibold: 600;
    --font-medium: 500;
    --font-bold: 700;
    font-size: 16px;
`;

const THEMES = {
  light: `
    --background-primary: #ffffff;
    --background-primary-alt: #f5f6f8;
    --background-secondary: #f2f3f5;
    --background-modifier-border: #e0e0e0;
    --background-modifier-box-shadow: rgba(0, 0, 0, 0.1);
    --background-modifier-error-hover: #e68787;
    --text-normal: #222222;
    --text-muted: #5c5c5c;
    --text-faint: #999999;
    --text-error: #b34747;
    --text-on-accent: #ffffff;
    --interactive-accent: #5b7cfa;
  `,
  dark: `
    --background-primary: #1e1e1e;
    --background-primary-alt: #161616;
    --background-secondary: #252525;
    --background-modifier-border: #333333;
    --background-modifier-box-shadow: rgba(0, 0, 0, 0.3);
    --background-modifier-error-hover: #932525;
    --text-normal: #dadada;
    --text-muted: #b3b3b3;
    --text-faint: #666666;
    --text-error: #ff6b6b;
    --text-on-accent: #ffffff;
    --interactive-accent: #7f6df2;
  `,
};

const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
const titles = raw.titles ?? [];
const settings = raw.settings ?? {};
const css = await readFile(join(root, "build/styles.css"), "utf8");

const grid = (theme) => `
<section class="preview is-${theme}" style="${THEMES[theme]}${TYPE_SCALE}">
  <h2>${theme}</h2>
  <div class="wl-view">
    <div class="preview-grid">${titles.map((title) => card(title, settings)).join("")}</div>
  </div>
</section>`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>Watch, Read and Learn cards — ${titles.length} title(s) from the real vault</title>
<style>
${css}

/* Harness only. Nothing below is part of the plugin. */
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.preview { padding: 24px; background: var(--background-primary); color: var(--text-normal); }
.preview h2 { margin: 0 0 12px; font: 600 13px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); }
.preview-grid { display: grid; grid-template-columns: repeat(${Math.min(6, Math.max(2, titles.length))}, var(--card-width, 160px)); gap: 12px; }
.preview.is-small { --card-width: 120px; }
.preview.is-large { --card-width: 215px; }
/* The cards' own aspect-ratio sizes the cells, as in the virtual grid. */
</style>
${grid("light")}
${grid("dark")}
`;

await writeFile(OUT, html, "utf8");
console.log(`Wrote ${OUT}`);
console.log(`  ${titles.length} card(s), styles.css ${css.length} bytes, light + dark`);
