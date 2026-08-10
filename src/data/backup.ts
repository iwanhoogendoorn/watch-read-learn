/**
 * One-shot v3 safety net.
 *
 * Before the plugin v4 writes `data.json` for the first time, the file as v3 left
 * it is copied to `data.json.v3.bak` inside the plugin folder. That copy is the
 * user's rollback path, so it is written **once** and never overwritten — a
 * second run must not clobber the original with a v4-shaped file.
 *
 * Two properties this has to have, because it is the last line of defence:
 *
 *   - **fail closed.** "I could not tell whether data.json exists" is not the
 *     same as "there is no data.json". Existence is a tri-state, and `unknown`
 *     counts as "there may be something to lose", so the caller's gate holds.
 *   - **atomic.** The copy is staged in a temporary sibling, read back and
 *     compared in full, and only then moved into place. A write that dies
 *     halfway can therefore never leave a truncated file at the backup path —
 *     and a target that is already there is only accepted once it has been read
 *     and shown to be a complete document, never on the strength of its name.
 */
import type { DataAdapter } from "obsidian";
import { DATA_FILE, V3_BACKUP_FILE } from "../constants";

/** Suffix of the staging file. Cleaned up on success and on failure. */
const TEMP_SUFFIX = ".writing.tmp";

/**
 * What we know about `data.json`.
 *
 * `unknown` is what an adapter error produces, and it is deliberately *not*
 * folded into `absent`: the whole point of the gate is that we do not write
 * when we cannot prove there is nothing to lose.
 */
export type SourceState = "present" | "absent" | "unknown";

export interface BackupResult {
  /** True when this call created the backup. */
  created: boolean;
  /** Absolute-in-vault path of the backup, whether or not we created it. */
  path: string;
  /** Tri-state truth about `data.json`. */
  sourceState: SourceState;
  /**
   * True unless `data.json` is *known* to be absent — the gate's input.
   *
   * `unknown` reports `true` on purpose: paired with `error`, it means "a file
   * we may have needed to protect was not protected", which must block writes.
   */
  sourceExists: boolean;
  /** Populated when the copy failed. A failure with `sourceExists` blocks writes. */
  error?: string;
}

function result(
  sourceState: SourceState,
  path: string,
  extra: { created?: boolean; error?: string } = {},
): BackupResult {
  return {
    created: extra.created ?? false,
    path,
    sourceState,
    sourceExists: sourceState !== "absent",
    ...(extra.error === undefined ? {} : { error: extra.error }),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this the complete document we set out to copy?
 *
 * Not "does the path exist" and not "does it match today's `data.json`" — the
 * backup is a v3 snapshot and `data.json` moves on the moment v4 saves, so
 * comparing them would rewrite the rollback copy with v4 data on the second
 * startup. Parsing is the test that separates a finished copy from a truncated
 * one without making that mistake.
 */
function isCompleteDocument(contents: string): boolean {
  if (contents.trim() === "") return false;
  try {
    const parsed: unknown = JSON.parse(contents);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * @param adapter    `app.vault.adapter`
 * @param pluginDir  `plugin.manifest.dir`, e.g. `.obsidian/plugins/watchlog`
 */
export async function ensureV3Backup(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<BackupResult> {
  const source = `${pluginDir}/${DATA_FILE}`;
  const target = `${pluginDir}/${V3_BACKUP_FILE}`;
  const temp = `${target}${TEMP_SUFFIX}`;

  // 1. Existence of the source, as a tri-state. Everything downstream reports
  //    this value, so an adapter that throws here still blocks the gate.
  let sourceState: SourceState;
  try {
    sourceState = (await adapter.exists(source)) ? "present" : "absent";
  } catch (err) {
    return result("unknown", target, { error: `could not check ${DATA_FILE}: ${message(err)}` });
  }
  if (sourceState === "absent") return result("absent", target);

  // 2. An existing target is accepted only once it has been read and shown to
  //    be a complete document. A partial file left by a failed write has the
  //    right name and none of the contents.
  let targetExists = false;
  try {
    targetExists = await adapter.exists(target);
  } catch (err) {
    return result(sourceState, target, {
      error: `could not check ${V3_BACKUP_FILE}: ${message(err)}`,
    });
  }
  if (targetExists) {
    try {
      if (isCompleteDocument(await adapter.read(target))) return result(sourceState, target);
    } catch (err) {
      return result(sourceState, target, {
        error: `could not verify the existing ${V3_BACKUP_FILE}: ${message(err)}`,
      });
    }
    // Fall through: the file at the backup path is not a usable backup, so it
    // is replaced by a staged copy rather than trusted.
  }

  // 3. Read what we are protecting.
  let contents: string;
  try {
    contents = await adapter.read(source);
  } catch (err) {
    return result(sourceState, target, { error: `could not read ${DATA_FILE}: ${message(err)}` });
  }

  // 4. Stage, verify, then move. Nothing lands at the backup path until the
  //    staged copy has been read back and matched character for character.
  try {
    await adapter.write(temp, contents);
    const staged = await adapter.read(temp);
    if (staged !== contents) {
      await removeQuietly(adapter, temp);
      return result(sourceState, target, {
        error: `the staged copy of ${DATA_FILE} did not match the original`,
      });
    }

    await moveIntoPlace(adapter, temp, target, contents);

    // 5. And confirm what actually ended up there.
    const written = await adapter.read(target);
    if (written !== contents) {
      return result(sourceState, target, {
        error: `${V3_BACKUP_FILE} could not be verified after writing`,
      });
    }
    return result(sourceState, target, { created: true });
  } catch (err) {
    await removeQuietly(adapter, temp);
    return result(sourceState, target, { error: `could not write ${V3_BACKUP_FILE}: ${message(err)}` });
  }
}

/** `rename` when the adapter has it, a plain write plus cleanup when it does not. */
async function moveIntoPlace(
  adapter: DataAdapter,
  temp: string,
  target: string,
  contents: string,
): Promise<void> {
  const rename = (adapter as Partial<DataAdapter>).rename?.bind(adapter);
  if (rename) {
    // The target may still hold the rejected partial file; a rename over it is
    // the atomic replacement we want.
    await removeQuietly(adapter, target);
    await rename(temp, target);
    return;
  }
  await adapter.write(target, contents);
  await removeQuietly(adapter, temp);
}

async function removeQuietly(adapter: DataAdapter, path: string): Promise<void> {
  const remove = (adapter as Partial<DataAdapter>).remove?.bind(adapter);
  if (!remove) return;
  try {
    if (await adapter.exists(path)) await remove(path);
  } catch {
    // Best effort: a leftover staging file is untidy, never dangerous.
  }
}

/** Read the v3 backup back, for the settings "restore backup" action. */
export async function readV3Backup(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<string | undefined> {
  const target = `${pluginDir}/${V3_BACKUP_FILE}`;
  try {
    if (!(await adapter.exists(target))) return undefined;
    const contents = await adapter.read(target);
    // A truncated backup is worse than none: restoring it would overwrite
    // `data.json` with a file that cannot be parsed.
    return isCompleteDocument(contents) ? contents : undefined;
  } catch {
    return undefined;
  }
}
