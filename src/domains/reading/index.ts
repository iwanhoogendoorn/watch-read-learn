/**
 * The reading domain's public surface (SPEC2 §D-READING).
 *
 * Everything another lane is meant to touch is re-exported here, and nothing
 * else should be imported from inside the folder:
 *
 *   - `mountReadingTab` — the tab, mount-handle shaped like every other tab;
 *   - `computeReadingStats` / `pagesRead` / `readingCompleted` /
 *     `upcomingReleases` — the Dashboard, widget and Upcoming numbers;
 *   - `createReadingStore` — the `ReadingStoreApi` implementation;
 *   - `ReadingNoteWriter` — the per-entry note mirror;
 *   - the progress maths, for anything that needs to say how far along an entry is.
 */
export { mountReadingTab, type ReadingDeps } from "./tab";
export {
  createReadingStore,
  buildReadingEntry,
  findExistingReading,
  READING_LOG_SOURCE,
  type ReadingStore,
  type NewEntrySeed,
} from "./store";
export {
  ReadingNoteWriter,
  composeReadingNote,
  buildReadingFrontmatter,
  readingNotePath,
  readingFolderFor,
  NOTES_HEADING,
  QUOTES_HEADING,
} from "./notes";
export {
  computeReadingStats,
  bookStats,
  mangaStats,
  pagesRead,
  readingCompleted,
  upcomingReleases,
  type ReadingStats,
  type BookStats,
  type MangaStats,
} from "./stats";
export {
  bumpPatch,
  derivedStatus,
  isBook,
  isFutureRelease,
  kindOf,
  pagesEquivalent,
  primaryCounter,
  progressLabel,
  progressPatch,
  readingProgress,
  remainingLabel,
  statusPatch,
  unitPatch,
  volumeCounter,
  wordsToPages,
  type ReadingEntry,
} from "./progress";
export {
  ReadingSearchEngine,
  searchReading,
  parseReadingQuery,
  READING_SEARCH_VOCABULARY,
} from "./query";
export {
  applyReadingFilters,
  createReadingFilterState,
  matchesReadingFilters,
  readingFacetOptions,
  sortReading,
  toPreset,
  fromPreset,
  READING_SORT_KEYS,
  type ReadingFilterState,
  type ReadingView,
} from "./viewstate";
export { AddReadingModal } from "./modals/add";
export { ReadingDetailModal } from "./modals/detail";
export { ReadingColumnsModal } from "./modals/columns";
