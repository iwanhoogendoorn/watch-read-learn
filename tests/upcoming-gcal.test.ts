/**
 * "Add to Google Calendar" — the URL builder and the row it hangs off.
 *
 * Everything worth testing here is encoding and absence. A title with an
 * ampersand in it is not exotic (Fire & Blood, Law & Order, Dungeons & Dragons)
 * and a hand-rolled query string truncates the summary at it. A `#` is worse:
 * everything after it never leaves the browser. And an undated row must produce
 * no link at all rather than a link to an empty form, which is the failure that
 * looks like success.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import {
  GOOGLE_CALENDAR_BASE,
  googleCalendarLabel,
  googleCalendarUrl,
} from "../src/domains/upcoming/gcal";
import { buildUpcomingIcs } from "../src/domains/upcoming/ics";
import { upcomingEventFor } from "../src/domains/upcoming/event";
import { UPCOMING_NOUNS, type UnifiedRow } from "../src/domains/upcoming/unified";
import { renderCalendarLink } from "../src/ui/tabs/upcoming";

function row(overrides: Partial<UnifiedRow> = {}): UnifiedRow {
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

/** The query half of the built URL, parsed back. */
function params(url: string): URLSearchParams {
  const [base, query] = url.split("?");
  expect(base).toBe(GOOGLE_CALENDAR_BASE);
  return new URLSearchParams(query ?? "");
}

describe("googleCalendarUrl", () => {
  it("builds a create-event URL against Google's template endpoint", () => {
    const url = googleCalendarUrl(row());
    expect(url).not.toBeNull();
    const query = params(url as string);
    expect(query.get("action")).toBe("TEMPLATE");
    expect(query.get("text")).toBe("Severance — S03E02");
    expect(query.get("details")).toBe("The next chapter\nTracked by Watch, Read and Learn.");
  });

  it("spells an all-day event as start/exclusive-next-day", () => {
    // Both halves matter: Google renders a same-day start and end as a
    // zero-length event, which shows up as a sliver at midnight.
    const query = params(googleCalendarUrl(row({ date: "2026-08-14" })) as string);
    expect(query.get("dates")).toBe("20260814/20260815");
  });

  it("rolls the exclusive end over a month and a year boundary", () => {
    expect(params(googleCalendarUrl(row({ date: "2026-08-31" })) as string).get("dates")).toBe(
      "20260831/20260901",
    );
    expect(params(googleCalendarUrl(row({ date: "2026-12-31" })) as string).get("dates")).toBe(
      "20261231/20270101",
    );
  });

  it("keeps only the date half of a longer ISO timestamp", () => {
    const query = params(googleCalendarUrl(row({ date: "2026-08-14T20:00:00Z" })) as string);
    expect(query.get("dates")).toBe("20260814/20260815");
  });

  it("encodes ampersands, hashes and spaces instead of truncating on them", () => {
    const url = googleCalendarUrl(
      row({ name: "Fire & Blood #2", label: "", detail: "A & B #3" }),
    ) as string;

    // The raw string must carry no unescaped separator: a bare `&` would start
    // a new parameter and a bare `#` would drop everything after it.
    const query = url.split("?")[1] ?? "";
    expect(query).toContain("%26");
    expect(query).toContain("%23");
    expect(url).not.toContain(" ");
    // Exactly the four parameters we set: an unescaped `&` inside the title
    // would show up here as a fifth.
    expect(query.split("&")).toHaveLength(4);
    // A `#` would make everything after it a fragment the server never sees.
    expect(url).not.toContain("#");

    // And it round-trips: what a parser gets back is exactly what went in.
    const parsed = params(url);
    expect(parsed.get("text")).toBe("Fire & Blood #2");
    expect(parsed.get("details")).toBe("A & B #3\nTracked by Watch, Read and Learn.");
  });

  it("drops the em-dash label separator when a row has no label", () => {
    const query = params(googleCalendarUrl(row({ label: "" })) as string);
    expect(query.get("text")).toBe("Severance");
  });

  it("still carries the provenance line when a row has no detail", () => {
    const query = params(googleCalendarUrl(row({ detail: "" })) as string);
    expect(query.get("details")).toBe("Tracked by Watch, Read and Learn.");
  });

  it("returns null for an undated row rather than a broken URL", () => {
    // An announced season upstream has not dated yet — the case that exists in
    // every real library.
    expect(googleCalendarUrl(row({ date: null, kind: "season", label: "Season 3" }))).toBeNull();
    expect(googleCalendarUrl(row({ date: "" }))).toBeNull();
    expect(googleCalendarUrl(row({ date: "TBA" as never }))).toBeNull();
  });

  it("works the same for a reading or games row", () => {
    const query = params(
      googleCalendarUrl(
        row({
          source: "games",
          id: "hollow-knight-silksong",
          name: "Hollow Knight: Silksong",
          kind: "release",
          label: "Release",
          detail: "",
          noun: UPCOMING_NOUNS.games,
          entry: { source: "games", value: {} as never },
        }),
      ) as string,
    );
    expect(query.get("text")).toBe("Hollow Knight: Silksong — Release");
    expect(query.get("dates")).toBe("20260814/20260815");
  });
});

describe("googleCalendarLabel", () => {
  it("names the event, so the link's accessible name is not just 'add'", () => {
    expect(googleCalendarLabel(row())).toBe("Add Severance — S03E02 to Google Calendar");
  });

  it("falls back to the plain name for an undated row", () => {
    expect(googleCalendarLabel(row({ date: null }))).toBe("Add Severance to Google Calendar");
  });
});

describe("the .ics export and the calendar link agree", () => {
  it("describes the same day, summary and body", () => {
    const one = row({ name: "Fire & Blood", label: "S01E03", detail: "Dragons" });
    const event = upcomingEventFor(one);
    expect(event).not.toBeNull();

    const { ics } = buildUpcomingIcs([one], { now: new Date("2026-08-10T19:30:00Z") });
    const query = params(googleCalendarUrl(one) as string);

    // Same summary on both sides — the drift this shared shaping exists to stop.
    expect(query.get("text")).toBe(event?.summary);
    expect(ics).toContain(`SUMMARY:${event?.summary}`);
    // Same all-day window.
    expect(ics).toContain("DTSTART;VALUE=DATE:20260814");
    expect(ics).toContain("DTEND;VALUE=DATE:20260815");
    expect(query.get("dates")).toBe("20260814/20260815");
  });

  it("skips the same undated rows", () => {
    const undated = row({ date: null });
    const { eventCount, skippedUndated } = buildUpcomingIcs([undated], { now: new Date() });
    expect(eventCount).toBe(0);
    expect(skippedUndated).toBe(1);
    expect(googleCalendarUrl(undated)).toBeNull();
  });
});

describe("renderCalendarLink", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installDomGlobals(900);
  });
  afterEach(() => restore());

  function host(): StubEl {
    return createHost(900);
  }

  it("renders an anchor carrying the built URL", () => {
    const el = host();
    const link = renderCalendarLink(el as unknown as HTMLElement, row());
    expect(link).not.toBeNull();

    const anchor = el.querySelector(".wl-upcoming-gcal");
    expect(anchor).not.toBeNull();
    expect(anchor?.tag).toBe("a");
    expect(anchor?.attrs.get("href")).toBe(googleCalendarUrl(row()));
    // Opened by the browser, not by us — and never with a live opener handle.
    expect(anchor?.attrs.get("target")).toBe("_blank");
    expect(anchor?.attrs.get("rel")).toBe("noopener");
    expect(anchor?.attrs.get("aria-label")).toBe(googleCalendarLabel(row()));
  });

  it("reuses the row's existing action strip instead of adding a second one", () => {
    const el = host();
    el.createDiv({ cls: "wl-upcoming-states" });
    renderCalendarLink(el as unknown as HTMLElement, row());
    expect(el.querySelectorAll(".wl-upcoming-states")).toHaveLength(1);
    expect(el.querySelector(".wl-upcoming-states")?.querySelector(".wl-upcoming-gcal")).not.toBeNull();
  });

  it("gives a plainer row its own action strip", () => {
    const el = host();
    renderCalendarLink(el as unknown as HTMLElement, row({ source: "reading" }));
    expect(el.querySelectorAll(".wl-upcoming-states")).toHaveLength(1);
  });

  it("renders nothing at all for an undated row", () => {
    const el = host();
    const link = renderCalendarLink(el as unknown as HTMLElement, row({ date: null }));
    expect(link).toBeNull();
    expect(el.querySelector(".wl-upcoming-gcal")).toBeNull();
    // Not even an empty strip — an undated row must look untouched.
    expect(el.querySelector(".wl-upcoming-states")).toBeNull();
  });
});
