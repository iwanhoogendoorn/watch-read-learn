/**
 * The "we are not going to touch your file until you say so" modal.
 *
 * Two startup conditions put the plugin into read-only mode (SPEC §3.1), and
 * both of them are situations where writing is the destructive act:
 *
 *   - the v3 backup could not be written, so the only copy of the user's data is
 *     the file v4 is about to migrate over;
 *   - `data.json` exists and is valid JSON but migration could not recognise it,
 *     which in v3 meant "start from defaults" — i.e. overwrite it with nothing.
 *
 * In both cases the plugin keeps running, keeps every change in memory, and asks
 * rather than assumes. The actions are supplied by the caller so this module
 * never learns what a backup or a migration is.
 */
import { Modal, setIcon, type App } from "obsidian";

export interface RecoveryAction {
  label: string;
  /** One sentence under the button saying what it actually does. */
  description?: string;
  danger?: boolean;
  /** Run on click. The modal closes first, so a follow-up modal can open. */
  run: () => void | Promise<void>;
}

export interface RecoveryOptions {
  title: string;
  message: string;
  /** Extra paragraphs — the file path, the underlying error, and so on. */
  details?: string[];
  actions: RecoveryAction[];
  /** The label of the do-nothing option. Defaults to "Leave it for now". */
  dismissLabel?: string;
  /**
   * Called when the modal closes without any action being chosen — dismiss
   * button, Esc, or a click outside. A caller that *awaits* a decision needs
   * this: without it, "the user pressed Esc" is indistinguishable from "the
   * user is still thinking", and an await on the answer never returns.
   */
  onDismiss?: () => void;
}

export class RecoveryModal extends Modal {
  /** Set the moment an action is chosen, so closing does not read as a dismiss. */
  private acted = false;

  constructor(
    app: App,
    private readonly options: RecoveryOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-recovery-modal");
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "wl-recovery-head" });
    const icon = head.createSpan({ cls: "wl-recovery-icon" });
    setIcon(icon, "shield-alert");
    head.createEl("h3", { cls: "wl-modal-title", text: this.options.title });

    contentEl.createDiv({ cls: "wl-modal-message", text: this.options.message });
    for (const detail of this.options.details ?? []) {
      contentEl.createDiv({ cls: "wl-modal-detail", text: detail });
    }

    const list = contentEl.createDiv({ cls: "wl-recovery-actions" });
    for (const action of this.options.actions) {
      const row = list.createDiv({ cls: "wl-recovery-action" });
      const button = row.createEl("button", {
        cls: `wl-btn ${action.danger ? "mod-warning" : "mod-cta"}`,
        text: action.label,
        attr: { type: "button" },
      });
      button.addEventListener("click", () => {
        this.acted = true;
        this.close();
        void action.run();
      });
      if (action.description) {
        row.createDiv({ cls: "wl-recovery-action-desc", text: action.description });
      }
    }

    const footer = contentEl.createDiv({ cls: "wl-modal-buttons" });
    footer
      .createEl("button", {
        cls: "wl-btn",
        text: this.options.dismissLabel ?? "Leave it for now",
        attr: { type: "button" },
      })
      .addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.acted) this.options.onDismiss?.();
  }
}

export function openRecovery(app: App, options: RecoveryOptions): void {
  new RecoveryModal(app, options).open();
}
