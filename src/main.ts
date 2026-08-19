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
import { repathAfterRename } from "./data/paths";
import {
  buildReadingEntry,
  createReadingStore,
  findExistingReading,
  readingCacheEntries,
  ReadingDetailModal,
  ReadingNoteWriter,
  type ReadingDeps,
  type ReadingEntry,
  type ReadingStore,
} from "./domains/reading";
import { seedFromHit } from "./domains/reading/modals/add";
import { openPdfPages, pdfProgressActions, recordBookPage } from "./domains/reading/bookfile";
import { progressPatch } from "./domains/reading/progress";
import { communityRatingPatch, fetchBookRating } from "./domains/reading/community";
import { fillPageCountsFromFiles } from "./domains/reading/pdfpages";
import { totalPatchFor } from "./domains/reading/progress";
import { createGoogleBooksClient } from "./services/googlebooks";
import {
  createOpenLibraryClient,
  type OpenLibraryClientWithAuthors,
} from "./services/openlibrary";
import { totalFromSeasons, withAddedSeason } from "./data/episodes";
import { reconcileJudgements } from "./data/review";
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
import {
  createImageCache,
  DEFAULT_IMAGE_CACHE_FOLDER,
  normalizeCacheFolder,
  type ImageCache,
} from "./services/imagecache";
import {
  createPersonService,
  createTmdbPersonClient,
  creditNamesOf,
  type PersonService,
} from "./services/tmdb-person";
import {
  openPersonView,
  registerPersonView,
  type PersonScreenDeps,
  type PersonTarget,
} from "./ui/views/person";
import {
  openTitleDetail,
  registerTitleDetailView,
  type TitleDetailDeps,
} from "./ui/views/title-detail";
import {
  authorOpener,
  openAuthorView,
  registerAuthorView,
  type AuthorScreenDeps,
  type AuthorTarget,
} from "./ui/views/author";
import {
  openBookDetail,
  registerBookDetailView,
  type BookDetailDeps,
} from "./ui/views/book-detail";
import {
  authorNamesOf,
  createAuthorService,
  type AuthorService,
  type AuthorStoreLike,
} from "./services/openlibrary-author";
import { posterCacheEntries } from "./ui/components/posters";
import { DraftsService, renderDraftsPanel } from "./domains/drafts/panel";
import { mountGroupsExtension } from "./domains/groups/panel";
import { CsvExportModal, CsvImportModal } from "./domains/csv/modals";
import { buildTitleCard } from "./ui/components/card";
import { createPosterLoader } from "./ui/components/posters";
import { AddTitleModal, buildTitleForHit, findExisting } from "./ui/modals/add";
import { confirmAction } from "./ui/modals/confirm";
import { DetailModal } from "./ui/modals/detail";
import { MatchTitleModal } from "./ui/modals/match";
import { openRecovery } from "./ui/modals/recovery";
import { runRequestFlow } from "./ui/modals/request";
import { openSuggestWizard } from "./ui/modals/suggest";
import { moreLikeBook, suggestFromShelf } from "./domains/reading/recommend";
import { bookKey } from "./domains/reading/suggest";
import { createBook } from "./data/schema";
import type { MoreLikeThis } from "./ui/modals/detail";
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
  type Book,
  type BookSearchResult,
  type Game,
  type GamesStoreApi,
  type GoogleBooksClient,
  type IgdbClient,
  type AniListClient,
  type JikanClient,
  type OverseerrClient,
  type PlexClient,
  type PosterLoader,
  type ReadingKind,
  type SteamClient,
  type TabId,
  type OverseerrSearchResult,
  type TitleV4,
  type TmdbClient,
  type WidgetParseResult,
} from "./types";

/** Service clients, exposed for the settings tab's Test buttons. */
export interface WatchLogClients {
  overseerr?: OverseerrClient;
  plex?: PlexClient;
  tmdb?: TmdbClient;
  /**
   * Keyless — always present, and the *only* Open Library client in the plugin.
   *
   * Typed with the author endpoints because the author screen's service needs
   * them and must not build a second client: a second client is a second rate
   * limiter, and two limiters means twice the agreed 3 req/s.
   */
  openLibrary?: OpenLibraryClientWithAuthors;
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

  /**
   * The person screen's cache-and-resolve service (`services/tmdb-person.ts`).
   *
   * Plugin-lifetime rather than view-lifetime: the cache it owns lives in
   * `data.json`, and a leaf that opens and closes must not throw that away.
   */
  private people: PersonService | null = null;

  /**
   * The one Open Library client, built on first use rather than in `wireHooks`.
   *
   * It has to exist before `wireHooks` runs: the author leaf is registered at
   * the top of `onload` (see there for why) and its service needs a client
   * then. Memoised rather than built twice, because a second client would be a
   * second rate limiter — see `WatchLogClients.openLibrary`.
   */
  private openLibraryClient: OpenLibraryClientWithAuthors | null = null;

  /**
   * The author screen's cache-and-resolve service
   * (`services/openlibrary-author.ts`) — the reading-side sibling of `people`,
   * and plugin-lifetime for the same reason: its cache lives in `data.json`.
   */
  private authors: AuthorService | null = null;

  /**
   * Optional local artwork cache (`services/imagecache.ts`).
   *
   * Always constructed, so the settings tab has something to talk to and the
   * enable toggle is a `configure()` call rather than a reload — but it is
   * constructed *disabled* unless the user opted in, and a disabled cache
   * writes nothing, reads nothing and answers `""` to everything.
   */
  imageCache: ImageCache | null = null;

  /** The games domain's seams, bound in `setupGames()`. */
  private games: GamesStoreApi | null = null;
  private gameNotes: GameNoteWriter | null = null;
  private igdb: IgdbClient | null = null;
  private steam: SteamClient | null = null;

  override async onload(): Promise<void> {
    this.store = new WatchLogStore(this);

    // The way in comes first, before anything that reads a disk. The view
    // factory is lazy — it runs when a leaf opens, by which time the store has
    // loaded — so registering here costs nothing and means a slow vault, a
    // failed backup or an unreadable data.json can never leave the user
    // without the icon they open the plugin with.
    this.registerView(VIEW_TYPE_WATCHLOG, (leaf: WorkspaceLeaf) => new WatchLogView(leaf, this));
    this.addRibbonIcon(VIEW_ICON, VIEW_DISPLAY_NAME, () => {
      void this.activateView();
    });

    // The two Wave-3 leaves, registered in the same breath and for the same
    // reason: Obsidian restores a saved workspace layout *after* `onload`
    // returns, so a leaf of either type left open in a previous session is
    // recreated then. A view type that is not registered by that point is shown
    // as "No view of type …" and the user's layout loses a tab. Both factories
    // are lazy and both take their dependencies through closures that read
    // `this` when a leaf actually opens — by which time the store has loaded —
    // so registering here costs nothing and cannot throw.
    registerPersonView(this, this.personScreenDeps());
    registerTitleDetailView(this, () => this.titleDetailDeps());

    // The reading side's two leaves, here for exactly the same reason and with
    // the same guarantee: a book pane or an author pane left open in a previous
    // session is restored after `onload` returns, and an unregistered type is
    // shown as "No view of type …". Registering the book view is also what
    // flips `isBookDetailViewRegistered()` — until it is true, the Reading tab
    // deliberately keeps opening the modal rather than an empty leaf.
    //
    // Neither factory reads anything now. `bookDetailDeps()` is a thunk, and
    // `authorScreenDeps()` returns getters for the two things that do not exist
    // yet at this point in `onload` (the Open Library client, the artwork
    // cache), so both bundles are assembled when a leaf actually opens.
    registerBookDetailView(this, () => this.bookDetailDeps());
    registerAuthorView(this, this.authorScreenDeps());

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

    this.setupImageCache();

    this.wireHooks();

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
      // `catchUp` is where the library-wide metadata sweep is fired from
      // (`integration.ts`) — deliberately last inside it and deliberately not
      // awaited, so the slowest job in the plugin can never be between the user
      // and a working view. Nothing here is awaited either: `onload` has
      // already returned by the time this runs, and it must stay that way.
      void this.integrations.catchUp();
      // Reading the artwork folder is one `list()` on a folder that usually
      // does not exist. Deferred anyway, on the same principle: no disk read
      // this plugin can defer belongs on the startup path.
      void this.primeImageCache();
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

    // Vault → data.json: the paths we store are not links, so Obsidian's own
    // rename handling never touches them. Renaming a folder fires once for the
    // folder, so descendants are matched by prefix.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const result = repathAfterRename(this.store.data, oldPath, file.path);
        if (result.changed === 0) return;
        this.store.save("vault-rename");
        this.store.emitChanged({ reason: "vault-rename" });
        console.log(`[wrl] followed a rename: ${result.changed} stored path(s) updated`);
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

  /**
   * The one Open Library client. Built on first ask, never twice.
   *
   * The config is read through a closure rather than captured, so building this
   * before `store.load()` — which the author leaf's registration does — is safe:
   * the user agent is looked up at request time, not now.
   */
  private openLibrary(): OpenLibraryClientWithAuthors {
    this.openLibraryClient ??= createOpenLibraryClient(() => ({
      userAgent: this.store.settings.openLibraryUserAgent,
    }));
    return this.openLibraryClient;
  }

  /** The Reading tab's bundle. Book clients are injected, never imported by it. */
  readingDeps(): ReadingDeps {
    const deps: ReadingDeps = { app: this.app, store: this.store };
    if (this.reading) deps.reading = this.reading;
    if (this.clients.openLibrary) deps.openLibrary = this.clients.openLibrary;
    if (this.clients.googleBooks) deps.googleBooks = this.clients.googleBooks;
    // The same cache the Library's posters use, handed to the shelves so a
    // cover is read from the vault instead of the CDN. Without this the reading
    // side never touches the cache at render time, which is half of "the cache
    // ignores books" — the other half is the warm/orphan pass below.
    if (this.imageCache) deps.imageCache = this.imageCache;
    if (this.store.settings.generateReadingNotes) {
      deps.onOpenNote = (entry, kind) => {
        void this.openReadingNote(entry, kind);
      };
    }
    // Book suggestions need Open Library and somewhere to put the answer.
    const openLibrary = this.clients.openLibrary;
    const reading = this.reading;
    if (openLibrary && reading) {
      const recommendDeps = {
        openLibrary,
        owned: () => [...this.store.reading.books, ...this.store.reading.manga],
        dismissed: () => this.dismissedBooks(),
      };
      deps.onMoreLikeThis = (entry) => moreLikeBook(recommendDeps, entry);
      deps.onAddSuggestion = async (hit) => {
        const existing = [...this.store.reading.books].find(
          (b) => bookKey(b.title) === bookKey(hit.title),
        );
        if (existing) return true;
        const book = createBook({
          id: reading.nextId("book", hit.title),
          title: hit.title,
          author: hit.authors[0] ?? "",
          coverUrl: hit.coverUrl,
          totalPages: hit.pageCount ?? 0,
        });
        this.store.reading.books.push(book);
        this.store.save("book-suggestion-added");
        this.store.emitChanged({ reason: "book-suggestion-added" });
        return true;
      };
      deps.onDismissSuggestion = (key) => this.dismissBook(key);
    }
    return deps;
  }

  /** Open Library keys the user has refused, persisted like the film ones. */
  private dismissedBooks(): string[] {
    const raw = readExtra<string[]>(this.store.settings, "dismissedBooks");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : [];
  }

  private dismissBook(key: string): void {
    if (!key) return;
    const next = new Set(this.dismissedBooks());
    next.add(key);
    writeExtra(this.store.settings, "dismissedBooks", [...next]);
    this.store.save("book-suggestion-dismissed");
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
      openLibrary: this.openLibrary(),
      googleBooks: createGoogleBooksClient(() => ({
        apiKey: this.store.settings.googleBooksApiKey,
      })),
    };

    this.hooks = {
      openAddModal: () => this.openAddModal(),
      openDetailModal: (title) => this.openTitle(title),
      openTrailer: (title) => {
        openTrailer(this.app, title, this.store.settings.trailerMode);
      },
      requestTitle: (title) => {
        void runRequestFlow(this.app, title, this.integrations.requests);
      },
      refreshPlexIndex: () => this.integrations.refreshPlexIndex(),
      refreshAiring: () => this.integrations.refreshAiring(),
      buildCard: (parent, title, ctx) => {
        // The artwork cache is handed down rather than reached for, the same way
        // the poster loader is. Spread, never rebuilt: `ctx` carries a lane's own
        // `CardExtras` callbacks that this file has never heard of, and a literal
        // would drop every one of them.
        const cache = this.imageCache;
        buildTitleCard(parent, title, cache ? { ...ctx, posterCache: cache } : ctx);
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
    deps.onOpenTitle = (title) => this.openTitle(title);
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
    // Suggestions are only offered where they can actually be answered.
    if (this.integrations?.overseerr.configured()) {
      deps.onSuggest = async () => {
        const outcome = await this.integrations.suggestFromLibrary({ limit: 8 });
        return {
          // Each row carries its own actions, because the book panel below
          // produces the same shape from an entirely different provider.
          suggestions: outcome.suggestions.map((s) => ({
            key: String(s.result.tmdbId),
            title: s.result.title,
            year: s.result.year,
            posterUrl: s.result.posterUrl,
            reasons: s.reasons,
            add: async () => (await deps.onAddSuggestion?.(s.result)) !== undefined,
            dismiss: () => this.integrations.dismissSuggestion(s.result.tmdbId),
          })),
          note:
            outcome.note ||
            (outcome.seeds && outcome.seeds.length > 0
              ? `Based on ${outcome.seeds.slice(0, 2).join(" and ")}${outcome.seeds.length > 2 ? " and more" : ""}.`
              : ""),
        };
      };
      deps.onOpenSuggestWizard = (fromLibrary) => this.openSuggestWizard(fromLibrary);
      deps.onAddSuggestion = async (result) => {
        const existing = findExisting(this.store, result);
        if (existing) return existing;
        const details = await this.integrations.overseerr.details(result.tmdbId, result.mediaType);
        const title = buildTitleForHit(
          details,
          this.store.settings,
          this.store.allTitles().map((t) => t.id),
        );
        const added = this.store.addTitle(title);
        void this.integrations.refreshTitlePlex(added);
        return added;
      };
      deps.onDismissSuggestion = (tmdbId) => this.integrations.dismissSuggestion(tmdbId);
    }

    // The same panel for the shelf, from Open Library rather than TMDB. Offered
    // independently of the film one: a vault with books and no Overseerr should
    // still get book suggestions.
    const openLibrary = this.clients.openLibrary;
    const readingStore = this.reading;
    if (openLibrary && readingStore) {
      const recommendDeps = {
        openLibrary,
        owned: () => [...this.store.reading.books, ...this.store.reading.manga],
        dismissed: () => this.dismissedBooks(),
      };
      deps.onSuggestBooks = async () => {
        const outcome = await suggestFromShelf(recommendDeps, { limit: 6 });
        return {
          suggestions: outcome.suggestions.map((s) => ({
            key: s.hit.id,
            title: s.hit.title,
            year: s.hit.firstPublishYear ?? null,
            posterUrl: s.hit.coverUrl,
            reasons: s.reasons,
            add: async () => {
              const book = createBook({
                id: readingStore.nextId("book", s.hit.title),
                title: s.hit.title,
                author: s.hit.authors[0] ?? "",
                coverUrl: s.hit.coverUrl,
                totalPages: s.hit.pageCount ?? 0,
              });
              this.store.reading.books.push(book);
              this.store.save("book-suggestion-added");
              this.store.emitChanged({ reason: "book-suggestion-added" });
              return true;
            },
            dismiss: () => this.dismissBook(s.hit.id),
          })),
          note:
            outcome.note ||
            (outcome.seeds.length > 0 ? `Based on ${outcome.seeds.slice(0, 2).join(" and ")}.` : ""),
        };
      };
    }
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

  // -------------------------------------------------------------------------
  // Local artwork cache (services/imagecache.ts)
  // -------------------------------------------------------------------------

  /**
   * Build the cache. Always constructed, enabled only if the user asked.
   *
   * The adapter is Obsidian's vault adapter, never Node `fs` — `isDesktopOnly`
   * is false and this has to work on a phone. `normalizeCacheFolder` is applied
   * here as well as in the settings tab, because the value on disk may have been
   * typed into `data.json` by hand.
   */
  private setupImageCache(): void {
    this.imageCache = createImageCache({
      adapter: this.app.vault.adapter,
      enabled: this.store.settings.cacheImagesLocally,
      folder: normalizeCacheFolder(this.store.settings.imageCacheFolder),
      source: "tmdb",
    });
  }

  /**
   * Move the cache out of `WatchLog/images`, once, if it is still there.
   *
   * The first default shipped under the old brand; `migrate.ts` repoints the
   * *setting* at `WRL/images`, and this moves the *files* so the two change
   * together — a repointed setting over an unmoved folder is a cache that went
   * silently cold and re-downloads everything.
   *
   * Copy, verify, then delete, one file at a time: a crash mid-move leaves
   * every image present in at least one of the two folders, and `prime()`
   * ignores the stragglers. Only runs when the setting is the NEW default and
   * the OLD default folder exists — a user who chose either path by hand is
   * left entirely alone.
   */
  /**
   * Offer to complete every half-judged title, then do exactly what was shown.
   *
   * The list in the dialog IS the change: each line is one title and the half
   * it gains. Nothing with both halves present is ever touched — disagreement
   * between two things the user typed is a judgement, not a defect — and
   * `autoStatus: false` because filling in an old review must not reshuffle a
   * status today.
   */
  private async reconcileJudgements(): Promise<void> {
    const plan = reconcileJudgements(this.store.allTitles(), this.store.settings.reviews);
    if (plan.length === 0) {
      new Notice("Every rated title has its review, and every review its rating.");
      return;
    }
    const result = await confirmAction(this.app, {
      title: "Complete half-entered ratings and reviews",
      message:
        `${plan.length} title(s) have one half of a judgement — a rating with no ` +
        "review, or a review with no rating — left over from the old sync bug. " +
        "Completing them writes the half the other one already implies:",
      details: plan.map((entry) => entry.describe),
      confirmText: `Complete ${plan.length} title(s)`,
    });
    if (!result.confirmed) return;
    for (const entry of plan) {
      this.store.updateTitle(entry.id, entry.patch, "judgement-reconciled", { autoStatus: false });
    }
    new Notice(`Completed ${plan.length} title(s).`);
  }

  private async relocateImageCache(): Promise<void> {
    const OLD = "WatchLog/images";
    const target = normalizeCacheFolder(this.store.settings.imageCacheFolder);
    if (target !== normalizeCacheFolder(DEFAULT_IMAGE_CACHE_FOLDER)) return;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(OLD))) return;
    try {
      const listing = await adapter.list(OLD);
      if (!(await adapter.exists(target))) await adapter.mkdir(target);
      let moved = 0;
      for (const path of listing.files) {
        const name = path.slice(path.lastIndexOf("/") + 1);
        // Staging leftovers are not cache entries; leave them for cleanup.
        if (name.startsWith(".") || name.endsWith(".writing.tmp")) continue;
        const dest = `${target}/${name}`;
        if (!(await adapter.exists(dest))) {
          await adapter.writeBinary(dest, await adapter.readBinary(path));
        }
        // Verified by existence at the destination; only then does the source go.
        if (await adapter.exists(dest)) {
          await adapter.remove(path);
          moved += 1;
        }
      }
      // The folder itself only goes when nothing is left in it.
      const after = await adapter.list(OLD);
      if (after.files.length === 0 && after.folders.length === 0) {
        await adapter.rmdir(OLD, false);
      }
      if (moved > 0) new Notice(`Artwork cache moved to ${target} (${moved} file(s)).`);
    } catch (err) {
      // A failed move is a cold cache, not a broken plugin: prime() simply
      // finds fewer files and the next warm re-downloads them.
      console.warn("[wrl] could not relocate the artwork cache:", err);
    }
  }

  /**
   * Re-read the settings into the cache and re-read the folder into its index.
   *
   * Called on load and whenever the toggle or the folder changes. Reads only —
   * nothing here downloads, and nothing here deletes.
   */
  async primeImageCache(): Promise<void> {
    const cache = this.imageCache;
    if (!cache) return;
    await this.relocateImageCache();
    cache.configure({
      enabled: this.store.settings.cacheImagesLocally,
      folder: normalizeCacheFolder(this.store.settings.imageCacheFolder),
    });
    try {
      await cache.prime();
    } catch (err) {
      // A cache that cannot read its folder is a cache that serves remote URLs,
      // which is the behaviour every user had before this feature existed.
      console.warn("[wrl] could not read the artwork cache folder:", err);
    }
  }

  /**
   * Everything in the library that references artwork — **titles and books**.
   *
   * One list, built in one place, because `warm()` and `findOrphans()` have to
   * be given the *same* answer. Warming with titles only leaves every book cover
   * on the network path; orphaning with titles only is worse, because then every
   * cached book cover looks unreferenced and is offered for deletion. The two
   * halves are a pair, and this is what makes them impossible to separate.
   *
   * The Open Library client goes in because `readingCacheEntries` attaches a
   * per-entry fetcher with it: cover bytes count against the same 3 req/s the
   * API does, so a warm pass over the shelves must go through the limiter rather
   * than around it with the cache's own transport.
   */
  private artworkCacheEntries(): { key: { scope: string; id: string }; url: string }[] {
    return [
      ...posterCacheEntries(this.store.allTitles()),
      ...readingCacheEntries(this.store.reading, this.clients.openLibrary ?? this.openLibrary()),
    ];
  }

  /**
   * Download every poster and cover that is not already on disk.
   *
   * User-triggered only, and it says how it went. `warm()` is bounded-concurrency
   * inside the service; a failure per image is counted, not thrown.
   */
  async cacheArtwork(): Promise<string> {
    const cache = this.imageCache;
    if (!cache || !this.store.settings.cacheImagesLocally) {
      return "Turn on “Keep local copies of artwork” in the plugin's settings first.";
    }
    await this.primeImageCache();
    const notice = new Notice("Downloading artwork…", 0);
    try {
      const result = await cache.warm(this.artworkCacheEntries());
      const tail = result.failed > 0 ? `, ${result.failed} failed` : "";
      return result.downloaded === 0 && result.failed === 0
        ? `Every poster and cover is already cached (${result.skipped} file(s)).`
        : `Downloaded ${result.downloaded} image(s)${tail}. ${result.skipped} already cached.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] artwork download failed", err);
      return `Could not download artwork — ${detail}`;
    } finally {
      notice.hide();
    }
  }

  /**
   * Files in the cache folder that nothing in the library references any more.
   *
   * Reporting only. Nothing in this plugin removes them on a timer, on load or
   * on a settings change — `purgeArtwork` is the one code path that deletes, and
   * it is only ever reached from a button the user pressed and confirmed.
   */
  async findOrphanArtwork(): Promise<string[]> {
    const cache = this.imageCache;
    if (!cache || !this.store.settings.cacheImagesLocally) return [];
    await this.primeImageCache();
    return cache.findOrphans(this.artworkCacheEntries());
  }

  /** Remove exactly these paths. The service refuses anything outside the folder. */
  async purgeArtwork(paths: readonly string[]): Promise<string> {
    const cache = this.imageCache;
    if (!cache || paths.length === 0) return "Nothing to remove.";
    const result = await cache.purge(paths);
    const tail = result.failed.length > 0 ? `, ${result.failed.length} could not be removed` : "";
    return `Removed ${result.removed.length} unreferenced image(s)${tail}.`;
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
      // Read per click, not per mount: flipping the setting takes effect on the
      // next card you open rather than the next time the tab is rebuilt.
      onOpenTitle: (title) => this.openTitle(title),
      onOpenNote: (title) => {
        void this.openNote(title);
      },
      onAddTitle: (afterAdd) => this.openAddModal(afterAdd),
      onSurprise: () => this.openSurpriseModal(),
      onRefreshMetadata: (title) => {
        void this.refreshMetadata(title);
      },
      onFindMatch: (title) => this.openMatchModal(title),
      ...this.suggestionHooks(),
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
        else if (this.store.settings.openLibraryAfterAdd) this.openTitle(result.title);
      },
    }).open();
  }

  /**
   * The suggestion hooks a detail view needs, or nothing when no provider is
   * configured — in which case the section is not drawn at all rather than
   * drawn empty.
   */
  suggestionHooks(): {
    onMoreLikeThis?: (title: TitleV4) => Promise<MoreLikeThis[]>;
    onAddSuggestion?: (result: OverseerrSearchResult) => Promise<TitleV4 | undefined>;
    onDismissSuggestion?: (tmdbId: number) => void;
  } {
    if (!this.integrations?.overseerr.configured()) return {};
    return {
      onMoreLikeThis: async (title) => this.integrations.moreLikeThis(title),
      onAddSuggestion: async (result) => {
        const existing = findExisting(this.store, result);
        if (existing) return existing;
        const details = await this.integrations.overseerr.details(result.tmdbId, result.mediaType);
        const built = buildTitleForHit(
          details,
          this.store.settings,
          this.store.allTitles().map((t) => t.id),
        );
        const added = this.store.addTitle(built);
        void this.integrations.refreshTitlePlex(added);
        return added;
      },
      onDismissSuggestion: (tmdbId) => this.integrations.dismissSuggestion(tmdbId),
    };
  }

  // -------------------------------------------------------------------------
  // The two Wave-3 leaves (SPEC §7 Wave 3)
  // -------------------------------------------------------------------------

  /**
   * The person service, built on first use.
   *
   * Lazy because `registerPersonView` runs before `store.load()` — the store
   * object exists from the first line of `onload`, but nothing here reads it
   * until a leaf opens, and the TMDB token is read per request rather than
   * captured, so typing one into Settings works on the next lookup.
   */
  private personService(): PersonService {
    if (!this.people) {
      this.people = createPersonService({
        store: this.store,
        client: createTmdbPersonClient(() => ({ token: this.store.settings.tmdbToken })),
      });
    }
    return this.people;
  }

  /**
   * Everything the person screen needs, and nothing about how it renders.
   *
   * `onAdd` deliberately routes through `suggestionHooks().onAddSuggestion` —
   * the *same* add path the suggestion wizard uses — rather than a second one
   * written here. The screen's own doc comment makes that a rule, and honouring
   * it is what stops "+ Add" from creating a title the rest of the plugin does
   * not recognise.
   */
  private personScreenDeps(): PersonScreenDeps {
    return {
      people: this.personService(),
      titles: () => this.store.allTitles(),
      onOpenTitle: (title) => this.openTitle(title),
      onAdd: async (result) => {
        const add = this.suggestionHooks().onAddSuggestion;
        if (!add) {
          new Notice("Add an Overseerr server in the plugin's settings first.");
          return undefined;
        }
        return add(result);
      },
      onJumpToQuery: (query) => this.openLibraryWithQuery(query),
      onOpenUrl: (url) => {
        window.open(url, "_blank");
      },
    };
  }

  // -------------------------------------------------------------------------
  // The reading side's two leaves: a book, and an author
  // -------------------------------------------------------------------------

  /**
   * The author cache-and-resolve service. Built on first ask, kept for the
   * plugin's life — the cache it owns lives in `data.json` under the preserved
   * `bookAuthors` key, and a leaf that opens and closes must not drop it.
   *
   * The store slice is an adapter rather than `this.store` itself: the service
   * asks for `books()`, which the plugin store spells `reading.books`. `data` is
   * a getter so the *live* object is handed over — the service writes its cache
   * into it, and a copy taken now would be written into and thrown away.
   */
  private authorService(): AuthorService {
    if (!this.authors) {
      const plugin = this;
      const store: AuthorStoreLike = {
        get data() {
          return plugin.store.data;
        },
        books: () => plugin.store.reading.books,
        save: (reason) => plugin.store.save(reason),
      };
      this.authors = createAuthorService({ store, client: this.openLibrary() });
    }
    return this.authors;
  }

  /**
   * Everything the author screen needs, and nothing about how it renders.
   *
   * `onAdd` routes through the *same* pieces the Add modal uses — `seedFromHit`,
   * `buildReadingEntry`, `store.addBook` — for the reason the person screen's
   * bundle gives: a second add path creates rows the rest of the plugin does not
   * recognise. The duplicate guard is the add modal's own.
   */
  private authorScreenDeps(): AuthorScreenDeps {
    const plugin = this;
    return {
      authors: this.authorService(),
      books: () => this.store.reading.books,
      onOpenBook: (book) => this.openBook(book),
      onAdd: (work) => this.addBookFromSearch(work),
      // The Reading tab, not the Library: `author:"…"` means nothing over there.
      onJumpToQuery: (query) => this.openLibraryWithQuery(query, "reading"),
      onOpenUrl: (url) => {
        window.open(url, "_blank");
      },
      covers: this.openLibrary(),
      /**
       * Read at paint time, not now: this bundle is built while `onload` is
       * still registering leaves, before `setupImageCache()` has run — and the
       * user can turn the cache on at any point afterwards without a reload.
       */
      get imageCache() {
        return plugin.imageCache ?? undefined;
      },
    };
  }

  /**
   * The book pane's bundle — built from `readingDeps()` rather than beside it,
   * so the pane and the modal are handed the same clients, the same cache, the
   * same note opener and the same suggestion callbacks. Two lists here would be
   * two behaviours for one screen.
   */
  private bookDetailDeps(): BookDetailDeps {
    const shared = this.readingDeps();
    const deps: BookDetailDeps = {
      app: this.app,
      store: this.store,
      // `setupReading()` has always run by the time a leaf mounts; the fallback
      // exists so a pane can never mount against nothing.
      reading: this.reading ?? createReadingStore(this.store),
      onJumpToQuery: (query) => this.openLibraryWithQuery(query, "reading"),
    };
    if (shared.openLibrary) deps.openLibrary = shared.openLibrary;
    if (shared.googleBooks) deps.googleBooks = shared.googleBooks;
    if (shared.imageCache) deps.imageCache = shared.imageCache;
    if (shared.onOpenNote) deps.onOpenNote = shared.onOpenNote;
    if (shared.onMoreLikeThis) deps.onMoreLikeThis = shared.onMoreLikeThis;
    if (shared.onAddSuggestion) deps.onAddSuggestion = shared.onAddSuggestion;
    if (shared.onDismissSuggestion) deps.onDismissSuggestion = shared.onDismissSuggestion;
    // Click opens the author, Alt-click still filters the shelf — the rule a
    // cast name follows (`ui/detail/people.ts`), applied to the other half of
    // the library. `renderAuthorLink` owns both bindings; this only supplies the
    // destination, and without it the chip degrades to the filter it always was.
    const openAuthor = authorOpener(this.app);
    if (openAuthor) deps.onOpenAuthor = openAuthor;
    return deps;
  }

  /**
   * Open a book — the entry point for every surface *outside* the Reading tab
   * (today: the author screen). The tab has its own, for the same reason the
   * Library has one next to `openTitle`: it must re-render itself afterwards.
   *
   * Both obey the one rule, and it is the rule a film obeys:
   * `openTitlesInFullView` chooses the frame. One preference the user already
   * has an opinion about, not a second one that says the same thing about books.
   */
  openBook(book: Book, kind: ReadingKind = "book"): void {
    if (this.store.settings.openTitlesInFullView) {
      void openBookDetail(this.app, { kind, id: book.id })
        .then((opened) => {
          // `false` means the leaf type was never registered — fall back rather
          // than leave the user looking at an empty pane.
          if (!opened) this.openBookModal(book.id, kind);
        })
        .catch((err: unknown) => {
          console.error("[wrl] could not open the book view", err);
          this.openBookModal(book.id, kind);
        });
      return;
    }
    this.openBookModal(book.id, kind);
  }

  /** The book modal, with the same callbacks the pane gets. */
  private openBookModal(id: string, kind: ReadingKind): void {
    const reading = this.reading;
    if (!reading) return;
    const deps = this.bookDetailDeps();
    const options: ConstructorParameters<typeof ReadingDetailModal>[1] = {
      store: reading,
      watch: this.store,
      kind,
      id,
      onJumpToQuery: (query) => this.openLibraryWithQuery(query, "reading"),
    };
    if (deps.openLibrary) options.openLibrary = deps.openLibrary;
    if (deps.googleBooks) options.googleBooks = deps.googleBooks;
    if (deps.imageCache) options.imageCache = deps.imageCache;
    if (deps.onOpenNote) options.onOpenNote = deps.onOpenNote;
    if (deps.onOpenAuthor) options.onOpenAuthor = deps.onOpenAuthor;
    if (deps.onMoreLikeThis) options.onMoreLikeThis = deps.onMoreLikeThis;
    if (deps.onAddSuggestion) options.onAddSuggestion = deps.onAddSuggestion;
    if (deps.onDismissSuggestion) options.onDismissSuggestion = deps.onDismissSuggestion;
    new ReadingDetailModal(this.app, options).open();
  }

  /**
   * `+ Add` on the author screen → a row on the Book shelf.
   *
   * Deliberately the add modal's own pieces rather than a second recipe:
   * `seedFromHit` decides what a provider hit becomes, `buildReadingEntry`
   * decides what a row is, and `findExistingReading` is the duplicate guard. A
   * book already on the shelf is returned as-is, never added twice.
   */
  private async addBookFromSearch(work: BookSearchResult): Promise<Book | undefined> {
    const reading = this.reading;
    if (!reading) return undefined;
    const existing = findExistingReading(this.store.reading, "book", work.title);
    if (existing) return existing as Book;
    const seed = seedFromHit(work, "book");
    const entry = buildReadingEntry(
      "book",
      reading.nextId("book", seed.title),
      seed,
      this.store.reading,
    ) as Book;
    reading.addBook(entry);
    return entry;
  }

  /** The author screen, unconditionally. Never throws out of a click handler. */
  async openAuthor(target: AuthorTarget): Promise<void> {
    try {
      await openAuthorView(this.app, target);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] could not open the author view", err);
      new Notice(`Could not open that author — ${detail}`, 8000);
    }
  }

  /**
   * Every author name the shelves know, deduped and sorted.
   *
   * `authorNamesOf` is what defines "every": a book's author field is as often a
   * list (`"Frank Herbert, Brian Herbert"`) as a name, and both halves of one
   * are a person you can open.
   */
  private authorNames(): string[] {
    const names = new Set<string>();
    for (const entry of [...this.store.reading.books, ...this.store.reading.manga]) {
      for (const name of authorNamesOf(entry)) {
        const trimmed = name.trim();
        if (trimmed !== "") names.add(trimmed);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /**
   * The full-view detail leaf's bundle — deliberately the same callbacks the
   * modal is handed in `openDetailModal`, because the two surfaces are the same
   * screen in a different frame and a second set of behaviours here is exactly
   * the defect the shared `ui/detail/` modules exist to prevent.
   */
  private titleDetailDeps(): TitleDetailDeps {
    const deps: TitleDetailDeps = {
      app: this.app,
      store: this.store,
      onJumpToQuery: (query) => this.openLibraryWithQuery(query),
      onOpenNote: (title) => {
        void this.openNote(title);
      },
      onOpenInPlex: (title) => {
        void this.integrations?.openInPlex(title);
      },
      onRefreshMetadata: (title) => {
        void this.refreshMetadata(title);
      },
      onRequest: (title) => {
        void runRequestFlow(this.app, title, this.integrations.requests);
      },
    };
    if (this.store.settings.trailerMode !== "off") {
      deps.onPlayTrailer = (title) => {
        openTrailer(this.app, title, this.store.settings.trailerMode);
      };
    }
    return deps;
  }

  /**
   * Open a title — the one entry point every surface calls.
   *
   * Which frame it lands in is `settings.openTitlesInFullView`, and it is a
   * setting rather than a hard switch because the modal is what every existing
   * user's hands already know. The command palette can always force the leaf,
   * so the new surface is reachable without changing the default.
   */
  openTitle(title: TitleV4): void {
    if (this.store.settings.openTitlesInFullView) {
      void this.openTitleInLeaf(title);
      return;
    }
    this.openDetailModal(title);
  }

  /** The full view, unconditionally. Falls back to the modal if the leaf fails. */
  async openTitleInLeaf(title: TitleV4): Promise<void> {
    try {
      await openTitleDetail(this.app, title.id);
    } catch (err) {
      console.error("[wrl] could not open the title view", err);
      this.openDetailModal(title);
    }
  }

  /** The person screen, unconditionally. Never throws out of a click handler. */
  async openPerson(target: PersonTarget): Promise<void> {
    try {
      await openPersonView(this.app, target);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] could not open the person view", err);
      new Notice(`Could not open that person — ${detail}`, 8000);
    }
  }

  /**
   * Every cast and director name the library knows, deduped and sorted.
   *
   * `creditNamesOf` is what defines "every" — API values *and* the user's own
   * `manualCast`/`manualDirector` additions — so a person somebody typed in by
   * hand is as openable as one TMDB supplied.
   */
  private creditNames(): string[] {
    const names = new Set<string>();
    for (const title of this.store.allTitles()) {
      for (const name of creditNamesOf(title)) {
        const trimmed = name.trim();
        if (trimmed !== "") names.add(trimmed);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
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
      ...this.suggestionHooks(),
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
      id: "repair-seasons",
      name: "Rebuild season structure from upstream",
      callback: () => {
        void this.runRefresh(
          () => this.integrations.repairSeasons(),
          "Checking season structures…",
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

    // The library-wide sweep (`services/sweep.ts`). It also runs on its TTL from
    // `catchUp`; this is the "do it now, all of it" door, so it forces past the
    // TTL *and* past the off switch — an explicit command is the user asking.
    // The service's own re-entry guard and `integration.ts`'s `busy` set mean
    // pressing it twice cannot start two passes.
    this.addCommand({
      id: "sweep-metadata",
      name: "Refresh metadata for the whole library",
      callback: () => {
        void this.integrations
          .sweepMetadata({ force: true })
          .then((message) => new Notice(message, 8000));
      },
    });

    this.addCommand({
      id: "stop-metadata-sweep",
      name: "Stop the metadata refresh",
      callback: () => {
        this.integrations.cancelMetadataSweep();
        new Notice("The metadata refresh will stop after the title it is on.");
      },
    });

    // Completes half-judged titles — five stars with no review, a review over
    // zero stars — left behind by the 1.19–1.22 sync bugs. A command rather
    // than a migration on purpose: a review is the user's opinion, and even a
    // derived one is shown for a yes before it is stored. `reconcileJudgements`
    // reads the same two mapping functions the live binding uses, so this
    // writes exactly what the sync would have written at the time.
    this.addCommand({
      id: "reconcile-judgements",
      name: "Complete half-entered ratings and reviews",
      callback: () => void this.reconcileJudgements(),
    });

    // --- the two Wave-3 leaves ---------------------------------------------
    //
    // Both surfaces are also reachable by clicking (a title through
    // `openTitle`, a person from the person screen's own links), but a feature
    // that only exists at the end of a click is a feature half the users never
    // find. These are the doors that always work.
    this.addCommand({
      id: "open-title-view",
      name: "Open a title in a full tab",
      callback: () => {
        const titles = [...this.store.allTitles()];
        if (titles.length === 0) {
          new Notice("Nothing tracked yet — add a title first.");
          return;
        }
        new TitleLeafModal(this, titles).open();
      },
    });

    this.addCommand({
      id: "open-person",
      name: "Open a person (actor or director)",
      callback: () => {
        const names = this.creditNames();
        if (names.length === 0) {
          new Notice(
            "No cast or directors recorded yet — refresh a title's metadata to fill this in.",
          );
          return;
        }
        new PersonSearchModal(this, names).open();
      },
    });

    this.addCommand({
      id: "open-author",
      name: "Open an author",
      callback: () => {
        const names = this.authorNames();
        if (names.length === 0) {
          new Notice("No authors recorded yet — add a book first.");
          return;
        }
        new AuthorSearchModal(this, names).open();
      },
    });

    // --- artwork cache ------------------------------------------------------
    this.addCommand({
      id: "cache-artwork",
      name: "Download missing artwork to the vault",
      callback: () => {
        void this.cacheArtwork().then((message) => new Notice(message, 8000));
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

    this.addCommand({
      id: "suggest-wizard",
      name: "Suggest something to watch (wizard)",
      callback: () => {
        this.openSuggestWizard(false);
      },
    });

    this.addCommand({
      id: "suggest-from-library",
      name: "Suggest something based on what I have watched",
      callback: () => {
        this.openSuggestWizard(true);
      },
    });

    this.addCommand({
      id: "suggest-books",
      name: "Suggest a book based on what I have read",
      callback: () => {
        void this.suggestBooks();
      },
    });

    this.addCommand({
      id: "fill-page-counts",
      name: "Fill in page counts from linked book files",
      callback: () => {
        void this.fillPageCounts();
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
  /**
   * Read page counts out of the linked PDFs for every book still missing one.
   *
   * The Reading tab does this on mount too; this is the same sweep with a
   * handle on it, for when the tab is not the thing you are looking at — and
   * for saying out loud which files could not answer, rather than leaving a
   * silent dash.
   */
  /**
   * Open the suggestion wizard, or its library-driven shortcut.
   *
   * Everything network-shaped is handed in as a closure, so the modal never
   * learns what Overseerr is — the same seam every other modal here uses.
   */
  openSuggestWizard(fromLibrary: boolean): void {
    openSuggestWizard(
      this.app,
      {
        genreOptions: (mediaType) => this.integrations.genreOptions(mediaType),
        search: (query) => this.integrations.overseerr.search(query),
        suggest: (query) => this.integrations.suggestGuided(query),
        fromLibrary: () => this.integrations.suggestFromLibrary(),
        onAdd: async (result) => {
          const existing = findExisting(this.store, result);
          if (existing) return existing;
          const details = await this.integrations.overseerr.details(
            result.tmdbId,
            result.mediaType,
          );
          const title = buildTitleForHit(
            details,
            this.store.settings,
            this.store.allTitles().map((t) => t.id),
          );
          const added = this.store.addTitle(title);
          void this.integrations.refreshTitlePlex(added);
          return added;
        },
        onRequest: (result) => {
          const existing = findExisting(this.store, result);
          if (!existing) {
            new Notice("Add it to your library first, then request it.");
            return;
          }
          void runRequestFlow(this.app, existing, this.integrations.requests);
        },
        onDismiss: (tmdbId) => this.integrations.dismissSuggestion(tmdbId),
      },
      fromLibrary,
    );
  }

  /**
   * Shelf-wide book suggestions, reported as a notice.
   *
   * Deliberately not a modal: the per-book "More like this" is where the
   * browsing happens, and this is the "what next?" question, which has a short
   * answer. Open Library is asked one seed at a time — its allowance is small
   * and shared with cover fetching.
   */
  private async suggestBooks(): Promise<void> {
    const openLibrary = this.clients.openLibrary;
    if (!openLibrary) {
      new Notice("Open Library is not available.");
      return;
    }
    const notice = new Notice("Looking for something to read…", 0);
    try {
      const outcome = await suggestFromShelf(
        {
          openLibrary,
          owned: () => [...this.store.reading.books, ...this.store.reading.manga],
          dismissed: () => this.dismissedBooks(),
        },
        { limit: 5 },
      );
      if (outcome.suggestions.length === 0) {
        new Notice(outcome.note || "Nothing to suggest yet.", 8000);
        return;
      }
      const lines = outcome.suggestions.map((s) => {
        const author = s.hit.authors[0] ? ` — ${s.hit.authors[0]}` : "";
        return `• ${s.hit.title}${author}`;
      });
      new Notice(
        `Based on ${outcome.seeds.slice(0, 2).join(" and ")}:\n${lines.join("\n")}`,
        15000,
      );
    } finally {
      notice.hide();
    }
  }

  private async fillPageCounts(): Promise<void> {
    const readingStore = this.reading;
    if (!readingStore) return;
    const due = this.store.reading.books.filter(
      (book) =>
        (book.progressUnit === "words" ? book.totalWords : book.totalPages) === 0 &&
        (book.filePath ?? "").toLowerCase().endsWith(".pdf"),
    );
    if (due.length === 0) {
      new Notice("Every book with a linked PDF already has a page count.");
      return;
    }
    const notice = new Notice(`Reading page counts from ${due.length} file(s)…`, 0);
    try {
      const result = await fillPageCountsFromFiles({
        adapter: this.app.vault.adapter,
        candidates: due.map((book) => ({
          id: book.id,
          title: book.title,
          filePath: book.filePath,
        })),
        apply: (id, pages) => {
          const book = this.store.reading.books.find((candidate) => candidate.id === id);
          if (book) {
            readingStore.updateBook(id, totalPatchFor(book, pages), "reading-pages-from-file");
          }
        },
      });
      const missed =
        result.unknown.length > 0 ? ` ${result.unknown.length} file(s) did not say.` : "";
      new Notice(`Filled ${result.filled} page count(s) from your files.${missed}`, 8000);
    } finally {
      notice.hide();
    }
  }

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

/**
 * "Open a title in a full tab" — the same picker, landing in the leaf.
 *
 * Separate from `TitleSearchModal` rather than a flag on it because the two
 * commands answer different questions: one is "find it", the other is "show me
 * this one, properly". This one ignores `openTitlesInFullView` — asking for the
 * full tab by name is an explicit instruction, not a preference.
 */
class TitleLeafModal extends FuzzySuggestModal<TitleV4> {
  constructor(
    private readonly plugin: WatchLogPlugin,
    private readonly titles: TitleV4[],
  ) {
    super(plugin.app);
    this.setPlaceholder("Open a title in its own tab…");
  }

  override getItems(): TitleV4[] {
    return this.titles;
  }

  override getItemText(title: TitleV4): string {
    return `${title.title} ${title.type} ${title.status} ${(title.genres ?? []).join(" ")}`;
  }

  override onChooseItem(title: TitleV4): void {
    void this.plugin.openTitleInLeaf(title);
  }
}

/**
 * "Open a person" — fuzzy over every cast and director name the library holds.
 *
 * Names rather than TMDB ids because names are what the titles store; the
 * person service resolves one to an id (and asks, when a name is ambiguous)
 * exactly as it does when the screen is opened any other way.
 */
class PersonSearchModal extends FuzzySuggestModal<string> {
  constructor(
    private readonly plugin: WatchLogPlugin,
    private readonly names: string[],
  ) {
    super(plugin.app);
    this.setPlaceholder("Open an actor or director…");
  }

  override getItems(): string[] {
    return this.names;
  }

  override getItemText(name: string): string {
    return name;
  }

  override onChooseItem(name: string): void {
    void this.plugin.openPerson({ name });
  }
}

/**
 * "Open an author" — the same door for the reading side.
 *
 * Names rather than Open Library keys, because a name is all a book stores; the
 * author service resolves one to a key (and asks, when two authors share a
 * name) exactly as it does when the screen is opened from a book.
 */
class AuthorSearchModal extends FuzzySuggestModal<string> {
  constructor(
    private readonly plugin: WatchLogPlugin,
    private readonly names: string[],
  ) {
    super(plugin.app);
    this.setPlaceholder("Open an author…");
  }

  override getItems(): string[] {
    return this.names;
  }

  override getItemText(name: string): string {
    return name;
  }

  override onChooseItem(name: string): void {
    void this.plugin.openAuthor({ name });
  }
}
