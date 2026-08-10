/**
 * The Steam import modal — fetch, **preview**, then write.
 *
 * The preview is the point. A Steam library is hundreds of games, an import that
 * just ran would be the single most destructive button in the plugin, and v3's
 * flow (fetch → show what will happen → confirm) is worth keeping exactly.
 * Every row says what it would do and can be unticked; nothing is written until
 * Import is pressed, and the writes then go through the store one at a time so a
 * failure halfway leaves a consistent library.
 *
 * Achievements are a second call per game, so they are fetched **only for the
 * rows being imported**, one at a time behind the client's rate limiter, with a
 * progress line and a Cancel that actually stops the loop.
 */
import { Modal, Notice, setIcon, type App } from "obsidian";
import { describeGameApiError, toGameApiError } from "../../../services/igdb";
import type { Game, GamesStoreApi, SteamClient, SteamOwnedGame } from "../../../types";
import { formatPlaytime } from "../stats";
import {
  gameFromSteam,
  planSteamImport,
  selectedRows,
  summarize,
  summaryText,
  type SteamImportRow,
} from "../steam-import";

export interface SteamImportOptions {
  store: GamesStoreApi;
  client: SteamClient;
  /** Called once, after everything is written. */
  onImported?: (summary: string) => void;
}

/** Rows above this are rendered lazily on scroll would be nice; this is simpler. */
const MAX_ROWS_RENDERED = 400;

export class SteamImportModal extends Modal {
  private store: GamesStoreApi;
  private client: SteamClient;
  private onImported: ((summary: string) => void) | undefined;

  private statusEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  private rows: SteamImportRow[] = [];
  private importing = false;
  private cancelled = false;
  /** Games whose playtime is below this are not offered. */
  private minMinutes = 0;

  constructor(app: App, options: SteamImportOptions) {
    super(app);
    this.store = options.store;
    this.client = options.client;
    this.onImported = options.onImported;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-game-modal", "wl-steam-modal");
    contentEl.empty();

    contentEl.createEl("h3", { cls: "wl-modal-title", text: "Import your Steam library" });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Nothing is written until you press Import. Your statuses, ratings and notes are never touched — only playtime, achievements, the Steam link and the store URL.",
    });

    this.statusEl = contentEl.createDiv({ cls: "wl-add-status" });
    this.listEl = contentEl.createDiv({ cls: "wl-steam-list" });
    this.footerEl = contentEl.createDiv({ cls: "wl-modal-buttons" });

    if (!this.client.configured()) {
      this.setStatus(
        "Steam is not configured. Settings → Games needs your Web API key and 64-bit Steam ID.",
        "error",
      );
      this.renderCloseOnly();
      return;
    }

    void this.fetch();
  }

  override onClose(): void {
    this.cancelled = true;
    this.contentEl.empty();
  }

  private setStatus(text: string, tone: "" | "error" = ""): void {
    const el = this.statusEl;
    if (!el) return;
    el.setText(text);
    el.toggleClass("is-error", tone === "error");
    el.toggleClass("is-hidden", text === "");
  }

  private async fetch(): Promise<void> {
    this.setStatus("Asking Steam what you own…");
    let owned: SteamOwnedGame[];
    try {
      owned = await this.client.ownedGames();
    } catch (error) {
      this.setStatus(describeGameApiError(toGameApiError(error, "steam")), "error");
      this.renderCloseOnly();
      return;
    }
    if (this.cancelled) return;

    this.rows = planSteamImport(owned, this.store.allGames(), {
      defaultStatus: this.store.games.settings.defaultStatus,
      minPlaytimeMinutes: this.minMinutes,
    });

    const summary = summarize(this.rows);
    this.setStatus(
      `${owned.length} game${owned.length === 1 ? "" : "s"} on Steam — ${summaryText(summary)}.`,
    );
    this.renderRows();
    this.renderFooter();
  }

  private renderRows(): void {
    const host = this.listEl;
    if (!host) return;
    host.empty();

    const shown = this.rows.slice(0, MAX_ROWS_RENDERED);
    for (const row of shown) {
      const el = host.createDiv({ cls: `wl-steam-row is-${row.action}` });

      const check = el.createEl("input", {
        cls: "wl-checkbox",
        attr: { type: "checkbox", "aria-label": `Import ${row.owned.title}` },
      });
      check.checked = row.selected;
      check.disabled = row.action === "skip";
      check.addEventListener("change", () => {
        row.selected = check.checked;
        this.renderFooter();
      });

      const body = el.createDiv({ cls: "wl-steam-row-body" });
      body.createDiv({ cls: "wl-steam-row-title", text: row.owned.title });
      const meta: string[] = [formatPlaytime(row.owned.playtimeMinutes)];
      if (row.owned.lastPlayed) meta.push(`last played ${row.owned.lastPlayed}`);
      body.createDiv({ cls: "wl-steam-row-meta", text: meta.join(" · ") });
      body.createDiv({ cls: "wl-steam-row-changes", text: row.changes.join(" · ") });

      const tag = el.createSpan({ cls: `wl-flag is-${row.action}` });
      tag.setText(row.action === "add" ? "New" : row.action === "update" ? "Update" : "Up to date");
    }

    if (this.rows.length > shown.length) {
      // Saying what was left out beats a list that silently stops.
      host.createDiv({
        cls: "wl-steam-more",
        text: `…and ${this.rows.length - shown.length} more, which will be imported too.`,
      });
    }
  }

  private renderFooter(): void {
    const host = this.footerEl;
    if (!host) return;
    host.empty();

    const chosen = selectedRows(this.rows);
    const label = chosen.length === 0 ? "Nothing selected" : `Import ${chosen.length}`;

    const cancel = host.createEl("button", {
      cls: "wl-btn",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => {
      this.cancelled = true;
      this.close();
    });

    const submit = host.createEl("button", {
      cls: "wl-btn mod-cta",
      text: label,
      attr: { type: "button" },
    });
    submit.disabled = chosen.length === 0 || this.importing;
    submit.addEventListener("click", () => {
      void this.runImport(chosen);
    });
  }

  private renderCloseOnly(): void {
    const host = this.footerEl;
    if (!host) return;
    host.empty();
    const close = host.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Close",
      attr: { type: "button" },
    });
    close.addEventListener("click", () => this.close());
  }

  private async runImport(rows: SteamImportRow[]): Promise<void> {
    this.importing = true;
    this.cancelled = false;
    this.renderProgressFooter();

    let added = 0;
    let updated = 0;
    let index = 0;

    for (const row of rows) {
      if (this.cancelled) break;
      index += 1;
      this.setStatus(`Importing ${index} of ${rows.length} — ${row.owned.title}…`);

      // One achievements call per game, behind the client's own limiter. A game
      // with no achievement schema answers "undefined" and simply gets none.
      const achievements = await this.client.achievements(row.owned.appId);

      if (row.action === "add") {
        const game: Game = gameFromSteam(
          row.owned,
          {
            defaultStatus: this.store.games.settings.defaultStatus,
            ...(this.minMinutes > 0 ? { minPlaytimeMinutes: this.minMinutes } : {}),
          },
          this.store.allGames(),
        );
        if (achievements) {
          game.achievementsEarned = achievements.earned;
          game.achievementsTotal = achievements.total;
        }
        this.store.addGame(game);
        added += 1;
      } else if (row.existing) {
        const patch = { ...row.patch };
        if (achievements) {
          patch.achievementsEarned = achievements.earned;
          patch.achievementsTotal = achievements.total;
        }
        this.store.updateGame(row.existing.id, patch, "steam-import");
        updated += 1;
      }
    }

    this.importing = false;
    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    const summary =
      parts.length === 0
        ? "Nothing was imported."
        : `${parts.join(", ")}${this.cancelled ? " (stopped early)" : ""}.`;

    new Notice(`Steam import — ${summary}`);
    this.onImported?.(summary);
    this.close();
  }

  private renderProgressFooter(): void {
    const host = this.footerEl;
    if (!host) return;
    host.empty();
    const stop = host.createEl("button", { cls: "wl-btn mod-warning", attr: { type: "button" } });
    setIcon(stop.createSpan({ cls: "wl-btn-icon" }), "x");
    stop.createSpan({ cls: "wl-btn-label", text: "Stop" });
    // Cancelling leaves everything already written in place — it is a stop, not
    // an undo, and the summary says how far it got.
    stop.addEventListener("click", () => {
      this.cancelled = true;
    });
  }
}
