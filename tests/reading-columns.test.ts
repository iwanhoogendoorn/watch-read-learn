/**
 * Built-in columns — the facts a reading row already carries.
 *
 * Two rules, both of which have bitten this plugin elsewhere:
 *
 *   1. **A built-in is derived, never stored.** The year comes off
 *      `releaseDate`, the same field the detail screen prints and the decade
 *      facet buckets by. A second copy under `customFields` would be free to
 *      drift the first time somebody edited the date.
 *   2. **The stored list records what is HIDDEN**, the same convention every
 *      facet in this domain follows. A list of "columns I want", written before
 *      a column existed, would hide that column from everybody who had ever
 *      opened the modal.
 *
 * Pure: no DOM, no store. The table's half of this is in `reading-grid.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_COLUMNS,
  toggleBuiltInColumn,
  visibleBuiltInColumns,
} from "../src/domains/reading/columns";
import { createBook, createManga } from "../src/data/schema";
import type { ReadingEntry } from "../src/domains/reading/progress";

function yearColumn() {
  const column = BUILT_IN_COLUMNS.find((entry) => entry.id === "year");
  if (!column) throw new Error("there is no Year column");
  return column;
}

function bookWith(releaseDate: string | null): ReadingEntry {
  return createBook({ id: "b", title: "A Book", releaseDate });
}

describe("the Year column", () => {
  it("reads the year off releaseDate", () => {
    expect(yearColumn().value(bookWith("1965-08-01"))).toBe("1965");
    // A date that is only a year is still a date this can answer.
    expect(yearColumn().value(bookWith("1965"))).toBe("1965");
  });

  it("answers manga as readily as books — it is one field on both", () => {
    const manga = createManga({ id: "m", title: "A Series", releaseDate: "1989-08-25" });
    expect(yearColumn().value(manga)).toBe("1989");
  });

  it("says nothing rather than NaN when the row cannot answer", () => {
    // Every shape a missing or broken date arrives in. `Number.parseInt` would
    // turn three of these into NaN and print it in the table.
    for (const value of [null, "", "   ", "not-a-date", "n/a", "0000-01-01"]) {
      expect(yearColumn().value(bookWith(value)), `for ${JSON.stringify(value)}`).toBe("");
    }
  });

  it("never invents a customFields entry — the year is read, not stored", () => {
    const book = bookWith("1965-08-01");
    expect(yearColumn().value(book)).toBe("1965");
    expect(book.customFields).toEqual({});
  });
});

describe("which built-ins are shown", () => {
  it("shows everything when nothing is hidden, including with no list at all", () => {
    expect(visibleBuiltInColumns()).toEqual([...BUILT_IN_COLUMNS]);
    expect(visibleBuiltInColumns([])).toEqual([...BUILT_IN_COLUMNS]);
  });

  it("hides exactly what the list names", () => {
    expect(visibleBuiltInColumns(["year"]).map((column) => column.id)).toEqual([]);
  });

  it("is exclusion, not inclusion — a column nobody has heard of is still shown", () => {
    // A hidden list written by an older version names ids that version knew
    // about. Anything added since is absent from it, and absent means shown.
    const stale = ["some-column-a-later-version-removed"];
    expect(visibleBuiltInColumns(stale).map((column) => column.id)).toEqual(
      BUILT_IN_COLUMNS.map((column) => column.id),
    );
  });
});

describe("toggling a built-in", () => {
  it("adds and removes the id, and round-trips", () => {
    const off = toggleBuiltInColumn([], "year");
    expect(off).toEqual(["year"]);
    expect(toggleBuiltInColumn(off, "year")).toEqual([]);
  });

  it("leaves the list it was given alone", () => {
    const hidden = ["year"];
    const next = toggleBuiltInColumn(hidden, "year");
    // The caller holds the stored array by reference; mutating it would write
    // a change nobody asked to save.
    expect(hidden).toEqual(["year"]);
    expect(next).not.toBe(hidden);
  });

  it("keeps the ids it was not asked about", () => {
    expect(toggleBuiltInColumn(["other"], "year")).toEqual(["other", "year"]);
    expect(toggleBuiltInColumn(["other", "year"], "year")).toEqual(["other"]);
  });
});
