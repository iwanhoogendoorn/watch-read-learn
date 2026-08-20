/**
 * Per-title markdown notes (SPEC D7, §4.6; `report-watchlog.md` §1.5).
 *
 * `data.json` stays the source of truth for titles. The note is a **mirror** the
 * user can link to, search and annotate, with exactly one part flowing the other
 * way:
 *
 *   - the note lives at `${rootFolder}/${type}/${title}.md`, with the characters
 *     Obsidian rejects (`* " \ / < > : | ?`) replaced by `-`;
 *   - the frontmatter is regenerated from the title record on every sync;
 *   - `## Notes` is the ONLY section read back, and everything the user writes
 *     anywhere else in the file survives regeneration untouched;
 *   - renaming a title (or changing its type) moves the note rather than
 *     leaving a duplicate behind;
 *   - all of it is skipped while `settings.generateNotes` is false.
 *
 * Note failures never block `data.json`: the store is the record, this is the
 * mirror, and a vault that refuses a write must not cost the user their rating.
 * Everything above `NoteWriter` is pure, so the formatting is unit-tested
 * without a vault.
 */
import { TFile, TFolder, normalizePath, type App } from "obsidian";
import type { Settings, TitleV4 } from "../types";
import { getProgress } from "./episodes";

/** Characters Obsidian will not accept in a file name. */
const ILLEGAL_PATH_CHARS = /[*"\\/<>:|?]/g;

/** The one section the plugin owns *and* reads back. */
const NOTES_HEADING = "## Notes";

export function sanitizeFileName(name: string): string {
  return name.replace(ILLEGAL_PATH_CHARS, "-").trim();
}

export function notePathFor(settings: Settings, title: TitleV4): string {
  const folder = [settings.rootFolder, sanitizeFileName(title.type)].filter(Boolean).join("/");
  return `${folder}/${sanitizeFileName(title.title)}.md`;
}

// ---------------------------------------------------------------------------
// Pure: YAML frontmatter
// ---------------------------------------------------------------------------

/** A YAML scalar that survives every character a title can contain. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlLine(key: string, value: string | number | boolean): string {
  if (typeof value === "string") return `${key}: ${yamlString(value)}`;
  return `${key}: ${String(value)}`;
}

function yamlList(key: string, values: readonly string[]): string {
  const items = values.filter((v) => v.trim() !== "");
  if (items.length === 0) return "";
  return [`${key}:`, ...items.map((v) => `  - ${yamlString(v)}`)].join("\n");
}

/**
 * The frontmatter block, keys and order following v3 so an existing vault's
 * notes do not churn on the first v4 save (`report-watchlog.md` §1.5).
 *
 * Optional keys are omitted rather than written empty — an empty `trailer:` in
 * every note is noise, and Obsidian's property UI shows it as a dangling field.
 */
export function buildFrontmatter(title: TitleV4): string {
  const lines: string[] = [
    yamlLine("title", title.title),
    yamlLine("type", title.type),
    yamlLine("status", title.status),
  ];

  if (title.priority) lines.push(yamlLine("priority", title.priority));
  if (title.review) lines.push(yamlLine("review", title.review));
  if (title.watchedVia) lines.push(yamlLine("watchedVia", title.watchedVia));
  lines.push(yamlLine("rating", title.rating));
  lines.push(yamlLine("progress", `${getProgress(title)}%`));
  lines.push(yamlLine("totalEpisodes", title.totalEpisodes));
  lines.push(yamlLine("episodeDuration", title.episodeDuration));
  if (title.dateStarted) lines.push(yamlLine("dateStarted", title.dateStarted));
  if (title.dateFinished) lines.push(yamlLine("dateFinished", title.dateFinished));
  lines.push(yamlLine("dateAdded", title.dateAdded));
  lines.push(yamlLine("dateModified", title.dateModified));
  if (title.releaseDate) lines.push(yamlLine("releaseDate", title.releaseDate));
  if (title.malId) lines.push(yamlLine("malId", title.malId));
  if (title.anilistId) lines.push(yamlLine("anilistId", title.anilistId));
  if (title.communityRating > 0) lines.push(yamlLine("communityRating", title.communityRating));
  if (title.communityVotes > 0) lines.push(yamlLine("communityVotes", title.communityVotes));
  if (title.communitySource) lines.push(yamlLine("communitySource", title.communitySource));

  const director = yamlList("director", title.manualDirector.length ? title.manualDirector : title.director);
  if (director) lines.push(director);
  const cast = yamlList("cast", title.manualCast.length ? title.manualCast : title.cast);
  if (cast) lines.push(cast);
  const studio = yamlList("studio", title.manualStudio.length ? title.manualStudio : title.studio);
  if (studio) lines.push(studio);
  const tags = yamlList("tags", title.tags);
  if (tags) lines.push(tags);

  const poster = title.manualPosterUrl.trim() || title.posterUrl.trim();
  if (poster) lines.push(yamlLine("poster", poster));
  const trailer = title.manualTrailerUrl.trim() || title.trailerUrl.trim();
  if (trailer) lines.push(yamlLine("trailer", trailer));
  if (title.externalLink) lines.push(yamlLine("externalLink", title.externalLink));
  if (title.pinned) lines.push(yamlLine("pinned", true));
  if (title.favorite) lines.push(yamlLine("favorite", true));

  return `---\n${lines.join("\n")}\n---\n`;
}

// ---------------------------------------------------------------------------
// Pure: body surgery
// ---------------------------------------------------------------------------

/** Split an existing note into its frontmatter block and everything after it. */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[0], body: content.slice(match[0].length) };
}

/**
 * The text of the `## Notes` section, or `undefined` when the note has none.
 *
 * The section ends at the next heading of level 1 or 2, so a `### Episode 4`
 * the user wrote inside their notes stays part of them.
 */
export function readNotesSection(content: string): string | undefined {
  const { body } = splitFrontmatter(content);
  const start = /^##[ \t]+Notes[ \t]*$/m.exec(body);
  if (!start || start.index === undefined) return undefined;
  const after = body.slice(start.index + start[0].length);
  const end = /^#{1,2}[ \t]+\S/m.exec(after);
  const section = end ? after.slice(0, end.index) : after;
  return section.replace(/^[\r\n]+/, "").trimEnd();
}

/** Replace the `## Notes` section's text, appending the section when missing. */
export function upsertNotesSection(body: string, notes: string): string {
  const text = notes.trimEnd();
  const start = /^##[ \t]+Notes[ \t]*$/m.exec(body);
  if (!start || start.index === undefined) {
    const prefix = body.trimEnd();
    const head = prefix === "" ? "" : `${prefix}\n\n`;
    return `${head}${NOTES_HEADING}\n\n${text}\n`;
  }
  const before = body.slice(0, start.index + start[0].length);
  const after = body.slice(start.index + start[0].length);
  const end = /^#{1,2}[ \t]+\S/m.exec(after);
  const tail = end ? after.slice(end.index) : "";
  return `${before}\n\n${text}\n${tail === "" ? "" : `\n${tail}`}`;
}

/**
 * The full note contents for a title, preserving everything in `existing` that
 * the plugin does not own.
 */
export function composeNote(existing: string | undefined, title: TitleV4): string {
  // Leading blank lines are ours (the gap under the frontmatter), so they are
  // dropped before being re-added — otherwise every regeneration grows one.
  const body =
    existing === undefined ? "" : splitFrontmatter(existing).body.replace(/^[\r\n]+/, "");
  return `${buildFrontmatter(title)}\n${upsertNotesSection(body, title.notes)}`;
}

// ---------------------------------------------------------------------------
// The vault side
// ---------------------------------------------------------------------------

export class NoteWriter {
  private app: App;
  /** Previous path per title id, so renames move rather than duplicate. */
  private lastPathById = new Map<string, string>();
  /** Paths this writer is mid-write on, so its own `modify` events are ignored. */
  private writing = new Set<string>();

  constructor(app: App) {
    this.app = app;
  }

  /** Where this title's note belongs right now. */
  pathFor(title: TitleV4, settings: Settings): string {
    return normalizePath(notePathFor(settings, title));
  }

  /** True while we are the one writing that path — the read-back's echo guard. */
  isOwnWrite(path: string): boolean {
    return this.writing.has(normalizePath(path));
  }

  /** The title a note path belongs to, for the read-back listener. */
  titleIdForPath(path: string): string | undefined {
    const wanted = normalizePath(path);
    for (const [id, known] of this.lastPathById) {
      if (known === wanted) return id;
    }
    return undefined;
  }

  /**
   * Create or update the note for a title, moving it first when the title was
   * renamed or re-typed. Never throws at the caller.
   */
  async sync(title: TitleV4, settings: Settings): Promise<void> {
    if (!settings.generateNotes) return;
    const path = this.pathFor(title, settings);
    try {
      await this.rename(title, settings);
      const existing = await this.readIfPresent(path);
      const next = composeNote(existing, title);
      if (existing === next) {
        this.lastPathById.set(title.id, path);
        return;
      }
      await this.write(path, next, existing !== undefined);
      this.lastPathById.set(title.id, path);
    } catch (err) {
      console.error(`[wrl] could not write the note for «${title.title}»`, err);
    }
  }

  /** Read the `## Notes` section back, for the note → `title.notes` direction. */
  async readNotes(title: TitleV4, settings: Settings): Promise<string | undefined> {
    if (!settings.generateNotes) return undefined;
    const path = this.pathFor(title, settings);
    try {
      const existing = await this.readIfPresent(path);
      if (existing === undefined) return undefined;
      return readNotesSection(existing);
    } catch (err) {
      console.warn(`[wrl] could not read the note for «${title.title}»`, err);
      return undefined;
    }
  }

  /**
   * Move the note when a title's name or type changed.
   *
   * The old path comes from `lastPathById`; a note that is not where we left it
   * (the user moved it themselves) is left alone rather than chased.
   */
  async rename(title: TitleV4, settings: Settings): Promise<void> {
    if (!settings.generateNotes) return;
    const from = this.lastPathById.get(title.id);
    const to = this.pathFor(title, settings);
    if (!from || from === to) return;

    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) {
      this.lastPathById.set(title.id, to);
      return;
    }
    try {
      await this.ensureFolder(to);
      this.writing.add(to);
      await this.app.fileManager.renameFile(file, to);
      this.lastPathById.set(title.id, to);
    } catch (err) {
      console.error(`[wrl] could not move the note for «${title.title}»`, err);
    } finally {
      this.writing.delete(to);
    }
  }

  /** Remember where a title's note is without touching the vault. */
  remember(title: TitleV4, settings: Settings): void {
    this.lastPathById.set(title.id, this.pathFor(title, settings));
  }

  forget(titleId: string): void {
    this.lastPathById.delete(titleId);
  }

  // --- vault plumbing ------------------------------------------------------

  private async readIfPresent(path: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    return this.app.vault.read(file);
  }

  private async write(path: string, contents: string, exists: boolean): Promise<void> {
    this.writing.add(path);
    try {
      if (exists) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, contents);
          return;
        }
      }
      await this.ensureFolder(path);
      await this.app.vault.create(path, contents);
    } finally {
      // One tick, so the vault's own `modify` event has been delivered before
      // the read-back listener is allowed to believe it.
      setTimeout(() => this.writing.delete(path), 0);
    }
  }

  /** Create the note's folder chain. A folder that already exists is fine. */
  private async ensureFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent === "" || parent === path) return;
    const parts = parent.split("/");
    let current = "";
    for (const part of parts) {
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
