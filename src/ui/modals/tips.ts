/**
 * The search-syntax modal, reachable from the `?` inside the search box.
 *
 * This is how a query language becomes discoverable without documentation
 * (foodspot §2c): every rule is a colourised example next to a plain-English
 * sentence, and the footer lists every field name you can scope to.
 */
import { Modal, type App } from "obsidian";

interface Rule {
  /** Tokens of the example, tagged so each part gets its own colour. */
  example: { text: string; kind?: "field" | "value" | "quote" | "op" | "neg" | "or" }[];
  description: string;
}

const RULES: Rule[] = [
  {
    example: [{ text: "dexter blood" }],
    description: "Bare words match loosely across title, cast, genres, tags and notes.",
  },
  {
    example: [{ text: '"breaking bad"', kind: "quote" }],
    description: "Quotes match the exact phrase, ignoring accents.",
  },
  {
    example: [
      { text: "genre:", kind: "field" },
      { text: "sci-fi", kind: "value" },
    ],
    description: "Scope a term to one field.",
  },
  {
    example: [
      { text: "rating:", kind: "field" },
      { text: ">=", kind: "op" },
      { text: "4", kind: "value" },
    ],
    description: "Compare numbers with > >= < <= = — a bare number means equals.",
  },
  {
    example: [
      { text: "year:", kind: "field" },
      { text: ">", kind: "op" },
      { text: "2020", kind: "value" },
    ],
    description: "Release year. `eps-left`, `runtime` and `community` work the same way.",
  },
  {
    example: [
      { text: "plex:", kind: "field" },
      { text: "yes", kind: "value" },
    ],
    description: "Availability. Also `plex:partial`, `plex:no`.",
  },
  {
    example: [
      { text: "requested:", kind: "field" },
      { text: "yes", kind: "value" },
    ],
    description: "Titles with an Overseerr request on file.",
  },
  {
    example: [
      { text: "airing:", kind: "field" },
      { text: "soon", kind: "value" },
    ],
    description: "Something airs or releases in the future. Also `returning`, `ended`.",
  },
  {
    example: [
      { text: "-", kind: "neg" },
      { text: "anime" },
    ],
    description: "A leading minus excludes. Works on every kind of term.",
  },
  {
    example: [
      { text: "sci-fi " },
      { text: "|", kind: "or" },
      { text: " thriller" },
    ],
    description: "A bare pipe is OR — either side matching is enough.",
  },
];

const FIELDS = [
  "title",
  "type",
  "status",
  "priority",
  "genre",
  "tag",
  "cast",
  "director",
  "studio",
  "note",
  "rating",
  "year",
  "eps-left",
  "runtime",
  "community",
  "plex",
  "requested",
  "airing",
  "favorite",
];

export class SearchTipsModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-tips-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Search syntax" });
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
    for (const field of FIELDS) chips.createSpan({ cls: "wl-chip", text: field });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
