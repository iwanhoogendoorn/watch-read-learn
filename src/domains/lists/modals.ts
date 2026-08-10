/**
 * The four dialogs the Lists tab needs: name a list, edit its columns, copy it
 * out, paste rows in.
 *
 * The import dialog is the one with opinions. v3 accepted a TSV paste and
 * silently invented text columns for anything wider than the table; this keeps
 * that (spreadsheets are how people actually get data in here) but refuses to
 * run while a number column is receiving words. A preview that says "5 rows × 4
 * columns, 1 new column will be created" before anything is written is the
 * difference between an import and an accident.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type { CustomList, CustomListColumn, CustomListColumnType } from "../../types";
import { editableColumns, generateColumnId, generateRowId } from "./format";

// ---------------------------------------------------------------------------
// Name a list
// ---------------------------------------------------------------------------

export class ListNameModal extends Modal {
  private value: string;
  private readonly taken: readonly string[];
  private readonly heading: string;
  private readonly confirmText: string;
  private readonly onSubmit: (name: string) => void;

  constructor(
    app: App,
    options: {
      heading: string;
      confirmText: string;
      initial?: string;
      taken: readonly string[];
      onSubmit: (name: string) => void;
    },
  ) {
    super(app);
    this.heading = options.heading;
    this.confirmText = options.confirmText;
    this.value = options.initial ?? "";
    this.taken = options.taken;
    this.onSubmit = options.onSubmit;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-listname-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: this.heading });

    const error = contentEl.createDiv({ cls: "wl-modal-error is-hidden" });
    const input = contentEl.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "List name", "aria-label": "List name" },
    });
    input.value = this.value;

    const submit = (): void => {
      const name = input.value.trim();
      if (name === "") {
        error.setText("Give the list a name.");
        error.removeClass("is-hidden");
        return;
      }
      // A list is a file, so a duplicate name is a duplicate path — caught here
      // rather than by a vault error the user cannot read.
      if (this.taken.includes(name)) {
        error.setText(`A list called “${name}” already exists.`);
        error.removeClass("is-hidden");
        return;
      }
      if (/[*"\\/<>:|?]/.test(name)) {
        error.setText("A list name cannot contain * \" \\ / < > : | or ?");
        error.removeClass("is-hidden");
        return;
      }
      this.close();
      this.onSubmit(name);
    };

    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") submit();
    });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", {
        cls: "wl-btn mod-cta",
        text: this.confirmText,
        attr: { type: "button" },
      })
      .addEventListener("click", submit);

    window.setTimeout(() => input.focus(), 0);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const COLUMN_TYPES: { value: CustomListColumnType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Select" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
];

/**
 * The column editor.
 *
 * Reordering is drag-and-drop on the whole card, and deleting a column says what
 * it will cost ("its values go with it") because the cell data is keyed by
 * column id — dropping the column drops the values, and the caller sweeps them.
 */
export class ListColumnsModal extends Modal {
  private readonly list: CustomList;
  private readonly onApply: (columns: CustomListColumn[]) => void;
  private draft: CustomListColumn[];
  private dragFrom = -1;
  private listEl: HTMLElement | null = null;

  constructor(app: App, list: CustomList, onApply: (columns: CustomListColumn[]) => void) {
    super(app);
    this.list = list;
    this.onApply = onApply;
    // Locked columns are v3's built-ins; they are not editable and not shown,
    // but they must survive the round trip.
    this.draft = list.columns.map((column) => ({ ...column }));
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-listcols-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `Columns — ${this.list.name}` });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Every list starts with a Name column. Add your own beside it; drag to reorder.",
    });

    this.listEl = contentEl.createDiv({ cls: "wl-listcols-rows" });
    this.renderRows();

    const add = contentEl.createEl("button", {
      cls: "wl-btn wl-listcols-add",
      attr: { type: "button" },
    });
    setIcon(add.createSpan({ cls: "wl-btn-icon" }), "plus");
    add.createSpan({ cls: "wl-btn-label", text: "Add column" });
    add.addEventListener("click", () => {
      this.draft.push({
        id: generateColumnId(this.draft),
        name: "",
        type: "text",
      });
      this.renderRows();
    });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", { cls: "wl-btn mod-cta", text: "Save", attr: { type: "button" } })
      .addEventListener("click", () => {
        // An unnamed column is a column the user abandoned mid-thought.
        const columns = this.draft.filter(
          (column) => column.name.trim() !== "" || column.id.startsWith("__"),
        );
        this.close();
        this.onApply(columns);
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderRows(): void {
    const host = this.listEl;
    if (!host) return;
    host.empty();

    const editable = this.draft.filter((column) => !("locked" in column));
    if (editable.length === 0) {
      host.createDiv({ cls: "wl-listcols-empty", text: "No columns yet." });
    }

    editable.forEach((column, index) => {
      const row = host.createDiv({ cls: "wl-listcols-row" });
      row.setAttribute("draggable", "true");
      row.addEventListener("dragstart", () => {
        this.dragFrom = index;
        row.addClass("is-dragging");
      });
      row.addEventListener("dragend", () => row.removeClass("is-dragging"));
      row.addEventListener("dragover", (event: DragEvent) => {
        event.preventDefault();
        row.addClass("is-drop-target");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
      row.addEventListener("drop", (event: DragEvent) => {
        event.preventDefault();
        row.removeClass("is-drop-target");
        this.move(this.dragFrom, index);
      });

      setIcon(row.createSpan({ cls: "wl-listcols-grip" }), "grip-vertical");

      const name = row.createEl("input", {
        cls: "wl-input",
        attr: { type: "text", placeholder: "Column name", "aria-label": "Column name" },
      });
      name.value = column.name;
      name.addEventListener("input", () => {
        column.name = name.value;
      });

      const type = row.createEl("select", { cls: "wl-select" });
      for (const option of COLUMN_TYPES) {
        type.createEl("option", { value: option.value, text: option.label });
      }
      type.value = column.type;

      const optionsInput = row.createEl("input", {
        cls: "wl-input wl-listcols-options",
        attr: { type: "text", placeholder: "Option, option, option", "aria-label": "Select options" },
      });
      optionsInput.value = (column.options ?? []).join(", ");
      const syncOptions = (): void => {
        optionsInput.toggleClass("is-hidden", column.type !== "select");
      };
      optionsInput.addEventListener("input", () => {
        column.options = optionsInput.value
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
      });
      syncOptions();

      type.addEventListener("change", () => {
        column.type = type.value as CustomListColumnType;
        if (column.type !== "select") delete column.options;
        syncOptions();
      });

      const remove = row.createEl("button", {
        cls: "wl-btn wl-icon-btn mod-warning",
        attr: { type: "button", "aria-label": "Delete column", title: "Delete column" },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        this.draft = this.draft.filter((c) => c.id !== column.id);
        this.renderRows();
      });
    });
  }

  private move(from: number, to: number): void {
    if (from < 0 || to < 0 || from === to) return;
    const moved = this.draft.splice(from, 1)[0];
    if (!moved) return;
    this.draft.splice(to, 0, moved);
    this.renderRows();
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ListExportFormat = "tsv" | "markdown";

export class ListExportModal extends Modal {
  private readonly preview: { headers: string[]; rows: string[][] };
  private readonly onChoose: (format: ListExportFormat) => void;

  constructor(
    app: App,
    preview: { headers: string[]; rows: string[][] },
    onChoose: (format: ListExportFormat) => void,
  ) {
    super(app);
    this.preview = preview;
    this.onChoose = onChoose;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-listexport-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Copy list" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: `${this.preview.rows.length} row${this.preview.rows.length === 1 ? "" : "s"} × ${this.preview.headers.length} columns, as they are filtered and sorted right now.`,
    });
    contentEl.createEl("p", {
      cls: "wl-modal-detail",
      text: "TSV pastes into a spreadsheet as columns. Markdown pastes into a note as a table.",
    });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", { cls: "wl-btn", text: "Copy as Markdown", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.close();
        this.onChoose("markdown");
      });
    buttons
      .createEl("button", { cls: "wl-btn mod-cta", text: "Copy as TSV", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.close();
        this.onChoose("tsv");
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface TsvAnalysis {
  header: string[];
  dataRows: string[][];
  rowCount: number;
  /** Widest row, header included. */
  totalColumns: number;
  /** Name + the list's editable columns. */
  existingColumns: number;
  newColumns: number;
  /** Select columns that would gain options, and which. */
  selectAdditions: { label: string; values: string[] }[];
  /** Number columns receiving something that is not a number. Blocks import. */
  numberConflicts: string[];
}

/** Split a pasted block into a header row and data rows. Pure. */
export function parseTsv(text: string, firstRowIsHeader: boolean): {
  header: string[];
  dataRows: string[][];
} | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const split = (line: string): string[] => line.split("\t").map((cell) => cell.trim());
  if (!firstRowIsHeader) return { header: [], dataRows: lines.map(split) };
  const [head, ...rest] = lines;
  return { header: split(head ?? ""), dataRows: rest.map(split) };
}

/**
 * What a paste would do to the list, before it does it. Pure, so the preview and
 * the apply cannot disagree.
 *
 * Column 0 is always the Name; columns 1..n line up with the list's editable
 * columns in order; anything wider becomes a new text column.
 */
export function analyseTsv(list: CustomList, parsed: {
  header: string[];
  dataRows: string[][];
}): TsvAnalysis | null {
  if (parsed.dataRows.length === 0) return null;
  const columns = editableColumns(list);
  const existingColumns = 1 + columns.length;
  const totalColumns = Math.max(
    parsed.header.length,
    ...parsed.dataRows.map((row) => row.length),
  );

  const numberConflicts = new Set<string>();
  const selectAdditions = new Map<number, { label: string; values: Set<string> }>();

  for (const row of parsed.dataRows) {
    for (let i = 1; i < row.length && i < existingColumns; i += 1) {
      const column = columns[i - 1];
      const value = row[i];
      if (!column || value === undefined || value === "") continue;
      if (column.type === "number") {
        if (!Number.isFinite(Number(value))) numberConflicts.add(column.name || "(unnamed)");
      } else if (column.type === "select") {
        const known = new Set(column.options ?? []);
        if (known.has(value)) continue;
        const entry = selectAdditions.get(i) ?? {
          label: column.name || "(unnamed)",
          values: new Set<string>(),
        };
        entry.values.add(value);
        selectAdditions.set(i, entry);
      }
    }
  }

  return {
    header: parsed.header,
    dataRows: parsed.dataRows,
    rowCount: parsed.dataRows.length,
    totalColumns,
    existingColumns,
    newColumns: Math.max(0, totalColumns - existingColumns),
    selectAdditions: [...selectAdditions.values()].map((entry) => ({
      label: entry.label,
      values: [...entry.values],
    })),
    numberConflicts: [...numberConflicts],
  };
}

/**
 * Apply an analysed paste to the list, in place. Pure apart from the mutation.
 *
 * Returns the number of rows appended.
 */
export function applyTsv(list: CustomList, analysis: TsvAnalysis): number {
  const columns = editableColumns(list);
  const created: CustomListColumn[] = [];

  for (let i = analysis.existingColumns; i < analysis.totalColumns; i += 1) {
    const label = (analysis.header[i] ?? "").trim() || `Column ${i + 1}`;
    const column: CustomListColumn = {
      id: generateColumnId([...list.columns, ...created]),
      name: label,
      type: "text",
    };
    created.push(column);
  }
  list.columns.push(...created);

  for (const addition of analysis.selectAdditions) {
    const column = columns.find(
      (c) => (c.name || "(unnamed)") === addition.label && c.type === "select",
    );
    if (!column) continue;
    column.options = [...(column.options ?? [])];
    for (const value of addition.values) {
      if (!column.options.includes(value)) column.options.push(value);
    }
  }

  const targets: (CustomListColumn | "name")[] = ["name", ...columns, ...created];
  for (const source of analysis.dataRows) {
    const row: Record<string, unknown> = { id: generateRowId(list.rows), name: "" };
    list.rows.push(row);
    for (let i = 0; i < analysis.totalColumns; i += 1) {
      const target = targets[i];
      if (!target) continue;
      const value = (source[i] ?? "").trim();
      if (target === "name") {
        row.name = value;
        continue;
      }
      if (value === "") continue;
      row[target.id] = target.type === "number" ? Number(value) : value;
    }
  }

  return analysis.rowCount;
}

export class ListImportModal extends Modal {
  private readonly list: CustomList;
  private readonly onApplied: (added: number) => void;
  private firstRowIsHeader = true;
  private textarea: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private addButton: HTMLButtonElement | null = null;

  constructor(app: App, list: CustomList, onApplied: (added: number) => void) {
    super(app);
    this.list = list;
    this.onApplied = onApplied;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-listimport-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `Paste rows into ${this.list.name}` });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Tab-separated values, copied straight out of a spreadsheet. The first column is the Name; rows are appended and numbered for you, so leave the # column out.",
    });

    this.textarea = contentEl.createEl("textarea", {
      cls: "wl-textarea wl-listimport-input",
      attr: { rows: "8", placeholder: "Paste here…", "aria-label": "Rows to import" },
    });
    this.textarea.addEventListener("input", () => this.refresh());

    const toggle = contentEl.createEl("label", { cls: "wl-modal-check" });
    const box = toggle.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.firstRowIsHeader;
    box.addEventListener("change", () => {
      this.firstRowIsHeader = box.checked;
      this.refresh();
    });
    toggle.createSpan({ text: "First row holds column names" });

    this.previewEl = contentEl.createDiv({ cls: "wl-listimport-preview" });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    buttons
      .createEl("button", { cls: "wl-btn", text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    this.addButton = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Add rows",
      attr: { type: "button" },
    });
    this.addButton.addEventListener("click", () => this.apply());

    this.refresh();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private analyse(): TsvAnalysis | null {
    const text = this.textarea?.value ?? "";
    const parsed = parseTsv(text, this.firstRowIsHeader);
    if (!parsed) return null;
    return analyseTsv(this.list, parsed);
  }

  private refresh(): void {
    const host = this.previewEl;
    if (!host) return;
    host.empty();

    const analysis = this.analyse();
    if (!analysis) {
      if (this.addButton) this.addButton.disabled = true;
      host.createDiv({ cls: "wl-listimport-count", text: "Nothing pasted yet." });
      return;
    }

    host.createDiv({
      cls: "wl-listimport-count",
      text: `${analysis.rowCount} row${analysis.rowCount === 1 ? "" : "s"} × ${analysis.totalColumns} column${analysis.totalColumns === 1 ? "" : "s"}.`,
    });

    if (analysis.newColumns > 0) {
      host.createDiv({
        cls: "wl-listimport-warn",
        text: `${analysis.newColumns} new text column${analysis.newColumns === 1 ? "" : "s"} will be created to hold the extra data.`,
      });
    }
    for (const addition of analysis.selectAdditions) {
      host.createDiv({
        cls: "wl-listimport-warn",
        text: `“${addition.label}” gains ${addition.values.length} option${addition.values.length === 1 ? "" : "s"}: ${addition.values.join(", ")}.`,
      });
    }
    if (analysis.totalColumns < analysis.existingColumns) {
      host.createDiv({
        cls: "wl-listimport-warn",
        text: "Fewer columns than the table — the trailing cells stay empty.",
      });
    }
    for (const label of analysis.numberConflicts) {
      host.createDiv({
        cls: "wl-listimport-error",
        text: `The number column “${label}” is receiving text. Reorder the pasted columns, or change that column's type, then paste again.`,
      });
    }

    if (this.addButton) this.addButton.disabled = analysis.numberConflicts.length > 0;
  }

  private apply(): void {
    const analysis = this.analyse();
    if (!analysis || analysis.numberConflicts.length > 0) return;
    const added = applyTsv(this.list, analysis);
    this.close();
    this.onApplied(added);
    new Notice(`Added ${added} row${added === 1 ? "" : "s"}.`);
  }
}
