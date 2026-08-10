/**
 * Stylesheet invariants (QA4).
 *
 * The dashboard broke because `.wl-card` named two different components in two
 * different partials: the poster card in `20-cards.css` and the dashboard panel
 * in `50-dashboard.css`. Nothing failed — the bundle simply concatenated them,
 * later declarations won per property, and every panel silently inherited the
 * poster's `aspect-ratio: 2 / 3` and `overflow: hidden` the day those were added
 * for QA1 B1. Six screen-tall empty rectangles, and the user saw a hero card
 * followed by a void.
 *
 * One class means one component. That is now a test rather than a convention.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = join(dirname(dirname(fileURLToPath(import.meta.url))), "styles");

interface Rule {
  selector: string;
  body: string;
}

/**
 * Top-level rules only.
 *
 * A class re-declared inside `@media` is the same component being adjusted for a
 * viewport, not a second component wearing its name.
 */
function topLevelRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = stripped.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        if (!selector.startsWith("@")) out.push({ selector, body: stripped.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return out;
}

/** Bare single-class selectors (`.wl-card`), per partial. */
function bareClassesByFile(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort()) {
    const classes = new Set<string>();
    for (const rule of topLevelRules(readFileSync(join(STYLES, file), "utf8"))) {
      for (const part of rule.selector.split(",")) {
        const bare = /^\.([a-z0-9-]+)$/i.exec(part.trim());
        if (bare?.[1]) classes.add(bare[1]);
      }
    }
    out.set(file, classes);
  }
  return out;
}

describe("stylesheet partials", () => {
  it("never declares the same bare class in two partials", () => {
    const byFile = bareClassesByFile();
    const owners = new Map<string, string[]>();
    for (const [file, classes] of byFile) {
      for (const cls of classes) {
        owners.set(cls, [...(owners.get(cls) ?? []), file]);
      }
    }

    const collisions = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([cls, files]) => `.${cls} — ${files.join(" and ")}`);

    // A qualified selector (`.wl-btn.wl-icon-btn`) is an intentional variant and
    // is deliberately not counted; only bare names, which claim the component.
    expect(collisions, "one class must mean one component").toEqual([]);
  });

  it("reserves the progress strip on every poster card, drawn or not", () => {
    // The card body is bottom-anchored, so every optional row it *omits* moves
    // the text that is left. The progress bar is the only one below the text,
    // and a film never has one — which put a film's last line 7px lower than a
    // show's in the same row of the grid. The strip is reserved instead, and
    // the bar is positioned into it.
    const css = readFileSync(join(STYLES, "20-cards.css"), "utf8");
    const rules = topLevelRules(css);

    const body = rules.find((rule) => rule.selector === ".wl-card-body");
    expect(body, ".wl-card-body must exist").toBeDefined();
    expect(body?.body).toMatch(/padding-bottom:\s*calc\(.*3px\)/);

    const bar = rules.find((rule) => rule.selector === ".wl-card-body .wl-progress");
    expect(bar, "the bar must be drawn into the reserved strip").toBeDefined();
    expect(bar?.body).toMatch(/position:\s*absolute/);
  });

  it("gives a fixed aspect-ratio only to boxes that hold media", () => {
    // `aspect-ratio` on a *text* panel is what turned the dashboard into a stack
    // of screen-tall empty rectangles. Every box that legitimately has one holds
    // a poster or a video, and the list is explicit: adding a ratio to anything
    // else has to be a deliberate edit here, not an accident of the cascade.
    const MEDIA_BOXES = [
      ".wl-card", // the poster card itself
      ".wl-card-row-poster",
      ".wl-card-mini-poster",
      ".wl-vgrid-cell",
      ".wl-thumb",
      ".wl-fallback-poster",
      ".wl-add-result-poster",
      ".wl-detail-poster",
      ".wl-surprise-poster", // the "Surprise me" roll's poster
      ".wl-widget-domain-cover", // reading/games rows in a code block
      ".wl-trailer-slot:not(:empty)", // 16/9 video embed
    ];

    const owners: string[] = [];
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
      for (const rule of topLevelRules(readFileSync(join(STYLES, file), "utf8"))) {
        if (!/(^|;|\s)aspect-ratio\s*:/.test(rule.body)) continue;
        for (const part of rule.selector.split(",")) owners.push(part.trim());
      }
    }

    expect(owners.length).toBeGreaterThan(0);
    expect(owners.filter((selector) => !MEDIA_BOXES.includes(selector))).toEqual([]);
  });
});
