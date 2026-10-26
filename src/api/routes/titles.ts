/**
 * Films and TV shows over HTTP: `/films`, `/shows` and what hangs off them.
 *
 * Every write goes through the same `WatchLogStore` mutations the detail
 * surfaces use, so the API cannot skip the bookkeeping that keeps a library
 * honest — the episode sanitiser, the air-date guard, auto-complete, the
 * activity log, the note mirror. "Log watched" is the wizard's own patch
 * (`data/watched.ts`), and rating and review stay bound the way
 * `data/review.ts` binds them everywhere else.
 *
 * A film is anything watched in one sitting (`isSingleSitting`); everything
 * else, anime included, is a show. A title is only reachable under its own
 * collection, so `/films/<a show's id>` is a 404 rather than a quiet success.
 */
import {
  STATUS_COMPLETED,
  STATUS_DROPPED,
  STATUS_PLAN_TO_WATCH,
  STATUS_TO_BE_RELEASED,
  STATUS_WATCHING,
  TYPE_MOVIE,
} from "../../constants";
import {
  isEpisodeSkipped,
  recomputeOffsets,
  sanitizeWatchedEpisodes,
  seasonEpisodes,
  totalFromSeasons,
} from "../../data/episodes";
import { syncedRatingPatch, syncedReviewPatch } from "../../data/review";
import { createTitle, uniqueId } from "../../data/schema";
import { watchedPatch } from "../../data/watched";
import type { NamedColor, Season, Settings, TitlePatch, TitleV4 } from "../../types";
import { byRecentlyModified, parseLimit, parseOffset, type ListPage } from "../query";
import { kindOf, progressJson, seasonNumberOf, titleJson, type TitleKind } from "../serialize/titles";
import { article } from "../text";
import { ApiError, type ApiDeps, type ApiRequest, type ApiResponse, type RouteHandler } from "../types";

const DEFAULT_SHOW_TYPE = "TV Show";

/** The five statuses the plugin keys behaviour off; always accepted. */
const STATUS_CONSTANTS: readonly string[] = [
  STATUS_WATCHING,
  STATUS_PLAN_TO_WATCH,
  STATUS_COMPLETED,
  STATUS_TO_BE_RELEASED,
  STATUS_DROPPED,
];

const COLLECTIONS: Record<string, TitleKind> = { films: "film", shows: "show" };

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

function bad(message: string): never {
  throw new ApiError(400, message);
}

const has = (body: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(body, key);

/** The request body as a plain object; an absent body reads as `{}`. */
function bodyOf(req: ApiRequest): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null || body === "") return {};
  if (typeof body !== "object" || Array.isArray(body)) bad("The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[], where = ""): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) bad(`Unknown field: ${where}${key}`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") bad(`${field} must be a string.`);
  return value;
}

/** `YYYY-MM-DD` that names a real calendar day. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isCalendarDate(value)) bad(`${field} must be a YYYY-MM-DD date or null.`);
  return value;
}

/** `YYYY-MM-DD` for the local day — never `toISOString`, which is UTC. */
function localDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function positiveIntOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    bad(`${field} must be a positive integer or null.`);
  }
  return value;
}

/** A name from one of the user's configured lists, matched case-insensitively. */
function fromList(value: string, names: readonly string[], field: string): string {
  const needle = value.trim().toLowerCase();
  const found = names.find((name) => name.trim().toLowerCase() === needle);
  if (found === undefined) bad(`${field} must be one of: ${names.join(", ")}.`);
  return found;
}

const namesOf = (list: readonly NamedColor[]): string[] => list.map((entry) => entry.name);

/** `""`/null clears; anything else must name an entry in the list. */
function optionalFromList(value: unknown, list: readonly NamedColor[], field: string): string {
  if (value === null) return "";
  const raw = text(value, field);
  return raw.trim() === "" ? "" : fromList(raw, namesOf(list), field);
}

/** Every status a film or show may have: the configured ones, then any constant they lack. */
export function titleStatusNames(settings: Settings): string[] {
  const names = [...namesOf(settings.statuses)];
  for (const status of STATUS_CONSTANTS) if (!names.includes(status)) names.push(status);
  return names;
}

function statusFrom(value: unknown, settings: Settings): string {
  return fromList(text(value, "status"), titleStatusNames(settings), "status");
}

/** 0–5; whole stars unless the half-star setting is on. `0`/null means unrated. */
function ratingFrom(value: unknown, settings: Settings): number {
  if (value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
    bad("rating must be a number from 0 to 5.");
  }
  const step = settings.halfStarRatings ? 2 : 1;
  if (!Number.isInteger(value * step)) {
    bad(settings.halfStarRatings ? "rating must be in half-star steps." : "rating must be a whole number of stars.");
  }
  return value;
}

function tagsFrom(value: unknown): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    bad("tags must be an array of strings.");
  }
  const out: string[] = [];
  for (const raw of value as string[]) {
    const tag = raw.trim();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Rating and review are one judgement (`data/review.ts`).
 *
 * Send one and the other follows it, exactly as the stars and the review
 * select do in the detail surfaces; send both and both are kept as given,
 * because a proposal never overwrites a choice.
 */
function judgementPatch(
  current: { rating: number; review: string },
  rating: number | undefined,
  review: string | undefined,
  settings: Settings,
): { rating?: number; review?: string } {
  if (rating !== undefined && review !== undefined) return { rating, review };
  if (rating !== undefined) return syncedRatingPatch(current, rating, settings.reviews);
  if (review !== undefined) return syncedReviewPatch(current, review, settings.reviews);
  return {};
}

// ---------------------------------------------------------------------------
// Writable fields — shared by create and PATCH
// ---------------------------------------------------------------------------

const WRITABLE = [
  "title",
  "type",
  "status",
  "rating",
  "review",
  "watchedVia",
  "favorite",
  "tags",
  "notes",
  "dates",
  "year",
  "ids",
] as const;
const WRITABLE_DATES = ["started", "finished", "released"] as const;
const WRITABLE_IDS = ["tmdb", "imdb", "tvdb", "mal", "anilist"] as const;
/** Present in what GET returns, so a round-tripped object names them helpfully. */
const READ_ONLY = ["id", "kind", "progress"];

/**
 * The patch a request body asks for, validated against the user's settings.
 *
 * Only the keys actually sent are written; `null` clears a field that has an
 * empty state. `current` is the title as it stands (or a fresh one, on create),
 * which the rating/review binding reads from.
 */
function fieldsPatch(
  body: Record<string, unknown>,
  current: TitleV4,
  kind: TitleKind,
  settings: Settings,
  now: Date,
): TitlePatch {
  for (const key of Object.keys(body)) {
    if (READ_ONLY.includes(key)) bad(`${key} is read-only.`);
  }
  const patch: TitlePatch = {};

  if (has(body, "title")) {
    const name = typeof body.title === "string" ? body.title.trim() : "";
    if (name === "") bad("title must be a non-empty string.");
    patch.title = name;
  }
  if (has(body, "type")) patch.type = fromList(text(body.type, "type"), namesOf(settings.types), "type");
  if (has(body, "status")) patch.status = statusFrom(body.status, settings);

  const rating = has(body, "rating") ? ratingFrom(body.rating, settings) : undefined;
  const review = has(body, "review") ? optionalFromList(body.review, settings.reviews, "review") : undefined;
  Object.assign(patch, judgementPatch(current, rating, review, settings));

  if (has(body, "watchedVia")) {
    patch.watchedVia = optionalFromList(body.watchedVia, settings.watchedViaOptions, "watchedVia");
  }
  if (has(body, "favorite")) {
    if (typeof body.favorite !== "boolean") bad("favorite must be true or false.");
    // The same pair the card and detail toggles write.
    patch.favorite = body.favorite;
    patch.dateFavorited = body.favorite ? (current.dateFavorited ?? now.toISOString()) : undefined;
  }
  if (has(body, "tags")) patch.tags = tagsFrom(body.tags);
  if (has(body, "notes")) patch.notes = body.notes === null ? "" : text(body.notes, "notes");
  if (has(body, "year")) {
    const year = body.year;
    if (year !== null && (typeof year !== "number" || !Number.isInteger(year) || year < 1800 || year > 3000)) {
      bad("year must be a four-digit year or null.");
    }
    patch.year = year === null ? undefined : year;
  }

  if (has(body, "dates")) {
    const dates = body.dates;
    if (!dates || typeof dates !== "object" || Array.isArray(dates)) bad("dates must be an object.");
    const d = dates as Record<string, unknown>;
    rejectUnknown(d, WRITABLE_DATES, "dates.");
    if (has(d, "started")) patch.dateStarted = dateOrNull(d.started, "dates.started");
    if (has(d, "finished")) patch.dateFinished = dateOrNull(d.finished, "dates.finished");
    if (has(d, "released")) patch.releaseDate = dateOrNull(d.released, "dates.released");
  }

  if (has(body, "ids")) {
    const ids = body.ids;
    if (!ids || typeof ids !== "object" || Array.isArray(ids)) bad("ids must be an object.");
    const i = ids as Record<string, unknown>;
    rejectUnknown(i, WRITABLE_IDS, "ids.");
    if (has(i, "tmdb")) {
      const tmdb = positiveIntOrNull(i.tmdb, "ids.tmdb");
      // A TMDB id only means something together with which of TMDB's two
      // catalogues it is from, and the collection the caller used says which.
      patch.tmdbId = tmdb ?? undefined;
      patch.tmdbMediaType = tmdb === null ? undefined : kind === "film" ? "movie" : "tv";
    }
    if (has(i, "imdb")) {
      if (i.imdb !== null && (typeof i.imdb !== "string" || !/^tt\d+$/.test(i.imdb))) {
        bad("ids.imdb must look like tt1234567, or be null.");
      }
      patch.imdbId = i.imdb === null ? undefined : (i.imdb as string);
    }
    if (has(i, "tvdb")) patch.tvdbId = positiveIntOrNull(i.tvdb, "ids.tvdb") ?? undefined;
    if (has(i, "mal")) patch.malId = positiveIntOrNull(i.mal, "ids.mal") ?? 0;
    if (has(i, "anilist")) patch.anilistId = positiveIntOrNull(i.anilist, "ids.anilist") ?? 0;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * The Add modal's "Already tracked" rule, scoped to one collection: the same
 * name (trimmed, any case), or the same TMDB id from the same catalogue. A
 * remake that shares its name needs a name that tells the two apart.
 */
function assertUnique(
  deps: ApiDeps,
  kind: TitleKind,
  name: string | undefined,
  tmdbId: number | undefined,
  self?: string,
): void {
  const needle = name?.trim().toLowerCase();
  const mediaType = kind === "film" ? "movie" : "tv";
  const existing = deps.store
    .allTitles()
    .filter((t) => t.id !== self && kindOf(t) === kind)
    .find(
      (t) =>
        (needle !== undefined && t.title.trim().toLowerCase() === needle) ||
        (tmdbId !== undefined && t.tmdbId === tmdbId && (t.tmdbMediaType ?? mediaType) === mediaType),
    );
  if (existing) throw new ApiError(409, `${article(kind)} ${kind} called "${existing.title}" already exists (id "${existing.id}").`);
}

function findTitle(deps: ApiDeps, kind: TitleKind, id: string): TitleV4 {
  const title = deps.store.getTitle(id);
  if (!title || kindOf(title) !== kind) throw new ApiError(404, `No ${kind} with id "${id}".`);
  return title;
}

/** A season by the number people call it (see `seasonNumberOf`). */
function findSeasonIndex(title: TitleV4, seasonNumber: number): number {
  const index = title.seasons.findIndex((season, i) => seasonNumberOf(season, i) === seasonNumber);
  if (index < 0) throw new ApiError(404, `${title.title} has no season ${seasonNumber}.`);
  return index;
}

/** Every write is on disk before the caller hears it succeeded. */
async function flushed(deps: ApiDeps): Promise<void> {
  try {
    await deps.store.flush();
  } catch {
    throw new ApiError(500, "The change was made but could not be written to disk.");
  }
}

function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) bad(`${field} must be a whole number.`);
  return value;
}

function watchedFlag(body: Record<string, unknown>): boolean {
  if (!has(body, "watched")) return true;
  if (typeof body.watched !== "boolean") bad("watched must be true or false.");
  return body.watched;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function list(req: ApiRequest, deps: ApiDeps, kind: TitleKind): ApiResponse {
  const { type, q } = req.query;
  // An unknown status is a 400, as it is on a write, not an empty list.
  const status =
    req.query.status !== undefined && req.query.status.trim() !== ""
      ? statusFrom(req.query.status, deps.store.settings)
      : undefined;
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const needle = (q ?? "").trim().toLowerCase();
  const matches = deps.store
    .allTitles()
    .filter((t) => kindOf(t) === kind)
    .filter((t) => status === undefined || same(t.status, status))
    .filter((t) => type === undefined || same(t.type, type))
    .filter((t) => needle === "" || t.title.toLowerCase().includes(needle))
    .sort(byRecentlyModified);
  const page: ListPage<unknown> = { items: matches.slice(offset, offset + limit).map(titleJson), total: matches.length };
  return ok(page);
}

/** A show's seasons from the request, or the single season the Add modal makes. */
function showGeometry(body: Record<string, unknown>): { seasons: Season[]; totalEpisodes: number } {
  if (has(body, "seasons")) {
    if (!Array.isArray(body.seasons) || body.seasons.length === 0) bad("seasons must be a non-empty array.");
    const seasons: Season[] = (body.seasons as unknown[]).map((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad(`seasons[${i}] must be an object.`);
      const s = raw as Record<string, unknown>;
      rejectUnknown(s, ["name", "episodes", "seasonNumber", "skippedEpisodes"], `seasons[${i}].`);
      const episodes = wholeNumber(s.episodes, `seasons[${i}].episodes`);
      if (episodes < 1) bad(`seasons[${i}].episodes must be at least 1.`);
      const seasonNumber = has(s, "seasonNumber") ? wholeNumber(s.seasonNumber, `seasons[${i}].seasonNumber`) : i + 1;
      const name = has(s, "name") ? text(s.name, `seasons[${i}].name`).trim() : "";
      const skipped = has(s, "skippedEpisodes") ? s.skippedEpisodes : [];
      if (
        !Array.isArray(skipped) ||
        skipped.some((ep) => typeof ep !== "number" || !Number.isInteger(ep) || ep < 1 || ep > episodes)
      ) {
        bad(`seasons[${i}].skippedEpisodes must list episode numbers from 1 to ${episodes}.`);
      }
      return {
        name: name || `Season ${seasonNumber}`,
        episodes,
        offset: 0,
        skippedEpisodes: [...new Set(skipped as number[])].sort((a, b) => a - b),
        seasonNumber,
      };
    });
    recomputeOffsets(seasons);
    return { seasons, totalEpisodes: totalFromSeasons(seasons) };
  }
  const total = has(body, "totalEpisodes") ? wholeNumber(body.totalEpisodes, "totalEpisodes") : 0;
  if (total < 2) bad("A show needs seasons, or totalEpisodes of 2 or more.");
  return {
    seasons: [{ name: "Season 1", episodes: total, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    totalEpisodes: total,
  };
}

async function create(req: ApiRequest, deps: ApiDeps, kind: TitleKind): Promise<ApiResponse> {
  const body = bodyOf(req);
  const settings = deps.store.settings;
  const geometryKeys = kind === "show" ? ["seasons", "totalEpisodes"] : [];
  rejectUnknown(body, [...WRITABLE, ...READ_ONLY, ...geometryKeys]);
  if (typeof body.title !== "string" || body.title.trim() === "") bad("title is required.");

  let type: string;
  if (has(body, "type")) {
    type = fromList(text(body.type, "type"), namesOf(settings.types), "type");
  } else {
    const fallback = kind === "film" ? TYPE_MOVIE : DEFAULT_SHOW_TYPE;
    if (!namesOf(settings.types).includes(fallback)) bad(`type is required (there is no "${fallback}" type).`);
    type = fallback;
  }
  const geometry = kind === "show" ? showGeometry(body) : { seasons: [], totalEpisodes: 1 };

  const name = body.title.trim();
  // A provisional title, so the field rules read the same defaults a new
  // title gets — the rating/review binding starts from "unrated, no review".
  const draft = createTitle({
    id: "",
    title: name,
    type,
    status: STATUS_PLAN_TO_WATCH,
    ...geometry,
  });
  const patch = fieldsPatch(body, draft, kind, settings, deps.now());
  assertUnique(deps, kind, name, patch.tmdbId);
  const title = createTitle({
    ...patch,
    id: uniqueId(name, deps.store.allTitles().map((t) => t.id)),
    title: name,
    type,
    status: patch.status ?? STATUS_PLAN_TO_WATCH,
    ...geometry,
  });
  if (kindOf(title) !== kind) {
    bad(
      kind === "film"
        ? `${article(type)} "${type}" with those details is not a film.`
        : `${article(type)} "${type}" is a film, not a show.`,
    );
  }
  deps.store.addTitle(title);
  await flushed(deps);
  return { status: 201, body: titleJson(title) };
}

async function update(req: ApiRequest, deps: ApiDeps, title: TitleV4, kind: TitleKind): Promise<ApiResponse> {
  const body = bodyOf(req);
  rejectUnknown(body, [...WRITABLE, ...READ_ONLY]);
  const patch = fieldsPatch(body, title, kind, deps.store.settings, deps.now());
  if (Object.keys(patch).length === 0) bad("Nothing to change.");
  // Only what this request changes: an old same-name pair from the UI is not the caller's conflict.
  assertUnique(deps, kind, patch.title, patch.tmdbId, title.id);
  const updated = deps.store.updateTitle(title.id, patch, "api-patch");
  if (!updated) throw new ApiError(404, `No ${kind} with id "${title.id}".`);
  await flushed(deps);
  return ok(titleJson(updated));
}

async function remove(deps: ApiDeps, title: TitleV4): Promise<ApiResponse> {
  deps.store.deleteTitle(title.id);
  await flushed(deps);
  return ok({ id: title.id, deleted: true });
}

/**
 * "I watched it", the wizard's way: Watched, the date (today unless told),
 * and whichever of rating, review and venue were actually given.
 */
async function logWatched(req: ApiRequest, deps: ApiDeps, title: TitleV4): Promise<ApiResponse> {
  const body = bodyOf(req);
  const settings = deps.store.settings;
  rejectUnknown(body, ["date", "rating", "review", "watchedVia"]);
  const date = has(body, "date") ? dateOrNull(body.date, "date") : localDay(deps.now());
  // The wizard opens unrated and without a review, and its stars and select
  // keep each other in step from there; the API starts from the same place.
  const rating = has(body, "rating") ? ratingFrom(body.rating, settings) : undefined;
  const review = has(body, "review") ? optionalFromList(body.review, settings.reviews, "review") : undefined;
  const judged = judgementPatch({ rating: 0, review: "" }, rating, review, settings);
  const watchedVia = has(body, "watchedVia")
    ? optionalFromList(body.watchedVia, settings.watchedViaOptions, "watchedVia")
    : "";
  const patch = watchedPatch(title, {
    date,
    rating: judged.rating ?? 0,
    review: judged.review ?? "",
    watchedVia,
  });
  // The same call, reason aside, that the detail surfaces' `patch` makes.
  const updated = deps.store.updateTitle(title.id, patch, "api-watched");
  if (!updated) throw new ApiError(404, `No title with id "${title.id}".`);
  await flushed(deps);
  return ok(titleJson(updated));
}

async function markEpisode(req: ApiRequest, deps: ApiDeps, title: TitleV4): Promise<ApiResponse> {
  const body = bodyOf(req);
  rejectUnknown(body, ["season", "episode", "absolute", "watched"]);
  const watched = watchedFlag(body);

  let absolute: number;
  let label: string;
  if (has(body, "absolute")) {
    if (has(body, "season") || has(body, "episode")) bad("Send either absolute, or season and episode — not both.");
    absolute = wholeNumber(body.absolute, "absolute");
    if (absolute < 1 || absolute > title.totalEpisodes) {
      bad(`absolute must be from 1 to ${title.totalEpisodes}.`);
    }
    label = `Episode ${absolute}`;
  } else {
    if (!has(body, "season") || !has(body, "episode")) bad("Send season and episode, or absolute.");
    const seasonNumber = wholeNumber(body.season, "season");
    const episode = wholeNumber(body.episode, "episode");
    const index = findSeasonIndex(title, seasonNumber);
    const season = title.seasons[index] as Season;
    if (episode < 1 || episode > season.episodes) bad(`${season.name} has episodes 1 to ${season.episodes}.`);
    // Through the season's offset, so S2E3 is the right absolute number
    // however the seasons before it are sized.
    absolute = season.offset + episode;
    label = `S${String(seasonNumber).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }

  // Skipped episodes are out of the count entirely; the store ignores them
  // without a word, which over HTTP would read as success.
  if (watched && isEpisodeSkipped(title, absolute)) {
    throw new ApiError(409, `${label} is marked as skipped and cannot be watched.`);
  }
  deps.store.markEpisodeWatched(title.id, absolute, watched);
  await flushed(deps);
  const nowWatched = sanitizeWatchedEpisodes(title).includes(absolute);
  if (watched && !nowWatched) {
    // The store refuses an episode that has not aired yet, and says so in a
    // Notice; a caller over HTTP needs to hear it too.
    throw new ApiError(409, `${label} has not aired yet.`);
  }
  return ok(titleJson(title));
}

async function markSeason(req: ApiRequest, deps: ApiDeps, title: TitleV4, rawNumber: string): Promise<ApiResponse> {
  const body = bodyOf(req);
  rejectUnknown(body, ["watched"]);
  const watched = watchedFlag(body);
  const seasonNumber = Number(rawNumber);
  if (!Number.isInteger(seasonNumber)) bad("The season must be a whole number.");
  const index = findSeasonIndex(title, seasonNumber);
  deps.store.markSeasonWatched(title.id, index, watched);
  await flushed(deps);
  if (watched && seasonEpisodes(title, index).length > 0) {
    const ticked = new Set(sanitizeWatchedEpisodes(title));
    if (!seasonEpisodes(title, index).some((ep) => ticked.has(ep))) {
      throw new ApiError(409, `Nothing in ${title.seasons[index]?.name ?? `season ${seasonNumber}`} has aired yet.`);
    }
  }
  return ok(titleJson(title));
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  try {
    return path.split("/").filter((part) => part !== "").map(decodeURIComponent);
  } catch {
    bad("The path is not valid URL encoding.");
  }
}

function notAllowed(method: string, path: string): never {
  throw new ApiError(405, `${method} is not supported on ${path}.`);
}

export const titleRoutes: RouteHandler = async (req, deps) => {
  const parts = segments(req.path);
  const kind = COLLECTIONS[parts[0] ?? ""];
  if (!kind) return undefined;
  const method = req.method.toUpperCase();
  const [, id, sub, arg, ...rest] = parts;

  if (id === undefined) {
    if (method === "GET") return list(req, deps, kind);
    if (method === "POST") return create(req, deps, kind);
    notAllowed(method, req.path);
  }

  const title = findTitle(deps, kind, id);

  if (sub === undefined) {
    if (method === "GET") return ok(titleJson(title));
    if (method === "PATCH") return update(req, deps, title, kind);
    if (method === "DELETE") return remove(deps, title);
    notAllowed(method, req.path);
  }

  if (rest.length > 0) throw new ApiError(404, `Not found: ${req.path}`);

  if (sub === "watched" && arg === undefined) {
    if (method !== "POST") notAllowed(method, req.path);
    return logWatched(req, deps, title);
  }

  if (kind === "show") {
    if (sub === "progress" && arg === undefined) {
      if (method !== "GET") notAllowed(method, req.path);
      return ok({ id: title.id, status: title.status, ...progressJson(title) });
    }
    if (sub === "episodes" && arg === undefined) {
      if (method !== "POST") notAllowed(method, req.path);
      return markEpisode(req, deps, title);
    }
    if (sub === "seasons" && arg !== undefined) {
      if (method !== "POST") notAllowed(method, req.path);
      return markSeason(req, deps, title, arg);
    }
  }

  throw new ApiError(404, `Not found: ${req.path}`);
};
