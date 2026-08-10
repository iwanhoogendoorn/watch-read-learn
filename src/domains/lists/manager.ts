/**
 * Vault I/O for custom lists.
 *
 * The whole file is the thin shell around `format.ts`: find the files, read
 * them, write them, rename them, bin them. Every decision that can be made
 * without a vault has already been made one module over.
 *
 * Four behaviours, two carried from v3 and two the core store earned the hard
 * way in the first review cycle:
 *
 *   - **saves are serialized per list.** Two edits landing in the same tick must
 *     not race each other into `vault.modify`; each list gets its own promise
 *     chain, so the second write always sees the first one's file.
 *   - **a corrupt list is never written.** If the JSON block failed to parse we
 *     have no idea what the file held, and overwriting it with our empty
 *     interpretation would destroy it. The list is marked and refused instead.
 *   - **a failed write is loud and stays dirty** (W8 review P0-1). The queue must
 *     survive a rejection so later edits still run, but the *caller's* promise
 *     must still reject: swallowing it makes an edit look saved, and the next
 *     reload silently reverts it. Same rule as `data/store.ts` — a hidden failure
 *     is worse than a slow one.
 *   - **a save never replaces a file it has not read** (W8 review P0-2). The
 *     bytes each list was loaded from are remembered; if the file on disk no
 *     longer matches, somebody else (sync, another device, the user in a pane)
 *     changed it, and overwriting it wholesale would delete their rows. The
 *     write is refused and the conflict reported instead.
 */
import { Notice, TFile, normalizePath, type App } from "obsidian";
import type { CustomList } from "../../types";
import {
  mergeCustomLists,
  notesOf,
  parseCustomList,
  replaceNotesSection,
  serializeCustomList,
  setNotes,
} from "./format";

export const DEFAULT_LISTS_FOLDER = "Watch Read Learn/CustomLists";

/**
 * How many times the file is sampled while a write is in flight.
 *
 * Enough to catch a writer that lands inside the window, few enough that a slow
 * vault is not hammered. The post-write read is the backstop either way.
 */
const WRITE_SAMPLES = 5;

/**
 * How many times a write may be re-attempted against a moving file.
 *
 * Bounded on purpose. A vault being written continuously by another device is a
 * situation to *report*, not to spin on — and three retries is already far more
 * contention than a human editing a list can produce.
 */
const MAX_WRITE_ATTEMPTS = 3;

/**
 * A list whose edit could not be landed, with both versions kept.
 *
 * `externalText` is what is on disk (and on every other device); `localText` is
 * what the user made. Neither is thrown away — that is the whole point of the
 * record.
 */
export interface ListConflictRecord {
  name: string;
  externalText: string;
  localText: string;
  at: string;
}

/** What a write attempt intends to leave on disk. */
interface BuildResult {
  text: string;
  /** Fields where both sides changed the same key; named in the Notice. */
  conflicts: string[];
  /** Runs only once the bytes are confirmed on disk. */
  adopt?: () => void;
}

/**
 * Samples taken on the microtask queue before falling back to real ticks.
 *
 * An adapter that resolves `modify` within the same tick — a stub, a memory
 * vault, a very fast disk — never yields to a timer, so a racing write in that
 * tick is only visible here.
 */
const WRITE_MICRO_SAMPLES = 3;

/**
 * The file changed underneath us.
 *
 * Carries the current contents so the caller can offer the choice rather than
 * picking for the user — theirs, ours, or open the file and look.
 */
/**
 * A write that could not be landed cleanly within the attempt budget.
 *
 * Nothing is discarded: the file on disk keeps the other party's version — it is
 * what every other device will sync — and `localText` carries the user's, so the
 * tab can offer it back rather than pretending the edit never happened.
 */
export class ListWriteConflictError extends Error {
  override readonly name = "ListWriteConflictError";
  constructor(
    readonly listName: string,
    readonly externalText: string,
    readonly localText = "",
  ) {
    super(
      `“${listName}” is being changed elsewhere faster than the plugin can save it. The version on disk was kept and your edit is parked.`,
    );
  }
}

export class ListConflictError extends Error {
  override readonly name = "ListConflictError";
  constructor(
    readonly listName: string,
    readonly currentText: string,
  ) {
    super(
      `“${listName}” changed on disk since the plugin last read it, so the edit was not written over it.`,
    );
  }
}

export class CustomListManager {
  private readonly app: App;
  private readonly folderOf: () => string;
  /** Lists whose file we could not understand; writing to them is blocked. */
  private readonly corrupt = new Set<string>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  /**
   * The exact text each list was last read from or written as.
   *
   * This is the conflict check, and it is deliberately the whole string rather
   * than a hash: a hash collision would fail *open* — silently overwriting
   * somebody's edit — and a list file is small.
   */
  private readonly seenText = new Map<string, string>();
  /** Lists with an edit that never reached disk, and the error that stopped it. */
  private readonly failed = new Map<string, Error>();
  /** Set while a save is writing. A *status* flag, never the echo classifier. */
  private readonly writing = new Set<string>();
  /**
   * The exact bytes an in-flight write intends to leave on disk.
   *
   * This is the store's `lastWrittenSerialized` pattern, and it is here for the
   * same reason: "was this change mine?" can only be answered by *content*. The
   * previous version answered it with "am I writing right now", which classifies
   * somebody else's write as an echo purely because it landed during our window
   * — and then overwrote it (re-check P0-2).
   */
  private readonly pendingBytes = new Map<string, string>();
  /**
   * Content seen on disk during a write that was neither the pre-write state nor
   * our own intended bytes: somebody wrote while we were writing.
   */
  private readonly racedText = new Map<string, string>();
  /** The bytes the current attempt tried to write, kept for the conflict record. */
  private readonly lastIntended = new Map<string, string>();
  /** Lists whose edit could not be landed; both versions preserved. */
  private readonly conflicted = new Map<string, ListConflictRecord>();

  constructor(app: App, folderOf: () => string) {
    this.app = app;
    this.folderOf = folderOf;
  }

  /**
   * Lists in a conflict state, with both versions.
   *
   * The tab reads this to mark the sub-tab and offer the parked edit back.
   */
  conflicts(): ListConflictRecord[] {
    return [...this.conflicted.values()];
  }

  conflictFor(name: string): ListConflictRecord | undefined {
    return this.conflicted.get(name);
  }

  /** The user resolved it (kept theirs, or re-applied ours). */
  clearConflict(name: string): void {
    this.conflicted.delete(name);
    this.seenText.delete(name);
  }

  /** Lists whose last write failed — teardown reports these rather than losing them. */
  pendingFailures(): { name: string; error: Error }[] {
    return [...this.failed.entries()].map(([name, error]) => ({ name, error }));
  }

  /**
   * Wait for every queued write, then report an outstanding failure.
   *
   * The tab and the plugin call this on teardown: an edit that never landed is
   * the user's data, and they deserve to be told before the pane closes.
   */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.saveQueues.values()]);
    const outstanding = this.pendingFailures();
    if (outstanding.length === 0) return;
    const names = outstanding.map((entry) => `“${entry.name}”`).join(", ");
    new Notice(
      `Watch, Read and Learn could not save ${names}. The file on disk is unchanged; your edit is still in the open tab.`,
      10000,
    );
    throw outstanding[0]?.error ?? new Error("a custom list could not be saved");
  }

  /** Forget a list's fingerprint — the watcher calls this when the file moves. */
  forget(name: string): void {
    this.seenText.delete(name);
    this.corrupt.delete(name);
  }

  /** True while this manager is mid-write for `name`. Status only. */
  isWriting(name: string): boolean {
    return this.writing.has(name);
  }

  /**
   * Is this exactly what we are writing (or just wrote)?
   *
   * The only honest echo test. A watcher event carrying these bytes is our own
   * change coming back; anything else is somebody else's, whatever the timing.
   */
  isSelfWrite(name: string, text: string): boolean {
    return this.pendingBytes.get(name) === text || this.seenText.get(name) === text;
  }

  /**
   * Record content a watcher observed while a write was in flight.
   *
   * The tab calls this instead of discarding the event. `saveList` reconciles
   * against it once the write settles — a pre-write read cannot close that
   * window, because the adapter has no compare-and-swap.
   */
  noteExternalContent(name: string, text: string): void {
    if (this.isSelfWrite(name, text)) return;
    this.racedText.set(name, text);
  }

  get folderPath(): string {
    return normalizePath(this.folderOf() || DEFAULT_LISTS_FOLDER);
  }

  private pathFor(name: string): string {
    return normalizePath(`${this.folderPath}/${name}.md`);
  }

  isCorrupt(name: string): boolean {
    return this.corrupt.has(name);
  }

  /** Markdown files directly inside the lists folder, by basename, A→Z. */
  listNames(): string[] {
    const folder = this.folderPath;
    return this.app.vault
      .getFiles()
      .filter((file) => (file.parent?.path ?? "") === folder && file.extension === "md")
      .map((file) => file.basename)
      .sort((a, b) => a.localeCompare(b));
  }

  async ensureFolder(): Promise<void> {
    const folder = this.folderPath;
    if (this.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch {
      // Already there, or the vault refused — `create` below reports either way.
    }
  }

  async loadList(name: string): Promise<CustomList | null> {
    const file = this.app.vault.getAbstractFileByPath(this.pathFor(name));
    if (!(file instanceof TFile)) return null;
    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch (error) {
      console.warn("[wrl] could not read custom list", name, error);
      return null;
    }
    // Remember the bytes: a later save compares against them before replacing.
    this.seenText.set(name, text);
    const result = parseCustomList(name, text);
    if (!result.ok) {
      // Loud, once, and then the file is left strictly alone.
      if (!this.corrupt.has(name)) {
        new Notice(`Custom list “${name}” has unreadable data and was left untouched.`);
      }
      this.corrupt.add(name);
      return null;
    }
    this.corrupt.delete(name);
    return result.list;
  }

  /** Tab colours without keeping every list in memory. */
  async loadColors(names: readonly string[]): Promise<Map<string, string>> {
    const colors = new Map<string, string>();
    await Promise.all(
      names.map(async (name) => {
        const list = await this.loadList(name);
        if (list?.color) colors.set(name, list.color);
      }),
    );
    return colors;
  }

  /**
   * Run `task` behind this list's write chain.
   *
   * Two promises on purpose. The **chain** absorbs the rejection so one failed
   * write cannot poison every later edit of that list; the **returned** promise
   * carries it, so the caller learns what happened. Collapsing them into one is
   * exactly the bug P0-1 describes.
   */
  private queue(name: string, task: () => Promise<void>): Promise<void> {
    const previous = this.saveQueues.get(name) ?? Promise.resolve();
    const run = previous.then(task);
    this.saveQueues.set(
      name,
      run.catch(() => undefined),
    );
    return run.then(
      () => {
        this.failed.delete(name);
      },
      (error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        console.error("[wrl] custom-list save failed:", name, wrapped);
        this.failed.set(name, wrapped);
        new Notice(
          `Could not save the list “${name}” — ${wrapped.message}. Your edit is still on screen; it will be retried on your next change.`,
          8000,
        );
        throw wrapped;
      },
    );
  }

  /**
   * The ONE code path that writes a list file.
   *
   * Everything before this fixed a level and left the level above it exposed:
   * the pre-write check missed a writer that landed during `vault.modify`,
   * and the corrective write that fixed *that* was itself unprotected — a second
   * racing write clobbered it in turn. Each fix was a patch on the previous
   * patch's blind spot, which is the shape of a problem that needs a structure
   * rather than another special case.
   *
   * So: a bounded write-reconcile loop built on `Vault.process`, and no other
   * way to write a list.
   *
   * WHAT THIS CLOSES, AND WHAT IT CANNOT
   * ------------------------------------
   * `Vault.process` is Obsidian's atomic read-modify-write: the callback runs
   * inside the vault's per-file operation queue, so the content it is handed is
   * the content being replaced. That closes **every ordering that goes through
   * the vault layer** — this plugin, other plugins, the editor, and Obsidian
   * Sync, which applies remote changes through the vault like everything else.
   * A separate read and modify cannot close it at any level of retrying,
   * because the gap between "what I merged from" and "what I am replacing" is
   * where the loss happens, and checking around a gap does not remove it.
   *
   * What no plugin can close: a process outside Obsidian writing the file
   * directly — a `git checkout`, a Dropbox daemon, `vim` in another window. That
   * is last-writer-wins at the OS level and there is no primitive available here
   * that would arbitrate it. It self-heals rather than corrupting: the vault
   * raises a `modify` event for the foreign write, the tab's watcher reports the
   * content, and the next save merges it back in through this same loop.
   *
   *     attempt = 0
   *     loop:
   *       intended = serialize(merge(baseline, local, latestExternal))
   *       write(intended); after = read()
   *       if after == intended and nothing external arrived → baseline = intended, done
   *       else                                              → latestExternal = after, attempt++
   *       if attempt > MAX → park the local version, leave theirs on disk, report
   *
   * Two rules make it sound:
   *
   *   - **the baseline only advances on a clean write.** Advancing it after a
   *     losing attempt would turn the rows we just merged in into "present in
   *     the baseline, absent remotely" — a deletion — and drop them on the next
   *     iteration.
   *   - **external content is only ever recognised by fingerprint.** Timing
   *     classifies somebody else's write as our echo; content cannot. An
   *     observation that matches what we intended to write is ours, and anything
   *     else feeds the next iteration, whenever it arrived.
   */
  private async writeLoop(
    name: string,
    build: (currentText: string | null, clobbered: string | undefined, attempt: number) => BuildResult,
  ): Promise<void> {
    if (this.corrupt.has(name)) {
      throw new Error(`“${name}” could not be read earlier, so the plugin will not overwrite it`);
    }
    await this.ensureFolder();
    const path = this.pathFor(name);

    for (let attempt = 0; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      const file = existing instanceof TFile ? existing : null;

      // Content that was on disk and is not any more — a version we overwrote,
      // reported by a watcher or caught by a sample. `process` hands us what the
      // file holds *now*, which by definition no longer contains it, so it has
      // to be merged in separately or it is lost for good.
      const clobbered = this.racedText.get(name);
      this.racedText.delete(name);

      let intended: string;
      let built: BuildResult;

      if (file) {
        // THE atomic step. `Vault.process` runs the callback inside Obsidian's
        // per-file operation queue with the file's current contents and writes
        // what it returns — read, merge and write in one indivisible operation.
        //
        // This is what closes the window the previous three attempts could not:
        // with a separate read and modify there is *always* a gap between the
        // content the merge was computed from and the content being replaced,
        // and no amount of checking around that gap removes it. The callback is
        // synchronous for the same reason — nothing may await inside it, or the
        // atomicity is gone.
        let captured: BuildResult | null = null;
        const before = this.seenText.get(name) ?? null;
        this.writing.add(name);
        try {
          const run = this.app.vault.process(file, (current) => {
            captured = build(current, clobbered, attempt);
            // Published from inside the callback: until it runs there is no
            // "intended" content, and the watcher's echo test needs the exact
            // bytes rather than a guess.
            this.pendingBytes.set(name, captured.text);
            this.lastIntended.set(name, captured.text);
            return captured.text;
          });
          // Sampling stays, as defence in depth. Under `process` it should find
          // nothing — the merge and the write are one operation — and in the
          // worst case a stale sample only adds a candidate for the next
          // iteration, which re-merges and converges. It still earns its place
          // against an adapter that turns out not to be atomic.
          await this.watchWhileWriting(name, file, () => captured?.text ?? null, before, run);
        } finally {
          this.writing.delete(name);
          this.pendingBytes.delete(name);
        }
        if (captured === null) {
          throw new Error(`“${name}” could not be prepared for writing`);
        }
        built = captured as BuildResult;
        intended = built.text;
      } else {
        // No file yet: `create` is already atomic in the only sense that
        // matters — it fails if something else got there first.
        built = build(null, clobbered, attempt);
        intended = built.text;
        this.lastIntended.set(name, intended);
        this.writing.add(name);
        this.pendingBytes.set(name, intended);
        try {
          await this.app.vault.create(path, intended);
        } finally {
          this.writing.delete(name);
          this.pendingBytes.delete(name);
        }
      }

      // Defence in depth. `process` has already made the merge atomic, so this
      // should not fire — but a write that landed *after* it (a sync applying a
      // remote change a moment later) is still worth catching here rather than
      // on the next user edit.
      const target = this.app.vault.getAbstractFileByPath(path);
      let after: string | null = null;
      if (target instanceof TFile) {
        try {
          after = await this.app.vault.read(target);
        } catch {
          after = null;
        }
      }
      const raced = this.racedText.get(name);

      const clean = (after === null || after === intended) && raced === undefined;
      if (clean) {
        this.racedText.delete(name);
        this.lastIntended.delete(name);
        this.conflicted.delete(name);
        this.seenText.set(name, intended);
        built.adopt?.();
        if (built.conflicts.length > 0 || attempt > 0) {
          this.reportMerge(name, built.conflicts, attempt > 0);
        }
        return;
      }

      // Something arrived after our write. It becomes the next attempt's input;
      // `process` will read it again anyway, so this only decides whether to go
      // round once more.
      this.racedText.set(name, raced ?? (after as string));
    }

    // Out of attempts. Neither version is discarded: theirs stays on disk (it is
    // what every other device will sync) and ours is parked here, so the tab can
    // show a conflict marker and hand the edit back instead of the user
    // discovering days later that an afternoon's changes never landed.
    const latest = this.racedText.get(name) ?? "";
    this.racedText.delete(name);
    const parked = this.lastIntended.get(name) ?? "";
    this.lastIntended.delete(name);
    this.conflicted.set(name, {
      name,
      externalText: latest,
      localText: parked,
      at: new Date().toISOString(),
    });
    throw new ListWriteConflictError(name, latest, parked);
  }

  /** One place decides what a merge tells the user. */
  private reportMerge(name: string, conflicts: readonly string[], retried: boolean): void {
    const where = retried
      ? `“${name}” was changed elsewhere while the plugin was saving it`
      : `“${name}” had changed on disk`;
    if (conflicts.length === 0) {
      new Notice(`${where}, so both sets of edits were merged.`, 8000);
      return;
    }
    // Naming the fields matters: a silent pick is how somebody discovers the
    // loss a week later, with nothing left to compare against.
    new Notice(
      `${where}. Both sets of edits were merged, and the other device's version won for: ${conflicts.join(", ")}.`,
      12000,
    );
  }

  /**
   * Watch the file while a write is in flight.
   *
   * A writer that lands inside the window and is then overwritten by us leaves
   * no trace on disk — the post-write read sees our own bytes. The watcher's
   * event is one way to learn about it; sampling is the other, for a vault that
   * offers no event in time. Both funnel into the same `racedText` slot, and
   * both are filtered by fingerprint rather than by timing.
   *
   * Microtasks first: an adapter that resolves within the same tick never yields
   * to a timer, so a same-tick race is only visible there. Then real ticks,
   * which is what a write on a synced vault actually spans.
   */
  private async watchWhileWriting(
    name: string,
    file: TFile | null,
    intendedOf: () => string | null,
    before: string | null,
    write: Promise<unknown>,
  ): Promise<void> {
    let settled = false;
    const done = write.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    const sample = async (): Promise<void> => {
      if (!file) return;
      try {
        const seen = await this.app.vault.read(file);
        const intended = intendedOf();
        if (seen !== intended && seen !== before) this.racedText.set(name, seen);
      } catch {
        // A read that fails mid-write tells us nothing; the post-write read is
        // the one that has to succeed.
      }
    };

    const sampling = (async (): Promise<void> => {
      for (let i = 0; i < WRITE_MICRO_SAMPLES && !settled; i += 1) {
        await Promise.resolve();
        if (settled) break;
        await sample();
      }
      for (let i = 0; i < WRITE_SAMPLES && !settled; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (settled) break;
        await sample();
      }
    })();

    try {
      await done;
    } finally {
      await sampling;
    }
  }

  /**
   * Save a list.
   *
   * The merge lives in the builder, so every iteration of the loop re-merges
   * against whatever the latest external content turned out to be — including
   * the content that raced the *previous* iteration's write.
   */
  async saveList(list: CustomList): Promise<void> {
    await this.queue(list.name, async () => {
      const baseline = this.seenText.get(list.name);
      // `mine` accumulates across attempts: each merge result becomes the local
      // side of the next one, so rows merged in during attempt 1 are still ours
      // in attempt 2 rather than being re-derived from a stale object.
      let mine = list;

      await this.writeLoop(list.name, (current, clobbered) => {
        const conflicts: string[] = [];
        const base = baseline === undefined ? null : parseCustomList(list.name, baseline);
        const baseList = base && base.ok ? base.list : null;
        let toWrite = mine;

        // Both are "theirs" against the same baseline, folded in one after the
        // other with the local side accumulating: what is on the file now, and
        // any version we are known to have overwritten.
        for (const other of [current, clobbered]) {
          if (other === undefined || other === null || other === "" || other === baseline) continue;
          const theirs = parseCustomList(list.name, other);
          if (!theirs.ok) throw new ListConflictError(list.name, other);
          const merged = mergeCustomLists(baseList, toWrite, theirs.list);
          toWrite = merged.list;
          conflicts.push(...merged.conflicts);
        }

        mine = toWrite;
        toWrite.dateModified = new Date().toISOString();
        return {
          text: serializeCustomList(toWrite),
          conflicts,
          // Only once the bytes are confirmed on disk: the caller holds `list`
          // and an open tab renders it, so it must never show a merge that lost.
          adopt: () => {
            list.rows = toWrite.rows;
            list.columns = toWrite.columns;
            setNotes(list, notesOf(toWrite));
            list.dateModified = toWrite.dateModified;
          },
        };
      });
    });
  }

  /**
   * Write the prose without touching the data block.
   *
   * Same loop, different builder: the notes are spliced into whatever the file
   * currently holds, so a data-block change that arrives mid-write survives —
   * it is in `current` on the next attempt. Falls back to a full serialize when
   * the file has no `## Notes` section, which is what a list created outside the
   * plugin looks like.
   */
  async saveNotes(list: CustomList, notes: string): Promise<void> {
    setNotes(list, notes);
    await this.queue(list.name, async () => {
      await this.writeLoop(list.name, (current) => {
        if (current === null) {
          return { text: serializeCustomList(list), conflicts: [] };
        }
        // Spliced into whatever `process` just handed us, so a data-block change
        // that landed a moment ago is preserved rather than serialized over.
        const spliced = replaceNotesSection(current, notes);
        return { text: spliced ?? serializeCustomList(list), conflicts: [] };
      });
    });
  }

  async createList(name: string): Promise<CustomList | null> {
    await this.ensureFolder();
    const path = this.pathFor(name);
    if (this.app.vault.getAbstractFileByPath(path)) return null;
    const now = new Date().toISOString();
    const list: CustomList = {
      id: name,
      name,
      columns: [],
      rows: [],
      dateAdded: now,
      dateModified: now,
    };
    setNotes(list, "");
    try {
      // Through the loop like every other write, even though a brand-new file
      // has nothing to race: "there is exactly one code path that writes list
      // files" only stays true if it has no exceptions, and the next person
      // adding a write should find no second example to copy.
      await this.writeLoop(name, () => ({
        text: serializeCustomList(list),
        conflicts: [],
      }));
    } catch (error) {
      console.error("[wrl] could not create custom list", name, error);
      return null;
    }
    return list;
  }

  /** Trash, not delete: the file goes wherever the vault's deleted files go. */
  async deleteList(name: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.pathFor(name));
    if (!(file instanceof TFile)) return;
    try {
      await this.app.fileManager.trashFile(file);
    } catch (error) {
      console.error("[wrl] could not delete custom list", name, error);
    }
  }

  /** Renaming a list renames its file. Returns false when the name is taken. */
  async renameList(from: string, to: string): Promise<boolean> {
    if (from === to) return true;
    const target = this.pathFor(to);
    if (this.app.vault.getAbstractFileByPath(target)) return false;
    const file = this.app.vault.getAbstractFileByPath(this.pathFor(from));
    if (!(file instanceof TFile)) return false;
    try {
      await this.app.vault.rename(file, target);
    } catch (error) {
      console.error("[wrl] could not rename custom list", from, error);
      return false;
    }
    this.corrupt.delete(from);
    const text = this.seenText.get(from);
    this.seenText.delete(from);
    if (text !== undefined) this.seenText.set(to, text);
    this.failed.delete(from);
    return true;
  }
}
