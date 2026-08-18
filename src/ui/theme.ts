/**
 * Light ↔ dark, from inside the plugin — using Obsidian's own theme, never one
 * of our own.
 *
 * The temptation here is a plugin-local "dark mode" that paints our surfaces and
 * leaves the rest of the app alone. That is always wrong: the user would end up
 * with a dark plugin inside a light Obsidian, our `var(--text-normal)` would
 * still be the app's light-theme colour, and every other plugin on screen would
 * disagree with us. There is exactly one theme, the app owns it, and this module
 * only flips it.
 *
 * HOW THE APP EXPOSES IT
 * ----------------------
 * Obsidian stores the choice in `app.vault.getConfig("theme")`, whose values are
 * `"obsidian"` (dark), `"moonstone"` (light) and `"system"` (follow the OS). It
 * renders the result as a `theme-dark` / `theme-light` class on `document.body`.
 * Neither is in the published `obsidian.d.ts`, so both are reached structurally
 * and every one of them is optional: a build that drops `setConfig` falls back
 * to executing the core command (`theme:use-dark` / `theme:use-light`), which is
 * the same thing the settings pane does, and a build that has neither simply
 * reports failure rather than pretending.
 *
 * Reading follows the same ladder — the stored value first, and the body class
 * when the stored value is `"system"`, because "system" is a rule, not a state:
 * only the class says which way it resolved *right now*.
 *
 * WHAT THIS MUST NOT TOUCH
 * ------------------------
 * `--wl-scrim-rgb` / `--wl-scrim-ink-rgb` in `styles/10-base.css`. Those are
 * deliberately dark in **both** themes because they sit over poster artwork
 * rather than over the page (see the comment there). Nothing in this file reads,
 * writes or overrides them, and `tests/theme-toggle.test.ts` holds that line.
 */

/** The two states a user can be in. `system` resolves into one of them. */
export type AppTheme = "dark" | "light";

/** Obsidian's stored values for the two themes. */
export const THEME_CONFIG_KEY = "theme";
export const THEME_CONFIG_DARK = "obsidian";
export const THEME_CONFIG_LIGHT = "moonstone";

/** The core commands, used only when `setConfig` is unavailable. */
export const THEME_COMMAND_DARK = "theme:use-dark";
export const THEME_COMMAND_LIGHT = "theme:use-light";

/** The body classes the app renders the resolved theme as. */
export const THEME_BODY_DARK = "theme-dark";
export const THEME_BODY_LIGHT = "theme-light";

/**
 * The slice of `App` this module uses, all of it optional.
 *
 * Structural rather than a cast to `any`: every access below is a real branch a
 * test can take, which is what makes "the API moved" a fallback instead of a
 * crash.
 */
export interface ThemeCapableApp {
  vault?: {
    getConfig?(key: string): unknown;
    setConfig?(key: string, value: unknown): void;
  };
  workspace?: {
    trigger?(name: string, ...args: unknown[]): void;
    on?(name: string, callback: () => void): unknown;
    offref?(ref: unknown): void;
  };
  commands?: {
    executeCommandById?(id: string): boolean;
  };
}

/** Just enough of a document to read the rendered theme off its body. */
export interface ThemeDocumentLike {
  body?: { className?: string } | null;
}

/** The theme the app has *rendered*, from the body class. `null` if unreadable. */
export function themeFromBody(doc: ThemeDocumentLike | null | undefined): AppTheme | null {
  const className = doc?.body?.className;
  if (typeof className !== "string") return null;
  const names = className.split(/\s+/);
  if (names.includes(THEME_BODY_LIGHT)) return "light";
  if (names.includes(THEME_BODY_DARK)) return "dark";
  return null;
}

/**
 * Which theme is on.
 *
 * Stored value first, body class second. `"system"` deliberately falls through
 * to the body class: it says "follow the OS", which is not an answer to "is it
 * dark right now" — only what the app actually painted is.
 */
export function currentTheme(
  app: ThemeCapableApp | null | undefined,
  doc?: ThemeDocumentLike | null,
): AppTheme {
  const stored = app?.vault?.getConfig?.(THEME_CONFIG_KEY);
  if (stored === THEME_CONFIG_DARK) return "dark";
  if (stored === THEME_CONFIG_LIGHT) return "light";
  return themeFromBody(doc ?? globalDocument()) ?? "dark";
}

function globalDocument(): ThemeDocumentLike | null {
  const doc = (globalThis as { document?: ThemeDocumentLike }).document;
  return doc ?? null;
}

/**
 * Switch the app to `theme`. Returns whether a supported route was found.
 *
 * `css-change` is what the settings pane fires after the same write; without it
 * the config is correct and the screen is not, until something else redraws.
 */
export function applyTheme(app: ThemeCapableApp | null | undefined, theme: AppTheme): boolean {
  const value = theme === "dark" ? THEME_CONFIG_DARK : THEME_CONFIG_LIGHT;
  const setConfig = app?.vault?.setConfig;
  if (typeof setConfig === "function") {
    setConfig.call(app?.vault, THEME_CONFIG_KEY, value);
    app?.workspace?.trigger?.("css-change");
    return true;
  }

  const execute = app?.commands?.executeCommandById;
  if (typeof execute === "function") {
    return execute.call(
      app?.commands,
      theme === "dark" ? THEME_COMMAND_DARK : THEME_COMMAND_LIGHT,
    ) !== false;
  }

  console.warn("[wrl] no supported route to change the Obsidian theme");
  return false;
}

/** Flip it. Returns the theme now in force — unchanged if nothing worked. */
export function toggleTheme(
  app: ThemeCapableApp | null | undefined,
  doc?: ThemeDocumentLike | null,
): AppTheme {
  const now = currentTheme(app, doc);
  const next: AppTheme = now === "dark" ? "light" : "dark";
  return applyTheme(app, next) ? next : now;
}

/** The label under both the button and the command. One state, one sentence. */
export function themeToggleLabel(theme: AppTheme): string {
  return theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme";
}

/** The icon of the theme that is *on*, not the one you would switch to. */
export function themeIcon(theme: AppTheme): string {
  return theme === "dark" ? "moon" : "sun";
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export interface ThemeToggleOptions {
  app: ThemeCapableApp | null | undefined;
  /** Overridable for tests; production reads the real `document`. */
  doc?: ThemeDocumentLike | null;
  /** Called after a successful flip, e.g. to re-sync something else. */
  onChange?: (theme: AppTheme) => void;
}

export interface ThemeToggleController {
  el: HTMLElement;
  /** Re-read the app's theme and repaint the button. */
  sync(): void;
  destroy(): void;
}

/**
 * The toolbar button.
 *
 * It carries the state three ways on purpose: the icon for the eye, the
 * `aria-label` for a screen reader, and `data-theme` for anything that needs to
 * assert on it. The label changes with the state — a button whose name is always
 * "Toggle theme" tells a screen-reader user nothing about which way they are
 * about to go.
 */
export function createThemeToggle(
  parent: HTMLElement,
  options: ThemeToggleOptions,
  setIcon: (el: HTMLElement, icon: string) => void,
): ThemeToggleController {
  const el = parent.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-theme-toggle",
    attr: { type: "button" },
  });

  const sync = (): void => {
    const theme = currentTheme(options.app, options.doc);
    const label = themeToggleLabel(theme);
    el.dataset.theme = theme;
    el.toggleClass("is-dark", theme === "dark");
    el.toggleClass("is-light", theme === "light");
    el.setAttr("aria-label", label);
    el.setAttr("title", label);
    // `setIcon` appends rather than replaces; without this the icons stack.
    el.empty();
    setIcon(el, themeIcon(theme));
  };

  const onClick = (): void => {
    const theme = toggleTheme(options.app, options.doc);
    sync();
    options.onChange?.(theme);
  };
  el.addEventListener("click", onClick);

  // Someone else may flip the theme — the settings pane, the core command, a
  // system change while on "system". The button follows rather than going stale.
  const ref = options.app?.workspace?.on?.("css-change", sync);

  sync();

  return {
    el,
    sync,
    destroy(): void {
      el.removeEventListener("click", onClick);
      if (ref !== undefined) options.app?.workspace?.offref?.(ref);
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export const THEME_TOGGLE_COMMAND_ID = "toggle-theme";
export const THEME_TOGGLE_COMMAND_NAME = "Toggle light / dark theme";

/**
 * The command-palette entry, as data.
 *
 * Built here rather than inline in `main.ts` so the id, the name and the action
 * are the same three things the button uses, and so the command is testable
 * without a plugin instance.
 */
export function themeToggleCommand(app: ThemeCapableApp | null | undefined): {
  id: string;
  name: string;
  callback: () => void;
} {
  return {
    id: THEME_TOGGLE_COMMAND_ID,
    name: THEME_TOGGLE_COMMAND_NAME,
    callback: () => {
      toggleTheme(app);
    },
  };
}
