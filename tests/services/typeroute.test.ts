/**
 * Type → API routing (SPEC2 D-ANIME).
 *
 * The bug this file exists to prevent has no symptom at the network layer: every
 * request succeeds, and the wrong work comes back. AniList 21 is One Piece,
 * TMDB 21 is a 1971 film, MAL 21 is One Piece again — same number, three
 * catalogues, and only one of them is the one this title came from.
 */
import { describe, expect, it } from "vitest";
import {
  animeIdsOf,
  animeTypeNames,
  familyForTypeName,
  hasAnimeId,
  isAnimeTitle,
  isAnimeTypeName,
  mediaTypeForFormat,
  providerForTitle,
  routeForTitle,
  routeForType,
  type RoutingSettings,
} from "../../src/services/typeroute";
import { createTitle } from "../../src/data/schema";
import type { TitleV4 } from "../../src/types";

function settings(over: Partial<RoutingSettings> = {}): RoutingSettings {
  return { typeApiMapping: {}, animeApiSource: "anilist", ...over };
}

function title(over: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({ id: "t", title: "T", type: "Anime", ...over });
}

describe("type names", () => {
  it("routes the built-in names the way v3 did, with an empty mapping", () => {
    const s = settings();
    expect(familyForTypeName("Anime", s)).toBe("anime");
    expect(familyForTypeName("Movie", s)).toBe("video");
    expect(familyForTypeName("TV Show", s)).toBe("video");
    expect(familyForTypeName("TvShow", s)).toBe("video");
    // Not configured — not "video by default", which is a different claim.
    expect(familyForTypeName("Korean TV Show", s)).toBe("");
  });

  it("routes a user-mapped custom type to anime", () => {
    const s = settings({ typeApiMapping: { Donghua: "anime", Documentary: "movie" } });
    expect(isAnimeTypeName("Donghua", s)).toBe(true);
    expect(familyForTypeName("Documentary", s)).toBe("video");
    expect(isAnimeTypeName("Documentary", s)).toBe(false);
  });

  it("is case-insensitive about the built-in names but not about the mapping key", () => {
    const s = settings({ typeApiMapping: { Donghua: "anime" } });
    expect(familyForTypeName("anime", s)).toBe("anime");
    expect(familyForTypeName("donghua", s)).toBe("");
  });

  it("carries the configured provider on an anime route", () => {
    expect(routeForType("Anime", settings())).toEqual({ family: "anime", provider: "anilist" });
    expect(routeForType("Anime", settings({ animeApiSource: "jikan" }))).toEqual({
      family: "anime",
      provider: "jikan",
    });
  });

  it("leaves mediaType unset for a type nothing has classified", () => {
    expect(routeForType("Korean TV Show", settings())).toEqual({ family: "video" });
    expect(routeForType("Movie", settings())).toEqual({ family: "video", mediaType: "movie" });
    expect(routeForType("TV Show", settings())).toEqual({ family: "video", mediaType: "tv" });
  });

  it("lists the user's anime types", () => {
    const s = settings({ typeApiMapping: { Donghua: "anime" } });
    const types = [{ name: "Anime" }, { name: "Movie" }, { name: "Donghua" }];
    expect(animeTypeNames(types, s)).toEqual(["Anime", "Donghua"]);
  });
});

describe("titles that already exist", () => {
  it("keeps a title on the catalogue its id came from, whatever the type says", () => {
    const anilistTyped = title({ type: "TV Show", anilistId: 154587 });
    expect(routeForTitle(anilistTyped, settings())).toEqual({ family: "anime", provider: "anilist" });

    const malTyped = title({ type: "Movie", malId: 52991 });
    expect(routeForTitle(malTyped, settings())).toEqual({ family: "anime", provider: "jikan" });
  });

  it("does not treat a zero id as an id — v3 wrote 0 for 'unused'", () => {
    const zeroed = title({ type: "TV Show", anilistId: 0, malId: 0 });
    expect(hasAnimeId(zeroed)).toBe(false);
    expect(animeIdsOf(zeroed)).toEqual({});
    expect(routeForTitle(zeroed, settings())).toEqual({ family: "video", mediaType: "tv" });
  });

  it("lets the preference decide only when the title carries both ids or neither", () => {
    const both = title({ anilistId: 154587, malId: 52991 });
    expect(providerForTitle(both, settings())).toBe("anilist");
    expect(providerForTitle(both, settings({ animeApiSource: "jikan" }))).toBe("jikan");

    // One id: the preference is irrelevant, because the other catalogue cannot
    // resolve it without a search that might land on a different work.
    const anilistOnly = title({ anilistId: 154587 });
    expect(providerForTitle(anilistOnly, settings({ animeApiSource: "jikan" }))).toBe("anilist");
    const malOnly = title({ malId: 52991 });
    expect(providerForTitle(malOnly, settings())).toBe("jikan");
  });

  it("routes an id-less anime type by its type", () => {
    expect(isAnimeTitle(title({ type: "Anime" }), settings())).toBe(true);
    expect(isAnimeTitle(title({ type: "Movie" }), settings())).toBe(false);
    expect(
      isAnimeTitle(title({ type: "Donghua" }), settings({ typeApiMapping: { Donghua: "anime" } })),
    ).toBe(true);
  });

  it("derives a media type for an unclassified video title", () => {
    const film = title({ type: "Korean TV Show", totalEpisodes: 1, seasons: [] });
    expect(routeForTitle(film, settings())).toEqual({ family: "video", mediaType: "movie" });

    const show = title({ type: "Korean TV Show", totalEpisodes: 16 });
    expect(routeForTitle(show, settings())).toEqual({ family: "video", mediaType: "tv" });

    // A stored media type is evidence and outranks the heuristic.
    const stored = title({ type: "Korean TV Show", totalEpisodes: 1, tmdbMediaType: "tv" });
    expect(routeForTitle(stored, settings())).toEqual({ family: "video", mediaType: "tv" });
  });
});

describe("format → media type", () => {
  it("calls only MOVIE a movie", () => {
    expect(mediaTypeForFormat("MOVIE")).toBe("movie");
    expect(mediaTypeForFormat("TV")).toBe("tv");
    expect(mediaTypeForFormat("TV_SHORT")).toBe("tv");
    expect(mediaTypeForFormat("OVA")).toBe("tv");
    expect(mediaTypeForFormat(undefined)).toBe("tv");
  });
});
