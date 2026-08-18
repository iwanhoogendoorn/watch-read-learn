/**
 * Ryot.
 *
 * One JSON file from Settings → Imports and Exports → Export, whose shape is
 * Ryot's `CompleteExport`:
 *
 *     { "metadata": [ { "lot": "MOVIE", "source": "TMDB", "identifier": "27205",
 *                       "seen_history": [...], "reviews": [...] } ] }
 *
 * The awkward part, and the reason this parser is shaped the way it is:
 * **a Ryot export contains no titles.** An entry is a `source` plus an
 * `identifier`, and for `source: "TMDB"` the identifier *is* the TMDB id. So
 * every usable record is an exact id match with a placeholder name, and every
 * record from any other source (Anilist, IGDB, Audible, Openlibrary…) is
 * unusable here and is counted into a warning rather than dropped in silence.
 *
 * `title` is still filled in — as `TMDB movie 27205` — because a plan preview
 * with a blank name is unreadable, and because the title is replaced by the
 * real one the moment the TMDB backfill runs against the id that is already
 * attached. It is a label, never an identity: nothing matches on it.
 *
 * Ryot's rating scale is a user setting the export does not state, so it is
 * inferred from the value (`inferRyotScale`).
 */
import { parseDateOnly, parseNumericId } from "../columns";
import {
  convertRating,
  inferRyotScale,
  type ImportEpisode,
  type ImportRecord,
  type ImportStatus,
  type ParsedExport,
} from "../types";
import type { DateString, MediaType } from "../../../types";

interface RyotSeen {
  state?: string | null;
  started_on?: string | null;
  ended_on?: string | null;
  show_season_number?: number | null;
  show_episode_number?: number | null;
}

interface RyotReview {
  rating?: string | number | null;
  show_season_number?: number | null;
  show_episode_number?: number | null;
}

interface RyotEntry {
  lot?: string;
  source?: string;
  identifier?: string | number;
  title?: string;
  seen_history?: RyotSeen[];
  reviews?: RyotReview[];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function lotToMediaType(lot: string): MediaType | null {
  const text = lot.trim().toLowerCase();
  if (text === "movie") return "movie";
  if (text === "show" || text === "tv" || text === "series") return "tv";
  return null;
}

/**
 * The status the seen-history implies, most-progressed first.
 *
 * A null `state` is Ryot's older export for "seen", so it counts as completed —
 * an entry with watch history and no state is not a plan-to-watch.
 */
export function ryotStatus(history: readonly RyotSeen[]): ImportStatus {
  if (history.length === 0) return "planned";
  const states = history.map((entry) => (entry.state ?? "completed").toLowerCase());
  if (states.some((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "in_progress")) return "watching";
  if (states.some((state) => state === "on_a_hold")) return "on-hold";
  if (states.some((state) => state === "dropped")) return "dropped";
  return "planned";
}

export function parseRyot(text: string): ParsedExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      source: "ryot",
      records: [],
      warnings: ["That file is not valid JSON. Use the file from Ryot's Imports and Exports settings."],
    };
  }

  const metadata = asArray((parsed as { metadata?: unknown } | null)?.metadata);
  if (metadata.length === 0) {
    return {
      source: "ryot",
      records: [],
      warnings: ['No "metadata" array — this does not look like a Ryot CompleteExport file.'],
    };
  }

  const records: ImportRecord[] = [];
  const warnings: string[] = [];
  let otherSource = 0;
  let otherLot = 0;

  for (const raw of metadata) {
    const entry = raw as RyotEntry;
    const mediaType = lotToMediaType(String(entry.lot ?? ""));
    if (mediaType === null) {
      otherLot += 1;
      continue;
    }
    const provider = String(entry.source ?? "").trim().toLowerCase();
    const tmdbId = provider === "tmdb" ? parseNumericId(entry.identifier) : undefined;
    if (tmdbId === undefined) {
      otherSource += 1;
      continue;
    }

    const history = asArray(entry.seen_history) as RyotSeen[];
    const status = ryotStatus(history);

    let started: DateString | undefined;
    let finished: DateString | undefined;
    const episodes: ImportEpisode[] = [];
    for (const seen of history) {
      const state = (seen.state ?? "completed").toLowerCase();
      const startedOn = parseDateOnly(String(seen.started_on ?? ""));
      const endedOn = parseDateOnly(String(seen.ended_on ?? ""));
      if (startedOn !== undefined && (started === undefined || startedOn < started)) started = startedOn;
      if (endedOn !== undefined && (finished === undefined || endedOn > finished)) finished = endedOn;

      const season = seen.show_season_number;
      const episode = seen.show_episode_number;
      if (
        state === "completed" &&
        typeof season === "number" &&
        typeof episode === "number" &&
        season > 0 &&
        episode > 0
      ) {
        episodes.push({ season, episode });
      }
    }

    // Only the work-level review is a rating of the work. A per-episode review
    // rates one episode, and averaging those into a show's rating would invent
    // a number the user never gave.
    const overall = (asArray(entry.reviews) as RyotReview[]).find(
      (review) =>
        (review.show_season_number ?? null) === null && (review.show_episode_number ?? null) === null,
    );
    const rawRating = Number(overall?.rating ?? NaN);
    const scale = Number.isFinite(rawRating) ? inferRyotScale(rawRating) : 0;
    const rating = convertRating(rawRating, scale);

    records.push({
      source: "ryot",
      title: String(entry.title ?? "").trim() || `TMDB ${mediaType} ${tmdbId}`,
      mediaType,
      status,
      tmdbId,
      ...(rating !== undefined ? { rating, ratingRaw: { value: rawRating, scale } } : {}),
      ...(started !== undefined ? { dateStarted: started } : {}),
      ...(finished !== undefined && (status === "completed" || status === "dropped")
        ? { dateFinished: finished }
        : {}),
      ...(episodes.length > 0 ? { episodes } : {}),
    });
  }

  if (otherSource > 0) {
    warnings.push(
      `${otherSource} entr${otherSource === 1 ? "y is" : "ies are"} not from TMDB. A Ryot export carries no titles, only ids, so there is nothing to import them by.`,
    );
  }
  if (otherLot > 0) {
    warnings.push(`${otherLot} entr${otherLot === 1 ? "y" : "ies"} skipped: not a film or a show.`);
  }
  if (records.length > 0) {
    warnings.push(
      "Ryot exports ids rather than names, so imported entries are named after their TMDB id until the details are fetched.",
    );
  }

  return { source: "ryot", records, warnings };
}
