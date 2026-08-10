/**
 * Reading draft candidates out of note text (SPEC2-PARITY.md §D-EXTRAS, item 2;
 * report §2.2 "Drafts").
 *
 * The whole feature rests on one line of syntax:
 *
 *     #watchlog Dune, Arrival, The Expanse
 *
 * Everything after the tag on that line, split on commas, is a thing the user
 * wants to track. That is deliberately dumber than a parser: it has to work
 * inside a sentence, inside a bullet, inside a daily note written on a phone.
 *
 * Rules carried verbatim from v3, because a vault full of existing tags depends
 * on them:
 *
 *   - only the text after the **first** occurrence of the tag is read;
 *   - candidates are split on `,` and trimmed;
 *   - anything longer than 100 characters is a sentence, not a title, and is
 *     dropped — this is what stops "#watchlog because I keep forgetting the one
 *     about the…" from becoming an entry;
 *   - identity is the **lower-cased** text, so `dune` and `Dune` are one draft,
 *     while the first casing seen is what gets displayed.
 *
 * Pure: the caller supplies file text, this returns candidates.
 */

/** Longer than this and it is prose. v3's cap, kept. */
export const MAX_CANDIDATE_LENGTH = 100;

export interface ScannedCandidate {
  /** Lower-cased identity, matching `DraftsState`'s keys. */
  key: string;
  /** The casing the note used. */
  display: string;
  /** Note basenames the candidate was seen in, in encounter order. */
  sources: string[];
}

/** The candidates on one line, in order. Empty when the tag is absent. */
export function candidatesInLine(line: string, tag: string): string[] {
  if (tag === "" || !line.includes(tag)) return [];
  const after = line.slice(line.indexOf(tag) + tag.length).trim();
  if (after === "") return [];
  return after
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.length <= MAX_CANDIDATE_LENGTH);
}

/**
 * Fold one note's text into an accumulator keyed by candidate.
 *
 * The accumulator is shared across the whole vault sweep so a title mentioned in
 * three notes is one draft with three sources rather than three drafts.
 */
export function collectCandidates(
  accumulator: Map<string, ScannedCandidate>,
  text: string,
  tag: string,
  source: string,
): Map<string, ScannedCandidate> {
  for (const line of text.split("\n")) {
    for (const display of candidatesInLine(line, tag)) {
      const key = display.toLowerCase();
      const existing = accumulator.get(key);
      if (!existing) {
        accumulator.set(key, { key, display, sources: [source] });
        continue;
      }
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
  }
  return accumulator;
}

/** Convenience for a single body of text — used by the tests and one-off scans. */
export function scanText(text: string, tag: string, source = ""): ScannedCandidate[] {
  return [...collectCandidates(new Map(), text, tag, source).values()];
}
