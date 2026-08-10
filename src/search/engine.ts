/**
 * The real `LibraryEngine`, replacing `components/engine.ts`'s stand-in.
 *
 * It is a bridge and nothing else: `filter.ts` does the facets, `query.ts` does
 * the token language, `sort.ts` does the two-level comparator. The order is the
 * one SPEC §4.5 specifies and it is not an accident — facets first shrinks the
 * pool before the Fuse index has to be built over it, and the index is built
 * lazily on top of the *filtered* pool, so a narrow facet selection makes search
 * cheaper rather than more expensive.
 *
 * The `SearchEngine` is rebuilt per call. That sounds wasteful and is not: its
 * cost is the document projection, which is O(pool) string work, and it is only
 * paid once per keystroke — while caching one across calls would serve stale
 * documents the moment a title changed, which is a correctness bug in a live-bound
 * UI, not a performance win.
 */
import type { FilterState, Settings, SortSpec, TitleV4 } from "../types";
import type { LibraryEngine } from "../ui/components/engine";
import { applyFilters } from "./filter";
import { SearchEngine } from "./query";
import { sortContextFrom, sortTitles } from "./sort";

/**
 * `settings` is read live (not captured), so re-ordering statuses in the
 * settings tab re-orders the status sort without a reload — the v3 bug SPEC
 * §4.5 calls out by name.
 */
export function createLibraryEngine(settings: Settings): LibraryEngine {
  return {
    filter(titles: readonly TitleV4[], query: string, state: FilterState): TitleV4[] {
      const faceted = applyFilters(titles, state);
      if (query.trim() === "") return faceted;
      return new SearchEngine(faceted).filter(query);
    },

    sort(titles: TitleV4[], sort: SortSpec, secondary: SortSpec | null): TitleV4[] {
      return sortTitles(titles, sort, secondary, sortContextFrom(settings));
    },
  };
}
