/**
 * Groups (SPEC2-PARITY.md §D-EXTRAS, item 4).
 *
 * `data.groups` migrated cleanly on day one and then nothing read it, so a user
 * who organised their v3 library found the shelves gone from the UI while still
 * sitting in the file. These are the operations that give them back.
 *
 * Two behaviours are worth stating as tests rather than comments: an unrated
 * member does not drag the group's average down to zero, and deleting a group
 * clears the pin that pointed at it — a dangling `pinnedGroupId` is how a
 * "Now watching" surface ends up rendering nothing with no explanation.
 */
import { describe, expect, it } from "vitest";
import {
  addTitlesToGroup,
  createGroup,
  deleteGroup,
  groupId,
  groupRating,
  groupsOf,
  membersOf,
  pinnedGroupId,
  pruneGroups,
  removeTitlesFromGroup,
  renameGroup,
  setPinnedGroupId,
  togglePinnedGroup,
} from "../src/domains/groups/ops";
import { createDefaultData, createTitle } from "../src/data/schema";
import type { Group, TitleV4, WatchLogData } from "../src/types";

function title(id: string, rating = 0): TitleV4 {
  return createTitle({ id, title: id, type: "Movie", rating });
}

function data(): WatchLogData {
  const value = createDefaultData();
  value.titles = [title("dune", 5), title("arrival", 4), title("sicario")];
  return value;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("groupId", () => {
  it("follows v3's `group-` + slug scheme", () => {
    expect(groupId("Watched with Dad", [])).toBe("group-watched-with-dad");
    expect(groupId("Sci-Fi!!", [])).toBe("group-sci-fi");
  });

  it("suffixes a collision rather than overwriting", () => {
    expect(groupId("Trilogy", ["group-trilogy"])).toBe("group-trilogy-2");
    expect(groupId("Trilogy", ["group-trilogy", "group-trilogy-2"])).toBe("group-trilogy-3");
  });

  it("still produces an id for a name with nothing sluggable in it", () => {
    expect(groupId("!!!", [])).toBe("group-group");
  });
});

// ---------------------------------------------------------------------------
// The set of groups
// ---------------------------------------------------------------------------

describe("create / rename / delete", () => {
  it("creates an empty group with a timestamp", () => {
    const groups: Group[] = [];
    const group = createGroup(groups, "  Trilogy  ");
    expect(groups).toHaveLength(1);
    expect(group.name).toBe("Trilogy");
    expect(group.titleIds).toEqual([]);
    expect(Number.isNaN(Date.parse(group.dateAdded))).toBe(false);
  });

  it("renames, and refuses a blank name", () => {
    const groups: Group[] = [];
    const group = createGroup(groups, "Trilogy");
    expect(renameGroup(groups, group.id, " Quadrilogy ")).toBe(true);
    expect(group.name).toBe("Quadrilogy");
    expect(renameGroup(groups, group.id, "   ")).toBe(false);
    expect(group.name).toBe("Quadrilogy");
    expect(renameGroup(groups, "group-nope", "x")).toBe(false);
  });

  it("deletes the group and leaves its titles alone", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune"]);
    expect(deleteGroup(value, group.id)).toBe(true);
    expect(value.groups).toEqual([]);
    expect(value.titles.map((entry) => entry.id)).toContain("dune");
  });

  it("returns false for a group that is not there", () => {
    expect(deleteGroup(data(), "group-nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("membership", () => {
  it("adds without duplicating and reports how many were new", () => {
    const group = createGroup([], "Trilogy");
    expect(addTitlesToGroup(group, ["dune", "arrival"])).toBe(2);
    expect(addTitlesToGroup(group, ["dune", "sicario"])).toBe(1);
    expect(group.titleIds).toEqual(["dune", "arrival", "sicario"]);
  });

  it("removes and reports how many actually went", () => {
    const group = createGroup([], "Trilogy");
    addTitlesToGroup(group, ["dune", "arrival"]);
    expect(removeTitlesFromGroup(group, ["arrival", "nope"])).toBe(1);
    expect(group.titleIds).toEqual(["dune"]);
  });

  it("resolves members in the group's own order, skipping deleted ones", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["sicario", "gone", "dune"]);
    expect(membersOf(group, value.titles).map((entry) => entry.id)).toEqual(["sicario", "dune"]);
  });

  it("answers which groups a title is in", () => {
    const groups: Group[] = [];
    addTitlesToGroup(createGroup(groups, "A"), ["dune"]);
    addTitlesToGroup(createGroup(groups, "B"), ["dune", "arrival"]);
    addTitlesToGroup(createGroup(groups, "C"), ["arrival"]);
    expect(groupsOf(groups, "dune").map((group) => group.name)).toEqual(["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// Derived rating
// ---------------------------------------------------------------------------

describe("groupRating", () => {
  it("averages the rated members", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune", "arrival"]);
    expect(groupRating(group, value.titles)).toBe(4.5);
  });

  it("ignores unrated members rather than counting them as zero", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune", "arrival", "sicario"]);
    expect(groupRating(group, value.titles)).toBe(4.5);
  });

  it("is null when nothing in it is rated", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["sicario"]);
    expect(groupRating(group, value.titles)).toBeNull();
    expect(groupRating(createGroup(value.groups, "Empty"), value.titles)).toBeNull();
  });

  it("rounds to one decimal", () => {
    const value = data();
    value.titles.push(title("tenet", 3));
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune", "arrival", "tenet"]);
    expect(groupRating(group, value.titles)).toBe(4);

    value.titles.push(title("dunkirk", 5));
    addTitlesToGroup(group, ["dunkirk"]);
    expect(groupRating(group, value.titles)).toBe(4.3);
  });

  it("ignores a member id that no longer resolves", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune", "gone"]);
    expect(groupRating(group, value.titles)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The pin (v3's `data.pinnedGroupId`, in the round-tripped remainder)
// ---------------------------------------------------------------------------

describe("pinned group", () => {
  it("reads a v3 file's pin", () => {
    const value = data();
    (value as unknown as Record<string, unknown>).pinnedGroupId = "group-trilogy";
    expect(pinnedGroupId(value)).toBe("group-trilogy");
  });

  it("treats absent and empty as unpinned", () => {
    const value = data();
    expect(pinnedGroupId(value)).toBeNull();
    setPinnedGroupId(value, null);
    expect(pinnedGroupId(value)).toBeNull();
    (value as unknown as Record<string, unknown>).pinnedGroupId = "";
    expect(pinnedGroupId(value)).toBeNull();
  });

  it("is a radio, not a checkbox", () => {
    const value = data();
    expect(togglePinnedGroup(value, "group-a")).toBe(true);
    expect(pinnedGroupId(value)).toBe("group-a");
    expect(togglePinnedGroup(value, "group-b")).toBe(true);
    expect(pinnedGroupId(value)).toBe("group-b");
    expect(togglePinnedGroup(value, "group-b")).toBe(false);
    expect(pinnedGroupId(value)).toBeNull();
  });

  it("is cleared when the pinned group is deleted", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    togglePinnedGroup(value, group.id);
    deleteGroup(value, group.id);
    expect(pinnedGroupId(value)).toBeNull();
  });

  it("is left alone when a different group is deleted", () => {
    const value = data();
    const kept = createGroup(value.groups, "Kept");
    const other = createGroup(value.groups, "Other");
    togglePinnedGroup(value, kept.id);
    deleteGroup(value, other.id);
    expect(pinnedGroupId(value)).toBe(kept.id);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

describe("pruneGroups", () => {
  it("drops ids that no longer resolve and says it did", () => {
    const value = data();
    const group = createGroup(value.groups, "Trilogy");
    addTitlesToGroup(group, ["dune", "gone", "arrival"]);
    expect(pruneGroups(value.groups, value.titles)).toBe(true);
    expect(group.titleIds).toEqual(["dune", "arrival"]);
  });

  it("reports no change when everything resolves", () => {
    const value = data();
    addTitlesToGroup(createGroup(value.groups, "Trilogy"), ["dune"]);
    expect(pruneGroups(value.groups, value.titles)).toBe(false);
  });
});
