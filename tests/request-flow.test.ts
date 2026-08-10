/**
 * The request flow — the one place in this plugin that makes something happen
 * on somebody else's server.
 *
 * A request reaches Overseerr, which hands it to Radarr/Sonarr, which starts
 * downloading. Nothing here can take that back, and the user reported the exact
 * failure this guards: a title requested as a side effect of a press they did
 * not mean as "request it". So the property under test is not "the POST works"
 * — it is **no POST without a yes**.
 */
import { describe, expect, it } from "vitest";
import { createTitle } from "../src/data/schema";
import { runRequestFlow } from "../src/ui/modals/request";
import type { RequestService } from "../src/services/requests";
import type { TitleV4 } from "../src/types";

/** A service that records every call instead of making one. */
function fakeService(): RequestService & { calls: { seasons?: number[] | "all" }[] } {
  const calls: { seasons?: number[] | "all" }[] = [];
  return {
    calls,
    submit: async (_title: TitleV4, seasons?: number[] | "all") => {
      calls.push(seasons === undefined ? {} : { seasons });
      return { message: "Requested", ok: true };
    },
  } as unknown as RequestService & { calls: { seasons?: number[] | "all" }[] };
}

const film = (overrides: Partial<TitleV4> = {}): TitleV4 =>
  createTitle({
    id: "film",
    title: "A Film",
    type: "Movie",
    tmdbId: 1,
    tmdbMediaType: "movie",
    totalEpisodes: 1,
    ...overrides,
  });

const show = (overrides: Partial<TitleV4> = {}): TitleV4 =>
  createTitle({
    id: "show",
    title: "A Show",
    type: "TV Show",
    tmdbId: 2,
    tmdbMediaType: "tv",
    totalEpisodes: 10,
    seasons: [{ name: "Season 1", seasonNumber: 1, episodes: 10, offset: 0, skippedEpisodes: [] }],
    ...overrides,
  });

const app = {} as never;

describe("nothing is requested without an explicit yes", () => {
  it("asks before requesting a film, and posts nothing when the answer is no", async () => {
    const service = fakeService();
    const asked: string[] = [];
    await runRequestFlow(app, film(), service, {
      confirm: async (title) => {
        asked.push(title.title);
        return false;
      },
    });
    expect(asked).toEqual(["A Film"]);
    expect(service.calls).toEqual([]);
  });

  it("posts once the answer is yes", async () => {
    const service = fakeService();
    await runRequestFlow(app, film(), service, { confirm: async () => true });
    expect(service.calls).toEqual([{}]);
  });

  it("asks before requesting a show it cannot break into seasons", async () => {
    // No season list — the picker cannot run, so this is the path that used to
    // post straight away.
    const service = fakeService();
    await runRequestFlow(app, show({ seasons: [] }), service, { confirm: async () => false });
    expect(service.calls).toEqual([]);

    const second = fakeService();
    const seen: (number[] | "all" | undefined)[] = [];
    await runRequestFlow(app, show({ seasons: [] }), second, {
      confirm: async (_title, seasons) => {
        seen.push(seasons);
        return true;
      },
    });
    // The confirmation names what it is about to do: every season.
    expect(seen).toEqual(["all"]);
    expect(second.calls).toEqual([{ seasons: "all" }]);
  });

  it("does not ask twice when the season picker already asked", async () => {
    const service = fakeService();
    let confirms = 0;
    await runRequestFlow(app, show(), service, {
      pick: async () => [1],
      confirm: async () => {
        confirms += 1;
        return true;
      },
    });
    // The picker IS the confirmation: it names the seasons and its button says
    // "Request 1 season".
    expect(confirms).toBe(0);
    expect(service.calls).toEqual([{ seasons: [1] }]);
  });

  it("posts nothing when the season picker is cancelled or left empty", async () => {
    const cancelled = fakeService();
    await runRequestFlow(app, show(), cancelled, { pick: async () => null });
    expect(cancelled.calls).toEqual([]);

    const empty = fakeService();
    await runRequestFlow(app, show(), empty, { pick: async () => [] });
    expect(empty.calls).toEqual([]);
  });
});
