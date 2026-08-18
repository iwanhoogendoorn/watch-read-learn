/**
 * What a "detail surface" is, and the two helpers every one of them needs.
 *
 * A title can be looked at in two places now — the modal (`ui/modals/detail.ts`)
 * and the workspace view (`ui/views/title-detail.ts`) — and the controls inside
 * them are the same controls. The rating/review binding was reported broken four
 * times, and the last two root causes were both *duplication*: the modal wrote
 * without repainting, and the wizard carried a second, divergent copy of the
 * binding. So the controls live in `ui/detail/` and take one of these, and
 * neither surface is allowed its own copy of the rules.
 *
 * The contract is deliberately tiny: a store to read settings from, a write that
 * **repaints**, and a debounced write for free-text fields.
 */
import type { TitlePatch, WatchLogStoreApi } from "../../types";

export interface DetailSurface {
  readonly store: WatchLogStoreApi;
  /**
   * Write, then repaint.
   *
   * The repaint is not optional and not the caller's problem: a write nobody
   * can see is indistinguishable from no write, which is exactly what "rating
   * and review are not connected" looked like for three releases.
   */
  patch(patch: TitlePatch, reason: string): void;
  /** Debounced write for free-text fields; keystrokes never reach the store. */
  debouncedPatch(key: string, read: () => TitlePatch): void;
}

/**
 * Duck-typed on purpose. `instanceof HTMLInputElement` compares against *this*
 * window's constructor, and Obsidian's popout windows each have their own — so
 * a field in a popped-out surface is not an instance of the main window's input
 * class, and the guard silently reads "not editable". Tag names cross realms.
 */
export function isEditable(el: { tagName?: string; isContentEditable?: boolean }): boolean {
  const tag = (el.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

/** `sci-fi, rewatch , ,cosy` → `["sci-fi","rewatch","cosy"]`. */
export function readTagList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}
