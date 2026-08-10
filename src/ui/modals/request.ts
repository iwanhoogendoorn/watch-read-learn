/**
 * The request affordance: season picker → POST → feedback (SPEC §4.2).
 *
 * A movie has nothing to choose, so it goes straight out. A show opens the
 * picker with **the seasons Plex does not already have pre-checked** — the
 * single most useful default, because the reason you are looking at this dialog
 * is almost always "season 4 dropped and I don't have it".
 *
 * Seasons already on Plex are still listed, just unchecked and labelled, rather
 * than hidden: hiding them makes the list look wrong to anyone counting.
 *
 * The button is disabled with nothing selected. Requesting zero seasons is a
 * 202 from Overseerr and a confusing no-op for the user.
 */
import { Modal, Notice, type App } from "obsidian";
import { confirmAction } from "./confirm";
import type { TitleV4 } from "../../types";
import {
  defaultSeasonSelection,
  needsSeasonPicker,
  plexEpisodesBySeason,
  seasonOnPlex,
  type RequestService,
} from "../../services/requests";

export interface SeasonPickerOptions {
  title: TitleV4;
  /** Resolves with the chosen season numbers, or `null` when cancelled. */
  resolve: (seasons: number[] | null) => void;
}

export class SeasonPickerModal extends Modal {
  private selected: Set<number>;
  private settled = false;
  private submitButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private readonly options: SeasonPickerOptions,
  ) {
    super(app);
    this.selected = new Set(defaultSeasonSelection(options.title));
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-season-picker-modal");
    contentEl.empty();

    const { title } = this.options;
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `Request «${title.title}»` });
    contentEl.createEl("p", {
      cls: "wl-modal-message",
      text: "Seasons your Plex server already has are unchecked.",
    });

    const list = contentEl.createDiv({ cls: "wl-season-picker" });
    const onPlexCounts = plexEpisodesBySeason(title);

    title.seasons.forEach((season, index) => {
      const number = season.seasonNumber ?? index + 1;
      const row = list.createEl("label", { cls: "wl-season-picker-row" });
      const box = row.createEl("input", { attr: { type: "checkbox" } });
      box.checked = this.selected.has(number);
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(number);
        else this.selected.delete(number);
        this.syncSubmit();
      });

      row.createSpan({ cls: "wl-season-picker-name", text: season.name || `Season ${number}` });

      const have = onPlexCounts.get(number) ?? 0;
      const meta = seasonOnPlex(title, index)
        ? "on Plex"
        : have > 0
          ? `${have}/${season.episodes} on Plex`
          : `${season.episodes} ep${season.episodes === 1 ? "" : "s"}`;
      row.createSpan({ cls: "wl-season-picker-meta", text: meta });
    });

    const buttons = contentEl.createDiv({ cls: "wl-modal-buttons" });
    const cancel = buttons.createEl("button", {
      cls: "wl-btn",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.settle(null));

    this.submitButton = buttons.createEl("button", {
      cls: "wl-btn mod-cta",
      text: "Request",
      attr: { type: "button" },
    });
    this.submitButton.addEventListener("click", () => this.settle([...this.selected].sort((a, b) => a - b)));
    this.syncSubmit();
    this.submitButton.focus();
  }

  override onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }

  private syncSubmit(): void {
    const button = this.submitButton;
    if (!button) return;
    const count = this.selected.size;
    button.disabled = count === 0;
    button.setText(count === 0 ? "Pick a season" : `Request ${count} season${count === 1 ? "" : "s"}`);
  }

  private settle(seasons: number[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.options.resolve(seasons);
    this.close();
  }
}

/**
 * The question the season picker asks implicitly, asked out loud for everything
 * that has no picker.
 *
 * Named after what it does rather than what it prevents: the user is choosing
 * to request, at a moment of their choosing, which is the whole point.
 */
export async function confirmRequest(
  app: App,
  title: TitleV4,
  seasons: number[] | "all" | undefined,
): Promise<boolean> {
  const details = [
    "Overseerr passes it to Radarr/Sonarr immediately. Watch, Read and Learn cannot take it back — cancelling one is done in Overseerr.",
  ];
  if (seasons === "all") {
    details.unshift("Every season Overseerr does not already have will be requested.");
  }
  const result = await confirmAction(app, {
    title: `Request “${title.title}”?`,
    message: "It stays in your library either way — this only asks the server for it.",
    details,
    confirmText: "Request",
    cancelText: "Not now",
  });
  return result.confirmed;
}

/** Resolves `null` on Escape, the × and the backdrop. Never hangs. */
export function pickSeasons(app: App, title: TitleV4): Promise<number[] | null> {
  return new Promise<number[] | null>((resolve) => {
    new SeasonPickerModal(app, { title, resolve }).open();
  });
}

/**
 * The whole flow behind every request button: **confirm**, pick, post, report.
 *
 * A request is not a local edit. It reaches Overseerr, which hands it to
 * Radarr/Sonarr, which starts downloading — and nothing in the plugin can take it
 * back. A show has always had the season picker standing between the button and
 * the POST, and the picker doubles as that confirmation; a **film had nothing**,
 * so one press on a card, in the detail modal that opens straight after adding,
 * or on an Upcoming row put a request on the server with no question asked.
 *
 * So every path that does not go through the picker asks first. Adding a title
 * to the library and requesting it are two decisions, and this is the seam
 * between them.
 *
 * The "Requesting…" Notice is held open for the round trip, because Overseerr
 * talks to Radarr/Sonarr synchronously and a slow answer with no feedback reads
 * as a dead button.
 */
export interface RequestFlowHooks {
  /** Injected by tests, so the guarantee below is testable without a real modal. */
  confirm?: (title: TitleV4, seasons: number[] | "all" | undefined) => Promise<boolean>;
  pick?: (title: TitleV4) => Promise<number[] | null>;
}

export async function runRequestFlow(
  app: App,
  title: TitleV4,
  service: RequestService,
  hooks: RequestFlowHooks = {},
): Promise<void> {
  const ask = hooks.confirm ?? ((t, s) => confirmRequest(app, t, s));
  const pick = hooks.pick ?? ((t: TitleV4) => pickSeasons(app, t));
  let seasons: number[] | "all" | undefined;

  if (needsSeasonPicker(title)) {
    const picked = await pick(title);
    if (picked === null) return; // cancelled
    if (picked.length === 0) return;
    seasons = picked;
  } else {
    if (title.tmdbMediaType === "tv" || title.seasons.length > 1) {
      // A show we track without a season breakdown — let the server expand it.
      seasons = "all";
    }
    const confirmed = await ask(title, seasons);
    if (!confirmed) return;
  }

  const pending = new Notice(`Requesting «${title.title}»…`, 0);
  try {
    const result = await service.submit(title, seasons);
    pending.hide();
    new Notice(result.message);
  } catch (err) {
    pending.hide();
    new Notice(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[wrl] request failed", err);
  }
}
