/**
 * `episodeRuntime` and its single-episode fallback.
 *
 * The bug this file pins down, measured against the real library: five tracked
 * shows sat at `episodeDuration: 0` — The Agency, Reacher, The Day of the
 * Jackal, Last Seen and VisionQuest — so the detail screen drew no "Left" or
 * "Watched" tile and the dashboard under-counted. A full metadata sweep
 * refreshed all five (cast, studio and ratings all changed) and the durations
 * stayed at zero, because TMDB ships `episode_run_time: []` for every one of
 * them. The runtimes below are the ones TMDB actually answers with today.
 *
 * Payloads are fixtures shaped like the wire, in both spellings: snake_case is
 * a direct TMDB v3 call, camelCase is the same payload proxied through
 * Overseerr. No network.
 */
import { describe, expect, it } from "vitest";
import { EPISODE_RUNTIME_MAX_MINUTES, episodeRuntime } from "../../src/services/normalize";

/** `/tv/219971` — The Agency. Empty list, an aired finale that ran 57 minutes. */
const theAgency = {
  id: 219971,
  name: "The Agency",
  episode_run_time: [],
  last_episode_to_air: {
    id: 6072919,
    name: "King Sacrifice",
    air_date: "2026-04-19",
    episode_number: 10,
    season_number: 2,
    runtime: 57,
  },
  next_episode_to_air: null,
};

/** `/tv/108978` — Reacher, proxied. Both stubs present and they disagree. */
const reacherProxied = {
  id: 108978,
  name: "Reacher",
  episodeRunTime: [],
  lastEpisodeToAir: {
    id: 6146011,
    name: "One Small Step",
    airDate: "2026-08-06",
    episodeNumber: 3,
    seasonNumber: 4,
    runtime: 44,
  },
  nextEpisodeToAir: {
    id: 6146012,
    name: "Karambits and Pieces",
    airDate: "2026-08-13",
    episodeNumber: 4,
    seasonNumber: 4,
    runtime: 42,
  },
};

/** `/tv/258230` — Last Seen. Not premiered: `last` is null, `next` has 53. */
const lastSeen = {
  id: 258230,
  name: "Last Seen",
  episode_run_time: [],
  last_episode_to_air: null,
  next_episode_to_air: {
    id: 6207447,
    name: "The Dispatcher",
    air_date: "2026-09-24",
    episode_number: 1,
    season_number: 1,
    runtime: 53,
  },
};

/** `/tv/213375` — VisionQuest. TMDB knows nothing: no list, no runtime anywhere. */
const visionQuest = {
  id: 213375,
  name: "VisionQuest",
  episode_run_time: [],
  last_episode_to_air: null,
  next_episode_to_air: {
    id: 5330081,
    name: "Episode 1",
    air_date: null,
    episode_number: 1,
    season_number: 1,
    runtime: null,
  },
};

describe("episodeRuntime — a real list still decides", () => {
  it("prefers the modal list value over any single episode", () => {
    // Both stubs disagree with the list on purpose. The list wins regardless.
    expect(
      episodeRuntime({
        episode_run_time: [30, 30, 38],
        last_episode_to_air: { season_number: 3, episode_number: 7, runtime: 31 },
        next_episode_to_air: { season_number: 3, episode_number: 8, runtime: 32 },
      }),
    ).toBe(30);
  });

  it("still returns the modal value on a payload with no stubs at all", () => {
    expect(episodeRuntime({ episode_run_time: [60] })).toBe(60);
    expect(episodeRuntime({ episodeRunTime: [22, 24, 24] })).toBe(24);
  });

  it("breaks a tie towards the longer episode, as before", () => {
    expect(episodeRuntime({ episode_run_time: [25, 50] })).toBe(50);
  });

  it("treats a list of only unusable numbers as no list, and falls back", () => {
    // 0 and -1 are filtered out by the primary, which leaves nothing to be modal
    // about — that is the same state as an empty list, not a reason to give up.
    expect(
      episodeRuntime({
        episode_run_time: [0, -1],
        last_episode_to_air: { season_number: 1, runtime: 45 },
      }),
    ).toBe(45);
  });
});

describe("episodeRuntime — the single-episode fallback", () => {
  it("reads an aired episode's runtime when the list is empty (snake_case)", () => {
    expect(episodeRuntime(theAgency)).toBe(57);
  });

  it("reads it through the camelCase spelling Overseerr proxies (camelCase)", () => {
    expect(episodeRuntime(reacherProxied)).toBe(44);
  });

  it("prefers the aired episode over the scheduled one — a fact beats a plan", () => {
    // Reacher's two stubs disagree: 44 aired, 42 scheduled. TMDB revises the
    // scheduled runtime right up until broadcast, so it must not win.
    expect(episodeRuntime(reacherProxied)).toBe(44);
    expect(episodeRuntime({ ...reacherProxied, lastEpisodeToAir: null })).toBe(42);
  });

  it("falls through to the scheduled episode for a show that has not premiered", () => {
    expect(episodeRuntime(lastSeen)).toBe(53);
  });

  it("falls through a *present* last stub whose runtime is null", () => {
    // The studioNames bug shape: TMDB sends both stubs, so a first-key-present
    // lookup would stop at `last` and never read `next`.
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, episode_number: 1, runtime: null },
        next_episode_to_air: { season_number: 1, episode_number: 2, runtime: 48 },
      }),
    ).toBe(48);
  });

  it("reads a camelCase last stub before a snake_case next stub", () => {
    expect(
      episodeRuntime({
        episodeRunTime: [],
        lastEpisodeToAir: { seasonNumber: 2, runtime: 51 },
        next_episode_to_air: { season_number: 2, runtime: 90 },
      }),
    ).toBe(51);
  });
});

describe("episodeRuntime — what the fallback refuses", () => {
  it("rejects a special: season 0 is recaps and compilations, not an episode", () => {
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 0, episode_number: 1, runtime: 92 },
        next_episode_to_air: { season_number: 1, episode_number: 1, runtime: 47 },
      }),
    ).toBe(47);
  });

  it("does not reject a stub that simply carries no season number", () => {
    // Absence is not evidence of a special.
    expect(episodeRuntime({ episode_run_time: [], last_episode_to_air: { runtime: 47 } })).toBe(47);
  });

  it("rejects a value too large to be an episode, rather than storing it", () => {
    const overBound = EPISODE_RUNTIME_MAX_MINUTES + 1;
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, runtime: overBound },
      }),
    ).toBe(0);
    // Seconds mistaken for minutes is the error class the bound exists for.
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, runtime: 2700 },
      }),
    ).toBe(0);
    // …and it falls through to a sane sibling rather than giving up outright.
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, runtime: 2700 },
        next_episode_to_air: { season_number: 1, runtime: 44 },
      }),
    ).toBe(44);
  });

  it("accepts the boundary itself, and a long-but-real finale", () => {
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, runtime: EPISODE_RUNTIME_MAX_MINUTES },
      }),
    ).toBe(EPISODE_RUNTIME_MAX_MINUTES);
    // The Day of the Jackal's 62-minute finale, and a 3-minute anime short.
    expect(
      episodeRuntime({ episode_run_time: [], last_episode_to_air: { season_number: 1, runtime: 62 } }),
    ).toBe(62);
    expect(
      episodeRuntime({ episode_run_time: [], last_episode_to_air: { season_number: 1, runtime: 3 } }),
    ).toBe(3);
  });

  it("rejects zero and negative runtimes", () => {
    expect(
      episodeRuntime({ episode_run_time: [], last_episode_to_air: { season_number: 1, runtime: 0 } }),
    ).toBe(0);
    expect(
      episodeRuntime({ episode_run_time: [], last_episode_to_air: { season_number: 1, runtime: -5 } }),
    ).toBe(0);
  });
});

describe("episodeRuntime — 0 stays the honest answer", () => {
  it("returns 0 when TMDB knows nothing at all", () => {
    // VisionQuest: no list, no aired episode, a scheduled one with no runtime.
    // Inventing a plausible 24 here would silently corrupt every time statistic.
    expect(episodeRuntime(visionQuest)).toBe(0);
  });

  it("returns 0 for an empty payload, a movie payload, and junk stubs", () => {
    expect(episodeRuntime({})).toBe(0);
    expect(episodeRuntime({ runtime: 139, title: "Dune: Part Two" })).toBe(0);
    expect(episodeRuntime({ episode_run_time: null, last_episode_to_air: "soon" })).toBe(0);
    expect(episodeRuntime({ episode_run_time: "60", last_episode_to_air: [] })).toBe(0);
  });

  it("ignores a non-numeric runtime on an otherwise well-formed stub", () => {
    expect(
      episodeRuntime({
        episode_run_time: [],
        last_episode_to_air: { season_number: 1, runtime: "forty-four" },
      }),
    ).toBe(0);
  });
});
