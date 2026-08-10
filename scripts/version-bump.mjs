/**
 * Sync manifest.json and versions.json to the version in package.json.
 *
 * Runs automatically from the npm `version` lifecycle hook:
 *
 *   npm version patch|minor|major
 *
 * which bumps package.json, runs this script, and commits the three files
 * together. Tag the commit `<version>` (no leading "v") and push the tag;
 * the release workflow builds and publishes the BRAT-consumable assets.
 */
import { readFile, writeFile } from "node:fs/promises";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("Run through npm: npm version patch|minor|major");
  process.exit(1);
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.version = targetVersion;
await writeFile("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(await readFile("versions.json", "utf8"));
versions[targetVersion] = manifest.minAppVersion;
await writeFile("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`[wrl] manifest.json + versions.json -> ${targetVersion} (minAppVersion ${manifest.minAppVersion})`);
