/**
 * The two group dialogs: manage the set of groups, and pick what is in one.
 *
 * Both are deliberately plain. A group is a name and a membership list, and the
 * interesting decisions (what the average rating means, what the pin does) are
 * in `ops.ts` — these screens just show them.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import type { Group, TitleV4, WatchLogStoreApi } from "../../types";
import { confirmAction } from "../../ui/modals/confirm";
import {
  addTitlesToGroup,
  createGroup,
  deleteGroup,
  groupRating,
  removeTitlesFromGroup,
  renameGroup,
  pinnedGroupId,
  togglePinnedGroup,
} from "./ops";

/** Membership editor: every title, searchable, ticked when it is in the group. */
export class GroupMembersModal extends Modal {
  private readonly store: WatchLogStoreApi;
  private readonly group: Group;
  private readonly onChanged: () => void;
  private query = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor(app: App, store: WatchLogStoreApi, group: Group, onChanged: () => void) {
    super(app);
    this.store = store;
    this.group = group;
    this.onChanged = onChanged;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-groupmembers-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `What is in “${this.group.name}”` });

    const search = contentEl.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "Search your library…", "aria-label": "Search titles" },
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });

    this.countEl = contentEl.createDiv({ cls: "wl-group-membercount" });
    this.listEl = contentEl.createDiv({ cls: "wl-group-memberlist" });
    this.renderList();

    contentEl
      .createDiv({ cls: "wl-modal-buttons" })
      .createEl("button", { cls: "wl-btn mod-cta", text: "Done", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderList(): void {
    const host = this.listEl;
    if (!host) return;
    host.empty();

    const needle = this.query.trim().toLowerCase();
    const titles = this.store
      .allTitles()
      .filter((title) => needle === "" || title.title.toLowerCase().includes(needle))
      // In-group first, so the modal opens on what is already there.
      .sort((a, b) => {
        const aIn = this.group.titleIds.includes(a.id);
        const bIn = this.group.titleIds.includes(b.id);
        if (aIn !== bIn) return aIn ? -1 : 1;
        return a.title.localeCompare(b.title);
      })
      .slice(0, 200);

    this.countEl?.setText(
      `${this.group.titleIds.length} in the group · ${this.store.allTitles().length} in the library`,
    );

    if (titles.length === 0) {
      host.createDiv({ cls: "wl-group-memberempty", text: "Nothing matches that." });
      return;
    }

    for (const title of titles) this.renderRow(host, title);
  }

  private renderRow(host: HTMLElement, title: TitleV4): void {
    const row = host.createEl("label", { cls: "wl-group-memberrow" });
    const box = row.createEl("input", { attr: { type: "checkbox" } });
    box.checked = this.group.titleIds.includes(title.id);
    row.createSpan({ cls: "wl-group-membername", text: title.title });
    row.createSpan({ cls: "wl-group-membermeta", text: title.type });
    box.addEventListener("change", () => {
      if (box.checked) addTitlesToGroup(this.group, [title.id]);
      else removeTitlesFromGroup(this.group, [title.id]);
      this.countEl?.setText(
        `${this.group.titleIds.length} in the group · ${this.store.allTitles().length} in the library`,
      );
      this.onChanged();
    });
  }
}

/** The list of groups: create, rename, delete, pin, and open the member editor. */
export class GroupsModal extends Modal {
  private readonly store: WatchLogStoreApi;
  private readonly onChanged: () => void;
  private body: HTMLElement | null = null;

  constructor(app: App, store: WatchLogStoreApi, onChanged: () => void) {
    super(app);
    this.store = store;
    this.onChanged = onChanged;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-groups-modal");
    contentEl.empty();
    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Groups" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "A group is a shelf: a trilogy, a rewatch list, everything you watch with someone. Its rating is the average of the members you have rated.",
    });

    this.body = contentEl.createDiv({ cls: "wl-groups-list" });
    this.renderList();

    const create = contentEl.createDiv({ cls: "wl-groups-create" });
    const input = create.createEl("input", {
      cls: "wl-input",
      attr: { type: "text", placeholder: "New group name", "aria-label": "New group name" },
    });
    const add = (): void => {
      const name = input.value.trim();
      if (name === "") return;
      if (this.store.data.groups.some((group) => group.name === name)) {
        new Notice(`There is already a group called “${name}”.`);
        return;
      }
      createGroup(this.store.data.groups, name);
      input.value = "";
      this.commit();
      this.renderList();
    };
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") add();
    });
    const button = create.createEl("button", { cls: "wl-btn mod-cta", attr: { type: "button" } });
    setIcon(button.createSpan({ cls: "wl-btn-icon" }), "plus");
    button.createSpan({ cls: "wl-btn-label", text: "Create" });
    button.addEventListener("click", add);

    contentEl
      .createDiv({ cls: "wl-modal-buttons" })
      .createEl("button", { cls: "wl-btn mod-cta", text: "Done", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private commit(): void {
    this.store.save("groups");
    this.store.emitChanged({ reason: "groups-changed" });
    this.onChanged();
  }

  private renderList(): void {
    const host = this.body;
    if (!host) return;
    host.empty();

    const groups = this.store.data.groups;
    if (groups.length === 0) {
      host.createDiv({
        cls: "wl-groups-empty",
        text: "No groups yet. Name one below, then add titles to it — or tick a few in the library and use the Group button.",
      });
      return;
    }

    const titles = this.store.allTitles();
    const pinned = pinnedGroupId(this.store.data);

    for (const group of groups) {
      const row = host.createDiv({ cls: `wl-groups-row${group.id === pinned ? " is-pinned" : ""}` });

      const name = row.createEl("input", {
        cls: "wl-input wl-groups-name",
        attr: { type: "text", "aria-label": "Group name" },
      });
      name.value = group.name;
      name.addEventListener("change", () => {
        if (renameGroup(groups, group.id, name.value)) this.commit();
        else name.value = group.name;
      });

      const rating = groupRating(group, titles);
      row.createSpan({
        cls: "wl-groups-meta",
        text: `${group.titleIds.length} title${group.titleIds.length === 1 ? "" : "s"} · ${
          rating === null ? "unrated" : `★ ${rating}`
        }`,
      });

      const iconButton = (icon: string, label: string, onClick: () => void, warn = false): void => {
        const button = row.createEl("button", {
          cls: `wl-btn wl-icon-btn${warn ? " mod-warning" : ""}`,
          attr: { type: "button", "aria-label": label, title: label },
        });
        setIcon(button, icon);
        button.addEventListener("click", onClick);
      };

      iconButton("list-plus", "Choose titles", () => {
        new GroupMembersModal(this.app, this.store, group, () => {
          this.commit();
          this.renderList();
        }).open();
      });

      iconButton(group.id === pinned ? "pin-off" : "pin", group.id === pinned ? "Unpin" : "Pin", () => {
        togglePinnedGroup(this.store.data, group.id);
        this.commit();
        this.renderList();
      });

      iconButton(
        "trash-2",
        "Delete group",
        () => {
          void confirmAction(this.app, {
            title: `Delete “${group.name}”?`,
            message: "The group goes; the titles in it stay exactly where they are.",
            confirmText: "Delete",
            danger: true,
          }).then((result) => {
            if (!result.confirmed) return;
            deleteGroup(this.store.data, group.id);
            this.commit();
            this.renderList();
          });
        },
        true,
      );
    }
  }
}
