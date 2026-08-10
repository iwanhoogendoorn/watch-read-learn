/**
 * The Games search-syntax modal, behind the `?` in the search box.
 *
 * Same job as `ui/modals/tips.ts` and the same markup (so it inherits the
 * modal's styling): every rule is a coloured example beside a plain sentence,
 * and the footer lists every field you can scope to. The one thing worth
 * spelling out here is the unit — `playtime:` is **hours**, because a library
 * where `playtime:>40` meant forty minutes would be a trap.
 */
import { Modal, type App } from "obsidian";
import { GAME_ENUM_FIELDS, GAME_NUMERIC_FIELDS, GAME_TEXT_FIELDS } from "../query";

interface Rule {
  example: { text: string; kind?: "field" | "value" | "quote" | "op" | "neg" | "or" }[];
  description: string;
}

const RULES: Rule[] = [
  {
    example: [{ text: "hollow knight" }],
    description: "Bare words match loosely across title, genre, developer, publisher and platform.",
  },
  {
    example: [{ text: '"hollow knight"', kind: "quote" }],
    description: "Quotes match the exact phrase, ignoring accents.",
  },
  {
    example: [
      { text: "platform:", kind: "field" },
      { text: "switch", kind: "value" },
    ],
    description: "Scope a term to one field.",
  },
  {
    example: [
      { text: "playtime:", kind: "field" },
      { text: ">", kind: "op" },
      { text: "40", kind: "value" },
    ],
    description: "Hours played. Use `minutes:` if you mean the raw number.",
  },
  {
    example: [
      { text: "achievements:", kind: "field" },
      { text: "=", kind: "op" },
      { text: "100", kind: "value" },
    ],
    description: "Percentage of achievements earned. Games without any never match.",
  },
  {
    example: [
      { text: "wishlist:", kind: "field" },
      { text: "yes", kind: "value" },
    ],
    description: "The wishlist flag. `favorite:` and `played:` work the same way.",
  },
  {
    example: [
      { text: "mode:", kind: "field" },
      { text: "coop", kind: "value" },
    ],
    description: "How it plays. Also `mode:solo`, `mode:multi`.",
  },
  {
    example: [
      { text: "-", kind: "neg" },
      { text: "indie" },
    ],
    description: "A leading minus excludes. Works on every kind of term.",
  },
  {
    example: [{ text: "rpg " }, { text: "|", kind: "or" }, { text: " strategy" }],
    description: "A bare pipe is OR — either side matching is enough.",
  },
];

export class GameSearchTipsModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-tips-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Games search syntax" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Terms combine with AND. Anything the parser does not recognise is searched for literally, so a half-typed query never errors.",
    });

    const list = contentEl.createDiv({ cls: "wl-tips-list" });
    for (const rule of RULES) {
      const row = list.createDiv({ cls: "wl-tips-row" });
      const code = row.createEl("code", { cls: "wl-qtok" });
      for (const part of rule.example) {
        code.createSpan({
          cls: part.kind ? `wl-qtok-${part.kind}` : "wl-qtok-term",
          text: part.text,
        });
      }
      row.createSpan({ cls: "wl-tips-desc", text: rule.description });
    }

    contentEl.createEl("h4", { cls: "wl-tips-subhead", text: "Fields you can scope to" });
    const chips = contentEl.createDiv({ cls: "wl-chips" });
    for (const field of [...GAME_TEXT_FIELDS, ...GAME_NUMERIC_FIELDS, ...GAME_ENUM_FIELDS]) {
      chips.createSpan({ cls: "wl-chip", text: field });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
