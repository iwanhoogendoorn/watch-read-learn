/**
 * The CSV dialogs (SPEC2-PARITY.md §D-EXTRAS, item 3).
 *
 * Export is one screen. Import is four, and the order matters:
 *
 *     pick a file  →  check the column mapping  →  see what will happen  →  go
 *
 * A tracker export (Trakt, Letterboxd, Simkl, IMDb, Ryot) is a different animal
 * and gets its own three screens at the bottom of this file — no mapping step,
 * because its shape is known, and a much larger preview, because it merges into
 * a library rather than filling an empty one. Everything it decides lives in
 * `domains/import/`.
 *
 * v3's shape, and the reason it is right is the third screen: a CSV import is
 * irreversible from inside the plugin, so the last thing before writing is a
 * count of new rows, a count of duplicates, and a list of columns nobody claimed.
 * The progress bar is cancellable and the write is chunked, so a 4,000-row file
 * neither freezes Obsidian nor becomes an all-or-nothing gamble — cancelling
 * stops it where it is and says how far it got.
 *
 * Everything that decides anything is in `data/csv.ts`; this file is the screens.
 */
import { Modal, Notice, normalizePath, setIcon, type App } from "obsidian";
import {
  autoDetectMapping,
  buildImportPlan,
  coerceRow,
  exportFileName,
  exportGamesCsv,
  exportReadingCsv,
  exportWatchlistCsv,
  fieldsFor,
  indexExisting,
  parseCsv,
} from "../../data/csv";
import { createBook, createGame, createManga, createTitle, slugify, uniqueId } from "../../data/schema";
import { applyTrackerPlan } from "../import/apply";
import { buildTrackerPlan, type TrackerImportPlan } from "../import/plan";
import { detectSource, parseExport, readExportFile } from "../import/sources";
import { TRACKER_LABELS, TRACKER_SOURCES, type ImportRecord, type TrackerSource } from "../import/types";
import {
  READING_STATUSES,
  type CsvImportPlan,
  type ReadingStatus,
  type WatchLogStoreApi,
  type WidgetDomain,
} from "../../types";

/** What the user is exporting or importing. Reading splits into two shelves. */
export type CsvScope = "watchlist" | "books" | "manga" | "games";

const SCOPE_LABELS: Record<CsvScope, string> = {
  watchlist: "Watchlist",
  books: "Books",
  manga: "Manga",
  games: "Games",
};

function domainOf(scope: CsvScope): WidgetDomain {
  if (scope === "games") return "games";
  if (scope === "watchlist") return "watchlist";
  return "reading";
}

/** How many entries a scope holds right now, for the picker's subtitles. */
function countOf(store: WatchLogStoreApi, scope: CsvScope): number {
  if (scope === "watchlist") return store.allTitles().length;
  if (scope === "books") return store.reading.books.length;
  if (scope === "manga") return store.reading.manga.length;
  return store.games.games.length;
}

function serializeScope(store: WatchLogStoreApi, scope: CsvScope): string {
  if (scope === "watchlist") return exportWatchlistCsv(store.allTitles());
  if (scope === "books") return exportReadingCsv(store.reading.books);
  if (scope === "manga") return exportReadingCsv(store.reading.manga);
  return exportGamesCsv(store.games.games);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export class CsvExportModal extends Modal {
  private readonly store: WatchLogStoreApi;
  private csvScope: CsvScope = "watchlist";

  constructor(app: App, store: WatchLogStoreApi) {
    super(app);
    this.store = store;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-csv-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Export CSV" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "The watchlist export uses WatchLog v3's exact fourteen columns, so anything built on an older export keeps working. Books, manga and games export their own fields.",
    });

    const picker = contentEl.createDiv({ cls: "wl-csv-scopes" });
    const buttons = new Map<CsvScope, HTMLElement>();
    for (const scope of Object.keys(SCOPE_LABELS) as CsvScope[]) {
      const count = countOf(this.store, scope);
      const button = picker.createEl("button", {
        cls: `wl-btn wl-csv-scope${scope === this.csvScope ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      button.createDiv({ cls: "wl-csv-scope-label", text: SCOPE_LABELS[scope] });
      button.createDiv({
        cls: "wl-csv-scope-count",
        text: `${count} entr${count === 1 ? "y" : "ies"}`,
      });
      button.disabled = count === 0;
      button.addEventListener("click", () => {
        this.csvScope = scope;
        for (const [key, el] of buttons) el.toggleClass("is-active", key === scope);
      });
      buttons.set(scope, button);
    }

    const row = contentEl.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    row
      .createEl("button", { cls: "wl-btn", text: "Save in vault", attr: { type: "button" } })
      .addEventListener("click", () => void this.saveToVault());
    row
      .createEl("button", { cls: "wl-btn mod-cta", text: "Download", attr: { type: "button" } })
      .addEventListener("click", () => this.download());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private payload(): { text: string; name: string; count: number } {
    return {
      text: serializeScope(this.store, this.csvScope),
      name: exportFileName(domainOf(this.csvScope)),
      count: countOf(this.store, this.csvScope),
    };
  }

  private download(): void {
    const { text, name, count } = this.payload();
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8;" }));
    const anchor = createEl("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
    new Notice(`Exported ${count} entr${count === 1 ? "y" : "ies"}.`);
    this.close();
  }

  /**
   * The mobile-safe route: a browser download does not exist there, and a file
   * in the vault is something you can actually get at afterwards.
   */
  private async saveToVault(): Promise<void> {
    const { text, name, count } = this.payload();
    const folder = normalizePath(`${this.store.settings.rootFolder || "Watch Read Learn"}/exports`);
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const path = normalizePath(`${folder}/${name}`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) await this.app.vault.adapter.write(path, text);
      else await this.app.vault.create(path, text);
      new Notice(`Exported ${count} entr${count === 1 ? "y" : "ies"} to ${path}`);
      this.close();
    } catch (error) {
      console.error("[wrl] CSV export failed", error);
      new Notice("Could not write the export into your vault.");
    }
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type ImportStep = "source" | "mapping" | "preview" | "running";

/** How many rows are written between yields, so the progress bar can paint. */
const IMPORT_CHUNK = 25;

export class CsvImportModal extends Modal {
  private readonly store: WatchLogStoreApi;
  private readonly onDone: () => void;

  private step: ImportStep = "source";
  private csvScope: CsvScope = "watchlist";
  private rows: string[][] = [];
  private mapping: Record<string, string> = {};
  private skipDuplicates = true;
  private cancelled = false;
  private body: HTMLElement | null = null;

  constructor(app: App, store: WatchLogStoreApi, onDone: () => void) {
    super(app);
    this.store = store;
    this.onDone = onDone;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-csv-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Import CSV" });
    this.body = contentEl.createDiv({ cls: "wl-csv-body" });
    this.render();
  }

  override onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private render(): void {
    const host = this.body;
    if (!host) return;
    host.empty();
    if (this.step === "source") this.renderSource(host);
    else if (this.step === "mapping") this.renderMapping(host);
    else if (this.step === "preview") this.renderPreview(host);
  }

  // --- step 1: where the data comes from ----------------------------------

  private renderSource(host: HTMLElement): void {
    host.createEl("p", {
      cls: "wl-modal-message",
      text: "Pick a CSV file, or paste one in. Columns are matched to fields automatically; you get to check that on the next screen.",
    });

    const picker = host.createDiv({ cls: "wl-csv-scopes" });
    const buttons = new Map<CsvScope, HTMLElement>();
    for (const scope of Object.keys(SCOPE_LABELS) as CsvScope[]) {
      const button = picker.createEl("button", {
        cls: `wl-btn wl-csv-scope${scope === this.csvScope ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      button.createDiv({ cls: "wl-csv-scope-label", text: SCOPE_LABELS[scope] });
      button.addEventListener("click", () => {
        this.csvScope = scope;
        for (const [key, el] of buttons) el.toggleClass("is-active", key === scope);
      });
      buttons.set(scope, button);
    }

    const file = host.createEl("input", {
      cls: "wl-csv-file",
      attr: { type: "file", accept: ".csv,text/csv", "aria-label": "CSV file" },
    });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      void chosen.text().then((text) => this.accept(text));
    });

    // A tracker export is not a spreadsheet: it has no header row to map, it may
    // be a zip of six files, and it carries the external ids that make a match
    // exact. Sending it through the column mapper would work and would be much
    // worse, so the offer is made here, where someone with a `trakt-export.zip`
    // is actually looking.
    const handoff = host.createDiv({ cls: "wl-csv-handoff" });
    handoff.createSpan({ text: "Exported from Trakt, Letterboxd, Simkl, IMDb or Ryot? " });
    const link = handoff.createEl("button", {
      cls: "wl-btn",
      text: "Use the tracker importer",
      attr: { type: "button" },
    });
    link.addEventListener("click", () => {
      this.close();
      new TrackerImportModal(this.app, this.store, this.onDone).open();
    });

    host.createEl("p", { cls: "wl-modal-detail", text: "…or paste the file's contents:" });
    const paste = host.createEl("textarea", {
      cls: "wl-textarea",
      attr: { rows: "6", placeholder: "title,type,status,…", "aria-label": "CSV text" },
    });

    const row = host.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    row
      .createEl("button", { cls: "wl-btn mod-cta", text: "Continue", attr: { type: "button" } })
      .addEventListener("click", () => this.accept(paste.value));
  }

  private accept(text: string): void {
    const rows = parseCsv(text);
    if (rows.length < 2) {
      new Notice("That file has no data rows.");
      return;
    }
    this.rows = rows;
    this.mapping = autoDetectMapping(rows[0] ?? [], domainOf(this.csvScope));
    this.step = "mapping";
    this.render();
  }

  // --- step 2: mapping ----------------------------------------------------

  private renderMapping(host: HTMLElement): void {
    const headers = (this.rows[0] ?? []).map((header) => header.trim());
    const fields = fieldsFor(domainOf(this.csvScope));
    const detected = Object.keys(this.mapping).length;

    host.createEl("p", {
      cls: "wl-modal-message",
      text: `${detected} of ${headers.length} columns matched a field by name. Change anything that looks wrong; “Ignore” leaves a column out.`,
    });

    const table = host.createDiv({ cls: "wl-csv-map" });
    headers.forEach((header, index) => {
      if (header === "") return;
      const row = table.createDiv({ cls: "wl-csv-map-row" });
      row.createDiv({ cls: "wl-csv-map-header", text: header });
      const sample = (this.rows[1] ?? [])[index] ?? "";
      row.createDiv({ cls: "wl-csv-map-sample", text: sample === "" ? "—" : sample });

      const select = row.createEl("select", {
        cls: "wl-select",
        attr: { "aria-label": `Field for ${header}` },
      });
      select.createEl("option", { value: "", text: "Ignore" });
      for (const field of fields) {
        select.createEl("option", { value: field.key, text: field.label });
      }
      select.value = this.mapping[header] ?? "";
      select.addEventListener("change", () => {
        if (select.value === "") delete this.mapping[header];
        else {
          // One field, one column: claiming a field releases it elsewhere.
          for (const [other, field] of Object.entries(this.mapping)) {
            if (other !== header && field === select.value) delete this.mapping[other];
          }
          this.mapping[header] = select.value;
        }
        this.render();
      });
    });

    const row = host.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Back", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.step = "source";
        this.render();
      });
    const next = row.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Preview",
      attr: { type: "button" },
    });
    next.disabled = !Object.values(this.mapping).includes("title");
    if (next.disabled) {
      host.createDiv({
        cls: "wl-csv-warn",
        text: "One column has to be the title — nothing can be imported without a name.",
      });
    }
    next.addEventListener("click", () => {
      this.step = "preview";
      this.render();
    });
  }

  // --- step 3: preview ----------------------------------------------------

  private plan(): CsvImportPlan {
    const scope = this.csvScope;
    const entries =
      scope === "watchlist"
        ? this.store.allTitles()
        : scope === "books"
          ? this.store.reading.books
          : scope === "manga"
            ? this.store.reading.manga
            : this.store.games.games;
    return buildImportPlan(
      domainOf(scope),
      this.rows,
      this.mapping,
      indexExisting(entries as readonly { id: string; title: string }[]),
    );
  }

  private renderPreview(host: HTMLElement): void {
    const plan = this.plan();
    const duplicates = plan.rows.filter((row) => row.duplicateOf !== undefined).length;
    const fresh = plan.rows.length - duplicates;

    host.createEl("p", {
      cls: "wl-modal-message",
      text: `${plan.rows.length} row${plan.rows.length === 1 ? "" : "s"} ready for ${SCOPE_LABELS[this.csvScope]}: ${fresh} new, ${duplicates} already there by name.`,
    });

    if (plan.unmapped.length > 0) {
      host.createDiv({
        cls: "wl-csv-warn",
        text: `Not imported: ${plan.unmapped.join(", ")}.`,
      });
    }

    if (duplicates > 0) {
      const toggle = host.createEl("label", { cls: "wl-modal-check" });
      const box = toggle.createEl("input", { attr: { type: "checkbox" } });
      box.checked = this.skipDuplicates;
      box.addEventListener("change", () => {
        this.skipDuplicates = box.checked;
      });
      toggle.createSpan({ text: "Skip rows whose title already exists" });
    }

    const table = host.createDiv({ cls: "wl-csv-preview" });
    for (const row of plan.rows.slice(0, 12)) {
      const line = table.createDiv({
        cls: `wl-csv-preview-row${row.duplicateOf ? " is-duplicate" : ""}`,
      });
      line.createSpan({ cls: "wl-csv-preview-title", text: row.values.title ?? "(no title)" });
      const rest = Object.entries(row.values)
        .filter(([key]) => key !== "title")
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · ");
      line.createSpan({ cls: "wl-csv-preview-meta", text: rest });
      if (row.duplicateOf) {
        const flag = line.createSpan({ cls: "wl-csv-preview-flag" });
        setIcon(flag, "copy");
        flag.setAttribute(
          "title",
          row.duplicateSource === "file"
            ? "This file lists the same title earlier — the first one wins"
            : "Already in your library",
        );
      }
    }
    if (plan.rows.length > 12) {
      table.createDiv({ cls: "wl-csv-preview-more", text: `…and ${plan.rows.length - 12} more.` });
    }

    const row = host.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Back", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.step = "mapping";
        this.render();
      });
    row
      .createEl("button", { cls: "wl-btn mod-cta", text: "Import", attr: { type: "button" } })
      .addEventListener("click", () => void this.run(plan));
  }

  // --- step 4: the write --------------------------------------------------

  private async run(plan: CsvImportPlan): Promise<void> {
    const host = this.body;
    if (!host) return;
    this.step = "running";
    this.cancelled = false;
    host.empty();

    const queue = plan.rows.filter((row) => !(this.skipDuplicates && row.duplicateOf !== undefined));
    const label = host.createDiv({ cls: "wl-csv-progress-label", text: `0 of ${queue.length}` });
    const bar = host.createDiv({ cls: "wl-csv-progress" }).createDiv({ cls: "wl-csv-progress-fill" });

    const buttons = host.createDiv({ cls: "wl-modal-buttons" });
    const cancel = buttons.createEl("button", {
      cls: "wl-btn mod-warning",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.cancelled = true;
    });

    let written = 0;
    for (const row of queue) {
      if (this.cancelled) break;
      this.write(coerceRow(plan.domain, row.values));
      written += 1;
      if (written % IMPORT_CHUNK === 0) {
        label.setText(`${written} of ${queue.length}`);
        bar.style.width = `${Math.round((written / Math.max(1, queue.length)) * 100)}%`;
        // Yield so the bar actually paints and Cancel can be clicked.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }

    this.store.save("csv-import");
    this.store.emitChanged({ reason: "csv-import" });
    this.onDone();

    const skipped = plan.rows.length - queue.length;
    const suffix = skipped > 0 ? `, ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : "";
    new Notice(
      this.cancelled
        ? `Import cancelled after ${written} row${written === 1 ? "" : "s"}. What was written is kept.`
        : `Imported ${written} row${written === 1 ? "" : "s"}${suffix}.`,
    );
    this.close();
  }

  /** One row → one entity, through the frozen factories. */
  private write(values: Record<string, unknown>): void {
    const title = String(values.title ?? "").trim();
    if (title === "") return;
    const settings = this.store.settings;

    if (this.csvScope === "watchlist") {
      const type = String(values.type ?? "") || settings.types[0]?.name || "Movie";
      const status = String(values.status ?? "") || settings.statuses[0]?.name || "Plan to watch";
      const seed = { ...values, title, type, status } as Record<string, unknown>;
      // `studio` arrives from a spreadsheet, so it is the user's, not an API's.
      if (Array.isArray(seed.studio)) {
        seed.manualStudio = seed.studio;
        delete seed.studio;
      }
      this.store.addTitle(
        createTitle({
          ...(seed as Parameters<typeof createTitle>[0]),
          id: uniqueId(slugify(title), this.store.allTitles().map((entry) => entry.id)),
        }),
      );
      return;
    }

    if (this.csvScope === "games") {
      const taken = this.store.games.games.map((game) => game.id);
      this.store.games.games.push(
        createGame({
          ...(values as Parameters<typeof createGame>[0]),
          id: uniqueId(slugify(title), taken),
          title,
          status: String(values.status ?? "") || this.store.games.settings.defaultStatus,
        }),
      );
      return;
    }

    // Reading statuses are a **fixed** five (`READING_STATUSES`), so a
    // spreadsheet's "want to read" is dropped rather than written as a sixth
    // status nothing in the UI can render. Stripping it first matters: leaving
    // it in the seed would let the invalid string through the spread.
    const seed = { ...values };
    delete seed.status;
    const raw = String(values.status ?? "");
    const status = (READING_STATUSES as readonly string[]).includes(raw)
      ? (raw as ReadingStatus)
      : undefined;

    if (this.csvScope === "books") {
      const taken = this.store.reading.books.map((book) => book.id);
      this.store.reading.books.push(
        createBook({
          ...(seed as Parameters<typeof createBook>[0]),
          id: uniqueId(slugify(title), taken),
          title,
          ...(status ? { status } : {}),
        }),
      );
      return;
    }

    const taken = this.store.reading.manga.map((manga) => manga.id);
    this.store.reading.manga.push(
      createManga({
        ...(seed as Parameters<typeof createManga>[0]),
        id: uniqueId(slugify(title), taken),
        title,
        ...(status ? { status } : {}),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Tracker import (Trakt, Letterboxd, Simkl, IMDb, Ryot)
// ---------------------------------------------------------------------------

/**
 * The tracker importer.
 *
 * Three screens rather than the CSV importer's four, and the missing one is the
 * column mapper: a tracker export has a known shape, so there is nothing to map
 * and nothing for the user to get wrong. What replaces it is a *bigger* preview,
 * because the interesting question has moved. For a spreadsheet it was "did the
 * columns line up"; for an export of six thousand watch events landing on a
 * library someone has been curating for years it is **"what is this going to do
 * to what I already have"** — so the preview leads with how many titles would be
 * merged rather than added, says per title what would change, and names the
 * things it refuses to touch.
 *
 *     pick a file  →  see exactly what would happen  →  go
 *
 * Nothing is written until the last button. Everything before it is pure.
 */
export class TrackerImportModal extends Modal {
  private readonly store: WatchLogStoreApi;
  private readonly onDone: () => void;

  private step: "source" | "preview" | "running" = "source";
  private files: Map<string, string> = new Map();
  private fileLabel = "";
  private source: TrackerSource | null = null;
  private records: ImportRecord[] = [];
  private parseWarnings: string[] = [];
  private skipExisting = false;
  private cancelled = false;
  private body: HTMLElement | null = null;

  constructor(app: App, store: WatchLogStoreApi, onDone: () => void) {
    super(app);
    this.store = store;
    this.onDone = onDone;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-csv-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Import from a tracker" });
    this.body = contentEl.createDiv({ cls: "wl-csv-body" });
    this.render();
  }

  override onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private render(): void {
    const host = this.body;
    if (!host) return;
    host.empty();
    if (this.step === "source") this.renderSource(host);
    else if (this.step === "preview") this.renderPreview(host);
  }

  // --- step 1: the file ----------------------------------------------------

  private renderSource(host: HTMLElement): void {
    host.createEl("p", {
      cls: "wl-modal-message",
      text: "Pick the export file. Trakt's and Letterboxd's zips are read as they are — no need to unpack them. Nothing is written until you have seen what it would do.",
    });

    const file = host.createEl("input", {
      cls: "wl-csv-file",
      attr: {
        type: "file",
        accept: ".zip,.csv,.json,application/zip,text/csv,application/json",
        "aria-label": "Tracker export file",
      },
    });
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      void this.accept(chosen);
    });

    const list = host.createDiv({ cls: "wl-csv-sources" });
    list.createDiv({
      cls: "wl-modal-detail",
      text: "Trakt — the full export zip · Letterboxd — the data export zip · Simkl — the CSV backup · IMDb — a ratings or watchlist CSV · Ryot — the CompleteExport JSON",
    });

    const row = host.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  private async accept(chosen: File): Promise<void> {
    try {
      this.files = await readExportFile(chosen.name, await chosen.arrayBuffer());
    } catch (error) {
      console.error("[wrl] tracker import: could not read the file", error);
      new Notice(error instanceof Error ? error.message : "Could not read that file.");
      return;
    }
    this.fileLabel = chosen.name;
    this.source = detectSource(this.files);
    if (this.source === null) {
      new Notice("That file does not look like a Trakt, Letterboxd, Simkl, IMDb or Ryot export.");
      // Not fatal: the picker on the next screen lets the user say which it is.
      this.source = "imdb";
    }
    this.reparse();
    this.step = "preview";
    this.render();
  }

  private reparse(): void {
    if (this.source === null) return;
    const parsed = parseExport(this.source, this.files);
    this.records = parsed.records;
    this.parseWarnings = parsed.warnings;
  }

  // --- step 2: what would happen -------------------------------------------

  private plan(): TrackerImportPlan {
    return buildTrackerPlan(
      this.source ?? "imdb",
      this.records,
      this.store.allTitles(),
      this.store.settings,
      this.parseWarnings,
      { skipExisting: this.skipExisting },
    );
  }

  private renderPreview(host: HTMLElement): void {
    const plan = this.plan();
    const { add, merge, skip, exact, byName } = plan.counts;

    const picker = host.createDiv({ cls: "wl-csv-scopes" });
    for (const source of TRACKER_SOURCES) {
      const button = picker.createEl("button", {
        cls: `wl-btn wl-csv-scope${source === this.source ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      button.createDiv({ cls: "wl-csv-scope-label", text: TRACKER_LABELS[source] });
      button.addEventListener("click", () => {
        this.source = source;
        this.reparse();
        this.render();
      });
    }

    host.createEl("p", {
      cls: "wl-modal-message",
      text: `${this.fileLabel}: ${plan.entries.length} entr${plan.entries.length === 1 ? "y" : "ies"} — ${add} new, ${merge} merged into a title you already have, ${skip} with nothing to add.`,
    });
    host.createEl("p", {
      cls: "wl-modal-detail",
      text: `${exact} matched exactly, by TMDB or IMDb id. ${byName} could only be matched by name and year.`,
    });

    // The promise the whole flow rests on, stated where the decision is made.
    host.createDiv({
      cls: "wl-csv-warn wl-csv-safe",
      text: "Merging never overwrites your own data: a rating, review, note or watched episode you already have is left exactly as it is. A merge can only fill in what is empty and add episodes you have not ticked.",
    });

    for (const warning of plan.warnings) {
      host.createDiv({ cls: "wl-csv-warn", text: warning });
    }

    if (byName > 0) {
      // No lookup step here on purpose. `integration.ts:backfillTmdbIds` already
      // searches every title that lands without a `tmdbId`, and it is the
      // stricter path: an answer it is not sure about is recorded as
      // `tmdbMatch: "ambiguous"` and surfaces the manual picker, rather than
      // being guessed at here where nothing would remember that it was a guess.
      host.createDiv({
        cls: "wl-modal-detail",
        text: `The ${byName} name-only ${byName === 1 ? "entry is" : "entries are"} looked up against TMDB after the import, by the same matcher the rest of the library uses. Anything it cannot settle asks you to pick.`,
      });
    }

    const skipToggle = host.createEl("label", { cls: "wl-modal-check" });
    const skipBox = skipToggle.createEl("input", { attr: { type: "checkbox" } });
    skipBox.checked = this.skipExisting;
    skipBox.addEventListener("change", () => {
      this.skipExisting = skipBox.checked;
      this.render();
    });
    skipToggle.createSpan({ text: "Leave titles I already have completely untouched" });

    const table = host.createDiv({ cls: "wl-csv-preview" });
    for (const entry of plan.entries.slice(0, 12)) {
      const line = table.createDiv({
        cls: `wl-csv-preview-row${entry.action === "merge" ? " is-duplicate" : ""}`,
      });
      line.createSpan({ cls: "wl-csv-preview-title", text: entry.record.title });
      const detail =
        entry.action === "add"
          ? "new"
          : entry.action === "merge"
            ? `adds ${entry.changes.join(", ")}`
            : entry.mergedIntoPlanned === true
              // Not "nothing happened": its facts went into the entry above that
              // is creating this same title, so there is nothing left to write.
              ? "folded into the new entry above"
              : "already up to date";
      line.createSpan({ cls: "wl-csv-preview-meta", text: detail });
      if (entry.action !== "add") {
        const flag = line.createSpan({ cls: "wl-csv-preview-flag" });
        setIcon(flag, "copy");
        flag.setAttribute("title", `Matched by ${entry.matchedBy ?? "name"}`);
      }
    }
    if (plan.entries.length > 12) {
      table.createDiv({ cls: "wl-csv-preview-more", text: `…and ${plan.entries.length - 12} more.` });
    }

    const row = host.createDiv({ cls: "wl-modal-buttons" });
    row
      .createEl("button", { cls: "wl-btn", text: "Back", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.step = "source";
        this.render();
      });
    const go = row.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Import",
      attr: { type: "button" },
    });
    go.disabled = add + merge === 0;
    go.addEventListener("click", () => void this.run());
  }

  // --- step 3: the write ---------------------------------------------------

  private async run(): Promise<void> {
    const host = this.body;
    if (!host) return;
    this.step = "running";
    this.cancelled = false;
    host.empty();

    const label = host.createDiv({ cls: "wl-csv-progress-label", text: "Working…" });
    const bar = host.createDiv({ cls: "wl-csv-progress" }).createDiv({ cls: "wl-csv-progress-fill" });
    const buttons = host.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn mod-warning", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.cancelled = true;
      });

    const paint = (done: number, total: number, what: string): void => {
      label.setText(`${what}: ${done} of ${total}`);
      bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    };

    const plan = this.plan();
    const result = await applyTrackerPlan(this.store, plan, {
      onProgress: ({ done, total }) => paint(done, total, "Importing"),
      isCancelled: () => this.cancelled,
    });
    this.onDone();

    new Notice(
      result.cancelled
        ? `Import cancelled after ${result.added + result.merged} titles. What was written is kept.`
        : `Imported ${result.added} new title${result.added === 1 ? "" : "s"} and updated ${result.merged}.`,
    );
    this.close();
  }
}
