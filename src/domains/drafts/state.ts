/**
 * `data.drafts` — what the panel remembers between scans.
 *
 * The scan is stateless: it reports what the vault says right now. This is the
 * layer that turns that into a queue, and the shape is v3's exactly
 * (`DraftsState` in `types.ts` §10.3), because a v3 vault's dismissals must
 * survive the upgrade — a user who spent an evening dismissing forty drafts does
 * not want them all back.
 *
 *   - `dismissed` — never show me this again. Wins over everything.
 *   - `added` — I acted on this. Shown, greyed, not counted.
 *   - `firstSeen` — when the tag first appeared, which is the sort order: a
 *     queue is oldest-first or it is a pile.
 *   - `titleDisplay` — the casing the note used the first time, so re-typing it
 *     in lower case later does not rename the card.
 *
 * Everything here is pure and mutates the passed-in state, returning whether
 * anything changed — so the caller saves once per scan rather than per key.
 */
import type { DraftCandidate, DraftsState } from "../../types";
import type { DraftMatch } from "./match";
import type { ScannedCandidate } from "./scan";

export function emptyDraftsState(): DraftsState {
  return { dismissed: [], added: [], firstSeen: {}, titleDisplay: {} };
}

/** Read `data.drafts` defensively — every field may be missing or wrong-typed. */
export function normalizeDraftsState(raw: unknown): DraftsState {
  const state = emptyDraftsState();
  if (typeof raw !== "object" || raw === null) return state;
  const source = raw as Record<string, unknown>;
  if (Array.isArray(source.dismissed)) state.dismissed = source.dismissed.map(String);
  if (Array.isArray(source.added)) state.added = source.added.map(String);
  if (typeof source.firstSeen === "object" && source.firstSeen !== null) {
    for (const [key, value] of Object.entries(source.firstSeen)) {
      if (typeof value === "string") state.firstSeen[key] = value;
    }
  }
  if (typeof source.titleDisplay === "object" && source.titleDisplay !== null) {
    for (const [key, value] of Object.entries(source.titleDisplay)) {
      if (typeof value === "string") state.titleDisplay[key] = value;
    }
  }
  return state;
}

/**
 * Record anything seen for the first time. Returns true when the state changed
 * and therefore needs saving.
 */
export function rememberSeen(
  state: DraftsState,
  scanned: readonly ScannedCandidate[],
  now: string,
): boolean {
  let changed = false;
  for (const candidate of scanned) {
    if (!state.firstSeen[candidate.key]) {
      state.firstSeen[candidate.key] = now;
      changed = true;
    }
    if (!state.titleDisplay[candidate.key]) {
      state.titleDisplay[candidate.key] = candidate.display;
      changed = true;
    }
  }
  return changed;
}

export function dismiss(state: DraftsState, key: string): void {
  if (!state.dismissed.includes(key)) state.dismissed.push(key);
  // A dismissed draft is not also an added one; the queue only holds one verdict.
  state.added = state.added.filter((entry) => entry !== key);
}

export function markAdded(state: DraftsState, key: string): void {
  if (!state.added.includes(key)) state.added.push(key);
}

/** Undo a dismissal — the panel's "show dismissed" list needs a way back. */
export function restore(state: DraftsState, key: string): void {
  state.dismissed = state.dismissed.filter((entry) => entry !== key);
}

export interface DraftEntry extends DraftCandidate {
  /** True once the user has acted on it; shown greyed rather than hidden. */
  added: boolean;
  /** Richer than `DraftCandidate.existing`, which cannot tell books from manga. */
  match: DraftMatch | null;
}

/**
 * The list the panel renders: everything scanned, minus dismissals, oldest
 * first, with matched-already entries pushed to the bottom.
 *
 * Sorting matched entries last is the whole ergonomics of the panel — the things
 * that need a decision are at the top, the "you already have this" noise sinks.
 */
export function buildEntries(
  state: DraftsState,
  scanned: readonly ScannedCandidate[],
  findMatch: (display: string) => DraftMatch | null,
  fallbackFirstSeen: string,
): DraftEntry[] {
  const entries: DraftEntry[] = [];
  for (const candidate of scanned) {
    if (state.dismissed.includes(candidate.key)) continue;
    const display = state.titleDisplay[candidate.key] ?? candidate.display;
    const added = state.added.includes(candidate.key);
    const match = added ? null : findMatch(display);
    const entry: DraftEntry = {
      key: candidate.key,
      display,
      sources: [...candidate.sources],
      firstSeen: state.firstSeen[candidate.key] ?? fallbackFirstSeen,
      added,
      match,
    };
    if (match) {
      entry.existing = {
        domain: match.domain,
        id: match.id,
        title: match.title,
        score: match.score,
      };
    }
    entries.push(entry);
  }

  entries.sort((a, b) => {
    const aResolved = a.added || a.match !== null;
    const bResolved = b.added || b.match !== null;
    if (aResolved !== bResolved) return aResolved ? 1 : -1;
    return a.firstSeen.localeCompare(b.firstSeen);
  });
  return entries;
}

/** The number on the Library's toolbar badge: drafts still awaiting a decision. */
export function pendingCount(entries: readonly DraftEntry[]): number {
  return entries.filter((entry) => !entry.added && entry.match === null).length;
}
