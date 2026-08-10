/**
 * The Lists tab (SPEC2-PARITY.md §D-EXTRAS, item 1).
 *
 * Free-form tables that live in the vault as notes rather than in `data.json` —
 * "everything I have not decided about yet", "watched with Dad", "the shelf".
 * The point of them is that they are *not* the library: no statuses, no
 * progress, no API, just columns you invent and rows you type.
 *
 * Every v3 affordance is here because each one is load-bearing for that use:
 * draggable sub-tabs with a colour (the tab bar is the index), double-click
 * rename, per-list columns, search, sort, duplicate-a-row (the reason people
 * keep lists in spreadsheets), and copy/paste in and out.
 *
 * Writes go straight to the file, debounced by the manager's per-list queue.
 * `data.json` never learns these exist — the only thing stored there is the tab
 * order, because that is a preference and not data.
 */
import { Notice, setIcon, type App, type EventRef, type TAbstractFile, type TFile } from "obsidian";
import type { CustomList, CustomListColumn, TabController, WatchLogStoreApi } from "../../types";
import { confirmAction } from "../../ui/modals/confirm";
import {
  createRow,
  duplicateRow,
  editableColumns,
  filterSortRows,
  isLockedColumn,
  parseCustomList,
  rowName,
  type SortDir,
} from "./format";
import { buildExportTable, toMarkdownTable, toTsv } from "./export";
import { CustomListManager } from "./manager";
import {
  ListColumnsModal,
  ListExportModal,
  ListImportModal,
  ListNameModal,
} from "./modals";

export interface ListsDeps {
  app: App;
  store: WatchLogStoreApi;
}

export function mountListsTab(container: HTMLElement, deps: ListsDeps): TabController {
  const { app, store } = deps;
  const settings = store.settings;
  const manager = new CustomListManager(app, () => settings.customListsFolder);

  const el = container.createDiv({ cls: "wl-tab-panel wl-tab-panel-lists wl-lists" });
  const tabsHost = el.createDiv({ cls: "wl-list-tabs" });
  const bodyHost = el.createDiv({ cls: "wl-list-body" });

  let names: string[] = [];
  let active: string | null = null;
  let current: CustomList | null = null;
  let query = "";
  let sortColumn: string | null = null;
  let sortDir: SortDir = "asc";
  /** Rows just cloned, highlighted until they are renamed — v3's cue. */
  const duplicated = new Set<string>();
  let generation = 0;
  let destroyed = false;
  const watchers: EventRef[] = [];

  /** Saved tab order first, then anything new, so a fresh list is never lost. */
  function applyTabOrder(found: string[]): string[] {
    const saved = (settings.customListTabOrder ?? []).filter((name) => found.includes(name));
    return [...saved, ...found.filter((name) => !saved.includes(name))];
  }

  function persistTabOrder(): void {
    settings.customListTabOrder = [...names];
    store.save("custom-list-order");
  }

  async function reload(): Promise<void> {
    const mine = ++generation;
    names = applyTabOrder(manager.listNames());
    if (active === null || !names.includes(active)) active = names[0] ?? null;
    current = active === null ? null : await manager.loadList(active);
    if (destroyed || mine !== generation) return;
    const colors = await manager.loadColors(names);
    if (destroyed || mine !== generation) return;
    renderTabs(colors);
    renderBody();
  }

  /**
   * Save the open list.
   *
   * The rejection is caught here and nowhere else: the manager has already told
   * the user (Notice) and kept the failure for `flush()`, so what is left is to
   * repaint — a merged save may have changed the rows under the cursor, and a
   * failed one leaves the tab showing an edit that is not on disk.
   */
  function save(): void {
    if (!current) return;
    void manager
      .saveList(current)
      .then(() => {
        if (!destroyed) renderBody();
      })
      .catch(() => {
        // The manager has already told the user and, if it gave up entirely,
        // parked their version. Repaint either way: a merged save may have moved
        // rows under the cursor, and a conflicted one must show its marker.
        if (!destroyed) {
          renderTabs(new Map());
          renderBody();
        }
      });
  }

  /**
   * The banner for a list whose edit could not be landed.
   *
   * Both versions exist — theirs on disk, ours parked in the manager — so the
   * only thing left is to say so and let the user choose. Silently keeping one
   * is what every earlier version of this code did wrong.
   */
  function renderConflictBanner(host: HTMLElement, name: string): void {
    const record = manager.conflictFor(name);
    if (!record) return;
    const panel = host.createDiv({ cls: "wl-list-conflict" });
    setIcon(panel.createSpan({ cls: "wl-list-conflict-icon" }), "alert-triangle");
    panel.createSpan({
      cls: "wl-list-conflict-text",
      text: `“${name}” is being changed somewhere else faster than the plugin can save. The version on disk is shown; your edit is kept aside.`,
    });
    const actions = panel.createDiv({ cls: "wl-list-conflict-actions" });

    const restore = actions.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Restore my version",
      attr: { type: "button" },
    });
    restore.addEventListener("click", () => {
      const parsed = parseCustomList(name, record.localText);
      if (!parsed.ok) {
        new Notice("That version could not be read back.");
        return;
      }
      manager.clearConflict(name);
      current = parsed.list;
      save();
    });

    const keep = actions.createEl("button", {
      cls: "wl-btn",
      text: "Keep the version on disk",
      attr: { type: "button" },
    });
    keep.addEventListener("click", () => {
      manager.clearConflict(name);
      void reload();
    });
  }

  /**
   * Watch the lists folder (W8 review P0-2).
   *
   * A list is a file, and a file can change without this tab: sync, another
   * device, the user in a markdown pane. The conflict-safe save is the guarantee
   * that nothing is *lost*; this is what keeps the screen honest in the meantime,
   * so the user is not editing a version that stopped existing minutes ago.
   */
  function watchFolder(): void {
    const folder = (): string => manager.folderPath;
    const affected = (file: TAbstractFile): boolean => {
      const path = file.path ?? "";
      return path.startsWith(`${folder()}/`) && path.endsWith(".md");
    };
    const onExternalChange = (file: TAbstractFile): void => {
      if (destroyed || !affected(file)) return;
      const name = file.path.slice(folder().length + 1).replace(/\.md$/, "");

      // Classify by CONTENT, never by timing (re-check P0-2).
      //
      // The previous version dropped every event that arrived while a save was
      // in flight, on the theory that it must be our own echo. A write from
      // another device that happens to land in that window is not an echo, and
      // discarding it meant our save replaced it with nobody any the wiser. So
      // the file is read and compared against the bytes the save intends to
      // leave: matching means ours, anything else is somebody else's and is
      // handed to the manager, which reconciles once its write settles.
      void (async () => {
        let current: string;
        try {
          current = await app.vault.read(file as TFile);
        } catch {
          // Deleted or unreadable: nothing to compare, so treat it as external.
          if (!destroyed) {
            manager.forget(name);
            void reload();
          }
          return;
        }
        if (destroyed || manager.isSelfWrite(name, current)) return;
        manager.noteExternalContent(name, current);
        // A write in flight will reconcile this itself; reloading underneath it
        // would show a state that is about to change again.
        if (manager.isWriting(name)) return;
        manager.forget(name);
        void reload();
      })();
    };

    // `rename` also hands over the old path; the extra argument is ignored
    // because either way the answer is "re-read the folder".
    watchers.push(app.vault.on("modify", (file) => onExternalChange(file)));
    watchers.push(app.vault.on("rename", (file) => onExternalChange(file)));
    watchers.push(app.vault.on("delete", (file) => onExternalChange(file)));
  }

  // -------------------------------------------------------------------------
  // Sub-tabs
  // -------------------------------------------------------------------------

  function renderTabs(colors: Map<string, string>): void {
    tabsHost.empty();
    let dragging: string | null = null;

    for (const name of names) {
      const tab = tabsHost.createDiv({
        cls: `wl-list-tab${name === active ? " is-active" : ""}`,
      });
      tab.setAttribute("draggable", "true");
      tab.dataset.list = name;

      const label = tab.createSpan({ cls: "wl-list-tab-name", text: name });
      const color = colors.get(name);
      if (color) label.style.color = color;
      label.setAttribute("title", "Double-click to rename");
      label.addEventListener("dblclick", (event: MouseEvent) => {
        event.stopPropagation();
        promptRename(name);
      });

      const remove = tab.createSpan({ cls: "wl-list-tab-del", text: "×" });
      remove.setAttribute("aria-label", `Delete ${name}`);
      remove.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        void promptDelete(name);
      });

      tab.addEventListener("click", () => {
        if (active === name) return;
        active = name;
        query = "";
        sortColumn = null;
        sortDir = "asc";
        duplicated.clear();
        void reload();
      });

      tab.addEventListener("dragstart", (event: DragEvent) => {
        dragging = name;
        event.dataTransfer?.setData("text/plain", name);
        tab.addClass("is-dragging");
      });
      tab.addEventListener("dragend", () => tab.removeClass("is-dragging"));
      tab.addEventListener("dragover", (event: DragEvent) => {
        event.preventDefault();
        tab.addClass("is-drop-target");
      });
      tab.addEventListener("dragleave", () => tab.removeClass("is-drop-target"));
      tab.addEventListener("drop", (event: DragEvent) => {
        event.preventDefault();
        tab.removeClass("is-drop-target");
        if (dragging === null || dragging === name) return;
        const from = names.indexOf(dragging);
        const to = names.indexOf(name);
        if (from < 0 || to < 0) return;
        names.splice(to, 0, ...names.splice(from, 1));
        persistTabOrder();
        void reload();
      });
    }

    const add = tabsHost.createEl("button", {
      cls: "wl-btn wl-list-tab-add",
      attr: { type: "button", "aria-label": "New list", title: "New list" },
    });
    setIcon(add, "plus");
    add.addEventListener("click", () => promptCreate());
  }

  function promptCreate(): void {
    new ListNameModal(app, {
      heading: "New list",
      confirmText: "Create",
      taken: names,
      onSubmit: (name) => {
        void manager.createList(name).then((created) => {
          if (!created) {
            new Notice(`Could not create “${name}”.`);
            return;
          }
          names.push(name);
          persistTabOrder();
          active = name;
          void reload();
        });
      },
    }).open();
  }

  function promptRename(from: string): void {
    new ListNameModal(app, {
      heading: `Rename “${from}”`,
      confirmText: "Rename",
      initial: from,
      taken: names.filter((name) => name !== from),
      onSubmit: (to) => {
        void manager.renameList(from, to).then((ok) => {
          if (!ok) {
            new Notice(`Could not rename “${from}”.`);
            return;
          }
          names = names.map((name) => (name === from ? to : name));
          persistTabOrder();
          if (active === from) active = to;
          void reload();
        });
      },
    }).open();
  }

  async function promptDelete(name: string): Promise<void> {
    const list = name === active ? current : await manager.loadList(name);
    const rows = list?.rows.length ?? 0;
    const result = await confirmAction(app, {
      title: `Delete “${name}”?`,
      message:
        rows === 0
          ? "The list is empty; its note goes to the vault's trash."
          : `Its ${rows} row${rows === 1 ? "" : "s"} go with it. The note goes to the vault's trash, so it is recoverable there.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!result.confirmed) return;
    await manager.deleteList(name);
    names = names.filter((entry) => entry !== name);
    persistTabOrder();
    if (active === name) active = null;
    await reload();
  }

  // -------------------------------------------------------------------------
  // Body
  // -------------------------------------------------------------------------

  function renderBody(): void {
    bodyHost.empty();

    if (names.length === 0) {
      const empty = bodyHost.createDiv({ cls: "wl-list-empty" });
      setIcon(empty.createDiv({ cls: "wl-list-empty-icon" }), "list");
      empty.createDiv({ cls: "wl-list-empty-title", text: "No lists yet" });
      empty.createDiv({
        cls: "wl-list-empty-body",
        text: `Lists are notes under “${manager.folderPath}”. Anything already there — including lists WatchLog v3 wrote — shows up here as a tab.`,
      });
      const button = empty.createEl("button", {
        cls: "wl-btn mod-cta",
        attr: { type: "button" },
      });
      button.createSpan({ cls: "wl-btn-label", text: "Create your first list" });
      button.addEventListener("click", () => promptCreate());
      return;
    }

    if (!current) {
      const problem = bodyHost.createDiv({ cls: "wl-list-empty" });
      setIcon(problem.createDiv({ cls: "wl-list-empty-icon" }), "alert-triangle");
      problem.createDiv({ cls: "wl-list-empty-title", text: `Could not read “${active ?? ""}”` });
      problem.createDiv({
        cls: "wl-list-empty-body",
        text: manager.isCorrupt(active ?? "")
          ? "Its data block is not valid JSON. The file has been left exactly as it is — open it and fix the block, or delete the tab."
          : "The note behind this tab could not be read.",
      });
      return;
    }

    if (active !== null) renderConflictBanner(bodyHost, active);
    renderToolbar(current);
    renderTable(bodyHost.createDiv({ cls: "wl-list-tablewrap" }), current);
  }

  function renderToolbar(list: CustomList): void {
    const bar = bodyHost.createDiv({ cls: "wl-list-toolbar" });

    const search = bar.createEl("input", {
      cls: "wl-input wl-list-search",
      attr: { type: "text", placeholder: "Search names…", "aria-label": "Search this list" },
    });
    search.value = query;
    let debounce: number | null = null;
    search.addEventListener("input", () => {
      query = search.value;
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        redrawTable();
      }, 250);
    });

    const sortSelect = bar.createEl("select", {
      cls: "wl-select wl-list-sort",
      attr: { "aria-label": "Sort by" },
    });
    sortSelect.createEl("option", { value: "", text: "Unsorted" });
    sortSelect.createEl("option", { value: "name", text: "Name" });
    for (const column of editableColumns(list)) {
      sortSelect.createEl("option", { value: column.id, text: column.name || "(unnamed)" });
    }
    sortSelect.value = sortColumn ?? "";
    sortSelect.addEventListener("change", () => {
      sortColumn = sortSelect.value === "" ? null : sortSelect.value;
      redrawTable();
    });

    const dirButton = bar.createEl("button", {
      cls: "wl-btn wl-icon-btn",
      attr: { type: "button" },
    });
    const syncDir = (): void => {
      dirButton.empty();
      setIcon(dirButton, sortDir === "asc" ? "arrow-up-a-z" : "arrow-down-z-a");
      const label = sortDir === "asc" ? "Sorting A → Z" : "Sorting Z → A";
      dirButton.setAttribute("aria-label", label);
      dirButton.setAttribute("title", label);
    };
    syncDir();
    dirButton.addEventListener("click", () => {
      sortDir = sortDir === "asc" ? "desc" : "asc";
      syncDir();
      redrawTable();
    });

    bar.createDiv({ cls: "wl-list-toolbar-spacer" });

    const iconButton = (icon: string, label: string, onClick: () => void): void => {
      const button = bar.createEl("button", {
        cls: "wl-btn wl-icon-btn",
        attr: { type: "button", "aria-label": label, title: label },
      });
      setIcon(button, icon);
      button.addEventListener("click", onClick);
    };

    iconButton("columns-3", "Columns", () => {
      new ListColumnsModal(app, list, (columns) => {
        // Dropping a column drops its cells; nothing else in the row is touched.
        const kept = new Set(columns.map((column) => column.id));
        for (const row of list.rows) {
          for (const key of Object.keys(row)) {
            if (key === "id" || key === "name" || key === "checked") continue;
            if (!kept.has(key)) delete row[key];
          }
        }
        list.columns = columns;
        save();
        renderBody();
      }).open();
    });

    iconButton("copy", "Copy list", () => {
      const table = buildExportTable(list, query, sortColumn, sortDir);
      new ListExportModal(app, table, (format) => {
        const text = format === "tsv" ? toTsv(table) : toMarkdownTable(table);
        navigator.clipboard
          .writeText(text)
          .then(() => new Notice(`Copied ${table.rows.length} row(s).`))
          .catch(() => new Notice("Could not write to the clipboard."));
      }).open();
    });

    iconButton("clipboard-paste", "Paste rows", () => {
      new ListImportModal(app, list, () => {
        save();
        renderBody();
      }).open();
    });

    const addRow = bar.createEl("button", { cls: "wl-btn mod-cta", attr: { type: "button" } });
    setIcon(addRow.createSpan({ cls: "wl-btn-icon" }), "plus");
    addRow.createSpan({ cls: "wl-btn-label", text: "Row" });
    addRow.addEventListener("click", () => {
      list.rows.push(createRow(list.rows));
      save();
      redrawTable();
    });
  }

  let tableHost: HTMLElement | null = null;

  function redrawTable(): void {
    if (!tableHost || !current) return;
    tableHost.empty();
    renderTable(tableHost, current);
  }

  function renderTable(host: HTMLElement, list: CustomList): void {
    tableHost = host;
    const columns = editableColumns(list);
    const rows = filterSortRows(list, query, sortColumn, sortDir);

    host.createDiv({
      cls: "wl-list-count",
      text:
        rows.length === list.rows.length
          ? `${list.rows.length} row${list.rows.length === 1 ? "" : "s"}`
          : `${rows.length} of ${list.rows.length} rows`,
    });

    if (list.rows.length === 0) {
      host.createDiv({
        cls: "wl-list-emptyrows",
        text: "Nothing in this list yet. Add a row, or paste one in from a spreadsheet.",
      });
      return;
    }
    if (rows.length === 0) {
      host.createDiv({ cls: "wl-list-emptyrows", text: "No row matches that search." });
      return;
    }

    const table = host.createEl("table", { cls: "wl-list-table" });
    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { cls: "wl-list-th-tick", text: "" });
    head.createEl("th", { cls: "wl-list-th-num", text: "#" });
    head.createEl("th", { text: "Name" });
    for (const column of columns) {
      const th = head.createEl("th", { text: column.name || "(unnamed)" });
      if (column.width !== undefined) th.style.width = `${column.width}px`;
    }
    head.createEl("th", { cls: "wl-list-th-actions", text: "" });

    const body = table.createEl("tbody");
    rows.forEach((row, index) => {
      const id = String(row.id);
      const tr = body.createEl("tr", { cls: "wl-list-row" });
      tr.dataset.rowId = id;
      const checked = row.checked === true;
      tr.toggleClass("is-checked", checked);
      tr.toggleClass("is-duplicated", duplicated.has(id));

      const tick = tr.createEl("td", { cls: "wl-list-td-tick" }).createEl("button", {
        cls: `wl-list-tick${checked ? " is-on" : ""}`,
        attr: { type: "button", "aria-label": checked ? "Untick row" : "Tick row" },
      });
      setIcon(tick, checked ? "check-circle" : "circle");
      tick.addEventListener("click", () => {
        const target = list.rows.find((candidate) => candidate.id === id);
        if (!target) return;
        target.checked = target.checked !== true;
        save();
        redrawTable();
      });

      tr.createEl("td", { cls: "wl-list-td-num", text: String(index + 1) });

      renderCell(tr.createEl("td", { cls: "wl-list-td-name" }), list, id, "name", null);
      for (const column of columns) {
        renderCell(tr.createEl("td"), list, id, column.id, column);
      }

      const actions = tr.createEl("td", { cls: "wl-list-td-actions" });
      const duplicate = actions.createEl("button", {
        cls: "wl-btn wl-icon-btn",
        attr: { type: "button", "aria-label": "Duplicate row", title: "Duplicate row" },
      });
      setIcon(duplicate, "copy-plus");
      duplicate.addEventListener("click", () => {
        const copy = duplicateRow(list.rows, id);
        if (!copy) return;
        duplicated.add(String(copy.id));
        save();
        redrawTable();
      });

      const remove = actions.createEl("button", {
        cls: "wl-btn wl-icon-btn mod-warning",
        attr: { type: "button", "aria-label": "Delete row", title: "Delete row" },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", () => {
        list.rows = list.rows.filter((candidate) => candidate.id !== id);
        duplicated.delete(id);
        save();
        redrawTable();
      });
    });
  }

  /**
   * One cell, edited in place.
   *
   * Text/number/date are an input that commits on blur or Enter; select is a
   * dropdown; checkbox is a checkbox. Committing writes the whole list file,
   * which the manager's queue keeps in order.
   */
  function renderCell(
    td: HTMLElement,
    list: CustomList,
    rowId: string,
    key: string,
    column: CustomListColumn | null,
  ): void {
    const row = list.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;
    const raw = row[key];
    const type = column?.type ?? "text";

    const commit = (value: unknown): void => {
      if (value === "" || value === undefined) delete row[key];
      else row[key] = value;
      if (key === "name") duplicated.delete(rowId);
      save();
    };

    if (type === "checkbox") {
      const box = td.createEl("input", {
        cls: "wl-list-cell-check",
        attr: { type: "checkbox", "aria-label": column?.name ?? "" },
      });
      box.checked = raw === true;
      box.addEventListener("change", () => commit(box.checked ? true : ""));
      return;
    }

    if (type === "select") {
      const select = td.createEl("select", {
        cls: "wl-select wl-list-cell-select",
        attr: { "aria-label": column?.name ?? "" },
      });
      select.createEl("option", { value: "", text: "—" });
      for (const option of column?.options ?? []) {
        select.createEl("option", { value: option, text: option });
      }
      select.value = typeof raw === "string" ? raw : "";
      select.addEventListener("change", () => commit(select.value));
      return;
    }

    const input = td.createEl("input", {
      cls: "wl-input wl-list-cell",
      attr: {
        type: type === "number" ? "number" : type === "date" ? "date" : "text",
        "aria-label": column?.name ?? "Name",
      },
    });
    input.value = raw === undefined || raw === null ? "" : String(raw);
    if (key === "name" && duplicated.has(rowId)) input.addClass("is-duplicated");
    const commitInput = (): void => {
      const value = input.value.trim();
      if (type === "number") commit(value === "" ? "" : Number(value));
      else commit(value);
    };
    input.addEventListener("blur", commitInput);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      input.blur();
    });
  }

  void reload();
  watchFolder();

  return {
    id: "lists",
    el,
    refresh(): void {
      void reload();
    },
    destroy(): void {
      destroyed = true;
      for (const ref of watchers) app.vault.offref(ref);
      watchers.length = 0;
      // An edit that never reached disk is the user's data: say so now, while
      // there is still a window in which they can do something about it.
      void manager.flush().catch(() => undefined);
      el.remove();
    },
  };
}
