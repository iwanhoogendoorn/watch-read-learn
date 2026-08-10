/**
 * Where a draft goes when you press Add.
 *
 * A draft is just a string, so the one thing this has to get right is *which
 * library it belongs to* — and only the user knows. v3 asked with a four-button
 * sheet (Watchlist / Book / Manga / Game) and so does this.
 *
 * The Watchlist route hands off to the composition root's Add modal, so a draft
 * gets the same search, the same metadata fill and the same post-add Plex/airing
 * refresh as anything added from the toolbar. Books, manga and games have no
 * search flow yet in this build, so they are created directly from the frozen
 * `createBook`/`createManga`/`createGame` factories with the title filled in and
 * everything else at its default — a real entry in the real store, ready for the
 * Reading and Games tabs to edit, rather than a draft that quietly went nowhere.
 */
import { Modal, Notice, type App } from "obsidian";
import { createBook, createGame, createManga, slugify, uniqueId } from "../../data/schema";
import type { WatchLogStoreApi } from "../../types";

export type DraftTarget = "watchlist" | "book" | "manga" | "game";

const TARGET_LABELS: { target: DraftTarget; label: string; hint: string }[] = [
  { target: "watchlist", label: "Watchlist", hint: "Movie, show or anime" },
  { target: "book", label: "Book", hint: "Pages or words" },
  { target: "manga", label: "Manga", hint: "Chapters and volumes" },
  { target: "game", label: "Game", hint: "Playtime and achievements" },
];

export class DraftTargetModal extends Modal {
  private readonly draft: string;
  private readonly onChoose: (target: DraftTarget) => void;

  constructor(app: App, draft: string, onChoose: (target: DraftTarget) => void) {
    super(app);
    this.draft = draft;
    this.onChoose = onChoose;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-drafttarget-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `Add “${this.draft}”` });
    contentEl.createEl("p", { cls: "wl-modal-message", text: "Which library does it belong in?" });

    const grid = contentEl.createDiv({ cls: "wl-drafttarget-grid" });
    for (const option of TARGET_LABELS) {
      const button = grid.createEl("button", {
        cls: "wl-btn wl-drafttarget-btn",
        attr: { type: "button" },
      });
      button.createDiv({ cls: "wl-drafttarget-label", text: option.label });
      button.createDiv({ cls: "wl-drafttarget-hint", text: option.hint });
      button.addEventListener("click", () => {
        this.close();
        this.onChoose(option.target);
      });
    }

    contentEl
      .createDiv({ cls: "wl-modal-buttons" })
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Create the entry for a non-watchlist target. Returns false when nothing was
 * written, which today only happens if the title is blank.
 */
export function addDraftToDomain(
  store: WatchLogStoreApi,
  target: Exclude<DraftTarget, "watchlist">,
  title: string,
): boolean {
  const name = title.trim();
  if (name === "") return false;

  if (target === "game") {
    const taken = store.games.games.map((game) => game.id);
    const game = createGame({
      id: uniqueId(slugify(name), taken),
      title: name,
      status: store.games.settings.defaultStatus,
    });
    store.games.games.push(game);
  } else if (target === "book") {
    const taken = store.reading.books.map((book) => book.id);
    store.reading.books.push(createBook({ id: uniqueId(slugify(name), taken), title: name }));
  } else {
    const taken = store.reading.manga.map((manga) => manga.id);
    store.reading.manga.push(createManga({ id: uniqueId(slugify(name), taken), title: name }));
  }

  const source = target === "game" ? "Games" : "Reading";
  store.logActivity({ message: `Added ${name} to ${source}`, source, action: "added" });
  store.save(`draft-added-${target}`);
  store.emitChanged({ reason: `draft-added-${target}` });
  new Notice(`“${name}” added to ${source}.`);
  return true;
}
