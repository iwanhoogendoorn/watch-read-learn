/**
 * "Insert widget" palette — SPEC §4.9.
 *
 * foodspot's best discoverability trick: the presets are **personalised at
 * insert time** from the user's own data, so you get `genre: Sci-Fi` and
 * `id: dexter-resurrection`, not `genre: <your genre>`. A preset that would
 * interpolate nothing useful is simply not offered.
 *
 * `buildWidgetPresets` is pure and unit-tested; the modal is a thin shell over it.
 */
import { FuzzySuggestModal, type App, type Editor, type FuzzyMatch } from "obsidian";
import { FENCE_WATCHLOG, STATUS_PLAN_TO_WATCH, STATUS_WATCHING } from "../constants";
import type { Settings, TitleV4, WatchLogStoreApi } from "../types";

export interface WidgetPreset {
  id: string;
  /** Shown as the palette row. */
  name: string;
  /** Second line in the palette, and the settings-tab card subtitle. */
  description: string;
  /** The full fenced block, ready to insert. */
  snippet: string;
}

/** Most frequent value, ties broken alphabetically so the result is stable. */
export function mostCommon(values: readonly string[]): string | null {
  const tally = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const entry = tally.get(key);
    if (entry) entry.count += 1;
    else tally.set(key, { label: value, count: 1 });
  }
  if (tally.size === 0) return null;
  return [...tally.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0]
    ?.label ?? null;
}

/** A configured status by name, falling back to the user's first status. */
function statusNamed(settings: Settings, wanted: string): string {
  const exact = settings.statuses.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  return exact?.name ?? settings.statuses[0]?.name ?? wanted;
}

/** The title a `now` block should pin: an explicit pin, else something in progress. */
export function pinCandidate(titles: readonly TitleV4[], watchingStatus: string): TitleV4 | null {
  return (
    titles.find((t) => t.pinned) ??
    titles.find((t) => t.status === watchingStatus) ??
    titles[0] ??
    null
  );
}

function fence(body: string): string {
  return "```" + FENCE_WATCHLOG + "\n" + body.trim() + "\n```\n";
}

/**
 * The preset list, in palette order. Presets whose personalisation is missing
 * (no genres recorded, no titles yet, no Plex data) are dropped rather than
 * inserted with a placeholder the user would have to edit.
 */
export function buildWidgetPresets(store: WatchLogStoreApi): WidgetPreset[] {
  const titles = store.allTitles();
  const settings = store.settings;

  const watching = statusNamed(settings, STATUS_WATCHING);
  const planned = statusNamed(settings, STATUS_PLAN_TO_WATCH);
  const topGenre = mostCommon(titles.flatMap((t) => t.genres ?? []));
  const topType = mostCommon(titles.map((t) => t.type)) ?? settings.types[0]?.name ?? "Movie";
  const pin = pinCandidate(titles, watching);
  const hasPlex = titles.some((t) => t.plex && t.plex.state !== "unknown");
  const hasRatings = titles.some((t) => t.rating > 0);

  const presets: WidgetPreset[] = [
    {
      id: "cards-watching",
      name: `Cards — ${watching}`,
      description: "Poster grid of everything in progress.",
      snippet: fence(`view: cards\nstatus: ${watching}\nsort: dateModified\nlimit: 8`),
    },
    {
      id: "upcoming-next",
      name: "Upcoming — what airs next",
      description: "Next episodes, releases and new seasons, soonest first.",
      snippet: fence(`view: upcoming\nlimit: 5`),
    },
    {
      id: "stat-time",
      name: "Stat — time watched and remaining",
      description: "The two headline numbers, using the one time formula.",
      snippet: fence(`view: stat\nstat: time`),
    },
    {
      id: "random-tonight",
      name: "Random — what should I watch tonight?",
      description: `One random pick from your ${planned} list, with a shuffle button.`,
      snippet: fence(`view: random\nstatus: ${planned}`),
    },
    {
      id: "shortlist-planned",
      name: `Shortlist — ${planned}`,
      description: "Checklist of everything you mean to get to.",
      snippet: fence(`view: shortlist\nlimit: 15`),
    },
    {
      id: "list-type",
      name: `List — every ${topType}`,
      description: "Compact rows with progress and availability.",
      snippet: fence(`view: list\ntype: ${topType}\nsort: title`),
    },
    {
      id: "stat-by-status",
      name: "Stat — by status",
      description: "A bar per status, in your configured order.",
      snippet: fence(`view: stat\nstat: by-status`),
    },
  ];

  if (topGenre) {
    presets.push({
      id: "cards-genre",
      name: `Cards — ${topGenre}`,
      description: `Everything tagged ${topGenre}, your most common genre.`,
      snippet: fence(`view: cards\ngenre: ${topGenre}\nlimit: 12`),
    });
  }

  if (hasRatings) {
    presets.push({
      id: "table-top-rated",
      name: "Table — top rated",
      description: "Your 4★-and-up titles as a sortable table. Unrated titles always pass.",
      snippet: fence(`view: table\nminRating: 4\nsort: rating\ndirection: desc`),
    });
  }

  if (pin) {
    presets.push({
      id: "now-pinned",
      name: `Now — ${pin.title}`,
      description: "Pinned title with a next-episode checkbox that writes through.",
      snippet: fence(`view: now\nid: ${pin.id}`),
    });
  }

  if (hasPlex) {
    presets.push({
      id: "cards-missing",
      name: "Cards — not on Plex yet",
      description: "What you track but do not have, ready to request.",
      snippet: fence(`view: cards\nplex: missing\nlimit: 12`),
    });
  }

  // --- the parity libraries ------------------------------------------------
  //
  // Personalised the same way and dropped the same way: a preset for a library
  // you do not use would insert a block that renders "nothing matches".
  const reading = store.reading;
  const games = store.games;
  const books = reading?.books ?? [];
  const manga = reading?.manga ?? [];
  const gameList = games?.games ?? [];

  if (books.length > 0 || manga.length > 0) {
    presets.push({
      id: "reading-current",
      name: "Reading — what I am part-way through",
      description: `Books and manga you have started (${books.length + manga.length} tracked).`,
      snippet: fence(`domain: reading\nview: list\nstatus: Reading\nlimit: 8`),
    });
    presets.push({
      id: "reading-pages",
      name: "Stat — pages read",
      description: "Pages across every book, words folded in at 250 a page.",
      snippet: fence(`domain: reading\nview: stat\nstat: pages-read`),
    });
    const topAuthor = mostCommon([...books, ...manga].map((entry) => entry.author));
    if (topAuthor) {
      presets.push({
        id: "reading-author",
        name: `Reading — ${topAuthor}`,
        description: "Everything by the author you read most.",
        snippet: fence(`domain: reading\nview: list\nauthor: ${topAuthor}`),
      });
    }
  }

  if (gameList.length > 0) {
    presets.push({
      id: "games-playing",
      name: "Games — currently playing",
      description: `Your in-progress games (${gameList.length} tracked).`,
      snippet: fence(`domain: games\nview: list\nstatus: Playing\nlimit: 8`),
    });
    presets.push({
      id: "games-time",
      name: "Stat — time played",
      description: "Total playtime across every game that reports one.",
      snippet: fence(`domain: games\nview: stat\nstat: time-played`),
    });
    const topPlatform = mostCommon(gameList.flatMap((game) => game.platforms ?? []));
    if (topPlatform) {
      presets.push({
        id: "games-platform",
        name: `Games — ${topPlatform}`,
        description: "Your most-used platform.",
        snippet: fence(`domain: games\nview: cards\nplatform: ${topPlatform}\nlimit: 12`),
      });
    }
  }

  return presets;
}

/** Fuzzy palette over the presets; inserts the chosen block at the cursor. */
export class WidgetPaletteModal extends FuzzySuggestModal<WidgetPreset> {
  constructor(
    app: App,
    private readonly presets: WidgetPreset[],
    private readonly onChoose: (preset: WidgetPreset) => void,
  ) {
    super(app);
    this.setPlaceholder("Insert a widget…");
  }

  override getItems(): WidgetPreset[] {
    return this.presets;
  }

  override getItemText(preset: WidgetPreset): string {
    return `${preset.name} ${preset.description}`;
  }

  override renderSuggestion(match: FuzzyMatch<WidgetPreset>, el: HTMLElement): void {
    el.addClass("wl-palette-row");
    el.createDiv({ cls: "wl-palette-name", text: match.item.name });
    el.createDiv({ cls: "wl-palette-desc", text: match.item.description });
  }

  override onChooseItem(preset: WidgetPreset): void {
    this.onChoose(preset);
  }
}

/** Command body for "Insert widget". */
export function openWidgetPalette(app: App, store: WatchLogStoreApi, editor: Editor): void {
  const presets = buildWidgetPresets(store);
  new WidgetPaletteModal(app, presets, (preset) => {
    editor.replaceSelection(preset.snippet);
  }).open();
}
