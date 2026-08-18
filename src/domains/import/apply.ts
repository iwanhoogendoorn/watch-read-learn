/**
 * Writing the plan.
 *
 * Everything that decides anything already happened in `plan.ts`; this walks the
 * decisions and hands them to the store. It stays a separate file because it is
 * the only part that mutates, and because the plan being computable without a
 * store is what makes all of it testable.
 *
 * Three details are load-bearing:
 *
 *   - **`autoStatus: false`.** The auto-complete rules exist to react to the
 *     *user* ticking off a last episode. An import that merges a season's worth
 *     of watches at once must not silently flip a Dropped show to Completed and
 *     stamp a finish date the user never chose; the plan already decided what
 *     the status should be, and it decided conservatively.
 *   - **`preserveAbsoluteEpisodes`.** A merge that adopts a season list is
 *     giving the title its *first* geometry, not correcting an old one, so the
 *     watched numbers in the same patch are already expressed against it.
 *   - **ids are unique against the live library**, not against the plan. The
 *     plan's ids are placeholders (`import-3`); the store is the only thing that
 *     knows what is taken.
 */
import { slugify, uniqueId } from "../../data/schema";
import type { TitleV4, WatchLogStoreApi } from "../../types";
import type { ImportPlanEntry, TrackerImportPlan } from "./plan";
import { TRACKER_LABELS } from "./types";

export interface ApplyProgress {
  done: number;
  total: number;
}

export interface ApplyOptions {
  /** Called every `chunk` entries so a progress bar can paint. */
  onProgress?: (progress: ApplyProgress) => void;
  /** Return `true` to stop; what has been written is kept. */
  isCancelled?: () => boolean;
  /** Entries between yields. */
  chunk?: number;
}

export interface ApplyResult {
  added: number;
  merged: number;
  skipped: number;
  cancelled: boolean;
}

const DEFAULT_CHUNK = 25;

/**
 * Give a planned title an id nothing in the library is using.
 *
 * Mutated in place rather than rebuilt: `createTitle` produced this object, and
 * rebuilding it from a literal is the one thing `types.ts` forbids outright.
 */
function reid(title: TitleV4, taken: Set<string>): TitleV4 {
  const id = uniqueId(slugify(title.title), taken);
  title.id = id;
  taken.add(id);
  return title;
}

function applyOne(store: WatchLogStoreApi, entry: ImportPlanEntry, taken: Set<string>): void {
  if (entry.action === "add") {
    if (!entry.newTitle) return;
    store.addTitle(reid(entry.newTitle, taken));
    return;
  }
  if (entry.action !== "merge") return;
  if (entry.titleId === undefined || entry.patch === undefined) return;
  store.updateTitle(entry.titleId, entry.patch, "tracker-import", {
    autoStatus: false,
    preserveAbsoluteEpisodes: entry.patch.seasons !== undefined,
  });
}

/**
 * Write a plan, chunked and cancellable.
 *
 * Chunked for the same reason the CSV importer is: a 4,000-row Trakt export must
 * neither freeze Obsidian nor be an all-or-nothing gamble. Cancelling stops it
 * where it is and keeps what was written, which is safe precisely because every
 * individual write is non-destructive.
 */
export async function applyTrackerPlan(
  store: WatchLogStoreApi,
  plan: TrackerImportPlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const queue = plan.entries.filter((entry) => entry.action !== "skip");
  const chunk = Math.max(1, options.chunk ?? DEFAULT_CHUNK);
  const taken = new Set(store.allTitles().map((title) => title.id));

  const result: ApplyResult = {
    added: 0,
    merged: 0,
    skipped: plan.entries.length - queue.length,
    cancelled: false,
  };

  let done = 0;
  for (const entry of queue) {
    if (options.isCancelled?.() === true) {
      result.cancelled = true;
      break;
    }
    applyOne(store, entry, taken);
    if (entry.action === "add") result.added += 1;
    else result.merged += 1;
    done += 1;
    if (done % chunk === 0) {
      options.onProgress?.({ done, total: queue.length });
      // Yield so the bar paints and Cancel can be clicked.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  options.onProgress?.({ done, total: queue.length });

  store.logActivity({
    message: `Imported ${result.added} new and updated ${result.merged} existing ${result.added + result.merged === 1 ? "title" : "titles"} from ${TRACKER_LABELS[plan.source]}`,
    source: "Watchlist",
    action: "added",
  });
  store.save("tracker-import");
  store.emitChanged({ reason: "tracker-import" });
  return result;
}
