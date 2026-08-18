/**
 * Light ↔ dark.
 *
 * Two things are being held here. The first is that the toggle uses Obsidian's
 * own theme through a supported route and degrades down a ladder instead of
 * crashing when a route is missing — the API this needs is not in the published
 * typings, so every rung is a real branch.
 *
 * The second is the one that would be expensive to get wrong: the card caption
 * scrim (`--wl-scrim-rgb`) is deliberately DARK IN BOTH THEMES, because it sits
 * over poster artwork rather than over the page. A theme toggle is exactly the
 * change that would "fix" that into a light-theme white wash, so the last block
 * of this file proves the scrim is defined once, unconditionally, and that
 * nothing in the theme code goes near it.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StubEl } from "./helpers/dom";
import {
  THEME_COMMAND_DARK,
  THEME_COMMAND_LIGHT,
  THEME_CONFIG_DARK,
  THEME_CONFIG_KEY,
  THEME_CONFIG_LIGHT,
  THEME_TOGGLE_COMMAND_ID,
  applyTheme,
  createThemeToggle,
  currentTheme,
  themeFromBody,
  themeIcon,
  themeToggleCommand,
  themeToggleLabel,
  toggleTheme,
  type AppTheme,
  type ThemeCapableApp,
} from "../src/ui/theme";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STYLES = join(ROOT, "styles");

/** An app that stores a theme the way Obsidian does, and records the fallout. */
function fakeApp(stored: unknown = THEME_CONFIG_DARK): ThemeCapableApp & {
  config: Record<string, unknown>;
  triggered: string[];
  executed: string[];
  cssChange: (() => void)[];
  offrefs: unknown[];
} {
  const config: Record<string, unknown> = { [THEME_CONFIG_KEY]: stored };
  const triggered: string[] = [];
  const executed: string[] = [];
  const cssChange: (() => void)[] = [];
  const offrefs: unknown[] = [];
  return {
    config,
    triggered,
    executed,
    cssChange,
    offrefs,
    vault: {
      getConfig: (key: string) => config[key],
      setConfig: (key: string, value: unknown) => {
        config[key] = value;
      },
    },
    workspace: {
      trigger: (name: string) => triggered.push(name),
      on: (name: string, callback: () => void) => {
        if (name === "css-change") cssChange.push(callback);
        return { name };
      },
      offref: (ref: unknown) => offrefs.push(ref),
    },
    commands: {
      executeCommandById: (id: string) => {
        executed.push(id);
        return true;
      },
    },
  };
}

function bodyDoc(className: string): { body: { className: string } } {
  return { body: { className } };
}

describe("reading the current theme", () => {
  it("reads Obsidian's own stored value", () => {
    expect(currentTheme(fakeApp(THEME_CONFIG_DARK), bodyDoc(""))).toBe("dark");
    expect(currentTheme(fakeApp(THEME_CONFIG_LIGHT), bodyDoc(""))).toBe("light");
  });

  it("falls through to the rendered body class on “system”", () => {
    // "system" is a rule, not a state: only what the app painted says which way
    // it resolved right now.
    expect(currentTheme(fakeApp("system"), bodyDoc("mod-macos theme-light"))).toBe("light");
    expect(currentTheme(fakeApp("system"), bodyDoc("mod-macos theme-dark"))).toBe("dark");
  });

  it("reads the body class on its own", () => {
    expect(themeFromBody(bodyDoc("theme-dark is-focused"))).toBe("dark");
    expect(themeFromBody(bodyDoc("theme-light"))).toBe("light");
    expect(themeFromBody(bodyDoc("no-theme-here"))).toBeNull();
    expect(themeFromBody(null)).toBeNull();
    expect(themeFromBody({ body: null })).toBeNull();
  });

  it("does not throw when there is no app and no document to ask", () => {
    expect(currentTheme(undefined, null)).toBe("dark");
    expect(currentTheme({}, null)).toBe("dark");
  });
});

describe("applying a theme", () => {
  it("writes Obsidian's config and repaints, the way the settings pane does", () => {
    const app = fakeApp(THEME_CONFIG_DARK);
    expect(applyTheme(app, "light")).toBe(true);
    expect(app.config[THEME_CONFIG_KEY]).toBe(THEME_CONFIG_LIGHT);
    // Without `css-change` the config is right and the screen is not.
    expect(app.triggered).toEqual(["css-change"]);
  });

  it("falls back to the core command when setConfig is unavailable", () => {
    const app = fakeApp();
    delete app.vault?.setConfig;
    expect(applyTheme(app, "light")).toBe(true);
    expect(app.executed).toEqual([THEME_COMMAND_LIGHT]);
    expect(applyTheme(app, "dark")).toBe(true);
    expect(app.executed).toEqual([THEME_COMMAND_LIGHT, THEME_COMMAND_DARK]);
  });

  it("reports failure rather than pretending when neither route exists", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(applyTheme({ vault: {}, commands: {} }, "light")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flips, and reports the theme now in force", () => {
    const app = fakeApp(THEME_CONFIG_DARK);
    expect(toggleTheme(app, bodyDoc(""))).toBe("light");
    expect(app.config[THEME_CONFIG_KEY]).toBe(THEME_CONFIG_LIGHT);
    expect(toggleTheme(app, bodyDoc(""))).toBe("dark");
    expect(app.config[THEME_CONFIG_KEY]).toBe(THEME_CONFIG_DARK);
  });

  it("leaves the reported theme alone when nothing could be changed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(toggleTheme({ vault: {}, commands: {} }, bodyDoc("theme-light"))).toBe("light");
    warn.mockRestore();
  });
});

describe("the toolbar button", () => {
  function mount(stored: unknown = THEME_CONFIG_DARK): {
    parent: StubEl;
    app: ReturnType<typeof fakeApp>;
    icons: string[];
    changes: AppTheme[];
    controller: ReturnType<typeof createThemeToggle>;
  } {
    const parent = new StubEl("div");
    const app = fakeApp(stored);
    const icons: string[] = [];
    const changes: AppTheme[] = [];
    const controller = createThemeToggle(
      parent as unknown as HTMLElement,
      { app, doc: bodyDoc(""), onChange: (theme) => changes.push(theme) },
      (el, icon) => {
        icons.push(icon);
        (el as unknown as StubEl).createSpan({ cls: `icon-${icon}` });
      },
    );
    return { parent, app, icons, changes, controller };
  }

  it("shows which mode is active, in the icon and in its name", () => {
    const dark = mount(THEME_CONFIG_DARK);
    const el = dark.controller.el as unknown as StubEl;
    expect(el.dataset.theme).toBe("dark");
    expect(el.hasClass("is-dark")).toBe(true);
    expect(dark.icons).toEqual(["moon"]);
    expect(el.getAttribute("aria-label")).toBe("Switch to the light theme");
    expect(el.getAttribute("title")).toBe("Switch to the light theme");

    const light = mount(THEME_CONFIG_LIGHT);
    const lightEl = light.controller.el as unknown as StubEl;
    expect(lightEl.dataset.theme).toBe("light");
    expect(lightEl.hasClass("is-light")).toBe(true);
    expect(light.icons).toEqual(["sun"]);
    expect(lightEl.getAttribute("aria-label")).toBe("Switch to the dark theme");
  });

  it("flips the app on click and repaints itself", () => {
    const { app, controller, icons, changes } = mount(THEME_CONFIG_DARK);
    const el = controller.el as unknown as StubEl;

    el.fire("click");

    expect(app.config[THEME_CONFIG_KEY]).toBe(THEME_CONFIG_LIGHT);
    expect(el.dataset.theme).toBe("light");
    expect(el.getAttribute("aria-label")).toBe("Switch to the dark theme");
    expect(changes).toEqual(["light"]);
    // One icon per repaint, and never two icons in the button at once.
    expect(icons).toEqual(["moon", "sun"]);
    expect(el.querySelectorAll(".icon-sun")).toHaveLength(1);
    expect(el.querySelectorAll(".icon-moon")).toHaveLength(0);
  });

  it("follows a theme changed somewhere else", () => {
    const { app, controller } = mount(THEME_CONFIG_DARK);
    const el = controller.el as unknown as StubEl;

    // The settings pane, the core command, or the OS while on "system".
    app.config[THEME_CONFIG_KEY] = THEME_CONFIG_LIGHT;
    for (const callback of app.cssChange) callback();

    expect(el.dataset.theme).toBe("light");
  });

  it("releases its subscription and itself on destroy", () => {
    const { app, controller, parent } = mount();
    expect(parent.children).toHaveLength(1);
    controller.destroy();
    expect(app.offrefs).toHaveLength(1);
    expect(parent.children).toHaveLength(0);
  });

  it("labels and ices consistently with the command", () => {
    expect(themeToggleLabel("dark")).toBe("Switch to the light theme");
    expect(themeToggleLabel("light")).toBe("Switch to the dark theme");
    expect(themeIcon("dark")).toBe("moon");
    expect(themeIcon("light")).toBe("sun");
  });
});

describe("the command-palette entry", () => {
  it("flips the same theme the button does", () => {
    const app = fakeApp(THEME_CONFIG_DARK);
    const command = themeToggleCommand(app);
    expect(command.id).toBe(THEME_TOGGLE_COMMAND_ID);
    expect(command.name).toBe("Toggle light / dark theme");

    command.callback();
    expect(app.config[THEME_CONFIG_KEY]).toBe(THEME_CONFIG_LIGHT);
  });
});

// ---------------------------------------------------------------------------
// The scrim must not follow the theme
// ---------------------------------------------------------------------------

describe("the poster scrim is theme-independent", () => {
  const cssFiles = readdirSync(STYLES).filter((file) => file.endsWith(".css"));

  /** Comments explain the rule; only the code can break it. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("declares the scrim tokens exactly once, in the base layer", () => {
    const hits = cssFiles.flatMap((file) => {
      const matches = readFileSync(join(STYLES, file), "utf8").match(/--wl-scrim-rgb\s*:/g) ?? [];
      return matches.map(() => file);
    });
    expect(hits).toEqual(["10-base.css"]);
  });

  it("declares them unconditionally — no media query, no theme selector", () => {
    const css = stripComments(readFileSync(join(STYLES, "10-base.css"), "utf8"));
    const index = css.indexOf("--wl-scrim-rgb:");
    expect(index).toBeGreaterThan(-1);

    // Walk the braces before the declaration: exactly one block may be open
    // (`.wl-view`), and no `@media` / `.theme-*` / `[data-theme]` block may be.
    const before = css.slice(0, index);
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(1);

    const openSelector = before.slice(before.lastIndexOf("}") + 1).split("{")[0]?.trim() ?? "";
    expect(openSelector).toBe(".wl-view");
  });

  it("keeps every theme-conditional rule away from the scrim", () => {
    for (const file of cssFiles) {
      const css = readFileSync(join(STYLES, file), "utf8");
      // Nothing may re-derive the scrim from the app's theme, in any partial.
      expect(css).not.toMatch(/prefers-color-scheme[\s\S]{0,400}--wl-scrim/);
      expect(css).not.toMatch(/\.theme-(dark|light)[\s\S]{0,400}--wl-scrim/);
      expect(css).not.toMatch(/\[data-theme[\s\S]{0,400}--wl-scrim/);
    }
  });

  it("has no theme code anywhere near it", () => {
    const theme = stripComments(readFileSync(join(ROOT, "src", "ui", "theme.ts"), "utf8"));
    expect(theme).not.toContain("scrim");
    // Nor any other style property: the toggle changes Obsidian's theme and
    // touches no CSS variable of ours.
    expect(theme).not.toContain("setProperty");
    expect(theme).not.toContain("--wl-");
  });
});
