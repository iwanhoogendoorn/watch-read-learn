/**
 * Trakt.
 *
 * The only source that ships an archive, and the only one whose facts about a
 * single work are spread across several files:
 *
 *     watched-movies.json        last watch per film
 *     watched-shows.json         last watch per show, plus `aired_episodes`
 *     watched-history-N.json     every watch *event*, films and episodes
 *     ratings-movies.json        the user's ratings, out of 10
 *     ratings-shows.json
 *     lists-watchlist.json       things not watched yet
 *
 * So the parser is a merge: every file contributes to a `Draft` keyed by
 * `movie:<trakt id>` / `show:<trakt id>`, and only at the end does a draft
 * become a record. Reading `ratings-movies.json` alone would produce a library
 * where nothing is watched; reading `watched-movies.json` alone would produce
 * one where nothing is rated.
 *
 * Trakt's `ids` block is the good part: `{trakt, slug, imdb, tmdb, tvdb}`. An
 * entry usually has all of them, and **often has an IMDb id but no TMDB one** —
 * older or more obscure entries in particular. Both are carried, because either
 * is an exact identity here: TMDB is what the plugin keys on, and IMDb is what
 * both the Plex GUID index and TMDB's own `/find` resolve from.
 *
 * `watched-history-*.json` is the only file with episode numbers, and it is a
 * list of *events* — a rewatch appears twice, and a partial watch appears with
 * only the episodes actually seen. It is deduplicated, never expanded: unlike
 * Simkl's high-water mark, a gap in Trakt's history is a real gap.
 */
import { parseDateOnly, parseNumericId, parseImdbId } from "../columns";
import {
  convertRating,
  RATING_SCALES,
  type ImportEpisode,
  type ImportRecord,
  type ParsedExport,
} from "../types";
import type { DateString, MediaType } from "../../../types";

interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

interface TraktWork {
  title?: string;
  year?: number | null;
  ids?: TraktIds;
  aired_episodes?: number;
}

interface Draft {
  kind: MediaType;
  title: string;
  year?: number;
  ids: TraktIds;
  airedEpisodes?: number;
  lastWatched?: DateString;
  firstWatched?: DateString;
  rating?: number;
  ratingRaw?: { value: number; scale: number };
  watched: boolean;
  planned: boolean;
  episodes: Map<string, ImportEpisode>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Files whose basename this parser knows, whatever folder Trakt nested them in. */
export function isTraktFile(name: string): boolean {
  const base = name.toLowerCase();
  return (
    base === "watched-movies.json" ||
    base === "watched-shows.json" ||
    base === "ratings-movies.json" ||
    base === "ratings-shows.json" ||
    base === "lists-watchlist.json" ||
    /^watched-history(-\d+)?\.json$/.test(base)
  );
}

function keyOf(kind: MediaType, work: TraktWork): string | null {
  const ids = work.ids ?? {};
  const trakt = parseNumericId(ids.trakt);
  if (trakt !== undefined) return `${kind}:trakt:${trakt}`;
  const tmdb = parseNumericId(ids.tmdb);
  if (tmdb !== undefined) return `${kind}:tmdb:${tmdb}`;
  const imdb = parseImdbId(String(ids.imdb ?? ""));
  if (imdb !== undefined) return `${kind}:imdb:${imdb}`;
  const title = String(work.title ?? "").trim().toLowerCase();
  if (title === "") return null;
  return `${kind}:name:${title}|${work.year ?? ""}`;
}

/** Get or create the draft for a work, merging in whatever ids this file knew. */
function draftFor(drafts: Map<string, Draft>, kind: MediaType, work: TraktWork): Draft | null {
  const key = keyOf(kind, work);
  if (key === null) return null;
  const existing = drafts.get(key);
  const draft: Draft = existing ?? {
    kind,
    title: String(work.title ?? "").trim(),
    ids: {},
    watched: false,
    planned: false,
    episodes: new Map(),
  };
  if (draft.title === "") draft.title = String(work.title ?? "").trim();

  const ids = work.ids ?? {};
  // Ids accumulate across files: `lists-watchlist.json` may carry a tmdb id that
  // `watched-shows.json` did not, and vice versa. First non-empty wins, so a
  // later file cannot overwrite an id with a blank.
  draft.ids.trakt ??= parseNumericId(ids.trakt);
  draft.ids.tmdb ??= parseNumericId(ids.tmdb);
  draft.ids.tvdb ??= parseNumericId(ids.tvdb);
  draft.ids.imdb ??= parseImdbId(String(ids.imdb ?? ""));
  draft.ids.slug ??= typeof ids.slug === "string" && ids.slug !== "" ? ids.slug : undefined;

  if (draft.year === undefined && typeof work.year === "number" && Number.isFinite(work.year)) {
    draft.year = work.year;
  }
  const aired = parseNumericId(work.aired_episodes);
  if (aired !== undefined && (draft.airedEpisodes === undefined || aired > draft.airedEpisodes)) {
    draft.airedEpisodes = aired;
  }

  drafts.set(key, draft);
  return draft;
}

function noteWatch(draft: Draft, at: DateString | undefined): void {
  draft.watched = true;
  if (at === undefined) return;
  if (draft.lastWatched === undefined || at > draft.lastWatched) draft.lastWatched = at;
  if (draft.firstWatched === undefined || at < draft.firstWatched) draft.firstWatched = at;
}

function readWatched(text: string, kind: MediaType, drafts: Map<string, Draft>): void {
  const field = kind === "movie" ? "movie" : "show";
  for (const raw of asArray(JSON.parse(text))) {
    const row = raw as Record<string, unknown>;
    const work = row[field] as TraktWork | undefined;
    if (!work) continue;
    const draft = draftFor(drafts, kind, work);
    if (!draft) continue;
    noteWatch(draft, parseDateOnly(String(row.last_watched_at ?? "")));
  }
}

function readRatings(text: string, kind: MediaType, drafts: Map<string, Draft>): void {
  const field = kind === "movie" ? "movie" : "show";
  for (const raw of asArray(JSON.parse(text))) {
    const row = raw as Record<string, unknown>;
    const work = row[field] as TraktWork | undefined;
    if (!work) continue;
    const draft = draftFor(drafts, kind, work);
    if (!draft) continue;
    const value = Number(row.rating ?? NaN);
    const rating = convertRating(value, RATING_SCALES.trakt);
    if (rating !== undefined) {
      draft.rating = rating;
      draft.ratingRaw = { value, scale: RATING_SCALES.trakt };
    }
  }
}

function readWatchlist(text: string, drafts: Map<string, Draft>): void {
  for (const raw of asArray(JSON.parse(text))) {
    const row = raw as Record<string, unknown>;
    const movie = row.movie as TraktWork | undefined;
    const show = row.show as TraktWork | undefined;
    const kind: MediaType | null = movie ? "movie" : show ? "tv" : null;
    if (kind === null) continue;
    const draft = draftFor(drafts, kind, (movie ?? show) as TraktWork);
    if (draft) draft.planned = true;
  }
}

function readHistory(text: string, drafts: Map<string, Draft>): void {
  for (const raw of asArray(JSON.parse(text))) {
    const row = raw as Record<string, unknown>;
    const type = String(row.type ?? "").toLowerCase();
    const at = parseDateOnly(String(row.watched_at ?? ""));

    if (type === "movie") {
      const movie = row.movie as TraktWork | undefined;
      if (!movie) continue;
      const draft = draftFor(drafts, "movie", movie);
      if (draft) noteWatch(draft, at);
      continue;
    }
    if (type !== "episode") continue;

    const show = row.show as TraktWork | undefined;
    if (!show) continue;
    const draft = draftFor(drafts, "tv", show);
    if (!draft) continue;
    noteWatch(draft, at);

    const episode = row.episode as { season?: number; number?: number } | undefined;
    const season = episode?.season;
    const number = episode?.number;
    // Season 0 is Trakt's specials bucket. It has no place in an absolute
    // episode numbering that TMDB will later restate without it, and admitting
    // one would shift every later episode by one.
    if (typeof season !== "number" || typeof number !== "number") continue;
    if (season < 1 || number < 1) continue;
    // A rewatch is a second event for the same episode, not a second episode.
    draft.episodes.set(`${season}x${number}`, { season, episode: number });
  }
}

/**
 * Parse a Trakt export.
 *
 * `files` is basename → text, which is what `entriesByName(readZip(...))`
 * produces; the folder Trakt nests everything in is not load-bearing.
 */
export function parseTrakt(files: ReadonlyMap<string, string>): ParsedExport {
  const drafts = new Map<string, Draft>();
  const warnings: string[] = [];
  let read = 0;

  for (const [name, text] of files) {
    const base = name.toLowerCase();
    if (!isTraktFile(base)) continue;
    try {
      if (base === "watched-movies.json") readWatched(text, "movie", drafts);
      else if (base === "watched-shows.json") readWatched(text, "tv", drafts);
      else if (base === "ratings-movies.json") readRatings(text, "movie", drafts);
      else if (base === "ratings-shows.json") readRatings(text, "tv", drafts);
      else if (base === "lists-watchlist.json") readWatchlist(text, drafts);
      else readHistory(text, drafts);
      read += 1;
    } catch {
      warnings.push(`${name} is not valid JSON and was skipped.`);
    }
  }

  if (read === 0) {
    return {
      source: "trakt",
      records: [],
      warnings: [
        "None of Trakt's export files were found (watched-movies.json, watched-shows.json, watched-history-*.json, ratings-*.json, lists-watchlist.json).",
      ],
    };
  }

  const records: ImportRecord[] = [];
  let imdbOnly = 0;
  let noId = 0;

  for (const draft of drafts.values()) {
    if (draft.title === "") continue;
    const episodes = [...draft.episodes.values()].sort(
      (a, b) => a.season - b.season || a.episode - b.episode,
    );
    // Trakt has no explicit "watching" — it is watched-but-not-all-of-it. With
    // `aired_episodes` to compare against, that is a fact rather than a guess.
    const aired = draft.airedEpisodes;
    const complete =
      draft.kind === "movie" ||
      aired === undefined ||
      (episodes.length > 0 && episodes.length >= aired);
    const status = draft.watched ? (complete ? "completed" : "watching") : "planned";

    if (draft.ids.tmdb === undefined && draft.ids.imdb !== undefined) imdbOnly += 1;
    if (draft.ids.tmdb === undefined && draft.ids.imdb === undefined) noId += 1;

    records.push({
      source: "trakt",
      title: draft.title,
      ...(draft.year !== undefined ? { year: draft.year } : {}),
      mediaType: draft.kind,
      status,
      ...(draft.rating !== undefined ? { rating: draft.rating } : {}),
      ...(draft.ratingRaw !== undefined ? { ratingRaw: draft.ratingRaw } : {}),
      ...(draft.watched && draft.firstWatched !== undefined ? { dateStarted: draft.firstWatched } : {}),
      ...(status === "completed" && draft.lastWatched !== undefined
        ? { dateFinished: draft.lastWatched }
        : {}),
      ...(draft.ids.tmdb !== undefined ? { tmdbId: draft.ids.tmdb } : {}),
      ...(draft.ids.imdb !== undefined ? { imdbId: draft.ids.imdb } : {}),
      ...(draft.ids.tvdb !== undefined ? { tvdbId: draft.ids.tvdb } : {}),
      ...(draft.ids.trakt !== undefined ? { traktId: draft.ids.trakt } : {}),
      ...(draft.ids.slug !== undefined
        ? { externalLink: `https://trakt.tv/${draft.kind === "movie" ? "movies" : "shows"}/${draft.ids.slug}` }
        : {}),
      ...(episodes.length > 0 ? { episodes } : {}),
      ...(aired !== undefined ? { airedEpisodes: aired } : {}),
    });
  }

  if (imdbOnly > 0) {
    warnings.push(
      `${imdbOnly} entr${imdbOnly === 1 ? "y has" : "ies have"} an IMDb id but no TMDB one; they are still matched exactly, through the IMDb id.`,
    );
  }
  if (noId > 0) {
    warnings.push(`${noId} entr${noId === 1 ? "y has" : "ies have"} no external id and can only be matched by name.`);
  }

  return { source: "trakt", records, warnings };
}
