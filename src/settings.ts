/**
 * Settings tab — SPEC §4.10.
 *
 * foodspot's shape, ported: a sticky left nav rail with six sections, only the
 * active one rendered; grouped panels carrying a **live status chip**; masked
 * key inputs with an eye toggle, a 500 ms debounced save and a flush on blur;
 * real Test buttons that run an actual API call and report into the chip;
 * inline `?` help toggles instead of paragraph-long descriptions; and a danger
 * zone behind explicit confirms.
 *
 * Service clients belong to the services lane, so they are read off
 * `plugin.clients` — a Test button with no client behind it says so plainly
 * rather than pretending to pass.
 */
import { Modal, PluginSettingTab, Setting, setIcon, type App } from "obsidian";
import { readV3Backup } from "./data/backup";
import { DEFAULT_RATING_SYSTEM } from "./data/schema";
import { buildWidgetPresets } from "./widgets/palette";
import { WIDGET_KEYS, WIDGET_STATS, WIDGET_VIEWS } from "./widgets/render";
import type { NamedColor, Settings } from "./types";
import { CsvExportModal, CsvImportModal } from "./domains/csv/modals";
import type WatchLogPlugin from "./main";

type SectionId =
  | "general"
  | "integrations"
  | "reading"
  | "games"
  | "anime"
  | "lists"
  | "csv"
  | "customize"
  | "widgets"
  | "data"
  | "info";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
}

const SECTIONS: SectionDef[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "integrations", label: "Integrations", icon: "key-round" },
  // Parity sections (SPEC2-PARITY.md). Scaffolded in the contract wave so the
  // domain lanes have a place to hang controls; each says plainly that its
  // domain is not built yet rather than showing dead inputs.
  { id: "reading", label: "Reading", icon: "book-open" },
  { id: "games", label: "Games", icon: "gamepad-2" },
  { id: "anime", label: "Anime APIs", icon: "sparkles" },
  { id: "lists", label: "Lists & Drafts", icon: "list" },
  { id: "csv", label: "CSV", icon: "file-spreadsheet" },
  { id: "customize", label: "Customize", icon: "palette" },
  { id: "widgets", label: "Widgets", icon: "code" },
  { id: "data", label: "Data", icon: "database" },
  { id: "info", label: "Quick info", icon: "info" },
];

type ChipTone = "ok" | "warn" | "pending" | "muted";

interface GroupHandle {
  content: HTMLElement;
  setChip(text: string, tone: ChipTone): void;
}

/** Two-button confirm. Destructive actions never fire on a single click. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly opts: {
      title: string;
      body: string;
      confirmLabel: string;
      onConfirm: () => void;
    },
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.addClass("wl-confirm");
    this.contentEl.createEl("h3", { text: this.opts.title });
    this.contentEl.createEl("p", { text: this.opts.body });
    const row = this.contentEl.createDiv({ cls: "wl-confirm-actions" });
    const cancel = row.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const confirm = row.createEl("button", {
      cls: "mod-warning",
      text: this.opts.confirmLabel,
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class WatchLogSettingTab extends PluginSettingTab {
  private plugin: WatchLogPlugin;
  private active: SectionId = "general";
  private bodyEl: HTMLElement | null = null;
  private navEl: HTMLElement | null = null;
  /** Debounce timers for text fields, cleared (and flushed) on hide. */
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(app: App, plugin: WatchLogPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private get settings(): Settings {
    return this.plugin.store.settings;
  }

  private save(reason = "settings"): void {
    this.plugin.store.save(reason);
  }

  /** Debounced save for fields that fire on every keystroke. */
  private saveSoon(reason = "settings"): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.save(reason);
    }, 500);
    this.timers.add(timer);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("wl-settings");

    const layout = containerEl.createDiv({ cls: "wl-settings-layout" });
    this.navEl = layout.createDiv({ cls: "wl-settings-nav" });
    this.bodyEl = layout.createDiv({ cls: "wl-settings-body" });

    for (const section of SECTIONS) {
      const item = this.navEl.createDiv({ cls: "wl-settings-nav-item" });
      item.toggleClass("is-active", section.id === this.active);
      setIcon(item.createSpan({ cls: "wl-settings-nav-icon" }), section.icon);
      item.createSpan({ text: section.label });
      item.addEventListener("click", () => {
        this.active = section.id;
        for (const el of Array.from(this.navEl?.children ?? [])) {
          el.toggleClass("is-active", el === item);
        }
        this.renderBody();
      });
    }

    this.renderBody();
  }

  override hide(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Flush anything the debounce still owes before the tab goes away.
    void this.plugin.store.flush();
    this.containerEl.removeClass("wl-settings");
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  private group(
    parent: HTMLElement,
    opts: { icon: string; title: string; subtitle?: string; chip?: string; tone?: ChipTone },
  ): GroupHandle {
    const panel = parent.createDiv({ cls: "wl-sgroup" });
    const head = panel.createDiv({ cls: "wl-sgroup-head" });
    setIcon(head.createDiv({ cls: "wl-sgroup-icon" }), opts.icon);
    const titles = head.createDiv({ cls: "wl-sgroup-titles" });
    titles.createDiv({ cls: "wl-sgroup-title", text: opts.title });
    if (opts.subtitle) titles.createDiv({ cls: "wl-sgroup-sub", text: opts.subtitle });
    const chip = head.createDiv({ cls: `wl-chip is-${opts.tone ?? "muted"}` });
    chip.setText(opts.chip ?? "");
    chip.toggleClass("is-hidden", !opts.chip);
    const content = panel.createDiv({ cls: "wl-sgroup-body" });
    return {
      content,
      setChip: (text, tone) => {
        chip.setText(text);
        chip.removeClass("is-ok", "is-warn", "is-pending", "is-muted");
        chip.addClass(`is-${tone}`);
        chip.toggleClass("is-hidden", !text);
      },
    };
  }

  /** Inline `?` toggle — keeps the settings list scannable (foodspot §3). */
  private addHelp(setting: Setting, text: string): Setting {
    let help: HTMLElement | null = null;
    setting.addExtraButton((button) =>
      button
        .setIcon("help-circle")
        .setTooltip("What is this?")
        .onClick(() => {
          if (help) {
            help.remove();
            help = null;
            return;
          }
          help = setting.settingEl.createDiv({ cls: "wl-setting-help", text });
        }),
    );
    return setting;
  }

  /**
   * Masked credential field: password input, eye toggle, debounced save, flush
   * on blur. The value lives in `data.json` in cleartext — the section says so.
   */
  private addSecret(
    parent: HTMLElement,
    opts: {
      name: string;
      desc: string;
      placeholder?: string;
      get: () => string;
      set: (value: string) => void;
    },
  ): Setting {
    const setting = new Setting(parent).setName(opts.name).setDesc(opts.desc);
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addClass("wl-secret-input");
      if (opts.placeholder) text.setPlaceholder(opts.placeholder);
      text.setValue(opts.get()).onChange((value) => {
        opts.set(value.trim());
        this.saveSoon("settings-secret");
      });
      text.inputEl.addEventListener("blur", () => {
        void this.plugin.store.flush();
      });
    });
    setting.addExtraButton((button) =>
      button
        .setIcon("eye")
        .setTooltip("Show or hide")
        .onClick(() => {
          const input = setting.settingEl.querySelector<HTMLInputElement>(".wl-secret-input");
          if (!input) return;
          const shown = input.type === "text";
          input.type = shown ? "password" : "text";
          button.setIcon(shown ? "eye" : "eye-off");
        }),
    );
    return setting;
  }

  private renderBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.empty();
    switch (this.active) {
      case "general":
        this.renderGeneral(body);
        break;
      case "integrations":
        this.renderIntegrations(body);
        break;
      case "reading":
        this.renderReading(body);
        break;
      case "games":
        this.renderGames(body);
        break;
      case "anime":
        this.renderAnime(body);
        break;
      case "lists":
        this.renderLists(body);
        break;
      case "csv":
        this.renderCsv(body);
        break;
      case "customize":
        this.renderCustomize(body);
        break;
      case "widgets":
        this.renderWidgets(body);
        break;
      case "data":
        this.renderData(body);
        break;
      case "info":
        this.renderInfo(body);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // General
  // -------------------------------------------------------------------------

  private renderGeneral(parent: HTMLElement): void {
    const settings = this.settings;

    const notes = this.group(parent, {
      icon: "file-text",
      title: "Notes",
      subtitle: "Per-title markdown notes under your root folder.",
      chip: settings.generateNotes ? "on" : "off",
      tone: settings.generateNotes ? "ok" : "muted",
    });

    this.addHelp(
      new Setting(notes.content).setName("Generate a note per title").addToggle((toggle) =>
        toggle.setValue(settings.generateNotes).onChange((value) => {
          settings.generateNotes = value;
          notes.setChip(value ? "on" : "off", value ? "ok" : "muted");
          this.save();
        }),
      ),
      "data.json stays the source of truth either way. Notes are a convenience: frontmatter plus a ## Notes section that syncs back.",
    );

    new Setting(notes.content).setName("Root folder").addText((text) =>
      text.setValue(settings.rootFolder).onChange((value) => {
        settings.rootFolder = value.trim() || "Watch Read Learn";
        this.saveSoon();
      }),
    );

    new Setting(notes.content)
      .setName("Create folders automatically")
      .setDesc("Make the root folder if it is missing.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoCreateFolders).onChange((value) => {
          settings.autoCreateFolders = value;
          this.save();
        }),
      );

    const behaviour = this.group(parent, {
      icon: "sliders-horizontal",
      title: "Behaviour",
      subtitle: "What happens as you tick episodes off.",
    });

    this.addHelp(
      new Setting(behaviour.content)
        .setName("Complete a title on its last episode")
        .addToggle((toggle) =>
          toggle.setValue(settings.autoCompleteOnLastEpisode).onChange((value) => {
            settings.autoCompleteOnLastEpisode = value;
            this.save();
          }),
        ),
      "Works both ways: ticking the final episode marks the title Completed, and un-ticking one on a completed title puts it back to Watching.",
    );

    this.addHelp(
      new Setting(behaviour.content)
        .setName("Keep seasons in sync automatically")
        .addToggle((toggle) =>
          toggle.setValue(settings.autoSyncSeasons).onChange((value) => {
            settings.autoSyncSeasons = value;
            this.save();
          }),
        ),
      "A show is one thing you follow, not one thing per season: when a new season is announced it is added to the title for you, and its episode count fills in as upstream publishes it. Your watched episodes, ratings and status are never touched. Turn this off to be asked first instead.",
    );

    new Setting(behaviour.content)
      .setName("Set the finish date automatically")
      .addToggle((toggle) =>
        toggle.setValue(settings.setFinishDateAutomatically).onChange((value) => {
          settings.setFinishDateAutomatically = value;
          this.save();
        }),
      );

    new Setting(behaviour.content)
      .setName("Open the library after adding a title")
      .addToggle((toggle) =>
        toggle.setValue(settings.openLibraryAfterAdd).onChange((value) => {
          settings.openLibraryAfterAdd = value;
          this.save();
        }),
      );

    this.addHelp(
      new Setting(behaviour.content).setName("Status bar item").addToggle((toggle) =>
        toggle.setValue(settings.showUpcomingStatusBar).onChange((value) => {
          settings.showUpcomingStatusBar = value;
          this.save();
          this.plugin.refreshStatusBar();
        }),
      ),
      "Shows how many episodes or releases are due today. Click it to open the Upcoming tab. Desktop only.",
    );

    const display = this.group(parent, {
      icon: "monitor",
      title: "Display",
      subtitle: "How things look in the plugin view.",
    });

    new Setting(display.content).setName("Date format").addDropdown((drop) =>
      drop
        .addOptions({ european: "31-12-2026", american: "12/31/2026", iso: "2026-12-31" })
        .setValue(settings.dateFormat)
        .onChange((value) => {
          settings.dateFormat = value as Settings["dateFormat"];
          this.save();
          this.plugin.store.emitChanged({ reason: "settings-date-format" });
        }),
    );

    new Setting(display.content)
      .setName("Card size")
      .setDesc("Minimum poster width in the library grid.")
      .addSlider((slider) =>
        slider
          .setLimits(-3, 3, 1)
          .setValue(settings.cardSize)
          .setDynamicTooltip()
          .onChange((value) => {
            settings.cardSize = value;
            this.save();
          }),
      );

    new Setting(display.content).setName("Half-star ratings").addToggle((toggle) =>
      toggle.setValue(settings.halfStarRatings).onChange((value) => {
        settings.halfStarRatings = value;
        this.save();
      }),
    );

    new Setting(display.content)
      .setName("Top cast, directors and studios")
      .setDesc("How many entries each dashboard credit list shows.")
      .addSlider((slider) =>
        slider
          .setLimits(3, 15, 1)
          .setValue(settings.dashboardTopCredits || 5)
          .setDynamicTooltip()
          .onChange((value) => {
            settings.dashboardTopCredits = value;
            this.save();
          }),
      );

    this.addHelp(
      new Setting(display.content).setName("Trailers").addDropdown((drop) =>
        drop
          .addOptions({ embed: "Embed in a modal", "link-only": "Open on YouTube", off: "Off" })
          .setValue(settings.trailerMode)
          .onChange((value) => {
            settings.trailerMode = value as Settings["trailerMode"];
            this.save();
          }),
      ),
      "Embeds use youtube-nocookie.com. Some studio uploads block embedding and some are region-locked, so an “open on YouTube” link is always offered as well.",
    );
  }

  // -------------------------------------------------------------------------
  // Integrations
  // -------------------------------------------------------------------------

  /**
   * The scaffolding shared by the five parity sections.
   *
   * Each one is a real group with its real chip, and a single honest line about
   * what is not wired up yet. The alternative — inputs that save a value nothing
   * reads — is worse than an empty section: it looks configured.
   */
  private renderReading(parent: HTMLElement): void {
    const settings = this.plugin.store.settings;

    const openLibrary = this.group(parent, {
      icon: "library",
      title: "Open Library",
      subtitle: "Books and covers. No key needed.",
      chip: "Ready",
      tone: "ok",
    });
    // No `notBuiltYet` here: the Reading tab is built, and search works with
    // nothing on this page filled in.
    this.addHelp(
      new Setting(openLibrary.content).setName("Identify this plugin").addText((text) =>
        text
          .setPlaceholder("Watch, Read and Learn/4 (you@example.com)")
          .setValue(settings.openLibraryUserAgent)
          .onChange((value) => {
            settings.openLibraryUserAgent = value.trim();
            this.save();
          }),
      ),
      "Open Library asks callers to identify themselves with an app name and a contact address. Doing so raises the rate limit from one request a second to three — so this is worth filling in even though nothing forces you to.",
    );

    new Setting(openLibrary.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.openLibrary;
        if (!client) {
          openLibrary.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        openLibrary.setChip("Testing…", "pending");
        try {
          const hits = await client.search("dune", 1);
          openLibrary.setChip(
            hits.length > 0 ? `Reachable — found “${hits[0]?.title}”` : "Reachable, no results",
            "ok",
          );
        } catch (err) {
          openLibrary.setChip(err instanceof Error ? err.message : "Search failed", "warn");
        }
      }),
    );

    const google = this.group(parent, {
      icon: "book",
      title: "Google Books",
      subtitle: "Optional second source.",
      chip: settings.googleBooksApiKey ? "Key set" : "Not configured",
      tone: settings.googleBooksApiKey ? "ok" : "muted",
    });
    this.addSecret(google.content, {
      name: "API key",
      desc: "Stored in data.json in cleartext, like every other key here.",
      get: () => settings.googleBooksApiKey,
      set: (value) => {
        settings.googleBooksApiKey = value;
        google.setChip(value ? "Key set" : "Not configured", value ? "ok" : "muted");
      },
    });
    new Setting(google.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.googleBooks;
        if (!client) {
          google.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        if (!client.configured()) {
          google.setChip("Add a key first", "muted");
          return;
        }
        google.setChip("Testing…", "pending");
        try {
          const hits = await client.search("dune", 1);
          google.setChip(hits.length > 0 ? "Key works" : "Key accepted, no results", "ok");
        } catch (err) {
          // The most likely failure is the documented one: a quota of zero on
          // the shared anonymous project, which means the key did not arrive.
          google.setChip(err instanceof Error ? err.message : "Search failed", "warn");
        }
      }),
    );
    this.addHelp(
      new Setting(google.content).setName("Why a key is not optional here"),
      "Without a key Google attributes the request to a shared project whose daily quota is zero, so keyless calls fail immediately rather than merely being slow. Open Library covers the same ground without one.",
    );

    const notes = this.group(parent, {
      icon: "file-text",
      title: "Notes",
      subtitle: "A markdown note per book and per manga.",
    });
    new Setting(notes.content)
      .setName("Generate reading notes")
      .addToggle((toggle) =>
        toggle.setValue(settings.generateReadingNotes).onChange((value) => {
          settings.generateReadingNotes = value;
          this.save();
        }),
      );
  }

  private renderGames(parent: HTMLElement): void {
    const settings = this.plugin.store.settings;

    const igdb = this.group(parent, {
      icon: "gamepad-2",
      title: "IGDB",
      subtitle: "Game metadata, via a Twitch application.",
      chip: settings.igdbClientId && settings.igdbClientSecret ? "Configured" : "Not configured",
      tone: settings.igdbClientId && settings.igdbClientSecret ? "ok" : "muted",
    });
    const syncIgdbChip = (): void => {
      const ready = Boolean(settings.igdbClientId && settings.igdbClientSecret);
      igdb.setChip(ready ? "Configured" : "Not configured", ready ? "ok" : "muted");
    };
    new Setting(igdb.content).setName("Client ID").addText((text) =>
      text.setValue(settings.igdbClientId).onChange((value) => {
        settings.igdbClientId = value.trim();
        syncIgdbChip();
        this.save();
      }),
    );
    this.addSecret(igdb.content, {
      name: "Client secret",
      desc: "From the same Twitch application as the client ID.",
      get: () => settings.igdbClientSecret,
      set: (value) => {
        settings.igdbClientSecret = value;
        syncIgdbChip();
      },
    });
    new Setting(igdb.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.igdb;
        if (!client) {
          igdb.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        igdb.setChip("Testing…", "pending");
        // A real call: mint the token, then ask IGDB for one id. Anything less
        // proves only that the fields are not empty.
        const info = await client.testConnection();
        igdb.setChip(info.message, info.ok ? "ok" : "warn");
      }),
    );
    this.addHelp(
      new Setting(igdb.content).setName("Where these come from"),
      "Register an application on the Twitch developer console — IGDB is Twitch's. Watch, Read and Learn exchanges the pair for a token that lasts about two months and caches it, so this is a one-time step.",
    );

    const steam = this.group(parent, {
      icon: "download",
      title: "Steam import",
      subtitle: "Optional: pull owned games, playtime and achievements.",
      chip: settings.steamApiKey && settings.steamId ? "Configured" : "Not configured",
      tone: settings.steamApiKey && settings.steamId ? "ok" : "muted",
    });
    const syncSteamChip = (): void => {
      const ready = Boolean(settings.steamApiKey && settings.steamId);
      steam.setChip(ready ? "Configured" : "Not configured", ready ? "ok" : "muted");
    };
    this.addSecret(steam.content, {
      name: "API key",
      desc: "From steamcommunity.com/dev/apikey.",
      get: () => settings.steamApiKey,
      set: (value) => {
        settings.steamApiKey = value;
        syncSteamChip();
      },
    });
    new Setting(steam.content).setName("Steam ID (64-bit)").addText((text) =>
      text.setValue(settings.steamId).onChange((value) => {
        settings.steamId = value.trim();
        syncSteamChip();
        this.save();
      }),
    );

    new Setting(steam.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.steam;
        if (!client) {
          steam.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        if (!client.configured()) {
          steam.setChip("Add a key and a Steam ID first", "muted");
          return;
        }
        steam.setChip("Testing…", "pending");
        try {
          const owned = await client.ownedGames();
          steam.setChip(`${owned.length} owned game(s) visible`, owned.length > 0 ? "ok" : "warn");
        } catch (err) {
          steam.setChip(err instanceof Error ? err.message : "Could not reach Steam", "warn");
        }
      }),
    );

    const rawg = this.group(parent, {
      icon: "alert-triangle",
      title: "RAWG",
      subtitle: "Not integrated.",
      chip: "Not supported",
      tone: "muted",
    });
    this.addHelp(
      new Setting(rawg.content).setName("Why not"),
      "RAWG was down throughout the research for this build and has been unreliable for a long time. Any key v3 stored is kept in your data file, but nothing calls it. IGDB covers the same ground.",
    );

    const notes = this.group(parent, {
      icon: "file-text",
      title: "Notes",
      subtitle: "A markdown note per game.",
    });
    new Setting(notes.content)
      .setName("Generate game notes")
      .addToggle((toggle) =>
        toggle.setValue(settings.generateGameNotes).onChange((value) => {
          settings.generateGameNotes = value;
          this.save();
        }),
      );
  }

  private renderAnime(parent: HTMLElement): void {
    const settings = this.plugin.store.settings;

    const source = this.group(parent, {
      icon: "sparkles",
      title: "Anime metadata",
      subtitle: "Which catalogue anime types are looked up in.",
      chip: settings.animeApiSource === "anilist" ? "AniList" : "Jikan",
      tone: "ok",
    });
    this.addHelp(
      new Setting(source.content).setName("Primary source").addDropdown((drop) =>
        drop
          .addOption("anilist", "AniList")
          .addOption("jikan", "Jikan (MyAnimeList)")
          .setValue(settings.animeApiSource)
          .onChange((value) => {
            settings.animeApiSource = value === "jikan" ? "jikan" : "anilist";
            source.setChip(settings.animeApiSource === "anilist" ? "AniList" : "Jikan", "ok");
            this.save();
          }),
      ),
      "AniList gives an exact air time for every individual episode, which is what the Upcoming list wants. Jikan only publishes a weekly broadcast slot, and because it reads MyAnimeList it goes down when MyAnimeList does — but it is where MAL ids come from. Whichever you pick, the other is the fallback.",
    );
    this.addHelp(
      new Setting(source.content).setName("Rate limits"),
      "Neither needs a key. AniList allows 30 requests a minute and Jikan three a second; Watch, Read and Learn stays inside both and backs off when told to.",
    );

    // Both are tested, not just the preferred one: the fallback is only a
    // fallback if it works, and finding that out during an outage is too late.
    new Setting(source.content).setName("Test both providers").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        source.setChip("Testing…", "pending");
        const results: string[] = [];
        let ok = true;

        const anilist = this.plugin.clients.anilist;
        if (anilist) {
          try {
            const hits = await anilist.search("cowboy bebop", 1);
            results.push(hits.length > 0 ? "AniList ✓" : "AniList — no results");
            if (hits.length === 0) ok = false;
          } catch (err) {
            ok = false;
            results.push(`AniList — ${err instanceof Error ? err.message : "failed"}`);
          }
        }

        const jikan = this.plugin.clients.jikan;
        if (jikan) {
          try {
            const hits = await jikan.search("cowboy bebop", 1);
            results.push(hits.length > 0 ? "Jikan ✓" : "Jikan — no results");
          } catch (err) {
            // Jikan scrapes MyAnimeList, so its outages are MAL's. That is worth
            // reporting without failing the whole test — AniList still leads.
            results.push(`Jikan — ${err instanceof Error ? err.message : "unreachable"}`);
          }
        }

        source.setChip(results.join(" · ") || "no clients", ok ? "ok" : "warn");
      }),
    );

    const routing = this.group(parent, {
      icon: "route",
      title: "Type routing",
      subtitle: "Which of your types are anime.",
    });
    const mapped = Object.entries(settings.typeApiMapping)
      .filter(([, value]) => value === "anime")
      .map(([name]) => name);
    this.addHelp(
      new Setting(routing.content).setName("Anime types").setDesc(
        mapped.length > 0 ? mapped.join(", ") : "Anime (the built-in type)",
      ),
      "A type routed to anime is searched on AniList or Jikan instead of TMDB. This matters more than it sounds: the same numeric id means different works in different catalogues, so a lookup in the wrong one silently returns the wrong show.",
    );
  }

  private renderLists(parent: HTMLElement): void {
    const settings = this.plugin.store.settings;

    const lists = this.group(parent, {
      icon: "list",
      title: "Custom lists",
      subtitle: "Free-form tables kept as files in your vault.",
    });
    this.addHelp(
      new Setting(lists.content).setName("Folder").addText((text) =>
        text
          .setPlaceholder("Watch Read Learn/CustomLists")
          .setValue(settings.customListsFolder)
          .onChange((value) => {
            settings.customListsFolder = value.trim();
            this.save();
          }),
      ),
      "Lists v3 wrote are read from here as they are. Nothing is moved or rewritten.",
    );

    const drafts = this.group(parent, {
      icon: "square-pen",
      title: "Drafts",
      subtitle: "Titles you jotted into notes, waiting to be filed.",
    });
    this.addHelp(
      new Setting(drafts.content).setName("Vault tag").addText((text) =>
        text
          .setPlaceholder("#watch-read-learn")
          .setValue(settings.draftsVaultTag)
          .onChange((value) => {
            settings.draftsVaultTag = value.trim();
            this.save();
          }),
      ),
      "Everything after this tag on a line, comma-separated, becomes a draft candidate — so “#watch-read-learn Dune, Arrival” queues two. Drafts appear in a panel in the Library rather than a tab of their own.",
    );
    new Setting(drafts.content)
      .setName("After adding a draft")
      .addDropdown((drop) =>
        drop
          .addOption("keep", "Keep it in the note")
          .addOption("dismiss", "Dismiss it from the list")
          .setValue(settings.draftsAfterAdding)
          .onChange((value) => {
            settings.draftsAfterAdding = value === "dismiss" ? "dismiss" : "keep";
            this.save();
          }),
      );
  }

  private renderCsv(parent: HTMLElement): void {
    const csv = this.group(parent, {
      icon: "file-spreadsheet",
      title: "CSV",
      subtitle: "Import and export, per library.",
    });
    new Setting(csv.content)
      .setName("Export a library")
      .setDesc("Choose the library and download a file.")
      .addButton((button) =>
        button
          .setButtonText("Export…")
          .setCta()
          .onClick(() => new CsvExportModal(this.app, this.plugin.store).open()),
      );

    new Setting(csv.content)
      .setName("Import a file")
      .setDesc("Map the columns, see a preview with duplicates flagged, then import.")
      .addButton((button) =>
        button.setButtonText("Import…").onClick(() =>
          new CsvImportModal(this.app, this.plugin.store, () => {
            // The libraries changed underneath every open surface.
            this.plugin.store.emitChanged({ reason: "csv-imported" });
          }).open(),
        ),
      );

    this.addHelp(
      new Setting(csv.content).setName("Export format"),
      "The watchlist export keeps v3's exact fourteen columns, so a file exported from either version imports into the other. Reading and games get their own column sets.",
    );
    this.addHelp(
      new Setting(csv.content).setName("Import"),
      "Column names are matched against a synonym table — “runtime” and “minutes” both find the episode duration — and anything unmatched is reported rather than guessed at. You see a preview with duplicates flagged before a single row is written.",
    );
  }

  private renderIntegrations(parent: HTMLElement): void {
    const settings = this.settings;

    const warning = parent.createDiv({ cls: "wl-warning" });
    setIcon(warning.createSpan({ cls: "wl-warning-icon" }), "shield-alert");
    warning.createSpan({
      text:
        "API keys are stored in plain text in this plugin's data.json, like every Obsidian plugin. " +
        "Anyone with access to your vault — or to whatever syncs it — can read them.",
    });

    // --- Overseerr ---------------------------------------------------------
    const overseerr = this.group(parent, {
      icon: "download",
      title: "Overseerr",
      subtitle: "Search, metadata, trailers, airing data and requests.",
      chip: settings.overseerrApiKey ? "key set" : "no key",
      tone: settings.overseerrApiKey ? "ok" : "warn",
    });

    // The empty state names every feature that is off and how to switch it on.
    // "no key" in a chip is a diagnosis; this is the instruction.
    if (!settings.overseerrApiKey.trim()) {
      const empty = overseerr.content.createDiv({ cls: "wl-empty is-inline" });
      empty.createDiv({ cls: "wl-empty-title", text: "No API key yet" });
      empty.createDiv({
        cls: "wl-empty-body",
        text:
          "Without one, Watch, Read and Learn still tracks everything you add by hand and still reads Plex — " +
          "but search-to-add, poster and cast autofill, trailers, airing dates and requests are all off. " +
          "The key is in Overseerr under Settings → General → API Key; paste it below and hit Test.",
      });
    }

    new Setting(overseerr.content)
      .setName("Server URL")
      .setDesc("Base URL, without /api/v1.")
      .addText((text) =>
        text
          .setPlaceholder("http://192.168.1.10:5055")
          .setValue(settings.overseerrUrl)
          .onChange((value) => {
            settings.overseerrUrl = value.trim().replace(/\/+$/, "");
            this.saveSoon();
          }),
      );

    this.addSecret(overseerr.content, {
      name: "API key",
      desc: "Overseerr → Settings → General → API Key.",
      placeholder: "required for search and requests",
      get: () => settings.overseerrApiKey,
      set: (value) => {
        settings.overseerrApiKey = value;
      },
    });

    new Setting(overseerr.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.overseerr;
        if (!client) {
          overseerr.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        overseerr.setChip("Testing…", "pending");
        try {
          const info = await client.testConnection();
          if (!info.ok) {
            overseerr.setChip(info.message, "warn");
            return;
          }
          const counts = await client.requestCounts().catch(() => undefined);
          const parts = [info.version ? `v${info.version}` : "connected"];
          if (info.user) parts.push(info.user);
          if (counts) parts.push(`${counts.pending} pending`);
          overseerr.setChip(parts.join(" · "), "ok");
        } catch (err) {
          overseerr.setChip(err instanceof Error ? err.message : "test failed", "warn");
        }
      }),
    );

    // --- Plex --------------------------------------------------------------
    const plex = this.group(parent, {
      icon: "tv",
      title: "Plex",
      subtitle: "Authoritative availability, episode-level presence and deep links.",
      chip: settings.plexUrl ? "configured" : "not configured",
      tone: settings.plexUrl ? "ok" : "warn",
    });

    new Setting(plex.content).setName("Server URL").addText((text) =>
      text
        .setPlaceholder("http://192.168.1.10:32400")
        .setValue(settings.plexUrl)
        .onChange((value) => {
          settings.plexUrl = value.trim().replace(/\/+$/, "");
          this.saveSoon();
        }),
    );

    this.addHelp(
      this.addSecret(plex.content, {
        name: "X-Plex-Token",
        desc: "Optional on a LAN your server lists in allowedNetworks.",
        get: () => settings.plexToken,
        set: (value) => {
          settings.plexToken = value;
        },
      }),
      "If Plex allows your LAN without authentication, every request returns 200 whether or not the token is valid — a bare success does not prove the token works. The test says which case you are in.",
    );

    new Setting(plex.content)
      .setName("Machine identifier")
      .setDesc("Discovered on test; used to build “Open in Plex” links.")
      .addText((text) =>
        text.setPlaceholder("discovered on test").setValue(settings.plexMachineId).setDisabled(true),
      );

    new Setting(plex.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.plex;
        if (!client) {
          plex.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        plex.setChip("Testing…", "pending");
        try {
          const info = await client.testConnection();
          if (info.machineId) {
            settings.plexMachineId = info.machineId;
            this.save("plex-machine-id");
          }
          plex.setChip(info.message, info.ok ? (info.tokenUnverified ? "warn" : "ok") : "warn");
        } catch (err) {
          plex.setChip(err instanceof Error ? err.message : "test failed", "warn");
        }
      }),
    );

    // --- TMDB --------------------------------------------------------------
    const tmdb = this.group(parent, {
      icon: "clapperboard",
      title: "TMDB (optional)",
      subtitle: "Direct fallback for metadata when Overseerr is unavailable.",
      chip: settings.tmdbToken ? "token set" : "optional",
      tone: settings.tmdbToken ? "ok" : "muted",
    });

    this.addSecret(tmdb.content, {
      name: "Read access token",
      desc: "The v4 token, starting eyJ. Not the old v3 API key.",
      get: () => settings.tmdbToken,
      set: (value) => {
        settings.tmdbToken = value;
      },
    });

    new Setting(tmdb.content).setName("Test connection").addButton((button) =>
      button.setButtonText("Test").onClick(async () => {
        const client = this.plugin.clients.tmdb;
        if (!client) {
          tmdb.setChip("client unavailable — reload the plugin", "warn");
          return;
        }
        tmdb.setChip("Testing…", "pending");
        try {
          const info = await client.testConnection();
          tmdb.setChip(info.message, info.ok ? "ok" : "warn");
        } catch (err) {
          tmdb.setChip(err instanceof Error ? err.message : "test failed", "warn");
        }
      }),
    );

    // --- cadences ----------------------------------------------------------
    const refresh = this.group(parent, {
      icon: "refresh-cw",
      title: "Refresh cadences",
      subtitle: "How hard the plugin leans on your servers.",
    });

    this.addHelp(
      new Setting(refresh.content).setName("Poll open requests every").addSlider((slider) =>
        slider
          .setLimits(0, 60, 5)
          .setValue(settings.requestPollMinutes)
          .setDynamicTooltip()
          .onChange((value) => {
            settings.requestPollMinutes = value;
            this.save();
          }),
      ),
      "Minutes between request-status checks while the plugin view is open. 0 disables polling; statuses still refresh when you open the view.",
    );

    new Setting(refresh.content)
      .setName("Airing data lifetime")
      .setDesc("Hours before a title's next-episode data is refetched.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 48, 1)
          .setValue(settings.airingTtlHours)
          .setDynamicTooltip()
          .onChange((value) => {
            settings.airingTtlHours = value;
            this.save();
          }),
      );

    new Setting(refresh.content)
      .setName("Plex availability lifetime")
      .setDesc("Hours before availability is rechecked.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 48, 1)
          .setValue(settings.plexTtlHours)
          .setDynamicTooltip()
          .onChange((value) => {
            settings.plexTtlHours = value;
            this.save();
          }),
      );
  }

  // -------------------------------------------------------------------------
  // Customize
  // -------------------------------------------------------------------------

  private renderCustomize(parent: HTMLElement): void {
    const settings = this.settings;

    parent.createDiv({
      cls: "wl-settings-note",
      text:
        "Order matters: statuses and priorities sort in the order you set here, on every tab and " +
        "in every code block. v3 hardcoded that order; v4 follows yours.",
    });

    this.renderColorList(parent, "Types", "shapes", settings.types, "type");
    this.renderColorList(parent, "Statuses", "activity", settings.statuses, "status");
    this.renderColorList(parent, "Priorities", "flag", settings.priorities, "priority");
    this.renderColorList(parent, "Reviews", "message-square", settings.reviews, "review");

    const tiers = this.group(parent, {
      icon: "star",
      title: "Rating tiers",
      subtitle: "Five labels and colours, one per star.",
    });
    settings.ratingSystem.forEach((tier, index) => {
      const row = tiers.content.createDiv({ cls: "wl-color-row" });
      row.createSpan({ cls: "wl-color-index", text: `${index + 1}★` });
      const label = row.createEl("input", { attr: { type: "text", value: tier.label } });
      label.addEventListener("input", () => {
        tier.label = label.value;
        this.saveSoon();
      });
      const color = row.createEl("input", { attr: { type: "color", value: tier.color } });
      color.addEventListener("input", () => {
        tier.color = color.value;
        this.saveSoon();
      });
    });
    new Setting(tiers.content).addButton((button) =>
      button.setButtonText("Reset tiers").onClick(() => {
        settings.ratingSystem = DEFAULT_RATING_SYSTEM.map((t) => ({ ...t }));
        this.save();
        this.renderBody();
      }),
    );
  }

  private renderColorList(
    parent: HTMLElement,
    title: string,
    icon: string,
    list: NamedColor[],
    noun: "type" | "status" | "priority" | "review",
  ): void {
    const group = this.group(parent, { icon, title, chip: `${list.length}`, tone: "muted" });
    const rows = group.content.createDiv({ cls: "wl-color-list" });

    const usageOf = (name: string): number =>
      this.plugin.store.allTitles().filter((t) => t[noun] === name).length;

    const paint = (): void => {
      rows.empty();
      list.forEach((entry, index) => {
        const row = rows.createDiv({ cls: "wl-color-row" });
        const name = row.createEl("input", { attr: { type: "text", value: entry.name } });
        name.addEventListener("input", () => {
          entry.name = name.value;
          this.saveSoon();
        });
        const color = row.createEl("input", { attr: { type: "color", value: entry.color } });
        color.addEventListener("input", () => {
          entry.color = color.value;
          this.saveSoon();
        });

        const up = row.createEl("button", {
          cls: "wl-icon-btn",
          attr: { type: "button", "aria-label": "Move up" },
        });
        setIcon(up, "chevron-up");
        up.disabled = index === 0;
        up.addEventListener("click", () => {
          const previous = list[index - 1];
          const current = list[index];
          if (!previous || !current) return;
          list[index - 1] = current;
          list[index] = previous;
          this.save();
          paint();
        });

        const remove = row.createEl("button", {
          cls: "wl-icon-btn is-danger",
          attr: { type: "button", "aria-label": `Remove this ${noun}` },
        });
        setIcon(remove, "trash-2");
        remove.addEventListener("click", () => {
          const used = usageOf(entry.name);
          new ConfirmModal(this.app, {
            title: `Remove “${entry.name}”?`,
            body:
              used > 0
                ? `${used} title(s) still use this ${noun}. They keep the value — it just stops being offered in menus.`
                : `Nothing uses this ${noun}.`,
            confirmLabel: "Remove",
            onConfirm: () => {
              list.splice(index, 1);
              this.save();
              group.setChip(`${list.length}`, "muted");
              paint();
            },
          }).open();
        });
      });
    };
    paint();

    new Setting(group.content).addButton((button) =>
      button.setButtonText(`Add ${noun}`).onClick(() => {
        list.push({ name: `New ${noun}`, color: "#888888" });
        this.save();
        group.setChip(`${list.length}`, "muted");
        paint();
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Widgets
  // -------------------------------------------------------------------------

  private renderWidgets(parent: HTMLElement): void {
    const presets = this.group(parent, {
      icon: "code",
      title: "Ready-made blocks",
      subtitle: "Personalised from your own data. The Insert widget command offers the same list.",
    });

    for (const preset of buildWidgetPresets(this.plugin.store)) {
      const card = presets.content.createDiv({ cls: "wl-widget-preset" });
      const head = card.createDiv({ cls: "wl-widget-preset-head" });
      const titles = head.createDiv();
      titles.createDiv({ cls: "wl-widget-preset-name", text: preset.name });
      titles.createDiv({ cls: "wl-widget-preset-desc", text: preset.description });
      const copy = head.createEl("button", {
        cls: "wl-mini-btn",
        text: "Copy",
        attr: { type: "button" },
      });
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(preset.snippet).then(() => {
          copy.setText("Copied");
          window.setTimeout(() => {
            if (copy.isConnected) copy.setText("Copy");
          }, 1500);
        });
      });
      card.createEl("pre", { cls: "wl-widget-preset-code" }).createEl("code", {
        text: preset.snippet.trim(),
      });
    }

    const reference = this.group(parent, {
      icon: "book-open",
      title: "Reference",
      subtitle: "Every key the watch-read-learn fence accepts.",
    });

    const table = reference.content.createDiv({ cls: "wl-doc-table" });
    for (const entry of WIDGET_KEYS) {
      const row = table.createDiv({ cls: "wl-doc-row" });
      row.createEl("code", { text: entry.key });
      row.createSpan({ text: entry.values });
    }

    reference.content.createDiv({
      cls: "wl-settings-note",
      text: `Views: ${WIDGET_VIEWS.join(", ")}. Stats: ${WIDGET_STATS.join(", ")}.`,
    });

    const legacy = this.group(parent, {
      icon: "history",
      title: "Legacy blocks",
      subtitle: "Your v3 notes keep working.",
      chip: "5 shims",
      tone: "ok",
    });
    legacy.content.createDiv({
      cls: "wl-settings-note",
      text:
        "wl-todo, wl-stat, wl-upcoming, wl-nowwatching and wl-now-next still render — they are " +
        "translated into the new renderers. Old watchlog blocks with an id: line parse as-is. " +
        "wl-upcoming now surfaces recurring weekly shows too, which v3 could not.",
    });
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private renderData(parent: HTMLElement): void {
    const store = this.plugin.store;
    const titles = store.allTitles();

    const overview = this.group(parent, {
      icon: "database",
      title: "Your data",
      chip: `${titles.length} titles`,
      tone: "ok",
    });
    const cached = titles.filter((t) => t.plex || t.request || t.airing).length;
    overview.content.createDiv({
      cls: "wl-settings-note",
      text:
        `${titles.length} title(s), ${store.data.groups.length} group(s), ` +
        `${store.data.history.length} activity entries. ${cached} title(s) carry cached Plex, ` +
        `request or airing data.`,
    });

    const report = store.migrationReport;
    if (report && report.fromVersion < report.toVersion) {
      const migration = this.group(parent, {
        icon: "arrow-up-circle",
        title: "Migration",
        chip: `v${report.fromVersion} → v${report.toVersion}`,
        tone: "ok",
      });
      migration.content.createDiv({
        cls: "wl-settings-note",
        text:
          `Migrated ${report.titlesMigrated} title(s). Your v3 data.json was copied to ` +
          `data.json.v3.bak before anything was written, and keys v4 does not use ` +
          `(reading, games, drafts…) were preserved untouched.`,
      });
      if (report.notes.length > 0) {
        const list = migration.content.createEl("ul", { cls: "wl-settings-note" });
        for (const note of report.notes.slice(0, 10)) list.createEl("li", { text: note });
      }
    }

    const maintenance = this.group(parent, {
      icon: "refresh-cw",
      title: "Maintenance",
      subtitle: "Housekeeping that touches no data.",
    });
    new Setting(maintenance.content)
      .setName("Reload the plugin")
      .setDesc("Disable and re-enable the plugin so a newly deployed build is picked up. Your data is untouched.")
      .addButton((button) =>
        button.setButtonText("Reload").onClick(() => {
          void this.plugin.reloadSelf();
        }),
      );

    const danger = this.group(parent, {
      icon: "alert-triangle",
      title: "Danger zone",
      subtitle: "All three ask before they act.",
      chip: "careful",
      tone: "warn",
    });

    const wipe = new Setting(danger.content)
      .setName("Wipe cached Plex, request and airing data")
      .setDesc("Your titles, ratings and watched episodes are untouched.");
    wipe.settingEl.addClass("wl-danger-setting");
    wipe.addButton((button) =>
      button
        .setButtonText("Wipe caches")
        .setWarning()
        .onClick(() => {
          new ConfirmModal(this.app, {
            title: "Wipe cached availability?",
            body:
              "Plex badges, request statuses and airing data are cleared for every title and " +
              "refetched on the next refresh. Nothing you typed is affected.",
            confirmLabel: "Wipe caches",
            onConfirm: () => {
              for (const title of [...this.plugin.store.allTitles()]) {
                this.plugin.store.updateTitle(
                  title.id,
                  { plex: undefined, request: undefined, airing: undefined },
                  "caches-wiped",
                );
              }
              this.renderBody();
            },
          }).open();
        }),
    );

    const clear = new Setting(danger.content)
      .setName("Clear the activity log")
      .setDesc(`${store.data.history.length} entries, including any migrated from v3.`);
    clear.settingEl.addClass("wl-danger-setting");
    clear.addButton((button) =>
      button
        .setButtonText("Clear log")
        .setWarning()
        .onClick(() => {
          new ConfirmModal(this.app, {
            title: "Clear the activity log?",
            body: "Every logged event is removed. This cannot be undone from inside the plugin.",
            confirmLabel: "Clear log",
            onConfirm: () => {
              this.plugin.store.clearActivity();
              this.renderBody();
            },
          }).open();
        }),
    );

    const restore = new Setting(danger.content)
      .setName("Restore the v3 backup")
      .setDesc("Writes data.json.v3.bak back over data.json. Everything since the upgrade is lost.");
    restore.settingEl.addClass("wl-danger-setting");
    restore.addButton((button) =>
      button
        .setButtonText("Restore")
        .setWarning()
        .onClick(() => {
          void this.restoreBackup();
        }),
    );
  }

  private async restoreBackup(): Promise<void> {
    const dir = this.plugin.manifest.dir;
    if (!dir) return;
    const adapter = this.app.vault.adapter;
    const contents = await readV3Backup(adapter, dir);
    if (!contents) {
      new ConfirmModal(this.app, {
        title: "No backup found",
        body: "data.json.v3.bak is not in the plugin folder, so there is nothing to restore.",
        confirmLabel: "OK",
        onConfirm: () => undefined,
      }).open();
      return;
    }
    new ConfirmModal(this.app, {
      title: "Restore the v3 backup?",
      body:
        "data.json is overwritten with the copy taken before the v4 upgrade. Every title, rating " +
        "and episode changed since then is lost, and Obsidian must be reloaded afterwards.",
      confirmLabel: "Overwrite data.json",
      onConfirm: () => {
        void (async () => {
          // Flush first: a queued debounced write would otherwise land on top of
          // the restored file a moment later.
          await this.plugin.store.flush();
          await adapter.write(`${dir}/data.json`, contents);
          new ConfirmModal(this.app, {
            title: "Backup restored",
            body: "Reload Obsidian now — Watch, Read and Learn is still holding the old data in memory.",
            confirmLabel: "OK",
            onConfirm: () => undefined,
          }).open();
        })();
      },
    }).open();
  }

  // -------------------------------------------------------------------------
  // Quick info
  // -------------------------------------------------------------------------

  private renderInfo(parent: HTMLElement): void {
    const info = this.group(parent, {
      icon: "info",
      title: "Watch, Read and Learn",
      chip: `v${this.plugin.manifest.version}`,
      tone: "ok",
    });

    const rows: [string, string][] = [
      [
        "Commands",
        "Open the plugin · Add title · Insert widget · Refresh Plex index · Refresh airing data · Search title. All unbound by default — assign hotkeys in Obsidian's Hotkeys pane.",
      ],
      [
        "Code blocks",
        "One watch-read-learn fence; the view: key picks the renderer. The older watchlog fences still work.",
      ],
      [
        "Where data lives",
        "data.json inside this plugin's folder. Markdown notes are generated from it, not the other way round.",
      ],
      [
        "Scope",
        "Movies and TV. Books, manga, games, custom lists and drafts from v3 are not rebuilt — their data is preserved untouched in data.json.",
      ],
    ];
    for (const [label, text] of rows) {
      const row = info.content.createDiv({ cls: "wl-doc-row" });
      row.createEl("strong", { text: label });
      row.createSpan({ text });
    }

    const search = this.group(parent, {
      icon: "search",
      title: "Search syntax",
      subtitle: "For the library search box.",
    });
    const examples: [string, string][] = [
      ["dexter", "fuzzy match anywhere"],
      ['"the wire"', "exact phrase"],
      ["-anime", "exclude"],
      ["sci-fi | thriller", "either group"],
      ["genre:comedy", "scoped to one field"],
      ["rating:>=4", "numeric comparison"],
      ["plex:no", "not on Plex"],
      ["airing:soon", "airing in the next week"],
    ];
    const table = search.content.createDiv({ cls: "wl-doc-table" });
    for (const [example, meaning] of examples) {
      const row = table.createDiv({ cls: "wl-doc-row" });
      row.createEl("code", { text: example });
      row.createSpan({ text: meaning });
    }
  }
}
