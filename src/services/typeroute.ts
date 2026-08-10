/**
 * Type → API routing (SPEC2 D-ANIME).
 *
 * One question, answered in exactly one place: **which catalogue does this
 * belong to?** It matters more than it sounds, because catalogue ids are only
 * unique inside their own catalogue — AniList 21 is One Piece, TMDB 21 is a
 * 1971 Belmondo film — so a lookup sent to the wrong provider does not fail, it
 * quietly returns a different work (the QA3 fix-4 note on `TypeApiRoute`).
 *
 * The v3 rule (`report-watchlog.md` §3, function `X`) is kept verbatim:
 *
 *   - the type named `Anime` routes to the anime family;
 *   - `Movie` / `TV Show` / `TvShow` route to the video family;
 *   - anything else consults `settings.typeApiMapping[type]`, where `""` means
 *     "nothing configured — decide from the title".
 *
 * v4 adds one rule on top, for *existing* titles only: **an id already written
 * to a title names the catalogue it came from**, and that outranks the type. v3
 * did the same thing (`anilistId > 0` vs `malId > 0` chose the dispatch), and it
 * is what keeps a title created against AniList from being refreshed against
 * TMDB the day its type is renamed.
 */
import { TYPE_MOVIE } from "../constants";
import type { ApiFamily, MediaType, TitleV4, TypeApiRoute } from "../types";

/** The built-in type name that is anime, before any user mapping is consulted. */
export const TYPE_ANIME = "Anime";

/** v3's hardcoded video type names, lowercased for comparison. */
const VIDEO_TYPE_NAMES = new Set(["movie", "tv show", "tvshow"]);

/** The settings this module reads. A subset, so tests need not build a whole one. */
export interface RoutingSettings {
  typeApiMapping: Record<string, "anime" | "movie" | "">;
  animeApiSource: "anilist" | "jikan";
}

/** AniList `format` → the media type Overseerr/Plex speak. */
export function mediaTypeForFormat(format: string | undefined): MediaType {
  return (format ?? "").toUpperCase() === "MOVIE" ? "movie" : "tv";
}

/**
 * The catalogue family a *type name* belongs to, or `""` for "not configured".
 *
 * Built-in names win over the mapping, exactly as v3 ordered it: a user who
 * renames nothing gets sane routing with an empty mapping object.
 */
export function familyForTypeName(typeName: string, settings: RoutingSettings): ApiFamily | "" {
  const name = typeName.trim();
  const lower = name.toLowerCase();
  if (lower === TYPE_ANIME.toLowerCase()) return "anime";
  if (VIDEO_TYPE_NAMES.has(lower)) return "video";

  const mapped = settings.typeApiMapping[name];
  if (mapped === "anime") return "anime";
  if (mapped === "movie") return "video";
  return "";
}

export function isAnimeTypeName(typeName: string, settings: RoutingSettings): boolean {
  return familyForTypeName(typeName, settings) === "anime";
}

/**
 * Where a *search* for this type should go.
 *
 * An unmapped type falls back to the video family — that is what v3's `""` meant
 * in practice once the Add modal had to do something — but it deliberately
 * leaves `mediaType` unset, because nothing here knows yet whether the user is
 * about to add a film or a show.
 */
export function routeForType(typeName: string, settings: RoutingSettings): TypeApiRoute {
  const family = familyForTypeName(typeName, settings);
  if (family === "anime") return { family: "anime", provider: settings.animeApiSource };
  if (typeName.trim().toLowerCase() === TYPE_MOVIE.toLowerCase()) {
    return { family: "video", mediaType: "movie" };
  }
  if (family === "video") return { family: "video", mediaType: "tv" };
  return { family: "video" };
}

/** Which anime id this title already carries, if any. */
export function animeIdsOf(title: TitleV4): { anilistId?: number; malId?: number } {
  const out: { anilistId?: number; malId?: number } = {};
  if ((title.anilistId ?? 0) > 0) out.anilistId = title.anilistId as number;
  if ((title.malId ?? 0) > 0) out.malId = title.malId as number;
  return out;
}

export function hasAnimeId(title: TitleV4): boolean {
  const ids = animeIdsOf(title);
  return ids.anilistId !== undefined || ids.malId !== undefined;
}

/**
 * The provider to use for a title that already exists.
 *
 * The id decides, not the preference: a title that only has a MAL id cannot be
 * refreshed on AniList without a search that might land on a different work, and
 * vice versa. The setting is only consulted when the title carries both ids (or
 * neither, which is the new-title case).
 */
export function providerForTitle(
  title: TitleV4,
  settings: RoutingSettings,
): "anilist" | "jikan" {
  const ids = animeIdsOf(title);
  if (ids.anilistId !== undefined && ids.malId === undefined) return "anilist";
  if (ids.malId !== undefined && ids.anilistId === undefined) return "jikan";
  return settings.animeApiSource;
}

/**
 * Where a *refresh* of this title should go.
 *
 * Ids first (see the header), then the type. A video route also answers with the
 * media type, since by now there is a title to derive it from.
 */
export function routeForTitle(title: TitleV4, settings: RoutingSettings): TypeApiRoute {
  if (hasAnimeId(title)) {
    return { family: "anime", provider: providerForTitle(title, settings) };
  }
  const byType = routeForType(title.type, settings);
  if (byType.family === "anime") return byType;
  if (byType.mediaType) return byType;

  const mediaType: MediaType =
    title.tmdbMediaType ??
    (title.type === TYPE_MOVIE
      ? "movie"
      : title.totalEpisodes > 1 || title.seasons.length > 1
        ? "tv"
        : "movie");
  return { family: "video", mediaType };
}

export function isAnimeTitle(title: TitleV4, settings: RoutingSettings): boolean {
  return routeForTitle(title, settings).family === "anime";
}

/** The anime types the user has, for settings copy and the add-flow type picker. */
export function animeTypeNames(
  types: readonly { name: string }[],
  settings: RoutingSettings,
): string[] {
  return types.map((t) => t.name).filter((name) => isAnimeTypeName(name, settings));
}
