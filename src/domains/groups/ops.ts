/**
 * Group operations (SPEC2-PARITY.md §D-EXTRAS, item 4).
 *
 * `data.groups` has been migrated and round-tripped since v4 shipped and nothing
 * has ever read it — a user who organised their library in v3 opened v4 and
 * found their groups gone from the UI while still sitting in the file. This is
 * the layer that gives them back.
 *
 * A group is deliberately thin: an id, a name, and a list of title ids. Two
 * derived facts hang off it, both v3's:
 *
 *   - **rating = the average of its rated members.** Unrated titles (`rating`
 *     0) are excluded from the average rather than counted as zero, which is the
 *     same rule the rest of v4 applies to rating 0 everywhere else.
 *   - **one pinned group**, stored in `data.pinnedGroupId`. That key is v3's and
 *     lives in the round-tripped remainder of `data.json`, so it is read and
 *     written through `readExtra`/`writeExtra` rather than declared — exactly
 *     how the view stores its active tab.
 *
 * Everything here is pure, mutating the arrays it is handed. The panel does the
 * saving and the change events, once per user action.
 */
import { readExtra, writeExtra, type Group, type TitleV4, type WatchLogData } from "../../types";

/** v3's id scheme: `group-` + slug, collision-suffixed. */
export function groupId(name: string, taken: Iterable<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `group-${slug === "" ? "group" : slug}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function createGroup(groups: Group[], name: string): Group {
  const group: Group = {
    id: groupId(name, groups.map((entry) => entry.id)),
    name: name.trim(),
    titleIds: [],
    dateAdded: new Date().toISOString(),
  };
  groups.push(group);
  return group;
}

export function renameGroup(groups: Group[], id: string, name: string): boolean {
  const group = groups.find((entry) => entry.id === id);
  const next = name.trim();
  if (!group || next === "") return false;
  group.name = next;
  return true;
}

/**
 * Delete the group, not its titles.
 *
 * Also clears the pin if it pointed here — a pinned id with no group behind it
 * is how "Now watching" ends up rendering nothing with no explanation.
 */
export function deleteGroup(data: WatchLogData, id: string): boolean {
  const index = data.groups.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  data.groups.splice(index, 1);
  if (pinnedGroupId(data) === id) setPinnedGroupId(data, null);
  return true;
}

/** Add titles, ignoring the ones already in. Returns how many were new. */
export function addTitlesToGroup(group: Group, titleIds: readonly string[]): number {
  let added = 0;
  for (const id of titleIds) {
    if (group.titleIds.includes(id)) continue;
    group.titleIds.push(id);
    added += 1;
  }
  return added;
}

export function removeTitlesFromGroup(group: Group, titleIds: readonly string[]): number {
  const drop = new Set(titleIds);
  const before = group.titleIds.length;
  group.titleIds = group.titleIds.filter((id) => !drop.has(id));
  return before - group.titleIds.length;
}

/** Groups a title belongs to, for the detail view and the chips. */
export function groupsOf(groups: readonly Group[], titleId: string): Group[] {
  return groups.filter((group) => group.titleIds.includes(titleId));
}

/**
 * The group's rating: the mean of its **rated** members, rounded to one decimal.
 *
 * `null` when nothing in it is rated — which the UI shows as "—" rather than as
 * a zero-star group, because "nobody has rated these" and "these are terrible"
 * are not the same statement.
 */
export function groupRating(group: Group, titles: readonly TitleV4[]): number | null {
  const byId = new Map(titles.map((title) => [title.id, title]));
  const ratings: number[] = [];
  for (const id of group.titleIds) {
    const rating = byId.get(id)?.rating ?? 0;
    if (rating > 0) ratings.push(rating);
  }
  if (ratings.length === 0) return null;
  const mean = ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
  return Math.round(mean * 10) / 10;
}

/** Members that still exist, in the group's own order. */
export function membersOf(group: Group, titles: readonly TitleV4[]): TitleV4[] {
  const byId = new Map(titles.map((title) => [title.id, title]));
  return group.titleIds
    .map((id) => byId.get(id))
    .filter((title): title is TitleV4 => title !== undefined);
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

/** v3's `data.pinnedGroupId`, in the round-tripped remainder of `data.json`. */
export function pinnedGroupId(data: WatchLogData): string | null {
  const value = readExtra<unknown>(data, "pinnedGroupId");
  return typeof value === "string" && value !== "" ? value : null;
}

export function setPinnedGroupId(data: WatchLogData, id: string | null): void {
  writeExtra(data, "pinnedGroupId", id);
}

/** Pinning is a radio, not a checkbox: pinning one unpins the other. */
export function togglePinnedGroup(data: WatchLogData, id: string): boolean {
  const next = pinnedGroupId(data) === id ? null : id;
  setPinnedGroupId(data, next);
  return next !== null;
}

/**
 * Drop title ids that no longer resolve.
 *
 * `deleteTitle` already sweeps groups, so this only matters for data that
 * arrived from v3 or from an external edit of `data.json`. Returns true when
 * anything was removed, so the caller knows whether to save.
 */
export function pruneGroups(groups: Group[], titles: readonly TitleV4[]): boolean {
  const live = new Set(titles.map((title) => title.id));
  let changed = false;
  for (const group of groups) {
    const before = group.titleIds.length;
    group.titleIds = group.titleIds.filter((id) => live.has(id));
    if (group.titleIds.length !== before) changed = true;
  }
  return changed;
}
