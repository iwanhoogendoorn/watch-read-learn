/**
 * Live smoke test against a real Plex server (SPEC §7 Wave 2 evidence).
 *
 *   node scripts/smoke-plex.mjs [--url http://host:32400] [--token TOKEN] [title...]
 *
 * It runs the plugin's OWN code — `services/plex.ts` and `services/availability.ts`
 * are bundled by esbuild and imported here, with `services/http.ts`'s Obsidian
 * `requestUrl` swapped for Node's `fetch`. That is the point: a curl transcript
 * proves the endpoints exist, this proves the client hits them correctly, parses
 * them correctly, and builds an index the matcher can actually resolve a title
 * against.
 *
 * What it exercises, in order:
 *   1. `GET /identity`               — unauthenticated reachability + machine id
 *   2. `indexableSections()`         — agent filtering (home videos must not match)
 *   3. `buildIndex()`                — the full GUID index
 *   4. `match()`                     — a known title, through the real matcher
 *   5. `allLeaves()`                 — every episode of a matched show
 *
 * Exits non-zero on the first failure, so it is usable as a gate.
 *
 * Overseerr is deliberately NOT smoke-tested: it needs an API key we do not
 * have, and inventing one would produce a green run that proves nothing. Those
 * paths stay fixture-tested (`tests/services/overseerr.test.ts`).
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}

const PLEX_URL = flag("url", process.env.PLEX_URL ?? "http://192.168.1.10:32400");
const PLEX_TOKEN = flag("token", process.env.PLEX_TOKEN ?? "");
const WANTED = argv.filter((a) => !a.startsWith("--"));
const TITLES = WANTED.length > 0 ? WANTED : ["Anora", "Shrinking"];

// ---------------------------------------------------------------------------
// Build the plugin's service layer for Node
// ---------------------------------------------------------------------------

/**
 * `services/http.ts` imports `requestUrl` from `obsidian`, which does not exist
 * outside the app. This shim gives esbuild an `obsidian` module backed by
 * `fetch`, with the same response shape `requestUrl` returns.
 */
const OBSIDIAN_SHIM = `
export async function requestUrl(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(options.url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    const headers = {};
    response.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const result = { status: response.status, headers, text, json, arrayBuffer: new ArrayBuffer(0) };
    if (!(options.throw === false) && response.status >= 400) {
      const error = new Error("Request failed, status " + response.status);
      error.status = response.status;
      error.headers = headers;
      throw Object.assign(error, result);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
export class Notice {}
export class Plugin {}
export class Modal {}
export class ItemView {}
export const Platform = { isMobile: false };
export function setIcon() {}
`;

const ENTRY = `
export { createPlexClient, isIndexableSection } from ${JSON.stringify(join(root, "src/services/plex.ts"))};
export { createAvailabilityService, confirmsMatch, normalizeTitle } from ${JSON.stringify(join(root, "src/services/availability.ts"))};
`;

async function loadServices() {
  const dir = await mkdtemp(join(tmpdir(), "watchlog-smoke-"));
  const shimPath = join(dir, "obsidian-shim.mjs");
  const entryPath = join(dir, "entry.ts");
  const outPath = join(dir, "bundle.mjs");

  await writeFile(shimPath, OBSIDIAN_SHIM, "utf8");
  await writeFile(entryPath, ENTRY, "utf8");

  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile: outPath,
    logLevel: "warning",
    alias: { obsidian: shimPath },
  });

  const mod = await import(pathToFileURL(outPath).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let step = 0;
const started = Date.now();

function pass(label, detail) {
  step += 1;
  console.log(`  PASS  ${step}. ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  step += 1;
  console.error(`  FAIL  ${step}. ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
  throw new Error(`${label}: ${detail}`);
}

/** A minimal but complete `TitleV4` for the matcher to chew on. */
function smokeTitle(name, extra = {}) {
  return {
    id: `smoke-${name}`,
    title: name,
    type: "",
    status: "",
    priority: "",
    review: "",
    rating: 0,
    notes: "",
    favorite: false,
    tags: [],
    dateStarted: null,
    dateFinished: null,
    dateAdded: "",
    dateModified: "",
    releaseDate: null,
    totalEpisodes: 1,
    episodeDuration: 0,
    seasons: [],
    watchedEpisodes: [],
    externalLink: "",
    posterUrl: "",
    manualPosterUrl: "",
    trailerUrl: "",
    manualTrailerUrl: "",
    director: [],
    cast: [],
    studio: [],
    manualDirector: [],
    manualCast: [],
    manualStudio: [],
    communityRating: 0,
    communityVotes: 0,
    communitySource: "",
    communityRatingLastFetched: "",
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { mod, cleanup } = await loadServices();

try {
  console.log(`Watch, Read and Learn v4 — live Plex smoke test`);
  console.log(`  server: ${PLEX_URL}`);
  console.log(`  token:  ${PLEX_TOKEN ? "(supplied)" : "(none — relying on allowedNetworks)"}`);
  console.log("");

  const plex = mod.createPlexClient(() => ({
    url: PLEX_URL,
    token: PLEX_TOKEN,
    machineId: "",
  }));

  // --- 1. identity -------------------------------------------------------
  const identity = await plex.identity();
  if (!identity.machineIdentifier) fail("GET /identity", "no machineIdentifier in the response");
  pass(
    "GET /identity",
    `machineId ${identity.machineIdentifier.slice(0, 12)}… · Plex ${identity.version}`,
  );

  // --- 2. sections -------------------------------------------------------
  const allSections = await plex.sections();
  const indexable = await plex.indexableSections();
  if (indexable.length === 0) fail("indexableSections()", "no movie/show library on a modern agent");
  const skipped = allSections.filter((s) => !mod.isIndexableSection(s));
  pass(
    "indexableSections()",
    `${indexable.length} indexable (${indexable.map((s) => `${s.title} [${s.type}]`).join(", ")}); ` +
      `${skipped.length} skipped (${skipped.map((s) => s.title).join(", ") || "none"})`,
  );

  // --- 3. the GUID index -------------------------------------------------
  const availability = mod.createAvailabilityService({
    plex,
    getMachineId: () => identity.machineIdentifier,
  });

  const t0 = Date.now();
  const index = await availability.buildIndex();
  const indexMs = Date.now() - t0;
  if (index.itemCount === 0) fail("buildIndex()", "indexed zero items");
  const schemes = new Map();
  for (const key of index.guids.keys()) {
    const scheme = key.split("://")[0];
    schemes.set(scheme, (schemes.get(scheme) ?? 0) + 1);
  }
  pass(
    "buildIndex()",
    `${index.itemCount} item(s) → ${index.guids.size} GUID key(s) in ${indexMs} ms ` +
      `(${[...schemes].map(([s, n]) => `${s}:${n}`).join(", ")})`,
  );

  // --- 4. the primary match path: TMDB id → GUID index -------------------
  // Titles added through Overseerr always carry a tmdbId, so this — not the
  // fuzzy fallback below — is the path almost every real match takes.
  const tmdbKey = [...index.guids.keys()].find((key) => key.startsWith("tmdb://"));
  if (!tmdbKey) fail("match() via guid", "the index holds no tmdb:// key at all");
  const indexedEntry = index.guids.get(tmdbKey);
  const byId = await availability.match(
    smokeTitle(indexedEntry.title, { tmdbId: Number(tmdbKey.slice("tmdb://".length)) }),
  );
  if (!byId) fail("match() via guid", `${tmdbKey} is in the index but did not resolve`);
  if (byId.via !== "guid") {
    fail("match() via guid", `resolved via "${byId.via}", expected the index`);
  }
  pass(
    "match() via guid",
    `${tmdbKey} → ratingKey ${byId.entry.ratingKey} ("${byId.entry.title}") without a network call`,
  );

  // --- 5. match by name (the fuzzy fallback) -----------------------------
  let matchedShow = null;
  for (const wanted of TITLES) {
    // A bare name with no ids is the hardest case for the matcher: it has to
    // fall through the GUID index to `/hubs/search` and confirm the hit.
    const found = await availability.match(smokeTitle(wanted));
    if (!found) {
      fail("match()", `"${wanted}" was not found on this server`);
      continue;
    }
    pass(
      "match()",
      `"${wanted}" → ${found.entry.type} ratingKey ${found.entry.ratingKey} ` +
        `(${found.entry.title}${found.entry.year ? ` ${found.entry.year}` : ""}) via ${found.via}` +
        (found.entry.leafCount !== undefined ? `, leafCount ${found.entry.leafCount}` : ""),
    );
    if (found.entry.type === "show" && !matchedShow) matchedShow = found.entry;
  }

  // --- 5. allLeaves ------------------------------------------------------
  if (!matchedShow) {
    // Nothing among the requested titles was a show; take the first one in the
    // index so this step is still exercised rather than silently skipped.
    matchedShow = [...index.guids.values()].find((entry) => entry.type === "show") ?? null;
    if (matchedShow) console.log(`  note  no requested title was a show; using "${matchedShow.title}"`);
  }
  if (!matchedShow) fail("allLeaves()", "no show in the index to read episodes from");

  const leaves = await plex.allLeaves(matchedShow.ratingKey);
  if (leaves.length === 0) fail("allLeaves()", `"${matchedShow.title}" returned zero episodes`);
  const seasons = new Map();
  for (const leaf of leaves) seasons.set(leaf.s, (seasons.get(leaf.s) ?? 0) + 1);
  const breakdown = [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `S${s}:${n}`)
    .join(" ");
  pass(
    "allLeaves()",
    `"${matchedShow.title}" → ${leaves.length} episode(s) across ${seasons.size} season(s) [${breakdown}]` +
      (matchedShow.leafCount !== undefined
        ? ` · leafCount agrees: ${matchedShow.leafCount === leaves.length}`
        : ""),
  );

  console.log("");
  console.log(`ALL ${step} CHECKS PASSED in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error("");
  console.error(`SMOKE TEST FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
