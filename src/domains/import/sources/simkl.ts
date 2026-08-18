/**
 * Simkl.
 *
 * One CSV from Settings → "Download backup (CSV format)":
 *
 *     SIMKL_ID,Title,Type,Year,Watchlist,LastEpWatched,WatchedDate,Rating,Memo,TVDB,TMDB,IMDB
 *
 * Simkl is the richest of the CSV sources: it carries **both** external ids and
 * per-episode progress, which no other flat export does.
 *
 * `LastEpWatched` is the per-episode column, and it is a *high-water mark*
 * rather than a list — `S03E07` means "everything up to and including S03E07".
 * That is exactly how a plugin whose `watchedEpisodes` is a contiguous prefix
 * wants to be told, and it is why this parser expands it into episodes rather
 * than storing the string: the expansion needs a season geometry, and only the
 * plan step (which can see the existing title, or derive one) has it. So the
 * record carries the pairs implied by the mark, and `plan.ts` maps them.
 *
 * A row with no `LastEpWatched` but a Completed status is *also* fully watched,
 * and there is nothing in the CSV that says how many episodes that is. Those
 * rows import their status and let the episode grid fill in when TMDB does.
 */
import { parseCsv } from "../../../data/csv";
import {
  cell,
  findColumn,
  parseDateOnly,
  parseImdbId,
  parseNumericId,
  parseYear,
  stripBom,
} from "../columns";
import {
  convertRating,
  RATING_SCALES,
  type ImportEpisode,
  type ImportRecord,
  type ImportStatus,
  type ParsedExport,
} from "../types";
import type { MediaType } from "../../../types";

/**
 * Expand Simkl's `S03E07` high-water mark into every episode up to it.
 *
 * Seasons before the marked one are taken whole, at the length the mark itself
 * cannot state — so they are left to the plan step, which knows the real season
 * lengths when the title already exists and derives them when it does not.
 * What this returns is therefore the *mark*, expressed as a pair, plus every
 * episode of the marked season up to it. See `expandProgress` in `plan.ts`.
 */
export function parseLastEpisode(raw: string): ImportEpisode | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const se = /^s\s*(\d{1,3})\s*[ex._-]\s*(\d{1,4})$/i.exec(text);
  if (se) {
    const season = Number(se[1]);
    const episode = Number(se[2]);
    if (season > 0 && episode > 0) return { season, episode };
    return undefined;
  }
  // `12` on a show with no season syntax means episode 12 of season 1.
  const bare = /^(\d{1,4})$/.exec(text);
  if (bare) {
    const episode = Number(bare[1]);
    if (episode > 0) return { season: 1, episode };
  }
  return undefined;
}

/** Simkl's `Watchlist` column. Empty means "watched", which is the backup's default. */
export function simklStatus(raw: string): ImportStatus {
  const text = raw.trim().toLowerCase();
  if (text.includes("watching")) return "watching";
  if (text.includes("plan") || text.includes("ptw")) return "planned";
  if (text.includes("hold")) return "on-hold";
  if (text.includes("drop")) return "dropped";
  return "completed";
}

function simklMediaType(raw: string): MediaType | null {
  const text = raw.trim().toLowerCase();
  if (text.includes("movie") || text.includes("film")) return "movie";
  if (text.includes("tv") || text.includes("show") || text.includes("series") || text.includes("anime")) {
    return "tv";
  }
  return null;
}

export function parseSimkl(text: string): ParsedExport {
  const rows = parseCsv(stripBom(text));
  const headers = rows[0];
  const warnings: string[] = [];
  if (!headers) return { source: "simkl", records: [], warnings: ["That file is empty."] };

  const titleAt = findColumn(headers, "title", "name");
  if (titleAt < 0) {
    return {
      source: "simkl",
      records: [],
      warnings: ["No Title column — this does not look like a Simkl backup CSV."],
    };
  }
  const typeAt = findColumn(headers, "type");
  const yearAt = findColumn(headers, "year");
  const statusAt = findColumn(headers, "watchlist", "status");
  const lastEpAt = findColumn(headers, "lastepwatched", "last ep watched", "last episode");
  const dateAt = findColumn(headers, "watcheddate", "watched date", "last watched");
  const ratingAt = findColumn(headers, "rating");
  const memoAt = findColumn(headers, "memo", "comment");
  const tmdbAt = findColumn(headers, "tmdb");
  const imdbAt = findColumn(headers, "imdb");
  const tvdbAt = findColumn(headers, "tvdb");

  const records: ImportRecord[] = [];
  let unknownType = 0;

  for (const row of rows.slice(1)) {
    const title = cell(row, titleAt);
    if (title === "") continue;

    const rawType = typeAt >= 0 ? cell(row, typeAt) : "";
    const mediaType = simklMediaType(rawType);
    if (typeAt >= 0 && mediaType === null && rawType !== "") {
      unknownType += 1;
      continue;
    }

    const status = simklStatus(statusAt >= 0 ? cell(row, statusAt) : "");
    const rawRating = ratingAt >= 0 ? Number(cell(row, ratingAt)) : NaN;
    const rating = convertRating(rawRating, RATING_SCALES.simkl);
    const watchedAt = dateAt >= 0 ? parseDateOnly(cell(row, dateAt)) : undefined;
    const lastEpisode = lastEpAt >= 0 ? parseLastEpisode(cell(row, lastEpAt)) : undefined;
    const memo = memoAt >= 0 ? cell(row, memoAt) : "";

    records.push({
      source: "simkl",
      title,
      ...(yearAt >= 0 ? optionalYear(cell(row, yearAt)) : {}),
      ...(mediaType !== null ? { mediaType } : {}),
      status,
      ...(rating !== undefined ? { rating, ratingRaw: { value: rawRating, scale: RATING_SCALES.simkl } } : {}),
      ...(watchedAt !== undefined && (status === "completed" || status === "dropped")
        ? { dateFinished: watchedAt }
        : {}),
      ...(tmdbAt >= 0 ? optionalTmdb(cell(row, tmdbAt)) : {}),
      ...(imdbAt >= 0 ? optionalImdb(cell(row, imdbAt)) : {}),
      ...(tvdbAt >= 0 ? optionalTvdb(cell(row, tvdbAt)) : {}),
      // The mark is the *last* episode watched, so it is both the progress and
      // the only episode this file names. `plan.ts` fills in everything before it.
      ...(lastEpisode !== undefined ? { episodes: [lastEpisode], progressIsHighWaterMark: true } : {}),
      ...(memo !== "" ? { notes: memo } : {}),
    });
  }

  if (unknownType > 0) {
    warnings.push(`${unknownType} row${unknownType === 1 ? "" : "s"} skipped: the Type column said something other than movie, tv or anime.`);
  }
  if (tmdbAt < 0 && imdbAt < 0) {
    warnings.push("This backup has no TMDB or IMDB column, so every row has to be matched by name.");
  }

  return { source: "simkl", records, warnings };
}

function optionalYear(raw: string): { year?: number } {
  const year = parseYear(raw);
  return year === undefined ? {} : { year };
}

function optionalTmdb(raw: string): { tmdbId?: number } {
  const id = parseNumericId(raw);
  return id === undefined ? {} : { tmdbId: id };
}

function optionalTvdb(raw: string): { tvdbId?: number } {
  const id = parseNumericId(raw);
  return id === undefined ? {} : { tvdbId: id };
}

function optionalImdb(raw: string): { imdbId?: string } {
  const id = parseImdbId(raw);
  return id === undefined ? {} : { imdbId: id };
}
