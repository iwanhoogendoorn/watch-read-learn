/**
 * The book *file* — when the epub/pdf itself lives in the vault, a tracked
 * book can link straight to it and "open the book" means the book, not a note
 * about it.
 *
 * Three pieces:
 *
 *   - pure candidate logic (which vault files count as books, ranked against a
 *     title) — exported for tests;
 *   - a fuzzy picker over those candidates, best matches first;
 *   - the opener. PDFs open in Obsidian's own viewer; every other format is
 *     handed to the system reader via `openWithDefaultApp`, because an epub in
 *     a pane Obsidian cannot render is a blank rectangle, and the honest
 *     answer is the app that can. Obsidian's own File menu ships the same
 *     fallback, so the API is unofficial but load-bearing platform-wide; it is
 *     feature-detected all the same.
 */
import { FuzzySuggestModal, Notice, TFile, type App } from "obsidian";

/** Formats a vault plausibly stores a readable book in. */
export const BOOK_FILE_EXTENSIONS: readonly string[] = [
  "pdf",
  "epub",
  "mobi",
  "azw3",
  "cbz",
  "cbr",
  "djvu",
];

export function isBookFilePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return BOOK_FILE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** Lowercase words, no punctuation — the vocabulary both sides are compared in. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 1);
}

/**
 * How strongly a file name resembles a book title: the fraction of title
 * words the file name contains, minus a whisper per extra word the file name
 * carries beyond the title. The penalty is what puts `Dune.epub` above
 * `Dune Messiah.epub` for the title "Dune" — both cover it fully, but one
 * says more than was asked. The extension is stripped before tokenizing so
 * `epub` never counts as an extra word.
 */
export function bookFileScore(path: string, title: string): number {
  const wanted = tokens(title);
  if (wanted.length === 0) return 0;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const have = new Set(tokens(dot < 0 ? base : base.slice(0, dot)));
  const hits = wanted.filter((t) => have.has(t)).length;
  const extras = [...have].filter((t) => !wanted.includes(t)).length;
  return hits / wanted.length - extras * 0.01;
}

/**
 * Book-shaped vault paths, best title matches first, ties alphabetical so the
 * order is stable. Everything stays in the list — a rename the scorer cannot
 * see through must still be pickable.
 */
export function rankBookFiles(paths: readonly string[], title: string): string[] {
  return paths
    .filter(isBookFilePath)
    .map((path) => ({ path, score: bookFileScore(path, title) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

/**
 * Open the linked file. PDFs render in a normal Obsidian tab — at the
 * remembered page when there is one, via the `#page=N` subpath that both the
 * native viewer and PDF++ honour. Anything else goes to the system's reader.
 */
export function openBookFile(app: App, filePath: string, page?: number): void {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) {
    new Notice(`Not in the vault any more: ${filePath}`);
    return;
  }
  if (file.extension.toLowerCase() === "pdf") {
    if (typeof page === "number" && page > 1) {
      void app.workspace.openLinkText(`${file.path}#page=${Math.floor(page)}`, "", true);
    } else {
      void app.workspace.getLeaf("tab").openFile(file);
    }
    return;
  }
  const opener = (app as unknown as { openWithDefaultApp?: (path: string) => Promise<void> })
    .openWithDefaultApp;
  if (typeof opener === "function") {
    void opener.call(app, file.path);
  } else {
    new Notice("This format needs an external reader — open it from your file manager.");
  }
}

// ---------------------------------------------------------------------------
// The reading bookmark
//
// While a linked PDF is open, remember which page the user is on, so the next
// open lands exactly there. There is no event for "the user turned a page" —
// the viewer keeps its page in the leaf's view state and scrolling emits
// nothing — so a light poll reads the active leaf's state every few seconds.
// A tick where nothing changed writes nothing.
// ---------------------------------------------------------------------------

/**
 * Every open PDF viewer's file + current page — all panes, focused or not, so
 * a book read in a split still bookmarks while the cursor lives elsewhere.
 */
export interface PdfOpenState {
  path: string;
  page: number;
  /** Total pages, when the viewer exposes it. Undefined is "unknown", never 0. */
  pageCount?: number;
}

export function openPdfPages(app: App): PdfOpenState[] {
  const out: PdfOpenState[] = [];
  for (const leaf of app.workspace.getLeavesOfType("pdf")) {
    const view = leaf.view as
      | {
          file?: { path?: string };
          getState?: () => unknown;
          viewer?: { child?: { pdfViewer?: { pagesCount?: unknown } } };
        }
      | undefined;
    const path = view?.file?.path;
    const state = view?.getState?.() as { page?: unknown } | undefined;
    const page = state?.page;
    if (typeof path !== "string" || typeof page !== "number" || !(page >= 1)) continue;
    // The page count lives on the embedded pdf.js viewer, not the leaf state.
    // Unofficial structure (view.viewer.child.pdfViewer), so feature-detected;
    // absent just means "progress cannot adopt a total from this viewer".
    const count = view?.viewer?.child?.pdfViewer?.pagesCount;
    const entry: PdfOpenState = { path, page: Math.floor(page) };
    if (typeof count === "number" && count >= 1) entry.pageCount = Math.floor(count);
    out.push(entry);
  }
  return out;
}

/**
 * Record `page` on whichever entry links `path`. Returns true when something
 * changed and a save is due.
 *
 * Deliberately NOT `store.update()`: that bumps `dateModified` and rewrites
 * the mirrored note, and a bookmark that churns the vault on every page turn
 * is worse than no bookmark. The field is mutated in place (the data
 * contract's sanctioned move) and the caller saves `data.json` alone.
 */
/** The slice of a Book the progress planner reads. Structural, for tests. */
export interface TrackedBook {
  id: string;
  filePath?: string;
  pagesRead: number;
  totalPages: number;
  progressUnit: string;
}

export interface PdfProgressAction {
  id: string;
  /** New furthest page read — feed to `progressPatch`, never assign raw. */
  read: number;
  /** Fill `totalPages` from the PDF; only ever offered when it was 0. */
  adoptTotal?: number;
}

/**
 * What the Progress column should learn from the PDFs currently open.
 *
 * The rules that keep it honest:
 *
 *   - **Current page, in both directions.** Progress answers "where am I in
 *     this book", so turning back sets it back. An earlier version kept a
 *     high-water mark so that checking a diagram could not cost you progress,
 *     but that makes the number unfixable by the obvious means: going back to
 *     where you actually are and finding it ignored.
 *   - **A book with no page total adopts the PDF's** (once, while it is 0) —
 *     that is what turns "—" into a real bar for a book added by hand.
 *   - **Disagreeing totals disable auto-progress.** If the user typed a print
 *     total and the PDF has a different count, page 87 of the PDF is NOT page
 *     87 of the book, and writing it would corrupt a counter they own. The
 *     bookmark still works; the bar stays theirs.
 *   - **Throttled, symmetrically.** A flush happens when the page has moved
 *     `stride` in *either* direction since the last one, or on reaching the
 *     final page (so Completed lands the moment it is true). `flushedAt`
 *     (path → last flushed page) is the caller's bookkeeping between ticks.
 *   - Books measured in words are left alone entirely.
 */
export function pdfProgressActions(
  books: readonly TrackedBook[],
  open: readonly PdfOpenState[],
  flushedAt: Map<string, number>,
  stride = 3,
): PdfProgressAction[] {
  const actions: PdfProgressAction[] = [];
  for (const { path, page, pageCount } of open) {
    for (const book of books) {
      if ((book.filePath ?? "").trim() !== path) continue;
      if (book.progressUnit === "words") continue;

      const adopting = book.totalPages === 0 && pageCount !== undefined;
      const total = book.totalPages > 0 ? book.totalPages : (pageCount ?? 0);
      if (total <= 0) continue;
      if (book.totalPages > 0 && pageCount !== undefined && pageCount !== book.totalPages) continue;

      const current = Math.max(0, Math.min(page, total));
      const baseline = flushedAt.get(path) ?? book.pagesRead;
      const moved = Math.abs(current - baseline);
      const finished = current >= total;
      // Adoption always emits (the bar needs its denominator now, not in
      // `stride` pages); otherwise a write needs a stride's worth of movement
      // — forwards or back — or the finish line.
      if (!adopting && !(moved > 0 && (moved >= stride || finished))) continue;

      const action: PdfProgressAction = { id: book.id, read: current };
      if (adopting && pageCount !== undefined) action.adoptTotal = pageCount;
      actions.push(action);
      flushedAt.set(path, current);
    }
  }
  return actions;
}

export function recordBookPage(
  reading: { books: { filePath?: string; filePage?: number }[]; manga: { filePath?: string; filePage?: number }[] },
  path: string,
  page: number,
): boolean {
  let changed = false;
  for (const entry of [...reading.books, ...reading.manga]) {
    if ((entry.filePath ?? "").trim() !== path) continue;
    if (entry.filePage !== page) {
      entry.filePage = page;
      changed = true;
    }
  }
  return changed;
}

/**
 * Where an imported book file lands: the reading notes folder when one is
 * configured, the vault root otherwise. Never invents its own folder — the
 * user told the plugin where reading things live, or they did not.
 */
export function importDestination(folder: string, fileName: string): string {
  const base = folder.trim().replace(/^\/+|\/+$/g, "");
  return base === "" ? fileName : `${base}/${fileName}`;
}

/** `Dune.epub` + taken paths → `Dune-2.epub`, `Dune-3.epub`, … */
export function collisionFreePath(path: string, exists: (p: string) => boolean): string {
  if (!exists(path)) return path;
  const dot = path.lastIndexOf(".");
  const stem = dot < 0 ? path : path.slice(0, dot);
  const ext = dot < 0 ? "" : path.slice(dot);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * "Import…" — copy a book from anywhere on disk into the vault, then hand the
 * vault path back. A hidden file input + `vault.createBinary`, so the same
 * code works wherever Obsidian runs; no Electron-only dialogs.
 */
export function importBookFile(
  app: App,
  folder: string,
  onImported: (path: string) => void,
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = BOOK_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(",");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        if (!isBookFilePath(file.name)) {
          new Notice(`Not a book format: ${file.name}`);
          return;
        }
        const destination = collisionFreePath(
          importDestination(folder, file.name),
          (p) => app.vault.getAbstractFileByPath(p) !== null,
        );
        // Segment-wise, as the notes writer does — createFolder does not
        // reliably create intermediate folders on every platform.
        const segments = destination.split("/").slice(0, -1);
        let current = "";
        for (const segment of segments) {
          current = current === "" ? segment : `${current}/${segment}`;
          if (app.vault.getAbstractFileByPath(current) === null) {
            await app.vault.createFolder(current);
          }
        }
        await app.vault.createBinary(destination, await file.arrayBuffer());
        new Notice(`Imported to ${destination}.`);
        onImported(destination);
      } catch (err) {
        new Notice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("[wrl] book import failed", err);
      }
    })();
  });
  input.click();
}

/** Pick a book file out of the vault, best matches for `title` on top. */
export class BookFileSuggestModal extends FuzzySuggestModal<string> {
  private readonly paths: string[];
  private readonly onPick: (path: string) => void;

  constructor(app: App, title: string, onPick: (path: string) => void) {
    super(app);
    this.onPick = onPick;
    this.paths = rankBookFiles(
      app.vault.getFiles().map((file) => file.path),
      title,
    );
    this.setPlaceholder(
      this.paths.length === 0
        ? "No epub/pdf files in this vault."
        : "Pick the book's file…",
    );
  }

  override getItems(): string[] {
    return this.paths;
  }

  override getItemText(path: string): string {
    return path;
  }

  override onChooseItem(path: string): void {
    this.onPick(path);
  }
}
