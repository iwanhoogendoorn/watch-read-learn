/**
 * Following the vault when it moves underneath us.
 *
 * The plugin stores vault paths in `data.json`: the note mirroring a book or
 * game, and the epub/pdf a book links to. (A film or show's note path is
 * derived from `settings.rootFolder`, so moving that folder is covered by
 * rewriting the setting.) Obsidian rewrites `[[links]]` inside notes
 * when a file or folder is renamed, but it has no idea our JSON exists — so a
 * user who renames their `WatchLog` folder to `WRL` in the file explorer is
 * left with a library full of paths pointing at nothing, and an "open the
 * book" button that opens nothing.
 *
 * Renaming a folder fires one event for the folder, not one per descendant, so
 * matching is by path *prefix* as well as exact equality. The prefix has a
 * trailing slash on purpose: renaming `Books` must not touch `Books Archive`.
 */

/** Every stored path this rewrite touches, so a caller can report the count. */
export interface RepathResult {
  changed: number;
  /** Sample of what moved, for the notice. */
  examples: string[];
}

/** `old` → `next` for an exact hit or anything beneath it; null when unrelated. */
export function repathOne(stored: string, oldPath: string, newPath: string): string | null {
  const value = (stored ?? "").trim();
  if (value === "") return null;
  if (value === oldPath) return newPath;
  const prefix = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
  if (value.startsWith(prefix)) return `${newPath}/${value.slice(prefix.length)}`;
  return null;
}

/** The shapes this walks. Structural, so the store's types stay out of here. */
interface RepathTarget {
  reading?: {
    books?: { vaultPage?: string; filePath?: string }[];
    manga?: { vaultPage?: string; filePath?: string }[];
    settings?: { defaultFolder?: string };
  };
  games?: { games?: { vaultPage?: string }[]; settings?: { defaultFolder?: string } };
  settings?: { rootFolder?: string; customListsFolder?: string };
}

/**
 * Rewrite every stored path affected by a rename, in place.
 *
 * Folder *settings* move too: someone who renames the folder their notes live
 * in has renamed where their notes live, and leaving the setting behind would
 * scatter the next generated note back into a folder they just got rid of.
 */
export function repathAfterRename(
  data: RepathTarget,
  oldPath: string,
  newPath: string,
): RepathResult {
  const result: RepathResult = { changed: 0, examples: [] };
  if (oldPath === "" || newPath === "" || oldPath === newPath) return result;

  const rewrite = (holder: Record<string, unknown> | undefined, key: string): void => {
    if (!holder) return;
    const current = holder[key];
    if (typeof current !== "string") return;
    const next = repathOne(current, oldPath, newPath);
    if (next === null) return;
    holder[key] = next;
    result.changed += 1;
    if (result.examples.length < 3) result.examples.push(next);
  };

  for (const entry of [...(data.reading?.books ?? []), ...(data.reading?.manga ?? [])]) {
    rewrite(entry as Record<string, unknown>, "vaultPage");
    rewrite(entry as Record<string, unknown>, "filePath");
  }
  for (const game of data.games?.games ?? []) {
    rewrite(game as Record<string, unknown>, "vaultPage");
  }
  rewrite(data.settings as Record<string, unknown> | undefined, "rootFolder");
  rewrite(data.settings as Record<string, unknown> | undefined, "customListsFolder");
  rewrite(data.reading?.settings as Record<string, unknown> | undefined, "defaultFolder");
  rewrite(data.games?.settings as Record<string, unknown> | undefined, "defaultFolder");

  return result;
}
