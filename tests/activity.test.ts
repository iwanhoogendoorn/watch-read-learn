/**
 * Activity model — SPEC §4.8.
 *
 * The store appends newest **last**; everything the tab renders is newest-first,
 * so the reversal is the one thing that must not regress.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILTERS,
  activityIcon,
  dayLabel,
  filterActivity,
  formatClock,
  groupActivityByDay,
  usedKinds,
} from "../src/ui/tabs/activity";
import type { HistoryEntry } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

function entry(overrides: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    timestamp: "2026-08-03T09:15:00.000Z",
    message: "something happened",
    source: "Watchlist",
    ...overrides,
  };
}

const LOG: HistoryEntry[] = [
  entry({ id: "1", action: "added", message: "Dune (Movie) was added", titleName: "Dune", timestamp: new Date(2026, 7, 1, 9, 0).toISOString() }),
  entry({ id: "2", action: "watched", message: "Dexter — episode 3 marked as watched", titleName: "Dexter", timestamp: new Date(2026, 7, 2, 20, 5).toISOString() }),
  entry({ id: "3", action: "requested", message: "Severance was requested", titleName: "Severance", timestamp: new Date(2026, 7, 3, 8, 30).toISOString() }),
  entry({ id: "4", action: "watched", message: "Dexter — episode 4 marked as watched", titleName: "Dexter", timestamp: new Date(2026, 7, 3, 21, 45).toISOString() }),
];

describe("filterActivity", () => {
  it("returns newest first", () => {
    expect(filterActivity(LOG, "").map((e) => e.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("filters by kind", () => {
    expect(filterActivity(LOG, "watched").map((e) => e.id)).toEqual(["4", "2"]);
    expect(filterActivity(LOG, "deleted")).toEqual([]);
  });

  it("searches the message and the title name, case-insensitively", () => {
    expect(filterActivity(LOG, "", "dexter").map((e) => e.id)).toEqual(["4", "2"]);
    expect(filterActivity(LOG, "", "SEVERANCE").map((e) => e.id)).toEqual(["3"]);
    expect(filterActivity(LOG, "watched", "severance")).toEqual([]);
  });

  it("tolerates v3 entries with no action at all", () => {
    const legacy = [entry({ id: "old", message: "migrated row" })];
    expect(filterActivity(legacy, "")).toHaveLength(1);
    expect(filterActivity(legacy, "added")).toHaveLength(0);
  });
});

describe("groupActivityByDay", () => {
  it("buckets consecutive entries by local day, newest bucket first", () => {
    const groups = groupActivityByDay(filterActivity(LOG, ""), NOW);
    expect(groups.map((g) => g.key)).toEqual(["2026-08-03", "2026-08-02", "2026-08-01"]);
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(["4", "3"]);
  });

  it("labels today and yesterday by name", () => {
    const groups = groupActivityByDay(filterActivity(LOG, ""), NOW);
    expect(groups[0]?.label).toBe("Today");
    expect(groups[1]?.label).toBe("Yesterday");
    expect(groups[2]?.label).not.toBe("Today");
  });

  it("does not crash on an unparseable timestamp", () => {
    const groups = groupActivityByDay([entry({ id: "bad", timestamp: "not a date" })], NOW);
    expect(groups[0]?.key).toBe("unknown");
    expect(groups[0]?.label).toBe("Undated");
  });
});

describe("small helpers", () => {
  it("labels relative days", () => {
    expect(dayLabel(new Date(2026, 7, 3), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 7, 2), NOW)).toBe("Yesterday");
  });

  it("formats a zero-padded local clock, and nothing for junk", () => {
    expect(formatClock(new Date(2026, 7, 3, 9, 5).toISOString())).toBe("09:05");
    expect(formatClock("nope")).toBe("");
  });

  it("maps every filter kind to an icon", () => {
    for (const filter of ACTIVITY_FILTERS) {
      if (!filter.id) continue;
      expect(activityIcon(filter.id)).toBe(filter.icon);
    }
    expect(activityIcon("something-v3-wrote")).toBe("dot");
    expect(activityIcon(undefined)).toBe("dot");
  });

  it("reports the kinds actually present, so dead chips can be hidden", () => {
    expect(usedKinds(LOG)).toEqual(new Set(["added", "watched", "requested"]));
  });
});
