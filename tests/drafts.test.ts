/**
 * The drafts scanner (SPEC2-PARITY.md §D-EXTRAS, item 2; report §2.2).
 *
 * Three separable things, tested separately because they fail differently:
 * pulling candidates out of note text, deciding whether one is already tracked,
 * and remembering what the user did about it.
 *
 * The parsing rules are v3's, and a vault full of `#watchlog` lines depends on
 * them staying exactly this literal — one wrong trim and a tag someone wrote in
 * 2023 stops producing the draft it used to.
 */
import { describe, expect, it } from "vitest";
import { candidatesInLine, collectCandidates, scanText, MAX_CANDIDATE_LENGTH } from "../src/domains/drafts/scan";
import { DRAFT_MATCH_THRESHOLD, DraftMatcher, matchLabel } from "../src/domains/drafts/match";
import {
  buildEntries,
  dismiss,
  emptyDraftsState,
  markAdded,
  normalizeDraftsState,
  pendingCount,
  rememberSeen,
  restore,
} from "../src/domains/drafts/state";
import { createBook, createGame, createManga, createTitle } from "../src/data/schema";
import type { DraftsState } from "../src/types";

const TAG = "#watchlog";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("candidatesInLine", () => {
  it("takes everything after the tag, comma-split", () => {
    expect(candidatesInLine("#watchlog Dune, Arrival, The Expanse", TAG)).toEqual([
      "Dune",
      "Arrival",
      "The Expanse",
    ]);
  });

  it("works mid-sentence and inside a bullet", () => {
    expect(candidatesInLine("- must remember #watchlog Sicario", TAG)).toEqual(["Sicario"]);
  });

  it("ignores a line without the tag, and a tag with nothing after it", () => {
    expect(candidatesInLine("just a note", TAG)).toEqual([]);
    expect(candidatesInLine("#watchlog   ", TAG)).toEqual([]);
  });

  it("reads from the first occurrence, so a second tag is part of the text", () => {
    expect(candidatesInLine("#watchlog Dune #watchlog Arrival", TAG)).toEqual([
      "Dune #watchlog Arrival",
    ]);
  });

  it("drops a candidate longer than 100 characters — that is prose", () => {
    const long = "a".repeat(MAX_CANDIDATE_LENGTH + 1);
    expect(candidatesInLine(`#watchlog ${long}, Dune`, TAG)).toEqual(["Dune"]);
  });

  it("skips empty pieces from trailing or doubled commas", () => {
    expect(candidatesInLine("#watchlog Dune,, ,Arrival,", TAG)).toEqual(["Dune", "Arrival"]);
  });

  it("returns nothing for an empty tag rather than every line", () => {
    expect(candidatesInLine("anything at all", "")).toEqual([]);
  });
});

describe("collectCandidates", () => {
  it("dedupes case-insensitively and keeps the first casing seen", () => {
    const found = scanText("#watchlog Dune\n#watchlog dune\n#watchlog DUNE", TAG, "note");
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("dune");
    expect(found[0]?.display).toBe("Dune");
  });

  it("collects one draft with several sources across notes", () => {
    const accumulator = new Map<string, ReturnType<typeof scanText>[number]>();
    collectCandidates(accumulator, "#watchlog Dune", TAG, "daily-2026-08-01");
    collectCandidates(accumulator, "#watchlog dune, Arrival", TAG, "films to see");
    collectCandidates(accumulator, "#watchlog Dune", TAG, "daily-2026-08-01");
    const dune = accumulator.get("dune");
    expect(dune?.sources).toEqual(["daily-2026-08-01", "films to see"]);
    expect(accumulator.get("arrival")?.sources).toEqual(["films to see"]);
  });

  it("honours a custom tag", () => {
    expect(scanText("#media Dune", "#media").map((c) => c.display)).toEqual(["Dune"]);
    expect(scanText("#media Dune", TAG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function matcher() {
  return new DraftMatcher({
    titles: [createTitle({ id: "blade-runner-2049", title: "Blade Runner 2049", type: "Movie" })],
    books: [createBook({ id: "dune", title: "Dune" })],
    manga: [createManga({ id: "berserk", title: "Berserk" })],
    games: [createGame({ id: "hades", title: "Hades" })],
  });
}

describe("DraftMatcher", () => {
  it("matches across all four libraries and says which one", () => {
    const index = matcher();
    expect(index.find("Blade Runner 2049")?.library).toBe("Watchlist");
    expect(index.find("Dune")?.library).toBe("Books");
    expect(index.find("Berserk")?.library).toBe("Manga");
    expect(index.find("Hades")?.library).toBe("Games");
  });

  it("forgives casing and punctuation — the whole reason it is fuzzy", () => {
    expect(matcher().find("blade runner 2049")?.id).toBe("blade-runner-2049");
  });

  it("does not match something merely adjacent", () => {
    expect(matcher().find("Tetris")).toBeNull();
    expect(matcher().find("Elden Ring")).toBeNull();
  });

  it("keeps v3's 0.35 threshold", () => {
    expect(DRAFT_MATCH_THRESHOLD).toBe(0.35);
    const hit = matcher().find("Dune");
    expect(hit?.score).toBeLessThanOrEqual(DRAFT_MATCH_THRESHOLD);
  });

  it("returns null for blank input and for empty libraries", () => {
    expect(matcher().find("   ")).toBeNull();
    const empty = new DraftMatcher({ titles: [], books: [], manga: [], games: [] });
    expect(empty.find("Dune")).toBeNull();
  });

  it("labels a watchlist hit differently from a shelf hit", () => {
    expect(matchLabel(matcher().find("Blade Runner 2049")!)).toBe("In your Watchlist");
    expect(matchLabel(matcher().find("Dune")!)).toBe("In Books");
  });
});

// ---------------------------------------------------------------------------
// Persistence — the v3 `drafts` key
// ---------------------------------------------------------------------------

describe("normalizeDraftsState", () => {
  it("reads a v3 state as-is", () => {
    const raw = {
      dismissed: ["dune"],
      added: ["arrival"],
      firstSeen: { dune: "2026-01-01T00:00:00.000Z" },
      titleDisplay: { dune: "Dune" },
    };
    expect(normalizeDraftsState(raw)).toEqual(raw);
  });

  it("survives every field being missing or the wrong type", () => {
    expect(normalizeDraftsState(undefined)).toEqual(emptyDraftsState());
    expect(normalizeDraftsState({ dismissed: "nope", firstSeen: 7 })).toEqual(emptyDraftsState());
    expect(normalizeDraftsState({ firstSeen: { a: 1, b: "x" } }).firstSeen).toEqual({ b: "x" });
  });
});

describe("rememberSeen", () => {
  it("stamps first sight once and never again", () => {
    const state = emptyDraftsState();
    const scanned = scanText("#watchlog Dune", TAG, "note");
    expect(rememberSeen(state, scanned, "2026-08-01T00:00:00.000Z")).toBe(true);
    expect(state.firstSeen.dune).toBe("2026-08-01T00:00:00.000Z");
    expect(state.titleDisplay.dune).toBe("Dune");

    // A later scan of the same tag must not reset the age — the queue is sorted
    // by it, and a re-stamp would shuffle everything to the bottom.
    expect(rememberSeen(state, scanText("#watchlog DUNE", TAG, "note"), "2026-09-01T00:00:00.000Z")).toBe(
      false,
    );
    expect(state.firstSeen.dune).toBe("2026-08-01T00:00:00.000Z");
    expect(state.titleDisplay.dune).toBe("Dune");
  });
});

describe("dismiss / add / restore", () => {
  it("dismissing clears a previous add — one verdict per draft", () => {
    const state = emptyDraftsState();
    markAdded(state, "dune");
    dismiss(state, "dune");
    expect(state.dismissed).toEqual(["dune"]);
    expect(state.added).toEqual([]);
  });

  it("neither list ever gets a duplicate", () => {
    const state = emptyDraftsState();
    dismiss(state, "dune");
    dismiss(state, "dune");
    markAdded(state, "arrival");
    markAdded(state, "arrival");
    expect(state.dismissed).toEqual(["dune"]);
    expect(state.added).toEqual(["arrival"]);
  });

  it("restore puts a dismissed draft back in circulation", () => {
    const state = emptyDraftsState();
    dismiss(state, "dune");
    restore(state, "dune");
    expect(state.dismissed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rendered queue
// ---------------------------------------------------------------------------

function seededState(): DraftsState {
  const state = emptyDraftsState();
  state.firstSeen = {
    sicario: "2026-01-03T00:00:00.000Z",
    arrival: "2026-01-01T00:00:00.000Z",
    hades: "2026-01-02T00:00:00.000Z",
  };
  state.titleDisplay = { sicario: "Sicario", arrival: "Arrival", hades: "Hades" };
  return state;
}

// `sicario` is in nothing; `hades` is in the games fixture. That contrast is
// what the sorting and the badge count are actually about.
const SCANNED = [
  { key: "sicario", display: "sicario", sources: ["a"] },
  { key: "arrival", display: "arrival", sources: ["b"] },
  { key: "hades", display: "hades", sources: ["c"] },
];

describe("buildEntries", () => {
  it("sorts unresolved drafts oldest first", () => {
    const entries = buildEntries(seededState(), SCANNED, () => null, "2026-08-01T00:00:00.000Z");
    expect(entries.map((entry) => entry.key)).toEqual(["arrival", "hades", "sicario"]);
  });

  it("shows the casing the note used, not the scan's", () => {
    const entries = buildEntries(seededState(), SCANNED, () => null, "now");
    expect(entries.map((entry) => entry.display)).toEqual(["Arrival", "Hades", "Sicario"]);
  });

  it("hides dismissed drafts entirely", () => {
    const state = seededState();
    dismiss(state, "sicario");
    const entries = buildEntries(state, SCANNED, () => null, "now");
    expect(entries.map((entry) => entry.key)).toEqual(["arrival", "hades"]);
  });

  it("sinks already-tracked drafts below the ones needing a decision", () => {
    const index = matcher();
    const entries = buildEntries(seededState(), SCANNED, (text) => index.find(text), "now");
    expect(entries[entries.length - 1]?.key).toBe("hades");
    expect(entries[entries.length - 1]?.match?.library).toBe("Games");
  });

  it("fills the frozen `existing` field from the match", () => {
    const index = matcher();
    const entries = buildEntries(seededState(), SCANNED, (text) => index.find(text), "now");
    const hades = entries.find((entry) => entry.key === "hades");
    expect(hades?.existing).toEqual({
      domain: "games",
      id: "hades",
      title: "Hades",
      score: expect.any(Number),
    });
  });

  it("stops matching a draft the user has added, and greys it instead", () => {
    const state = seededState();
    markAdded(state, "arrival");
    const entries = buildEntries(state, SCANNED, () => null, "now");
    const arrival = entries.find((entry) => entry.key === "arrival");
    expect(arrival?.added).toBe(true);
    expect(entries[entries.length - 1]?.key).toBe("arrival");
  });

  it("falls back to the scan time for a draft with no recorded first sight", () => {
    const entries = buildEntries(emptyDraftsState(), SCANNED, () => null, "2026-08-01T00:00:00.000Z");
    expect(entries.every((entry) => entry.firstSeen === "2026-08-01T00:00:00.000Z")).toBe(true);
  });
});

describe("pendingCount", () => {
  it("counts only what still needs a decision", () => {
    const index = matcher();
    const state = seededState();
    markAdded(state, "arrival");
    const entries = buildEntries(state, SCANNED, (text) => index.find(text), "now");
    // sicario → nothing tracked, arrival → added, hades → already in Games.
    expect(pendingCount(entries)).toBe(1);
  });

  it("is zero when everything is resolved", () => {
    const state = seededState();
    for (const key of ["sicario", "arrival", "hades"]) markAdded(state, key);
    expect(pendingCount(buildEntries(state, SCANNED, () => null, "now"))).toBe(0);
  });
});
