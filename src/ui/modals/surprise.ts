/**
 * "Surprise me" — a random pick out of the watchable backlog.
 *
 * The problem it solves is the twenty-minute scroll: a library big enough to
 * be worth tracking is big enough to make "what tonight?" a chore. The command
 * rolls one title from everything that can actually be watched *now* —
 * Plan to watch or Watching, never Watched/Dropped/To be released — shows it
 * big, and offers exactly two ways out: watch it (land on the filtered
 * Library) or roll again.
 *
 * Two deliberate choices:
 *
 *   - The pool logic is pure and takes the RNG as an argument, so tests can
 *     drive it deterministically and the modal stays a thin shell.
 *   - A re-roll never repeats the current title while the pool has more than
 *     one candidate. A "random" button that shows the same poster twice in a
 *     row reads as broken, whatever the mathematics say.
 */
import { Modal, type App } from "obsidian";
import { STATUS_PLAN_TO_WATCH, STATUS_WATCHING } from "../../constants";
import type { TitleV4 } from "../../types";
import {
  isPosterFailed,
  markPosterFailed,
  posterUrlFor,
  renderPosterPlaceholder,
  resolvePosterUrl,
} from "../components/posters";

/** Statuses that mean "this can be watched tonight". */
const WATCHABLE_STATUSES: readonly string[] = [STATUS_PLAN_TO_WATCH, STATUS_WATCHING];

/** Everything the roll may choose from: the watchable backlog. */
export function surprisePool(titles: Iterable<TitleV4>): TitleV4[] {
  const pool: TitleV4[] = [];
  for (const title of titles) {
    if (WATCHABLE_STATUSES.includes(title.status)) pool.push(title);
  }
  return pool;
}

/** The type names present in the pool, in first-seen order — feeds the filter dropdown. */
export function surpriseTypes(pool: readonly TitleV4[]): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const title of pool) {
    if (seen.has(title.type)) continue;
    seen.add(title.type);
    types.push(title.type);
  }
  return types;
}

/**
 * One random title from the pool.
 *
 * `typeFilter` narrows to a single type name (`""` = all). `avoidId` is the
 * currently shown title: it is excluded whenever the filtered pool holds at
 * least one alternative, so a re-roll always visibly rolls. `rng` is
 * `Math.random`-shaped; injected so tests are deterministic.
 */
export function pickSurprise(
  pool: readonly TitleV4[],
  typeFilter: string,
  rng: () => number,
  avoidId?: string,
): TitleV4 | null {
  let candidates = typeFilter === "" ? [...pool] : pool.filter((t) => t.type === typeFilter);
  if (avoidId !== undefined && candidates.length > 1) {
    candidates = candidates.filter((t) => t.id !== avoidId);
  }
  if (candidates.length === 0) return null;
  const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length));
  return candidates[index] ?? null;
}

export interface SurpriseModalOptions {
  titles: TitleV4[];
  /** "Watch this" — the modal closes itself before handing over. */
  onAccept: (title: TitleV4) => void;
  /** Injected for tests; defaults to Math.random. */
  rng?: () => number;
}

export class SurpriseModal extends Modal {
  private readonly pool: TitleV4[];
  private readonly options: SurpriseModalOptions;
  private readonly rng: () => number;
  private typeFilter = "";
  private current: TitleV4 | null = null;
  private bodyEl: HTMLElement | null = null;

  constructor(app: App, options: SurpriseModalOptions) {
    super(app);
    this.options = options;
    this.pool = surprisePool(options.titles);
    this.rng = options.rng ?? Math.random;
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-surprise-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: "Surprise me" });

    // Type filter — only offered when the pool actually spans types.
    const types = surpriseTypes(this.pool);
    if (types.length > 1) {
      const bar = contentEl.createDiv({ cls: "wl-surprise-filter" });
      const select = bar.createEl("select", { cls: "dropdown" });
      select.createEl("option", { text: "All types", value: "" });
      for (const type of types) {
        const count = this.pool.filter((t) => t.type === type).length;
        select.createEl("option", { text: `${type} (${count})`, value: type });
      }
      select.addEventListener("change", () => {
        this.typeFilter = select.value;
        this.roll();
      });
    }

    this.bodyEl = contentEl.createDiv({ cls: "wl-surprise-body" });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const watch = buttons.createEl("button", { text: "Watch this", cls: "mod-cta" });
    watch.addEventListener("click", () => {
      if (this.current === null) return;
      const chosen = this.current;
      this.close();
      this.options.onAccept(chosen);
    });
    const reroll = buttons.createEl("button", { text: "Roll again" });
    reroll.addEventListener("click", () => this.roll());

    this.roll();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private roll(): void {
    this.current = pickSurprise(this.pool, this.typeFilter, this.rng, this.current?.id);
    this.render();
  }

  private render(): void {
    const body = this.bodyEl;
    if (body === null) return;
    body.empty();

    const title = this.current;
    if (title === null) {
      body.createDiv({
        cls: "wl-surprise-empty",
        text:
          this.pool.length === 0
            ? "Nothing to roll — every title is completed, dropped or unreleased."
            : "Nothing of this type left to roll.",
      });
      return;
    }

    const card = body.createDiv({ cls: "wl-surprise-card" });
    const poster = card.createDiv({ cls: "wl-surprise-poster" });
    const url = resolvePosterUrl(posterUrlFor(title), "w500");
    if (url === "" || isPosterFailed(url)) {
      renderPosterPlaceholder(poster, title.title);
    } else {
      const img = poster.createEl("img");
      img.setAttribute("decoding", "async");
      img.setAttribute("alt", "");
      img.addEventListener("error", () => {
        markPosterFailed(url);
        img.remove();
        renderPosterPlaceholder(poster, title.title);
      });
      img.src = url;
    }

    const meta = card.createDiv({ cls: "wl-surprise-meta" });
    meta.createDiv({ cls: "wl-surprise-title", text: title.title });
    const facts: string[] = [title.type];
    if (title.year !== undefined && title.year > 0) facts.push(String(title.year));
    facts.push(title.status);
    meta.createDiv({ cls: "wl-surprise-facts", text: facts.join(" · ") });
    if ((title.genres ?? []).length > 0) {
      meta.createDiv({ cls: "wl-surprise-genres", text: (title.genres ?? []).join(", ") });
    }
    const overview = (title.overview ?? "").trim();
    if (overview !== "") {
      meta.createDiv({ cls: "wl-surprise-overview", text: overview });
    }
  }
}
