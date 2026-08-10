/**
 * Groups in the Library: the chip row, the filter, and the bulk action.
 *
 * Mounted through `LibraryDeps.onMountExtras`, which is the one seam the Library
 * lends out. The Library still knows nothing about groups — it hands over a chip
 * host, a predicate slot and a bulk-bar button, and everything below decides
 * what those mean.
 *
 * The chips are the whole feature, really: one row above the results, one chip
 * per group with its size and its average rating, and clicking one narrows the
 * library to it. Clicking it again lets go. That is why the filter goes through
 * `setExtraFilter` rather than the facet state — a group is a *view* you step
 * into and out of, not a saved facet, and it must not end up baked into a preset
 * that then cannot be undone.
 */
import { Menu, Notice, setIcon, type App } from "obsidian";
import type { LibraryExtensions } from "../../ui/tabs/library";
import type { Group, WatchLogStoreApi } from "../../types";
import { GroupsModal } from "./modals";
import {
  addTitlesToGroup,
  createGroup,
  groupRating,
  pinnedGroupId,
  pruneGroups,
  removeTitlesFromGroup,
} from "./ops";

export interface GroupsExtensionDeps {
  app: App;
  store: WatchLogStoreApi;
}

export function mountGroupsExtension(
  ext: LibraryExtensions,
  deps: GroupsExtensionDeps,
): () => void {
  const { app, store } = deps;
  const chips = ext.chipsHost.createDiv({ cls: "wl-group-chips" });
  let activeId: string | null = null;

  // v3 data and hand-edited files can hold ids that no longer resolve; sweeping
  // once on mount keeps every count below honest.
  if (pruneGroups(store.data.groups, store.allTitles())) store.save("groups-pruned");

  function commit(reason: string): void {
    store.save(reason);
    store.emitChanged({ reason });
  }

  function applyFilter(): void {
    const group = store.data.groups.find((entry) => entry.id === activeId);
    if (!group) {
      activeId = null;
      ext.setExtraFilter(null);
      return;
    }
    const members = new Set(group.titleIds);
    ext.setExtraFilter((title) => members.has(title.id));
  }

  function select(id: string | null): void {
    activeId = activeId === id ? null : id;
    applyFilter();
    render();
    ext.refresh();
  }

  function render(): void {
    chips.empty();
    const groups = store.data.groups;
    const titles = store.allTitles();
    const pinned = pinnedGroupId(store.data);

    // Nothing to filter by yet — one button rather than an empty row that looks
    // like a broken toolbar.
    if (groups.length === 0) {
      const manage = chips.createEl("button", {
        cls: "wl-group-chip wl-group-chip-manage",
        attr: { type: "button", title: "Group titles into shelves" },
      });
      setIcon(manage.createSpan({ cls: "wl-group-chip-icon" }), "folder-plus");
      manage.createSpan({ cls: "wl-group-chip-label", text: "Groups" });
      manage.addEventListener("click", () => openManager());
      return;
    }

    const all = chips.createEl("button", {
      cls: `wl-group-chip${activeId === null ? " is-active" : ""}`,
      attr: { type: "button" },
    });
    all.createSpan({ cls: "wl-group-chip-label", text: "All" });
    all.addEventListener("click", () => {
      activeId = null;
      applyFilter();
      render();
      ext.refresh();
    });

    for (const group of groups) {
      const chip = chips.createEl("button", {
        cls: `wl-group-chip${group.id === activeId ? " is-active" : ""}`,
        attr: { type: "button" },
      });
      if (group.id === pinned) {
        setIcon(chip.createSpan({ cls: "wl-group-chip-icon" }), "pin");
      }
      chip.createSpan({ cls: "wl-group-chip-label", text: group.name });
      chip.createSpan({ cls: "wl-group-chip-count", text: String(group.titleIds.length) });
      const rating = groupRating(group, titles);
      if (rating !== null) {
        chip.createSpan({ cls: "wl-group-chip-rating", text: `★ ${rating}` });
      }
      chip.addEventListener("click", () => select(group.id));
      chip.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        openChipMenu(event, group);
      });
    }

    const manage = chips.createEl("button", {
      cls: "wl-group-chip wl-group-chip-manage",
      attr: { type: "button", "aria-label": "Manage groups", title: "Manage groups" },
    });
    setIcon(manage.createSpan({ cls: "wl-group-chip-icon" }), "settings-2");
    manage.addEventListener("click", () => openManager());
  }

  function openManager(): void {
    new GroupsModal(app, store, () => {
      applyFilter();
      render();
      ext.refresh();
    }).open();
  }

  function openChipMenu(event: MouseEvent, group: Group): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Edit titles…")
        .setIcon("list-plus")
        .onClick(() => openManager()),
    );
    const selection = ext.selection();
    if (selection.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(`Add ${selection.length} selected`)
          .setIcon("plus")
          .onClick(() => {
            const added = addTitlesToGroup(group, selection);
            commit("group-members-added");
            new Notice(`${added} added to “${group.name}”.`);
            render();
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle(`Remove ${selection.length} selected`)
          .setIcon("minus")
          .onClick(() => {
            const removed = removeTitlesFromGroup(group, selection);
            commit("group-members-removed");
            new Notice(`${removed} removed from “${group.name}”.`);
            render();
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  /**
   * The bulk action: tick a few cards, press Group, pick a shelf.
   *
   * This is how a group gets populated in practice — the member picker exists
   * for corrections, not for the first forty titles.
   */
  ext.addBulkAction("Group", "folder", (ids, event) => {
    if (ids.length === 0) {
      new Notice("Select some titles first.");
      return;
    }
    const menu = new Menu();
    for (const group of store.data.groups) {
      const inGroup = ids.filter((id) => group.titleIds.includes(id)).length;
      menu.addItem((item) =>
        item
          .setTitle(inGroup === ids.length ? `Remove from ${group.name}` : `Add to ${group.name}`)
          .setIcon(inGroup === ids.length ? "minus" : "plus")
          .onClick(() => {
            const count =
              inGroup === ids.length
                ? removeTitlesFromGroup(group, ids)
                : addTitlesToGroup(group, ids);
            commit("group-bulk");
            new Notice(
              inGroup === ids.length
                ? `${count} removed from “${group.name}”.`
                : `${count} added to “${group.name}”.`,
            );
            render();
            ext.exitSelectMode();
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("New group from selection…")
        .setIcon("folder-plus")
        .onClick(() => {
          const name = `Group ${store.data.groups.length + 1}`;
          const group = createGroup(store.data.groups, name);
          addTitlesToGroup(group, ids);
          commit("group-created");
          render();
          ext.exitSelectMode();
          // Straight into the manager so the placeholder name gets replaced
          // while the user still remembers what they picked.
          openManager();
        }),
    );
    menu.showAtMouseEvent(event);
  });

  render();

  return () => {
    chips.remove();
  };
}
