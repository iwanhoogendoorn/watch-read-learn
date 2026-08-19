/**
 * A markdown note per book and per manga (`report-watchlog.md` §1.5).
 *
 * Same contract as the title notes in `data/notes.ts`, and the pure helpers are
 * imported from there rather than rewritten — `data.json` is the record, the
 * note is a **mirror** whose frontmatter is regenerated on every save and whose
 * prose the plugin never touches.
 *
 * Two differences from a title note, both from v3:
 *
 *   - a book gets a **`## Quotes`** section alongside `## Notes`, because that
 *     is what a book note is for;
 *   - nothing is read back. A `Book` has no notes field to read into — v3's
 *     shape simply has no such column — so the sections are *ensured* and then
 *     left alone forever. That is stronger than "read back carefully": there is
 *     no path by which regenerating a note can lose a word the user wrote.
 *
 * Note failures never block a save: the store has already written, and a vault
 * that refuses a file must not cost the user their rating.
 */
import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { sanitizeFileName, splitFrontmatter } from "../../data/notes";
import type { ReadingData, ReadingKind, Settings } from "../../types";
import { coverSourceUrl } from "./covers";
import { derivedStatus, isBook, readingProgress, volumeCounter, type ReadingEntry } from "./progress";

export const NOTES_HEADING = "## Notes";
export const QUOTES_HEADING = "## Quotes";

/** Where reading notes live when `reading.settings.defaultFolder` is blank. */
export function defaultReadingFolder(settings: Settings): string {
  return [settings.rootFolder, "Reading"].filter(Boolean).join("/");
}

export function readingFolderFor(settings: Settings, reading: ReadingData): string {
  const configured = (reading.settings.defaultFolder ?? "").trim();
  return configured === "" ? defaultReadingFolder(settings) : configured;
}

/**
 * The note path for an entry.
 *
 * Flat inside the reading folder, exactly as v3 wrote it (`vaultPage` in a real
 * vault reads `Watch, Read and Learn/Reading/Dune.md`), so an upgraded vault keeps its links.
 * A book and a manga with the identical name would therefore share a file —
 * v3's behaviour, and the alternative moves every existing note.
 */
export function readingNotePath(
  entry: ReadingEntry,
  settings: Settings,
  reading: ReadingData,
): string {
  const folder = readingFolderFor(settings, reading);
  return `${folder}/${sanitizeFileName(entry.title || entry.id)}.md`;
}

// ---------------------------------------------------------------------------
// Pure: frontmatter and body
// ---------------------------------------------------------------------------

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlLine(key: string, value: string | number | boolean): string {
  if (typeof value === "string") return `${key}: ${yamlString(value)}`;
  return `${key}: ${String(value)}`;
}

/**
 * The YAML block, keys following v3's reading notes.
 *
 * Optional keys are omitted rather than written empty — a dangling `malId:` in
 * every note is noise in Obsidian's property view. Custom columns are written
 * under their **name**, since the id (`col-1`) means nothing in a note.
 */
export function buildReadingFrontmatter(
  entry: ReadingEntry,
  kind: ReadingKind,
  reading: ReadingData,
  now: Date = new Date(),
): string {
  const columns = kind === "book" ? reading.bookColumns : reading.mangaColumns;
  const lines: string[] = [
    yamlLine("title", entry.title),
    yamlLine("type", kind === "book" ? "Book" : "Manga"),
  ];
  if (entry.author) lines.push(yamlLine("author", entry.author));
  lines.push(yamlLine("status", derivedStatus(entry, now)));
  lines.push(yamlLine("rating", entry.rating));
  lines.push(yamlLine("progress", `${readingProgress(entry)}%`));

  if (isBook(entry)) {
    lines.push(yamlLine("progressUnit", entry.progressUnit));
    if (entry.totalPages > 0 || entry.pagesRead > 0) {
      lines.push(yamlLine("pagesRead", entry.pagesRead));
      lines.push(yamlLine("totalPages", entry.totalPages));
    }
    if (entry.totalWords > 0 || entry.wordsRead > 0) {
      lines.push(yamlLine("wordsRead", entry.wordsRead));
      lines.push(yamlLine("totalWords", entry.totalWords));
    }
    if (entry.totalChapters > 0 || entry.chaptersRead > 0) {
      lines.push(yamlLine("chaptersRead", entry.chaptersRead));
      lines.push(yamlLine("totalChapters", entry.totalChapters));
    }
    if (entry.googleBooksId) lines.push(yamlLine("googleBooksId", entry.googleBooksId));
  } else {
    lines.push(yamlLine("chaptersRead", entry.chaptersRead));
    lines.push(yamlLine("totalChapters", entry.totalChapters));
    const volumes = volumeCounter(entry);
    if (volumes.total > 0 || volumes.read > 0) {
      lines.push(yamlLine("volumesRead", entry.volumesRead));
      lines.push(yamlLine("totalVolumes", entry.totalVolumes));
    }
    if (entry.malId) lines.push(yamlLine("malId", entry.malId));
  }

  if (entry.dateStarted) lines.push(yamlLine("dateStarted", entry.dateStarted));
  if (entry.dateFinished) lines.push(yamlLine("dateFinished", entry.dateFinished));
  lines.push(yamlLine("dateAdded", entry.dateAdded));
  lines.push(yamlLine("dateModified", entry.dateModified));
  if (entry.releaseDate) lines.push(yamlLine("releaseDate", entry.releaseDate));
  // The cover the book actually shows, which is the hand-set one when there is
  // one — a note that quotes the catalogue URL for a book displaying the user's
  // own picture is a note describing a different book.
  const cover = coverSourceUrl(entry);
  if (cover) lines.push(yamlLine("cover", cover));
  if (entry.filePath) lines.push(yamlLine("file", `[[${entry.filePath}]]`));
  if (entry.externalLink) lines.push(yamlLine("externalLink", entry.externalLink));
  if (entry.favorite) lines.push(yamlLine("favorite", true));

  for (const column of columns) {
    const value = entry.customFields?.[column.id];
    if (value === undefined || value === null || value === "") continue;
    const key = column.name.trim();
    if (key === "") continue;
    lines.push(
      typeof value === "number" || typeof value === "boolean"
        ? yamlLine(key, value)
        : yamlLine(key, String(value)),
    );
  }

  return `---\n${lines.join("\n")}\n---\n`;
}

/** Append a heading if the body does not already have one at level 1 or 2. */
export function ensureHeading(body: string, heading: string): string {
  const name = heading.replace(/^#+\s*/, "");
  const present = new RegExp(`^#{1,2}[ \\t]+${name}[ \\t]*$`, "m").test(body);
  if (present) return body;
  const trimmed = body.trimEnd();
  return trimmed === "" ? `${heading}\n` : `${trimmed}\n\n${heading}\n`;
}

/**
 * The full contents for an entry's note, preserving everything the plugin does
 * not own. Only the frontmatter is rewritten; the body is carried through.
 */
export function composeReadingNote(
  existing: string | undefined,
  entry: ReadingEntry,
  kind: ReadingKind,
  reading: ReadingData,
  now: Date = new Date(),
): string {
  const body =
    existing === undefined ? "" : splitFrontmatter(existing).body.replace(/^[\r\n]+/, "");
  let next = ensureHeading(body, NOTES_HEADING);
  // Quotes are a books thing in v3; a manga note stays lean.
  if (kind === "book") next = ensureHeading(next, QUOTES_HEADING);
  return `${buildReadingFrontmatter(entry, kind, reading, now)}\n${next}`;
}

// ---------------------------------------------------------------------------
// The vault side
// ---------------------------------------------------------------------------

export class ReadingNoteWriter {
  private app: App;
  /** Previous path per entry id, so a rename moves the note rather than forking it. */
  private lastPathById = new Map<string, string>();

  constructor(app: App) {
    this.app = app;
  }

  pathFor(entry: ReadingEntry, settings: Settings, reading: ReadingData): string {
    return normalizePath(readingNotePath(entry, settings, reading));
  }

  /** Remember where a note is without touching the vault (startup). */
  remember(entry: ReadingEntry, settings: Settings, reading: ReadingData): void {
    const known = (entry.vaultPage ?? "").trim();
    this.lastPathById.set(entry.id, known === "" ? this.pathFor(entry, settings, reading) : normalizePath(known));
  }

  forget(id: string): void {
    this.lastPathById.delete(id);
  }

  /**
   * Create or update the note, moving it first when the entry was renamed.
   *
   * Returns the path it now lives at, so the caller can keep `vaultPage`
   * truthful — or `undefined` when nothing was written (notes off, or the vault
   * refused), which is deliberately not an error.
   */
  async sync(
    entry: ReadingEntry,
    kind: ReadingKind,
    settings: Settings,
    reading: ReadingData,
  ): Promise<string | undefined> {
    if (!settings.generateReadingNotes) return undefined;
    const path = this.pathFor(entry, settings, reading);
    try {
      await this.rename(entry, path);
      const existing = await this.readIfPresent(path);
      const next = composeReadingNote(existing, entry, kind, reading);
      if (existing !== next) await this.write(path, next, existing !== undefined);
      this.lastPathById.set(entry.id, path);
      return path;
    } catch (err) {
      console.error(`[wrl] could not write the note for «${entry.title}»`, err);
      return undefined;
    }
  }

  /** Move the note when the title changed. A note the user moved is left alone. */
  private async rename(entry: ReadingEntry, to: string): Promise<void> {
    const from = this.lastPathById.get(entry.id);
    if (!from || from === to) return;
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) {
      this.lastPathById.set(entry.id, to);
      return;
    }
    await this.ensureFolder(to);
    await this.app.fileManager.renameFile(file, to);
    this.lastPathById.set(entry.id, to);
  }

  private async readIfPresent(path: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    return this.app.vault.read(file);
  }

  private async write(path: string, contents: string, exists: boolean): Promise<void> {
    if (exists) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, contents);
        return;
      }
    }
    await this.ensureFolder(path);
    await this.app.vault.create(path, contents);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent === "" || parent === path) return;
    let current = "";
    for (const part of parent.split("/")) {
      current = current === "" ? part : `${current}/${part}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) return; // a *file* sits where the folder should be
      try {
        await this.app.vault.createFolder(current);
      } catch {
        // Concurrent syncs race here; the folder existing is the outcome we want.
      }
    }
  }
}
