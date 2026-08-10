/**
 * Honest stubs for the parity tabs (SPEC2-PARITY.md, W8-contract).
 *
 * The seven-tab shell lands with the contract so the later lanes have somewhere
 * to plug into, but Reading, Games and Lists have no implementation yet. A tab
 * that exists and does nothing is worse than no tab at all *unless it says so*:
 * these render what the tab will hold, what already exists on disk for it, and
 * that it is not built yet. No fake charts, no "0 books" implying an empty
 * shelf when the truth is an unbuilt feature.
 *
 * Each stub is replaced wholesale by its lane; nothing else imports this file.
 */
import { setIcon } from "obsidian";
import type { TabController, TabId } from "../../types";

export interface StubTabOptions {
  id: TabId;
  icon: string;
  title: string;
  /** One sentence on what the tab is for. */
  body: string;
  /** What the vault already holds for this domain, when anything does. */
  existing?: string;
  /** The bullet list of what the lane will bring. */
  planned: string[];
}

export function mountStubTab(host: HTMLElement, options: StubTabOptions): TabController {
  const el = host.createDiv({ cls: `wl-tab-panel wl-tab-panel-${options.id}` });
  const panel = el.createDiv({ cls: "wl-stub" });

  const head = panel.createDiv({ cls: "wl-stub-head" });
  setIcon(head.createDiv({ cls: "wl-stub-icon" }), options.icon);
  head.createDiv({ cls: "wl-stub-title", text: options.title });

  panel.createDiv({ cls: "wl-stub-body", text: options.body });

  if (options.existing) {
    // The data is already in `data.json` and has been round-tripping untouched
    // since v4 shipped. Saying so is the difference between "not built" and
    // "your books are gone".
    const note = panel.createDiv({ cls: "wl-stub-existing" });
    setIcon(note.createSpan({ cls: "wl-stub-existing-icon" }), "database");
    note.createSpan({ text: options.existing });
  }

  const list = panel.createEl("ul", { cls: "wl-stub-list" });
  for (const item of options.planned) list.createEl("li", { text: item });

  panel.createDiv({
    cls: "wl-stub-foot",
    text: "Coming in this build — nothing here is wired up yet.",
  });

  return {
    id: options.id,
    el,
    refresh: () => undefined,
    destroy: () => el.remove(),
  };
}
