/**
 * Studios for a film, networks for a show.
 *
 * TMDB sends both `production_companies` and `networks` on a TV payload. The
 * normaliser used to take whichever key appeared first in one flat list, which
 * meant `networks` was never reached and every show in the library reported its
 * production company instead of the network it airs on — "Skydance Television"
 * where the user expected "Prime Video". These pin the branch so the two lists
 * can never be collapsed back into one lookup.
 */
import { describe, expect, it } from "vitest";
import { studioNames } from "../../src/services/normalize";

/** A real-shaped TMDB TV payload: it carries BOTH keys, which is the whole bug. */
const SHOW = {
  networks: [{ name: "Prime Video" }],
  production_companies: [{ name: "Skydance Television" }, { name: "Amazon Studios" }],
};

const FILM = {
  production_companies: [{ name: "Legendary Pictures" }, { name: "Warner Bros." }],
};

describe("studioNames", () => {
  it("gives a show its network, not its production company", () => {
    expect(studioNames(SHOW, "tv")).toEqual(["Prime Video"]);
  });

  it("gives a film its production companies", () => {
    expect(studioNames(FILM, "movie")).toEqual(["Legendary Pictures", "Warner Bros."]);
  });

  it("falls back to production companies when a show has no network", () => {
    // Something rather than nothing: a payload missing the preferred key should
    // still say who made it.
    expect(studioNames({ production_companies: [{ name: "HBO Films" }] }, "tv")).toEqual([
      "HBO Films",
    ]);
  });

  it("falls back to networks when a film somehow has only those", () => {
    expect(studioNames({ networks: [{ name: "Netflix" }] }, "movie")).toEqual(["Netflix"]);
  });

  it("accepts the camelCase spelling Overseerr proxies through", () => {
    expect(studioNames({ productionCompanies: [{ name: "A24" }] }, "movie")).toEqual(["A24"]);
  });

  it("is empty, never a sentinel, when the payload says nothing", () => {
    expect(studioNames({}, "tv")).toEqual([]);
  });
});
