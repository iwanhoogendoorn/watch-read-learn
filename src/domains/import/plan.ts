/**
 * From records to a plan: what would be added, what would be merged, and what
 * exactly would change.
 *
 * A tracker import is the most destructive thing this plugin can be asked to do
 * — thousands of rows, arriving on top of a library the user has been rating and
 * annotating for years — so the whole of it is computed *before* anything is
 * written, and the preview shows the computation rather than a promise about it.
 *
 * Two rules run through every line below.
 *
 * **1. An existing title's own fields are never overwritten.** Not the rating,
 * not the review, not the notes, not a watched episode. A merge may only fill a
 * gap (`rating === 0`, `notes === ""`, `dateFinished === null`) or *add* to a set
 * (`watchedEpisodes`). This is not conservatism for its own sake: the import has
 * no way to know whether the file or the library is the newer statement, and the
 * library is the one the user typed.
 *
 * **2. An id beats a name, always.** A record carrying a TMDB or IMDb id is
 * matched exactly and cannot land on the wrong title. A record carrying only a
 * name is matched by normalised name *and* an agreeing year, using the same
 * `yearsAgree` tolerance `services/match.ts` uses upstream — and a name match
 * against a title that has an id the record contradicts is refused outright.
 */
import { STATUS_COMPLETED, STATUS_DROPPED, STATUS_PLAN_TO_WATCH, STATUS_WATCHING, TYPE_MOVIE } from "../../constants";
import { recomputeOffsets, seasonRange } from "../../data/episodes";
import { createTitle } from "../../data/schema";
import { normalizeTitle } from "../../services/availability";
import { yearsAgree } from "../../services/match";
import type {
  MediaType,
  NamedColor,
  Season,
  Settings,
  TitleV4,
  TitlePatch,
} from "../../types";
import type { ImportEpisode, ImportRecord, ImportStatus, TrackerSource } from "./types";

// ---------------------------------------------------------------------------
// Settings vocabulary
// ---------------------------------------------------------------------------

/**
 * Which of the user's configured statuses an import status means.
 *
 * The five literals in `constants.ts` are the semantic ones and ship as
 * defaults, but the list is editable, so each is looked for and only used when
 * it is actually configured. `on-hold` has no v3/v4 equivalent at all; a user who
 * has added one gets it, and everyone else gets Watching, which is what an
 * on-hold show is from the library's point of view — started, not finished.
 *
 * The substring fallbacks are ordered by the *user's* list order, so a vault
 * that kept `Completed` as its own status gets it back for `completed` rows;
 * only a vault with neither name falls through to the first status it has.
 */
export function resolveStatusName(status: ImportStatus, statuses: readonly NamedColor[]): string {
  const names = statuses.map((entry) => entry.name);
  const has = (name: string): boolean => names.includes(name);
  const like = (needle: string): string | undefined =>
    names.find((name) => name.toLowerCase().includes(needle));

  if (status === "completed") return has(STATUS_COMPLETED) ? STATUS_COMPLETED : (like("complet") ?? names[0] ?? STATUS_COMPLETED);
  if (status === "dropped") return has(STATUS_DROPPED) ? STATUS_DROPPED : (like("drop") ?? names[0] ?? STATUS_DROPPED);
  if (status === "planned") return has(STATUS_PLAN_TO_WATCH) ? STATUS_PLAN_TO_WATCH : (like("plan") ?? names[0] ?? STATUS_PLAN_TO_WATCH);
  if (status === "on-hold") {
    const hold = like("hold");
    if (hold !== undefined) return hold;
  }
  // `"watching"`, not `"watch"`: the finished status is spelled **Watched**, so
  // a substring of `watch` now matches the one status this branch must never
  // pick. `Currently watching` and the like still land here.
  return has(STATUS_WATCHING) ? STATUS_WATCHING : (like("watching") ?? names[0] ?? STATUS_WATCHING);
}

/**
 * Which configured type a media kind means.
 *
 * The same rule `services/match.ts:typeRepairFor` uses, and for the same reason:
 * `Movie` is the one type name both versions treat as semantic, and everything
 * else is episodic.
 */
export function resolveTypeName(
  mediaType: MediaType | undefined,
  types: readonly NamedColor[],
  fallback: string,
): string {
  const names = types.map((entry) => entry.name);
  if (mediaType === "movie") return names.includes(TYPE_MOVIE) ? TYPE_MOVIE : (names[0] ?? TYPE_MOVIE);
  if (mediaType === "tv") return names.find((name) => name !== TYPE_MOVIE) ?? names[0] ?? "TV Show";
  return fallback || names[0] || TYPE_MOVIE;
}

/** The type a brand-new title gets, honouring `settings.defaultAddType` for unknowns. */
export function typeNameForRecord(record: ImportRecord, settings: Settings): string {
  const configured = settings.types;
  const fallback = configured.some((type) => type.name === settings.defaultAddType)
    ? settings.defaultAddType
    : (configured[0]?.name ?? TYPE_MOVIE);
  return resolveTypeName(record.mediaType, configured, fallback);
}

// ---------------------------------------------------------------------------
// Season geometry
// ---------------------------------------------------------------------------

/** Season number for a season, whether or not it carries an explicit one. */
function numberOf(season: Season, index: number): number {
  return season.seasonNumber ?? index + 1;
}

/** `(season, episode)` → this title's absolute episode number, or `null`. */
export function toAbsolute(seasons: readonly Season[], pair: ImportEpisode): number | null {
  for (let i = 0; i < seasons.length; i += 1) {
    const season = seasons[i] as Season;
    if (numberOf(season, i) !== pair.season) continue;
    if (pair.episode < 1 || pair.episode > season.episodes) return null;
    return season.offset + pair.episode;
  }
  return null;
}

/**
 * Invent the season list a record's episodes imply.
 *
 * A tracker export states which episodes were watched and never how many exist,
 * so the only defensible geometry is the smallest one that can hold what was
 * watched: each season is as long as the highest episode of it in the file.
 * `airedEpisodes`, where a source states it, grows the **last** season to make
 * up the difference — the last one specifically, because growing any earlier
 * season would shift every absolute number after it and silently re-point the
 * watch history that is being written in the same breath.
 *
 * This is a placeholder, and it is meant to be replaced: the moment the title
 * gets a `tmdbId` and the airing sync runs, real seasons arrive and
 * `rebaseWatchedEpisodes` carries the watched episodes across by season number.
 */
export function deriveSeasons(record: ImportRecord): Season[] {
  const pairs = record.episodes ?? [];
  if (pairs.length === 0) return [];

  const longest = new Map<number, number>();
  for (const pair of pairs) {
    const best = longest.get(pair.season) ?? 0;
    if (pair.episode > best) longest.set(pair.season, pair.episode);
  }

  const seasons: Season[] = [...longest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seasonNumber, episodes]) => ({
      name: `Season ${seasonNumber}`,
      episodes,
      offset: 0,
      skippedEpisodes: [],
      seasonNumber,
    }));

  recomputeOffsets(seasons);
  const total = seasons.reduce((sum, season) => sum + season.episodes, 0);
  const aired = record.airedEpisodes;
  if (aired !== undefined && aired > total && seasons.length > 0) {
    (seasons[seasons.length - 1] as Season).episodes += aired - total;
  }
  return seasons;
}

export interface ExpandedEpisodes {
  /** Absolute numbers, sorted and deduped. */
  absolute: number[];
  /** Episodes the file listed that this title's seasons cannot express. */
  dropped: number;
  /**
   * Set when a high-water mark could only be applied from its own season on.
   *
   * Simkl says "last watched: S03E07" and means seasons 1 and 2 as well. That is
   * only expandable against a season list that actually has seasons 1 and 2 in
   * it, which a title being created from this same file does not.
   */
  partialHighWaterMark?: boolean;
}

/**
 * The absolute episode numbers a record implies, against a given season list.
 *
 * A high-water mark expands to everything at or before it; an event list is
 * taken literally, because a gap in Trakt's history is a real gap and filling it
 * in would invent watches.
 */
export function expandEpisodes(record: ImportRecord, seasons: readonly Season[]): ExpandedEpisodes {
  const pairs = record.episodes ?? [];
  if (pairs.length === 0 || seasons.length === 0) return { absolute: [], dropped: pairs.length };

  if (record.progressIsHighWaterMark) {
    const mark = pairs[pairs.length - 1] as ImportEpisode;
    const markAbsolute = toAbsolute(seasons, mark);
    if (markAbsolute === null) return { absolute: [], dropped: 1 };
    const first = seasons[0] as Season;
    const known = seasons.some((season, i) => numberOf(season, i) < mark.season);
    const from = known ? seasonRange(first).first : (markAbsolute - mark.episode + 1);
    const absolute: number[] = [];
    for (let n = from; n <= markAbsolute; n += 1) absolute.push(n);
    return { absolute, dropped: 0, ...(known ? {} : { partialHighWaterMark: mark.season > 1 }) };
  }

  const absolute = new Set<number>();
  let dropped = 0;
  for (const pair of pairs) {
    const n = toAbsolute(seasons, pair);
    if (n === null) dropped += 1;
    else absolute.add(n);
  }
  return { absolute: [...absolute].sort((a, b) => a - b), dropped };
}

// ---------------------------------------------------------------------------
// Matching against the library
// ---------------------------------------------------------------------------

export type MatchedBy = "tmdbId" | "imdbId" | "tvdbId" | "title";

/** Every way an existing library can be looked up, built once per plan. */
export interface LibraryIndex {
  byTmdb: Map<number, TitleV4[]>;
  byImdb: Map<string, TitleV4>;
  byTvdb: Map<number, TitleV4>;
  byName: Map<string, TitleV4[]>;
}

function mediaKindOf(title: TitleV4): MediaType | undefined {
  if (title.tmdbMediaType) return title.tmdbMediaType;
  if (title.type === TYPE_MOVIE) return "movie";
  if (title.seasons.length > 0 || title.totalEpisodes > 1) return "tv";
  return undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function indexLibrary(titles: readonly TitleV4[]): LibraryIndex {
  const index: LibraryIndex = {
    byTmdb: new Map(),
    byImdb: new Map(),
    byTvdb: new Map(),
    byName: new Map(),
  };
  for (const title of titles) {
    if (title.tmdbId) push(index.byTmdb, title.tmdbId, title);
    if (title.imdbId && !index.byImdb.has(title.imdbId)) index.byImdb.set(title.imdbId, title);
    if (title.tvdbId && !index.byTvdb.has(title.tvdbId)) index.byTvdb.set(title.tvdbId, title);
    const name = normalizeTitle(title.title);
    if (name !== "") push(index.byName, name, title);
  }
  return index;
}

/** The year a title claims, from `year` or its release date. Mirrors `match.ts`. */
function yearOf(title: TitleV4): number | undefined {
  if (title.year && Number.isFinite(title.year)) return title.year;
  if (title.releaseDate) {
    const year = Number.parseInt(title.releaseDate.slice(0, 4), 10);
    if (Number.isFinite(year)) return year;
  }
  return undefined;
}

/** Same TMDB id, different namespace, is a different work — id 557 is two of them. */
function kindsAgree(record: ImportRecord, title: TitleV4): boolean {
  const theirs = mediaKindOf(title);
  if (record.mediaType === undefined || theirs === undefined) return true;
  return record.mediaType === theirs;
}

export interface RecordMatch {
  title: TitleV4;
  by: MatchedBy;
}

/**
 * Find the library entry a record is about, or nothing.
 *
 * Ids first and in confidence order, then the name. The last clause is the one
 * that matters: a name match is refused when the record and the title *both*
 * carry an id and the ids differ, because two works can share a name and only
 * one of them is the one the file meant.
 */
export function matchRecord(record: ImportRecord, index: LibraryIndex): RecordMatch | undefined {
  if (record.tmdbId !== undefined) {
    const candidates = (index.byTmdb.get(record.tmdbId) ?? []).filter((title) => kindsAgree(record, title));
    const hit = candidates[0];
    if (hit) return { title: hit, by: "tmdbId" };
  }
  if (record.imdbId !== undefined) {
    const hit = index.byImdb.get(record.imdbId);
    if (hit) return { title: hit, by: "imdbId" };
  }
  if (record.tvdbId !== undefined) {
    const hit = index.byTvdb.get(record.tvdbId);
    if (hit) return { title: hit, by: "tvdbId" };
  }

  const name = normalizeTitle(record.title);
  if (name === "") return undefined;
  for (const title of index.byName.get(name) ?? []) {
    if (!kindsAgree(record, title)) continue;
    if (!yearsAgree(record.year, yearOf(title) ?? null)) continue;
    // The record says TMDB 42 and this same-named title says TMDB 99: the name
    // is a coincidence and the ids are the evidence.
    if (record.tmdbId !== undefined && title.tmdbId && title.tmdbId !== record.tmdbId) continue;
    if (record.imdbId !== undefined && title.imdbId && title.imdbId !== record.imdbId) continue;
    return { title, by: "title" };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type ImportAction = "add" | "merge" | "skip";

export interface ImportPlanEntry {
  record: ImportRecord;
  action: ImportAction;
  /** Set for `merge` and `skip`: the library entry this record is about. */
  titleId?: string;
  matchedBy?: MatchedBy;
  /** What a merge would write. Empty for `add` and `skip`. */
  patch?: TitlePatch;
  /**
   * Set for `add`: the title as it would be created.
   *
   * Built here rather than at write time so the preview shows the actual object
   * and so a *later* record in the same file can match against it — two sources
   * imported one after another must not each add their own copy of Dune. Its
   * `id` is a placeholder and is reassigned against the live library on apply.
   */
  newTitle?: TitleV4;
  /** One human sentence per field the merge touches, for the preview. */
  changes: string[];
  /**
   * The match was another entry in this same plan, and its extra facts have
   * already been folded into that entry's `newTitle`.
   *
   * The action is `skip` because there is nothing separate to write, not because
   * nothing happened — importing a Trakt export and then a Simkl one must end
   * with one title carrying both files' ids, not with the second file ignored.
   */
  mergedIntoPlanned?: boolean;
  /** Episodes in the file this title's seasons cannot express. */
  droppedEpisodes: number;
}

export interface TrackerImportPlan {
  source: TrackerSource;
  entries: ImportPlanEntry[];
  warnings: string[];
  counts: { add: number; merge: number; skip: number; exact: number; byName: number };
}

/** Is this title's episode grid still the "nothing known yet" shape? */
function hasNoGeometry(title: TitleV4): boolean {
  return title.seasons.length === 0 && title.totalEpisodes <= 1;
}

/**
 * What a merge would write, and nothing more.
 *
 * Every branch is guarded by "is the library's value still empty" — the whole
 * point of this function is that it cannot produce a patch that replaces
 * something the user put there. The one exception is `watchedEpisodes`, and it
 * is a union: the result is always a superset of what was already marked.
 */
export function mergePatch(
  existing: TitleV4,
  record: ImportRecord,
  settings: Settings,
): { patch: TitlePatch; changes: string[]; dropped: number } {
  const patch: TitlePatch = {};
  const changes: string[] = [];

  if (!existing.tmdbId && record.tmdbId !== undefined) {
    patch.tmdbId = record.tmdbId;
    if (record.mediaType !== undefined) patch.tmdbMediaType = record.mediaType;
    changes.push(`TMDB id ${record.tmdbId}`);
  }
  if (!existing.imdbId && record.imdbId !== undefined) {
    patch.imdbId = record.imdbId;
    changes.push(`IMDb id ${record.imdbId}`);
  }
  if (!existing.tvdbId && record.tvdbId !== undefined) {
    patch.tvdbId = record.tvdbId;
    changes.push(`TVDB id ${record.tvdbId}`);
  }
  if (existing.year === undefined && record.year !== undefined) {
    patch.year = record.year;
    changes.push(`year ${record.year}`);
  }

  // A rating of 0 is this plugin's "unrated", so filling it in adds information
  // and never replaces an opinion. A rating the user already gave is theirs.
  if (existing.rating === 0 && record.rating !== undefined && record.rating > 0) {
    patch.rating = record.rating;
    changes.push(`rating ${record.rating}`);
  }
  if (existing.notes.trim() === "" && record.notes !== undefined && record.notes.trim() !== "") {
    patch.notes = record.notes;
    changes.push("notes");
  }
  if (existing.externalLink === "" && record.externalLink !== undefined && record.externalLink !== "") {
    patch.externalLink = record.externalLink;
    changes.push("link");
  }
  if (existing.episodeDuration === 0 && record.runtimeMinutes !== undefined && record.runtimeMinutes > 0) {
    patch.episodeDuration = record.runtimeMinutes;
    changes.push(`${record.runtimeMinutes} min per episode`);
  }
  if (existing.dateStarted === null && record.dateStarted !== undefined) {
    patch.dateStarted = record.dateStarted;
    changes.push(`started ${record.dateStarted}`);
  }
  if (existing.dateFinished === null && record.dateFinished !== undefined) {
    patch.dateFinished = record.dateFinished;
    changes.push(`finished ${record.dateFinished}`);
  }

  // Status moves only off the default. "Plan to watch" is what a title has when
  // nobody has said anything about it; anything else is a statement, and a file
  // does not get to overrule it.
  if (record.status !== undefined && existing.status === STATUS_PLAN_TO_WATCH) {
    const name = resolveStatusName(record.status, settings.statuses);
    if (name !== existing.status) {
      patch.status = name;
      changes.push(`status ${name}`);
    }
  }

  // Seasons are adopted only into a title that has none. Overwriting a real
  // season list with one derived from watch history would replace facts with a
  // guess, and would re-point every absolute episode number in the process.
  let seasons: readonly Season[] = existing.seasons;
  if (hasNoGeometry(existing) && record.mediaType === "tv") {
    const derived = deriveSeasons(record);
    if (derived.length > 0) {
      patch.seasons = derived;
      patch.totalEpisodes = derived.reduce((sum, season) => sum + season.episodes, 0);
      seasons = derived;
      changes.push(`${derived.length} season${derived.length === 1 ? "" : "s"}`);
    }
  }

  const expanded = expandEpisodes(record, seasons);
  const added = expanded.absolute.filter((n) => !existing.watchedEpisodes.includes(n));
  if (added.length > 0) {
    // Union, never replacement: an episode the user ticked off in the plugin and
    // never logged on the tracker stays ticked.
    patch.watchedEpisodes = [...new Set([...existing.watchedEpisodes, ...added])].sort((a, b) => a - b);
    changes.push(`${added.length} watched episode${added.length === 1 ? "" : "s"}`);
  }

  return { patch, changes, dropped: expanded.dropped };
}

/**
 * The title a record would create, through the frozen factory.
 *
 * `createTitle` and not an object literal — see the contract at the top of
 * `types.ts`. Every field below is one the record actually stated; nothing is
 * defaulted here that `createTitle` already defaults.
 */
export function buildTitle(record: ImportRecord, settings: Settings, id: string): TitleV4 {
  const type = typeNameForRecord(record, settings);
  const status = resolveStatusName(record.status ?? "planned", settings.statuses);
  const seasons = record.mediaType === "tv" ? deriveSeasons(record) : [];
  const total = seasons.reduce((sum, season) => sum + season.episodes, 0);
  const expanded = expandEpisodes(record, seasons);

  // A film has one episode, and a film that has been watched has watched it.
  // Without this a completed import sits at 0% on every card it appears on.
  const watched =
    record.mediaType !== "tv" && status === resolveStatusName("completed", settings.statuses)
      ? [1]
      : expanded.absolute;

  return createTitle({
    id,
    title: record.title,
    type,
    status,
    ...(record.rating !== undefined && record.rating > 0 ? { rating: record.rating } : {}),
    ...(record.year !== undefined ? { year: record.year } : {}),
    ...(record.dateStarted !== undefined ? { dateStarted: record.dateStarted } : {}),
    ...(record.dateFinished !== undefined ? { dateFinished: record.dateFinished } : {}),
    ...(record.tmdbId !== undefined ? { tmdbId: record.tmdbId } : {}),
    ...(record.mediaType !== undefined ? { tmdbMediaType: record.mediaType } : {}),
    ...(record.imdbId !== undefined ? { imdbId: record.imdbId } : {}),
    ...(record.tvdbId !== undefined ? { tvdbId: record.tvdbId } : {}),
    ...(record.notes !== undefined && record.notes !== "" ? { notes: record.notes } : {}),
    ...(record.externalLink !== undefined && record.externalLink !== "" ? { externalLink: record.externalLink } : {}),
    ...(record.runtimeMinutes !== undefined && record.runtimeMinutes > 0
      ? { episodeDuration: record.runtimeMinutes }
      : {}),
    ...(seasons.length > 0 ? { seasons, totalEpisodes: Math.max(1, total) } : {}),
    ...(watched.length > 0 ? { watchedEpisodes: watched } : {}),
  });
}

/** Register a planned addition so later records in the same run can find it. */
function indexOne(index: LibraryIndex, title: TitleV4): void {
  if (title.tmdbId) push(index.byTmdb, title.tmdbId, title);
  if (title.imdbId && !index.byImdb.has(title.imdbId)) index.byImdb.set(title.imdbId, title);
  if (title.tvdbId && !index.byTvdb.has(title.tvdbId)) index.byTvdb.set(title.tvdbId, title);
  const name = normalizeTitle(title.title);
  if (name !== "") push(index.byName, name, title);
}

export interface PlanOptions {
  /** Skip rows that match an existing title entirely. Default `false` (merge them). */
  skipExisting?: boolean;
}

/**
 * Build the plan.
 *
 * Records are matched against the library *and* against each other: a Trakt
 * export that lists a film in both the history and the watchlist has already
 * been merged by the parser, but two sources imported one after another have
 * not, and the second must see what the first is about to add. So each planned
 * `add` joins the index as it is decided.
 */
export function buildTrackerPlan(
  source: TrackerSource,
  records: readonly ImportRecord[],
  titles: readonly TitleV4[],
  settings: Settings,
  warnings: readonly string[] = [],
  options: PlanOptions = {},
): TrackerImportPlan {
  const index = indexLibrary(titles);
  /** The titles this plan has decided to create, by identity. */
  const planned = new Set<TitleV4>();
  const entries: ImportPlanEntry[] = [];
  const counts = { add: 0, merge: 0, skip: 0, exact: 0, byName: 0 };
  const notes = [...warnings];
  let partialProgress = 0;

  for (const record of records) {
    if (record.title.trim() === "") continue;
    const match = matchRecord(record, index);

    if (match === undefined) {
      const derived = record.mediaType === "tv" ? deriveSeasons(record) : [];
      const expanded = expandEpisodes(record, derived);
      if (expanded.partialHighWaterMark) partialProgress += 1;
      const newTitle = buildTitle(record, settings, `import-${entries.length + 1}`);
      indexOne(index, newTitle);
      planned.add(newTitle);
      entries.push({
        record,
        action: "add",
        newTitle,
        changes: [],
        droppedEpisodes: expanded.dropped,
      });
      counts.add += 1;
      if (record.tmdbId !== undefined || record.imdbId !== undefined) counts.exact += 1;
      else counts.byName += 1;
      continue;
    }

    if (match.by === "title") counts.byName += 1;
    else counts.exact += 1;

    // The match is a title this same plan is about to create, so there is no
    // store row to patch — the patch goes onto the pending object, in place.
    // Mutated rather than rebuilt: `createTitle` made it, and rebuilding one of
    // these from a literal is what `types.ts` forbids outright.
    if (planned.has(match.title)) {
      const folded = mergePatch(match.title, record, settings);
      Object.assign(match.title, folded.patch);
      entries.push({
        record,
        action: "skip",
        matchedBy: match.by,
        mergedIntoPlanned: true,
        changes: folded.changes,
        droppedEpisodes: folded.dropped,
      });
      counts.skip += 1;
      continue;
    }

    if (options.skipExisting) {
      entries.push({
        record,
        action: "skip",
        titleId: match.title.id,
        matchedBy: match.by,
        changes: [],
        droppedEpisodes: 0,
      });
      counts.skip += 1;
      continue;
    }

    const { patch, changes, dropped } = mergePatch(match.title, record, settings);
    if (changes.length === 0) {
      entries.push({
        record,
        action: "skip",
        titleId: match.title.id,
        matchedBy: match.by,
        changes: [],
        droppedEpisodes: dropped,
      });
      counts.skip += 1;
      continue;
    }
    entries.push({
      record,
      action: "merge",
      titleId: match.title.id,
      matchedBy: match.by,
      patch,
      changes,
      droppedEpisodes: dropped,
    });
    counts.merge += 1;
  }

  if (partialProgress > 0) {
    notes.push(
      `${partialProgress} new show${partialProgress === 1 ? "" : "s"} only state${partialProgress === 1 ? "s" : ""} the last episode watched, so seasons before it stay unwatched until the show's details are fetched.`,
    );
  }
  const droppedTotal = entries.reduce((sum, entry) => sum + entry.droppedEpisodes, 0);
  if (droppedTotal > 0) {
    notes.push(
      `${droppedTotal} watched episode${droppedTotal === 1 ? "" : "s"} could not be placed in an existing season list and will be left out.`,
    );
  }

  return { source, entries, warnings: notes, counts };
}
