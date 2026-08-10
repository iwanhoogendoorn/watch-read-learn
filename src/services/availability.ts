/**
 * TMDB id → Plex item, and the `TitleV4.plex` cache that falls out of it.
 *
 * Three matchers, cheapest first (SPEC §4.1):
 *
 *   1. **Overseerr's `ratingKey`.** Once Plex sync has run, `mediaInfo` hands us
 *      the Plex identifier outright and there is nothing to match at all.
 *   2. **The local GUID index.** Plex cannot be queried by TMDB id — `?guid=`
 *      compares against the primary `guid` attribute, which on modern agents is
 *      always `plex://…`. So we pull every movie/show once with
 *      `includeGuids=1` (140 movies ≈ 325 KB in under a second) and index every
 *      `tmdb://` / `imdb://` / `tvdb://` child.
 *   3. **Fuzzy search, then confirm.** `/hubs/search` finds what `?title=` can't,
 *      but a hit is never trusted on its own: it is confirmed against a shared
 *      external id, or against normalised title **and** year. An unconfirmed
 *      match would put an "On Plex" badge on the wrong film.
 *
 * The index is invalidated on a section's `scannedAt`/`updatedAt` changing, not
 * on a timer — a library that has not been scanned cannot have changed.
 */
import type {
  IsoTimestamp,
  OverseerrMediaInfo,
  PlexCache,
  PlexGuidIndex,
  PlexIndexEntry,
  PlexSection,
  PlexState,
  TitleV4,
} from "../types";
import { expectedEpisodes } from "../data/episodes";
import { guidValue, type PlexClientEx, type PlexIndexedItem } from "./plex";

export interface PlexIndex {
  /** `tmdb://1064213` → the movie or **show** it belongs to. */
  guids: PlexGuidIndex;
  /** Section key → the `scannedAt`/`updatedAt` it was built from. */
  sectionStamps: Record<string, number>;
  itemCount: number;
  builtAt: IsoTimestamp;
}

export type MatchVia = "overseerr" | "guid" | "search";

export interface PlexMatch {
  entry: PlexIndexEntry;
  via: MatchVia;
}

export interface AvailabilityDeps {
  plex: PlexClientEx;
  /** Server `machineIdentifier`, stamped into the cache for deep links. */
  getMachineId?: () => string;
  /** Injected so tests get deterministic `checkedAt` stamps. */
  now?: () => Date;
}

export interface RefreshOptions {
  /** Overseerr's `mediaInfo` for this title, when the caller already has it. */
  mediaInfo?: OverseerrMediaInfo | undefined;
  /** Skip the fuzzy fallback — used by bulk refreshes to stay cheap. */
  skipSearch?: boolean;
}

/** Accent- and punctuation-insensitive title key, for fuzzy confirmation. */
export function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every GUID this title could be indexed under, in confidence order. */
export function guidKeysForTitle(title: TitleV4): string[] {
  const keys: string[] = [];
  if (title.tmdbId) keys.push(`tmdb://${title.tmdbId}`);
  if (title.imdbId) keys.push(`imdb://${title.imdbId}`);
  if (title.tvdbId) keys.push(`tvdb://${title.tvdbId}`);
  return keys;
}

function stampOf(section: PlexSection): number {
  return Math.max(section.scannedAt ?? 0, section.updatedAt ?? 0);
}

/**
 * Does the candidate really refer to this title?
 *
 * A shared external id settles it. Otherwise the normalised titles must match
 * and, when both sides know a year, they must be within one — release years
 * disagree by a year across providers often enough that an exact test would
 * reject good matches, and a two-year window starts pulling in remakes.
 */
export function confirmsMatch(title: TitleV4, candidate: PlexIndexedItem): boolean {
  const wanted = new Set(guidKeysForTitle(title));
  if (candidate.guids.some((guid) => wanted.has(guid))) return true;

  // A candidate that advertises a *different* tmdb id is a positive mismatch,
  // not merely unconfirmed.
  if (title.tmdbId) {
    const candidateTmdb = candidate.guids
      .map((g) => guidValue(g, "tmdb"))
      .find((v): v is string => v !== undefined);
    if (candidateTmdb !== undefined && candidateTmdb !== String(title.tmdbId)) return false;
  }

  if (normalizeTitle(candidate.title) !== normalizeTitle(title.title)) return false;

  const titleYear = title.year ?? (title.releaseDate ? Number(title.releaseDate.slice(0, 4)) : undefined);
  if (titleYear && candidate.year) return Math.abs(candidate.year - titleYear) <= 1;
  return true;
}

/**
 * Availability state for a show.
 *
 * `leafCount` — what is on disk — is the truth. It is compared against the
 * episode count we believe exists upstream, preferring the airing engine's
 * number over the user's own season maths, because a show can be fully
 * downloaded while the tracker is a season behind.
 */
export function showState(present: number, expected: number): PlexState {
  if (present <= 0) return "none";
  if (expected > 0 && present >= expected) return "available";
  return "partial";
}

/**
 * Episodes we believe exist upstream, for the partial/available decision.
 *
 * Lives in `data/episodes.ts` (it is pure episode maths, and the card pills need
 * the same number so state and label cannot disagree) and is re-exported here
 * because availability is where it is conceptually owned.
 */
export { expectedEpisodes } from "../data/episodes";

export function createAvailabilityService(deps: AvailabilityDeps) {
  const { plex } = deps;
  const now = deps.now ?? (() => new Date());
  let index: PlexIndex | undefined;

  async function buildIndex(): Promise<PlexIndex> {
    const sections = await plex.indexableSections();
    const guids: PlexGuidIndex = new Map();
    const sectionStamps: Record<string, number> = {};
    let itemCount = 0;

    for (const section of sections) {
      sectionStamps[section.key] = stampOf(section);
      const items = await plex.sectionItems(section);
      itemCount += items.length;
      for (const item of items) {
        // One item is indexed under all of its ids — imdb and tvdb are free
        // fallbacks for the titles TMDB never filled in.
        for (const guid of item.guids) {
          if (!guids.has(guid)) guids.set(guid, item);
        }
      }
    }

    index = { guids, sectionStamps, itemCount, builtAt: now().toISOString() };
    return index;
  }

  /** True when a section has been scanned since the index was built. */
  async function isIndexStale(): Promise<boolean> {
    if (!index) return true;
    const sections = await plex.indexableSections();
    if (sections.length !== Object.keys(index.sectionStamps).length) return true;
    return sections.some((section) => index?.sectionStamps[section.key] !== stampOf(section));
  }

  async function ensureIndex(force = false): Promise<PlexIndex> {
    if (!force && index) return index;
    return buildIndex();
  }

  function lookupGuid(title: TitleV4): PlexIndexEntry | undefined {
    if (!index) return undefined;
    for (const key of guidKeysForTitle(title)) {
      const hit = index.guids.get(key);
      if (hit) return hit;
    }
    return undefined;
  }

  async function match(title: TitleV4, options: RefreshOptions = {}): Promise<PlexMatch | undefined> {
    // 1. Overseerr already knows the Plex item — no matching required at all.
    const ratingKey = options.mediaInfo?.ratingKey;
    if (ratingKey) {
      const entry = await plex.metadata(ratingKey);
      if (entry) return { entry, via: "overseerr" };
    }

    // 2. The local GUID index.
    await ensureIndex();
    const indexed = lookupGuid(title);
    if (indexed) return { entry: indexed, via: "guid" };

    // 3. Fuzzy, then confirm.
    if (options.skipSearch) return undefined;
    const wantedType = title.totalEpisodes > 1 || title.seasons.length > 1 ? "show" : undefined;
    const candidates = await plex.search(title.title);
    for (const candidate of candidates) {
      if (wantedType && candidate.type !== wantedType) continue;
      if (confirmsMatch(title, candidate)) {
        // `/hubs/search` results carry no `leafCount`, so a confirmed show is
        // re-read from `/library/metadata/{rk}` to get one.
        const full = candidate.type === "show" ? await plex.metadata(candidate.ratingKey) : undefined;
        return { entry: full ?? candidate, via: "search" };
      }
    }
    return undefined;
  }

  /**
   * The `TitleV4.plex` cache for one title.
   *
   * Never throws: an unreachable Plex leaves the state at `unknown` (which the
   * UI renders as "no badge"), because a network blip must not silently
   * downgrade a title to "not on Plex".
   */
  async function refreshTitle(title: TitleV4, options: RefreshOptions = {}): Promise<PlexCache> {
    const checkedAt = now().toISOString();
    if (!plex.configured()) {
      return { state: "unknown", checkedAt };
    }

    let found: PlexMatch | undefined;
    try {
      found = await match(title, options);
    } catch {
      // `unknown`, not `none`: a timeout is not evidence of absence.
      return { state: "unknown", checkedAt };
    }

    if (!found) return { state: "none", checkedAt };

    const machineId = deps.getMachineId?.() ?? "";
    const cache: PlexCache = {
      state: "available",
      ratingKey: found.entry.ratingKey,
      checkedAt,
      ...(machineId ? { machineId } : {}),
    };

    if (found.entry.type === "movie") return cache;

    // TV: `allLeaves` in one call gives every episode present on disk, as
    // `{parentIndex, index}` — the season grid's per-episode dots.
    let episodes: { s: number; e: number }[] = [];
    try {
      episodes = (await plex.allLeaves(found.entry.ratingKey)).map((ep) => ({ s: ep.s, e: ep.e }));
    } catch {
      // Fall back to the show-level count; a partial answer beats none.
      episodes = [];
    }

    const leafCount = found.entry.leafCount ?? episodes.length;
    cache.episodes = episodes;
    cache.leafCount = leafCount;
    cache.state = showState(Math.max(leafCount, episodes.length), expectedEpisodes(title));
    return cache;
  }

  /** Has this title's Plex state gone stale? `plexTtlHours` from settings. */
  function needsRefresh(title: TitleV4, ttlHours: number, at: Date = now()): boolean {
    const checkedAt = title.plex?.checkedAt;
    if (!checkedAt) return true;
    const age = at.getTime() - new Date(checkedAt).getTime();
    if (!Number.isFinite(age)) return true;
    return age >= Math.max(0, ttlHours) * 3600_000;
  }

  return {
    buildIndex,
    ensureIndex,
    isIndexStale,
    getIndex: (): PlexIndex | undefined => index,
    match,
    refreshTitle,
    needsRefresh,
  };
}

export type AvailabilityService = ReturnType<typeof createAvailabilityService>;
