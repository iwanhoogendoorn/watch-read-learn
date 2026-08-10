/**
 * The anime domain (SPEC2 D-ANIME), assembled.
 *
 * One factory, so the composition root wires anime the way it wires everything
 * else: hand it live settings accessors, get back a search service, an airing
 * refresher and the clients. Nothing in here reaches for the plugin, the store
 * or the app — the modal is the only piece that knows Obsidian exists, and it is
 * constructed by the caller.
 */
import { createAniListClient, type AniListClientEx, type AniListDeps } from "../../services/anilist";
import { createJikanClient, type JikanClientEx, type JikanDeps } from "../../services/jikan";
import type { RoutingSettings } from "../../services/typeroute";
import {
  createAnimeAiringService,
  type AnimeAiringService,
} from "./airing";
import { createAnimeSearchService, type AnimeSearchService } from "./search";

export * from "./cache";
export * from "./errors";
export * from "./airing";
export * from "./request";
export * from "./search";
export * from "./modal";

export interface AnimeDomain {
  anilist: AniListClientEx;
  jikan: JikanClientEx;
  search: AnimeSearchService;
  airing: AnimeAiringService;
}

export interface AnimeDomainDeps {
  /** Read live, so a settings change takes effect on the next call. */
  settings: () => RoutingSettings;
  anilist?: AniListDeps;
  jikan?: JikanDeps;
  now?: () => Date;
}

/**
 * Both clients are always constructed, whichever provider leads.
 *
 * They are keyless, so there is nothing to configure and no cost to having the
 * other one ready — and "ready" is the point: the fallback only works if the
 * client that is not preferred still exists.
 */
export function createAnimeDomain(deps: AnimeDomainDeps): AnimeDomain {
  const anilist = createAniListClient(() => ({ enabled: true }), deps.anilist ?? {});
  const jikan = createJikanClient(() => ({ enabled: true }), deps.jikan ?? {});

  const search = createAnimeSearchService({ anilist, jikan, settings: deps.settings });
  const airing = createAnimeAiringService({
    anilist,
    jikan,
    settings: deps.settings,
    ...(deps.now ? { now: deps.now } : {}),
  });

  return { anilist, jikan, search, airing };
}
