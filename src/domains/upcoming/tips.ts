/**
 * The Upcoming search-syntax modal, behind the `?` in the search box.
 *
 * Same job and same markup as `ui/modals/tips.ts` and the Games one, over the
 * fields an *event* has. The reason this is a modal rather than a placeholder is
 * QA2 report 2: a placeholder that reads like a grammar tells someone who wants
 * to type "severance" that they must learn a syntax first. Plain typing works
 * fuzzily; this is where the rest lives.
 */
import { Modal, type App } from "obsidian";
import {
  UPCOMING_ENUM_FIELDS,
  UPCOMING_NUMERIC_FIELDS,
  UPCOMING_TEXT_FIELDS,
} from "./query";

interface Rule {
  example: { text: string; kind?: "field" | "value" | "quote" | "op" | "neg" | "or" }[];
  description: string;
}

const RULES: Rule[] = [
  {
    example: [{ text: "severance" }],
    description: "Bare words match loosely across the title, the show, the episode name and the detail line.",
  },
  {
    example: [{ text: '"the last of us"', kind: "quote" }],
    description: "Quotes match the exact phrase, ignoring accents.",
  },
  {
    example: [
      { text: "show:", kind: "field" },
      { text: "severance", kind: "value" },
    ],
    description: "The programme. `episode:` scopes to the episode's own name instead.",
  },
  {
    example: [
      { text: "domain:", kind: "field" },
      { text: "games", kind: "value" },
    ],
    description: "Which library the row came from. Also `domain:watchlist`, `domain:reading`.",
  },
  {
    example: [
      { text: "kind:", kind: "field" },
      { text: "season", kind: "value" },
    ],
    description: "What kind of event it is. Also `kind:episode`, `kind:release`.",
  },
  {
    example: [
      { text: "state:", kind: "field" },
      { text: "due", kind: "value" },
    ],
    description: "Already arrived (`due`), still to come (`scheduled`) or dateless (`announced`).",
  },
  {
    example: [
      { text: "days:", kind: "field" },
      { text: "<=", kind: "op" },
      { text: "7", kind: "value" },
    ],
    description: "Calendar days until it arrives — negative once it has. `year:` compares the same way.",
  },
  {
    example: [
      { text: "plex:", kind: "field" },
      { text: "no", kind: "value" },
    ],
    description: "Availability. Also `plex:yes` (on Plex) and `plex:queued` (requested, on its way).",
  },
  {
    example: [
      { text: "watched:", kind: "field" },
      { text: "no", kind: "value" },
    ],
    description:
      "Whether you have finished it — this episode ticked off, the book completed, the game finished. `seen:`, `read:` and `played:` are the same field.",
  },
  {
    example: [
      { text: "-", kind: "neg" },
      { text: "anime" },
    ],
    description: "A leading minus excludes. Works on every kind of term.",
  },
  {
    example: [{ text: "episode " }, { text: "|", kind: "or" }, { text: " release" }],
    description: "A bare pipe is OR — either side matching is enough.",
  },
];

export class UpcomingSearchTipsModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-tips-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Upcoming search syntax" });
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
    for (const field of [
      ...UPCOMING_TEXT_FIELDS,
      ...UPCOMING_NUMERIC_FIELDS,
      ...UPCOMING_ENUM_FIELDS,
    ]) {
      chips.createSpan({ cls: "wl-chip", text: field });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
