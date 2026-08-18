/**
 * Dashboard poster shelves — the pure selection half.
 *
 * A shelf is a titled horizontal row of poster cards, the shape every streaming
 * service uses to answer "what now" without making the user search. Four of them
 * ship: Favourites, Recently added, Recently watched, Recently released.
 *
 * Everything here is pure and takes `now` as an argument, because the only
 * interesting thing about three of these four shelves is a date comparison and a
 * date comparison against the wall clock is not testable.
 *
 * Two disciplines this module is deliberate about:
 *
 *   1. **No hardcoded status names.** Statuses are user-configurable
 *      (`settings.statuses[].name`), so "is the user still following this?"
 *      cannot be a literal list of names. It is derived from the two notions the
 *      codebase already has — `NON_COUNTING_STATUSES` (the statuses the
 *      dashboard's completion ratio refuses to count: Dropped, To be released)
 *      and `isFullyWatched` / `STATUS_COMPLETED` — so a status the user invents
 *      tomorrow counts as followed from the moment it exists, which is the only
 *      safe default. See `isActivelyFollowed`.
 *   2. **Dates are compared as strings.** `YYYY-MM-DD` and ISO-8601 timestamps
 *      both sort lexicographically, so ordering needs no `Date` objects and
 *      therefore no timezone to be wrong about. A missing or malformed date
 *      becomes `""`, which sorts last in every descending comparison here.
 */
import { NON_COUNTING_STATUSES, STATUS_COMPLETED } from "../constants";
import { isFullyWatched } from "../data/episodes";
import { isSingleSitting } from "../data/review";
import { toDateString } from "../services/airing";
import { readExtra, writeExtra, type Settings, type TitleV4 } from "../types";

/**
 * Items per shelf. A "recently X" shelf is a glance, not a library.
 *
 * Favourites is deliberately exempt — see `favouritesShelf`.
 */
export const SHELF_SIZE = 12;

/** The four shelves this module defines by hand. */
export type CuratedShelfId = "favourites" | "recentlyAdded" | "recentlyWatched" | "recentlyReleased";

/**
 * A shelf that *is* one of the user's statuses, e.g. `status:Plan to watch`.
 *
 * Not an enum, because the thing it names is not one: statuses are
 * user-configurable and a status invented this afternoon has to be able to
 * become a shelf without a code change. The id carries the name rather than an
 * index so it survives the user reordering or renaming the list — a renamed
 * status simply becomes a new id, which then falls back to this kind's default
 * (hidden, see `shelfDefaultVisible`) rather than inheriting an answer the user
 * gave about a different status.
 */
export type StatusShelfId = `status:${string}`;

export type ShelfId = CuratedShelfId | StatusShelfId;

export interface Shelf {
  id: ShelfId;
  label: string;
  titles: TitleV4[];
}

export const CURATED_SHELF_IDS: readonly CuratedShelfId[] = [
  "favourites",
  "recentlyAdded",
  "recentlyWatched",
  "recentlyReleased",
];

export const SHELF_LABELS: Record<CuratedShelfId, string> = {
  favourites: "Favourites",
  recentlyAdded: "Recently added",
  recentlyWatched: "Recently watched",
  recentlyReleased: "Recently released",
};

/**
 * What each curated shelf actually selects, in one sentence.
 *
 * These are the descriptions under the toggles in the "Choose visible shelves"
 * modal, and they live here rather than in the modal for the same reason the
 * labels do: a shelf's rule is defined in this file, so the sentence describing
 * that rule cannot be allowed to drift away from it in another one.
 */
export const SHELF_DESCRIPTIONS: Record<CuratedShelfId, string> = {
  favourites: "Everything you have marked with the heart, alphabetically and uncapped.",
  recentlyAdded: "The newest titles in your library.",
  recentlyWatched:
    "Titles with episodes ticked off, or films completed, most recently.",
  recentlyReleased:
    "Titles you are still following that have had an episode air or a release come out.",
};

const STATUS_SHELF_PREFIX = "status:";

/** `"Plan to watch"` → `"status:Plan to watch"`. */
export function statusShelfId(status: string): StatusShelfId {
  return `${STATUS_SHELF_PREFIX}${status}`;
}

export function isStatusShelfId(id: string): id is StatusShelfId {
  return id.startsWith(STATUS_SHELF_PREFIX);
}

/** The status a shelf id names, or `null` for the four curated ones. */
export function statusShelfName(id: string): string | null {
  return isStatusShelfId(id) ? id.slice(STATUS_SHELF_PREFIX.length) : null;
}

/** Heading for any shelf id, curated or status. */
export function shelfLabel(id: ShelfId): string {
  return statusShelfName(id) ?? SHELF_LABELS[id as CuratedShelfId] ?? id;
}

/**
 * The user's statuses, in their configured order, cleaned up.
 *
 * Blank names cannot be a shelf (a rail with no heading is a rail nobody can
 * turn off) and a duplicate name would produce two shelves sharing one id and
 * therefore one toggle, so both are dropped here rather than everywhere that
 * walks the list.
 */
export function shelfStatusNames(settings: Settings): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const status of settings.statuses ?? []) {
    const name = (status?.name ?? "").trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** A date-ish field as a sortable string; `""` for anything unusable. */
function dateKey(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Newest first, with the undated sorted to the back rather than to the front. */
function byKeyDesc<T>(key: (item: T) => string) {
  return (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return 0;
    if (ka === "") return 1;
    if (kb === "") return -1;
    return kb < ka ? -1 : 1;
  };
}

/** When the title entered the library. */
export function addedKey(title: TitleV4): string {
  return dateKey(title.dateAdded);
}

/**
 * When the user last watched something of this title.
 *
 * There is no per-episode watch date in the schema, so the honest answer is the
 * same one the dashboard's "Recently watched" panel already uses: the date the
 * title was finished, or — for something still in progress — the last time it
 * was touched at all, which is what ticking an episode bumps. A title that has
 * never been watched has neither and returns `""`.
 */
export function watchedKey(title: TitleV4): string {
  const finished = dateKey(title.dateFinished);
  const modified = dateKey(title.dateModified);
  return finished > modified ? finished : modified;
}

/** Has the user actually watched any of this? */
export function hasBeenWatched(title: TitleV4): boolean {
  return (
    title.watchedEpisodes.length > 0 ||
    title.status === STATUS_COMPLETED ||
    isFullyWatched(title) ||
    dateKey(title.dateFinished) !== ""
  );
}

/**
 * When this title last put something in front of the user.
 *
 * A film releases once, so its signal is its release date. A show releases every
 * week, so its signal is its most recently aired episode — otherwise a series
 * that started in 2011 and aired an episode last night would sort below a film
 * from 2012, which is the opposite of "recently released". Falls back to the
 * release date when nothing upstream has been cached yet.
 */
export function releaseKey(title: TitleV4): string {
  const release = dateKey(title.releaseDate);
  if (isSingleSitting(title)) return release;
  const aired = dateKey(title.airing?.lastEpisode?.airDate);
  return aired !== "" ? aired : release;
}

/**
 * Is the user still following this title?
 *
 * Statuses are user-configurable, so this is defined by exclusion rather than by
 * a list of names: everything except the statuses the dashboard already refuses
 * to count (`NON_COUNTING_STATUSES` — Dropped and To be released) and except
 * what is finished. A brand-new user-invented status is followed by default,
 * because "I made a status the plugin has never heard of" must not silently
 * empty a shelf.
 */
export function isActivelyFollowed(title: TitleV4): boolean {
  if (NON_COUNTING_STATUSES.includes(title.status)) return false;
  if (title.status === STATUS_COMPLETED) return false;
  return !isFullyWatched(title);
}

// ---------------------------------------------------------------------------
// The four shelves
// ---------------------------------------------------------------------------

/**
 * Every favourite, alphabetically — and *uncapped*, unlike the other three.
 *
 * The cap exists because "recently X" is a window onto something unbounded: the
 * thirteenth most recently added title is not news, so cutting the row costs
 * nothing. Favourites is not a window, it is a set the user built by hand, and
 * silently hiding the back half of it is the one thing a favourites row must not
 * do. Alphabetical for the same reason: a hand-built set is browsed for a known
 * title, not scanned for the newest one.
 */
export function favouritesShelf(titles: readonly TitleV4[]): TitleV4[] {
  return titles.filter((title) => title.favorite).sort((a, b) => a.title.localeCompare(b.title));
}

export function recentlyAddedShelf(titles: readonly TitleV4[]): TitleV4[] {
  return titles
    .filter((title) => addedKey(title) !== "")
    .sort(byKeyDesc(addedKey))
    .slice(0, SHELF_SIZE);
}

export function recentlyWatchedShelf(titles: readonly TitleV4[]): TitleV4[] {
  return titles
    .filter((title) => hasBeenWatched(title) && watchedKey(title) !== "")
    .sort(byKeyDesc(watchedKey))
    .slice(0, SHELF_SIZE);
}

/**
 * Followed titles whose release signal has already happened, newest first.
 *
 * The date filter is inclusive of today and strict about the future: a show with
 * a `lastEpisode` dated next week — which upstream data can and does produce
 * during a refresh — is *not* recently released, it is upcoming, and the
 * Upcoming tab is where it belongs.
 */
export function recentlyReleasedShelf(titles: readonly TitleV4[], now: Date): TitleV4[] {
  const today = toDateString(now);
  return titles
    .filter((title) => {
      if (!isActivelyFollowed(title)) return false;
      const key = releaseKey(title);
      return key !== "" && key.slice(0, 10) <= today;
    })
    .sort(byKeyDesc(releaseKey))
    .slice(0, SHELF_SIZE);
}

/**
 * One status, as a shelf: everything currently in it, most recently touched first.
 *
 * Ordered by `watchedKey` rather than by `dateAdded` because a status shelf is
 * read as "where am I in this pile", and the pile's front is whatever the user
 * last did something to. `watchedKey` falls back to `dateModified`, which every
 * title has, so a status nobody has watched anything in — "Plan to watch" — is
 * still ordered by something real instead of collapsing to insertion order.
 *
 * **The tiebreak is not optional.** The other four shelves are windows onto a
 * date, and two items sharing a date is a curiosity. A status shelf is a *set*,
 * and the vault this was built for has seven titles in one status carrying no
 * usable timestamp between them — at which point "most recently touched" orders
 * nothing at all and the row is whatever `sort` happened to leave, which is a
 * different row after a save and looks like a bug the user cannot reproduce. So
 * anything undated, and any exact tie, falls through to the title. Every title
 * has one, so the order below is total: the same library always paints the same
 * row.
 *
 * Capped like the other windows: the Library tab is where a full status list is
 * browsed, and a rail of two hundred posters is not a glance.
 */
export function statusShelf(titles: readonly TitleV4[], status: string): TitleV4[] {
  return titles
    .filter((title) => title.status === status)
    .sort((a, b) => {
      const ka = watchedKey(a);
      const kb = watchedKey(b);
      // Undated to the back, exactly as `byKeyDesc` does — but then keep going
      // rather than calling two undated titles equal.
      if (ka !== kb) {
        if (ka === "") return 1;
        if (kb === "") return -1;
        return kb < ka ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, SHELF_SIZE);
}

// ---------------------------------------------------------------------------
// Which shelves the user wants to see
// ---------------------------------------------------------------------------

/**
 * `Settings` key holding the shelf → visible map.
 *
 * Read and written through `readExtra`/`writeExtra` (see the header of
 * `types.ts`) so this lane adds a persisted preference without editing the
 * frozen contract. The map is *sparse*: a missing entry means "whatever this
 * shelf's default is", never "hidden". That is what makes an untouched
 * `data.json` — every one that exists today — paint the dashboard it has always
 * painted, and what lets a shelf invented by a later version decide its own
 * default instead of inheriting a `false` nobody wrote.
 */
export const VISIBLE_SHELVES_KEY = "visibleShelves";

/** Shelf id → shown. Sparse on purpose — see `shelfDefaultVisible`. */
export type VisibleShelves = Record<string, boolean>;

/**
 * Is this shelf shown when the user has never said?
 *
 * The four curated shelves: **yes**. They are what the Dashboard has always
 * drawn, and a new preference that quietly removes something is not a
 * preference, it is a regression.
 *
 * A status shelf: **no**. These are new, and there is one per status — a vault
 * with five statuses would gain up to five rows of posters above its statistics
 * the next time it opened, without anyone asking for them. So they ship as
 * something to switch on rather than something to discover and switch off, and
 * the modal reads honestly in two halves: the top group is what you already
 * have, the bottom group is what you can add.
 */
export function shelfDefaultVisible(id: ShelfId): boolean {
  return !isStatusShelfId(id);
}

/** The stored map, or an empty one for anything that is not a map of booleans. */
export function readVisibleShelves(settings: Settings): VisibleShelves {
  const raw = readExtra<unknown>(settings, VISIBLE_SHELVES_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: VisibleShelves = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** The user's answer if they gave one, this shelf's default otherwise. */
export function isShelfVisible(settings: Settings, id: ShelfId): boolean {
  return readVisibleShelves(settings)[id] ?? shelfDefaultVisible(id);
}

/**
 * Show or hide one shelf, in place.
 *
 * Mutates `settings` rather than returning a new one: `Settings` carries keys
 * TypeScript cannot see and rebuilding it from a literal would drop them
 * (`types.ts` header). The caller still owns the save.
 */
export function setShelfVisible(settings: Settings, id: ShelfId, visible: boolean): void {
  const map = { ...readVisibleShelves(settings) };
  map[id] = visible;
  writeExtra(settings, VISIBLE_SHELVES_KEY, map);
}

/** One row of the "Choose visible shelves" modal. */
export interface ShelfToggle {
  id: ShelfId;
  label: string;
  description: string;
  visible: boolean;
}

/** The modal's two groups, both generated rather than listed. */
export interface ShelfToggleGroups {
  curated: ShelfToggle[];
  statuses: ShelfToggle[];
}

/**
 * Every toggle the modal should offer, for these settings.
 *
 * Derived from `CURATED_SHELF_IDS` and from `settings.statuses` — never from a
 * hand-kept parallel list, which is the one way a settings screen ends up
 * offering a switch for something that no longer exists.
 */
export function shelfToggles(settings: Settings): ShelfToggleGroups {
  const visible = readVisibleShelves(settings);
  // One source of truth for "is it on", shared with `isShelfVisible`, so the
  // switch a user sees can never disagree with the row they are looking at.
  const shown = (id: ShelfId): boolean => visible[id] ?? shelfDefaultVisible(id);
  return {
    curated: CURATED_SHELF_IDS.map((id) => ({
      id,
      label: SHELF_LABELS[id],
      description: SHELF_DESCRIPTIONS[id],
      visible: shown(id),
    })),
    statuses: shelfStatusNames(settings).map((name) => {
      const id = statusShelfId(name);
      return {
        id,
        label: name,
        description: `A row of everything currently marked “${name}”.`,
        visible: shown(id),
      };
    }),
  };
}

/**
 * The shelves worth painting, in reading order.
 *
 * A shelf with nothing on it is omitted entirely rather than rendered as an
 * empty headed row: a heading over a void reads as a bug, and four of them reads
 * as a broken tab. The caller therefore never has to check for emptiness — if it
 * is in this list, it has cards.
 *
 * `settings` is optional, and its absence is not "defaults" — it is the older,
 * smaller contract: the four curated shelves, unfiltered. A caller that has the
 * user's settings passes them and gets the same four (they default to shown)
 * plus whichever status shelves the user has switched *on* — none of them, until
 * they do. Keeping the two-argument call meaning exactly what it always meant is
 * what lets the pure shelf tests stay about selection rather than preferences.
 */
export function buildShelves(
  titles: readonly TitleV4[],
  now: Date = new Date(),
  settings?: Settings,
): Shelf[] {
  const built: Shelf[] = [
    { id: "favourites", label: SHELF_LABELS.favourites, titles: favouritesShelf(titles) },
    { id: "recentlyAdded", label: SHELF_LABELS.recentlyAdded, titles: recentlyAddedShelf(titles) },
    {
      id: "recentlyWatched",
      label: SHELF_LABELS.recentlyWatched,
      titles: recentlyWatchedShelf(titles),
    },
    {
      id: "recentlyReleased",
      label: SHELF_LABELS.recentlyReleased,
      titles: recentlyReleasedShelf(titles, now),
    },
  ];

  if (settings) {
    for (const name of shelfStatusNames(settings)) {
      built.push({ id: statusShelfId(name), label: name, titles: statusShelf(titles, name) });
    }
  }

  return built.filter(
    (shelf) => shelf.titles.length > 0 && (!settings || isShelfVisible(settings, shelf.id)),
  );
}
