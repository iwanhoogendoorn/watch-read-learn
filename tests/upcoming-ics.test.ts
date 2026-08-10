/**
 * ICS export of the Upcoming feed — RFC 5545 details that break real parsers
 * when shortcut: TEXT escaping, octet-aware folding, all-day date windows,
 * stable UIDs, CRLF endings.
 */
import { describe, expect, it } from "vitest";
import {
  buildUpcomingIcs,
  escapeIcsText,
  foldIcsLine,
} from "../src/domains/upcoming/ics";
import { UPCOMING_NOUNS, type UnifiedRow } from "../src/domains/upcoming/unified";

const NOW = new Date("2026-08-10T19:30:00Z");

function row(overrides: Partial<UnifiedRow>): UnifiedRow {
  return {
    source: "watchlist",
    id: "severance",
    name: "Severance",
    kind: "episode",
    date: "2026-08-14",
    daysUntil: 4,
    label: "S03E02",
    detail: "The next chapter",
    noun: UPCOMING_NOUNS.watchlist,
    entry: { source: "watchlist", value: {} as never },
    ...overrides,
  };
}

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });

  it("escapes the backslash before the structure characters, not after", () => {
    // A naive order would turn ";" into "\\;" and then double the new backslash.
    expect(escapeIcsText(";")).toBe("\\;");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds every physical line to at most 75 octets", () => {
    const folded = foldIcsLine(`SUMMARY:${"x".repeat(300)}`);
    const encoder = new TextEncoder();
    for (const part of folded.split("\r\n")) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"x".repeat(300)}`);
  });

  it("never splits inside a multibyte character", () => {
    const folded = foldIcsLine(`SUMMARY:${"é".repeat(200)}`);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(200)}`);
    for (const part of folded.split("\r\n")) {
      expect(part).not.toContain("�");
    }
  });
});

describe("buildUpcomingIcs", () => {
  it("renders an all-day event with an exclusive end", () => {
    const { ics, eventCount } = buildUpcomingIcs([row({})], { now: NOW });
    expect(eventCount).toBe(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260814");
    expect(ics).toContain("DTEND;VALUE=DATE:20260815");
    expect(ics).toContain("SUMMARY:Severance — S03E02");
    expect(ics).toContain("DTSTAMP:20260810T193000Z");
  });

  it("rolls the exclusive end across month boundaries", () => {
    const { ics } = buildUpcomingIcs([row({ date: "2026-08-31" })], { now: NOW });
    expect(ics).toContain("DTEND;VALUE=DATE:20260901");
  });

  it("skips undated rows and reports them", () => {
    const { eventCount, skippedUndated } = buildUpcomingIcs(
      [row({}), row({ id: "announced", date: null, daysUntil: null })],
      { now: NOW },
    );
    expect(eventCount).toBe(1);
    expect(skippedUndated).toBe(1);
  });

  it("derives a UID that is stable across exports", () => {
    const first = buildUpcomingIcs([row({})], { now: NOW });
    const second = buildUpcomingIcs([row({})], { now: new Date("2026-08-11T00:00:00Z") });
    const uidOf = (ics: string) => /UID:(.*)/.exec(ics)?.[1];
    expect(uidOf(first.ics)).toBe(uidOf(second.ics));
    expect(uidOf(first.ics)).toBe("watchlog-watchlist-severance-episode-20260814@watchlog");
  });

  it("sanitises hostile ids out of the UID", () => {
    const { ics } = buildUpcomingIcs([row({ id: "a b;c\nd" })], { now: NOW });
    expect(ics).toContain("UID:watchlog-watchlist-a-b-c-d-episode-20260814@watchlog");
  });

  it("uses CRLF line endings throughout and closes the calendar", () => {
    const { ics } = buildUpcomingIcs([row({})], { now: NOW });
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // Every \n is preceded by \r: no bare LF anywhere.
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("escapes structure characters in summary and description", () => {
    const { ics } = buildUpcomingIcs(
      [row({ name: "Dungeons; Dragons, etc", detail: "line1\nline2" })],
      { now: NOW },
    );
    expect(ics).toContain("SUMMARY:Dungeons\\; Dragons\\, etc — S03E02");
    expect(ics).toContain("DESCRIPTION:line1\\nline2\\nTracked by Watch\\, Read and Learn.");
  });

  it("produces an empty but valid calendar for no rows", () => {
    const { ics, eventCount } = buildUpcomingIcs([], { now: NOW });
    expect(eventCount).toBe(0);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});
