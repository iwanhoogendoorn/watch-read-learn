/**
 * Confirmation modal.
 *
 * Two things it does that a bare `confirm()` cannot: it states the *consequence*
 * ("its 3 seasons and 33 watched episodes go with it"), and it can carry one
 * optional checkbox for a secondary decision ("also delete its note"). Foodspot's
 * delete dialog is the model — the message ends by saying what is recoverable.
 */
import { Modal, type App } from "obsidian";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Extra lines rendered under the message, one paragraph each. */
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  /** Red-tint the confirm button. */
  danger?: boolean;
  /** Optional secondary decision; its state comes back in the result. */
  checkbox?: { label: string; default?: boolean };
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

class ConfirmModal extends Modal {
  private options: ConfirmOptions;
  private resolve: (result: ConfirmResult) => void;
  private checked: boolean;
  private settled = false;

  constructor(app: App, options: ConfirmOptions, resolve: (result: ConfirmResult) => void) {
    super(app);
    this.options = options;
    this.resolve = resolve;
    this.checked = options.checkbox?.default ?? false;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-confirm-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: this.options.title });
    contentEl.createEl("p", { cls: "wl-modal-message", text: this.options.message });
    for (const line of this.options.details ?? []) {
      contentEl.createEl("p", { cls: "wl-modal-detail", text: line });
    }

    if (this.options.checkbox) {
      const row = contentEl.createEl("label", { cls: "wl-modal-check" });
      const box = row.createEl("input", { attr: { type: "checkbox" } });
      box.checked = this.checked;
      box.addEventListener("change", () => {
        this.checked = box.checked;
      });
      row.createSpan({ text: this.options.checkbox.label });
    }

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    const cancel = buttons.createEl("button", {
      cls: "wl-btn",
      text: this.options.cancelText ?? "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.settle(false));

    const confirm = buttons.createEl("button", {
      cls: `wl-btn mod-cta ${this.options.danger ? "mod-warning" : ""}`.trim(),
      text: this.options.confirmText ?? "Confirm",
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => this.settle(true));
    confirm.focus();
  }

  override onClose(): void {
    // Dismissing with Escape or the × is a "no", not a hang.
    this.settle(false);
    this.contentEl.empty();
  }

  private settle(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve({ confirmed, checked: this.checked });
    this.close();
  }
}

/** Resolves `{confirmed:false}` on Escape, the × and the backdrop. Never hangs. */
export function confirmAction(app: App, options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise<ConfirmResult>((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}
