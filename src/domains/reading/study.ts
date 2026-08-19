/**
 * The study workspace — a book on one side, your own notes on the other.
 *
 * THE CASE THIS EXISTS FOR
 * ------------------------
 * "When I read a book I sometimes make notes or even make an Excalidraw
 * diagram … maybe even different notes per chapter, or drawings per chapter."
 * The plugin already knew where a book's *file* was and which page you were on
 * (`bookfile.ts`); what it had no idea about was the material you make *while*
 * reading it. So this module adds three things and nothing else:
 *
 *   1. **a chapter index** on the book — a number and an optional name, no more;
 *   2. **a file per chapter**, note or drawing, created on demand;
 *   3. **the two motions that matter**: open the book beside the chapter note,
 *      and drop the page you are looking at into that note as a live reference.
 *
 * THREE RULES THIS MODULE IS BUILT AROUND
 * ---------------------------------------
 *
 * **The chapter list is an index, never ownership.** Removing a chapter edits a
 * list on the book record. It does not touch the vault. A note you wrote is
 * yours; nothing here deletes one, ever, and `withoutChapter` is a pure array
 * function precisely so it *cannot*.
 *
 * **Create-if-absent, open-if-present.** Every "open" here resolves an existing
 * file first and only writes when there is nothing to open. A template is a
 * starting point offered once, not a shape re-imposed on every click. Appending
 * a page reference appends — the file around it is never rewritten.
 *
 * **A screenshot is the wrong artefact.** The ask was "screenshots with
 * references"; Obsidian already has something strictly better. `![[book.pdf#page=12]]`
 * renders the page *and* remains a live link back to it — it cannot go stale,
 * it carries its own citation, and it costs no bytes. So `insertCurrentPage`
 * writes that, reading the page out of whichever PDF viewer is open via
 * `openPdfPages`. No raster capture is taken anywhere in this file.
 *
 * WHERE THE FILES LIVE
 * --------------------
 * `<reading folder>/<book title>/Chapter 03.md`, and the drawing beside it as
 * `Chapter 03 — diagram.excalidraw.md`. Zero-padded so a folder listing sorts
 * the way a book reads, under the folder `notes.ts` already decided reading
 * material belongs in, through the same `sanitizeFileName` a reading note gets.
 *
 * A chapter's *name* rides along in the filename when it has one, which is what
 * makes the folder browsable — but renaming a chapter must not therefore orphan
 * the note you already wrote. `resolveChapterFile` looks for the exact path and
 * then for *any* file in the folder claiming that chapter number, so a rename
 * finds the old file and keeps writing to it.
 *
 * WHAT IS OBSIDIAN AND WHAT IS NOT
 * --------------------------------
 * Everything above the vault is pure and exported: the chapter list algebra,
 * the paths, both templates, the page-embed block, and the "which chapter is
 * this file" matcher. That is the half the tests drive. The vault half uses the
 * vault API only — never Node `fs` — and the Excalidraw half is *feature
 * detected* against `window.ExcalidrawAutomate`, never imported, because the
 * plugin is a thing the user may or may not have.
 */
import {
  Menu,
  Notice,
  Platform,
  TFile,
  TFolder,
  normalizePath,
  type App,
  type WorkspaceLeaf,
} from "obsidian";
import { sanitizeFileName } from "../../data/notes";
import { readExtra, type ReadingData, type ReadingPatch, type Settings } from "../../types";
import { openBookFile, openPdfPages, type PdfOpenState } from "./bookfile";
import { readingFolderFor } from "./notes";
import type { ReadingEntry } from "./progress";

// ---------------------------------------------------------------------------
// The chapter index
// ---------------------------------------------------------------------------

/**
 * The preserved key the chapter list lives under.
 *
 * `types.ts` is frozen, so this takes the road `manualCoverUrl` and `review`
 * took before it: an undeclared key on the reading row, written through the
 * store like any other field and round-tripped through `data.json` verbatim by
 * the runtime preservation contract in the `types.ts` header. One spelling,
 * here, and everything else asks by function.
 */
export const STUDY_CHAPTERS_KEY = "studyChapters";

/** A chapter is a number and, when the reader bothered, a name. That is all. */
export interface StudyChapter {
  number: number;
  /** Absent and blank are the same thing; readers may assume `""` means none. */
  name?: string;
}

/**
 * The chapter list off a book — tolerant, because this key is user data that
 * has round-tripped through `data.json` and may be anything at all.
 *
 * Sorted by number and deduplicated on it: the number *is* the identity, and
 * two "Chapter 3"s would resolve to one file and fight over it.
 */
export function readChapters(entry: ReadingEntry): StudyChapter[] {
  const raw = readExtra<unknown>(entry, STUDY_CHAPTERS_KEY);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: StudyChapter[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const number = (item as { number?: unknown }).number;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 1) continue;
    const n = Math.floor(number);
    if (seen.has(n)) continue;
    seen.add(n);
    const name = (item as { name?: unknown }).name;
    out.push(typeof name === "string" && name.trim() !== "" ? { number: n, name: name.trim() } : { number: n });
  }
  return out.sort((a, b) => a.number - b.number);
}

/**
 * The patch that writes the list back.
 *
 * The cast is the same one `detail/extras.ts` documents and is confined to this
 * line: `ReadingPatch` cannot name a key that is not on `Book`, while the
 * store's `applyPatch` walks `Object.entries` and writes what it is handed. A
 * fresh array every time, so the store's identity check always sees a change.
 */
export function chaptersPatch(chapters: readonly StudyChapter[]): ReadingPatch {
  return { [STUDY_CHAPTERS_KEY]: chapters.map((c) => ({ ...c })) } as unknown as ReadingPatch;
}

/**
 * Chapters the reader has explicitly forgotten.
 *
 * This key exists because of `chaptersOnDisk`. Once the index heals itself from
 * the folder, "Remove" would otherwise be undone by the very next repaint — the
 * file is still there, so the chapter comes straight back — and a confirmation
 * dialog that promises something the next render reverses is a lie told twice.
 *
 * So removal records *intent*, not just absence. Adding the chapter again
 * clears it, because asking for it back is the plainest possible way of saying
 * you want it back.
 */
export const STUDY_FORGOTTEN_KEY = "studyChaptersForgotten";

export function readForgottenChapters(entry: ReadingEntry): number[] {
  const raw = readExtra<unknown>(entry, STUDY_FORGOTTEN_KEY);
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 1) continue;
    out.add(Math.floor(item));
  }
  return [...out].sort((a, b) => a - b);
}

export function forgottenPatch(numbers: readonly number[]): ReadingPatch {
  return { [STUDY_FORGOTTEN_KEY]: [...numbers] } as unknown as ReadingPatch;
}

/**
 * Adopt a chapter: into the index, and out of the forgotten list.
 *
 * The one patch every "add this chapter" goes through — the Add row, the table
 * shortcut, and re-adoption after a removal — so no caller has to remember the
 * second half.
 */
export function adoptChapterPatch(
  entry: ReadingEntry,
  number: number,
  name = "",
): ReadingPatch {
  const n = Math.max(1, Math.floor(number));
  return {
    ...chaptersPatch(withChapter(readChapters(entry), n, name)),
    ...forgottenPatch(readForgottenChapters(entry).filter((held) => held !== n)),
  };
}

/** Forget a chapter, and remember that it was forgotten. */
export function forgetChapterPatch(entry: ReadingEntry, number: number): ReadingPatch {
  const n = Math.max(1, Math.floor(number));
  return {
    ...chaptersPatch(withoutChapter(readChapters(entry), n)),
    ...forgottenPatch([...new Set([...readForgottenChapters(entry), n])].sort((a, b) => a - b)),
  };
}

/** The number "Add chapter" should propose: one past the highest, or 1. */
export function nextChapterNumber(chapters: readonly StudyChapter[]): number {
  return chapters.reduce((max, c) => Math.max(max, c.number), 0) + 1;
}

/** Add — or, when that number is already indexed, adopt the name onto it. */
export function withChapter(
  chapters: readonly StudyChapter[],
  number: number,
  name = "",
): StudyChapter[] {
  const n = Math.max(1, Math.floor(number));
  const label = name.trim();
  const kept = chapters.filter((c) => c.number !== n);
  const existing = chapters.find((c) => c.number === n);
  const chapter: StudyChapter = { number: n };
  const resolved = label === "" ? (existing?.name ?? "") : label;
  if (resolved !== "") chapter.name = resolved;
  return [...kept, chapter].sort((a, b) => a.number - b.number);
}

/** Rename in place. A blank name clears it; an unknown number changes nothing. */
export function renamedChapter(
  chapters: readonly StudyChapter[],
  number: number,
  name: string,
): StudyChapter[] {
  const label = name.trim();
  return chapters.map((c) => {
    if (c.number !== number) return c;
    return label === "" ? { number: c.number } : { number: c.number, name: label };
  });
}

/**
 * Drop a chapter from the index.
 *
 * A pure array function on purpose. There is no vault in this signature and
 * there never will be: forgetting a chapter is not deleting a note, and the way
 * to guarantee that is to write the removal somewhere that has no way to.
 */
export function withoutChapter(
  chapters: readonly StudyChapter[],
  number: number,
): StudyChapter[] {
  return chapters.filter((c) => c.number !== number);
}

// ---------------------------------------------------------------------------
// Where a chapter's material lives
// ---------------------------------------------------------------------------

/** The suffix that makes a file the chapter's *drawing* rather than its note. */
export const DIAGRAM_SUFFIX = " — diagram.excalidraw.md";

/** A chapter's number, zero-padded to two so ten does not sort before two. */
export function chapterNumberLabel(number: number): string {
  return String(Math.max(1, Math.floor(number))).padStart(2, "0");
}

/**
 * The per-book folder: the reading folder, then the book.
 *
 * Same folder the book's own note sits in, one level down — so a vault that
 * already has `Reading/Dune.md` gains `Reading/Dune/Chapter 03.md` beside it
 * rather than a second tree somewhere else.
 */
export function studyFolderFor(
  entry: ReadingEntry,
  settings: Settings,
  reading: ReadingData,
): string {
  const base = readingFolderFor(settings, reading);
  const book = sanitizeFileName(entry.title || entry.id) || entry.id;
  return base === "" ? book : `${base}/${book}`;
}

/**
 * The file *stem* for a chapter — `Chapter 03`, or `Chapter 03 — Arrakis`.
 *
 * The name is sanitised exactly as a note title is, so `C++: The Basics?`
 * becomes `C++- The Basics-` and the path is legal on every platform Obsidian
 * runs on.
 */
export function chapterStem(chapter: StudyChapter): string {
  const label = `Chapter ${chapterNumberLabel(chapter.number)}`;
  const name = sanitizeFileName(chapter.name ?? "");
  return name === "" ? label : `${label} — ${name}`;
}

export function chapterNotePath(
  entry: ReadingEntry,
  chapter: StudyChapter,
  settings: Settings,
  reading: ReadingData,
): string {
  return `${studyFolderFor(entry, settings, reading)}/${chapterStem(chapter)}.md`;
}

export function chapterDiagramPath(
  entry: ReadingEntry,
  chapter: StudyChapter,
  settings: Settings,
  reading: ReadingData,
): string {
  return `${studyFolderFor(entry, settings, reading)}/${chapterStem(chapter)}${DIAGRAM_SUFFIX}`;
}

/** Note or drawing — the two kinds of material a chapter can have. */
export type ChapterMaterial = "note" | "diagram";

export function chapterMaterialPath(
  entry: ReadingEntry,
  chapter: StudyChapter,
  kind: ChapterMaterial,
  settings: Settings,
  reading: ReadingData,
): string {
  return kind === "diagram"
    ? chapterDiagramPath(entry, chapter, settings, reading)
    : chapterNotePath(entry, chapter, settings, reading);
}

/**
 * Which chapter (and which kind of material) a file name claims to be, or null.
 *
 * This is what makes a *rename* survivable — `Chapter 03 — Arrakis.md` and
 * `Chapter 03.md` both answer 3 — and it is what lets the palette command work
 * out which chapter note the cursor is sitting in.
 */
export function chapterFileClaim(
  fileName: string,
): { number: number; kind: ChapterMaterial } | null {
  const match = /^Chapter[ \t]+(\d{1,4})(?![0-9])/.exec(fileName);
  if (!match?.[1]) return null;
  const number = Number.parseInt(match[1], 10);
  if (!(number >= 1)) return null;
  if (fileName.endsWith(".excalidraw.md")) return { number, kind: "diagram" };
  if (fileName.endsWith(".md")) return { number, kind: "note" };
  return null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `Chapter 3` / `Chapter 3: Arrakis` — for headings and notices, not paths. */
export function chapterLabel(chapter: StudyChapter): string {
  const name = (chapter.name ?? "").trim();
  return name === "" ? `Chapter ${chapter.number}` : `Chapter ${chapter.number}: ${name}`;
}

/**
 * The note a chapter starts life as. Short on purpose — it is the user's page,
 * and everything below the frontmatter is theirs from the first keystroke.
 *
 * `page` is where the book is open right now (or the stored bookmark); it
 * becomes an ordinary wiki link rather than an embed, because a chapter that
 * begins on page 41 wants a way *back to* page 41, not a picture of it at the
 * top of every note.
 */
export function chapterNoteTemplate(
  entry: ReadingEntry,
  chapter: StudyChapter,
  page?: number,
): string {
  const front: string[] = [
    `book: ${yamlString(entry.title)}`,
    `chapter: ${chapter.number}`,
  ];
  const name = (chapter.name ?? "").trim();
  if (name !== "") front.push(`chapterTitle: ${yamlString(name)}`);
  if ((entry.author ?? "").trim() !== "") front.push(`author: ${yamlString(entry.author ?? "")}`);

  const lines = [`---`, ...front, `---`, ``, `# ${entry.title} — ${chapterLabel(chapter)}`, ``];
  const file = (entry.filePath ?? "").trim();
  if (file !== "" && typeof page === "number" && page >= 1) {
    lines.push(`Starts at [[${file}#page=${Math.floor(page)}]]`, ``);
  } else if (file !== "") {
    lines.push(`[[${file}]]`, ``);
  }
  lines.push(`## Notes`, ``);
  return lines.join("\n");
}

/**
 * The banner the Excalidraw plugin puts at the top of every drawing it writes,
 * verbatim (double space after the first ⚠ included). It is what a reader sees
 * if the file is ever opened as plain markdown.
 */
export const EXCALIDRAW_BANNER =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== " +
  "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. " +
  "For more info check in plugin settings under 'Saving'";

/**
 * A blank drawing, byte-compatible with what the plugin itself writes.
 *
 * This is the *fallback* — `window.ExcalidrawAutomate.create` is preferred and
 * tried first — so it has to be right, because a nearly-valid `.excalidraw.md`
 * opens as junk and the user's response to junk is to delete it.
 *
 * It is not invented. It is the plugin's own `FRONTMATTER` constant followed by
 * its own `getMarkdownDrawingSection(BLANK_DRAWING, false)`:
 *
 *   FRONTMATTER = ["---","","excalidraw-plugin: parsed","tags: [excalidraw]",
 *                  "","---", <banner>, "", ""].join("\n")
 *   BLANK_DRAWING = {"type":"excalidraw","version":2,"source":…,"elements":[],
 *                    "appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"}}
 *   section       = "## Drawing\n```json\n" + BLANK_DRAWING + "\n```\n%%"
 *
 * `parsed` rather than `compressed-json`: the plugin reads both and rewrites the
 * file in whichever form the *user's* settings prefer on the first save, and a
 * plain JSON block is the one a human can still repair by hand.
 */
export function excalidrawSkeleton(): string {
  const drawing = JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://github.com/zsviczian/obsidian-excalidraw-plugin",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
  });
  return [
    "---",
    "",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "",
    "---",
    EXCALIDRAW_BANNER,
    "",
    "",
    "## Drawing",
    "```json",
    drawing,
    "```",
    "%%",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The page reference
// ---------------------------------------------------------------------------

/** The page a given file is showing right now, out of whatever PDFs are open. */
export function currentPageOf(
  open: readonly PdfOpenState[],
  filePath: string,
): number | null {
  const wanted = filePath.trim();
  if (wanted === "") return null;
  for (const state of open) {
    if (state.path === wanted) return state.page;
  }
  return null;
}

/**
 * The block a page reference appends as.
 *
 * An **embed**, so the page is visible in the note, and a live link, so it is
 * still a reference — that is the whole reason this beats a screenshot. The
 * caption carries no timestamp: a note is not a log, and a date stamped beside
 * every figure is noise the second time you read it.
 */
export function pageEmbedBlock(filePath: string, page: number, book: string): string {
  const n = Math.max(1, Math.floor(page));
  const caption = book.trim() === "" ? `Page ${n}` : `${book.trim()}, page ${n}`;
  return `\n![[${filePath}#page=${n}]]\n*${caption}*\n`;
}

/** Appending must never rewrite what is already there — not even the newline. */
export function appendedBody(existing: string, block: string): string {
  return existing.endsWith("\n") || existing === "" ? existing + block : `${existing}\n${block}`;
}

// ---------------------------------------------------------------------------
// The vault side
// ---------------------------------------------------------------------------

/**
 * Create every missing folder on the way to `path`, segment by segment.
 *
 * The same shape `ReadingNoteWriter.ensureFolder` uses, for the same two
 * reasons: `createFolder` does not reliably create intermediates on every
 * platform, and a *file* sitting where a folder should be is a reason to stop
 * rather than to throw.
 */
async function ensureFolder(app: App, path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent === "" || parent === path) return;
  let current = "";
  for (const part of parent.split("/")) {
    current = current === "" ? part : `${current}/${part}`;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) continue;
    if (existing) return;
    try {
      await app.vault.createFolder(current);
    } catch {
      // Two clicks in the same second race here; the folder existing is the win.
    }
  }
}

/**
 * The vault, when there is one.
 *
 * A detail surface can be mounted without an app — that is how both of them are
 * driven headlessly — and "is there already a note for chapter 3" is a question
 * with a perfectly good answer in that case: we cannot know, so the row offers
 * to create one. Never a throw during a paint.
 */
function vaultOf(app: App): App["vault"] | null {
  const vault = (app as { vault?: App["vault"] } | undefined)?.vault;
  return vault && typeof vault.getAbstractFileByPath === "function" ? vault : null;
}

/** Every file directly inside a folder, or `[]` when there is no such folder. */
function folderChildren(app: App, folder: string): TFile[] {
  const dir = vaultOf(app)?.getAbstractFileByPath(normalizePath(folder));
  if (!(dir instanceof TFolder)) return [];
  return (dir.children ?? []).filter((child): child is TFile => child instanceof TFile);
}

/**
 * The file that *is* this chapter's note (or drawing), if one already exists.
 *
 * Exact path first. Failing that, any file in the book's folder claiming the
 * same chapter number and the same kind — which is what stops a rename from
 * orphaning the note you already wrote into it.
 */
export function resolveChapterFile(
  app: App,
  entry: ReadingEntry,
  chapter: StudyChapter,
  kind: ChapterMaterial,
  settings: Settings,
  reading: ReadingData,
): TFile | null {
  const vault = vaultOf(app);
  if (!vault) return null;
  const exact = vault.getAbstractFileByPath(
    normalizePath(chapterMaterialPath(entry, chapter, kind, settings, reading)),
  );
  if (exact instanceof TFile) return exact;

  const folder = studyFolderFor(entry, settings, reading);
  for (const child of folderChildren(app, folder)) {
    const name = child.path.slice(child.path.lastIndexOf("/") + 1);
    const claim = chapterFileClaim(name);
    if (claim && claim.number === chapter.number && claim.kind === kind) return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The index heals itself from the folder
// ---------------------------------------------------------------------------

/**
 * Every chapter number the book's folder can prove exists.
 *
 * THE INCIDENT THIS EXISTS FOR
 * ----------------------------
 * A real book's `studyChapters` was found empty while
 * `Chapter 01.md` and `Chapter 01 — diagram.excalidraw.md` sat in its folder.
 * The index had lost what the disk still knew.
 *
 * The disk is the better record and always was: the files are the work, the
 * list is a convenience. So the list is *derived* from the folder wherever the
 * folder has an opinion, and an index wipe — from whatever cause, including
 * ones nobody has diagnosed — becomes a repaint rather than a loss.
 *
 * Read-only, and deliberately incurious: `chapterFileClaim` answers null for
 * anything that is not named like a chapter, which is exactly the right
 * treatment for a file the user renamed to `Notes on the routing chapter.md`.
 * It is theirs; it is not ours to index.
 */
export function chaptersOnDisk(
  app: App,
  entry: ReadingEntry,
  settings: Settings,
  reading: ReadingData,
): number[] {
  const numbers = new Set<number>();
  for (const child of folderChildren(app, studyFolderFor(entry, settings, reading))) {
    const claim = chapterFileClaim(child.path.slice(child.path.lastIndexOf("/") + 1));
    if (claim) numbers.add(claim.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * The index as it should be, given what is on disk — or `null` when the index
 * is already right, which is almost every render.
 *
 * Only ever *adds*: a chapter with no file yet is a perfectly good plan for a
 * chapter, and a list that deleted every entry the folder could not vouch for
 * would throw away the one the reader added thirty seconds ago. And it skips
 * anything explicitly forgotten, so healing cannot undo a removal.
 */
export function reconciledChapters(
  indexed: readonly StudyChapter[],
  onDisk: readonly number[],
  forgotten: readonly number[] = [],
): StudyChapter[] | null {
  const known = new Set(indexed.map((c) => c.number));
  const skip = new Set(forgotten);
  const missing = onDisk.filter((n) => !known.has(n) && !skip.has(n));
  if (missing.length === 0) return null;
  return [...indexed, ...missing.map((number) => ({ number }))].sort(
    (a, b) => a.number - b.number,
  );
}

// ---------------------------------------------------------------------------
// Everything a chapter owns, and moving it to the trash
// ---------------------------------------------------------------------------

/**
 * Every file in the book's folder that claims this chapter — both kinds.
 *
 * `resolveChapterFile` answers the *one* file to open; this answers the whole
 * set, which is what removal needs. "It only removes the chapter markdown and
 * does not remove the diagram" is the report this exists for: a chapter's note
 * and its drawing are one thing to the reader, and a removal that takes one and
 * leaves the other is not a removal, it is an orphan factory.
 *
 * The exact paths *and* the folder scan, unioned: the scan catches a file whose
 * name the reader edited (`Chapter 03 — Arrakis.md` → `Chapter 03 — spice.md`),
 * and the exact lookup still works in the degenerate case where the folder does
 * not resolve. A file the reader renamed out of the convention entirely is not
 * in the set — `chapterFileClaim` does not recognise it, and nothing this
 * module does may trash a file it cannot prove belongs to the chapter.
 */
export function chapterFilesFor(
  app: App,
  entry: ReadingEntry,
  chapter: StudyChapter,
  settings: Settings,
  reading: ReadingData,
): TFile[] {
  const vault = vaultOf(app);
  if (!vault) return [];
  const found = new Map<string, TFile>();

  for (const kind of ["note", "diagram"] as const) {
    const exact = vault.getAbstractFileByPath(
      normalizePath(chapterMaterialPath(entry, chapter, kind, settings, reading)),
    );
    if (exact instanceof TFile) found.set(exact.path, exact);
  }
  for (const child of folderChildren(app, studyFolderFor(entry, settings, reading))) {
    const claim = chapterFileClaim(child.path.slice(child.path.lastIndexOf("/") + 1));
    if (claim?.number === chapter.number) found.set(child.path, child);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** "its note", "its drawing", "its note and its drawing" — for the dialog. */
export function describeChapterFiles(files: readonly TFile[]): string {
  const kinds = new Set(
    files
      .map((file) => chapterFileClaim(file.path.slice(file.path.lastIndexOf("/") + 1))?.kind)
      .filter((kind): kind is ChapterMaterial => kind !== undefined),
  );
  const parts: string[] = [];
  if (kinds.has("note")) parts.push("its note");
  if (kinds.has("diagram")) parts.push("its drawing");
  return parts.join(" and ");
}

/**
 * Close every pane showing one of these files, in every window.
 *
 * Trashing a file that a leaf is displaying leaves a dead pane behind — an
 * empty editor over a path that no longer exists, in the main window or in a
 * popout. So the panes go first.
 *
 * `iterateAllLeaves` reaches into popout windows, and the match is a **string
 * comparison on `view.file.path`** rather than any `instanceof`: a leaf from a
 * popout carries objects from that window's realm, and this codebase has been
 * bitten by exactly that. The leaves are collected before any of them is
 * detached, because detaching inside the iteration mutates what is being
 * iterated.
 */
export function detachLeavesShowing(app: App, paths: readonly string[]): number {
  const wanted = new Set(paths.map((path) => normalizePath(path)));
  if (wanted.size === 0) return 0;

  const doomed: { detach?: () => void }[] = [];
  const workspace = app.workspace as unknown as {
    iterateAllLeaves?: (cb: (leaf: WorkspaceLeaf) => void) => void;
    getLeavesOfType?: (type: string) => WorkspaceLeaf[];
  };
  const consider = (leaf: WorkspaceLeaf): void => {
    const path = (leaf as unknown as LeafLike).view?.file?.path;
    if (typeof path === "string" && wanted.has(path)) {
      doomed.push(leaf as unknown as { detach?: () => void });
    }
  };
  if (typeof workspace.iterateAllLeaves === "function") {
    workspace.iterateAllLeaves(consider);
  } else {
    for (const type of ["markdown", "excalidraw"]) {
      for (const leaf of workspace.getLeavesOfType?.(type) ?? []) consider(leaf);
    }
  }

  for (const leaf of doomed) leaf.detach?.();
  return doomed.length;
}

export interface TrashOutcome {
  trashed: string[];
  failed: string[];
}

/**
 * Move a chapter's files to the trash — **the trash**, never a hard delete.
 *
 * `fileManager.trashFile` honours the reader's own "Deleted files" setting: the
 * system bin, the vault's `.trash/`, or permanent, as *they* configured it.
 * That is the whole reason a default-ticked checkbox is acceptable in the
 * dialog — the answer to a mis-click is Cmd-Z in Finder, not a restore from
 * backup. Nothing in this module calls `vault.delete` or `adapter.remove`.
 *
 * A file that will not go is reported, never thrown: half a removal that says
 * which half is a bad afternoon; an exception mid-loop is a corrupt one.
 */
export async function trashChapterFiles(
  app: App,
  entry: ReadingEntry,
  chapter: StudyChapter,
  settings: Settings,
  reading: ReadingData,
): Promise<TrashOutcome> {
  const files = chapterFilesFor(app, entry, chapter, settings, reading);
  const outcome: TrashOutcome = { trashed: [], failed: [] };
  if (files.length === 0) return outcome;

  detachLeavesShowing(
    app,
    files.map((file) => file.path),
  );

  const manager = (app as unknown as { fileManager?: { trashFile?: (f: TFile) => Promise<void> } })
    .fileManager;
  if (typeof manager?.trashFile !== "function") {
    new Notice("This version of Obsidian cannot move files to the trash — the files were left alone.");
    outcome.failed.push(...files.map((file) => file.path));
    return outcome;
  }

  for (const file of files) {
    try {
      await manager.trashFile(file);
      outcome.trashed.push(file.path);
    } catch (err) {
      outcome.failed.push(file.path);
      console.error(`[wrl] could not trash ${file.path}`, err);
    }
  }
  return outcome;
}

/** Whether a chapter already has material of this kind, for the UI to say so. */
export function chapterHasMaterial(
  app: App,
  entry: ReadingEntry,
  chapter: StudyChapter,
  kind: ChapterMaterial,
  settings: Settings,
  reading: ReadingData,
): boolean {
  return resolveChapterFile(app, entry, chapter, kind, settings, reading) !== null;
}

/**
 * The Excalidraw plugin's automation API, if the user has the plugin.
 *
 * Feature-detected off `window`, never imported: the plugin is an optional
 * thing in someone else's vault, and an import would make this module fail to
 * load without it. Typed as the two members we actually call.
 */
export interface ExcalidrawAutomateLike {
  reset?: () => void;
  create: (params: {
    filename?: string;
    foldername?: string;
    onNewPane?: boolean;
    silent?: boolean;
  }) => Promise<string>;
}

export function excalidrawAutomate(): ExcalidrawAutomateLike | null {
  const ea = (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
  if (!ea || typeof ea !== "object") return null;
  return typeof (ea as ExcalidrawAutomateLike).create === "function"
    ? (ea as ExcalidrawAutomateLike)
    : null;
}

/** Is Excalidraw installed *and* enabled? The automation API is the tell. */
export function excalidrawAvailable(app: App): boolean {
  if (excalidrawAutomate() !== null) return true;
  // Unofficial and therefore feature-detected: enabled plugins are not part of
  // the published API, and its absence just means "we have to say no".
  const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
  return plugins?.enabledPlugins?.has?.("obsidian-excalidraw-plugin") === true;
}

/**
 * Open `path`, creating it from `contents` only when nothing is there.
 *
 * The one function every "open" in this module goes through, and the reason
 * rule 3 holds: an existing file is *returned*, never regenerated, so a
 * template can only ever be the first thing in a file and never the last.
 */
export async function ensureFile(
  app: App,
  path: string,
  contents: () => string,
): Promise<TFile | null> {
  const normalized = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) return existing;
  if (existing) {
    new Notice(`A folder already sits at ${normalized}.`);
    return null;
  }
  try {
    await ensureFolder(app, normalized);
    const created = await app.vault.create(normalized, contents());
    return created instanceof TFile
      ? created
      : ((app.vault.getAbstractFileByPath(normalized) as TFile | null) ?? null);
  } catch (err) {
    new Notice(`Could not create ${normalized} — ${message(err)}`);
    console.error("[wrl] study file could not be created", err);
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Append to a file without rewriting it.
 *
 * `vault.process` when the installed Obsidian has it (atomic read-modify-write,
 * so a page dropped in while the note is open cannot lose a sentence typed a
 * moment earlier), `append` next, and only then the read/modify pair. All three
 * append; none of them touch a byte before the insertion point.
 */
export async function appendToFile(app: App, file: TFile, block: string): Promise<void> {
  const vault = app.vault as unknown as {
    process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
    append?: (file: TFile, data: string) => Promise<void>;
    read: (file: TFile) => Promise<string>;
    modify: (file: TFile, data: string) => Promise<void>;
  };
  if (typeof vault.process === "function") {
    await vault.process(file, (data) => appendedBody(data, block));
    return;
  }
  if (typeof vault.append === "function") {
    const existing = await vault.read(file);
    await vault.append(file, existing.endsWith("\n") || existing === "" ? block : `\n${block}`);
    return;
  }
  const existing = await vault.read(file);
  await vault.modify(file, appendedBody(existing, block));
}

// ---------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------

interface LeafLike {
  view?: { file?: { path?: string } };
  openFile?: (file: TFile) => Promise<void>;
}

/**
 * A leaf already showing this file, if there is one.
 *
 * Without it, "read and take notes" spawns a fresh split every single click and
 * a morning's reading ends as eleven identical panes — which is precisely the
 * complaint `openBookDetail` reuses its leaf to avoid.
 */
export function findLeafShowingFile(app: App, path: string): WorkspaceLeaf | null {
  const wanted = normalizePath(path);
  let found: WorkspaceLeaf | null = null;
  const workspace = app.workspace as unknown as {
    iterateAllLeaves?: (cb: (leaf: WorkspaceLeaf) => void) => void;
    getLeavesOfType?: (type: string) => WorkspaceLeaf[];
  };
  const consider = (leaf: WorkspaceLeaf): void => {
    if (found) return;
    if ((leaf as unknown as LeafLike).view?.file?.path === wanted) found = leaf;
  };
  if (typeof workspace.iterateAllLeaves === "function") {
    workspace.iterateAllLeaves(consider);
  } else {
    for (const type of ["markdown", "excalidraw"]) {
      for (const leaf of workspace.getLeavesOfType?.(type) ?? []) consider(leaf);
    }
  }
  return found;
}

/**
 * Reveal the leaf already showing `file`, or open it in a new one.
 *
 * Returns the leaf either way, because the three-pane layout needs something
 * to *anchor* to: the diagram is split off the note's pane, and the note's pane
 * is as often the one that was already open as the one just created.
 */
export async function openFileInLeaf(
  app: App,
  file: TFile,
  mode: "tab" | "split",
): Promise<WorkspaceLeaf | null> {
  const existing = findLeafShowingFile(app, file.path);
  if (existing) {
    app.workspace.revealLeaf(existing);
    return existing;
  }
  const leaf = app.workspace.getLeaf(mode);
  await (leaf as unknown as LeafLike).openFile?.(file);
  return leaf ?? null;
}

/**
 * Open `file` in a pane split off `anchor` — the only way to say *where*.
 *
 * `getLeaf("split")` splits whichever leaf happens to be active, which for a
 * third pane is a coin toss; `createLeafBySplit` names the pane being divided
 * and the direction, so "below the note" means below the note. Feature-detected
 * because it is the one workspace method a stubbed workspace is likely to
 * lack, and falling back to a plain split is a worse layout, not a failure.
 */
export async function openFileBesideLeaf(
  app: App,
  file: TFile,
  anchor: WorkspaceLeaf | null,
  direction: "horizontal" | "vertical",
): Promise<WorkspaceLeaf | null> {
  const existing = findLeafShowingFile(app, file.path);
  if (existing) {
    app.workspace.revealLeaf(existing);
    return existing;
  }
  const workspace = app.workspace as unknown as {
    createLeafBySplit?: (leaf: WorkspaceLeaf, direction: string) => WorkspaceLeaf;
  };
  const leaf =
    anchor && typeof workspace.createLeafBySplit === "function"
      ? workspace.createLeafBySplit(anchor, direction)
      : app.workspace.getLeaf("split");
  await (leaf as unknown as LeafLike).openFile?.(file);
  return leaf ?? null;
}

// ---------------------------------------------------------------------------
// The three actions
// ---------------------------------------------------------------------------

/** Everything an action needs to find a book's chapter material. */
export interface StudyContext {
  app: App;
  entry: ReadingEntry;
  settings: Settings;
  reading: ReadingData;
}

/**
 * Where the reader is in this book, best answer first: the page the PDF is
 * *actually* showing, then the bookmark the page-watcher left behind.
 */
export function studyPage(context: StudyContext): number | undefined {
  const file = (context.entry.filePath ?? "").trim();
  if (file === "") return undefined;
  const live = currentPageOf(openPdfPages(context.app), file);
  if (live !== null) return live;
  const marked = context.entry.filePage ?? 0;
  return marked > 1 ? marked : undefined;
}

/**
 * The chapter's note or drawing **as a file** — existing, or created now.
 *
 * Deliberately does not open anything. Every way of *showing* a chapter (a tab,
 * a split, a separate OS window) needs the same answer to "which file is this,
 * and does it exist yet", and three copies of that question is three chances to
 * create a second note beside the one already there.
 *
 * Null is a real answer: a drawing without the Excalidraw plugin is a
 * *deliberate* refusal, not a failure — a `.excalidraw.md` in a vault that
 * cannot render it is a file the user opens once, sees garbage in, and deletes.
 */
export async function ensureChapterMaterial(
  context: StudyContext,
  chapter: StudyChapter,
  kind: ChapterMaterial,
): Promise<TFile | null> {
  const { app, entry, settings, reading } = context;
  const existing = resolveChapterFile(app, entry, chapter, kind, settings, reading);
  if (existing) return existing;
  if (kind === "diagram") return createChapterDiagram(context, chapter);
  return ensureFile(
    app,
    chapterNotePath(entry, chapter, settings, reading),
    () => chapterNoteTemplate(entry, chapter, studyPage(context)),
  );
}

/** Open a chapter's note or drawing in this window, creating it the first time. */
export async function openChapterMaterial(
  context: StudyContext,
  chapter: StudyChapter,
  kind: ChapterMaterial,
  mode: "tab" | "split" = "tab",
): Promise<TFile | null> {
  const file = await ensureChapterMaterial(context, chapter, kind);
  if (file) await openFileInLeaf(context.app, file, mode);
  return file;
}

/**
 * Make the drawing file itself.
 *
 * `ExcalidrawAutomate.create` first, because a file the plugin wrote is a file
 * the plugin is certain to be able to read — it stamps its own version into
 * `source` and honours the user's compression setting. `reset()` before it,
 * since the automation object is a *global* and whatever script touched it last
 * left its elements sitting in the buffer.
 *
 * The skeleton is the fallback for the version of the plugin whose API differs
 * from this one, and it is only ever reached with the plugin present.
 */
async function createChapterDiagram(
  context: StudyContext,
  chapter: StudyChapter,
): Promise<TFile | null> {
  const { app, entry, settings, reading } = context;
  if (!excalidrawAvailable(app)) {
    new Notice("Excalidraw is not installed — the chapter note is the plain-text alternative.");
    return null;
  }

  const folder = studyFolderFor(entry, settings, reading);
  const stem = chapterStem(chapter);
  const path = normalizePath(`${folder}/${stem}${DIAGRAM_SUFFIX}`);

  const ea = excalidrawAutomate();
  if (ea) {
    try {
      ea.reset?.();
      await ensureFolder(app, path);
      // `filename` gains `.excalidraw.md` unless it already ends `.md`, so the
      // full name is handed over and the plugin leaves it alone.
      const made = await ea.create({
        filename: `${stem}${DIAGRAM_SUFFIX}`,
        foldername: folder,
        onNewPane: false,
        silent: true,
      });
      const file = app.vault.getAbstractFileByPath(normalizePath(made || path));
      if (file instanceof TFile) return file;
    } catch (err) {
      console.error("[wrl] ExcalidrawAutomate could not create the drawing", err);
    }
  }
  return ensureFile(app, path, excalidrawSkeleton);
}

// ---------------------------------------------------------------------------
// Read: one button, three layouts
// ---------------------------------------------------------------------------

/**
 * Three ways to read, one control.
 *
 * A chapter row already carries six icons and a table row is one line by
 * hard-won design, so a "Read & draw" button and an "all three" button are two
 * icons neither surface has room for. The variants ride on modifiers instead —
 * the same convention an author name already uses for its second destination
 * (`ui/detail/people.ts`) — and are spelled out by name on right-click for
 * anyone who would rather point at what they want than remember a key. The
 * tooltip says both, so neither has to be discovered by accident.
 */
export const READ_HINT =
  "Alt-click Read for the drawing, Shift-click for both, Cmd-click for a separate window. " +
  "Right-click any of them for the full list.";

/** Shift wins over Alt: asking for both is more specific than asking for one. */
export function layoutFor(event: { altKey?: boolean; shiftKey?: boolean }): StudyLayout {
  if (event.shiftKey === true) return "both";
  if (event.altKey === true) return "diagram";
  return "note";
}

/** Said on every control that honours the window modifier, so it is said once. */
export const POPOUT_HINT = "Cmd-click for a separate window";

/**
 * Did this click ask for a separate window?
 *
 * Cmd on a Mac, Ctrl everywhere else — the split Obsidian's own `Keymap` makes,
 * and it matters here for a reason beyond convention: on macOS a Ctrl-click
 * *is* a right-click, so honouring `ctrlKey` there would fire the popout and
 * the menu from one gesture.
 */
export function popoutRequested(event: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return Platform.isMacOS ? event.metaKey === true : event.ctrlKey === true;
}

/** Where a Read action ends up: panes in this window, or windows of its own. */
export interface ReadRequest {
  layout: StudyLayout;
  popout: boolean;
}

export function readRequestFor(event: {
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): ReadRequest {
  return { layout: layoutFor(event), popout: popoutRequested(event) };
}

/** One way of reading, as a button and as a menu entry — the same row of data. */
export interface ReadOption {
  layout: StudyLayout;
  popout: boolean;
  /** The button's accessible name and the menu entry's text. */
  title: string;
  /** What it actually does, for the tooltip. */
  hint: string;
  icon: string;
}

/** The six, by name, in the order the modifiers escalate. */
export const READ_LAYOUTS: readonly ReadOption[] = [
  {
    layout: "note",
    popout: false,
    title: "Read & take notes",
    hint: "Open the book beside this chapter's note",
    icon: "columns-2",
  },
  {
    layout: "diagram",
    popout: false,
    title: "Read & draw",
    hint: "Open the book beside this chapter's drawing",
    icon: "pencil-ruler",
  },
  {
    layout: "both",
    popout: false,
    title: "Read with both",
    hint: "Open the book, the note and the drawing under it",
    icon: "layout-grid",
  },
  {
    layout: "note",
    popout: true,
    title: "Note in a separate window",
    hint: "Put this chapter's note in a window of its own",
    icon: "picture-in-picture-2",
  },
  {
    layout: "diagram",
    popout: true,
    title: "Drawing in a separate window",
    hint: "Put this chapter's drawing in a window of its own",
    icon: "picture-in-picture-2",
  },
  {
    layout: "both",
    popout: true,
    title: "Both, in two windows",
    hint: "One window for the note, one for the drawing",
    icon: "copy",
  },
];

/**
 * The ones that are **buttons**, not menu entries.
 *
 * Derived rather than listed a second time, so a button and its menu entry
 * cannot drift apart — and derived *here* rather than in a surface, so the
 * chapter row and the table row offer the same verbs in the same order.
 *
 * Why buttons at all, when the modifiers already worked: "I also asked you to
 * create a separate button for the side by side with the pdf and diagram." A
 * modifier is an accelerator for someone who already knows the feature exists.
 * It is not a way to *find out* that it does.
 */
export const READ_BUTTONS: readonly ReadOption[] = READ_LAYOUTS.filter((o) => !o.popout);

/**
 * The right-click menu, once, for every surface that offers a Read control.
 *
 * It takes a `run` rather than a chapter: the book screen reads a chapter the
 * user picked, and a table row reads whichever chapter the shortcut resolves to
 * — but the *menu* is the same six choices in the same order either way, and
 * two copies of it is two places for a seventh to be forgotten. A separator
 * divides the panes from the windows, because they are two different answers to
 * "where does this go", not six points on one scale.
 */
export function openReadMenu(event: MouseEvent, run: (request: ReadRequest) => void): void {
  event.preventDefault();
  const menu = new Menu();
  let inWindows = false;
  for (const { layout, popout, title, icon } of READ_LAYOUTS) {
    if (popout && !inWindows) {
      inWindows = true;
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(icon)
        .onClick(() => run({ layout, popout })),
    );
  }
  menu.showAtMouseEvent(event);
}

/**
 * What ends up on screen beside the book: the chapter's note, its drawing, or
 * both.
 *
 * `"both"` is not two calls to `"note"` and `"diagram"` — that would put the
 * drawing beside the *book*, halving the page you are reading. It is one
 * layout, described below.
 */
export type StudyLayout = ChapterMaterial | "both";

/**
 * The motion the whole feature is for: the book on one side, the chapter on the
 * other, in one click.
 *
 * The book opens first — at the page it was left on, through `openBookFile`, so
 * a PDF lands on `#page=N` and an epub still goes to the system reader — and
 * the chapter goes into a split beside it. Second click does not split again:
 * `openFileInLeaf` reveals the pane that is already there.
 *
 * THE THREE-PANE LAYOUT
 * ---------------------
 * Book left, note top-right, **drawing under the note**. Two reasons, and they
 * are the same reason twice: the book is the thing being read, so it keeps its
 * full width rather than being cut to a third; and a diagram is what you make
 * *about* the passage in the note above it, so under the note is where the eye
 * already is. A vertical third column would give all three panes a measure too
 * narrow for a PDF page and too narrow for prose.
 *
 * It is built by anchoring: the drawing splits off the *note's* leaf, not off
 * whatever happens to be focused. So asking for all three when the note is
 * already open beside the book adds the drawing to that arrangement instead of
 * starting a second one — which is the difference between a layout and a mess.
 *
 * With no file linked, only half of this is possible, and the Notice says which
 * half rather than leaving the missing pane to be interpreted.
 */
export async function openStudySplit(
  context: StudyContext,
  chapter: StudyChapter,
  layout: StudyLayout = "note",
): Promise<TFile | null> {
  const { app, entry } = context;
  const book = (entry.filePath ?? "").trim();
  const primary: ChapterMaterial = layout === "diagram" ? "diagram" : "note";

  if (book === "") {
    const file = await openChapterMaterial(context, chapter, primary, "tab");
    if (layout === "both") await openChapterMaterial(context, chapter, "diagram", "split");
    if (file) {
      new Notice(`No book file is linked to «${entry.title}» — opened ${chapterLabel(chapter)} on its own.`);
    }
    return file;
  }

  // The book too: `openBookFile` would open a *second* tab on the same PDF
  // every time, and three clicks across a morning's reading is three copies of
  // the same book fighting for the pane you are trying to read in.
  const already = findLeafShowingFile(app, book);
  if (already) app.workspace.revealLeaf(already);
  else openBookFile(app, book, entry.filePage);

  if (layout !== "both") return openChapterMaterial(context, chapter, primary, "split");

  // Note beside the book, then the drawing under the note.
  const note = await openChapterMaterial(context, chapter, "note", "split");
  const file = await ensureChapterMaterial(context, chapter, "diagram");
  if (file) {
    const anchor = note ? findLeafShowingFile(app, note.path) : null;
    await openFileBesideLeaf(app, file, anchor, "horizontal");
  }
  return note;
}

// ---------------------------------------------------------------------------
// Separate OS windows
//
// "Open the note and/or diagram in full screen in a separate window so I can
// switch with OSX between the windows." Obsidian calls these *popouts*: a real
// Electron window with its own leaves, which is exactly what Cmd-Tab and
// Mission Control can see.
//
// THE CROSS-REALM RULE, WHICH THIS CODEBASE HAS BEEN BITTEN BY
// ------------------------------------------------------------
// A popout is a separate JavaScript realm: its `HTMLElement`, `Event` and
// `document` are *different objects* from this window's, so `instanceof
// HTMLElement` is false for a perfectly good element that came from one. There
// is not a single `instanceof` against a DOM constructor anywhere in this file
// or in `detail/study.ts`, and there must never be — the two identity checks
// below are against Obsidian's own objects (`rootSplit`, `TFile`), which the
// plugin holds exactly one copy of no matter how many windows are open.
//
// For the same reason nothing here reaches for a global `document` or `window`.
// A window is reached through the leaf that lives in it — `getContainer().win`
// — never assumed to be ours.
// ---------------------------------------------------------------------------

/** Obsidian's popout geometry: where the window goes and how big it is. */
export interface PopoutBox {
  x: number;
  y: number;
  size: { width: number; height: number };
}

/**
 * As much of the screen as a window may politely ask for.
 *
 * "Full screen" here is a **maximised window**, not a macOS fullscreen Space.
 * Fighting the OS for a Space from inside Electron is neither supported nor
 * desirable — it would take the window out of Cmd-Tab's ordinary flow, which is
 * the exact thing that was asked for. Filling the work area (`availWidth` and
 * friends already exclude the menu bar and the Dock) gets a window the user can
 * green-button themselves in one click.
 *
 * The fallback is a generous laptop-sized box, for the case where the screen
 * metrics are missing — which is every headless test, and would otherwise be a
 * zero-sized window.
 */
export function popoutBox(metrics?: {
  availWidth?: number;
  availHeight?: number;
  availLeft?: number;
  availTop?: number;
}): PopoutBox {
  const width = Math.max(900, Math.floor(metrics?.availWidth ?? 1440));
  const height = Math.max(600, Math.floor(metrics?.availHeight ?? 900));
  return {
    x: Math.floor(metrics?.availLeft ?? 0),
    y: Math.floor(metrics?.availTop ?? 0),
    size: { width, height },
  };
}

/** The screen this plugin is running on, when anything can tell us. */
function screenMetrics(): PopoutBox {
  const screen = (globalThis as { screen?: Parameters<typeof popoutBox>[0] }).screen;
  return popoutBox(screen);
}

/**
 * Is this leaf in a window of its own?
 *
 * `getContainer()` answers the *window-level* container: the one and only
 * `WorkspaceRoot` for the main window, a `WorkspaceWindow` for every popout. So
 * the question is a reference comparison against `workspace.rootSplit` — two
 * objects the plugin owns, in the plugin's own realm. Not a DOM `instanceof`,
 * which is what would break here.
 */
export function isPoppedOut(app: App, leaf: WorkspaceLeaf): boolean {
  const container = (leaf as unknown as { getContainer?: () => unknown }).getContainer?.();
  if (container === undefined || container === null) return false;
  return container !== (app.workspace as unknown as { rootSplit?: unknown }).rootSplit;
}

/**
 * Bring the window a leaf lives in to the front.
 *
 * `revealLeaf` makes the leaf the visible one inside its own window; on its own
 * that leaves a popout sitting behind the main window, which reads as "the
 * button did nothing". The window itself has to be focused, and it is reached
 * through the leaf rather than through any global — see the realm note above.
 */
export function focusLeafWindow(app: App, leaf: WorkspaceLeaf): void {
  app.workspace.revealLeaf(leaf);
  const container = (
    leaf as unknown as { getContainer?: () => { win?: { focus?: () => void } } }
  ).getContainer?.();
  container?.win?.focus?.();
}

/**
 * Show `file` in its own OS window.
 *
 * Three cases, and the middle one is the whole reason this is not two lines:
 *
 *   - **already in a window of its own** → focus that window. Asking twice must
 *     not produce a third window; it must bring back the one that exists.
 *   - **open in the main window** → *move that pane out* (`moveLeafToPopout`)
 *     rather than opening a second copy. "Pop this out" is a request about the
 *     thing you are looking at, and answering it with a duplicate leaves the
 *     user with two views of one file and no idea which one they typed into.
 *   - **not open at all** → a fresh popout, sized to the screen.
 *
 * An Obsidian too old for popouts is told so and given a tab, because a button
 * that silently does nothing is worse than one that does the lesser thing.
 */
export async function openFileInPopout(app: App, file: TFile): Promise<WorkspaceLeaf | null> {
  const workspace = app.workspace as unknown as {
    openPopoutLeaf?: (data?: PopoutBox) => WorkspaceLeaf;
    moveLeafToPopout?: (leaf: WorkspaceLeaf, data?: PopoutBox) => unknown;
  };
  const box = screenMetrics();
  const existing = findLeafShowingFile(app, file.path);

  if (existing) {
    if (isPoppedOut(app, existing)) {
      focusLeafWindow(app, existing);
      return existing;
    }
    if (typeof workspace.moveLeafToPopout === "function") {
      workspace.moveLeafToPopout(existing, box);
      focusLeafWindow(app, existing);
      return existing;
    }
  }

  if (typeof workspace.openPopoutLeaf !== "function") {
    new Notice("This version of Obsidian cannot open a separate window — opened in a tab instead.");
    return openFileInLeaf(app, file, "tab");
  }

  const leaf = workspace.openPopoutLeaf(box);
  await (leaf as unknown as LeafLike).openFile?.(file);
  focusLeafWindow(app, leaf);
  return leaf;
}

/**
 * Pop a chapter out: the note, the drawing, or **both as two windows**.
 *
 * Two windows rather than one split window for `"both"`, because the ask was
 * about switching between windows — one window containing both artefacts gives
 * macOS nothing to switch to.
 *
 * The book is left where it is, in the main window. That is the arrangement the
 * request describes: the book on one screen, what you are writing on another.
 */
export async function openStudyPopout(
  context: StudyContext,
  chapter: StudyChapter,
  layout: StudyLayout = "note",
): Promise<TFile | null> {
  const kinds: ChapterMaterial[] = layout === "both" ? ["note", "diagram"] : [layout];
  let first: TFile | null = null;
  for (const kind of kinds) {
    const file = await ensureChapterMaterial(context, chapter, kind);
    if (!file) continue;
    await openFileInPopout(context.app, file);
    first ??= file;
  }
  return first;
}

/** Panes or windows — one place to decide, so no caller has to branch. */
export async function runReadRequest(
  context: StudyContext,
  chapter: StudyChapter,
  request: ReadRequest,
): Promise<TFile | null> {
  return request.popout
    ? openStudyPopout(context, chapter, request.layout)
    : openStudySplit(context, chapter, request.layout);
}

// ---------------------------------------------------------------------------
// The shortcut — study without opening the book's screen first
// ---------------------------------------------------------------------------

/**
 * The chapter a row-level shortcut means.
 *
 * The **furthest one indexed**, because a chapter list is built as you read and
 * the last one you added is the one you are in. A book with no chapters at all
 * means chapter 1: reading is the moment notes start, and making somebody go
 * and configure a chapter list before they can take a note is the friction this
 * shortcut exists to remove.
 */
export function currentChapter(entry: ReadingEntry): StudyChapter {
  const chapters = readChapters(entry);
  return chapters[chapters.length - 1] ?? { number: 1 };
}

/**
 * A shortcut's whole job: pick the current chapter, make sure the index knows
 * about it, and open it.
 *
 * `commit` is a callback rather than a store, so this stays as testable as
 * everything else in the file and so the two callers (the table row and the
 * card menu) cannot disagree about what "current chapter" means.
 *
 * `"alone"` is the plain note in a tab — the shortcut for "I just want to look
 * at what I wrote", which does not want a book beside it.
 */
export async function openStudyShortcut(
  context: StudyContext,
  commit: (patch: ReadingPatch) => void,
  layout: StudyLayout | "alone" = "note",
  popout = false,
): Promise<TFile | null> {
  const chapters = readChapters(context.entry);
  const chapter = currentChapter(context.entry);
  if (!chapters.some((c) => c.number === chapter.number)) {
    commit(adoptChapterPatch(context.entry, chapter.number, chapter.name ?? ""));
  }
  if (layout === "alone") {
    const file = await ensureChapterMaterial(context, chapter, "note");
    if (!file) return null;
    if (popout) await openFileInPopout(context.app, file);
    else await openFileInLeaf(context.app, file, "tab");
    return file;
  }
  return runReadRequest(context, chapter, { layout, popout });
}

/** What an action did, in a sentence the user can be shown verbatim. */
export interface StudyOutcome {
  ok: boolean;
  /** Always shown to the user; always names the file that was acted on. */
  message: string;
  path?: string;
}

export interface InsertPageOutcome extends StudyOutcome {
  page?: number;
}

/**
 * Drop the page currently on screen into a chapter note, as a live reference.
 *
 * The three refusals are all "say what is missing", never a silent no-op, and
 * the success message names the *note* as well as the page — writing into the
 * wrong note without saying so is the one failure mode this action could have.
 */
export async function insertCurrentPage(
  context: StudyContext,
  chapter: StudyChapter,
  target?: TFile,
): Promise<InsertPageOutcome> {
  const { app, entry, settings, reading } = context;
  const book = (entry.filePath ?? "").trim();
  if (book === "") {
    return { ok: false, message: `«${entry.title}» has no linked file, so there is no page to embed.` };
  }
  const page = currentPageOf(openPdfPages(app), book);
  if (page === null) {
    return { ok: false, message: `Open ${book} first — nothing is showing a page to embed.` };
  }

  const file =
    target ??
    (resolveChapterFile(app, entry, chapter, "note", settings, reading) ||
      (await ensureFile(
        app,
        chapterNotePath(entry, chapter, settings, reading),
        () => chapterNoteTemplate(entry, chapter, page),
      )));
  if (!file) {
    return { ok: false, message: `Could not open a note for ${chapterLabel(chapter)}.` };
  }

  try {
    await appendToFile(app, file, pageEmbedBlock(book, page, entry.title));
  } catch (err) {
    return { ok: false, message: `Could not write to ${file.path} — ${message(err)}` };
  }
  return {
    ok: true,
    message: `Page ${page} embedded in ${chapterLabel(chapter)}.`,
    path: file.path,
    page,
  };
}

/**
 * The palette command's half: work out which chapter note is on screen, then do
 * exactly what the button does.
 *
 * The match is by *path* — the file has to live in a book's study folder and
 * claim a chapter number — rather than by frontmatter, so a note whose
 * frontmatter the user rewrote still works. A file that matches nothing is told
 * so; it is never guessed at.
 */
export async function insertCurrentPageIntoActiveNote(
  app: App,
  entries: readonly ReadingEntry[],
  settings: Settings,
  reading: ReadingData,
): Promise<InsertPageOutcome> {
  const active = app.workspace.getActiveFile();
  if (!active) return { ok: false, message: "Open a chapter note first." };

  const found = chapterOfFile(active.path, entries, settings, reading);
  if (!found) {
    return { ok: false, message: `${active.path} is not a chapter note of a tracked book.` };
  }
  return insertCurrentPage(
    { app, entry: found.entry, settings, reading },
    found.chapter,
    active,
  );
}

/**
 * The palette's window command: pop the chapter you are looking at out.
 *
 * Same path-based match as the page-embed command, so it works from a chapter
 * note *or* from its drawing, and a file that belongs to no tracked book is
 * told so rather than guessed at.
 *
 * The `"both"` layout is what the ask was actually about — two windows, one for
 * the note and one for the drawing, so there is something for macOS to switch
 * *between*.
 */
export async function popOutActiveChapterMaterial(
  app: App,
  entries: readonly ReadingEntry[],
  settings: Settings,
  reading: ReadingData,
  layout: StudyLayout = "note",
): Promise<StudyOutcome> {
  const active = app.workspace.getActiveFile();
  if (!active) return { ok: false, message: "Open a chapter note or drawing first." };

  const found = chapterOfFile(active.path, entries, settings, reading);
  if (!found) {
    return { ok: false, message: `${active.path} is not a chapter note of a tracked book.` };
  }

  const file = await openStudyPopout(
    { app, entry: found.entry, settings, reading },
    found.chapter,
    layout,
  );
  if (!file) {
    return { ok: false, message: `Nothing to pop out for ${chapterLabel(found.chapter)}.` };
  }
  const what = layout === "both" ? "note and drawing" : layout === "diagram" ? "drawing" : "note";
  return {
    ok: true,
    message: `${chapterLabel(found.chapter)} — ${what} in ${layout === "both" ? "their own windows" : "a window of its own"}.`,
    path: file.path,
  };
}

/**
 * Which book and chapter a vault path belongs to — pure, and therefore the
 * piece the tests can hold still while everything around it needs a workspace.
 */
export function chapterOfFile(
  path: string,
  entries: readonly ReadingEntry[],
  settings: Settings,
  reading: ReadingData,
): { entry: ReadingEntry; chapter: StudyChapter } | null {
  const normalized = normalizePath(path);
  for (const entry of entries) {
    const folder = `${normalizePath(studyFolderFor(entry, settings, reading))}/`;
    if (!normalized.startsWith(folder)) continue;
    const name = normalized.slice(folder.length);
    if (name.includes("/")) continue;
    const claim = chapterFileClaim(name);
    if (!claim) continue;
    const indexed = readChapters(entry).find((c) => c.number === claim.number);
    return { entry, chapter: indexed ?? { number: claim.number } };
  }
  return null;
}
