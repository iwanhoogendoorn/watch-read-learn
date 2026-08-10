/**
 * `obsidian://watchlog` route parsing — pure, total, and strict about typos.
 */
import { describe, expect, it } from "vitest";
import { parseWatchlogRoute } from "../src/uri";

describe("parseWatchlogRoute", () => {
  it("bare link opens the Library", () => {
    expect(parseWatchlogRoute({ action: "watchlog" })).toEqual({
      action: "open",
      tab: "library",
      query: "",
    });
  });

  it("tab parameter picks the tab", () => {
    expect(parseWatchlogRoute({ action: "watchlog", tab: "upcoming" })).toEqual({
      action: "open",
      tab: "upcoming",
      query: "",
    });
  });

  it("rejects an unknown tab with the list of real ones", () => {
    const route = parseWatchlogRoute({ action: "watchlog", tab: "upcomming" });
    expect(route.action).toBe("invalid");
    if (route.action === "invalid") {
      expect(route.reason).toContain('"upcomming"');
      expect(route.reason).toContain("upcoming");
    }
  });

  it("search is open with a query", () => {
    expect(parseWatchlogRoute({ action: "watchlog", do: "search", query: " alien " })).toEqual({
      action: "open",
      tab: "library",
      query: "alien",
    });
  });

  it("add carries the prefill query", () => {
    expect(parseWatchlogRoute({ action: "watchlog", do: "add", query: "Dune" })).toEqual({
      action: "add",
      query: "Dune",
    });
  });

  it("surprise is parameterless", () => {
    expect(parseWatchlogRoute({ action: "watchlog", do: "surprise" })).toEqual({
      action: "surprise",
    });
  });

  it("verbs are case-insensitive", () => {
    expect(parseWatchlogRoute({ action: "watchlog", do: "ADD" }).action).toBe("add");
  });

  it("rejects an unknown verb with the list of real ones", () => {
    const route = parseWatchlogRoute({ action: "watchlog", do: "explode" });
    expect(route.action).toBe("invalid");
    if (route.action === "invalid") {
      expect(route.reason).toContain('"explode"');
      expect(route.reason).toContain("surprise");
    }
  });

  it("honours a surviving action= parameter as the verb", () => {
    // On platforms where the query's action= is not clobbered by the handler
    // name, hand-written links using the conventional key still work.
    expect(parseWatchlogRoute({ action: "add", query: "Dune" })).toEqual({
      action: "add",
      query: "Dune",
    });
  });

  it("do= wins over action=", () => {
    expect(parseWatchlogRoute({ action: "watchlog", do: "surprise", query: "x" }).action).toBe(
      "surprise",
    );
  });

  it("tolerates a completely empty params object", () => {
    expect(parseWatchlogRoute({})).toEqual({ action: "open", tab: "library", query: "" });
  });
});
