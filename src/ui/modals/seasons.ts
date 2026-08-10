/**
 * The structured season editor.
 *
 * v3 stored seasons as free text (`Season 3: 10 (3,5-7)`) and re-parsed it on
 * every read, so a typo silently reassigned which episodes the stored absolute
 * numbers referred to. v4 edits **rows**: name, episode count, air date, skipped
 * list. Offsets are recomputed from the row order on save (`recomputeOffsets`),
 * and `totalEpisodes` is derived from the rows rather than tracked separately.
 *
 * The one destructive case — shrinking a season so that watched episodes fall off
 * the end — is surfaced before it happens, not after.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import {
  getWatchedCount,
  recomputeOffsets,
  totalFromSeasons,
} from "../../data/episodes";
import type { Season, TitleV4, WatchLogStoreApi } from "../../types";
import { renderDateInput } from "../components/dates";

// ---------------------------------------------------------------------------
// Episode-list parsing (pure — `1,3,5-7` ⇄ [1,3,5,6,7])
// ---------------------------------------------------------------------------

/**
 * Parse a compact episode list. Accepts `1, 3, 5-7`; ignores junk rather than
 * failing, and clamps to `1..max` so a stale list can never widen a season.
 */
export function parseEpisodeList(raw: string, max: number): number[] {
  const out = new Set<number>();
  for (const chunk of raw.split(/[,\s]+/)) {
    if (chunk === "") continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(chunk);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) {
        if (n >= 1 && n <= max) out.add(n);
      }
      continue;
    }
    const single = /^(\d+)$/.exec(chunk);
    if (single) {
      const n = Number(single[1]);
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Inverse of `parseEpisodeList`: `[1,3,5,6,7]` → `1, 3, 5-7`. */
export function formatEpisodeList(episodes: readonly number[]): string {
  const sorted = [...new Set(episodes)].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index] as number;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index] as number;
    }
    parts.push(end > start + 1 ? `${start}-${end}` : end === start + 1 ? `${start}, ${end}` : `${start}`);
    index += 1;
  }
  return parts.join(", ");
}

/** A draft row, normalised into a real `Season` on save. */
export interface SeasonDraft {
  name: string;
  episodes: number;
  skipped: string;
  airDate: string;
  seasonNumber: number | null;
}

export function toDrafts(seasons: readonly Season[]): SeasonDraft[] {
  return seasons.map((season) => ({
    name: season.name,
    episodes: season.episodes,
    skipped: formatEpisodeList(season.skippedEpisodes),
    airDate: season.airDate ?? "",
    seasonNumber: season.seasonNumber ?? null,
  }));
}

/** Drafts → seasons, with offsets recomputed from the row order. */
export function fromDrafts(drafts: readonly SeasonDraft[]): Season[] {
  const seasons: Season[] = drafts.map((draft, index) => {
    const episodes = Math.max(0, Math.trunc(draft.episodes) || 0);
    return {
      name: draft.name.trim() || `Season ${index + 1}`,
      episodes,
      offset: 0,
      skippedEpisodes: parseEpisodeList(draft.skipped, episodes),
      seasonNumber: draft.seasonNumber ?? index + 1,
      airDate: draft.airDate.trim() === "" ? null : draft.airDate.trim(),
    };
  });
  recomputeOffsets(seasons);
  return seasons;
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

export class SeasonEditorModal extends Modal {
  private store: WatchLogStoreApi;
  private titleId: string;
  private drafts: SeasonDraft[];
  private rowsEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private onSaved: (() => void) | undefined;

  constructor(app: App, store: WatchLogStoreApi, title: TitleV4, onSaved?: () => void) {
    super(app);
    this.store = store;
    this.titleId = title.id;
    this.drafts = toDrafts(title.seasons);
    this.onSaved = onSaved;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-seasons-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Seasons" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Rows are the source of truth. Episode numbers are recalculated from the order, so moving or resizing a season keeps the rest lined up.",
    });

    const header = contentEl.createDiv({ cls: "wl-season-row is-header" });
    header.createSpan({ text: "Name" });
    header.createSpan({ text: "Episodes" });
    header.createSpan({ text: "Skipped" });
    header.createSpan({ text: "First aired" });
    header.createSpan({ text: "" });

    this.rowsEl = contentEl.createDiv({ cls: "wl-season-rows" });
    this.renderRows();

    const addRow = contentEl.createDiv({ cls: "wl-season-add" });
    const add = addRow.createEl("button", {
      cls: "wl-btn wl-small-btn",
      attr: { type: "button" },
    });
    const addIcon = add.createSpan({ cls: "wl-btn-icon" });
    setIcon(addIcon, "plus");
    add.createSpan({ cls: "wl-btn-label", text: "Add season" });
    add.addEventListener("click", () => {
      this.drafts.push({
        name: `Season ${this.drafts.length + 1}`,
        episodes: 10,
        skipped: "",
        airDate: "",
        seasonNumber: this.drafts.length + 1,
      });
      this.renderRows();
    });

    this.summaryEl = contentEl.createDiv({ cls: "wl-season-summary" });
    this.renderSummary();

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", {
        cls: "wl-btn mod-cta",
        text: "Save seasons",
        attr: { type: "button" },
      })
      .addEventListener("click", () => this.save());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderRows(): void {
    const host = this.rowsEl;
    if (!host) return;
    host.empty();

    this.drafts.forEach((draft, index) => {
      const row = host.createDiv({ cls: "wl-season-row" });

      const name = row.createEl("input", {
        cls: "wl-input",
        attr: { type: "text", "aria-label": `Season ${index + 1} name` },
      });
      name.value = draft.name;
      name.addEventListener("input", () => {
        draft.name = name.value;
      });

      const episodes = row.createEl("input", {
        cls: "wl-input",
        attr: { type: "number", min: "0", step: "1", "aria-label": `Season ${index + 1} episode count` },
      });
      episodes.value = String(draft.episodes);
      episodes.addEventListener("input", () => {
        draft.episodes = Math.max(0, Number(episodes.value) || 0);
        this.renderSummary();
      });

      const skipped = row.createEl("input", {
        cls: "wl-input",
        attr: {
          type: "text",
          placeholder: "e.g. 3, 5-7",
          "aria-label": `Season ${index + 1} skipped episodes`,
        },
      });
      skipped.value = draft.skipped;
      skipped.addEventListener("input", () => {
        draft.skipped = skipped.value;
        this.renderSummary();
      });

      renderDateInput(row, {
        format: this.store.settings.dateFormat,
        label: `Season ${index + 1} first air date`,
        value: draft.airDate === "" ? null : draft.airDate,
        onCommit: (value) => {
          draft.airDate = value ?? "";
        },
      });

      const remove = row.createEl("button", {
        cls: "wl-icon-btn",
        attr: { type: "button", "aria-label": `Remove ${draft.name}`, title: "Remove season" },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        this.drafts.splice(index, 1);
        this.renderRows();
        this.renderSummary();
      });
    });

    if (this.drafts.length === 0) {
      host.createDiv({
        cls: "wl-season-empty",
        text: "No seasons yet — add one, or leave it empty for a film.",
      });
    }
  }

  private renderSummary(): void {
    const el = this.summaryEl;
    if (!el) return;
    const seasons = fromDrafts(this.drafts);
    const total = totalFromSeasons(seasons);
    const skipped = seasons.reduce((sum, s) => sum + s.skippedEpisodes.length, 0);
    el.setText(
      skipped > 0
        ? `${total} episodes across ${seasons.length} season(s) — ${skipped} skipped, ${total - skipped} counted.`
        : `${total} episodes across ${seasons.length} season(s).`,
    );
  }

  private save(): void {
    const title = this.store.getTitle(this.titleId);
    if (!title) {
      new Notice("That title is no longer in your library.");
      this.close();
      return;
    }

    const seasons = fromDrafts(this.drafts);
    const totalEpisodes = Math.max(1, totalFromSeasons(seasons));
    const before = getWatchedCount(title);

    // `updateTitle` re-sanitises `watchedEpisodes` against the new shape, so
    // anything past the new end or newly skipped is dropped there, not here.
    this.store.updateTitle(this.titleId, { seasons, totalEpisodes }, "seasons-edited");

    const after = getWatchedCount(this.store.getTitle(this.titleId) ?? title);
    if (after < before) {
      new Notice(`${before - after} watched episode(s) no longer exist and were dropped.`);
    }

    this.onSaved?.();
    this.close();
  }
}
