/**
 * The reading half of the store (`types.ts` §10.4, `ReadingStoreApi`).
 *
 * `WatchLogStore` guarantees `store.reading` exists and is the live object that
 * gets written to `data.json`; this adapter is the only thing that mutates it.
 * Every rule the title store follows applies here, and one of them is the whole
 * reason this is an adapter rather than a set of object literals:
 *
 *   **Rows are mutated, never rebuilt.** `data.reading` in a real vault carries
 *   fields no version of v4 has heard of — `shelfLocation`, `lentTo`,
 *   `physicalCopies` — and `{...defaults, ...patch}` over a *typed* view of a row
 *   deletes every one of them. `Object.assign(row, patch)` keeps them, which is
 *   what `tests/reading-games.test.ts` pins for migration and what this file
 *   pins for editing.
 *
 * The rest is the same discipline as `data/store.ts`: one debounced writer, one
 * `watchlog-data-changed` per mutation, `dateModified` stamped by the store and
 * never by the caller, and activity logged with v3's `Reading` source so the Log
 * tab reads continuously across the version boundary.
 */
import {
  type Book,
  type CustomColumn,
  type Manga,
  type ReadingData,
  type ReadingKind,
  type ReadingPatch,
  type ReadingStoreApi,
  type WatchLogStoreApi,
} from "../../types";
import { createBook, createManga, uniqueId } from "../../data/schema";
import { derivedStatus, type ReadingEntry } from "./progress";

/** v3's activity-log source for reading rows. */
export const READING_LOG_SOURCE = "Reading";

export interface ReadingStoreOptions {
  /**
   * Called after a row is added, changed or removed, with the row when it still
   * exists. The note mirror hangs off this; a failure there must never reach the
   * data write, so the callback is invoked inside a try/catch.
   */
  onChanged?: (entry: ReadingEntry | undefined, kind: ReadingKind, id: string, reason: string) => void;
}

export interface ReadingStore extends ReadingStoreApi {
  /** Every book and manga in one list, for cross-shelf work (search, stats). */
  allEntries(): readonly ReadingEntry[];
  getEntry(kind: ReadingKind, id: string): ReadingEntry | undefined;
  /** Kind-agnostic edit, so the detail modal does not branch twice per field. */
  update(kind: ReadingKind, id: string, patch: ReadingPatch, reason?: string): ReadingEntry | undefined;
  remove(kind: ReadingKind, id: string): boolean;
  columns(kind: ReadingKind): CustomColumn[];
  /** An id nothing else on that shelf is using. */
  nextId(kind: ReadingKind, title: string): string;
}

export function createReadingStore(
  store: WatchLogStoreApi,
  options: ReadingStoreOptions = {},
): ReadingStore {
  const reading = (): ReadingData => store.reading;

  function notify(entry: ReadingEntry | undefined, kind: ReadingKind, id: string, reason: string): void {
    try {
      options.onChanged?.(entry, kind, id, reason);
    } catch (err) {
      // The note mirror is a mirror. Losing it must not lose the edit.
      console.error("[wrl] reading change hook failed", err);
    }
  }

  function commit(reason: string, ids: string[]): void {
    store.save(reason);
    store.emitChanged({ reason, titleIds: ids });
  }

  function list(kind: ReadingKind): ReadingEntry[] {
    return kind === "book" ? reading().books : reading().manga;
  }

  function find(kind: ReadingKind, id: string): ReadingEntry | undefined {
    return list(kind).find((entry) => entry.id === id);
  }

  /**
   * Apply a patch to a live row.
   *
   * `undefined` values are skipped rather than written: a patch built from a
   * partially-filled form must not blank a field it simply did not mention.
   */
  function applyPatch(entry: ReadingEntry, patch: ReadingPatch): boolean {
    let changed = false;
    const target = entry as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (key === "id" || key === "dateAdded" || key === "dateModified") continue;
      if (target[key] === value) continue;
      target[key] = value;
      changed = true;
    }
    return changed;
  }

  function update(
    kind: ReadingKind,
    id: string,
    patch: ReadingPatch,
    reason = "reading-updated",
  ): ReadingEntry | undefined {
    const entry = find(kind, id);
    if (!entry) return undefined;

    const before = derivedStatus(entry);
    const beforeRating = entry.rating;
    if (!applyPatch(entry, patch)) return entry;

    entry.dateModified = new Date().toISOString();
    // v3 stamped the moment a title *became* a favourite and never cleared it;
    // the same, because the Dashboard sorts favourites by when they were made.
    if (patch.favorite === true && !entry.dateFavorited) {
      entry.dateFavorited = entry.dateModified;
    }

    const after = derivedStatus(entry);
    if (after === "Completed" && before !== "Completed") {
      store.logActivity({
        action: "completed",
        source: READING_LOG_SOURCE,
        message: `Finished «${entry.title}»`,
        titleId: entry.id,
        titleName: entry.title,
      });
    } else if (patch.rating !== undefined && patch.rating !== beforeRating && entry.rating > 0) {
      store.logActivity({
        action: "rating",
        source: READING_LOG_SOURCE,
        message: `Rated «${entry.title}» ${entry.rating}★`,
        titleId: entry.id,
        titleName: entry.title,
      });
    }

    notify(entry, kind, id, reason);
    commit(reason, [id]);
    return entry;
  }

  function remove(kind: ReadingKind, id: string): boolean {
    const rows = list(kind);
    const index = rows.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [removed] = rows.splice(index, 1);
    if (removed) {
      store.logActivity({
        action: "deleted",
        source: READING_LOG_SOURCE,
        message: `Removed «${removed.title}» from ${kind === "book" ? "books" : "manga"}`,
        titleId: id,
        titleName: removed.title,
      });
    }
    notify(undefined, kind, id, "reading-deleted");
    commit("reading-deleted", [id]);
    return true;
  }

  function add(entry: ReadingEntry, kind: ReadingKind): void {
    if (kind === "book") reading().books.push(entry as Book);
    else reading().manga.push(entry as Manga);
    store.logActivity({
      action: "added",
      source: READING_LOG_SOURCE,
      message: `Added «${entry.title}» to ${kind === "book" ? "books" : "manga"}`,
      titleId: entry.id,
      titleName: entry.title,
    });
    notify(entry, kind, entry.id, "reading-added");
    commit("reading-added", [entry.id]);
  }

  return {
    get reading(): ReadingData {
      return reading();
    },

    allBooks: () => reading().books,
    allManga: () => reading().manga,
    allEntries: () => [...reading().books, ...reading().manga],

    getBook: (id) => reading().books.find((book) => book.id === id),
    getManga: (id) => reading().manga.find((manga) => manga.id === id),
    getEntry: (kind, id) => find(kind, id),

    addBook: (book) => add(book, "book"),
    addManga: (manga) => add(manga, "manga"),

    updateBook: (id, patch, reason) => update("book", id, patch, reason) as Book | undefined,
    updateManga: (id, patch, reason) => update("manga", id, patch, reason) as Manga | undefined,
    update,

    deleteBook: (id) => remove("book", id),
    deleteManga: (id) => remove("manga", id),
    remove,

    setColumns(kind: ReadingKind, columns: CustomColumn[]): void {
      const data = reading();
      if (kind === "book") data.bookColumns = columns;
      else data.mangaColumns = columns;
      commit("reading-columns", []);
    },

    columns: (kind) => (kind === "book" ? reading().bookColumns : reading().mangaColumns),

    nextId(kind: ReadingKind, title: string): string {
      // Ids are unique per shelf in v3 (a book and a manga may share one), but
      // uniqueness across both costs nothing and keeps cross-shelf lookups safe.
      const taken = [...reading().books, ...reading().manga].map((entry) => entry.id);
      return uniqueId(title, taken);
    },
  };
}

// ---------------------------------------------------------------------------
// New rows
// ---------------------------------------------------------------------------

export interface NewEntrySeed {
  title: string;
  author?: string;
  coverUrl?: string;
  categories?: string[];
  externalLink?: string;
  releaseDate?: string | null;
  totalPages?: number;
  totalChapters?: number;
  totalVolumes?: number;
  googleBooksId?: string;
  malId?: string;
}

/**
 * A complete row, with every field the contract promises present.
 *
 * `createBook`/`createManga` from `data/schema.ts` are the single source of the
 * defaults, so a row added here and a row repaired by migration are the same
 * shape — including `customFields: {}`, which the table walks unconditionally.
 */
export function buildReadingEntry(
  kind: ReadingKind,
  id: string,
  seed: NewEntrySeed,
  data: ReadingData,
): ReadingEntry {
  const status = data.settings.defaultStatus;
  if (kind === "book") {
    return createBook({
      id,
      title: seed.title,
      status,
      ...(seed.author !== undefined ? { author: seed.author } : {}),
      ...(seed.coverUrl !== undefined ? { coverUrl: seed.coverUrl } : {}),
    ...(seed.categories !== undefined ? { categories: [...seed.categories] } : {}),
      ...(seed.categories !== undefined ? { categories: [...seed.categories] } : {}),
      ...(seed.externalLink !== undefined ? { externalLink: seed.externalLink } : {}),
      ...(seed.releaseDate !== undefined ? { releaseDate: seed.releaseDate } : {}),
      ...(seed.totalPages !== undefined ? { totalPages: seed.totalPages } : {}),
      ...(seed.totalChapters !== undefined ? { totalChapters: seed.totalChapters } : {}),
      ...(seed.googleBooksId !== undefined ? { googleBooksId: seed.googleBooksId } : {}),
    });
  }
  return createManga({
    id,
    title: seed.title,
    status,
    ...(seed.author !== undefined ? { author: seed.author } : {}),
    ...(seed.coverUrl !== undefined ? { coverUrl: seed.coverUrl } : {}),
    ...(seed.externalLink !== undefined ? { externalLink: seed.externalLink } : {}),
    ...(seed.releaseDate !== undefined ? { releaseDate: seed.releaseDate } : {}),
    ...(seed.totalChapters !== undefined ? { totalChapters: seed.totalChapters } : {}),
    ...(seed.totalVolumes !== undefined ? { totalVolumes: seed.totalVolumes } : {}),
    ...(seed.malId !== undefined ? { malId: seed.malId } : {}),
  });
}

/** True when a title is already on that shelf — the add flow's duplicate guard. */
export function findExistingReading(
  data: ReadingData,
  kind: ReadingKind,
  title: string,
): ReadingEntry | undefined {
  const needle = title.trim().toLowerCase();
  if (needle === "") return undefined;
  const rows: ReadingEntry[] = kind === "book" ? data.books : data.manga;
  return rows.find((entry) => (entry.title ?? "").trim().toLowerCase() === needle);
}
