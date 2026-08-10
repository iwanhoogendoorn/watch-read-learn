/**
 * Per-game markdown notes (SPEC2-PARITY.md §D-GAMES; `report-watchlog.md` §1.5).
 *
 * The same contract the watchlist's notes have: `data.json` is the record, the
 * note is a mirror the user can link to and annotate, the frontmatter is
 * regenerated on every save, and **everything the user wrote below it survives
 * untouched**.
 *
 * One difference from titles, and it is deliberate: `Game` has no `notes` field
 * in the v3 shape, so nothing flows back from the file. The `## Notes` heading is
 * created once on a new note and then never rewritten — the section is entirely
 * the user's. Regenerating it from an empty string would quietly erase whatever
 * they had typed there.
 *
 * Everything above `GameNoteWriter` is pure and tested without a vault.
 */
import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { sanitizeFileName, splitFrontmatter } from "../../data/notes";
import type { Game, GamesSettings } from "../../types";
import { achievementText, formatPlaytime, gameProgress } from "./stats";

const NOTES_HEADING = "## Notes";

/** `Watch, Read and Learn/Games/Hades.md` — v3's `vaultPage`, rebuilt from settings. */
export function gameNotePath(settings: GamesSettings, game: Game): string {
  const folder = settings.defaultFolder.replace(/\/+$/, "");
  const name = sanitizeFileName(game.title) || "Untitled";
  return folder === "" ? `${name}.md` : `${folder}/${name}.md`;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlLine(key: string, value: string | number | boolean): string {
  return typeof value === "string" ? `${key}: ${yamlString(value)}` : `${key}: ${String(value)}`;
}

function yamlList(key: string, values: readonly string[]): string {
  const items = values.filter((value) => value.trim() !== "");
  if (items.length === 0) return "";
  return [`${key}:`, ...items.map((value) => `  - ${yamlString(value)}`)].join("\n");
}

/**
 * The frontmatter block.
 *
 * Optional keys are omitted rather than written empty — an `achievements: ""` in
 * every note is noise, and Obsidian's property UI shows it as a dangling field.
 */
export function buildGameFrontmatter(game: Game): string {
  const lines: string[] = [yamlLine("title", game.title)];

  if (game.type) lines.push(yamlLine("genre", game.type));
  lines.push(yamlLine("status", game.status));
  if (game.priority) lines.push(yamlLine("priority", game.priority));
  lines.push(yamlLine("rating", game.rating));
  lines.push(yamlLine("progress", `${gameProgress(game)}%`));
  if (game.playtimeMinutes > 0) {
    lines.push(yamlLine("playtime", formatPlaytime(game.playtimeMinutes)));
    lines.push(yamlLine("playtimeMinutes", game.playtimeMinutes));
  }
  const achievements = achievementText(game);
  if (achievements) lines.push(yamlLine("achievements", achievements));

  const platforms = yamlList("platforms", game.platforms ?? []);
  if (platforms) lines.push(platforms);

  const modes = [
    game.singleplayer ? "Singleplayer" : "",
    game.coop ? "Co-op" : "",
    game.multiplayer ? "Multiplayer" : "",
  ].filter((mode) => mode !== "");
  const modeList = yamlList("modes", modes);
  if (modeList) lines.push(modeList);

  if (game.developer) lines.push(yamlLine("developer", game.developer));
  if (game.publisher) lines.push(yamlLine("publisher", game.publisher));
  if (game.wishlist) lines.push(yamlLine("wishlist", true));
  if (game.favorite) lines.push(yamlLine("favorite", true));
  if (game.releaseDate) lines.push(yamlLine("releaseDate", game.releaseDate));
  if (game.dateStarted) lines.push(yamlLine("dateStarted", game.dateStarted));
  if (game.dateFinished) lines.push(yamlLine("dateFinished", game.dateFinished));
  if (game.lastPlayed) lines.push(yamlLine("lastPlayed", game.lastPlayed));
  lines.push(yamlLine("dateAdded", game.dateAdded));
  lines.push(yamlLine("dateModified", game.dateModified));
  if (game.coverUrl) lines.push(yamlLine("cover", game.coverUrl));
  if (game.storeUrl) lines.push(yamlLine("storeUrl", game.storeUrl));
  if (game.externalLink) lines.push(yamlLine("externalLink", game.externalLink));

  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * The full note contents.
 *
 * A new note gets an empty `## Notes` section to write into; an existing one
 * keeps its body byte for byte, heading or no heading.
 */
export function composeGameNote(existing: string | undefined, game: Game): string {
  const frontmatter = buildGameFrontmatter(game);
  if (existing === undefined) return `${frontmatter}\n${NOTES_HEADING}\n\n`;
  const body = splitFrontmatter(existing).body.replace(/^[\r\n]+/, "");
  return `${frontmatter}\n${body}`;
}

// ---------------------------------------------------------------------------
// The vault side
// ---------------------------------------------------------------------------

export class GameNoteWriter {
  private app: App;
  /** Previous path per game id, so a rename moves rather than duplicates. */
  private lastPathById = new Map<string, string>();

  constructor(app: App) {
    this.app = app;
  }

  pathFor(game: Game, settings: GamesSettings): string {
    return normalizePath(gameNotePath(settings, game));
  }

  /**
   * Create or update a game's note. Never throws at the caller: the store is the
   * record, and a vault that refuses a write must not cost the user their edit.
   */
  async sync(game: Game, settings: GamesSettings, enabled: boolean): Promise<string> {
    const path = this.pathFor(game, settings);
    if (!enabled) return path;
    try {
      await this.rename(game, settings);
      const existing = await this.readIfPresent(path);
      const next = composeGameNote(existing, game);
      if (existing !== next) await this.write(path, next, existing !== undefined);
      this.lastPathById.set(game.id, path);
    } catch (err) {
      console.error(`[wrl] could not write the note for «${game.title}»`, err);
    }
    return path;
  }

  /** Move the note when a game was renamed. A note that moved is left alone. */
  async rename(game: Game, settings: GamesSettings): Promise<void> {
    const from = this.lastPathById.get(game.id);
    const to = this.pathFor(game, settings);
    if (!from || from === to) return;
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) {
      this.lastPathById.set(game.id, to);
      return;
    }
    try {
      await this.ensureFolder(to);
      await this.app.fileManager.renameFile(file, to);
      this.lastPathById.set(game.id, to);
    } catch (err) {
      console.error(`[wrl] could not move the note for «${game.title}»`, err);
    }
  }

  remember(game: Game, settings: GamesSettings): void {
    this.lastPathById.set(game.id, this.pathFor(game, settings));
  }

  forget(gameId: string): void {
    this.lastPathById.delete(gameId);
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
