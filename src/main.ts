/**
 * Plugin entry point and composition root (SPEC §4.11, §7 Wave 2).
 *
 * Everything the four Wave-1 lanes left as an interface seam is bound here and
 * nowhere else: the three API clients, the availability index, the airing queue,
 * the request feedback loop, the shared card component, the shared poster loader
 * and the modals. No tab, widget or component imports a service; they are all
 * handed one through `tabDeps()` / `libraryDeps()`.
 *
 * The one shared mutable thing at this level is `pendingLibraryQuery` — the
 * chip → filtered-Library handoff for the case where the view is not open yet.
 */
import {
  FuzzySuggestModal,
  Notice,
  Platform,
  Plugin,
  TFile,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import {
  DATA_FILE,
  V3_BACKUP_FILE,
  VIEW_DISPLAY_NAME,
  VIEW_ICON,
  VIEW_TYPE_WATCHLOG,
} from "./constants";
import {
  describeCounts,
  scanForAdoptable,
  totalItems,
  type AdoptionCandidate,
} from "./data/adopt";
import { ensureV3Backup, readV3Backup, type SourceState } from "./data/backup";
import {
  createReadingStore,
  ReadingNoteWriter,
  type ReadingDeps,
  type ReadingEntry,
  type ReadingStore,
} from "./domains/reading";
import { openPdfPages, pdfProgressActions, recordBookPage } from "./domains/reading/bookfile";
import { progressPatch } from "./domains/reading/progress";
import { communityRatingPatch, fetchBookRating } from "./domains/reading/community";
import { createGoogleBooksClient } from "./services/googlebooks";
import { createOpenLibraryClient } from "./services/openlibrary";
import { totalFromSeasons, withAddedSeason } from "./data/episodes";
import { NoteWriter } from "./data/notes";
import { WatchLogStore } from "./data/store";
import { createGamesStore } from "./domains/games/store";
import { GameNoteWriter } from "./domains/games/notes";
import type { GamesDeps } from "./domains/games/tab";
import { createIgdbClient, type IgdbTokenCache } from "./services/igdb";
import { createSteamClient } from "./services/steam";
import { Integrations } from "./integration";
import { createLibraryEngine } from "./search/engine";
import { WatchLogSettingTab } from "./settings";
import { WatchLogView } from "./ui/view";
import { DraftsService, renderDraftsPanel } from "./domains/drafts/panel";
import { mountGroupsExtension } from "./domains/groups/panel";
import { CsvExportModal, CsvImportModal } from "./domains/csv/modals";
import { buildTitleCard } from "./ui/components/card";
import { createPosterLoader } from "./ui/components/posters";
import { AddTitleModal } from "./ui/modals/add";
import { confirmAction } from "./ui/modals/confirm";
import { DetailModal } from "./ui/modals/detail";
import { MatchTitleModal } from "./ui/modals/match";
import { openRecovery } from "./ui/modals/recovery";
import { runRequestFlow } from "./ui/modals/request";
import { SurpriseModal } from "./ui/modals/surprise";
import { parseWatchlogRoute } from "./uri";
import { hasTrailer, openTrailer } from "./ui/modals/trailer";
import {
  acknowledgePatch,
  buildUpcomingEntries,
  countDue,
  type CardFactory,
  type TabDeps,
} from "./ui/tabs/upcoming";
import {
  buildUnifiedUpcoming,
  countUnified,
  statusBarText,
} from "./domains/upcoming/unified";
import { buildUpcomingIcs } from "./domains/upcoming/ics";
import type { LibraryDeps } from "./ui/tabs/library";
import { registerLegacyFences } from "./widgets/legacy";
import { openWidgetPalette } from "./widgets/palette";
import { WidgetSystem } from "./widgets/render";
import { parseWidgetSource } from "./widgets/parser";
import {
  DATA_CHANGED_EVENT,
  readExtra,
  writeExtra,
  type Game,
  type GamesStoreApi,
  type GoogleBooksClient,
  type IgdbClient,
  type OpenLibraryClient,
  type AniListClient,
  type JikanClient,
  type OverseerrClient,
  type PlexClient,
  type PosterLoader,
  type ReadingKind,
  type SteamClient,
  type TabId,
  type TitleV4,
  type TmdbClient,
  type WidgetParseResult,
} from "./types";

/** Service clients, exposed for the settings tab's Test buttons. */
export interface WatchLogClients {
  overseerr?: OverseerrClient;
  plex?: PlexClient;
  tmdb?: TmdbClient;
  /** Keyless — always present. */
  openLibrary?: OpenLibraryClient;
  /** Present but unconfigured until the user sets a key. */
  googleBooks?: GoogleBooksClient;
  /** Games. Steam has no test call worth making — its errors are per-request. */
  igdb?: IgdbClient;
  /** Anime. Both keyless, both always constructed — the fallback needs the pair. */
  anilist?: AniListClient;
  jikan?: JikanClient;
  /** Steam. Present once a key and an id are set. */
  steam?: SteamClient;
}

/**
 * Cross-lane callbacks. Every one is bound in `wireHooks()`; they stay optional
 * so a surface that is handed nothing degrades honestly rather than throwing.
 */
export interface WatchLogHooks {
  openAddModal?: () => void;
  openDetailModal?: (title: TitleV4) => void;
  openTrailer?: (title: TitleV4) => void;
  requestTitle?: (title: TitleV4) => void;
  /** Resolves with a sentence for the Notice. */
  refreshPlexIndex?: () => Promise<string>;
  refreshAiring?: () => Promise<string>;
  buildCard?: CardFactory;
  posterLoader?: PosterLoader;
  parseWidget?: (source: string) => WidgetParseResult;
}

export default class WatchLogPlugin extends Plugin {
  store!: WatchLogStore;
  integrations!: Integrations;
  clients: WatchLogClients = {};
  hooks: WatchLogHooks = {};

  /**
   * Query the Library should apply the next time it mounts — the chip →
   * filtered-library handoff, and where the "Search title" command lands. Read
   * exactly once, via `takePendingLibraryQuery()`.
   */
  pendingLibraryQuery: string | null = null;

  /**
   * One IntersectionObserver for every poster outside the Library tab (widgets,
   * Dashboard, Upcoming). The Library owns its own because it is torn down and
   * rebuilt on every tab switch; this one lives as long as the plugin and is
   * released in `onunload`.
   */
  private posterLoader: PosterLoader | null = null;

  /**
   * The drafts scanner (SPEC2-PARITY.md §D-EXTRAS).
   *
   * Plugin-lifetime rather than view-lifetime on purpose: the Library's toolbar
   * badge has to know the pending count the moment the tab mounts, and a scan
   * that only started when the panel opened would always report zero first.
   */
  drafts: DraftsService | null = null;

  /** Owns the code-block registry; it unregisters itself through `register`. */
  private widgets: WidgetSystem | null = null;
  /** The markdown-note mirror; null only before `onload` finishes. */
  private notes: NoteWriter | null = null;
  /** The reading domain's store and note mirror (SPEC2 §D-READING). */
  private reading: ReadingStore | null = null;
  private readingNotes: ReadingNoteWriter | null = null;
  private statusBarEl: HTMLElement | null = null;

  /** The games domain's seams, bound in `setupGames()`. */
  private games: GamesStoreApi | null = null;
  private gameNotes: GameNoteWriter | null = null;
  private igdb: IgdbClient | null = null;
  private steam: SteamClient | null = null;

  override async onload(): Promise<void> {
    this.store = new WatchLogStore(this);

    const dir = this.manifest.dir;

    // The rename changed the plugin's id, and Obsidian keys the data folder off
    // the id — so to an existing user this load looks like a fresh install with
    // an empty library. Look for the old folder *now*, while "we have no data of
    // our own" is still unambiguously true; the offer itself comes later, once
    // the workspace is up. Nothing here blocks on a human.
    const adoptable = dir ? await this.findAdoptable(dir) : null;

    // The v3 safety net must exist BEFORE anything can write (SPEC §3.1). A
    // failed copy is a hard gate whenever `data.json` exists — or whenever we
    // could not find out whether it does, because "unknown" is not "absent"
    // and the only copy of the user's data may be the one v4 would migrate over.
    if (dir) {
      const backup = await ensureV3Backup(this.app.vault.adapter, dir);
      if (backup.error && backup.sourceExists) {
        console.error("[wrl] could not back up data.json:", backup.error);
        this.gateOnFailedBackup(dir, backup.error, backup.sourceState);
      } else if (backup.error) {
        // Nothing on disk to lose — a fresh install with a grumpy adapter.
        console.warn("[wrl] backup skipped:", backup.error);
      } else if (backup.created) {
        console.log(`[wrl] wrote ${backup.path}`);
      }
    }

    await this.store.load();

    const report = this.store.migrationReport;
    if (report?.reset) {
      // `data.json` was valid JSON but not one of ours. v3's answer was to
      // start from defaults and save; that overwrites a recoverable file. We
      // never auto-save it — the user decides (SPEC §3.1).
      this.gateOnUnrecognisedData(dir ?? "");
    } else if (report && report.fromVersion < report.toVersion) {
      console.log(
        `[wrl] migrated schema v${report.fromVersion} -> v${report.toVersion}, ` +
          `${report.titlesMigrated} title(s)`,
        report.notes,
      );
      // The migration rewrote the file shape; persist it once, now.
      await this.saveNow("the migrated data");
    }

    if (dir) this.watchExternalChanges(dir);

    this.setupNotes();
    this.setupReading();
    this.setupGames();

    this.integrations = new Integrations({
      app: this.app,
      store: this.store,
      saveSettings: (reason) => this.store.save(reason),
    });
    this.register(() => this.integrations.destroy());
    this.wireAnimeClients();

    this.posterLoader = createPosterLoader({ rootMargin: "300px" });
    this.register(() => {
      this.posterLoader?.destroy();
      this.posterLoader = null;
    });

    this.wireHooks();

    this.registerView(VIEW_TYPE_WATCHLOG, (leaf: WorkspaceLeaf) => new WatchLogView(leaf, this));

    this.addRibbonIcon(VIEW_ICON, VIEW_DISPLAY_NAME, () => {
      void this.activateView();
    });

    this.registerCommands();
    this.registerUriHandler();
    this.registerWidgets();
    this.setupStatusBar();
    this.setupDrafts();

    this.addSettingTab(new WatchLogSettingTab(this.app, this));

    // Catch-up on load: v3 only noticed an episode had aired while its view was
    // open, so a week with Obsidian closed swallowed every notification. Deferred
    // to after the workspace settles so it never delays startup.
    this.app.workspace.onLayoutReady(() => {
      void this.integrations.catchUp();
      // Deferred to here so a modal can never sit between the user and a
      // plugin that has finished loading. Guarded because a prompt that fails
      // to open must cost the user a prompt, not the rest of this callback.
      try {
        if (adoptable && dir) this.offerAdoption(adoptable, `${dir}/${DATA_FILE}`);
      } catch (err) {
        console.error("[wrl] could not offer to adopt the previous install:", err);
      }
    });
  }

  override async onunload(): Promise<void> {
    // Flush any debounced write before the plugin goes away — and say so if it
    // did not land, rather than letting the session's edits disappear quietly.
    await this.saveNow("your last changes");
  }

  // -------------------------------------------------------------------------
  // Data safety
  // -------------------------------------------------------------------------

  /** `store.flush()` with the failure actually surfaced. */
  private async saveNow(what: string): Promise<boolean> {
    try {
      await this.store.flush();
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] save failed", err);
      new Notice(`Watch, Read and Learn could not save ${what} — ${detail}`, 12000);
      return false;
    }
  }

  /**
   * P0-3's gate: no backup, no writing. The plugin stays usable read-only, and
   * the user gets the three answers that actually exist.
   */
  private gateOnFailedBackup(dir: string, error: string, sourceState: SourceState): void {
    this.store.blockWrites(
      "Watch, Read and Learn could not back up data.json, so it is not writing to it yet.",
    );
    openRecovery(this.app, {
      title: "Watch, Read and Learn could not back up your data",
      message:
        sourceState === "unknown"
          ? "Before touching data.json for the first time, Watch, Read and Learn copies it to data.json.v3.bak. " +
            "It could not even find out whether that file exists, and it will not write over " +
            "something it cannot see — Watch, Read and Learn is read-only until you choose."
          : "Before touching data.json for the first time, Watch, Read and Learn copies it to data.json.v3.bak. " +
            "That copy failed, so nothing is being written — your existing file is untouched and " +
            "Watch, Read and Learn is read-only until you choose.",
      details: [`Folder: ${dir}`, `Error: ${error}`],
      actions: [
        {
          label: "Try the backup again",
          description: "Usually enough after a sync finishes or a permission is granted.",
          run: () => {
            void this.retryBackup(dir);
          },
        },
        {
          label: "Save anyway, without a backup",
          description: "Watch, Read and Learn will write to data.json with no rollback copy to fall back on.",
          danger: true,
          run: () => {
            this.store.allowWrites();
            new Notice("Watch, Read and Learn is saving again — there is no v3 backup.");
          },
        },
      ],
      dismissLabel: "Stay read-only",
    });
  }

  /**
   * Is there a previous install worth offering to adopt?
   *
   * Answered only when our own `data.json` is *known* to be absent. Every other
   * answer — including an adapter that will not say — means we leave well
   * alone: the cost of a wrong "yes" here is someone's collection. Reads only.
   */
  private async findAdoptable(dir: string): Promise<AdoptionCandidate | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(`${dir}/${DATA_FILE}`)) return null;
    } catch (err) {
      // Fail closed, exactly as the backup gate does: "cannot tell" ≠ "absent".
      console.warn("[wrl] skipped the adoption check:", err);
      return null;
    }
    const ownFolder = dir.replace(/\/+$/, "").split("/").pop() ?? "";
    const { candidate } = await scanForAdoptable(adapter, dir, ownFolder);
    if (!candidate || totalItems(candidate.counts) === 0) return null;
    return candidate;
  }

  /**
   * The rename's one-time question: "there is a library in the old folder —
   * want it?"
   *
   * Deliberately fire-and-forget. Nothing waits on the answer, so a modal that
   * never opens costs the user a prompt, not a working plugin. Dismissing
   * writes nothing at all, which is what brings the question back next load.
   *
   * The old folder is only ever read. Whichever way this goes, the previous
   * install stays exactly as it was and can be re-enabled at any time.
   */
  private offerAdoption(candidate: AdoptionCandidate, ownPath: string): void {
    openRecovery(this.app, {
      title: "Bring your library across?",
      message:
        `This plugin used to be called WatchLog. Renaming it gave it a new folder, ` +
        `which is why it is currently empty — your entries are still in the old one, ` +
        `untouched. They can be copied over now.`,
      details: [
        `Found in ${candidate.folder}: ${describeCounts(candidate.counts)}.`,
        `Copying reads that folder and never writes to it, so the old install stays intact.`,
      ],
      actions: [
        {
          label: "Bring my library across",
          description: "Copies the file into this plugin's folder. Nothing else moves.",
          run: () => this.adoptFrom(candidate, ownPath),
        },
        {
          label: "Start empty",
          description: "Keeps the old folder as it is and begins a fresh library here.",
          run: () => this.declineAdoption(ownPath),
        },
      ],
      dismissLabel: "Decide later",
    });
  }

  /**
   * Copy the previous install's file in, then re-read it through the normal
   * migration path so the adopted data gets the same treatment as any other.
   * Failure is loud and non-destructive.
   */
  private async adoptFrom(candidate: AdoptionCandidate, ownPath: string): Promise<void> {
    try {
      await this.app.vault.adapter.write(ownPath, candidate.raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] adoption failed", err);
      new Notice(
        `Watch, Read and Learn could not copy your library from ${candidate.folder} — ${detail}. ` +
          `Nothing was changed; the old folder is untouched.`,
        12000,
      );
      return;
    }
    const adopted = await this.store.reloadFromDisk();
    if (!adopted) {
      new Notice(
        `Watch, Read and Learn copied the file from ${candidate.folder} but could not read it back. ` +
          `Your old install is untouched — restart Obsidian to try again.`,
        12000,
      );
      return;
    }
    this.store.emitChanged({ reason: "data-reloaded" });
    new Notice(
      `Watch, Read and Learn brought ${describeCounts(candidate.counts)} across from ${candidate.folder}.`,
      8000,
    );
  }

  /**
   * Record "no thanks" by writing an empty-but-recognisable file.
   *
   * Without this the folder stays empty, and an empty folder is the very
   * condition that triggers the question — so it would be asked on every
   * single load.
   */
  private async declineAdoption(ownPath: string): Promise<void> {
    try {
      await this.app.vault.adapter.write(ownPath, JSON.stringify({ titles: [] }, null, 2));
    } catch (err) {
      console.warn("[wrl] could not record the adoption decision:", err);
    }
  }

  private async retryBackup(dir: string): Promise<void> {
    const backup = await ensureV3Backup(this.app.vault.adapter, dir);
    if (backup.error && backup.sourceExists) {
      this.gateOnFailedBackup(dir, backup.error, backup.sourceState);
      return;
    }
    this.store.allowWrites();
    new Notice("Watch, Read and Learn backed up data.json and is saving again.");
  }

  /**
   * P0-4's gate: `data.json` parsed but is not one of ours. Memory holds
   * defaults; the file on disk holds whatever it holds, and it stays that way
   * until the user picks one.
   */
  private gateOnUnrecognisedData(dir: string): void {
    this.store.blockWrites(
      "data.json could not be recognised, so the plugin is not overwriting it.",
    );
    const notes = this.store.migrationReport?.notes ?? [];
    openRecovery(this.app, {
      title: "Watch, Read and Learn could not read data.json",
      message:
        "The file is valid JSON but does not look like one of our databases — a partial sync or a " +
        "damaged copy usually explains it. Watch, Read and Learn has started empty and is NOT writing, so the " +
        "file is still exactly as it was and can be inspected or restored.",
      details: [
        `File: ${dir}/${DATA_FILE}`,
        ...notes.slice(0, 3),
        "Open that file in a text editor before choosing — it may only need one bracket.",
      ],
      actions: [
        {
          label: "Restore the v3 backup",
          description: `Copies ${V3_BACKUP_FILE} back over data.json, then reload Obsidian.`,
          run: () => {
            void this.restoreFromBackup(dir);
          },
        },
        {
          label: "Reload and try again",
          description: "Re-reads the file, for after you have fixed or re-synced it.",
          run: () => {
            void this.retryLoad(dir);
          },
        },
        {
          label: "Start fresh and overwrite data.json",
          description: "The current file's contents are lost. Only the .bak copy survives.",
          danger: true,
          run: () => {
            void this.confirmReset();
          },
        },
      ],
      dismissLabel: "Leave the file alone",
    });
  }

  private async restoreFromBackup(dir: string): Promise<void> {
    const contents = await readV3Backup(this.app.vault.adapter, dir);
    if (contents === undefined) {
      new Notice(`No ${V3_BACKUP_FILE} in the plugin folder — nothing to restore.`, 10000);
      return;
    }
    try {
      await this.app.vault.adapter.write(`${dir}/${DATA_FILE}`, contents);
    } catch (err) {
      new Notice(
        `Could not restore the backup: ${err instanceof Error ? err.message : String(err)}`,
        12000,
      );
      return;
    }
    await this.retryLoad(dir);
  }

  /** Re-read the file; adopt it and resume writing when it makes sense again. */
  private async retryLoad(dir: string): Promise<void> {
    const adopted = await this.store.reloadFromDisk();
    if (!adopted) {
      this.gateOnUnrecognisedData(dir);
      return;
    }
    this.store.allowWrites();
    this.store.emitChanged({ reason: "data-reloaded" });
    new Notice("Watch, Read and Learn read data.json and is saving again.");
  }

  private async confirmReset(): Promise<void> {
    const result = await confirmAction(this.app, {
      title: "Overwrite data.json with an empty library?",
      message:
        "Everything currently in that file is replaced by an empty the plugin database. This cannot " +
        "be undone from inside the plugin.",
      details: [`Only ${V3_BACKUP_FILE}, if it exists, would still hold the old contents.`],
      confirmText: "Overwrite it",
      danger: true,
    });
    if (!result.confirmed) return;
    this.store.allowWrites();
    this.store.save("explicit-reset");
    await this.saveNow("the empty library");
  }

  /**
   * P0-5: adopt `data.json` changes made by Obsidian Sync, another device or a
   * text editor instead of overwriting them on the next local save.
   */
  private watchExternalChanges(dir: string): void {
    const adapter = this.app.vault.adapter;
    const path = `${dir}/${DATA_FILE}`;
    const stop = this.store.startExternalWatch({
      stamp: async () => {
        try {
          const stat = await adapter.stat(path);
          return stat ? stat.mtime : null;
        } catch {
          return null;
        }
      },
      onConflict: () =>
        confirmAction(this.app, {
          title: "data.json changed outside the plugin",
          message:
            "Another device (or Obsidian Sync) rewrote data.json while you have unsaved changes " +
            "in this window. Only one of the two can survive.",
          details: [
            "Keep this window: your unsaved edits are written over the incoming file.",
            "Take the file: this window reloads and your unsaved edits are lost.",
          ],
          confirmText: "Keep this window",
          cancelText: "Take the file",
        }).then((result) => (result.confirmed ? "mine" : "theirs")),
      onReloaded: () => {
        new Notice("Watch, Read and Learn reloaded data.json after an external change.");
      },
      onUnreadable: () => {
        this.gateOnUnrecognisedData(dir);
      },
    });
    this.register(stop);
  }

  // -------------------------------------------------------------------------
  // Markdown notes (SPEC D7, §4.6)
  // -------------------------------------------------------------------------

  /**
   * The per-title note mirror.
   *
   * Three wires: every title mutation writes its note, every note the *user*
   * edits pushes its `## Notes` section back into the title, and both directions
   * are cheap because they are keyed by title id rather than by scanning.
   */
  private setupNotes(): void {
    const notes = new NoteWriter(this.app);
    this.notes = notes;

    // Where each note currently lives, so the first rename moves rather than
    // duplicates — without touching the vault at startup.
    for (const title of this.store.allTitles()) notes.remember(title, this.store.settings);

    this.store.onTitlesChanged((titleIds, reason) => {
      if (!this.store.settings.generateNotes) return;
      for (const id of titleIds) {
        const title = this.store.getTitle(id);
        if (!title) {
          notes.forget(id);
          continue;
        }
        // The note we just read *from* must not be written straight back.
        if (reason === "note-read-back") continue;
        void notes.sync(title, this.store.settings);
      }
    });

    // Note → title: the `## Notes` section is the only part read back.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.store.settings.generateNotes) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (notes.isOwnWrite(file.path)) return;
        const titleId = notes.titleIdForPath(file.path);
        if (!titleId) return;
        void this.readNotesBack(titleId);
      }),
    );

    this.addCommand({
      id: "sync-title-notes",
      name: "Sync title notes",
      callback: () => {
        void this.syncAllNotes();
      },
    });
  }

  /**
   * The games domain (SPEC2-PARITY.md §D-GAMES).
   *
   * Both clients are optional and read their credentials **live**, so a key
   * typed into Settings works on the next search rather than the next reload.
   * The IGDB token lasts about two months, so it is cached in `data.json`
   * beside the settings — through `readExtra`/`writeExtra`, since `Settings` is
   * a frozen shape and an undeclared key round-trips by design.
   */
  private setupGames(): void {
    const notes = new GameNoteWriter(this.app);
    this.gameNotes = notes;

    this.games = createGamesStore({
      store: this.store,
      onMutated: (gameIds) => {
        if (!this.store.settings.generateGameNotes) return;
        for (const id of gameIds) {
          const game = this.games?.getGame(id);
          if (!game) {
            notes.forget(id);
            continue;
          }
          void notes.sync(game, this.store.games.settings, true);
        }
      },
    });

    this.igdb = createIgdbClient({
      credentials: () => ({
        clientId: this.store.settings.igdbClientId,
        clientSecret: this.store.settings.igdbClientSecret,
      }),
      readToken: () => readExtra<IgdbTokenCache>(this.store.settings, "igdbToken"),
      writeToken: (token) => {
        writeExtra(this.store.settings, "igdbToken", token);
        this.store.save("igdb-token");
      },
    });

    this.steam = createSteamClient({
      credentials: () => ({
        apiKey: this.store.settings.steamApiKey,
        steamId: this.store.settings.steamId,
      }),
    });

    // The settings tab's Test button reads this. The anime clients are bound in
    // wireAnimeClients() instead — `integrations` does not exist yet when this
    // runs during onload.
    this.clients.igdb = this.igdb;
    this.clients.steam = this.steam;

    // Where each note lives now, so the first rename moves rather than
    // duplicates — without touching the vault at startup.
    for (const game of this.games.allGames()) notes.remember(game, this.store.games.settings);
  }


  /** Anime test-button clients; must run after `integrations` exists. */
  private wireAnimeClients(): void {
    this.clients.anilist = this.integrations.anime.anilist;
    this.clients.jikan = this.integrations.anime.jikan;
  }

  /** The Games tab's bundle. */
  gamesDeps(): GamesDeps {
    const deps: GamesDeps = {
      app: this.app,
      store: this.store,
      ...(this.games ? { games: this.games } : {}),
      onOpenNote: (game) => {
        void this.openGameNote(game);
      },
    };
    // An unconfigured client is not handed over at all: the modal shows the
    // manual form, and the Steam button never appears.
    if (this.igdb?.configured()) deps.igdb = this.igdb;
    if (this.steam?.configured()) deps.steam = this.steam;
    return deps;
  }

  /** "Open note" for a game — writes it first when it is not there yet. */
  private async openGameNote(game: Game): Promise<void> {
    const notes = this.gameNotes;
    if (!notes) return;
    if (!this.store.settings.generateGameNotes) {
      new Notice("Game notes are off — turn them on in the plugin's settings.");
      return;
    }
    const settings = this.store.games.settings;
    const path = await notes.sync(game, settings, true);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Watch, Read and Learn could not create a note for «${game.title}».`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  /** The ⋮ menu's "Open note" — writes the note first if it is not there yet. */
  private async openNote(title: TitleV4): Promise<void> {
    const notes = this.notes;
    if (!notes) return;
    if (!this.store.settings.generateNotes) {
      new Notice("Note generation is off — turn it on in the plugin's settings.");
      return;
    }
    await notes.sync(title, this.store.settings);
    const file = this.app.vault.getAbstractFileByPath(notes.pathFor(title, this.store.settings));
    if (!(file instanceof TFile)) {
      new Notice(`Watch, Read and Learn could not create a note for «${title.title}».`);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private async readNotesBack(titleId: string): Promise<void> {
    const notes = this.notes;
    if (!notes) return;
    const title = this.store.getTitle(titleId);
    if (!title) return;
    const text = await notes.readNotes(title, this.store.settings);
    if (text === undefined || text === title.notes) return;
    this.store.updateTitle(titleId, { notes: text }, "note-read-back");
  }

  /** Regenerate every note — after switching `generateNotes` on, mostly. */
  private async syncAllNotes(): Promise<void> {
    const notes = this.notes;
    if (!notes) return;
    if (!this.store.settings.generateNotes) {
      new Notice("Note generation is off — turn it on in the plugin's settings first.");
      return;
    }
    const titles = [...this.store.allTitles()];
    const notice = new Notice(`Writing ${titles.length} note(s)…`, 0);
    for (const title of titles) await notes.sync(title, this.store.settings);
    notice.hide();
    new Notice(`Watch, Read and Learn wrote ${titles.length} note(s).`);
  }

  // -------------------------------------------------------------------------
  // Reading (SPEC2 §D-READING)
  // -------------------------------------------------------------------------

  /**
   * The reading store, its note mirror, and nothing else.
   *
   * Wired exactly like the title notes: every mutation the domain makes calls
   * back here, the note is written, and `vaultPage` is kept truthful — v3 wrote
   * that field and a v3 vault's links point at it. A note write that fails is
   * logged and dropped; it must never take a rating with it.
   */
  private setupReading(): void {
    const notes = new ReadingNoteWriter(this.app);
    this.readingNotes = notes;

    const reading = this.store.reading;
    for (const entry of [...reading.books, ...reading.manga]) {
      notes.remember(entry, this.store.settings, reading);
    }

    this.reading = createReadingStore(this.store, {
      onChanged: (entry, kind, id) => {
        if (!entry) {
          notes.forget(id);
          return;
        }
        if (!this.store.settings.generateReadingNotes) return;
        void notes
          .sync(entry, kind, this.store.settings, this.store.reading)
          .then((path) => {
            // Written *without* going back through the store: `vaultPage` is
            // bookkeeping about where the mirror landed, not a user edit, and
            // routing it through `update` would loop straight back into here.
            if (path && entry.vaultPage !== path) entry.vaultPage = path;
          })
          .catch(() => undefined);
      },
    });

    // The reading bookmark + PDF progress (bookfile.ts): every few seconds
    // note which page any open linked PDF sits on. The bookmark is written in
    // place (cheap, no note churn); *progress* goes through the store via
    // progressPatch — status flips, date stamps, note sync — throttled to a
    // few pages per flush, plus one final flush when a PDF closes.
    const readingStore = this.reading;
    const pdfFlushedAt = new Map<string, number>();
    let pdfOpenBefore = new Set<string>();
    this.registerInterval(
      window.setInterval(() => {
        const open = openPdfPages(this.app);
        let bookmarkChanged = false;
        for (const { path, page } of open) {
          if (recordBookPage(this.store.reading, path, page)) bookmarkChanged = true;
        }
        if (bookmarkChanged) this.store.save("reading-bookmark");

        // A closed PDF gets one last look at its remembered page, with the
        // stride waived — leaving the book is exactly when the bar must land.
        const openNow = new Set(open.map((o) => o.path));
        const lastLooks = [...pdfOpenBefore]
          .filter((path) => !openNow.has(path))
          .flatMap((path) => {
            pdfFlushedAt.delete(path);
            const book = this.store.reading.books.find((b) => (b.filePath ?? "").trim() === path);
            const page = book?.filePage;
            return book && typeof page === "number" ? [{ path, page }] : [];
          });
        pdfOpenBefore = openNow;

        const actions = [
          ...pdfProgressActions(this.store.reading.books, open, pdfFlushedAt),
          ...pdfProgressActions(this.store.reading.books, lastLooks, new Map(), 1),
        ];
        for (const action of actions) {
          const book = readingStore.getBook(action.id);
          if (!book) continue;
          const patch = progressPatch(book, action.read);
          if (action.adoptTotal !== undefined) patch.totalPages = action.adoptTotal;
          readingStore.updateBook(action.id, patch, "reading-pdf-progress");
        }
      }, 5000),
    );
  }

  /** Create (if needed) and open the note for a reading entry. */
  private async openReadingNote(entry: ReadingEntry, kind: ReadingKind): Promise<void> {
    const notes = this.readingNotes;
    if (!notes) return;
    if (!this.store.settings.generateReadingNotes) {
      new Notice("Reading notes are off — turn them on in the plugin's settings.");
      return;
    }
    const path = await notes.sync(entry, kind, this.store.settings, this.store.reading);
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) {
      new Notice(`Watch, Read and Learn could not create a note for «${entry.title}».`);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  /** The Reading tab's bundle. Book clients are injected, never imported by it. */
  readingDeps(): ReadingDeps {
    const deps: ReadingDeps = { app: this.app, store: this.store };
    if (this.reading) deps.reading = this.reading;
    if (this.clients.openLibrary) deps.openLibrary = this.clients.openLibrary;
    if (this.clients.googleBooks) deps.googleBooks = this.clients.googleBooks;
    if (this.store.settings.generateReadingNotes) {
      deps.onOpenNote = (entry, kind) => {
        void this.openReadingNote(entry, kind);
      };
    }
    return deps;
  }

  // -------------------------------------------------------------------------
  // Cross-lane wiring
  // -------------------------------------------------------------------------

  /** Bind every seam the lanes left. The only place this happens. */
  private wireHooks(): void {
    this.clients = {
      overseerr: this.integrations.overseerr,
      plex: this.integrations.plex,
      tmdb: this.integrations.tmdb,
      // Books: Open Library needs no key at all, Google Books needs one to be
      // usable at all (its anonymous quota is zero). Both are built either way;
      // `configured()` is what decides whether the Add modal offers them.
      openLibrary: createOpenLibraryClient(() => ({
        userAgent: this.store.settings.openLibraryUserAgent,
      })),
      googleBooks: createGoogleBooksClient(() => ({
        apiKey: this.store.settings.googleBooksApiKey,
      })),
    };

    this.hooks = {
      openAddModal: () => this.openAddModal(),
      openDetailModal: (title) => this.openDetailModal(title),
      openTrailer: (title) => {
        openTrailer(this.app, title, this.store.settings.trailerMode);
      },
      requestTitle: (title) => {
        void runRequestFlow(this.app, title, this.integrations.requests);
      },
      refreshPlexIndex: () => this.integrations.refreshPlexIndex(),
      refreshAiring: () => this.integrations.refreshAiring(),
      buildCard: (parent, title, ctx) => {
        buildTitleCard(parent, title, ctx);
      },
      ...(this.posterLoader ? { posterLoader: this.posterLoader } : {}),
      parseWidget: (source) => parseWidgetSource(source),
    };
  }

  /**
   * The dependency bundle every aux tab and every code block is built from.
   *
   * `onPlayTrailer` is omitted when trailers are off or the title has none —
   * the foodspot rule that an affordance the data cannot support is not shown
   * rather than shown and dead.
   */
  tabDeps(): TabDeps {
    // The Upcoming toolbar opens two modals of its own (search tips, saved
    // views); every other aux surface ignores this.
    const deps: TabDeps = { store: this.store, app: this.app };
    if (this.hooks.buildCard) deps.buildCard = this.hooks.buildCard;
    if (this.posterLoader) deps.posterLoader = this.posterLoader;
    deps.onOpenTitle = (title) => this.openDetailModal(title);
    deps.onRequest = (title) => {
      void runRequestFlow(this.app, title, this.integrations.requests);
    };
    if (this.store.settings.trailerMode !== "off") {
      deps.onPlayTrailer = (title) => {
        if (!hasTrailer(title)) return;
        openTrailer(this.app, title, this.store.settings.trailerMode);
      };
    }
    deps.onAddSeason = (title, seasonNumber) => {
      void this.addSeasonToTracker(title, seasonNumber);
    };
    deps.onOpenInPlex = (title) => {
      void this.integrations.openInPlex(title);
    };
    deps.onAcknowledge = (title, entry) => {
      // A user action, so it goes through `updateTitle` rather than the silent
      // cache path — the Upcoming tab redraws off the same change event.
      this.store.updateTitle(title.id, acknowledgePatch(entry), "upcoming-acknowledged");
    };
    /**
     * The Upcoming tab's refresh, both flavours (QA2 report 1, fix 4).
     *
     * Quiet (on mount): the throttled, TTL-respecting catch-up — cheap when
     * nothing is stale. Announced (the button): force everything, because a
     * user who pressed Refresh is asking a question and deserves an answer
     * rather than a no-op.
     */
    deps.onRefresh = async (announce: boolean): Promise<string> => {
      if (!announce) {
        await this.integrations.catchUpThrottled();
        return "";
      }
      const airing = await this.integrations.refreshAiring({ force: true });
      if (!this.integrations.plex.configured()) return airing;
      const plex = await this.integrations.refreshPlexIndex();
      return `${airing} ${plex}`;
    };
    deps.onJumpToQuery = (query: string) => this.openLibraryWithQuery(query);
    deps.onExportCalendar = () => {
      void this.exportUpcomingCalendar();
    };
    deps.onOpenDomainEntry = (domain, id) => this.openDomainEntry(domain, id);
    deps.onGoToTab = (tab) => {
      void this.activateView().then((view) => view?.setActiveTab(tab));
    };
    return deps;
  }

  /**
   * The Drafts scanner (SPEC2-PARITY.md §D-EXTRAS, item 2).
   *
   * Started once, on load, so the first sweep is done before anyone opens the
   * Library and the toolbar badge is right the first time it is drawn.
   */
  private setupDrafts(): void {
    const service = new DraftsService({
      app: this.app,
      store: this.store,
      onAddToWatchlist: (title, onAdded) => {
        this.openAddModal(() => onAdded(), title);
      },
    });
    this.drafts = service;
    this.register(() => {
      service.destroy();
      this.drafts = null;
    });
    // After the workspace settles: the sweep reads every tagged note, and
    // startup is not the moment to do that.
    //
    // The callback can outlive the plugin — unload before the workspace is ready
    // is unusual but perfectly possible — so it checks that this service is
    // still the live one before attaching a vault-wide listener (W8 review
    // P2-1). `start()` refuses after destruction too; belt and braces, because
    // the leak is permanent for the session.
    this.app.workspace.onLayoutReady(() => {
      if (this.drafts !== service) return;
      service.start();
    });
  }

  /** Toggle the Drafts panel inside the Library's drawer host. */
  private toggleDraftsPanel(host: HTMLElement): void {
    const open = host.querySelector(".wl-drafts-panel");
    if (open) {
      this.draftsPanel?.destroy();
      this.draftsPanel = null;
      open.remove();
      return;
    }
    const service = this.drafts;
    if (!service) return;
    this.draftsPanel = renderDraftsPanel(host, service, this.app);
    // Opening the panel is the moment to check the vault again — a note edited
    // in another window is exactly what someone is looking for here.
    void service.scan();
  }

  private draftsPanel: { destroy(): void } | null = null;

  /**
   * What the vault already holds for a domain whose tab is still a stub.
   *
   * `data.reading` and `data.games` have been round-tripping untouched since v4
   * shipped, so a user who had books in v3 still has them. An empty tab that
   * does not say that reads as data loss; this is the sentence that prevents it.
   */
  stubDataNote(domain: "reading" | "games"): string | undefined {
    if (domain === "reading") {
      const reading = this.store.data.reading;
      const books = reading?.books.length ?? 0;
      const manga = reading?.manga.length ?? 0;
      if (books + manga === 0) return undefined;
      const parts: string[] = [];
      if (books > 0) parts.push(`${books} book${books === 1 ? "" : "s"}`);
      if (manga > 0) parts.push(`${manga} manga`);
      return `${parts.join(" and ")} already in your data file, kept exactly as they are.`;
    }
    const games = this.store.data.games?.games.length ?? 0;
    if (games === 0) return undefined;
    return `${games} game${games === 1 ? "" : "s"} already in your data file, kept exactly as they are.`;
  }

  /** The Library tab's own bundle — it owns more affordances than the others. */
  libraryDeps(): LibraryDeps {
    const deps: LibraryDeps = {
      app: this.app,
      store: this.store,
      engine: createLibraryEngine(this.store.settings),
      overseerr: this.integrations.overseerr,
      onRequest: (title) => {
        void runRequestFlow(this.app, title, this.integrations.requests);
      },
      onOpenInPlex: (title) => {
        void this.integrations.openInPlex(title);
      },
      onOpenInOverseerr: (title) => this.integrations.openInOverseerr(title),
      onOpenNote: (title) => {
        void this.openNote(title);
      },
      onAddTitle: (afterAdd) => this.openAddModal(afterAdd),
      onSurprise: () => this.openSurpriseModal(),
      onRefreshMetadata: (title) => {
        void this.refreshMetadata(title);
      },
      onFindMatch: (title) => this.openMatchModal(title),
      onOpenDrafts: (host) => this.toggleDraftsPanel(host),
      draftCount: () => this.drafts?.count() ?? 0,
      onMountExtras: (ext) => mountGroupsExtension(ext, { app: this.app, store: this.store }),
    };
    if (this.store.settings.trailerMode !== "off") {
      deps.onPlayTrailer = (title) => {
        openTrailer(this.app, title, this.store.settings.trailerMode);
      };
    }
    return deps;
  }

  /**
   * The one Add entry point (SPEC §7 — the composition root owns the seams).
   *
   * Every caller routes through here so the post-add refresh cannot be skipped:
   * the Library's own button used to build the modal itself and only opened the
   * detail view afterwards, leaving the new card without a Plex badge until the
   * next sweep.
   *
   * `afterAdd` lets a caller add its own follow-up (the Library opens the detail
   * modal) without owning any of the refresh logic. `initialQuery` is for
   * callers that already have the name — the Drafts panel, which got it out of
   * a note.
   */
  openAddModal(afterAdd?: (title: TitleV4) => void, initialQuery?: string): void {
    new AddTitleModal(this.app, {
      store: this.store,
      client: this.integrations.overseerr,
      ...(initialQuery ? { initialQuery } : {}),
      onAdded: (result) => {
        // A freshly added title has no Plex or airing data; fetch both now so
        // the card is not blank for the next twelve hours. Overseerr's
        // `mediaInfo` carries the Plex `ratingKey` when its sync has run, which
        // turns the first lookup into one metadata call instead of a full
        // GUID-index build (report-overseerr-tmdb §1.3).
        void this.integrations
          .refreshTitlePlex(result.title, false, { mediaInfo: result.mediaInfo })
          .catch(() => undefined);
        void this.integrations.refreshAiring({ force: false }).catch(() => undefined);
        if (afterAdd) afterAdd(result.title);
        else if (this.store.settings.openLibraryAfterAdd) this.openDetailModal(result.title);
      },
    }).open();
  }

  private openDetailModal(title: TitleV4): void {
    const options: ConstructorParameters<typeof DetailModal>[1] = {
      store: this.store,
      titleId: title.id,
      onJumpToQuery: (query) => this.openLibraryWithQuery(query),
      onRequest: (t) => {
        void runRequestFlow(this.app, t, this.integrations.requests);
      },
      onOpenInPlex: (t) => {
        void this.integrations.openInPlex(t);
      },
      onOpenNote: (t) => {
        void this.openNote(t);
      },
      onRefreshMetadata: (t) => {
        void this.refreshMetadata(t);
      },
      onFindMatch: (t) => this.openMatchModal(t),
    };
    if (this.store.settings.trailerMode !== "off") {
      options.onPlayTrailer = (t) => {
        openTrailer(this.app, t, this.store.settings.trailerMode);
      };
    }
    new DetailModal(this.app, options).open();
  }

  /**
   * "Season N announced" → on the tracker, in one click (SPEC §4.4).
   *
   * The upstream episode count comes from the airing cache (or one details call
   * if it is missing), the season is appended in number order, offsets are
   * recomputed — which the watched-episode rebase translates through, so nothing
   * you have watched is renumbered — the announcement is cleared, and the whole
   * thing lands as one write.
   */
  /**
   * The manual TMDB picker (QA2 report 1).
   *
   * Adopting an id is the moment a migrated v3 title stops being invisible to
   * the airing and availability engines, so the metadata pull that follows is
   * part of the same action rather than something the user has to think to do.
   */
  private openMatchModal(title: TitleV4): void {
    if (!this.integrations.overseerr.configured()) {
      new Notice("Add an Overseerr server in the plugin's settings first.");
      return;
    }
    new MatchTitleModal(this.app, {
      store: this.store,
      client: this.integrations.overseerr,
      title,
      onPicked: (tmdbId, mediaType) => {
        const notice = new Notice(`Linking «${title.title}»…`, 0);
        void this.integrations
          .adoptMatch(title, tmdbId, mediaType)
          .then((message) => {
            notice.hide();
            new Notice(message);
          })
          .catch((err: unknown) => {
            notice.hide();
            new Notice(`Could not link that title: ${err instanceof Error ? err.message : String(err)}`);
          });
      },
    }).open();
  }

  private async addSeasonToTracker(title: TitleV4, seasonNumber: number): Promise<void> {
    const live = this.store.getTitle(title.id);
    if (!live) return;
    if (live.seasons.some((s, i) => (s.seasonNumber ?? i + 1) === seasonNumber)) {
      new Notice(`«${live.title}» already has season ${seasonNumber}.`);
      return;
    }

    // Zero is normal, not a failure: a season is usually announced months
    // before TMDB enumerates its episodes (Dexter's Season 2 is 0 episodes and
    // undated upstream right now). Add it empty and let the next refresh that
    // finds a real count fill it in — refusing to add it is what made the
    // one-click action useless for the case it exists for (QA2 report 1).
    const episodes = await this.integrations.upstreamSeasonEpisodes(live, seasonNumber);

    const current = this.store.getTitle(title.id);
    if (!current) return;
    const seasons = withAddedSeason(current.seasons, seasonNumber, episodes);
    const airing = { ...(current.airing ?? {}) };
    delete airing.newSeasonDetected;
    delete airing.newSeasonEpisodes;

    this.store.updateTitle(
      current.id,
      { seasons, totalEpisodes: totalFromSeasons(seasons), airing },
      "season-added",
    );
    this.store.logActivity({
      action: "season",
      message: `Season ${seasonNumber} of «${current.title}» was added to the tracker`,
      titleId: current.id,
      titleName: current.title,
      source: "Watchlist",
    });
    new Notice(
      episodes > 0
        ? `Added season ${seasonNumber} (${episodes} episodes) to «${current.title}».`
        : `Added season ${seasonNumber} to «${current.title}». Its episode count lands when upstream publishes one.`,
    );
  }

  private async refreshMetadata(title: TitleV4): Promise<void> {
    const notice = new Notice(`Refreshing «${title.title}»…`, 0);
    try {
      const message = await this.integrations.refreshTitleMetadata(title);
      notice.hide();
      new Notice(message);
    } catch (err) {
      notice.hide();
      new Notice(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[wrl] metadata refresh failed", err);
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private registerCommands(): void {
    this.addCommand({
      id: "open-watchlog",
      name: "Open the plugin",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "add-title",
      name: "Add title",
      callback: () => this.openAddModal(),
    });

    this.addCommand({
      id: "insert-widget",
      name: "Insert widget",
      editorCallback: (editor: Editor) => {
        openWidgetPalette(this.app, this.store, editor);
      },
    });

    this.addCommand({
      id: "refresh-plex-index",
      name: "Refresh Plex index",
      callback: () => {
        void this.runRefresh(
          () => this.integrations.refreshPlexIndex({ force: true }),
          "Refreshing the Plex index…",
        );
      },
    });

    this.addCommand({
      id: "refresh-airing",
      name: "Refresh airing data",
      callback: () => {
        void this.runRefresh(
          () => this.integrations.refreshAiring({ force: true }),
          "Refreshing airing data…",
        );
      },
    });

    // CSV (SPEC2-PARITY.md §D-EXTRAS, item 3). Commands rather than buttons: an
    // import/export is a once-a-year action, and the palette is where those live
    // without costing the toolbar a slot.
    this.addCommand({
      id: "export-csv",
      name: "Export to CSV",
      callback: () => new CsvExportModal(this.app, this.store).open(),
    });

    this.addCommand({
      id: "import-csv",
      name: "Import from CSV",
      callback: () =>
        new CsvImportModal(this.app, this.store, () => {
          // A fresh import has no Plex or airing data; the throttled catch-up
          // fills it in without blocking the dialog closing.
          void this.integrations.catchUpThrottled().catch(() => undefined);
        }).open(),
    });

    this.addCommand({
      id: "rescan-drafts",
      name: "Rescan drafts",
      callback: () => {
        const service = this.drafts;
        if (!service) return;
        void service.scan().then(() => {
          const count = service.count();
          new Notice(
            count === 0
              ? "No drafts waiting."
              : `${count} draft${count === 1 ? "" : "s"} waiting in the Library.`,
          );
        });
      },
    });

    this.addCommand({
      id: "search-title",
      name: "Search title",
      callback: () => {
        const titles = [...this.store.allTitles()];
        if (titles.length === 0) {
          new Notice("Nothing tracked yet — add a title first.");
          return;
        }
        new TitleSearchModal(this, titles).open();
      },
    });

    this.addCommand({
      id: "export-upcoming-calendar",
      name: "Export upcoming to calendar (.ics)",
      callback: () => {
        void this.exportUpcomingCalendar();
      },
    });

    this.addCommand({
      id: "surprise-me",
      name: "Surprise me — pick something to watch",
      callback: () => this.openSurpriseModal(),
    });

    this.addCommand({
      id: "refresh-book-ratings",
      name: "Fetch public ratings for all books",
      callback: () => {
        void this.refreshBookRatings();
      },
    });

    // A plugin that can reload itself turns "toggle it off and on in Community
    // plugins" into one click after every deploy of a new build.
    this.addCommand({
      id: "reload-plugin",
      name: "Reload the plugin (pick up a new build)",
      callback: () => {
        void this.reloadSelf();
      },
    });
  }

  /** One entry point for the command, the toolbar dice and the deep link. */
  openSurpriseModal(): void {
    new SurpriseModal(this.app, {
      titles: [...this.store.allTitles()],
      onAccept: (title) => this.openLibraryWithQuery(`"${title.title}"`),
    }).open();
  }

  /**
   * Disable + re-enable this plugin so a freshly deployed `main.js` is picked
   * up without a trip through Community plugins. `app.plugins` is unofficial
   * API — the same one BRAT reloads through — so it is feature-detected and
   * the button degrades to a message rather than a crash if it ever moves.
   */
  async reloadSelf(): Promise<void> {
    const id = this.manifest.id;
    const plugins = (
      this.app as unknown as {
        plugins?: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> };
      }
    ).plugins;
    if (!plugins?.disablePlugin || !plugins.enablePlugin) {
      new Notice("Reload is not available — toggle the plugin in Community plugins instead.");
      return;
    }
    // Flush BEFORE disabling. Obsidian does not await an async onunload, so a
    // reload that relies on onunload's flush can hand the next instance a
    // half-written data.json — the torn read the load guard exists for. Better
    // to never produce it: the disk is settled before the old instance dies.
    if (!(await this.saveNow("your changes before reloading"))) return;
    new Notice("Reloading the plugin…");
    await plugins.disablePlugin(id);
    await plugins.enablePlugin(id);
  }

  /**
   * "Fetch public ratings for all books" — one pass over the shelf through
   * the rate-limited Google client. Books stamped within the last day are
   * skipped, so re-running after adding one book asks about one book.
   */
  private async refreshBookRatings(): Promise<void> {
    const google = this.clients.googleBooks;
    const readingStore = this.reading;
    if (!google || !google.configured() || !readingStore) {
      new Notice("Set a Google Books API key in the plugin's settings first.");
      return;
    }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const due = this.store.reading.books.filter((book) => {
      const stamped = Date.parse(book.communityRatingLastFetched ?? "");
      return !(stamped > dayAgo);
    });
    if (due.length === 0) {
      new Notice("Every book's public rating is fresh.");
      return;
    }
    const notice = new Notice(`Fetching public ratings for ${due.length} book(s)…`, 0);
    let found = 0;
    try {
      for (const book of due) {
        try {
          const info = await fetchBookRating(google, book);
          readingStore.updateBook(
            book.id,
            communityRatingPatch(info, book, new Date()),
            "reading-community-rating",
          );
          if (info.rated) found += 1;
        } catch (err) {
          console.error(`[wrl] rating fetch failed for "${book.title}"`, err);
        }
      }
    } finally {
      notice.hide();
    }
    new Notice(`Public ratings: ${found} of ${due.length} book(s) rated on Google.`);
  }

  /**
   * `obsidian://watchlog` deep links — parsing lives in `src/uri.ts`, this is
   * only the dispatch. Invalid links get a Notice with the reason: a typo in
   * an automation should be heard, not swallowed.
   *
   * Both spellings are live: `watchlog` because links already exist in the
   * wild, `watch-read-learn` because that is the plugin's name now.
   */
  private registerUriHandler(): void {
    for (const action of ["watchlog", "watch-read-learn"]) this.registerUriAction(action);
  }

  private registerUriAction(action: string): void {
    this.registerObsidianProtocolHandler(action, (params) => {
      const route = parseWatchlogRoute(params);
      switch (route.action) {
        case "open":
          if (route.query !== "") this.openLibraryWithQuery(route.query, route.tab);
          else void this.activateView().then((view) => view?.setActiveTab(route.tab));
          break;
        case "add":
          this.openAddModal(undefined, route.query === "" ? undefined : route.query);
          break;
        case "surprise":
          this.openSurpriseModal();
          break;
        case "invalid":
          new Notice(`Watch, Read and Learn link: ${route.reason}`);
          break;
      }
    });
  }

  /** Shared body for the two refresh commands: notice → run → report. */
  private async runRefresh(
    run: () => Promise<string>,
    pendingMessage: string,
  ): Promise<void> {
    const notice = new Notice(pendingMessage, 0);
    try {
      const summary = await run();
      notice.hide();
      new Notice(summary || "Done.");
    } catch (err) {
      notice.hide();
      new Notice(`Watch, Read and Learn refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[wrl] refresh failed", err);
    }
  }

  /**
   * "Export upcoming to calendar" — the unified Upcoming rows as an all-day
   * `.ics` at the vault root. Re-running overwrites the same file; the UIDs
   * inside are stable, so a calendar subscribed to it updates rather than
   * duplicates.
   */
  private async exportUpcomingCalendar(): Promise<void> {
    const path = "Watch, Read and Learn Upcoming.ics";
    try {
      const rows = buildUnifiedUpcoming(
        this.store.allTitles(),
        this.store.reading,
        this.store.games,
      );
      const { ics, eventCount, skippedUndated } = buildUpcomingIcs(rows, { now: new Date() });
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, ics);
      } else {
        await this.app.vault.create(path, ics);
      }
      const skipped = skippedUndated > 0 ? ` (${skippedUndated} undated skipped)` : "";
      new Notice(`Wrote ${eventCount} event(s) to ${path}${skipped}.`);
    } catch (err) {
      new Notice(`Calendar export failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[wrl] calendar export failed", err);
    }
  }

  // -------------------------------------------------------------------------
  // Code blocks
  // -------------------------------------------------------------------------

  private registerWidgets(): void {
    const deps = this.tabDeps();
    this.widgets = new WidgetSystem(
      this,
      this.hooks.parseWidget ? { ...deps, parse: this.hooks.parseWidget } : { ...deps },
    );
    this.widgets.registerDefaultFence();
    registerLegacyFences(this.widgets);
  }

  // -------------------------------------------------------------------------
  // Status bar
  // -------------------------------------------------------------------------

  private setupStatusBar(): void {
    // Mobile has no status bar to put this in.
    if (Platform.isMobile) return;

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("wl-statusbar");
    this.statusBarEl.addEventListener("click", () => {
      void this.activateView().then((view) => view?.setActiveTab("upcoming"));
    });

    const onChanged = (): void => this.refreshStatusBar();
    document.addEventListener(DATA_CHANGED_EVENT, onChanged);
    this.register(() => document.removeEventListener(DATA_CHANGED_EVENT, onChanged));

    // Countdowns are date-based, so the count goes stale at midnight even when
    // nothing changes. A five-minute tick is plenty and costs nothing.
    this.registerInterval(window.setInterval(() => this.refreshStatusBar(), 5 * 60 * 1000));

    this.refreshStatusBar();
  }

  /** Public so the settings toggle can repaint it immediately. */
  refreshStatusBar(): void {
    const el = this.statusBarEl;
    if (!el) return;
    el.empty();

    if (!this.store.settings.showUpcomingStatusBar) {
      el.toggleClass("is-hidden", true);
      return;
    }
    el.toggleClass("is-hidden", false);

    // Every library, in one number (SPEC2: the status bar is unified). The
    // sentence splits per library only when more than one contributes — "3 due
    // today" is fine until two of them are books.
    const rows = buildUnifiedUpcoming(
      this.store.allTitles(),
      this.store.reading,
      this.store.games,
    );
    const text = statusBarText(rows);
    if (text === "") {
      el.setText("");
      el.setAttr("aria-label", "Watch, Read and Learn — nothing due today");
      return;
    }
    el.setText(text);
    const counts = countUnified(rows.filter((row) => row.daysUntil !== null && row.daysUntil <= 0));
    el.setAttr(
      "aria-label",
      `Watch, Read and Learn — ${counts.total} item(s) due today across ${
        Object.values(counts.bySource).filter((n) => n > 0).length
      } librar${Object.values(counts.bySource).filter((n) => n > 0).length === 1 ? "y" : "ies"}`,
    );
  }

  // -------------------------------------------------------------------------
  // View plumbing
  // -------------------------------------------------------------------------

  /** Reuse an open the plugin leaf if there is one, else open a new tab. */
  async activateView(): Promise<WatchLogView | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_WATCHLOG);
    const leaf = existing[0] ?? workspace.getLeaf("tab");
    if (!existing[0]) {
      await leaf.setViewState({ type: VIEW_TYPE_WATCHLOG, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view instanceof WatchLogView ? leaf.view : null;
  }

  /** Read-and-clear, so a parked query is applied exactly once. */
  takePendingLibraryQuery(): string | null {
    const query = this.pendingLibraryQuery;
    this.pendingLibraryQuery = null;
    return query;
  }

  /**
   * Open the Library tab with a search query applied (foodspot's handoff).
   *
   * Two paths, because the view may not exist yet: a live view is told directly
   * so it can drain the query into an already-mounted Library, and a cold start
   * parks it for `onOpen` to pick up.
   */
  openLibraryWithQuery(query: string, domain: TabId = "library"): void {
    const open = this.app.workspace.getLeavesOfType(VIEW_TYPE_WATCHLOG);
    const live = open[0]?.view;
    if (live instanceof WatchLogView) {
      this.app.workspace.revealLeaf(open[0] as WorkspaceLeaf);
      live.jumpToQuery(query, domain);
      return;
    }
    // Nothing is open yet: park it and let the view drain it on mount. Only the
    // Library has a parking slot, so a parity query opens the view and then
    // routes — one extra tick, no lost query.
    if (domain === "library") {
      this.pendingLibraryQuery = query;
      void this.activateView();
      return;
    }
    void this.activateView().then((view) => view?.jumpToQuery(query, domain));
  }

  /**
   * Reveal one entry of a parity library — an Upcoming row or a code-block row.
   *
   * Implemented through the query handoff rather than a new controller method:
   * landing on the tab *filtered to that entry* is the same motion the chips
   * make, and it leaves the user somewhere they can act rather than in a modal
   * over the wrong tab.
   */
  openDomainEntry(domain: "reading" | "games", id: string): void {
    const name =
      domain === "games"
        ? this.store.games.games.find((game) => game.id === id)?.title
        : [...this.store.reading.books, ...this.store.reading.manga].find(
            (entry) => entry.id === id,
          )?.title;
    if (!name) return;
    this.openLibraryWithQuery(`"${name}"`, domain);
  }
}

/** "Search title" — fuzzy over the user's own titles, landing in the Library. */
class TitleSearchModal extends FuzzySuggestModal<TitleV4> {
  constructor(
    private readonly plugin: WatchLogPlugin,
    private readonly titles: TitleV4[],
  ) {
    super(plugin.app);
    this.setPlaceholder("Search your titles…");
  }

  override getItems(): TitleV4[] {
    return this.titles;
  }

  override getItemText(title: TitleV4): string {
    return `${title.title} ${title.type} ${title.status} ${(title.genres ?? []).join(" ")}`;
  }

  override onChooseItem(title: TitleV4): void {
    // Land on the filtered Library, not on a modal: the command is "search",
    // and leaving the user somewhere they can keep searching is the point.
    this.plugin.openLibraryWithQuery(`"${title.title}"`);
  }
}
