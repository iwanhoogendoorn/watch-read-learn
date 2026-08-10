/**
 * Deploy the built plugin into an Obsidian vault.
 *
 *   node scripts/deploy.mjs "/path/to/Vault"
 *   WATCHLOG_VAULT="/path/to/Vault" node scripts/deploy.mjs
 *
 * Refuses to run without an explicit target. Before copying anything it backs up
 * the installed plugin folder — including `data.json` — to a timestamped
 * sibling, because this overwrites a plugin the user is actively using.
 *
 * Copies only main.js, manifest.json and styles.css; `data.json` is never
 * touched, so the existing library carries over exactly as SPEC D1 requires.
 */
import { access, copyFile, mkdir, cp, readdir } from "node:fs/promises";
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

if (await exists(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${target}.bak-${stamp}`;
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

console.log("Done. Reload Obsidian or toggle the plugin off and on.");
