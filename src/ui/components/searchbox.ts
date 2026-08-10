/**
 * The search box: a text input, a clear ×, and the `?` that opens the search
 * syntax modal.
 *
 * The tips button lives *inside* the box on purpose (foodspot §2c) — a query
 * language nobody can discover is a query language nobody uses. What it must not
 * do is put the query language in the user's face: the placeholder used to read
 * `Search — try genre:"Sci-Fi" rating:>=4 -anime`, which told someone who wanted
 * to type "dexter" that they were expected to learn a syntax first (QA2 report
 * 2). Plain typing has always worked fuzzily; now the placeholder says so, and
 * every example lives one click away in the tips modal.
 *
 * Typing is debounced by `SEARCH_DEBOUNCE_MS`; Enter and the clear button fire
 * immediately, because those are deliberate acts and waiting on them feels broken.
 */
import { setIcon } from "obsidian";

export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Is this query written in the search *language*, or is it just words?
 *
 * Field scopes (`genre:`), negation (`-anime`), quoted phrases, `OR` and the
 * comparison operators are the whole vocabulary. Anything else — including the
 * hyphen inside `sci-fi` or `spider-man`, which is why negation only counts at
 * a word boundary — is plain typing, and plain typing is the default the box is
 * meant to advertise.
 */
export function usesOperators(query: string): boolean {
  const text = query.trim();
  if (text === "") return false;
  if (/(^|\s)-\S/.test(text)) return true; // -anime
  if (/[\w-]+:/.test(text)) return true; // genre:sci-fi, rating:>=4
  if (/"/.test(text)) return true; // "breaking bad"
  if (/(^|\s)OR(\s|$)/.test(text)) return true; // a OR b
  return false;
}

export interface SearchBoxOptions {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onTips?: () => void;
}

export interface SearchBoxHandle {
  el: HTMLElement;
  /** Set the text without firing `onChange` (preset apply, chip handoff). */
  setValue(value: string, fire?: boolean): void;
  focus(): void;
  destroy(): void;
}

export function createSearchBox(
  parent: HTMLElement,
  options: SearchBoxOptions,
): SearchBoxHandle {
  const wrap = parent.createDiv({ cls: "wl-searchbox" });

  const icon = wrap.createSpan({ cls: "wl-searchbox-icon" });
  setIcon(icon, "search");

  const input = wrap.createEl("input", {
    cls: "wl-searchbox-input",
    attr: {
      type: "search",
      placeholder: options.placeholder ?? "Search your library…",
      "aria-label": "Search your library",
      spellcheck: "false",
    },
  });
  input.value = options.value;

  const clear = wrap.createEl("button", {
    cls: "wl-icon-btn wl-searchbox-clear",
    attr: { type: "button", "aria-label": "Clear search", title: "Clear search" },
  });
  setIcon(clear, "x");
  clear.toggleClass("is-visible", input.value !== "");

  /**
   * The tips affordance: an icon once you are writing queries, an icon *and* the
   * word "Tips" while you are not.
   *
   * The label is the discoverability the placeholder used to buy at the cost of
   * intimidating everyone — it is a hint that more is available, next to a box
   * that plainly works without it, and it gets out of the way the moment the
   * user demonstrates they already know (QA2 report 2).
   */
  let syncTips = (): void => undefined;
  if (options.onTips) {
    const tips = wrap.createEl("button", {
      cls: "wl-icon-btn wl-searchbox-tips",
      attr: { type: "button", "aria-label": "Search syntax", title: "Search syntax" },
    });
    // `setIcon` writes innerHTML, so the label has to come after it.
    setIcon(tips, "help-circle");
    tips.createSpan({ cls: "wl-searchbox-tips-label", text: "Tips" });
    tips.addEventListener("click", () => options.onTips?.());
    syncTips = (): void => {
      tips.toggleClass("has-label", !usesOperators(input.value));
    };
    syncTips();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  function fire(immediate: boolean): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const emit = (): void => options.onChange(input.value);
    if (immediate) emit();
    else timer = setTimeout(emit, SEARCH_DEBOUNCE_MS);
  }

  input.addEventListener("input", () => {
    clear.toggleClass("is-visible", input.value !== "");
    syncTips();
    fire(false);
  });

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      fire(true);
    } else if (event.key === "Escape" && input.value !== "") {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      clear.removeClass("is-visible");
      syncTips();
      fire(true);
    }
  });

  clear.addEventListener("click", () => {
    input.value = "";
    clear.removeClass("is-visible");
    syncTips();
    fire(true);
    input.focus();
  });

  return {
    el: wrap,
    setValue(value: string, emit = false): void {
      input.value = value;
      clear.toggleClass("is-visible", value !== "");
      syncTips();
      if (emit) fire(true);
    },
    focus(): void {
      input.focus();
    },
    destroy(): void {
      if (timer !== null) clearTimeout(timer);
      wrap.remove();
    },
  };
}
