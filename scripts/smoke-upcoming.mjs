/**
 * Live smoke test for the Upcoming pipeline (QA2 report 1 evidence).
 *
 *   node scripts/smoke-upcoming.mjs --vault /path/to/Vault [--expect "Dexter"]
 *   WATCHLOG_VAULT=/path/to/Vault node scripts/smoke-upcoming.mjs
 *
 * It runs the plugin's OWN code — `services/match.ts`, `services/airing.ts` and
 * `ui/tabs/upcoming.ts` are bundled by esbuild and imported here, with
 * `services/http.ts`'s Obsidian `requestUrl` swapped for Node's `fetch` — over
 * the REAL vault's `data.json`, against the REAL Overseerr server, and prints
 * the Upcoming rows that come out the other end.
 *
 * The whole point is that this is the chain that was broken: migrated v3 titles
 * have no `tmdbId`, so the airing engine skipped them and Upcoming stayed empty.
 * A fixture cannot prove that is fixed; this can.
 *
 * SAFETY, and it is enforced rather than promised:
 *   - the vault file is read once and **never** written. Everything below
 *     operates on an in-memory deep copy;
 *   - the HTTP shim refuses any method other than GET, so `POST /request` cannot
 *     be issued even by accident;
 *   - the API key is read from the vault settings and never printed.
 */
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDataPath } from "./vault-data.mjs";

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

const DATA_PATH = resolveDataPath({
  script: "scripts/smoke-upcoming.mjs",
  data: flag("data", ""),
  vault: flag("vault", ""),
});
/** A substring of the title that MUST produce an announced-season row. */
const EXPECT = flag("expect", "Dexter");

// ---------------------------------------------------------------------------
// The Obsidian shim — GET only
// ---------------------------------------------------------------------------

const OBSIDIAN_SHIM = `
export async function requestUrl(options) {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    // Read-only by construction: this script must never create a request on
    // the user's Overseerr server.
    throw new Error("smoke-upcoming is read-only; refusing " + method + " " + options.url);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetch(options.url, {
      method: "GET",
      headers: options.headers ?? {},
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
export class MarkdownRenderChild {}
export class SuggestModal {}
export class FuzzySuggestModal {}
export class Menu {}
export const Platform = { isMobile: false };
export function setIcon() {}
export function normalizePath(p) { return p; }
`;

const ENTRY = `
export { createOverseerrClient } from ${JSON.stringify(join(root, "src/services/overseerr.ts"))};
export { createMatchService, needsTmdbBackfill } from ${JSON.stringify(join(root, "src/services/match.ts"))};
export { createAiringService, shouldTrackAiring, seasonSyncPlan, isEmptySyncPlan } from ${JSON.stringify(join(root, "src/services/airing.ts"))};
export { identityMatches, typeFamilyOf, typeRepairFor } from ${JSON.stringify(join(root, "src/services/match.ts"))};
export { withAddedSeason, recomputeOffsets, totalFromSeasons } from ${JSON.stringify(join(root, "src/data/episodes.ts"))};
export { buildUpcomingEntries, formatCountdown, countEntries, summarizeCounts } from ${JSON.stringify(join(root, "src/ui/tabs/upcoming.ts"))};
export { buildUnifiedUpcoming } from ${JSON.stringify(join(root, "src/domains/upcoming/unified.ts"))};
export {
  applyUpcomingFilters,
  availabilityOf,
  isQueuedForDownload,
  buildUpcomingFacetSections,
  createUpcomingFilterState,
  defaultUpcomingSort,
  hasArrived,
  sortUpcomingRows,
  stateOf,
  typeOf,
  watchStateOf,
  withinWindow,
} from ${JSON.stringify(join(root, "src/domains/upcoming/filters.ts"))};
export { UpcomingSearchEngine } from ${JSON.stringify(join(root, "src/domains/upcoming/query.ts"))};
`;

async function loadServices() {
  const dir = await mkdtemp(join(tmpdir(), "watchlog-upcoming-"));
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
// The run
// ---------------------------------------------------------------------------

const { mod, cleanup } = await loadServices();

try {
  console.log("Watch, Read and Learn v4 — live Upcoming smoke test");
  console.log(`  data:   ${DATA_PATH} (read-only)`);

  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  // Deep copy: nothing below can reach the parsed vault object, and nothing
  // ever writes the file back.
  const titles = structuredClone(raw.titles ?? []);
  const settings = raw.settings ?? {};
  console.log(`  server: ${settings.overseerrUrl}`);
  console.log(`  titles: ${titles.length}`);
  console.log("");

  const overseerr = mod.createOverseerrClient(() => ({
    url: settings.overseerrUrl ?? "",
    apiKey: settings.overseerrApiKey ?? "",
  }));
  if (!overseerr.configured()) {
    console.error("  FAIL  the vault has no Overseerr URL/key configured");
    process.exit(1);
  }

  // --- 1. backfill ---------------------------------------------------------

  console.log("1. TMDB id backfill");
  const missing = titles.filter((t) => mod.needsTmdbBackfill(t));
  console.log(`   ${missing.length} of ${titles.length} title(s) have no tmdbId:`);
  for (const t of missing) console.log(`     - ${t.title} (${t.type}, ${t.releaseDate ?? "no date"})`);

  const matcher = mod.createMatchService({ overseerr });
  const matches = await matcher.matchAll(titles, { force: true });
  for (const result of matches) {
    const title = titles.find((t) => t.id === result.titleId);
    if (!title) continue;
    if (result.error) {
      console.log(`     ✗ ${title.title}: search failed — ${result.error}`);
      continue;
    }
    if (result.outcome.kind === "match") {
      title.tmdbId = result.outcome.hit.tmdbId;
      title.tmdbMediaType = result.outcome.hit.mediaType;
      console.log(
        `     ✓ ${title.title} → tmdb ${title.tmdbId} (${title.tmdbMediaType}) “${result.outcome.hit.title}”`,
      );
    } else if (result.outcome.kind === "ambiguous") {
      console.log(
        `     ? ${title.title}: ambiguous — ${result.outcome.candidates
          .map((c) => `${c.title} (${c.year ?? "?"}, tmdb ${c.tmdbId})`)
          .join("; ")}`,
      );
    } else {
      console.log(`     — ${title.title}: nothing plausible upstream`);
    }
  }
  console.log("");

  // --- 1b. type vs media type ---------------------------------------------

  console.log("2. Type reconcile (display type vs media type)");
  const TYPES = settings.types ?? [];
  const suspect = titles.filter((t) => t.tmdbId && mod.typeFamilyOf(t.type) !== t.tmdbMediaType);
  if (suspect.length === 0) console.log("   nothing disagrees");
  for (const title of suspect) {
    console.log(
      `   ! ${title.title}: type “${title.type}” (${mod.typeFamilyOf(title.type)}) vs tmdbMediaType “${title.tmdbMediaType}” on tmdb ${title.tmdbId}`,
    );
    const claimed = title.tmdbMediaType;
    const other = claimed === "movie" ? "tv" : "movie";
    let confirmed;
    for (const candidate of [claimed, other]) {
      try {
        const payload = await overseerr.details(title.tmdbId, candidate);
        const ok = mod.identityMatches(title, payload);
        console.log(
          `       /${candidate}/${title.tmdbId} → “${payload.title}” (${payload.releaseDate ?? "?"}) — ${ok ? "IS this title" : "different programme"}`,
        );
        if (ok && !confirmed) confirmed = candidate;
      } catch (err) {
        console.log(`       /${candidate}/${title.tmdbId} → ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!confirmed) {
      console.log("       neither namespace answered as this title — left alone");
      continue;
    }
    if (confirmed !== claimed) {
      title.tmdbMediaType = confirmed;
      console.log(`       ✓ media type corrected to ${confirmed}`);
      continue;
    }
    const repair = mod.typeRepairFor(title, TYPES);
    if (repair) {
      Object.assign(title, repair.patch);
      console.log(`       ✓ display type repaired: ${repair.from} → ${repair.to} (seasons: ${title.seasons.length}, totalEpisodes: ${title.totalEpisodes})`);
    }
  }
  console.log("");

  // --- 2. airing refresh ---------------------------------------------------

  console.log("3. Airing refresh (forced, live) — seasons sync themselves");
  const airing = mod.createAiringService({
    overseerr,
    getTtlHours: () => 12,
  });
  const results = await airing.refreshAll(titles, { force: true });
  for (const result of results) {
    const title = titles.find((t) => t.id === result.titleId);
    if (!title) continue;
    if (result.error) {
      console.log(`     ✗ ${title.title}: ${result.error}`);
      continue;
    }
    title.airing = result.airing;
    // Exactly what `Integrations.applyAiringResults` writes: Overseerr's view of
    // the media, merged into the request cache without touching a request row.
    if (result.mediaStatus !== undefined) {
      title.request = { ...title.request, mediaStatus: result.mediaStatus };
    }
    const bits = [];
    if (result.airing.showStatus) bits.push(result.airing.showStatus);
    if (result.airing.seasonCount !== undefined) bits.push(`${result.airing.seasonCount} season(s)`);
    if (result.airing.newSeasonDetected !== undefined) {
      bits.push(`NEW SEASON ${result.airing.newSeasonDetected}`);
    }
    if (result.airing.nextEpisode) {
      bits.push(`next S${result.airing.nextEpisode.season}E${result.airing.nextEpisode.episode} ${result.airing.nextEpisode.airDate}`);
    }
    if (result.mediaStatus !== undefined) {
      bits.push(`media status ${result.mediaStatus}${mod.isQueuedForDownload(title) ? " (queued for download)" : ""}`);
    }
    if (result.airing.pendingSeason) {
      const p = result.airing.pendingSeason;
      bits.push(`pending season ${p.number}${p.airDate ? ` (${p.airDate})` : " (no date yet)"}`);
    }
    console.log(`     ✓ ${title.title}: ${bits.join(" · ") || "nothing scheduled"}`);
    if (result.change) console.log(`         change: ${result.change}`);

    // What the plugin does with `autoSyncSeasons` on (the default), applied to
    // the in-memory copy exactly as `Integrations.applySeasonSync` would.
    const plan = result.seasonSync;
    if (plan && !mod.isEmptySyncPlan(plan)) {
      let seasons = title.seasons.map((season, index) => {
        const grown = plan.grown.find((g) => g.seasonNumber === (season.seasonNumber ?? index + 1));
        return grown && season.episodes === 0 ? { ...season, episodes: grown.episodes } : { ...season };
      });
      for (const add of plan.added) {
        seasons = mod.withAddedSeason(seasons, add.seasonNumber, add.episodes, add.airDate);
        console.log(
          `         + season ${add.seasonNumber} added automatically${add.episodes > 0 ? ` (${add.episodes} episodes)` : " — episode list to come"}`,
        );
      }
      for (const g of plan.grown) {
        console.log(`         ~ season ${g.seasonNumber} sized to ${g.episodes} episode(s) upstream`);
      }
      mod.recomputeOffsets(seasons);
      title.seasons = seasons;
      title.totalEpisodes = Math.max(1, mod.totalFromSeasons(seasons));
      // v3-migrated seasons carry no `seasonNumber`; every consumer falls back
      // to the array position, so the print does too rather than saying
      // "Sundefined".
      const shape = seasons.map((s, i) => `S${s.seasonNumber ?? i + 1}(${s.episodes})`).join(" ");
      console.log(`         seasons now: ${shape} · status untouched (${title.status})`);
    }
  }
  console.log("");

  // --- 3. what Upcoming renders -------------------------------------------

  console.log("4. Upcoming entries");
  const entries = mod.buildUpcomingEntries(titles, new Date());
  const counts = mod.countEntries(entries);
  console.log(`   header: “${mod.summarizeCounts(counts)}”`);
  if (entries.length === 0) console.log("   (empty)");
  for (const entry of entries) {
    const date = entry.date ?? "—";
    console.log(
      `   • ${entry.title.title} | ${entry.label} | ${date} | ${mod.formatCountdown(entry.daysUntil)}` +
        (entry.detail ? ` | ${entry.detail}` : ""),
    );
  }
  console.log("");

  // --- 3b. the toolbar, over the real list ---------------------------------

  /**
   * The Upcoming tab's filters, run over the REAL vault.
   *
   * A fixture can prove a predicate; only this can prove the predicate is wired
   * to the data the user actually has — including their books and games, which
   * is why the unified list is built from all three libraries here.
   */
  const now = new Date();
  const reading = raw.reading ?? undefined;
  const gamesData = raw.games ?? undefined;
  const rows = mod.buildUnifiedUpcoming(titles, reading, gamesData, { now });
  const sorted = mod.sortUpcomingRows(rows, mod.defaultUpcomingSort());

  const line = (row) =>
    `   • ${row.name} | ${row.source} | ${row.kind} | ${row.date ?? "no date"} | ${mod.formatCountdown(row.daysUntil)} | ${mod.stateOf(row)} | ${mod.availabilityOf(row)} | ${mod.watchStateOf(row)} | ${mod.typeOf(row) || "(empty)"}`;

  console.log("5. The unified Upcoming list — UNFILTERED");
  const ahead = sorted.filter((row) => !mod.hasArrived(row));
  const arrived = mod
    .sortUpcomingRows(sorted.filter((row) => mod.hasArrived(row)), { key: "date", direction: "desc" });
  console.log(`   ${sorted.length} row(s) across every library`);
  console.log(`   still to come — ${ahead.length}`);
  if (ahead.length === 0) console.log("   (none)");
  for (const row of ahead) console.log(line(row));
  console.log(`   recently released (its own section on the tab) — ${arrived.length}`);
  if (arrived.length === 0) console.log("   (none)");
  for (const row of arrived) console.log(line(row));
  // The two lists partition the pool: nothing is shown twice and nothing is lost.
  if (ahead.length + arrived.length !== sorted.length) {
    console.error("  FAIL  the future/released split does not partition the list");
    process.exit(1);
  }
  console.log("");

  console.log("6. Facet chips the toolbar would offer (counts over the whole pool)");
  for (const section of mod.buildUpcomingFacetSections(rows)) {
    const chips = section.options.map((o) => `${o.label} (${o.count})`).join(", ");
    console.log(`   ${section.label}: ${chips || "— nothing to offer, chip row hidden"}`);
  }
  console.log("");

  console.log("7. The same list, FILTERED");

  /** Apply one named filter and print what survives. */
  const applyCase = (label, mutate, predicate) => {
    const state = mod.createUpcomingFilterState();
    mutate(state);
    const kept = mod.sortUpcomingRows(
      mod.applyUpcomingFilters(rows, state, now),
      mod.defaultUpcomingSort(),
    );
    console.log(`   ${label} → ${kept.length} of ${rows.length}`);
    for (const row of kept) console.log(line(row));
    // Filtering can only ever remove rows, and every survivor must satisfy the
    // filter that was applied. Both are asserted, not eyeballed.
    if (kept.length > rows.length) {
      console.error(`  FAIL  “${label}” produced more rows than the pool holds`);
      process.exit(1);
    }
    const wrong = kept.find((row) => !predicate(row));
    if (wrong) {
      console.error(`  FAIL  “${label}” kept a row it should have dropped: ${wrong.name}`);
      process.exit(1);
    }
    return kept;
  };

  const week = applyCase(
    "Next 7 days",
    (state) => {
      state.window = "7d";
    },
    (row) => row.daysUntil !== null && row.daysUntil >= 0 && row.daysUntil <= 7,
  );

  applyCase(
    "Watchlist only, episodes only",
    (state) => {
      state.excludedDomains = ["reading", "games"];
      state.excludedKinds = ["season", "release"];
    },
    (row) => row.source === "watchlist" && row.kind === "episode",
  );

  applyCase(
    "Not watched only",
    (state) => {
      state.excludedWatchStates = ["watched"];
    },
    (row) => mod.watchStateOf(row) === "unwatched",
  );

  const notOnPlex = applyCase(
    "This week, not on Plex (the saved-view workflow)",
    (state) => {
      state.window = "7d";
      state.excludedAvailability = ["plex"];
    },
    (row) => mod.withinWindow(row, "7d", now) && mod.availabilityOf(row) !== "plex",
  );
  if (notOnPlex.length > week.length) {
    console.error("  FAIL  adding a facet to the week window returned MORE rows");
    process.exit(1);
  }

  const query = "domain:watchlist state:due";
  const searched = new mod.UpcomingSearchEngine(rows).filter(query);
  console.log(`   search “${query}” → ${searched.length} of ${rows.length}`);
  for (const row of searched) console.log(line(row));
  const misfit = searched.find((row) => row.source !== "watchlist" || mod.stateOf(row) !== "due");
  if (misfit) {
    console.error(`  FAIL  the search kept a row that does not match: ${misfit.name}`);
    process.exit(1);
  }
  console.log(`  PASS  filters and search narrow the real list without inventing rows`);
  console.log("");

  // --- 4. the assertion ----------------------------------------------------

  const wanted = entries.find(
    (e) => e.kind === "season" && e.title.title.toLowerCase().includes(EXPECT.toLowerCase()),
  );
  if (!wanted) {
    console.error(`  FAIL  no season row for a title matching “${EXPECT}”`);
    process.exit(1);
  }
  const followed = titles.find((t) => t.title.toLowerCase().includes(EXPECT.toLowerCase()));
  const adopted = (followed?.seasons ?? []).some((s) => s.seasonNumber === wanted.seasonNumber);
  if (!adopted) {
    console.error(`  FAIL  season ${wanted.seasonNumber} was not adopted into «${followed?.title}»`);
    process.exit(1);
  }
  if (!wanted.tracked || wanted.detail.includes("not on your tracker")) {
    console.error("  FAIL  the season row is still nagging about adoption");
    process.exit(1);
  }
  console.log(
    `  PASS  «${wanted.title.title}» holds ${followed?.seasons.length} season(s) in ONE tracker entry; its row reads ` +
      `“${wanted.label} · ${mod.formatCountdown(wanted.daysUntil)}”${wanted.detail ? ` · ${wanted.detail}` : ""} — no adoption prompt`,
  );

  const repaired = titles.find((t) => t.title === "Spider-Man");
  if (repaired) {
    const ok = mod.typeFamilyOf(repaired.type) === repaired.tmdbMediaType;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  “Spider-Man” is type “${repaired.type}” / media “${repaired.tmdbMediaType}” (tmdb ${repaired.tmdbId})`,
    );
    if (!ok) process.exit(1);
  }
} finally {
  await cleanup();
}
