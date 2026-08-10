/**
 * Reading progress — the whole of the domain's arithmetic, in one pure module.
 *
 * Books and manga count different things, and v3 let a single book count two of
 * them: `progressUnit` switches between pages and words, and **both counters are
 * kept** when it flips, so a book tracked in words for the first half and pages
 * for the second does not lose either number. Every statistic folds words into
 * pages at v3's rate (`WORDS_PER_PAGE`, 250) so the two are comparable — a rate
 * that must not drift, or a dashboard number changes meaning between versions.
 *
 * The other rule with teeth: **`To be released` is derived, never chosen**
 * (`report-watchlog.md` §1.3). A reading entry whose `releaseDate` is in the
 * future reports that status regardless of what is stored, and an entry still
 * carrying the status after its date has passed falls back to the default rather
 * than sitting in a state the user cannot leave.
 *
 * No obsidian import, no DOM, no store — everything here takes values and
 * returns values, so the maths is unit-tested without mounting anything.
 */
import {
  WORDS_PER_PAGE,
  type Book,
  type DateString,
  type Manga,
  type ProgressUnit,
  type ReadingKind,
  type ReadingPatch,
  type ReadingStatus,
} from "../../types";

export type ReadingEntry = Book | Manga;

/** The status an entry lands on the moment it is finished. */
export const STATUS_COMPLETED: ReadingStatus = "Completed";
/** What a started entry becomes, and where a stale `To be released` falls back to. */
export const STATUS_READING: ReadingStatus = "Reading";
export const STATUS_PLAN_TO_READ: ReadingStatus = "Plan to Read";
export const STATUS_TO_BE_RELEASED: ReadingStatus = "To be released";
export const STATUS_DROPPED: ReadingStatus = "Dropped";

/**
 * Books carry `progressUnit`; manga never do. The discriminator is a field the
 * v3 shape guarantees per kind, so a row read straight off disk narrows without
 * anyone having to remember which array it came out of.
 */
export function isBook(entry: ReadingEntry): entry is Book {
  return "progressUnit" in entry;
}

export function kindOf(entry: ReadingEntry): ReadingKind {
  return isBook(entry) ? "book" : "manga";
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/**
 * What an entry is measured in right now, and how far along it is.
 *
 * `noun` is the singular unit, so a caller can say "312 of 528 pages" or
 * "3 chapters left" without a second lookup table.
 */
export interface ProgressCounter {
  read: number;
  total: number;
  unit: "pages" | "words" | "chapters";
  noun: string;
}

function nonNegative(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/** The counter the entry's own settings say it is tracked by. */
export function primaryCounter(entry: ReadingEntry): ProgressCounter {
  if (isBook(entry)) {
    if (entry.progressUnit === "words") {
      return {
        read: nonNegative(entry.wordsRead),
        total: nonNegative(entry.totalWords),
        unit: "words",
        noun: "word",
      };
    }
    return {
      read: nonNegative(entry.pagesRead),
      total: nonNegative(entry.totalPages),
      unit: "pages",
      noun: "page",
    };
  }
  return {
    read: nonNegative(entry.chaptersRead),
    total: nonNegative(entry.totalChapters),
    unit: "chapters",
    noun: "chapter",
  };
}

/**
 * Manga's second axis. Volumes are a real counter in v3 but never the one that
 * drives the percentage — a series is 374 chapters long whether or not the
 * user's shelf has caught up in volumes.
 */
export function volumeCounter(manga: Manga): { read: number; total: number } {
  return { read: nonNegative(manga.volumesRead), total: nonNegative(manga.totalVolumes) };
}

/**
 * Percent complete, 0–100.
 *
 * Zero when there is nothing to be a fraction of: an entry with no total is not
 * "0 % read", it is unmeasured, and the UI says so with an em dash rather than a
 * bar sitting at zero.
 */
export function readingProgress(entry: ReadingEntry): number {
  const { read, total } = primaryCounter(entry);
  if (total <= 0) {
    // A manga with volumes but no chapter count still deserves a bar.
    if (!isBook(entry)) {
      const volumes = volumeCounter(entry);
      if (volumes.total > 0) {
        return Math.min(100, Math.round((volumes.read / volumes.total) * 100));
      }
    }
    return 0;
  }
  return Math.min(100, Math.round((read / total) * 100));
}

/** True when the entry has a total to measure against at all. */
export function isMeasurable(entry: ReadingEntry): boolean {
  if (primaryCounter(entry).total > 0) return true;
  return !isBook(entry) && volumeCounter(entry).total > 0;
}

/**
 * A book's progress in **pages**, whatever it is tracked in.
 *
 * This is the one conversion every statistic goes through, and the rate is
 * v3's: 250 words to the page. Rounding happens once, here, so two callers can
 * never disagree about whether 12 500 words is 50 pages.
 */
export function pagesEquivalent(book: Book): { read: number; total: number } {
  if (book.progressUnit === "words") {
    return {
      read: Math.round(nonNegative(book.wordsRead) / WORDS_PER_PAGE),
      total: Math.round(nonNegative(book.totalWords) / WORDS_PER_PAGE),
    };
  }
  return { read: nonNegative(book.pagesRead), total: nonNegative(book.totalPages) };
}

/** Words → pages, exposed for the widget/dashboard lane's `pages-read` stat. */
export function wordsToPages(words: number): number {
  return Math.round(nonNegative(words) / WORDS_PER_PAGE);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` → a comparable day number, or `undefined` when unparseable. */
export function dayNumber(date: DateString | null | undefined): number | undefined {
  if (!date) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return undefined;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}

function todayNumber(now: Date): number {
  return now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
}

/** Strictly in the future — something released today is out. */
export function isFutureRelease(date: DateString | null | undefined, now: Date = new Date()): boolean {
  const day = dayNumber(date);
  if (day === undefined) return false;
  return day > todayNumber(now);
}

/**
 * The status to *show*, which is not always the status stored.
 *
 * Two derivations, both from v3:
 *   - a future `releaseDate` outranks everything except a user's own `Dropped`
 *     or `Completed` (you can drop a book you pre-ordered, and a re-read of an
 *     upcoming edition is still finished);
 *   - a stored `To be released` whose date has passed (or was cleared) is not a
 *     state the user can leave by hand, since the status is not manually
 *     selectable — so it falls back to `Plan to Read`.
 */
export function derivedStatus(entry: ReadingEntry, now: Date = new Date()): ReadingStatus {
  const stored = entry.status;
  if (isFutureRelease(entry.releaseDate, now)) {
    if (stored === STATUS_DROPPED || stored === STATUS_COMPLETED) return stored;
    return STATUS_TO_BE_RELEASED;
  }
  if (stored === STATUS_TO_BE_RELEASED) return STATUS_PLAN_TO_READ;
  return stored;
}

// ---------------------------------------------------------------------------
// Progress edits
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for the local day — the format every v3 date field uses. */
export function todayString(now: Date = new Date()): DateString {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface ProgressEditOptions {
  now?: Date;
  /** Off for a correction the user typed into the detail modal's raw fields. */
  autoStatus?: boolean;
}

/**
 * The patch for "the user moved the progress counter".
 *
 * Everything the move implies travels with it, which is what makes the +1 button
 * worth having: starting something sets `Reading` and stamps `dateStarted`,
 * finishing it sets `Completed` and stamps `dateFinished`, and un-finishing it
 * takes the completion back off rather than leaving a book that says both
 * "Completed" and "312 of 528".
 *
 * `Dropped` is never overwritten — dropping a book you keep dipping into is a
 * deliberate state, and having the plugin quietly un-drop it is worse than a
 * stale counter.
 */
export function progressPatch(
  entry: ReadingEntry,
  read: number,
  options: ProgressEditOptions = {},
): ReadingPatch {
  const now = options.now ?? new Date();
  const counter = primaryCounter(entry);
  const clamped = counter.total > 0 ? Math.max(0, Math.min(counter.total, Math.trunc(read))) : Math.max(0, Math.trunc(read));

  const patch: ReadingPatch = {};
  if (isBook(entry)) {
    if (entry.progressUnit === "words") patch.wordsRead = clamped;
    else patch.pagesRead = clamped;
  } else {
    patch.chaptersRead = clamped;
  }

  if (options.autoStatus === false) return patch;
  if (entry.status === STATUS_DROPPED) return patch;

  const finished = counter.total > 0 && clamped >= counter.total;
  if (finished) {
    patch.status = STATUS_COMPLETED;
    if (!entry.dateFinished) patch.dateFinished = todayString(now);
    if (!entry.dateStarted) patch.dateStarted = todayString(now);
    return patch;
  }

  if (clamped > 0) {
    // Coming back off a finished book is a re-read in progress, not a completed
    // one with a wrong number on it.
    if (entry.status !== STATUS_READING) patch.status = STATUS_READING;
    if (entry.status === STATUS_COMPLETED) patch.dateFinished = null;
    if (!entry.dateStarted) patch.dateStarted = todayString(now);
    return patch;
  }

  // Back to nothing read: it is planned again, and it never started.
  if (entry.status === STATUS_READING || entry.status === STATUS_COMPLETED) {
    patch.status = STATUS_PLAN_TO_READ;
    patch.dateFinished = null;
  }
  return patch;
}

/** `+1 chapter` / `+1 page`, or `-1` when the user overshot. */
export function bumpPatch(
  entry: ReadingEntry,
  delta: number,
  options: ProgressEditOptions = {},
): ReadingPatch {
  const { read } = primaryCounter(entry);
  return progressPatch(entry, read + Math.trunc(delta), options);
}

/**
 * The patch for a status the user picked by hand.
 *
 * `Completed` fills the counter in, because a book marked finished with 12 of
 * 528 pages read reports 2 % everywhere else and makes every statistic lie.
 */
export function statusPatch(
  entry: ReadingEntry,
  status: ReadingStatus,
  options: ProgressEditOptions = {},
): ReadingPatch {
  const now = options.now ?? new Date();
  const patch: ReadingPatch = { status };
  const counter = primaryCounter(entry);

  if (status === STATUS_COMPLETED) {
    if (counter.total > 0) {
      if (isBook(entry)) {
        if (entry.progressUnit === "words") patch.wordsRead = counter.total;
        else patch.pagesRead = counter.total;
      } else {
        patch.chaptersRead = counter.total;
      }
    } else if (!isBook(entry)) {
      // Chapters are the primary counter, but a manga tracked only by volumes
      // has no chapter total to fill — and `readingProgress` already falls back
      // to volumes for exactly that entry. Filling nothing left the row saying
      // Completed while every bar still said 30% (W8 review P1-3).
      const volumes = volumeCounter(entry);
      if (volumes.total > 0) patch.volumesRead = volumes.total;
    }
    if (!entry.dateFinished) patch.dateFinished = todayString(now);
    if (!entry.dateStarted) patch.dateStarted = todayString(now);
    return patch;
  }

  if (status === STATUS_READING && !entry.dateStarted) {
    patch.dateStarted = todayString(now);
  }
  // Leaving Completed clears the finish date; keeping it would date a book the
  // user is explicitly no longer calling finished.
  if (entry.status === STATUS_COMPLETED && status !== STATUS_COMPLETED) {
    patch.dateFinished = null;
  }
  return patch;
}

/**
 * Flip a book between pages and words, keeping both counters.
 *
 * Nothing is converted: v3 kept the two pairs side by side, and a book whose
 * word count was typed in by hand must still read 90 000 when the user switches
 * back. The fold to pages happens in `pagesEquivalent`, for statistics only.
 */
export function unitPatch(unit: ProgressUnit): ReadingPatch {
  return { progressUnit: unit };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** `312 / 528 pages` — or an em dash when there is nothing to measure. */
export function progressLabel(entry: ReadingEntry): string {
  const counter = primaryCounter(entry);
  if (counter.total > 0) {
    return `${formatCount(counter.read)} / ${formatCount(counter.total)} ${counter.unit}`;
  }
  if (!isBook(entry)) {
    const volumes = volumeCounter(entry);
    if (volumes.total > 0) {
      return `${formatCount(volumes.read)} / ${formatCount(volumes.total)} volumes`;
    }
  }
  if (counter.read > 0) return `${formatCount(counter.read)} ${counter.unit}`;
  return "";
}

/**
 * Space-grouped, so 90000 reads as 90 000 rather than a wall of zeros.
 *
 * Grouped by hand rather than with `toLocaleString`: the host locale decides
 * both the separator *and* which invisible space character it is, and a count
 * that renders differently on two machines is not worth the line it saves.
 */
export function formatCount(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}


/** `4 chapters left`, `""` when unmeasurable or already done. */
export function remainingLabel(entry: ReadingEntry): string {
  const counter = primaryCounter(entry);
  if (counter.total <= 0) return "";
  const left = Math.max(0, counter.total - counter.read);
  if (left === 0) return "";
  return `${formatCount(left)} ${counter.noun}${left === 1 ? "" : "s"} left`;
}
