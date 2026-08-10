/**
 * "Which one is this?" — the manual TMDB match picker (QA2 report 1).
 *
 * The automatic backfill (`services/match.ts`) deliberately refuses to guess
 * when two candidates are equally plausible, so something has to let a human
 * settle it. This is that something: the Add modal's search, pointed at an
 * existing title instead of at a new one.
 *
 * It opens pre-searched on the title's own name, because in the overwhelming
 * majority of cases the right answer is the first row and the whole interaction
 * is one click.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type { MediaType, OverseerrClient, OverseerrSearchResult, TitleV4, WatchLogStoreApi } from "../../types";
import { renderProviderResult, type ResultFlag } from "../components/results";

const SEARCH_DEBOUNCE_MS = 300;

export interface MatchModalOptions {
  store: WatchLogStoreApi;
  client: OverseerrClient;
  title: TitleV4;
  /** Adopt this id for the title. The modal closes itself first. */
  onPicked: (tmdbId: number, mediaType: MediaType) => void;
}

export class MatchTitleModal extends Modal {
  private options: MatchModalOptions;
  private resultsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** A stale response whose generation lost is discarded, as in the Add modal. */
  private generation = 0;

  constructor(app: App, options: MatchModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    const title = this.options.title;
    modalEl.addClass("wl-modal", "wl-add-modal", "wl-match-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: `Match “${title.title}”` });
    contentEl.createDiv({
      cls: "wl-modal-note",
      text:
        "Watch, Read and Learn could not work out which title this is upstream, so it has no release schedule, " +
        "no new-season alerts and no reliable Plex match. Pick the right one and everything else follows.",
    });

    const wrap = contentEl.createDiv({ cls: "wl-searchbox wl-add-search" });
    const icon = wrap.createSpan({ cls: "wl-searchbox-icon" });
    setIcon(icon, "search");
    const input = wrap.createEl("input", {
      cls: "wl-searchbox-input",
      attr: {
        type: "search",
        placeholder: "Search Overseerr…",
        "aria-label": `Search for the real ${title.title}`,
        spellcheck: "false",
      },
    });
    input.value = title.tmdbMatch?.query ?? title.title;

    input.addEventListener("input", () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.runSearch(input.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      void this.runSearch(input.value);
    });

    this.statusEl = contentEl.createDiv({ cls: "wl-add-status" });
    this.resultsEl = contentEl.createDiv({ cls: "wl-add-results" });

    // Pre-searched: the answer is usually the first row.
    void this.runSearch(input.value);
    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.contentEl.empty();
  }

  private setStatus(text: string, tone: "" | "error" = ""): void {
    const el = this.statusEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-hidden", text === "");
  }

  private async runSearch(query: string): Promise<void> {
    const results = this.resultsEl;
    if (!results) return;
    const trimmed = query.trim();
    const generation = ++this.generation;

    if (trimmed === "") {
      results.empty();
      this.setStatus("");
      return;
    }

    this.setStatus("Searching…");
    try {
      const hits = await this.options.client.search(trimmed);
      if (generation !== this.generation) return;
      this.renderResults(hits);
    } catch (error) {
      if (generation !== this.generation) return;
      results.empty();
      this.setStatus(
        error instanceof Error ? `Search failed — ${error.message}` : "Search failed.",
        "error",
      );
    }
  }

  private renderResults(hits: OverseerrSearchResult[]): void {
    const host = this.resultsEl;
    if (!host) return;
    host.empty();

    if (hits.length === 0) {
      this.setStatus("Nothing found. Try a different spelling, or the original-language name.");
      return;
    }
    this.setStatus("");

    const title = this.options.title;
    const shortlisted = new Set((title.tmdbMatch?.candidates ?? []).map((c) => c.tmdbId));

    for (const hit of hits) {
      const flags: ResultFlag[] = [];
      if (shortlisted.has(hit.tmdbId)) flags.push({ text: "Likely", cls: "is-ok" });
      // Two tracked titles pointing at one TMDB id would make every upstream
      // refresh fight over the same data, so say so before it happens.
      const clash = this.options.store
        .allTitles()
        .find((other) => other.id !== title.id && other.tmdbId === hit.tmdbId);
      if (clash) flags.push({ text: `Used by “${clash.title}”`, cls: "is-tracked" });

      renderProviderResult(host, hit, {
        flags,
        onPick: () => {
          if (clash) {
            new Notice(`“${clash.title}” is already matched to that title.`);
            return;
          }
          this.close();
          this.options.onPicked(hit.tmdbId, hit.mediaType);
        },
      });
    }
  }
}
