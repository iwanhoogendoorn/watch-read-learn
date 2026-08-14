/**
 * Dates the way the user asked for them (SPEC §4.10, QA1 B5).
 *
 * `settings.dateFormat` used to decide how dates were *displayed* in lists while
 * every editable date was a raw `<input type="date">` — which ignores the setting
 * entirely and renders whatever the host locale says (`dd.mm.yyyy` on this
 * user's machine), in a widget that also refuses to match the rest of the form.
 *
 * So: one module owns the three conversions, and every surface uses it.
 *
 *   - `formatDate`           storage (`YYYY-MM-DD`) → what the user reads
 *   - `parseDisplayDate`     what the user typed → storage, or "that is not a date"
 *   - `dateFormatPlaceholder` the pattern to show in an empty field
 *
 * Storage never changes: `YYYY-MM-DD`, calendar-only, no timezone. Only the
 * presentation moves.
 */
import { setIcon } from "obsidian";
import type { DateFormat } from "../../types";

/** `2026-07-31` → `31-07-2026` / `07/31/2026` / `2026-07-31`. `""` when unparseable. */
export function formatDate(value: string | null | undefined, format: DateFormat): string {
  const parts = splitStoredDate(value);
  if (!parts) return "";
  const { y, m, d } = parts;
  if (format === "iso") return `${y}-${m}-${d}`;
  if (format === "american") return `${m}/${d}/${y}`;
  return `${d}-${m}-${y}`;
}

/** The pattern an empty field advertises, in the configured order. */
export function dateFormatPlaceholder(format: DateFormat): string {
  if (format === "iso") return "yyyy-mm-dd";
  if (format === "american") return "mm/dd/yyyy";
  return "dd-mm-yyyy";
}

export type ParsedDate =
  /** A real date, in storage form. */
  | { ok: true; value: string }
  /** The field was cleared. */
  | { ok: true; value: null }
  /** Text that is not a date in this format — the caller must not commit. */
  | { ok: false };

/**
 * What the user typed → `YYYY-MM-DD`.
 *
 * Deliberately forgiving about *separators* (`-`, `/`, `.`, spaces) and about
 * leading zeros, because those are typing noise rather than intent — but never
 * about **field order**: `03-08-2026` is 3 August under `european` and nothing
 * at all under `american`, and silently guessing between them is how a watch
 * date lands five months out. A four-digit first group is the one exception: it
 * can only be ISO, so it is read as such under every format.
 */
export function parseDisplayDate(raw: string, format: DateFormat): ParsedDate {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };

  const match = /^(\d{1,4})[-/. ](\d{1,2})[-/. ](\d{1,4})$/.exec(text);
  if (!match) return { ok: false };
  const [, a, b, c] = match as unknown as [string, string, string, string];

  let year: number;
  let month: number;
  let day: number;
  if (a.length === 4 || format === "iso") {
    if (a.length !== 4 || c.length > 2) return { ok: false };
    year = Number(a);
    month = Number(b);
    day = Number(c);
  } else if (format === "american") {
    if (c.length !== 4) return { ok: false };
    month = Number(a);
    day = Number(b);
    year = Number(c);
  } else {
    if (c.length !== 4) return { ok: false };
    day = Number(a);
    month = Number(b);
    year = Number(c);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1) return { ok: false };
  // 31-02-2026 parses as three numbers and is still not a day.
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

// ---------------------------------------------------------------------------
// The one editable date control
// ---------------------------------------------------------------------------

export interface DateInputOptions {
  format: DateFormat;
  /** Used for the `aria-label`, which also announces the expected pattern. */
  label: string;
  /** Current value in storage form. */
  value: string | null;
  /**
   * Host for the inline "Use dd-mm-yyyy." message, created *after* the input so
   * it reads underneath it. Omit for hosts with no room for one.
   */
  messageHost?: HTMLElement;
  /** Called only when the text parses — with storage form, or `null` if cleared. */
  onCommit: (value: string | null) => void;
  cls?: string;
}

/**
 * A text field that shows, advertises and parses `settings.dateFormat`.
 *
 * Replaces `<input type="date">` everywhere a date is edited: the native picker
 * renders the *host locale's* order regardless of the plugin setting, and styles
 * nothing like the rest of the form. Committing happens on blur and on Enter,
 * never per keystroke, and unparseable text is refused rather than written.
 */
export function renderDateInput(host: HTMLElement, options: DateInputOptions): HTMLInputElement {
  const { format } = options;
  const placeholder = dateFormatPlaceholder(format);
  // The typed field and the calendar button live in one row: typing stays the
  // fast path, the picker is there for the days you cannot remember whether
  // the 12th was a Tuesday.
  const wrap = host.createDiv({ cls: "wl-date-field" });
  const input = wrap.createEl("input", {
    cls: `wl-input wl-date-input${options.cls ? ` ${options.cls}` : ""}`,
    attr: {
      type: "text",
      inputmode: "numeric",
      placeholder,
      spellcheck: "false",
      "aria-label": `${options.label} (${placeholder})`,
    },
  });
  input.value = formatDate(options.value, format);
  const message = options.messageHost?.createDiv({ cls: "wl-field-msg wl-date-msg" });

  const clearError = (): void => {
    message?.setText("");
    input.removeClass("is-invalid");
  };

  const commit = (): void => {
    const parsed = parseDisplayDate(input.value, format);
    if (!parsed.ok) {
      message?.setText(`Use ${placeholder}.`);
      input.addClass("is-invalid");
      return;
    }
    clearError();
    // Re-render what was accepted, so `3/8/2026` settles as `03-08-2026`.
    input.value = formatDate(parsed.value, format);
    options.onCommit(parsed.value);
  };

  input.addEventListener("input", clearError);
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });

  /*
   * The picker is a real `<input type="date">`, kept out of sight.
   *
   * It cannot be *the* field — it renders in the host locale and ignores
   * `settings.dateFormat` entirely, which is the bug this component exists to
   * fix (QA1 B5). But it is also the only calendar the platform will give us,
   * and `showPicker()` opens it without it ever being seen. What comes back is
   * written through the same commit path, so the value on screen stays in the
   * user's own format.
   */
  const native = wrap.createEl("input", {
    cls: "wl-date-native",
    attr: { type: "date", tabindex: "-1", "aria-hidden": "true" },
  });
  const stored = splitStoredDate(options.value);
  if (stored) native.value = `${stored.y}-${stored.m}-${stored.d}`;

  const openPicker = wrap.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-date-open",
    attr: { type: "button", "aria-label": `Pick a date for ${options.label}`, title: "Pick a date" },
  });
  setIcon(openPicker, "calendar");
  openPicker.addEventListener("click", () => {
    // `showPicker` is Chromium-only and Obsidian is Chromium; the click
    // fallback is what a stray non-Electron host gets.
    const withPicker = native as HTMLInputElement & { showPicker?: () => void };
    if (typeof withPicker.showPicker === "function") withPicker.showPicker();
    else native.click();
  });

  native.addEventListener("change", () => {
    const value = native.value.trim();
    if (value === "") return;
    clearError();
    input.value = formatDate(value, format);
    options.onCommit(value);
  });

  return input;
}

function splitStoredDate(
  value: string | null | undefined,
): { y: string; m: string; d: string } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y, m, d };
}
