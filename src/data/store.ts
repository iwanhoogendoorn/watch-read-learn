/**
 * The persistence layer and the only writer of `data.json`.
 *
 * Discipline ported from foodspot (SPEC §3.2):
 *   - saves are **promise-chained**, so two writes can never interleave or lose
 *     each other's data;
 *   - the disk write is debounced by `SAVE_DEBOUNCE_MS`, the UI re-render is not;
 *   - exactly one `watchlog-data-changed` CustomEvent on `document` is the
 *     re-render bus for the view, the status bar and every embedded code block;
 *   - our own writes are echo-suppressed so the external-change watcher does not
 *     reload on them.
 *
 * The data object is the *same reference* migration returned, which is the same
 * reference `loadData()` produced. Keys v4 does not know about live on it and are
 * invisible to TypeScript. Mutate it; never rebuild it. See `types.ts` header.
 */
import { Notice, type Plugin } from "obsidian";
import {
  DATA_FILE,
  EXTERNAL_WATCH_INTERVAL_MS,
  MAX_HISTORY_ENTRIES,
  MAX_SAVE_RETRIES,
  SAVE_DEBOUNCE_MS,
  SAVE_RETRY_DELAY_MS,
  STATUS_COMPLETED,
  STATUS_WATCHING,
} from "../constants";
import {
  DATA_CHANGED_EVENT,
  type DataChangedDetail,
  type GamesData,
  type HistoryEntry,
  type ReadingData,
  type MigrationReport,
  type Settings,
  type TitleV4,
  type TitlePatch,
  type WatchLogData,
  type WatchLogStoreApi,
} from "../types";
import { migrate } from "./migrate";
import { createDefaultData, createGamesData, createReadingData } from "./schema";
import { airedEpisodesAmong, isAbsoluteEpisodeMarkable } from "./aired";
import {
  getEffectiveTotal,
  getWatchedCount,
  isEpisodeSkipped,
  rememberSeasonGeometry,
  sanitizeWatchedEpisodes,
  seasonEpisodes,
  toSeasonEpisode,
} from "./episodes";

// Episode maths is the store's public surface too; one import site for callers.
export * from "./episodes";

/** What the store needs to watch `data.json` without knowing what a vault is. */
export interface ExternalWatchOptions {
  /**
   * The file's current change stamp (its mtime), or `null` when it cannot be
   * read. Injected so this module never imports a `DataAdapter` and so tests
   * can drive it by hand.
   */
  stamp: () => Promise<number | null>;
  intervalMs?: number;
  /**
   * Called when an external change arrives on top of unsaved local edits.
   * `"mine"` keeps memory and writes over the external copy; `"theirs"`
   * discards the unsaved edits and reloads. Absent means `"theirs"`.
   */
  onConflict?: () => Promise<"mine" | "theirs">;
  /** An external change was adopted; the data-changed event has already fired. */
  onReloaded?: () => void;
  /** The external file could not be migrated, so writes are now blocked. */
  onUnreadable?: () => void;
}

/**
 * The bytes a payload would serialise to, for identity comparison.
 *
 * A hash would be smaller but a collision fails *open* — it would suppress a
 * real external change — so the whole string is kept. `data.json` is a single
 * small document by design; the cap is a backstop against a pathological one.
 */
const MAX_FINGERPRINT_BYTES = 4_000_000;

function serializeForCompare(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_FINGERPRINT_BYTES) return null;
    return text;
  } catch {
    return null;
  }
}

/** How long a post-write stamp read may take before it is given up on. */
const SELF_STAMP_READ_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeHistoryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * `S04E08` for a refusal message, falling back to the absolute number when the
 * episode belongs to no known season.
 *
 * `pills.episodeCode` says the same thing for the UI, and the store cannot
 * import it: `data/` never depends on `ui/`. One format string in two places is
 * a smaller price than a shared module that only exists to hold it.
 */
function episodeLabel(title: TitleV4, absoluteEpisode: number): string {
  const at = toSeasonEpisode(title, absoluteEpisode);
  if (!at) return `Episode ${absoluteEpisode}`;
  const season = at.season.seasonNumber ?? at.seasonIndex + 1;
  return `S${String(season).padStart(2, "0")}E${String(at.episode).padStart(2, "0")}`;
}

export class WatchLogStore implements WatchLogStoreApi {
  private plugin: Plugin;
  private _data: WatchLogData = createDefaultData();

  /** Serialises every write; `save()` appends to this chain, never forks it. */
  private writeChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReason = "";

  /**
   * True from the moment a change is queued until a write of it reaches disk.
   *
   * A failed write leaves this set, which is what makes the failure recoverable:
   * the next save rewrites the whole object anyway, and `flush()` can tell the
   * caller that the session's edits are still only in memory.
   */
  private dirty = false;
  /** The last write failure, cleared by the first write that succeeds. */
  private lastSaveError: Error | null = null;
  /** Consecutive failed writes, so the automatic retry cannot spin forever. */
  private failedWrites = 0;

  /**
   * Non-null when writing is deliberately suspended — a failed v3 backup or a
   * migration that could not recognise the file. Changes still accumulate in
   * memory and still mark the store dirty; nothing reaches disk until the user
   * resolves it (SPEC §3.1).
   */
  private writeBlock: string | null = null;

  /**
   * Echo suppression, by identity rather than by clock (SPEC §3.2).
   *
   * Time windows and write counters both fail open: a two-second window swallows
   * a genuine write from another device that lands one millisecond after ours,
   * and a counter mis-attributes a later external change when several of our own
   * writes collapse into one observed state. So we record what our writes
   * actually produced and suppress **only** an exact match:
   *
   *   - `selfStamps` — post-write file stamps we know we caused;
   *   - `pendingSelfWrites` — writes whose resulting stamp we could not read
   *     back (the adapter had not published it yet). The first observed change
   *     claims them **all**, because collapsed writes share one state;
   *   - `lastWrittenSerialized` — the exact bytes we last wrote, so a file whose
   *     contents are ours is never adopted as somebody else's change.
   */
  private selfStamps = new Set<number>();
  private pendingSelfWrites = 0;
  private lastWrittenSerialized: string | null = null;

  /** Last `data.json` stamp (mtime) the watcher observed; `null` before priming. */
  private lastKnownStamp: number | null = null;
  /** The live watcher's options, so a completed write can read its own stamp. */
  private watchOptions: ExternalWatchOptions | null = null;

  /** Populated by `load()`; the settings tab surfaces it once. */
  migrationReport: MigrationReport | null = null;

  /** Notified after every title mutation; the note writer's subscription. */
  private titleSink: ((titleIds: string[], reason: string) => void) | null = null;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  get data(): WatchLogData {
    return this._data;
  }

  get settings(): Settings {
    return this._data.settings;
  }

  /**
   * The parity domains (SPEC2-PARITY.md).
   *
   * Migration creates both, so these never invent anything in practice — but a
   * store built from a hand-made object in a test would otherwise hand out
   * `undefined`, and the whole point of the accessor is that callers never have
   * to ask. Created **in place** on the data object, so the key that appears is
   * the key that gets saved.
   */
  get reading(): ReadingData {
    return (this._data.reading ??= createReadingData());
  }

  get games(): GamesData {
    return (this._data.games ??= createGamesData());
  }

  // -------------------------------------------------------------------------
  // Load / save
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    let raw: unknown = await this.plugin.loadData();

    // `loadData()` answers null for BOTH "no file" and "file unreadable right
    // now" — and only one of those is a fresh install. A torn read happens in
    // the wild: a reload while the previous instance's flush is still writing
    // (Obsidian does not await async onunload) hands the new instance an empty
    // or half-written file. Treating that as fresh runs the v0→v4 migration,
    // whose auto-save then writes an empty library OVER the real one. So:
    // when loadData says nothing but data.json exists on disk with content,
    // this is NOT a fresh install — substitute defaults with `reset` set, and
    // onload's unrecognised-data gate keeps the plugin read-only until the
    // user decides. Losing a session to a read-only gate is recoverable;
    // losing the library to an eager save is not.
    if (raw == null) {
      // Optional chaining throughout: test harnesses hand this store minimal
      // plugin shells, and a missing manifest must read as "cannot check",
      // never as a crash before the first render.
      const dir = this.plugin.manifest?.dir;
      const adapter = this.plugin.app?.vault?.adapter;
      if (dir && adapter) {
        let text: string | null = null;
        try {
          if (await adapter.exists(`${dir}/${DATA_FILE}`)) {
            text = await adapter.read(`${dir}/${DATA_FILE}`);
          }
        } catch {
          // Unreadable counts as "exists with unknown content": gate.
          text = "?";
        }
        if (text !== null && text.trim() !== "" && text.trim() !== "{}") {
          try {
            raw = JSON.parse(text);
          } catch {
            const { data, report } = migrate(null);
            this._data = data;
            this.migrationReport = { ...report, reset: true };
            return;
          }
        }
      }
    }

    const { data, report } = migrate(raw);
    this._data = data;
    this.migrationReport = report;
  }

  /** Queue a debounced write. Returns immediately; the UI must not await it. */
  save(reason = "save"): void {
    this.pendingReason = reason;
    this.dirty = true;
    if (this.writeBlock !== null) return; // held in memory until writes resume
    this.scheduleWrite(SAVE_DEBOUNCE_MS);
  }

  private scheduleWrite(delayMs: number): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueueWrite();
    }, delayMs);
  }

  /**
   * Write now and await it. Called on unload and before destructive operations.
   *
   * **Rejects when the write did not reach disk.** A caller that ignores that is
   * telling the user their session was saved when it was not, which is exactly
   * how a disk-full or sync-locked `data.json` used to eat an evening's edits.
   * Returns without writing while writes are blocked — the user has already been
   * told why, and the changes stay in memory.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.writeBlock !== null) return;
    await this.enqueueWrite();
    if (this.lastSaveError) throw this.lastSaveError;
  }

  /**
   * The write itself. Never rejects — a rejected `writeChain` would take every
   * queued write down with it — but it records what happened, so `flush()` can
   * report and the next save can retry.
   */
  private enqueueWrite(): Promise<void> {
    const reason = this.pendingReason;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const serialized = serializeForCompare(this._data);
        await this.plugin.saveData(this._data);
        this.dirty = false;
        this.lastSaveError = null;
        this.failedWrites = 0;
        this.lastWrittenSerialized = serialized;
        await this.recordSelfWriteStamp();
      })
      .catch((err: unknown) => {
        // `dirty` deliberately stays true: the data is still only in memory.
        this.lastSaveError = err instanceof Error ? err : new Error(String(err));
        this.failedWrites += 1;
        console.error(`[wrl] save failed (${reason})`, err);
        if (this.failedWrites <= MAX_SAVE_RETRIES && this.writeBlock === null) {
          // A sync lock or a momentarily unavailable adapter usually clears;
          // retry a few times before leaving it to the next user edit.
          this.scheduleWrite(SAVE_RETRY_DELAY_MS);
        }
      });
    return this.writeChain;
  }

  /** True while this session holds changes that have not reached disk. */
  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /** The last write failure, or `null` when the last write succeeded. */
  get saveError(): Error | null {
    return this.lastSaveError;
  }

  /** Why writing is suspended, or `null` when the store may write. */
  get writesBlocked(): string | null {
    return this.writeBlock;
  }

  /**
   * Suspend every write. Used as a startup gate: no v3 backup, or a `data.json`
   * migration could not recognise, means v4 must not be the thing that
   * overwrites it.
   */
  blockWrites(reason: string): void {
    this.writeBlock = reason;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    console.warn(`[wrl] writes are blocked: ${reason}`);
  }

  /** Resume writing, flushing anything that piled up while it was blocked. */
  allowWrites(): void {
    if (this.writeBlock === null) return;
    this.writeBlock = null;
    this.failedWrites = 0;
    if (this.dirty) this.scheduleWrite(0);
  }

  // -------------------------------------------------------------------------
  // External changes (SPEC §3.2)
  // -------------------------------------------------------------------------

  /**
   * Learn the stamp our just-completed write produced.
   *
   * When the adapter has already published it we get an exact value to match
   * against later — the only kind of suppression that cannot swallow somebody
   * else's write. When it has not (the read still shows the old stamp, or there
   * is no watcher yet), the write is recorded as *pending* instead: we know one
   * of the next observed states is ours, but not which value it will be.
   */
  private async recordSelfWriteStamp(): Promise<void> {
    const watch = this.watchOptions;
    if (!watch) {
      this.pendingSelfWrites += 1;
      return;
    }
    // Bounded: this runs inside the write chain, so an adapter whose `stat`
    // never settles would otherwise stall every later save and hang unload.
    // Giving up just means the write is recorded as pending instead of exact.
    let stamp: number | null = null;
    try {
      stamp = await withTimeout(watch.stamp(), SELF_STAMP_READ_TIMEOUT_MS);
    } catch {
      stamp = null;
    }
    if (stamp === null || stamp === this.lastKnownStamp) {
      this.pendingSelfWrites += 1;
      return;
    }
    this.selfStamps.add(stamp);
  }

  /** Forget every self-write marker — after adopting somebody else's file. */
  private clearSelfWriteMarkers(): void {
    this.selfStamps.clear();
    this.pendingSelfWrites = 0;
    this.lastWrittenSerialized = null;
  }

  /**
   * Re-read `data.json` and adopt it, unless it is unreadable.
   *
   * A file that migration has to *reset* is never adopted: replacing live data
   * with defaults because the disk copy got mangled is the same data loss as
   * writing defaults over it. `false` means "kept what we had".
   */
  async reloadFromDisk(): Promise<boolean> {
    return this.adoptRaw(await this.plugin.loadData());
  }

  /** Adopt an already-read `data.json` payload. `false` = kept what we had. */
  private adoptRaw(raw: unknown): boolean {
    const { data, report } = migrate(raw);
    this.migrationReport = report;
    if (report.reset) return false;
    this._data = data;
    this.dirty = false;
    this.clearSelfWriteMarkers();
    return true;
  }

  /**
   * Watch `data.json` for changes this instance did not make (SPEC §3.2).
   *
   * Obsidian Sync, a second device or a text editor can all rewrite the file
   * under us. Without this, memory stays stale and the next rating or Plex cache
   * write rewrites the whole monolithic file over the external change.
   *
   * The rules that make it safe:
   *   - a change is ours only when its stamp **exactly** matches one we recorded
   *     for a completed write, or when it claims the pending self-writes whose
   *     stamp we could not read back. Nothing is attributed to us because it
   *     happened recently, and any *other* value is external immediately;
   *   - claiming clears **every** pending marker, because several of our writes
   *     can collapse into one observed state and a leftover marker would eat the
   *     next genuine external change;
   *   - a queued debounced write is **cancelled**, because it was composed
   *     against data that no longer exists;
   *   - with unsaved local changes it **asks** (`onConflict`) rather than
   *     silently picking a winner.
   *
   * @returns a stop function; the caller registers it for unload.
   */
  startExternalWatch(options: ExternalWatchOptions): () => void {
    const intervalMs = options.intervalMs ?? EXTERNAL_WATCH_INTERVAL_MS;
    this.watchOptions = options;
    let stopped = false;
    let running = false;

    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      try {
        const stamp = await options.stamp();
        if (stamp === null) return;
        if (this.lastKnownStamp === null) {
          this.lastKnownStamp = stamp; // priming read; nothing to compare yet
          return;
        }
        if (stamp === this.lastKnownStamp) return;
        // Any different value is a change — including a *lower* one, which is
        // what restoring an older copy over the file looks like.
        this.lastKnownStamp = stamp;

        if (this.selfStamps.delete(stamp)) return; // exactly one of ours
        if (this.pendingSelfWrites > 0) {
          // A pending marker says *one of the next states* is ours — not that
          // this one is. Another device can produce the first visible change
          // while our own stamp is still unpublished, so the contents decide:
          // an exact match clears every pending marker (collapsed writes share
          // one state), anything else is external and goes down the normal path
          // with the payload we just read.
          const raw: unknown = await this.plugin.loadData();
          if (this.matchesLastWrite(raw)) {
            this.pendingSelfWrites = 0;
            return;
          }
          this.pendingSelfWrites = 0; // the marker was stale; this state is not ours
          await this.handleExternalChange(options, raw);
          return;
        }
        await this.handleExternalChange(options);
      } catch (err) {
        console.warn("[wrl] external-change watch failed", err);
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), intervalMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
      if (this.watchOptions === options) this.watchOptions = null;
    };
  }

  /** Is this payload character for character what we last wrote? */
  private matchesLastWrite(raw: unknown): boolean {
    if (this.lastWrittenSerialized === null) return false;
    return serializeForCompare(raw) === this.lastWrittenSerialized;
  }

  /**
   * @param preloaded the file's payload when the caller has already read it —
   *   passed through so one observed change costs exactly one read.
   */
  private async handleExternalChange(
    options: ExternalWatchOptions,
    preloaded?: unknown,
  ): Promise<void> {
    // Whatever was queued was built on data that is now stale on disk.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.dirty) {
      const choice = options.onConflict ? await options.onConflict() : "theirs";
      if (choice === "mine") {
        // The user chose their session; write it over the external copy.
        this.scheduleWrite(0);
        return;
      }
    }

    const raw: unknown = preloaded !== undefined ? preloaded : await this.plugin.loadData();

    // Last identity check, on the bytes themselves: a file that is character for
    // character what we last wrote is our own write surfacing late (a sync
    // round-trip, a stamp we never got to read), not somebody else's edit.
    // Cheaper to skip the repaint than to correctly reload identical data.
    if (this.matchesLastWrite(raw)) {
      this.pendingSelfWrites = 0;
      return;
    }

    const adopted = this.adoptRaw(raw);
    if (!adopted) {
      this.blockWrites(
        "data.json changed on disk into something the plugin could not read, so it is not writing.",
      );
      options.onUnreadable?.();
      return;
    }
    // One event for the whole reload — the same bus every surface repaints on.
    this.emitChanged({ reason: "external-change" });
    options.onReloaded?.();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  emitChanged(detail: DataChangedDetail): void {
    // `activeDocument` covers pop-out windows; fall back for non-DOM contexts.
    const doc = typeof activeDocument !== "undefined" ? activeDocument : document;
    doc.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail }));
  }

  private commit(reason: string, titleIds?: string[]): void {
    this.save(reason);
    this.emitChanged(titleIds ? { reason, titleIds } : { reason });
    if (titleIds && this.titleSink) {
      // The markdown-note mirror. Deliberately after the save and the event:
      // `data.json` is the record, notes are downstream of it, and a vault that
      // refuses a write must not cost the user the edit itself.
      try {
        this.titleSink(titleIds, reason);
      } catch (err) {
        console.error("[wrl] note sync failed", err);
      }
    }
  }

  /**
   * Subscribe to title mutations, for the markdown-note mirror (SPEC D7).
   *
   * A direct sink rather than the DOM event, because notes must be written even
   * when the change came from a pop-out window whose `activeDocument` is not the
   * one the plugin listens on.
   */
  onTitlesChanged(sink: (titleIds: string[], reason: string) => void): void {
    this.titleSink = sink;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getTitle(id: string): TitleV4 | undefined {
    return this._data.titles.find((t) => t.id === id);
  }

  getTitleByName(name: string): TitleV4 | undefined {
    const needle = name.trim().toLowerCase();
    return this._data.titles.find((t) => t.title.trim().toLowerCase() === needle);
  }

  allTitles(): readonly TitleV4[] {
    return this._data.titles;
  }

  distinct(field: "type" | "status" | "priority" | "genres" | "tags"): string[] {
    const out = new Set<string>();
    for (const title of this._data.titles) {
      if (field === "genres") for (const g of title.genres ?? []) out.add(g);
      else if (field === "tags") for (const t of title.tags) out.add(t);
      else out.add(title[field]);
    }
    out.delete("");
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  addTitle(title: TitleV4): TitleV4 {
    this._data.titles.push(title);
    this.logActivity({
      message: `${title.title} (${title.type}) was added`,
      source: "Watchlist",
      action: "added",
      titleName: title.title,
      titleId: title.id,
    });
    this.commit("title-added", [title.id]);
    return title;
  }

  updateTitle(
    id: string,
    patch: TitlePatch,
    reason = "title-updated",
    options: { autoStatus?: boolean; preserveAbsoluteEpisodes?: boolean } = {},
  ): TitleV4 | undefined {
    const title = this.getTitle(id);
    if (!title) return undefined;
    // What was already ticked, before the patch lands. Only episodes the patch
    // *adds* are put to the air-date guard: one that is somehow already stored
    // stays stored, so an unrelated write can never quietly delete watch history
    // and un-marking keeps working.
    const alreadyWatched = patch.watchedEpisodes ? new Set(title.watchedEpisodes) : null;
    Object.assign(title, patch);
    title.dateModified = new Date().toISOString();
    if (patch.watchedEpisodes || patch.seasons || patch.totalEpisodes !== undefined) {
      // `preserveAbsoluteEpisodes` is for a *repair*, where the old season list
      // was wrong rather than smaller. The rebase below reads each watched
      // number as season-relative and re-anchors it in the season of the same
      // number — correct when a season grew, catastrophic when one fake
      // 32-episode "Season 1" becomes four real ones, because everything past
      // the new season 1's length is dropped as "removed". Adopting the new
      // geometry first makes the rebase a no-op, so absolute numbers stand.
      if (options.preserveAbsoluteEpisodes) rememberSeasonGeometry(title);
      // A season edit changes what an absolute episode number *means*, so the
      // stored numbers are translated through the geometry change before they
      // are re-sanitised, and the new seasons become the basis for the next one.
      title.watchedEpisodes = sanitizeWatchedEpisodes(title);
      rememberSeasonGeometry(title);
      // The third writer of `watchedEpisodes`, and the one every bulk path uses:
      // the detail surfaces' `markEpisodesPatch`, CSV and tracker import, and
      // the type-repair in `services/match`. Guarding only the two `mark*`
      // methods would leave a wide-open door, so the same rule is applied to the
      // episodes this patch introduces. (After the rebase, deliberately: a
      // season edit changes which episode an absolute number *means*, so the
      // question is only worth asking of the numbers as they finally stand.)
      if (alreadyWatched) {
        const kept = title.watchedEpisodes.filter(
          (ep) => alreadyWatched.has(ep) || isAbsoluteEpisodeMarkable(title, ep),
        );
        const refused = title.watchedEpisodes.length - kept.length;
        if (refused > 0) {
          title.watchedEpisodes = kept;
          new Notice(
            `${title.title} — ${refused} episode${refused === 1 ? " has" : "s have"} not aired yet and ${refused === 1 ? "was" : "were"} not marked.`,
          );
        }
      }
      // The denominator moved with the geometry, so "is it finished?" has to be
      // asked again: resizing the last season can complete a title, and adding
      // one can un-complete it.
      //
      // `autoStatus: false` is for writes the *user did not make*: a season
      // synced in from upstream must not silently flip a Watched show to
      // Watching and wipe its finish date behind their back (QA3). The card
      // shows a "New season" chip instead and the decision stays theirs.
      if (options.autoStatus !== false) this.applyAutoCompleteRules(title);
    }
    this.commit(reason, [id]);
    return title;
  }

  /**
   * Write one of the derived caches (`plex`, `airing`, `request`).
   *
   * Two things it deliberately does not do, both of which `updateTitle` does:
   *
   *   - **it does not bump `dateModified`.** A background poll is not the user
   *     editing anything, and letting it touch that field would make the
   *     "Last updated" sort reshuffle itself every five minutes;
   *   - **it can stay silent.** A 200-title Plex sweep that emitted per title
   *     would repaint every open tab 200 times, so bulk callers pass
   *     `silent: true` and emit once when they are done.
   */
  updateCaches(
    id: string,
    patch: Pick<TitlePatch, "plex" | "airing" | "request" | "tmdbMatch">,
    options: { silent?: boolean; reason?: string } = {},
  ): TitleV4 | undefined {
    const title = this.getTitle(id);
    if (!title) return undefined;
    Object.assign(title, patch);
    const reason = options.reason ?? "caches-updated";
    this.save(reason);
    if (!options.silent) this.emitChanged({ reason, titleIds: [id] });
    return title;
  }

  deleteTitle(id: string): boolean {
    const index = this._data.titles.findIndex((t) => t.id === id);
    if (index < 0) return false;
    const [removed] = this._data.titles.splice(index, 1);
    for (const group of this._data.groups) {
      group.titleIds = group.titleIds.filter((t) => t !== id);
    }
    if (removed) {
      this.logActivity({
        message: `${removed.title} was deleted`,
        source: "Watchlist",
        action: "deleted",
        titleName: removed.title,
        titleId: id,
      });
    }
    this.commit("title-deleted", [id]);
    return true;
  }

  /**
   * Toggle one absolute episode.
   *
   * Skipped episodes are a no-op — they are excluded from the denominator, so
   * letting them be ticked is what made v3's progress exceed 100%.
   *
   * Episodes that have not aired are refused **here**, not in the grid that
   * draws them. The grid's dimmed cells only ever protected the grid; the card's
   * quick "mark next episode" action, the command palette, the
   * `obsidian://watchlog` URI handler and the code-block widgets all call this
   * method directly, and every one of them could tick next month's episode.
   * Un-marking is never refused: a user undoing a mistake must not be trapped by
   * the guard, and an already-ticked future episode has to stay removable.
   */
  markEpisodeWatched(id: string, absoluteEpisode: number, watched: boolean): void {
    const title = this.getTitle(id);
    if (!title) return;
    if (absoluteEpisode < 1 || absoluteEpisode > title.totalEpisodes) return;
    if (isEpisodeSkipped(title, absoluteEpisode)) return;
    if (watched && !isAbsoluteEpisodeMarkable(title, absoluteEpisode)) {
      // Silence would read as a broken button, so say which episode and why.
      new Notice(`${title.title} — ${episodeLabel(title, absoluteEpisode)} has not aired yet.`);
      return;
    }

    const set = new Set(title.watchedEpisodes);
    if (watched) set.add(absoluteEpisode);
    else set.delete(absoluteEpisode);
    title.watchedEpisodes = [...set].sort((a, b) => a - b);
    title.watchedEpisodes = sanitizeWatchedEpisodes(title);
    title.dateModified = new Date().toISOString();

    if (watched) {
      this.logActivity({
        message: `${title.title} — episode ${absoluteEpisode} marked as watched`,
        source: "Watchlist",
        action: "watched",
        titleName: title.title,
        titleId: id,
      });
    }
    this.applyAutoCompleteRules(title);
    this.commit("episode-toggled", [id]);
  }

  /**
   * Tick or untick a whole season.
   *
   * Marking is capped at what has actually **aired**: a season three episodes
   * into an eight-episode run would otherwise be recorded as fully watched, and
   * the progress maths, the time statistics and the auto-complete rule would all
   * believe it. Unticking is never capped — see `markEpisodeWatched`.
   */
  markSeasonWatched(id: string, seasonIndex: number, watched: boolean): void {
    const title = this.getTitle(id);
    if (!title) return;
    const all = seasonEpisodes(title, seasonIndex);
    if (all.length === 0) return;
    const episodes = watched ? airedEpisodesAmong(title, all) : all;
    const seasonName = title.seasons[seasonIndex]?.name ?? `Season ${seasonIndex + 1}`;
    if (episodes.length === 0) {
      new Notice(`${title.title} — nothing in ${seasonName} has aired yet.`);
      return;
    }
    if (episodes.length < all.length) {
      new Notice(
        `${title.title} — marked the ${episodes.length} aired episode${episodes.length === 1 ? "" : "s"} of ${seasonName}; the rest have not aired yet.`,
      );
    }

    const set = new Set(title.watchedEpisodes);
    for (const ep of episodes) {
      if (watched) set.add(ep);
      else set.delete(ep);
    }
    title.watchedEpisodes = [...set].sort((a, b) => a - b);
    title.watchedEpisodes = sanitizeWatchedEpisodes(title);
    title.dateModified = new Date().toISOString();

    const season = title.seasons[seasonIndex];
    if (watched && season) {
      this.logActivity({
        message:
          episodes.length < all.length
            ? `${title.title} — ${season.name}, the ${episodes.length} episodes that have aired, marked as watched`
            : `${title.title} — ${season.name} marked as watched`,
        source: "Watchlist",
        action: "season",
        titleName: title.title,
        titleId: id,
      });
    }
    this.applyAutoCompleteRules(title);
    this.commit("season-toggled", [id]);
  }

  /**
   * v3's auto-complete, both directions: finishing the last episode marks the
   * title Watched, un-ticking one on a watched title puts it back to Watching.
   */
  private applyAutoCompleteRules(title: TitleV4): void {
    if (!this.settings.autoCompleteOnLastEpisode) return;
    const total = getEffectiveTotal(title);
    if (total <= 0) return;
    const watched = getWatchedCount(title);

    if (watched >= total) {
      if (title.status === STATUS_COMPLETED) return;
      title.status = STATUS_COMPLETED;
      title.priority = "";
      if (this.settings.setFinishDateAutomatically && !title.dateFinished) {
        title.dateFinished = todayIso();
      }
      this.logActivity({
        message: `${title.title} was watched`,
        source: "Watchlist",
        action: "completed",
        titleName: title.title,
        titleId: title.id,
      });
      return;
    }

    if (title.status === STATUS_COMPLETED) {
      title.status = STATUS_WATCHING;
      title.dateFinished = null;
    }
  }

  // -------------------------------------------------------------------------
  // Activity log
  // -------------------------------------------------------------------------

  logActivity(entry: Omit<HistoryEntry, "id" | "timestamp">): void {
    this._data.history.push({
      ...entry,
      id: makeHistoryId(),
      timestamp: new Date().toISOString(),
    });
    if (this._data.history.length > MAX_HISTORY_ENTRIES) {
      this._data.history.splice(0, this._data.history.length - MAX_HISTORY_ENTRIES);
    }
  }

  clearActivity(): void {
    this._data.history.length = 0;
    this.commit("activity-cleared");
  }
}
