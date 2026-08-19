/**
 * The custom-columns editor — one per sub-tab (v3 kept `bookColumns` and
 * `mangaColumns` separately, and so does this).
 *
 * The only rule that needs stating: **deleting a column deletes the column, not
 * the data.** Values stay on the rows under the column's id, so a column removed
 * by accident comes back with everything in it if it is re-added with the same
 * id — and a v3 file whose columns were trimmed still round-trips its values.
 * That is why `withoutColumn` touches the definitions only.
 */
import { Modal, setIcon, type App } from "obsidian";
import type { CustomColumn, CustomColumnType, ReadingKind } from "../../../types";
import { confirmAction } from "../../../ui/modals/confirm";
import { sanitizeColor } from "../../../ui/components/pills";
import {
  BUILT_IN_COLUMNS,
  CUSTOM_COLUMN_TYPES,
  createColumn,
  replaceColumn,
  withoutColumn,
} from "../columns";

export interface ReadingColumnsOptions {
  kind: ReadingKind;
  getColumns: () => CustomColumn[];
  onChange: (columns: CustomColumn[]) => void;
  /** Built-in column ids the reader has switched off. Exclusion, not inclusion. */
  getHidden?: () => string[];
  /** Flip one built-in. Absent hides the section entirely. */
  onToggleBuiltIn?: (id: string) => void;
}

const TYPE_LABELS: Record<CustomColumnType, string> = {
  text: "Text",
  number: "Number",
  select: "Select",
};

export class ReadingColumnsModal extends Modal {
  private options: ReadingColumnsOptions;

  constructor(app: App, options: ReadingColumnsOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    this.modalEl.addClass("wl-modal", "wl-reading-columns-modal");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private commit(columns: CustomColumn[]): void {
    this.options.onChange(columns);
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", {
      cls: "wl-modal-title",
      text: this.options.kind === "book" ? "Book columns" : "Manga columns",
    });
    this.renderBuiltIns(contentEl);

    contentEl.createDiv({ cls: "wl-reading-section-label", text: "Your columns" });
    contentEl.createDiv({
      cls: "wl-reading-hint",
      text: "Columns show in the table and in each entry. Removing one keeps what you already typed in it.",
    });

    const columns = this.options.getColumns();
    const list = contentEl.createDiv({ cls: "wl-reading-column-list" });
    if (columns.length === 0) {
      list.createDiv({ cls: "wl-empty-body", text: "No columns yet." });
    }
    for (const column of columns) this.renderRow(list, column);

    this.renderAdd(contentEl);

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    const done = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Done",
      attr: { type: "button" },
    });
    done.addEventListener("click", () => this.close());
  }

  /**
   * The columns that are always available because the row always answers them.
   *
   * They get a tick rather than the name/type/colour/delete row a custom column
   * gets: there is nothing to rename, nothing to retype, and deleting a year
   * would mean deleting a release date. The only question a built-in has is
   * whether you want to look at it.
   */
  private renderBuiltIns(host: HTMLElement): void {
    const onToggle = this.options.onToggleBuiltIn;
    if (!onToggle || BUILT_IN_COLUMNS.length === 0) return;
    const hidden = this.options.getHidden?.() ?? [];

    host.createDiv({ cls: "wl-reading-section-label", text: "Always available" });
    const list = host.createDiv({ cls: "wl-reading-builtin-list" });
    for (const column of BUILT_IN_COLUMNS) {
      const row = list.createDiv({ cls: "wl-reading-builtin-row" });
      const box = row.createEl("input", {
        attr: { type: "checkbox", "aria-label": `Show the ${column.name} column` },
      });
      box.checked = !hidden.includes(column.id);
      box.addEventListener("change", () => {
        onToggle(column.id);
        this.render();
      });
      row.createSpan({ cls: "wl-reading-builtin-name", text: column.name });
    }
  }

  private renderRow(host: HTMLElement, column: CustomColumn): void {
    const row = host.createDiv({ cls: "wl-reading-column-row" });

    const name = row.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", "aria-label": "Column name" },
    });
    name.value = column.name;
    name.addEventListener("change", () => {
      const value = name.value.trim();
      if (value === "" || value === column.name) return;
      this.commit(replaceColumn(this.options.getColumns(), { ...column, name: value }));
    });

    const type = row.createEl("select", { cls: "wl-select" });
    type.setAttribute("aria-label", "Column type");
    for (const value of CUSTOM_COLUMN_TYPES) {
      type.createEl("option", { value, text: TYPE_LABELS[value] });
    }
    type.value = column.type;
    type.addEventListener("change", () => {
      this.commit(
        replaceColumn(this.options.getColumns(), {
          ...column,
          type: type.value as CustomColumnType,
        }),
      );
    });

    const color = row.createEl("input", {
      cls: "wl-reading-color",
      attr: { type: "color", "aria-label": `Colour for ${column.name}` },
    });
    color.value = sanitizeColor(column.color ?? "") || "#7F77DD";
    color.addEventListener("change", () => {
      this.commit(replaceColumn(this.options.getColumns(), { ...column, color: color.value }));
    });

    if (column.type === "select") {
      const options = row.createEl("input", {
        cls: "wl-input wl-reading-column-options",
        attr: {
          type: "text",
          "aria-label": `Options for ${column.name}`,
          placeholder: "Comma-separated options",
        },
      });
      options.value = (column.options ?? []).join(", ");
      options.addEventListener("change", () => {
        const next = options.value
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        this.commit(replaceColumn(this.options.getColumns(), { ...column, options: next }));
      });
    }

    const remove = row.createEl("button", {
      cls: "wl-btn wl-icon-btn mod-warning",
      attr: { type: "button", "aria-label": `Remove ${column.name}`, title: "Remove column" },
    });
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => {
      void confirmAction(this.app, {
        title: `Remove the “${column.name}” column?`,
        message: "The column disappears from the table. What you typed into it stays on each entry.",
        confirmText: "Remove",
        danger: true,
      }).then((result) => {
        if (!result.confirmed) return;
        this.commit(withoutColumn(this.options.getColumns(), column.id));
      });
    });
  }

  private renderAdd(host: HTMLElement): void {
    const row = host.createDiv({ cls: "wl-reading-column-row" });
    const name = row.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "New column", "aria-label": "New column name" },
    });
    const type = row.createEl("select", { cls: "wl-select" });
    type.setAttribute("aria-label", "New column type");
    for (const value of CUSTOM_COLUMN_TYPES) {
      type.createEl("option", { value, text: TYPE_LABELS[value] });
    }

    const add = row.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Add column",
      attr: { type: "button" },
    });
    const commit = (): void => {
      const value = name.value.trim();
      if (value === "") {
        name.focus();
        return;
      }
      const columns = this.options.getColumns();
      this.commit([...columns, createColumn(value, type.value as CustomColumnType, columns)]);
    };
    add.addEventListener("click", commit);
    name.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
  }
}
