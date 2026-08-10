/**
 * First-run adoption of a previous install's `data.json`.
 *
 * The plugin's id changed with the rename (`watchlog` → `watch-read-learn`),
 * and Obsidian keys a plugin's data folder off its id. A rename therefore
 * looks exactly like a fresh install: a new folder, no data, an empty library
 * where someone's collection used to be. This module finds the old folder and
 * offers to bring the file across.
 *
 * Three rules it does not bend:
 *
 *   - **read-only at the source.** The old folder is never written to, never
 *     moved, never cleaned up. If adoption goes wrong, the original install is
 *     still sitting there, intact, and can simply be re-enabled.
 *   - **only when we are certain we are empty.** Adoption is offered only when
 *     our own `data.json` is *known* to be absent. An adapter that cannot
 *     answer ("unknown") is treated as "there might be data" and we do nothing
 *     — the same fail-closed stance the v3 backup gate takes.
 *   - **the user decides.** Copying someone's library between folders is not a
 *     thing to do silently, so the caller prompts. Declining writes an empty
 *     file, which is what stops the question being asked again forever.
 *
 * The scan is ordered: the most recently used install wins, because someone who
 * has been testing `watchlog-v4` wants *that* library, not the v3 one they
 * abandoned months ago.
 */
import type { DataAdapter } from "obsidian";
import { DATA_FILE } from "../constants";

/**
 * Folders to look in, best first, relative to the plugins directory.
 *
 * Ordered by how likely the data is to be current, not alphabetically: the v4
 * test install was the live one immediately before the rename.
 */
export const ADOPTION_CANDIDATES: readonly string[] = ["watchlog-v4", "watchlog"];

/** What one candidate folder turned out to hold. */
export interface AdoptionCandidate {
  /** Plugin folder name, e.g. `watchlog-v4`. */
  folder: string;
  /** Full in-vault path of the file we would copy. */
  path: string;
  /** Raw file contents, kept so adoption never re-reads (and never re-races). */
  raw: string;
  /** Human counts for the prompt. Zero everywhere means "recognisable but empty". */
  counts: AdoptionCounts;
}

export interface AdoptionCounts {
  titles: number;
  books: number;
  manga: number;
  games: number;
  lists: number;
}

export function totalItems(counts: AdoptionCounts): number {
  return counts.titles + counts.books + counts.manga + counts.games + counts.lists;
}

/**
 * Count what a candidate holds, without trusting any of its shapes.
 *
 * Returns null when the file is not one of ours at all — a JSON document with
 * none of our top-level keys is somebody else's plugin data, and offering to
 * import it would be a great way to destroy something.
 */
export function countAdoptable(raw: string): AdoptionCounts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = parsed as Record<string, unknown>;

  // Our fingerprint: a titles array, or a reading/games block, or a schema
  // version. v3 and v4 files both satisfy this; a stray settings blob does not.
  const looksOurs =
    Array.isArray(data.titles) ||
    isRecord(data.reading) ||
    isRecord(data.games) ||
    typeof data.schemaVersion === "number";
  if (!looksOurs) return null;

  const reading = isRecord(data.reading) ? data.reading : {};
  const games = isRecord(data.games) ? data.games : {};
  return {
    titles: arrayLength(data.titles),
    books: arrayLength(reading.books),
    manga: arrayLength(reading.manga),
    games: arrayLength(games.games),
    lists: arrayLength(data.customLists),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Turn a plugin folder path into its parent plugins directory.
 *
 * `manifest.dir` is `.obsidian/plugins/<id>`; everything we scan is a sibling
 * of it. Returns null for anything that is not shaped like that, because
 * guessing at a path we are about to read from is how you read the wrong file.
 */
export function pluginsDirOf(manifestDir: string): string | null {
  const trimmed = manifestDir.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 0) return null;
  return trimmed.slice(0, cut);
}

export interface AdoptionScan {
  /** Best candidate, or null when there is nothing worth offering. */
  candidate: AdoptionCandidate | null;
  /** Every readable candidate, best first — the prompt names the alternatives. */
  all: AdoptionCandidate[];
}

/**
 * Look for a previous install worth adopting.
 *
 * Only ever called once our own data is known to be absent. Unreadable or
 * unrecognisable candidates are skipped in silence: a folder that is not ours
 * is not an error, it is just not interesting.
 */
export async function scanForAdoptable(
  adapter: DataAdapter,
  manifestDir: string,
  ownFolder: string,
  candidates: readonly string[] = ADOPTION_CANDIDATES,
): Promise<AdoptionScan> {
  const plugins = pluginsDirOf(manifestDir);
  if (plugins === null) return { candidate: null, all: [] };

  const found: AdoptionCandidate[] = [];
  for (const folder of candidates) {
    if (folder === ownFolder) continue; // never adopt from ourselves
    const path = `${plugins}/${folder}/${DATA_FILE}`;
    let raw: string;
    try {
      if (!(await adapter.exists(path))) continue;
      raw = await adapter.read(path);
    } catch {
      continue;
    }
    const counts = countAdoptable(raw);
    if (counts === null) continue;
    found.push({ folder, path, raw, counts });
  }

  // An empty-but-valid file is a real answer ("I had nothing"), but a populated
  // one always wins regardless of scan order.
  const populated = found.filter((c) => totalItems(c.counts) > 0);
  return { candidate: populated[0] ?? found[0] ?? null, all: found };
}

/** "8 films and TV shows, 6 books" — only the non-zero parts, in reading order. */
export function describeCounts(counts: AdoptionCounts): string {
  const parts: string[] = [];
  const push = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  push(counts.titles, "film or TV show", "films and TV shows");
  push(counts.books, "book", "books");
  push(counts.manga, "manga", "manga");
  push(counts.games, "game", "games");
  push(counts.lists, "custom list", "custom lists");
  const last = parts[parts.length - 1];
  if (last === undefined) return "no entries";
  if (parts.length === 1) return last;
  return `${parts.slice(0, -1).join(", ")} and ${last}`;
}
