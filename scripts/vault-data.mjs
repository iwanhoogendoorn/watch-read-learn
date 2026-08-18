/**
 * Where a harness gets its `data.json` from.
 *
 * The smoke and preview scripts all read one real vault's plugin data, and each
 * of them used to carry a maintainer's home directory as the fallback default —
 * which is both a private path in a public repo and a lie on every other
 * machine, because a wrong default fails as a confusing ENOENT rather than as
 * an answer to the question "which vault?".
 *
 * So there is no default. The resolution order mirrors `deploy.mjs`, which takes
 * the vault explicitly and refuses to guess:
 *
 *   1. `--data /path/to/data.json`
 *   2. `--vault /path/to/Vault`      (the plugin folder is derived)
 *   3. `WATCHLOG_DATA`
 *   4. `WATCHLOG_VAULT`              (same derivation)
 *   5. usage message on stderr, exit 1
 */
import { join } from "node:path";

/** The id `deploy.mjs` installs under; a vault path is completed with it. */
export const PLUGIN_ID = "watch-read-learn";

/** `<vault>/.obsidian/plugins/watch-read-learn/data.json` */
export function dataPathForVault(vault) {
  return join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json");
}

/**
 * Resolve the `data.json` to read, or exit 1 with instructions.
 *
 * @param {string} script      e.g. "scripts/smoke-dashboard.mjs", for the usage line
 * @param {string|undefined} data   the `--data` flag, if the caller parsed one
 * @param {string|undefined} vault  the `--vault` flag, if the caller parsed one
 */
export function resolveDataPath({ script, data, vault }) {
  if (data) return data;
  if (vault) return dataPathForVault(vault);
  if (process.env.WATCHLOG_DATA) return process.env.WATCHLOG_DATA;
  if (process.env.WATCHLOG_VAULT) return dataPathForVault(process.env.WATCHLOG_VAULT);

  console.error(
    `${script} needs the vault's plugin data, and will not guess where it is.\n\n` +
      `Set one of these:\n` +
      `  WATCHLOG_DATA=/path/to/Vault/.obsidian/plugins/${PLUGIN_ID}/data.json\n` +
      `  WATCHLOG_VAULT=/path/to/Vault\n` +
      `or pass it:\n` +
      `  node ${script} --data /path/to/Vault/.obsidian/plugins/${PLUGIN_ID}/data.json\n` +
      `  node ${script} --vault /path/to/Vault`,
  );
  process.exit(1);
}
