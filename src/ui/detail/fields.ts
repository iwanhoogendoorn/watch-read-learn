/**
 * The form controls a title's detail is edited through — one implementation
 * each, shared by the modal and the workspace view.
 *
 * Every one of them renders the same `.wl-field` block (label above control) so
 * a surface only has to decide *layout*, in CSS, rather than re-implementing the
 * control. That is the whole point: two copies of a control are two places for a
 * write to go missing, which is the bug this module exists to make impossible.
 */
import { setIcon } from "obsidian";
import type { DateFormat, TitlePatch, TitleV4 } from "../../types";
import { renderDateInput } from "../components/dates";
import type { DetailSurface } from "./surface";

export interface FieldOptions {
  label: string;
  /** Extra class on the `.wl-field` wrapper, for a surface-specific layout. */
  cls?: string;
}

function fieldBlock(host: HTMLElement, options: FieldOptions): HTMLElement {
  const field = host.createDiv({ cls: `wl-field${options.cls ? ` ${options.cls}` : ""}` });
  field.createDiv({ cls: "wl-field-label", text: options.label });
  return field;
}

export interface SelectFieldOptions extends FieldOptions {
  values: readonly string[];
  current: string;
  onChange: (value: string) => void;
}

export function renderSelectField(
  host: HTMLElement,
  options: SelectFieldOptions,
): HTMLSelectElement {
  const field = fieldBlock(host, options);
  const select = field.createEl("select", { cls: "wl-select" });
  select.setAttribute("aria-label", options.label);
  for (const value of options.values) {
    const option = select.createEl("option", { value, text: value === "" ? "—" : value });
    if (value === options.current) option.selected = true;
  }
  // Set explicitly as well as via `selected`: the two are equivalent in a
  // browser, and being explicit means the control states what it shows rather
  // than leaving it to be derived.
  select.value = options.current;
  select.addEventListener("change", () => options.onChange(select.value));
  return select;
}

/**
 * The status select.
 *
 * Shared rather than written twice because the *side effect* is the interesting
 * part: moving a title to Watched is the one status change that knows three
 * other things — when, how good, what you thought — and a surface that forgot to
 * ask would silently drop them. `afterChange` fires once the patch has landed.
 */
export function renderStatusField(
  host: HTMLElement,
  title: TitleV4,
  surface: DetailSurface,
  afterChange?: (value: string) => void,
  cls?: string,
): HTMLSelectElement {
  return renderSelectField(host, {
    label: "Status",
    cls,
    values: surface.store.settings.statuses.map((s) => s.name),
    current: title.status,
    onChange: (value) => {
      surface.patch({ status: value }, "detail-status");
      afterChange?.(value);
    },
  });
}

/**
 * Where it was watched.
 *
 * One control, both surfaces, for the same reason everything else in this
 * module is: a second copy is a second place for a write to go missing. It sits
 * beside Status because that is where the question belongs — the venue is a
 * fact about the watching, not about the film.
 *
 * `""` is offered and means "not recorded"; the Dashboard counts those rather
 * than hiding them, so clearing this is a real answer, not a hole.
 */
export function renderWatchedViaField(
  host: HTMLElement,
  title: TitleV4,
  surface: DetailSurface,
  cls?: string,
): HTMLSelectElement {
  return renderSelectField(host, {
    label: "Watched via",
    cls,
    values: ["", ...surface.store.settings.watchedViaOptions.map((v) => v.name)],
    current: title.watchedVia,
    onChange: (value) => surface.patch({ watchedVia: value }, "detail-watched-via"),
  });
}

export interface DateFieldOptions extends FieldOptions {
  format: DateFormat;
  current: string | null;
  onChange: (value: string | null) => void;
  /**
   * Injectable clock for the "Today" button, so a test can pin the day.
   *
   * The button itself is not optional. It used to be off in the modal and on in
   * the view, which meant the same field offered a different set of affordances
   * depending on how you had opened the title — the exact class of divergence
   * this module exists to prevent.
   */
  now?: () => Date;
}

export function renderDateField(host: HTMLElement, options: DateFieldOptions): HTMLElement {
  const field = fieldBlock(host, options);
  renderDateInput(field, {
    format: options.format,
    label: options.label,
    value: options.current,
    messageHost: field,
    onCommit: options.onChange,
    today: options.now ?? (() => new Date()),
  });
  return field;
}

export interface NumberFieldOptions extends FieldOptions {
  current: number;
  onChange: (value: number) => void;
}

export function renderNumberField(host: HTMLElement, options: NumberFieldOptions): HTMLElement {
  const field = fieldBlock(host, options);
  const input = field.createEl("input", {
    cls: "wl-input",
    attr: { type: "number", min: "0", step: "1" },
  });
  input.setAttribute("aria-label", options.label);
  input.value = String(options.current);
  input.addEventListener("change", () =>
    options.onChange(Math.max(0, Number(input.value) || 0)),
  );
  return field;
}

export interface TextFieldOptions extends FieldOptions {
  current: string;
  /** Debounce key; also the write reason (`detail-<key>`). */
  key: string;
  /** Latest keystrokes are handed back here, then read into a patch on commit. */
  onInput: (value: string) => void;
  read: () => TitlePatch;
  surface: DetailSurface;
}

export function renderTextField(host: HTMLElement, options: TextFieldOptions): HTMLElement {
  const field = fieldBlock(host, options);
  const input = field.createEl("input", { cls: "wl-input", attr: { type: "text" } });
  input.setAttribute("aria-label", options.label);
  input.value = options.current;
  input.addEventListener("input", () => {
    options.onInput(input.value);
    options.surface.debouncedPatch(options.key, options.read);
  });
  return field;
}

export interface NotesFieldOptions {
  current: string;
  onInput: (value: string) => void;
  read: () => TitlePatch;
  surface: DetailSurface;
  cls?: string;
}

/** The free-text notes box. Same debounce as every other free-text field. */
export function renderNotesField(host: HTMLElement, options: NotesFieldOptions): HTMLElement {
  const section = host.createDiv({
    cls: `wl-detail-section wl-detail-notes${options.cls ? ` ${options.cls}` : ""}`,
  });
  section.createDiv({ cls: "wl-field-label", text: "Notes" });
  const area = section.createEl("textarea", {
    cls: "wl-textarea",
    attr: { rows: "4", placeholder: "Anything worth remembering about this one…" },
  });
  area.setAttribute("aria-label", "Notes");
  area.value = options.current;
  area.addEventListener("input", () => {
    options.onInput(area.value);
    options.surface.debouncedPatch("notes", options.read);
  });
  return section;
}

/**
 * A button with an icon *and* a label.
 *
 * Never a bare coloured rectangle, whatever a theme does to `.mod-warning`
 * (QA1 B6) — which is why the destructive one uses this too.
 */
export function iconTextButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
  cls = "wl-btn",
): HTMLElement {
  const button = parent.createEl("button", { cls, attr: { type: "button" } });
  const iconEl = button.createSpan({ cls: "wl-btn-icon" });
  setIcon(iconEl, icon);
  button.createSpan({ cls: "wl-btn-label", text: label });
  button.addEventListener("click", onClick);
  return button;
}
