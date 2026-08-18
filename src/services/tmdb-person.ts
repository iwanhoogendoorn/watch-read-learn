/**
 * People — TMDB's person endpoints, plus the cache and the name resolver the
 * person screen is built on.
 *
 * The plugin stores credits as **name strings** (`title.cast`, `title.director`),
 * because that is what v3 wrote and what the Library's `cast:"…"` query filters
 * on. A person screen needs a TMDB person *id*, so opening one from a title means
 * turning a name back into an identity — and two working actors sharing a name is
 * not a rare edge, it is Wikipedia's most crowded disambiguation genre.
 *
 * So resolution has an order, cheapest and most certain first:
 *
 *   1. **The name cache.** A name resolved once stays resolved, no network.
 *   2. **The library's own TMDB credits.** If the user owns a film this name
 *      appears in, `/movie/{id}/credits` gives the exact person id TMDB used for
 *      that film. That is an answer, not a guess. Two *different* ids for one
 *      name across the library is the genuinely ambiguous case, and it is
 *      reported as such rather than resolved to whoever came first.
 *   3. **`/search/person`.** Only exact name matches count; one hit resolves,
 *      several are handed to the user to pick from.
 *
 * Everything fetched is cached in `data.json` under the preserved `people` key
 * (see the runtime-preservation contract in `types.ts` — this is exactly what
 * `readExtra`/`writeExtra` exist for). Opening a person a second time makes no
 * request at all, which is the same offline-first promise the `airing` and `plex`
 * caches on `TitleV4` make, and the same reason `domains/anime/cache.ts` exists.
 */
import { RATE_LIMIT_MS, TMDB_IMAGE_BASE } from "../constants";
import {
  readExtra,
  writeExtra,
  type DateString,
  type IsoTimestamp,
  type MediaType,
  type OverseerrSearchResult,
  type TitleV4,
  type WatchLogData,
} from "../types";
import { ApiError, defaultHttp, isApiError, queryString, type HttpFn } from "./http";
import {
  dateField,
  isRaw,
  normalizeSearchResult,
  num,
  optNum,
  rawArray,
  str,
  type Raw,
} from "./normalize";
import { createRateLimiter, realClock, type LimiterClock, type RateLimiter } from "./ratelimit";
import { TMDB_API_BASE } from "./tmdb";

/** Profile photos are portraits; `h632` is the tallest size worth shipping. */
export const TMDB_PROFILE_SIZE = "h632";

/** TMDB has no published hard limit but asks that a 429 be respected. */
const RATE_LIMIT_RETRY_MS = 1000;

// ---------------------------------------------------------------------------
// 1. Shapes
// ---------------------------------------------------------------------------

/** A person, flattened out of `/person/{id}`. Nothing here is ever a sentinel. */
export interface TmdbPerson {
  id: number;
  name: string;
  biography: string;
  birthday: DateString | null;
  deathday: DateString | null;
  placeOfBirth: string;
  /** Full CDN URL, or `""` when TMDB has no photo. */
  profileUrl: string;
  /** `Acting`, `Directing`, `Writing`, … */
  knownForDepartment: string;
  alsoKnownAs: string[];
  /** Spelled out (`Female`), never TMDB's integer. `""` when unspecified. */
  gender: string;
  imdbId: string;
  homepage: string;
  popularity: number;
}

/**
 * One filmography entry.
 *
 * The title itself is an `OverseerrSearchResult` rather than a shape of this
 * module's own, so a credit can be handed straight to the existing add path
 * (`ui/modals/add.ts`) without a second mapping that could drift from the first.
 */
export interface PersonCredit {
  result: OverseerrSearchResult;
  /** `Acting` for cast, the crew department otherwise. */
  department: string;
  /** Character name, or the crew job. `""` when TMDB gives neither. */
  role: string;
}

/** A `/search/person` hit, or a candidate assembled from library credits. */
export interface PersonCandidate {
  id: number;
  name: string;
  profileUrl: string;
  knownForDepartment: string;
  /** Titles that place them, so a picker can tell two same-named people apart. */
  knownFor: string[];
  popularity: number;
}

/** One name in one title's TMDB credits — the exact-id path. */
export interface TitleCreditPerson {
  id: number;
  name: string;
  /** `Acting` for cast entries, the crew department otherwise. */
  department: string;
  /** Character or job. */
  role: string;
  profileUrl: string;
  order: number;
}

export interface TmdbPersonClient {
  configured(): boolean;
  /** `/person/{id}` with `combined_credits` appended — one round trip. */
  person(personId: number): Promise<{ person: TmdbPerson; credits: PersonCredit[] }>;
  /** `/search/person`, exact-name filtering left to the caller. */
  searchPeople(query: string): Promise<PersonCandidate[]>;
  /** `/{mediaType}/{id}/credits` — cast and crew with their person ids. */
  titleCredits(tmdbId: number, mediaType: MediaType): Promise<TitleCreditPerson[]>;
}

// ---------------------------------------------------------------------------
// 2. Normalisation
// ---------------------------------------------------------------------------

/** TMDB's `gender` enum. 0 is "not set", which is not the same as non-binary. */
const GENDERS: Record<number, string> = {
  1: "Female",
  2: "Male",
  3: "Non-binary",
};

export function profileUrl(path: unknown): string {
  if (typeof path !== "string" || path.trim() === "") return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${TMDB_IMAGE_BASE}/${TMDB_PROFILE_SIZE}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function normalizePerson(raw: Raw, fallbackId: number): TmdbPerson {
  return {
    id: optNum(raw, "id") ?? fallbackId,
    name: str(raw, "name"),
    biography: str(raw, "biography"),
    birthday: dateField(raw, "birthday"),
    deathday: dateField(raw, "deathday"),
    placeOfBirth: str(raw, "place_of_birth", "placeOfBirth"),
    profileUrl: profileUrl(raw["profile_path"] ?? raw["profilePath"]),
    knownForDepartment: str(raw, "known_for_department", "knownForDepartment"),
    alsoKnownAs: (Array.isArray(raw["also_known_as"]) ? raw["also_known_as"] : [])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim()),
    gender: GENDERS[num(raw, "gender")] ?? "",
    imdbId: str(raw, "imdb_id", "imdbId"),
    homepage: str(raw, "homepage"),
    popularity: num(raw, "popularity"),
  };
}

/**
 * `combined_credits` → filmography entries.
 *
 * Entries with no usable title or no id are dropped rather than rendered as a
 * blank poster: TMDB's crew lists carry a fair amount of debris.
 */
export function normalizeCombinedCredits(value: unknown): PersonCredit[] {
  if (!isRaw(value)) return [];
  const out: PersonCredit[] = [];

  for (const raw of rawArray(value["cast"])) {
    const credit = toCredit(raw, "Acting", str(raw, "character"));
    if (credit) out.push(credit);
  }
  for (const raw of rawArray(value["crew"])) {
    const department = str(raw, "department") || "Crew";
    const credit = toCredit(raw, department, str(raw, "job"));
    if (credit) out.push(credit);
  }
  return out;
}

function toCredit(raw: Raw, department: string, role: string): PersonCredit | undefined {
  const mediaType = str(raw, "media_type", "mediaType");
  // `person` entries never appear here, but a payload that grew a third media
  // type must not be guessed at.
  if (mediaType !== "movie" && mediaType !== "tv") return undefined;
  const result = normalizeSearchResult(raw, mediaType);
  if (!result || result.title.trim() === "") return undefined;
  return { result, department, role };
}

export function normalizeTitleCredits(raw: Raw): TitleCreditPerson[] {
  const out: TitleCreditPerson[] = [];

  for (const entry of rawArray(raw["cast"])) {
    const person = toTitleCredit(entry, "Acting", str(entry, "character"));
    if (person) out.push(person);
  }
  for (const entry of rawArray(raw["crew"])) {
    const person = toTitleCredit(entry, str(entry, "department") || "Crew", str(entry, "job"));
    if (person) out.push(person);
  }
  return out;
}

function toTitleCredit(raw: Raw, department: string, role: string): TitleCreditPerson | undefined {
  const id = optNum(raw, "id");
  const name = str(raw, "name");
  if (id === undefined || id <= 0 || name === "") return undefined;
  return {
    id,
    name,
    department,
    role,
    profileUrl: profileUrl(raw["profile_path"] ?? raw["profilePath"]),
    order: optNum(raw, "order") ?? Number.MAX_SAFE_INTEGER,
  };
}

function normalizeCandidate(raw: Raw): PersonCandidate | undefined {
  const id = optNum(raw, "id");
  const name = str(raw, "name");
  if (id === undefined || id <= 0 || name === "") return undefined;
  return {
    id,
    name,
    profileUrl: profileUrl(raw["profile_path"] ?? raw["profilePath"]),
    knownForDepartment: str(raw, "known_for_department", "knownForDepartment"),
    knownFor: rawArray(raw["known_for"])
      .map((entry) => str(entry, "title", "name"))
      .filter((entry) => entry !== ""),
    popularity: num(raw, "popularity"),
  };
}

// ---------------------------------------------------------------------------
// 3. The client
// ---------------------------------------------------------------------------

export interface TmdbPersonConfig {
  /** v4 read access token. Empty means "not configured". */
  token: string;
}

export interface TmdbPersonDeps {
  http?: HttpFn;
  limiter?: RateLimiter;
  clock?: LimiterClock;
}

/**
 * A second small client rather than four more methods on `createTmdbClient`.
 *
 * `services/tmdb.ts` is the *title* client and is shared by three other lanes;
 * people are a separate concern with their own cache and their own resolver, and
 * they degrade independently — an unconfigured token here means "no person
 * screen", not "no plugin".
 */
export function createTmdbPersonClient(
  getConfig: () => TmdbPersonConfig,
  deps: TmdbPersonDeps = {},
): TmdbPersonClient {
  const http = deps.http ?? defaultHttp;
  const clock = deps.clock ?? realClock;
  const limiter = deps.limiter ?? createRateLimiter(RATE_LIMIT_MS.tmdb, clock);

  function configured(): boolean {
    return getConfig().token.trim() !== "";
  }

  async function get(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Raw> {
    if (!configured()) {
      throw new ApiError({ source: "tmdb", reason: "no-key", detail: "tmdbToken is empty" });
    }
    const url = `${TMDB_API_BASE}${path}${queryString(params)}`;
    const headers = { Authorization: `Bearer ${getConfig().token.trim()}` };
    const attempt = () => limiter.run(() => http({ url, source: "tmdb", headers }));

    let response;
    try {
      response = await attempt();
    } catch (err) {
      // One polite retry, then give up and let the caller serve stale.
      if (isApiError(err) && err.reason === "rate-limited") {
        await clock.sleep(RATE_LIMIT_RETRY_MS);
        response = await attempt();
      } else {
        throw err;
      }
    }

    if (!isRaw(response.json)) {
      throw new ApiError({ source: "tmdb", reason: "parse", url, detail: "expected a JSON object" });
    }
    return response.json;
  }

  return {
    configured,

    async person(personId) {
      const raw = await get(`/person/${personId}`, { append_to_response: "combined_credits" });
      return {
        person: normalizePerson(raw, personId),
        credits: normalizeCombinedCredits(raw["combined_credits"]),
      };
    },

    async searchPeople(query) {
      const trimmed = query.trim();
      if (trimmed === "") return [];
      const raw = await get("/search/person", { query: trimmed, include_adult: false });
      return rawArray(raw["results"])
        .map(normalizeCandidate)
        .filter((hit): hit is PersonCandidate => hit !== undefined);
    },

    async titleCredits(tmdbId, mediaType) {
      const raw = await get(`/${mediaType}/${tmdbId}/credits`);
      return normalizeTitleCredits(raw);
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Names
// ---------------------------------------------------------------------------

/**
 * The comparison key for a credit name.
 *
 * Diacritics are stripped because the library's stored string came from whatever
 * source matched the title first, and `Penelope Cruz` must find `Penélope Cruz`.
 * Punctuation goes for the same reason (`Samuel L. Jackson` / `Samuel L Jackson`).
 */
export function personNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sameName(a: string, b: string): boolean {
  const left = personNameKey(a);
  return left !== "" && left === personNameKey(b);
}

/** Every credit name on a title, API values and the user's own additions. */
export function creditNamesOf(title: TitleV4): string[] {
  return [
    ...title.cast,
    ...title.manualCast,
    ...title.director,
    ...title.manualDirector,
  ].filter((name) => name.trim() !== "");
}

/** Titles that list this name, most recently touched first. */
export function titlesCrediting(titles: readonly TitleV4[], name: string): TitleV4[] {
  return titles
    .filter((title) => creditNamesOf(title).some((credit) => sameName(credit, name)))
    .slice()
    .sort((a, b) => (b.dateModified ?? "").localeCompare(a.dateModified ?? ""));
}

/**
 * Which TMDB endpoint a title's credits live behind.
 *
 * `tmdbMediaType` is written by everything that matches upstream, but a v3 row
 * backfilled by id alone may not carry one — and asking `/movie/{id}/credits`
 * for a show's id does not fail, it answers about a completely different film.
 * Episodes are the tell: a tracker only ever gives a film one.
 */
export function mediaTypeFor(title: TitleV4): MediaType {
  if (title.tmdbMediaType) return title.tmdbMediaType;
  return title.seasons.length > 0 || title.totalEpisodes > 1 ? "tv" : "movie";
}

/** Distinct TMDB person ids in one title's credits that carry this name. */
export function personIdsNamed(credits: readonly TitleCreditPerson[], name: string): number[] {
  const ids: number[] = [];
  for (const credit of credits) {
    if (!sameName(credit.name, name)) continue;
    if (!ids.includes(credit.id)) ids.push(credit.id);
  }
  return ids;
}

/**
 * The `/search/person` hits that are actually this person.
 *
 * A search for "Chris Evans" also returns "Chris Evanson"; only an exact name
 * match is evidence. Sorted by popularity so a picker leads with the likely one
 * without ever *choosing* it.
 */
export function exactNameHits(
  hits: readonly PersonCandidate[],
  name: string,
): PersonCandidate[] {
  return hits
    .filter((hit) => sameName(hit.name, name))
    .slice()
    .sort((a, b) => b.popularity - a.popularity);
}

// ---------------------------------------------------------------------------
// 5. Resolution
// ---------------------------------------------------------------------------

export type PersonResolution =
  | {
      state: "resolved";
      personId: number;
      name: string;
      /** Where the id came from — `credits` is exact, `search` is a name match. */
      source: "cache" | "credits" | "search";
    }
  | { state: "ambiguous"; name: string; candidates: PersonCandidate[] }
  | { state: "unknown"; name: string };

/** How many owned titles are asked for their credits before giving up. */
export const RESOLVE_TITLE_BUDGET = 3;

export interface ResolveDeps {
  client: TmdbPersonClient;
  titles: readonly TitleV4[];
}

/**
 * Name → person, honestly.
 *
 * The library path is tried first because it is the only one that can be
 * *certain*: the id on a film the user owns is the id TMDB itself used for that
 * film. When two owned titles disagree, that disagreement is the answer — two
 * people share this name and the caller must ask which one.
 */
export async function resolvePersonByName(
  name: string,
  deps: ResolveDeps,
): Promise<PersonResolution> {
  const trimmed = name.trim();
  if (trimmed === "") return { state: "unknown", name };

  const seen = new Map<number, { name: string; titles: string[]; department: string }>();
  const candidates = titlesCrediting(deps.titles, trimmed).filter(
    (title) => typeof title.tmdbId === "number" && title.tmdbId > 0,
  );

  for (const title of candidates.slice(0, RESOLVE_TITLE_BUDGET)) {
    let credits: TitleCreditPerson[];
    try {
      credits = await deps.client.titleCredits(title.tmdbId as number, mediaTypeFor(title));
    } catch {
      // One title's credits failing is not the resolution failing.
      continue;
    }
    for (const credit of credits) {
      if (!sameName(credit.name, trimmed)) continue;
      const entry = seen.get(credit.id) ?? {
        name: credit.name,
        titles: [],
        department: credit.department,
      };
      if (!entry.titles.includes(title.title)) entry.titles.push(title.title);
      seen.set(credit.id, entry);
    }
  }

  if (seen.size === 1) {
    const [personId] = [...seen.keys()];
    return {
      state: "resolved",
      personId: personId as number,
      name: seen.get(personId as number)?.name ?? trimmed,
      source: "credits",
    };
  }
  if (seen.size > 1) {
    // Two ids, one name, both in this library. Nothing here can pick between
    // them and pretending otherwise puts the wrong filmography on screen.
    return {
      state: "ambiguous",
      name: trimmed,
      candidates: [...seen.entries()].map(([id, entry]) => ({
        id,
        name: entry.name,
        profileUrl: "",
        knownForDepartment: entry.department,
        knownFor: entry.titles,
        popularity: 0,
      })),
    };
  }

  let hits: PersonCandidate[];
  try {
    hits = exactNameHits(await deps.client.searchPeople(trimmed), trimmed);
  } catch {
    return { state: "unknown", name: trimmed };
  }
  if (hits.length === 0) return { state: "unknown", name: trimmed };
  if (hits.length === 1) {
    return {
      state: "resolved",
      personId: (hits[0] as PersonCandidate).id,
      name: (hits[0] as PersonCandidate).name,
      source: "search",
    };
  }
  return { state: "ambiguous", name: trimmed, candidates: hits };
}

// ---------------------------------------------------------------------------
// 6. Filmography shaping
// ---------------------------------------------------------------------------

export interface FilmographySection {
  department: string;
  credits: PersonCredit[];
}

/**
 * One credit per title per department, roles merged.
 *
 * TMDB lists a director who also produced twice in `crew`, and an actor playing
 * two parts twice in `cast`. Both are one poster with two role names on it.
 */
export function dedupeCredits(credits: readonly PersonCredit[]): PersonCredit[] {
  const byKey = new Map<string, PersonCredit>();
  for (const credit of credits) {
    const key = creditKey(credit.result);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...credit });
      continue;
    }
    if (credit.role !== "" && !existing.role.split(" / ").includes(credit.role)) {
      existing.role = existing.role === "" ? credit.role : `${existing.role} / ${credit.role}`;
    }
    // Prefer the copy that actually has a poster; endpoints vary.
    if (!existing.result.posterUrl && credit.result.posterUrl) existing.result = credit.result;
  }
  return [...byKey.values()];
}

export function creditKey(result: { tmdbId: number; mediaType: MediaType }): string {
  return `${result.mediaType}-${result.tmdbId}`;
}

/**
 * Credits grouped into the sections the screen draws, newest work first.
 *
 * The person's own department leads — an actor's page opens on their acting, a
 * director's on their directing — and the rest follow alphabetically so the
 * order does not shuffle between two people with the same sections.
 */
export function groupFilmography(
  credits: readonly PersonCredit[],
  knownForDepartment = "",
): FilmographySection[] {
  const byDepartment = new Map<string, PersonCredit[]>();
  for (const credit of credits) {
    const list = byDepartment.get(credit.department) ?? [];
    list.push(credit);
    byDepartment.set(credit.department, list);
  }

  const sections: FilmographySection[] = [...byDepartment.entries()]
    .map(([department, list]) => ({
      department,
      credits: dedupeCredits(list).sort(byNewestFirst),
    }))
    .filter((section) => section.credits.length > 0);

  const lead = knownForDepartment || "Acting";
  sections.sort((a, b) => {
    if (a.department === lead) return -1;
    if (b.department === lead) return 1;
    // "Acting" is the section people look for, whatever TMDB calls the rest.
    if (a.department === "Acting") return -1;
    if (b.department === "Acting") return 1;
    return a.department.localeCompare(b.department);
  });
  return sections;
}

function byNewestFirst(a: PersonCredit, b: PersonCredit): number {
  const left = a.result.releaseDate ?? "";
  const right = b.result.releaseDate ?? "";
  // Undated work is announced, not released — it belongs at the end, not at the
  // top where a blank string would otherwise sort it.
  if (left === "" && right === "") return a.result.title.localeCompare(b.result.title);
  if (left === "") return 1;
  if (right === "") return -1;
  return right.localeCompare(left);
}

/**
 * The library title a credit already is, if any.
 *
 * Same rule as `findExisting` in the add modal — TMDB id first, then the name —
 * so a title added before it had an id is still recognised as owned rather than
 * offered back as "+ Add".
 */
export function ownedTitleFor(
  credit: PersonCredit,
  titles: readonly TitleV4[],
): TitleV4 | undefined {
  const byId = titles.find(
    (title) =>
      title.tmdbId === credit.result.tmdbId &&
      (title.tmdbMediaType === undefined || title.tmdbMediaType === credit.result.mediaType),
  );
  if (byId) return byId;
  const key = personNameKey(credit.result.title);
  if (key === "") return undefined;
  return titles.find((title) => personNameKey(title.title) === key);
}

// ---------------------------------------------------------------------------
// 7. Age
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` → `[year, month, day]`, or null if it is not one. */
function parseDateParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return [year, month, day];
}

/**
 * Whole years between two calendar dates.
 *
 * Computed on the date parts rather than through `Date` arithmetic: a birthday
 * is a calendar fact, and putting it through a timezone is how someone born on
 * the 1st turns 40 a day early in Auckland.
 */
export function yearsBetween(from: string, to: string): number | null {
  const start = parseDateParts(from);
  const end = parseDateParts(to);
  if (!start || !end) return null;
  const [fy, fm, fd] = start;
  const [ty, tm, td] = end;
  let years = ty - fy;
  if (tm < fm || (tm === fm && td < fd)) years -= 1;
  return years < 0 ? null : years;
}

export interface AgeFacts {
  /** `1963-12-18`, or `""` when TMDB has no birthday. */
  birthday: string;
  deathday: string;
  /** Age today, or age reached at death. `null` when it cannot be computed. */
  age: number | null;
  /** True when `age` is an age at death rather than a current age. */
  atDeath: boolean;
}

/**
 * Birthday, death date and the age that follows from them.
 *
 * Three cases the screen must not get wrong: someone living (age today), someone
 * dead (the age they reached, never the age they *would* be), and someone TMDB
 * has no birthday for (no age at all, rather than a confident zero).
 */
export function ageFacts(person: TmdbPerson, today: DateString): AgeFacts {
  const birthday = person.birthday ?? "";
  const deathday = person.deathday ?? "";
  if (birthday === "") return { birthday: "", deathday, age: null, atDeath: deathday !== "" };
  if (deathday !== "") {
    return { birthday, deathday, age: yearsBetween(birthday, deathday), atDeath: true };
  }
  return { birthday, deathday: "", age: yearsBetween(birthday, today), atDeath: false };
}

/** `1963-12-18 (age 62)` / `1937-03-01 (aged 84 at death)` / `1963-12-18`. */
export function birthdayLabel(facts: AgeFacts): string {
  if (facts.birthday === "") return "";
  if (facts.age === null) return facts.birthday;
  return facts.atDeath
    ? `${facts.birthday} (aged ${facts.age} at death)`
    : `${facts.birthday} (age ${facts.age})`;
}

// ---------------------------------------------------------------------------
// 8. The cache
// ---------------------------------------------------------------------------

/** The preserved `data.json` key this cache lives under. */
export const PERSON_CACHE_KEY = "people";
export const PERSON_CACHE_VERSION = 1;
/** A biography does not change weekly; a filmography barely does. */
export const PERSON_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** People kept before the oldest is evicted. Credits lists are not small. */
export const PERSON_CACHE_MAX = 40;

export interface PersonCacheEntry {
  person: TmdbPerson;
  credits: PersonCredit[];
  fetchedAt: IsoTimestamp;
}

/** What a name resolved to, so the same lookup never runs twice. */
export interface PersonNameEntry {
  personId?: number;
  /** Ids that share this name. Present only for the ambiguous outcome. */
  candidateIds?: number[];
  checkedAt: IsoTimestamp;
}

export interface PersonCacheData {
  version: number;
  byId: Record<string, PersonCacheEntry>;
  names: Record<string, PersonNameEntry>;
}

export function emptyPersonCache(): PersonCacheData {
  return { version: PERSON_CACHE_VERSION, byId: {}, names: {} };
}

/**
 * The cache object on `data`, created on first use.
 *
 * Read through `readExtra`/`writeExtra` because `WatchLogData` is declared
 * strictly and this key is one of the preserved ones — see the runtime contract
 * at the top of `types.ts`. A cache written by a newer version is discarded
 * rather than half-read.
 */
export function personCacheOf(data: WatchLogData): PersonCacheData {
  const raw = readExtra<Partial<PersonCacheData>>(data, PERSON_CACHE_KEY);
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.version !== PERSON_CACHE_VERSION ||
    typeof raw.byId !== "object" ||
    raw.byId === null
  ) {
    const fresh = emptyPersonCache();
    writeExtra(data, PERSON_CACHE_KEY, fresh);
    return fresh;
  }
  if (typeof raw.names !== "object" || raw.names === null) raw.names = {};
  return raw as PersonCacheData;
}

/** Oldest-first eviction at a hard cap, the same rule the anime cache uses. */
export function evictPeople(cache: PersonCacheData, max = PERSON_CACHE_MAX): void {
  const ids = Object.keys(cache.byId);
  if (ids.length <= max) return;
  const oldest = ids
    .map((id) => ({ id, at: cache.byId[id]?.fetchedAt ?? "" }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, ids.length - max);
  for (const entry of oldest) delete cache.byId[entry.id];
}

// ---------------------------------------------------------------------------
// 9. The service
// ---------------------------------------------------------------------------

/** The slice of the store this service needs. `WatchLogStoreApi` satisfies it. */
export interface PersonStoreLike {
  readonly data: WatchLogData;
  allTitles(): readonly TitleV4[];
  save(reason?: string): void;
}

export interface PersonServiceDeps {
  store: PersonStoreLike;
  client: TmdbPersonClient;
  /** Injected so the TTL is testable without waiting a month. */
  now?: () => number;
  ttlMs?: number;
}

export interface PersonService {
  configured(): boolean;
  /** The cached entry, fresh or stale. Never touches the network. */
  cached(personId: number): PersonCacheEntry | undefined;
  isStale(entry: PersonCacheEntry): boolean;
  /** A name already resolved, from cache only. */
  cachedResolution(name: string): PersonResolution | undefined;
  resolve(name: string): Promise<PersonResolution>;
  /** Cached when possible; fetches only when absent, stale or forced. */
  load(personId: number, options?: { force?: boolean }): Promise<PersonCacheEntry>;
  /** Pin a name to a person the user picked out of an ambiguous list. */
  rememberChoice(name: string, personId: number): void;
}

export function createPersonService(deps: PersonServiceDeps): PersonService {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? PERSON_CACHE_TTL_MS;
  const cache = (): PersonCacheData => personCacheOf(deps.store.data);

  function isStale(entry: PersonCacheEntry): boolean {
    const at = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(at)) return true;
    return now() - at >= ttlMs;
  }

  function cached(personId: number): PersonCacheEntry | undefined {
    return cache().byId[String(personId)];
  }

  function cachedResolution(name: string): PersonResolution | undefined {
    const key = personNameKey(name);
    if (key === "") return undefined;
    const entry = cache().names[key];
    if (!entry) return undefined;
    if (entry.personId !== undefined) {
      return {
        state: "resolved",
        personId: entry.personId,
        name: cached(entry.personId)?.person.name ?? name.trim(),
        source: "cache",
      };
    }
    if (entry.candidateIds && entry.candidateIds.length > 1) {
      // Only the ids were kept; the names come back from whatever is cached.
      return {
        state: "ambiguous",
        name: name.trim(),
        candidates: entry.candidateIds.map((id) => ({
          id,
          name: cached(id)?.person.name ?? name.trim(),
          profileUrl: cached(id)?.person.profileUrl ?? "",
          knownForDepartment: cached(id)?.person.knownForDepartment ?? "",
          knownFor: [],
          popularity: 0,
        })),
      };
    }
    return undefined;
  }

  function writeName(name: string, entry: PersonNameEntry): void {
    const key = personNameKey(name);
    if (key === "") return;
    cache().names[key] = entry;
    deps.store.save("person-name-resolved");
  }

  return {
    configured: () => deps.client.configured(),
    cached,
    isStale,
    cachedResolution,

    async resolve(name) {
      const hit = cachedResolution(name);
      if (hit) return hit;
      const outcome = await resolvePersonByName(name, {
        client: deps.client,
        titles: deps.store.allTitles(),
      });
      if (outcome.state === "resolved") {
        writeName(name, { personId: outcome.personId, checkedAt: new Date(now()).toISOString() });
      } else if (outcome.state === "ambiguous") {
        writeName(name, {
          candidateIds: outcome.candidates.map((c) => c.id),
          checkedAt: new Date(now()).toISOString(),
        });
      }
      return outcome;
    },

    async load(personId, options = {}) {
      const entry = cached(personId);
      if (entry && !options.force && !isStale(entry)) return entry;
      try {
        const fetched = await deps.client.person(personId);
        const next: PersonCacheEntry = {
          person: fetched.person,
          credits: fetched.credits,
          fetchedAt: new Date(now()).toISOString(),
        };
        const store = cache();
        store.byId[String(personId)] = next;
        evictPeople(store);
        deps.store.save("person-cached");
        return next;
      } catch (err) {
        // Stale beats an error screen: the filmography from last month is still
        // very nearly this month's, and the network is not the user's problem.
        if (entry) return entry;
        throw err;
      }
    },

    rememberChoice(name, personId) {
      writeName(name, { personId, checkedAt: new Date(now()).toISOString() });
    },
  };
}
