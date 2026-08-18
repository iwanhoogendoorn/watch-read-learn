/**
 * Letterboxd.
 *
 * Films only, and the export is a zip of small CSVs — `watched.csv`,
 * `ratings.csv`, `diary.csv`, `watchlist.csv`, `reviews.csv` — that all share
 * the same four-ish columns: `Date`, `Name`, `Year`, `Letterboxd URI`, plus
 * `Rating` and `Watched Date` where they apply.
 *
 * Two things shape this parser:
 *
 *   1. **There are no ids.** Not IMDb, not TMDB — just a name, usually a year,
 *      and a letterboxd.com URL. Every Letterboxd row therefore matches by
 *      title and year, which is the one path that can pick the wrong film, and
 *      is why `plan.ts` never merges a title-matched row into an existing entry
 *      without the years agreeing.
 *   2. **The year is optional.** A short, a festival cut or a film Letterboxd
 *      has no release date for exports with an empty `Year` cell, and there is
 *      nothing to substitute — so `year` stays absent and the record says so.
 *      Guessing the current year here would produce a record that *looks* exact
 *      and matches the wrong film.
 *
 * Ratings are 0.5–5 stars, which is this plugin's scale already; they are still
 * routed through `convertRating` so the half-star rounding is the same one
 * every other source gets.
 */
import { parseCsv } from "../../../data/csv";
import { cell, findColumn, laterDate, parseDateOnly, parseYear, stripBom } from "../columns";
import { convertRating, RATING_SCALES, type ImportRecord, type ParsedExport } from "../types";

/** Which Letterboxd file a member of the zip is, by basename. */
function fileKind(name: string): "diary" | "ratings" | "watched" | "watchlist" | null {
  const base = name.toLowerCase();
  if (base === "diary.csv") return "diary";
  if (base === "ratings.csv") return "ratings";
  if (base === "watched.csv") return "watched";
  if (base === "watchlist.csv") return "watchlist";
  return null;
}

/** Name + year, lower-cased. A film with no year keys on its name alone. */
function keyOf(title: string, year: number | undefined): string {
  return `${title.trim().toLowerCase()}|${year ?? ""}`;
}

interface Draft {
  title: string;
  year?: number;
  rating?: number;
  ratingRaw?: { value: number; scale: number };
  watchedAt?: string;
  planned: boolean;
  watched: boolean;
  uri?: string;
}

/**
 * Parse one Letterboxd CSV into drafts, merged into `drafts` by name+year.
 *
 * `watchlist.csv` is the only file that means "not seen yet"; every other file
 * is evidence of a watch, so a film present in both ends up Completed, which is
 * what Letterboxd itself shows.
 */
function readOne(text: string, kind: ReturnType<typeof fileKind>, drafts: Map<string, Draft>): number {
  const rows = parseCsv(stripBom(text));
  const headers = rows[0];
  if (!headers) return 0;

  const titleAt = findColumn(headers, "name", "title", "film");
  if (titleAt < 0) return 0;
  const yearAt = findColumn(headers, "year");
  const ratingAt = findColumn(headers, "rating");
  const uriAt = findColumn(headers, "letterboxd uri", "uri", "url");
  // `Watched Date` is the diary's real watch date; the bare `Date` column is
  // when the row was *logged*, which is only a fallback for it.
  const watchedAt = findColumn(headers, "watched date");
  const dateAt = watchedAt >= 0 ? watchedAt : findColumn(headers, "date");

  let used = 0;
  for (const row of rows.slice(1)) {
    const title = cell(row, titleAt);
    if (title === "") continue;
    const year = yearAt >= 0 ? parseYear(cell(row, yearAt)) : undefined;
    const key = keyOf(title, year);
    const draft: Draft = drafts.get(key) ?? { title, planned: false, watched: false };
    if (year !== undefined) draft.year = year;

    const rawRating = ratingAt >= 0 ? Number(cell(row, ratingAt)) : NaN;
    const rating = convertRating(rawRating, RATING_SCALES.letterboxd);
    if (rating !== undefined) {
      draft.rating = rating;
      draft.ratingRaw = { value: rawRating, scale: RATING_SCALES.letterboxd };
    }

    const date = dateAt >= 0 ? parseDateOnly(cell(row, dateAt)) : undefined;
    if (kind !== "watchlist") draft.watchedAt = laterDate(draft.watchedAt, date);

    if (kind === "watchlist") draft.planned = true;
    else draft.watched = true;

    const uri = uriAt >= 0 ? cell(row, uriAt) : "";
    if (uri !== "" && draft.uri === undefined) draft.uri = uri;

    drafts.set(key, draft);
    used += 1;
  }
  return used;
}

/**
 * Parse a Letterboxd export.
 *
 * `files` is basename → text, so this takes either a whole unzipped export or a
 * single CSV the user picked out of it.
 */
export function parseLetterboxd(files: ReadonlyMap<string, string>): ParsedExport {
  const drafts = new Map<string, Draft>();
  const warnings: string[] = [];
  const seen: string[] = [];

  for (const [name, text] of files) {
    const kind = fileKind(name);
    if (kind === null) continue;
    const used = readOne(text, kind, drafts);
    if (used > 0) seen.push(name);
  }

  // A user who exported one file and picked it out of the zip gets it read
  // whatever it is called, as long as it has the columns.
  if (seen.length === 0) {
    for (const [name, text] of files) {
      if (!name.toLowerCase().endsWith(".csv")) continue;
      const kind = name.toLowerCase().includes("watchlist") ? "watchlist" : "watched";
      const used = readOne(text, kind, drafts);
      if (used > 0) seen.push(name);
    }
  }

  if (seen.length === 0) {
    warnings.push(
      "No Letterboxd CSV with a Name column was found. Export from letterboxd.com/settings/data and import the zip, or one of the CSVs inside it.",
    );
  }

  const records: ImportRecord[] = [];
  let missingYear = 0;
  for (const draft of drafts.values()) {
    if (draft.year === undefined) missingYear += 1;
    records.push({
      source: "letterboxd",
      title: draft.title,
      ...(draft.year !== undefined ? { year: draft.year } : {}),
      mediaType: "movie",
      status: draft.watched ? "completed" : "planned",
      ...(draft.rating !== undefined ? { rating: draft.rating } : {}),
      ...(draft.ratingRaw !== undefined ? { ratingRaw: draft.ratingRaw } : {}),
      ...(draft.watched && draft.watchedAt !== undefined ? { dateFinished: draft.watchedAt } : {}),
      ...(draft.uri !== undefined ? { externalLink: draft.uri } : {}),
    });
  }

  if (missingYear > 0) {
    warnings.push(
      `${missingYear} film${missingYear === 1 ? " has" : "s have"} no year in the export, so ${missingYear === 1 ? "it" : "they"} can only be matched by name.`,
    );
  }

  return { source: "letterboxd", records, warnings };
}
