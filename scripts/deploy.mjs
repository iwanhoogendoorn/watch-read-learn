/**
 * Deploy the built plugin into an Obsidian vault.
 *
 *   node scripts/deploy.mjs "/path/to/Vault"
 *   WATCHLOG_VAULT="/path/to/Vault" node scripts/deploy.mjs
 *
 * Refuses to run without an explicit target. Before copying anything it backs up
 * the installed plugin folder — including `data.json` — to a timestamped folder
 * under `.obsidian/plugin-backups/`, because this overwrites a plugin the user
 * is actively using. That location is deliberate: see the note by `backupRoot`.
 *
 * Copies only main.js, manifest.json and styles.css; `data.json` is never
 * touched, so the existing library carries over exactly as SPEC D1 requires.
 */
import { access, copyFile, mkdir, cp, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(root, "build");
const PLUGIN_ID = "watch-read-learn";
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

const vault = process.argv[2] ?? process.env.WATCHLOG_VAULT;
if (!vault) {
  console.error("Usage: node scripts/deploy.mjs <vault-path>   (or set WATCHLOG_VAULT)");
  process.exit(1);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(join(vault, ".obsidian")))) {
  console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
  process.exit(1);
}

for (const file of ARTIFACTS) {
  if (!(await exists(join(buildDir, file)))) {
    console.error(`Missing build/${file}. Run "npm run build" first.`);
    process.exit(1);
  }
}

const target = join(vault, ".obsidian", "plugins", PLUGIN_ID);

/**
 * Backups live OUTSIDE `plugins/`, and that is not tidiness — it is required.
 *
 * Obsidian keys a plugin by the `id` in its manifest, not by its folder name.
 * A backup copied to a sibling folder therefore declares the *same id* as the
 * real install, and Obsidian resolves the collision by loading one of them —
 * sometimes the backup. The symptom is vicious: every deploy appears to work,
 * the file on disk is provably correct, and the app keeps running old code
 * through restarts, because it is loading a different folder entirely.
 */
const backupRoot = join(vault, ".obsidian", "plugin-backups");

if (await exists(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(backupRoot, `${PLUGIN_ID}.bak-${stamp}`);
  await mkdir(backupRoot, { recursive: true });
  await cp(target, backup, { recursive: true });
  const contents = await readdir(backup);
  console.log(`Backed up the installed plugin to ${backup} (${contents.length} file(s))`);
} else {
  await mkdir(target, { recursive: true });
  console.log(`Created ${target}`);
}

for (const file of ARTIFACTS) {
  await copyFile(join(buildDir, file), join(target, file));
  console.log(`  -> ${join(target, file)}`);
}

// Anything else under plugins/ claiming our id would be loaded *instead of*
// what we just wrote. Older builds of this script left backups there, so say
// so loudly rather than let the next deploy look like it silently failed.
const pluginsDir = join(vault, ".obsidian", "plugins");
const impostors = [];
for (const name of await readdir(pluginsDir)) {
  if (name === PLUGIN_ID) continue;
  try {
    const manifest = JSON.parse(await readFile(join(pluginsDir, name, "manifest.json"), "utf8"));
    if (manifest.id === PLUGIN_ID) impostors.push(name);
  } catch {
    // Not a plugin folder, or no manifest. Not our problem.
  }
}
if (impostors.length > 0) {
  console.error(
    `\nWARNING: these folders also declare id "${PLUGIN_ID}", and Obsidian may load\n` +
      `one of them instead of the build just deployed. Move them out of plugins/:\n` +
      impostors.map((name) => `  ${join(pluginsDir, name)}`).join("\n"),
  );
  process.exitCode = 1;
}

console.log("Done. Reload Obsidian or toggle the plugin off and on.");
