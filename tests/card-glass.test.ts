/**
 * The library card's caption is a scrim, not a lid.
 *
 * It used to be an opaque box pinned over the bottom half of the poster: half
 * of every piece of cover art was simply gone, and a grid of them read as a
 * grid of badly cropped thumbnails. It is a long, gentle dark gradient now,
 * with light text on it in BOTH themes — the media-grid convention, and a
 * deliberate exception to this plugin's theme-following rule, because what is
 * behind it is artwork rather than page. The version in between followed the
 * theme and was rejected on sight: in a light theme it was a white wash that
 * fogged the art as badly as the panel it replaced.
 *
 * The part that is easy to get wrong: the gradient and blur live on a
 * `::before` layer BEHIND the text rather than on the panel itself.
 * `mask-image` applies to an element *and its children*, so a mask on the panel
 * would feather the title away along with the surface under it.
 *
 * None of that is observable from the DOM stub, which has no layout engine and
 * no cascade. So this file checks the two things that actually are checkable and
 * that a future edit could plausibly break: the DOM shape the CSS is written
 * against, and the declarations in the partial itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitleCard } from "../src/ui/components/card";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { CardContext, TitleV4, WatchLogStoreApi } from "../src/types";

const STYLES = join(dirname(dirname(fileURLToPath(import.meta.url))), "styles");
const CARDS = readFileSync(join(STYLES, "20-cards.css"), "utf8");

// ---------------------------------------------------------------------------
// A minimal top-level rule reader, same shape as the one in styles.test.ts.
// ---------------------------------------------------------------------------

interface Rule {
  selector: string;
  body: string;
}

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

function ruleFor(selector: string): Rule {
  const rule = topLevelRules(CARDS).find((candidate) => candidate.selector === selector);
  expect(rule, `20-cards.css must declare \`${selector}\``).toBeDefined();
  return rule as Rule;
}

/** `background: …` / `top: …`, ignoring `background-clip` and `padding-top`. */
function declares(rule: Rule, property: string): boolean {
  return new RegExp(`(^|;|\\s)${property}\\s*:`).test(rule.body);
}

// ---------------------------------------------------------------------------
// The DOM shape the stylesheet is written against
// ---------------------------------------------------------------------------

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

function fullCard(over: Partial<TitleV4> = {}): StubEl {
  const host = createHost(900);
  const title = createTitle({ id: "t", title: "A Title", type: "Movie", ...over });
  Object.assign(title, over);
  const ctx = {
    store: { settings: createDefaultSettings(), allTitles: () => [], getTitle: () => undefined } as
      unknown as WatchLogStoreApi,
    showActions: true,
    showAiringChip: true,
    showPlexBadge: true,
    showRating: true,
    showProgress: true,
    onOpen: () => undefined,
  } as unknown as CardContext;
  buildTitleCard(host as unknown as HTMLElement, title, ctx);
  return host.querySelectorAll(".wl-card")[0] as StubEl;
}

describe("the caption is a layer over the whole poster", () => {
  it("makes the panel a sibling of the poster, never its container", () => {
    const card = fullCard();
    const poster = card.querySelector(".wl-poster") as StubEl;
    const body = card.querySelector(".wl-card-body") as StubEl;
    const wrap = card.querySelector(".wl-card-poster") as StubEl;

    expect(poster.parentElement, "the poster hangs off the poster wrap").toBe(wrap);
    expect(body.parentElement, "so does the caption — they are siblings").toBe(wrap);
    // A caption *inside* the poster would be clipped by it and would take the
    // poster's own stacking; the whole point is one layer over another.
    expect(body.querySelectorAll(".wl-poster")).toHaveLength(0);
  });

  it("paints the caption last, so the scrim is above the art", () => {
    const wrap = fullCard().querySelector(".wl-card-poster") as StubEl;
    const last = wrap.children[wrap.children.length - 1] as StubEl;
    expect(last.className.split(" ")).toContain("wl-card-body");
  });

  it("keeps the text out of the background layer", () => {
    // The title, the pills and the meta are children of the panel; the surface
    // they sit on is a pseudo-element, so nothing in the DOM carries it. If a
    // later edit ever adds a real background div here, the mask goes back on
    // top of the text and the title fades with it.
    const body = fullCard().querySelector(".wl-card-body") as StubEl;
    const rows = body.children.map((child) => child.className.split(" ")[0]);
    expect(rows.slice(0, 3)).toEqual(["wl-card-title", "wl-card-pills", "wl-card-meta"]);
  });

  it("still gives the type and the status their own coloured pills", () => {
    // The panel got denser; the pills did not get replaced by flat text. They
    // carry the user's configured colours and are the only thing on the card
    // that does.
    const card = fullCard({ type: "Movie", status: "Watching" });
    const pills = card.querySelector(".wl-card-pills") as StubEl;
    expect(pills.querySelectorAll(".wl-pill")).toHaveLength(2);
    expect(pills.querySelector(".wl-pill.is-type")).not.toBeNull();
    expect(pills.querySelector(".wl-pill.is-status")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The declarations themselves
// ---------------------------------------------------------------------------

describe("the caption is a dark scrim in both themes", () => {
  it("gives the panel no surface of its own", () => {
    const body = ruleFor(".wl-card-body");
    expect(declares(body, "background"), "an opaque panel is the bug this fixed").toBe(false);
    // Both of these belong on the background layer. On the panel, the mask
    // would eat the title and the blur would apply to text as well as art.
    expect(declares(body, "backdrop-filter")).toBe(false);
    expect(declares(body, "mask-image")).toBe(false);
  });

  it("anchors the panel to the bottom and sizes it to its content", () => {
    const body = ruleFor(".wl-card-body");
    expect(body.body).toMatch(/bottom:\s*0/);
    // `top` or `height` here is what pinned the old panel to a fixed half of
    // the card whatever the caption actually needed.
    expect(declares(body, "top"), "a top edge means a fixed-height slab").toBe(false);
    expect(declares(body, "height")).toBe(false);
  });

  it("puts the blur, the gradient and the mask on the layer behind the text", () => {
    const glass = ruleFor(".wl-card-body::before");
    expect(glass.body).toMatch(/z-index:\s*-1/);
    expect(declares(glass, "backdrop-filter")).toBe(true);
    expect(declares(glass, "-webkit-backdrop-filter"), "Electron still wants it").toBe(true);
    expect(declares(glass, "mask-image")).toBe(true);
    expect(declares(glass, "-webkit-mask-image")).toBe(true);
    // It reaches above the panel so the whole ramp happens over bare poster
    // rather than over the title.
    expect(glass.body).toMatch(/top:\s*calc\(-1 \* var\(--wl-card-scrim-fade/);
  });

  it("builds the scrim from the scrim channels and nothing else", () => {
    const glass = ruleFor(".wl-card-body::before");
    const stops = [...glass.body.matchAll(/rgb\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)];
    expect(stops.length, "the gradient is built from rgb() stops").toBeGreaterThan(2);
    for (const stop of stops) {
      expect(stop[0], "every stop reads the scrim channel").toContain("var(--wl-card-scrim");
    }
    // The reversal, asserted: this layer must NOT follow the theme. It covers
    // artwork, and artwork does not flip when the theme does — a scrim mixed
    // from `--background-primary` is a ~90% white wash over every poster in a
    // light theme, which is what the first version of this shipped and what the
    // user rejected on sight.
    expect(glass.body, "the scrim must not follow the theme").not.toContain(
      "var(--background-primary)",
    );
  });

  it("keeps the caption's text on the scrim's ink, not the theme's", () => {
    // `--text-normal` here is near-black in a light theme, on a near-black
    // scrim. This is the single most likely way for someone to "tidy up" the
    // caption and make it invisible for half the users.
    for (const selector of [".wl-card-title", ".wl-card-meta"]) {
      const rule = ruleFor(selector);
      const color = /(?:^|;|\s)color:\s*([\s\S]*?);/.exec(rule.body)?.[1] ?? "";
      expect(color, `${selector} must read the ink`).toContain("var(--wl-card-ink");
      expect(color).not.toContain("--text-normal");
      expect(color).not.toContain("--text-muted");
    }
  });

  it("keeps the user's pill colour on all three of the pill's channels", () => {
    // The pills are the only thing on a card carrying a user setting, and they
    // are the whole reason we did not adopt the reference's flat uppercase
    // text. Repainting them a uniform translucent white is the obvious way to
    // make them read on a dark scrim and it throws the setting away.
    const pill = ruleFor(".wl-card-pills .wl-pill");
    // `color` is declared twice — fallback then enhancement — so every one of
    // them has to carry the setting, not just the first.
    for (const property of ["background", "color", "box-shadow"]) {
      const values = [
        ...pill.body.matchAll(new RegExp(`(?:^|;|\\s)${property}:\\s*([\\s\\S]*?);`, "g")),
      ].map((hit) => hit[1] ?? "");
      expect(values.length, `the pill must declare ${property}`).toBeGreaterThan(0);
      for (const value of values) {
        expect(value, `the pill's ${property} must carry --wl-pill`).toContain("var(--wl-pill,");
      }
    }
    // Only the LIGHTNESS is raised, to a floor. Chroma and hue pass straight
    // through, which is what keeps a deep configured colour legible on the
    // scrim while it stays recognisably the colour the user chose.
    expect(pill.body).toMatch(/oklch\(from var\(--wl-pill[\s\S]*?max\(l,\s*0?\.\d+\)\s*c\s*h\)/);
    // An inset shadow, never a border: a border adds 2px to the pill and breaks
    // the reserved row height that keeps every card's crop line shared.
    expect(pill.body).toMatch(/box-shadow:\s*inset/);
    expect(declares(pill, "border"), "a border would resize the pill").toBe(false);
  });

  it("never leaves a relative-colour declaration without a fallback under it", () => {
    // `oklch(from …)` needs Chromium 119+. On an older build the declaration is
    // dropped, and whatever was declared before it stands — so there must BE
    // something before it. Without one the pill falls back to the base
    // `.wl-pill` rule, which paints the raw user colour on the scrim: exactly
    // the invisible deep-navy case the floor exists to prevent.
    for (const rule of topLevelRules(CARDS)) {
      const lines = rule.body.split(";").map((line) => line.trim());
      lines.forEach((line, index) => {
        const property = /^([a-z-]+):/.exec(line)?.[1];
        if (!property || !line.includes("oklch(from")) return;
        const earlier = lines
          .slice(0, index)
          .some((candidate) => candidate.startsWith(`${property}:`));
        expect(earlier, `${rule.selector} needs a fallback \`${property}\` before its oklch()`).toBe(
          true,
        );
      });
    }
  });

  it("gives everything else on the scrim a colour that reads on dark", () => {
    // Each of these is a theme colour by default and each of them sits on the
    // scrim, so each needs either the ink or a lift towards it.
    const onScrim = [
      ".wl-card-body .wl-star-bg",
      ".wl-card-body .wl-star-fill",
      ".wl-card-body .wl-progress",
      ".wl-card-body .wl-progress-fill",
      ".wl-card-body .wl-airing-chip",
    ];
    for (const selector of onScrim) {
      const rule = ruleFor(selector);
      expect(
        /var\(--wl-card-(ink|scrim)/.test(rule.body),
        `${selector} sits on the scrim and must be coloured for it`,
      ).toBe(true);
    }
  });
});

/**
 * The card's accessibility and responsive handling is the one place this plugin
 * is strictly ahead of the plugin the scrim technique came from, and a restyle
 * is exactly the kind of edit that quietly drops it. These are here so a
 * stylesheet rewrite has to delete a passing test rather than a `@media` block
 * nobody remembered was load-bearing.
 */
describe("the scrim does not cost the card its touch and motion handling", () => {
  it("still reveals the actions on hover and pins them open on touch", () => {
    expect(CARDS).toMatch(/@media \(hover: hover\)/);
    expect(CARDS).toMatch(/@media \(hover: none\)/);
    const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(CARDS)?.[1] ?? "";
    expect(touch, "no hover to reveal with, so they stay visible").toMatch(
      /\.wl-card-actions \{[\s\S]*?opacity:\s*1/,
    );
    // 26px is the mouse size; fingers get 32px. Losing this is losing the touch
    // target, not just some padding.
    expect(touch).toMatch(/\.wl-card-action \{[\s\S]*?width:\s*32px[\s\S]*?height:\s*32px/);
  });

  it("keeps the always-visible action column above the panel and tappable", () => {
    // The two halves of one fix. On touch the column can be five 32px buttons
    // tall, which reaches into the panel's feathered overhang on a normal
    // library card: under the scrim those buttons are dimmed, and behind a
    // pointer-eating panel they are untappable.
    const actions = ruleFor(".wl-card-actions");
    expect(actions.body).toMatch(/z-index:\s*var\(--wl-card-z-chrome/);
    const body = ruleFor(".wl-card-body");
    expect(body.body).toMatch(/z-index:\s*var\(--wl-card-z-scrim/);
    expect(body.body).toMatch(/pointer-events:\s*none/);

    const card = ruleFor(".wl-card");
    const glass = Number(/--wl-card-z-scrim:\s*(-?\d+)/.exec(card.body)?.[1]);
    const chrome = Number(/--wl-card-z-chrome:\s*(-?\d+)/.exec(card.body)?.[1]);
    expect(chrome, "chrome must outrank glass").toBeGreaterThan(glass);
  });

  it("adds no motion of its own for reduced-motion to have to undo", () => {
    // `backdrop-filter` is a paint effect, not an animation, so the panel needs
    // no reduced-motion escape hatch — as long as it never grows a transition
    // or a transform. If one is ever added it has to be declared where the
    // global `.wl-view *, .wl-view *::before` rule in 10-base.css can reach it.
    for (const selector of [".wl-card-body", ".wl-card-body::before", ".wl-card-body .wl-progress"]) {
      const rule = ruleFor(selector);
      expect(declares(rule, "transition"), `${selector} must not animate`).toBe(false);
      expect(declares(rule, "transform"), `${selector} must not transform`).toBe(false);
      expect(declares(rule, "animation")).toBe(false);
    }
  });

  it("uses only font sizes Obsidian actually ships", () => {
    // There is no `--font-ui-larger`; a declaration naming it is invalid and
    // silently dropped, which is a font size that simply never applies.
    expect(CARDS).not.toContain("--font-ui-larger");
  });
});

describe("no stylesheet hardcodes a colour", () => {
  it("has not a single hex literal in any partial", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort()) {
      const css = readFileSync(join(STYLES, file), "utf8");
      for (const hit of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) offenders.push(`${file}: ${hit[0]}`);
    }
    expect(offenders, "every colour comes from a variable (SPEC §6)").toEqual([]);
  });

  it("only ever writes rgb() around a variable, never around channels", () => {
    // `rgb(var(--wl-card-scrim) / 0.5)` is the scrim reading its documented
    // channels. `rgb(10 10 14 / 0.5)` is someone inlining the number, which is
    // how one exemption becomes a hundred literals nobody can re-tune.
    const offenders: string[] = [];
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort()) {
      const css = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const hit of css.matchAll(/\b(?:rgba?|hsla?)\(\s*(.)/g)) {
        if (hit[1] !== "v") offenders.push(`${file}: ${hit[0]}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines the two scrim channels exactly once, in the base layer", () => {
    // The one sanctioned pair of literal colour values in the plugin. They are
    // exempt because they describe an overlay on an image rather than a surface
    // of the app — and an exemption that is not pinned to one definition site
    // is not an exemption, it is a leak.
    const defined = new Map<string, string[]>();
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css")).sort()) {
      const css = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const hit of css.matchAll(/(--wl-scrim(?:-ink)?-rgb)\s*:/g)) {
        defined.set(hit[1] as string, [...(defined.get(hit[1] as string) ?? []), file]);
      }
    }
    expect([...defined.keys()].sort()).toEqual(["--wl-scrim-ink-rgb", "--wl-scrim-rgb"]);
    for (const [token, files] of defined) {
      expect(files, `${token} must be declared once, in 10-base.css`).toEqual(["10-base.css"]);
    }
  });
});
