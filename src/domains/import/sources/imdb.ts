/**
 * IMDb.
 *
 * One CSV per list, from the Export button on Your Ratings or any watchlist:
 *
 *     Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,
 *     IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
 *
 * A plain watchlist export drops `Your Rating`/`Date Rated` and adds `Created`
 * and `Modified`, so every column but `Const` and `Title` is treated as optional.
 *
 * The valuable column is `Const`: **`tt0111161` is an exact identity**, which is
 * the difference between an import that lands on the right film and one that
 * guesses. It goes straight onto the title, where the Plex GUID index
 * (`imdb://tt0111161`) and the TMDB backfill can both use it without a search.
 *
 * `Title Type` is IMDb's own vocabulary — `movie`, `tvSeries`, `tvMiniSeries`,
 * `short`, `tvEpisode`, `video`, `videoGame`. Episodes are dropped rather than
 * imported: this plugin tracks works, and a row for one rated episode of a show
 * would arrive as a separate title with the episode's name.
 */
import { parseCsv } from "../../../data/csv";
import { cell, findColumn, parseDateOnly, parseImdbId, parseYear, stripBom } from "../columns";
import { convertRating, RATING_SCALES, type ImportRecord, type ParsedExport } from "../types";
import type { MediaType } from "../../../types";

/** IMDb's `Title Type` → this plugin's media kind. `null` means "do not import". */
export function imdbMediaType(raw: string): MediaType | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  if (text.includes("episode")) return null;
  if (text.includes("videogame") || text.includes("video game")) return null;
  if (text.includes("series")) return "tv";
  if (text.includes("movie") || text.includes("short") || text.includes("video")) return "movie";
  return null;
}

export function parseImdb(text: string): ParsedExport {
  const rows = parseCsv(stripBom(text));
  const headers = rows[0];
  const warnings: string[] = [];
  if (!headers) return { source: "imdb", records: [], warnings: ["That file is empty."] };

  const titleAt = findColumn(headers, "title", "original title", "name");
  if (titleAt < 0) {
    return {
      source: "imdb",
      records: [],
      warnings: ["No Title column — this does not look like an IMDb export CSV."],
    };
  }
  const constAt = findColumn(headers, "const", "imdb id", "tconst");
  const typeAt = findColumn(headers, "title type", "type");
  const yearAt = findColumn(headers, "year");
  const urlAt = findColumn(headers, "url");
  // `Your Rating` before `Rating`: `IMDb Rating` is the crowd's, not the user's,
  // and importing it as a personal rating would be a fabrication.
  const ratingAt = findColumn(headers, "your rating");
  const dateAt = findColumn(headers, "date rated", "created", "date added");
  const runtimeAt = findColumn(headers, "runtime (mins)", "runtime");

  const records: ImportRecord[] = [];
  let skippedEpisodes = 0;
  let skippedOther = 0;

  for (const row of rows.slice(1)) {
    const title = cell(row, titleAt);
    if (title === "") continue;

    const rawType = typeAt >= 0 ? cell(row, typeAt) : "";
    const mediaType = imdbMediaType(rawType);
    if (mediaType === null) {
      // An export with no Title Type column at all is a watchlist; nothing has
      // been said about the kind, and that is a record without `mediaType`
      // rather than a skipped row.
      if (typeAt < 0) {
        records.push(buildRecord(row, title, undefined));
        continue;
      }
      if (rawType.toLowerCase().includes("episode")) skippedEpisodes += 1;
      else skippedOther += 1;
      continue;
    }
    records.push(buildRecord(row, title, mediaType));
  }

  function buildRecord(
    row: readonly string[],
    title: string,
    mediaType: MediaType | undefined,
  ): ImportRecord {
    const imdbId = constAt >= 0 ? parseImdbId(cell(row, constAt)) : undefined;
    const year = yearAt >= 0 ? parseYear(cell(row, yearAt)) : undefined;
    const rawRating = ratingAt >= 0 ? Number(cell(row, ratingAt)) : NaN;
    const rating = convertRating(rawRating, RATING_SCALES.imdb);
    const date = dateAt >= 0 ? parseDateOnly(cell(row, dateAt)) : undefined;
    const runtime = runtimeAt >= 0 ? Number(cell(row, runtimeAt)) : NaN;
    const url = urlAt >= 0 ? cell(row, urlAt) : "";

    return {
      source: "imdb",
      title,
      ...(year !== undefined ? { year } : {}),
      ...(mediaType !== undefined ? { mediaType } : {}),
      // A ratings export is a list of things watched; a watchlist export has no
      // rating column at all and is a list of things to watch.
      status: ratingAt >= 0 ? "completed" : "planned",
      ...(rating !== undefined ? { rating, ratingRaw: { value: rawRating, scale: RATING_SCALES.imdb } } : {}),
      ...(ratingAt >= 0 && date !== undefined ? { dateFinished: date } : {}),
      ...(imdbId !== undefined ? { imdbId } : {}),
      ...(Number.isFinite(runtime) && runtime > 0 ? { runtimeMinutes: runtime } : {}),
      ...(url !== "" ? { externalLink: url } : {}),
    };
  }

  if (skippedEpisodes > 0) {
    warnings.push(
      `${skippedEpisodes} individual episode rating${skippedEpisodes === 1 ? "" : "s"} skipped — this plugin rates shows, not episodes.`,
    );
  }
  if (skippedOther > 0) {
    warnings.push(`${skippedOther} row${skippedOther === 1 ? "" : "s"} skipped: not a film or a series.`);
  }
  if (constAt < 0) {
    warnings.push("No Const column, so nothing carries an IMDb id — every row has to be matched by name.");
  }

  return { source: "imdb", records, warnings };
}
