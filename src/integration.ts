/**
 * The composition root (SPEC §7, Wave 2).
 *
 * Every Wave-1 lane was built against an interface and handed a stand-in. This
 * is the one place that constructs the real thing and hands it round: three API
 * clients, the availability index, the airing queue and the request feedback
 * loop, all reading **live settings** through closures so changing a URL in the
 * settings tab takes effect on the next call instead of on the next reload.
 *
 * Two rules the rest of the plugin depends on:
 *
 *   - **Nothing here throws at the caller.** A refresh that fails returns a
 *     sentence; a title that fails is skipped. The UI's job is to render, not
 *     to handle a network stack.
 *   - **Every write goes through the store**, which is what dispatches
 *     `watchlog-data-changed` — so a background poll repaints every open tab,
 *     widget and the status bar without any of them knowing this file exists.
 */
import { Notice, type App } from "obsidian";
import { createOverseerrClient } from "./services/overseerr";
import { createPlexClient, type PlexClientEx } from "./services/plex";
import { createTmdbClient } from "./services/tmdb";
import { createAvailabilityService, type AvailabilityService } from "./services/availability";
import {
  createAiringService,
  isEmptySyncPlan,
  mediaTypeForTitle,
  seasonRebuildPlan,
  shouldTrackAiring,
  type AiringRefreshResult,
  type AiringService,
  type SeasonSyncPlan,
} from "./services/airing";
import { createRequestService, type RequestService } from "./services/requests";
import {
  pickSeeds,
  rankSuggestions,
  seedWeightFor,
  type Candidate,
  type Suggestion,
} from "./services/suggest";
import { createAnimeDomain, type AnimeDomain } from "./domains/anime";
import { isAnimeTypeName } from "./services/typeroute";
import {
  createMatchService,
  identityMatches,
  matchStateFor,
  needsTmdbBackfill,
  typeFamilyOf,
  typeRepairFor,
  type MatchOutcome,
  type MatchService,
} from "./services/match";
import { seasonsFromDetails } from "./ui/modals/add";
import { recomputeOffsets, totalFromSeasons, withAddedSeason } from "./data/episodes";
import { readExtra, writeExtra } from "./types";
import type {
  DateString,
  GenreOption,
  MediaType,
  OverseerrClient,
  OverseerrDetails,
  OverseerrMediaInfo,
  Settings,
  TitleV4,
  TitlePatch,
  TmdbClient,
  WatchLogStoreApi,
} from "./types";

/** What a suggestion run produced, plus anything worth saying about it. */
export interface SuggestionResult {
  suggestions: Suggestion[];
  /** Empty when there is nothing to explain; a sentence when there is. */
  note: string;
  /** Which library titles were asked, for the "based on" line. */
  seeds?: string[];
}

/** The wizard's answers, in one object. Every field optional but the type. */
export interface GuidedQuery {
  mediaType?: MediaType;
  genres?: number[];
  /** "Something like this" — a title the user picked. */
  seed?: { tmdbId: number; title: string };
  /** With both a seed and genres, drop the seed's answers outside those genres. */
  strictGenre?: boolean;
  minRating?: number;
  minVotes?: number;
  fromYear?: number;
  toYear?: number;
  sortBy?: string;
  includeOwned?: boolean;
  limit?: number;
}

/** How long a library-driven suggestion run stays good for. */
const SUGGESTION_TTL_MS = 30 * 60_000;

/** How long after a view opens before the plugin bothers the servers again. */
const VIEW_OPEN_THROTTLE_MS = 60_000;

/** Plex badge refreshes run a few at a time — the server is on the LAN, not the moon. */
const PLEX_REFRESH_CONCURRENCY = 4;

export interface IntegrationDeps {
  app: App;
  store: WatchLogStoreApi;
  /** Persist a settings change made here (the discovered machine id). */
  saveSettings: (reason: string) => void;
}

export class Integrations {
  readonly overseerr: OverseerrClient;
  readonly plex: PlexClientEx;
  readonly tmdb: TmdbClient;
  readonly availability: AvailabilityService;
  readonly airing: AiringService;
  readonly requests: RequestService;
  readonly matcher: MatchService;
  /**
   * AniList + Jikan, their search service and their airing engine.
   *
   * Constructed here rather than in a lane because this is where the airing
   * sweep runs: an anime title routes to a different catalogue entirely, and the
   * sweep has to know that before it asks TMDB about a numeric id that means
   * something else there (SPEC2 §D-ANIME).
   */
  readonly anime: AnimeDomain;

  private readonly store: WatchLogStoreApi;
  private readonly deps: IntegrationDeps;

  /** Open the plugin views. Polling runs only while at least one is on screen. */
  private openViews = 0;
  private pollTimer: number | null = null;
  private lastViewOpenSync = 0;
  /** Guards against two "refresh everything" passes overlapping. */
  private busy = new Set<string>();
  /**
   * Last library-driven suggestion run. The dashboard asks on every mount, and
   * tab-flipping should not cost a round trip per flip — nor should the answer
   * be stale for a session, so it ages out.
   */
  private suggestionCache: { at: number; result: SuggestionResult } | null = null;

  constructor(deps: IntegrationDeps) {
    this.deps = deps;
    this.store = deps.store;
    const settings = (): Settings => deps.store.settings;

    this.overseerr = createOverseerrClient(() => ({
      url: settings().overseerrUrl,
      apiKey: settings().overseerrApiKey,
    }));

    this.plex = createPlexClient(() => ({
      url: settings().plexUrl,
      token: settings().plexToken,
      machineId: settings().plexMachineId,
    }));

    this.tmdb = createTmdbClient(() => ({ token: settings().tmdbToken }));

    this.availability = createAvailabilityService({
      plex: this.plex,
      getMachineId: () => settings().plexMachineId,
    });

    this.airing = createAiringService({
      overseerr: this.overseerr,
      tmdb: this.tmdb,
      getTtlHours: () => settings().airingTtlHours,
    });

    this.matcher = createMatchService({ overseerr: this.overseerr });

    this.anime = createAnimeDomain({
      settings: () => ({
        types: settings().types,
        typeApiMapping: settings().typeApiMapping,
        animeApiSource: settings().animeApiSource,
      }),
    });

    this.requests = createRequestService({
      overseerr: this.overseerr,
      store: deps.store,
      notify: (message) => {
        new Notice(message, 8000);
      },
      // The badge and the pill must agree the moment the request lands.
      onAvailable: async (title) => {
        await this.refreshTitlePlex(title);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Plex availability
  // -------------------------------------------------------------------------

  /**
   * Make sure `settings.plexMachineId` is populated.
   *
   * `/identity` needs no token even on a locked-down server, so this is the
   * cheapest call in the whole plugin and the deep links depend on it.
   */
  async ensureMachineId(): Promise<string> {
    const current = this.store.settings.plexMachineId;
    if (current) return current;
    if (!this.plex.configured()) return "";
    try {
      const identity = await this.plex.identity();
      if (identity.machineIdentifier) {
        this.store.settings.plexMachineId = identity.machineIdentifier;
        this.deps.saveSettings("plex-machine-id");
      }
      return identity.machineIdentifier;
    } catch {
      return "";
    }
  }

  /**
   * Rebuild the GUID index and re-derive every title's Plex state.
   *
   * The index is the expensive part (one pass over every library section) and
   * the per-title work is then pure lookups plus one `allLeaves` per show.
   */
  async refreshPlexIndex(options: { force?: boolean } = {}): Promise<string> {
    if (!this.plex.configured()) {
      return "Plex is not configured — add its URL in the plugin's settings.";
    }
    if (this.busy.has("plex")) return "A Plex refresh is already running.";
    this.busy.add("plex");
    try {
      await this.ensureMachineId();
      const index = await this.availability.ensureIndex(options.force ?? true);
      const titles = [...this.store.allTitles()];
      const changed = await this.refreshPlexFor(titles);
      return (
        `Plex index: ${index.itemCount} item(s). ` +
        `${changed} of ${titles.length} title(s) updated.`
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] Plex index refresh failed", err);
      return `Plex refresh failed: ${detail}`;
    } finally {
      this.busy.delete("plex");
    }
  }

  /**
   * Re-derive `title.plex` for one title. Silent on failure by design.
   *
   * `silent` suppresses the per-title change event so a bulk sweep repaints
   * once rather than once per title.
   */
  async refreshTitlePlex(
    title: TitleV4,
    silent = false,
    options: { mediaInfo?: OverseerrMediaInfo | undefined } = {},
  ): Promise<boolean> {
    if (!this.plex.configured()) return false;
    // With Overseerr's `mediaInfo` in hand the matcher can go straight to
    // `/library/metadata/{ratingKey}` and skip the GUID index entirely.
    const cache = await this.availability.refreshTitle(
      title,
      options.mediaInfo ? { mediaInfo: options.mediaInfo } : {},
    );
    // `unknown` is what an unreachable server produces; it must never overwrite
    // a good answer with "we don't know" and blank the badge.
    if (cache.state === "unknown" && title.plex && title.plex.state !== "unknown") return false;

    const changed = !sameCache(title.plex, cache);
    this.store.updateCaches(
      title.id,
      { plex: cache },
      { reason: changed ? "plex-refreshed" : "plex-checked", silent: silent || !changed },
    );
    return changed;
  }

  /** Bounded-concurrency sweep; returns how many titles actually changed. */
  private async refreshPlexFor(titles: readonly TitleV4[]): Promise<number> {
    let cursor = 0;
    let changed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const title = titles[index];
        if (!title) return;
        try {
          if (await this.refreshTitlePlex(title, true)) changed += 1;
        } catch (err) {
          console.warn(`[wrl] Plex refresh failed for ${title.title}`, err);
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(PLEX_REFRESH_CONCURRENCY, titles.length) },
      () => worker(),
    );
    await Promise.all(workers);
    // One repaint for the whole sweep.
    if (changed > 0) this.store.emitChanged({ reason: "plex-sweep" });
    return changed;
  }

  /** Only the titles whose Plex state has aged past `plexTtlHours`. */
  private async refreshStalePlex(): Promise<void> {
    if (!this.plex.configured()) return;
    const ttl = this.store.settings.plexTtlHours;
    const due = this.store
      .allTitles()
      .filter((title) => this.availability.needsRefresh(title, ttl));
    if (due.length === 0) return;
    try {
      await this.availability.ensureIndex(await this.availability.isIndexStale());
    } catch (err) {
      console.warn("[wrl] could not build the Plex index", err);
      return;
    }
    await this.refreshPlexFor(due);
  }

  // -------------------------------------------------------------------------
  // TMDB id backfill (SPEC §4.1; QA2 report 1)
  // -------------------------------------------------------------------------

  /**
   * Give every title that lacks a TMDB id one, before anything that needs it
   * runs.
   *
   * This is the step that was specified and never built. Migrated v3 rows carry
   * no `tmdbId` — v3 used OMDb — so `shouldTrackAiring` refused them and the
   * Plex index had no GUID to look them up by. Both engines skipped them
   * silently, which is how a returning show sat in the library with no airing
   * data at all.
   *
   * A confident match is written through (`tmdbId` + `tmdbMediaType`). Anything
   * else records *why* on the title, so the UI can offer the picker instead of
   * pretending everything is fine.
   */
  async backfillTmdbIds(options: { force?: boolean } = {}): Promise<string> {
    if (!this.overseerr.configured()) {
      return "Overseerr is not configured, so titles cannot be matched automatically.";
    }
    if (this.busy.has("match")) return "A match pass is already running.";
    this.busy.add("match");
    try {
      const results = await this.matcher.matchAll([...this.store.allTitles()], {
        ...(options.force !== undefined ? { force: options.force } : {}),
      });
      let matched = 0;
      let needsHelp = 0;
      for (const result of results) {
        if (result.error) continue; // a network blip is not "unmatched"
        if (this.applyMatchOutcome(result.titleId, result.outcome)) matched += 1;
        else needsHelp += 1;
      }
      if (results.length === 0) return "Every title already has a TMDB id.";
      const tail = needsHelp > 0 ? `, ${needsHelp} need(s) a manual match` : "";
      return `Matched ${matched} of ${results.length} title(s)${tail}.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] TMDB backfill failed", err);
      return `Match pass failed: ${detail}`;
    } finally {
      this.busy.delete("match");
    }
  }

  /** Write one outcome through. Returns whether an id was actually adopted. */
  private applyMatchOutcome(titleId: string, outcome: MatchOutcome): boolean {
    const title = this.store.getTitle(titleId);
    if (!title) return false;

    if (outcome.kind === "match") {
      this.linkToTmdb(title, outcome.hit.tmdbId, outcome.hit.mediaType, "tmdb-backfilled");
      return true;
    }

    // A background finding, not an edit — so it goes through `updateCaches`,
    // which does not stamp `dateModified` and can stay silent.
    this.store.updateCaches(
      titleId,
      { tmdbMatch: matchStateFor(outcome, title.title, new Date().toISOString()) },
      { reason: "tmdb-unmatched", silent: true },
    );
    return false;
  }

  /**
   * Adopt an id for a title — from the backfill, or from the manual picker.
   *
   * Pulling the metadata straight afterwards is the point: the title has been
   * flying blind, so the first thing it should get is the data it was missing.
   */
  linkToTmdb(
    title: TitleV4,
    tmdbId: number,
    mediaType: "movie" | "tv",
    reason = "tmdb-linked",
  ): void {
    this.store.updateTitle(
      title.id,
      { tmdbId, tmdbMediaType: mediaType, tmdbMatch: undefined },
      reason,
    );
  }

  /** The manual picker's commit: adopt the id, then refresh everything. */
  async adoptMatch(title: TitleV4, tmdbId: number, mediaType: "movie" | "tv"): Promise<string> {
    this.linkToTmdb(title, tmdbId, mediaType);
    const fresh = this.store.getTitle(title.id);
    if (!fresh) return `Linked «${title.title}».`;
    return this.refreshTitleMetadata(fresh);
  }

  /** Titles the user still has to settle by hand. */
  unmatchedTitles(): TitleV4[] {
    return this.store.allTitles().filter((title) => needsTmdbBackfill(title));
  }

  // -------------------------------------------------------------------------
  // Media type vs display type (QA3 fix 4)
  // -------------------------------------------------------------------------

  /**
   * Make a title's display type agree with what it actually is upstream.
   *
   * The vault's pre-B2 chimera: "Spider-Man", type **TV Show**, tmdbId **557** —
   * which is the 2002 *film*. TMDB ids are only unique within a namespace, so
   * `/tv/557` would answer 200 with a completely different programme. Routing
   * already prefers `tmdbMediaType`, but two things made that not enough:
   * migration *infers* `tmdbMediaType` from the display type when v3 stored none
   * (`migrate.ts`), so a mislabelled row produces a confidently wrong media
   * type; and a film labelled "TV Show" is wrong on every card regardless.
   *
   * So when the two disagree, neither side is trusted: upstream is asked, and
   * the answer is whichever namespace returns *this* title (by name and year).
   * One call, only for titles that actually disagree, and the result is
   * persisted so it never has to be asked again.
   */
  async reconcileMediaTypes(): Promise<string> {
    if (!this.overseerr.configured() && !this.tmdb.configured()) return "";
    const suspect = this.store
      .allTitles()
      .filter((title) => title.tmdbId && typeFamilyOf(title.type) !== title.tmdbMediaType);
    if (suspect.length === 0) return "";

    let repaired = 0;
    for (const title of suspect) {
      try {
        if (await this.reconcileOne(title)) repaired += 1;
      } catch (err) {
        console.warn(`[wrl] could not reconcile ${title.title}`, err);
      }
    }
    return repaired > 0 ? `Repaired the type of ${repaired} title(s).` : "";
  }

  private async reconcileOne(title: TitleV4): Promise<boolean> {
    const claimed = title.tmdbMediaType;
    if (!claimed || !title.tmdbId) return false;
    const other: "movie" | "tv" = claimed === "movie" ? "tv" : "movie";

    // Ask the namespace the title claims first; a name+year match confirms it.
    const confirmed = (await this.identityCheck(title, claimed))
      ? claimed
      : (await this.identityCheck(title, other))
        ? other
        : undefined;
    if (!confirmed) return false; // neither answered as this title — leave it alone

    if (confirmed !== claimed) {
      // The *media type* was the wrong one, so the display type was right all
      // along. Fix the routing key and stop.
      this.store.updateTitle(title.id, { tmdbMediaType: confirmed }, "media-type-corrected");
      this.store.logActivity({
        action: "airing",
        message: `«${title.title}» is a ${confirmed === "movie" ? "film" : "series"} upstream — its lookups were pointing at the wrong catalogue`,
        titleId: title.id,
        titleName: title.title,
        source: "Watchlist",
      });
      new Notice(`«${title.title}» now looks itself up as a ${confirmed === "movie" ? "film" : "series"}.`);
      return true;
    }

    const repair = typeRepairFor(title, this.store.settings.types);
    if (!repair) return false;
    this.store.updateTitle(title.id, repair.patch, "type-repaired", { autoStatus: false });
    this.store.logActivity({
      action: "airing",
      message: `«${title.title}» was a ${repair.from} on your tracker but a ${confirmed === "movie" ? "film" : "series"} upstream — its type is now ${repair.to}`,
      titleId: title.id,
      titleName: title.title,
      source: "Watchlist",
    });
    new Notice(`«${title.title}» is a ${confirmed === "movie" ? "film" : "series"} — its type is now ${repair.to}.`, 8000);
    return true;
  }

  /** Does `/{mediaType}/{tmdbId}` actually describe this title? */
  private async identityCheck(title: TitleV4, mediaType: "movie" | "tv"): Promise<boolean> {
    if (!title.tmdbId) return false;
    try {
      const details = this.overseerr.configured()
        ? await this.overseerr.details(title.tmdbId, mediaType)
        : await this.tmdb.details(title.tmdbId, mediaType);
      return identityMatches(title, details);
    } catch {
      // A 404 is a clear "not in this namespace"; anything else is unproven, and
      // both mean "do not adopt this side".
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Airing
  // -------------------------------------------------------------------------

  /**
   * Run the airing queue and write the results through.
   *
   * Every result that describes a real change becomes an Activity entry — a
   * new season, a status flip, a rescheduled episode — which is what turns the
   * Activity tab into a log of the outside world rather than of your own clicks.
   */
  /**
   * Rebuild season structures that upstream disagrees with.
   *
   * Separate from `refreshAiring` because it is the one season operation that
   * *replaces* rather than appends. A show imported as a single flat season
   * holding every episode ever made cannot be repaired by syncing — sync would
   * append the real seasons on top of the fake one and double the count — so
   * the repair is explicit, reports what it changed, and is never automatic.
   *
   * Watched episodes are absolute numbers across the show, so re-cutting the
   * seasons underneath them leaves progress meaning exactly what it did.
   */
  async repairSeasons(): Promise<string> {
    if (!this.overseerr.configured() && !this.tmdb.configured()) {
      return "No metadata provider configured — add Overseerr (or a TMDB token) in the plugin's settings.";
    }
    if (this.busy.has("airing")) return "An airing refresh is already running.";
    this.busy.add("airing");
    try {
      const shows = this.store
        .allTitles()
        .filter((title) => title.tmdbId && mediaTypeForTitle(title) === "tv");
      if (shows.length === 0) return "No shows with a provider link to check.";

      const repaired: string[] = [];
      let failed = 0;
      for (const title of shows) {
        try {
          const details = this.overseerr.configured()
            ? await this.overseerr.details(title.tmdbId as number, "tv")
            : await this.tmdb.details(title.tmdbId as number, "tv");
          const plan = seasonRebuildPlan(title, details);
          if (!plan) continue;
          const before = title.seasons.length;
          this.store.updateTitle(
            title.id,
            { seasons: plan.seasons, totalEpisodes: plan.totalEpisodes },
            "seasons-repaired",
            // Absolute episode numbers are exactly what survives a repair —
            // see the note in updateTitle for what rebasing them would cost.
            { autoStatus: false, preserveAbsoluteEpisodes: true },
          );
          repaired.push(`${title.title} (${before} → ${plan.seasons.length} seasons)`);
          this.store.logActivity({
            action: "season",
            message: `Season structure of «${title.title}» rebuilt from upstream`,
            titleId: title.id,
            titleName: title.title,
            source: "Watchlist",
          });
        } catch (err) {
          failed += 1;
          console.warn("[wrl] season repair failed for", title.title, err);
        }
      }
      if (repaired.length === 0) {
        return failed > 0
          ? `No structures repaired; ${failed} lookup(s) failed.`
          : "Every show's seasons already match upstream.";
      }
      const tail = failed > 0 ? `, ${failed} failed` : "";
      return `Rebuilt: ${repaired.join("; ")}${tail}.`;
    } finally {
      this.busy.delete("airing");
    }
  }

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  /** TMDB ids already tracked — never suggested back at the user. */
  private ownedIds(): Set<number> {
    const owned = new Set<number>();
    for (const title of this.store.allTitles()) {
      if (title.tmdbId) owned.add(title.tmdbId);
    }
    return owned;
  }

  /**
   * "What should I watch, given what I already like?"
   *
   * Seeds are the library's own strongest signals; each is asked for its
   * recommendations, and what several of them agree on rises. Seeds are asked
   * in parallel but the whole thing is bounded by `pickSeeds`, so a library of
   * two thousand titles costs the same as one of ten.
   */
  async suggestFromLibrary(
    options: { limit?: number; seedLimit?: number } = {},
  ): Promise<SuggestionResult> {
    if (!this.overseerr.configured()) {
      return { suggestions: [], note: "Add an Overseerr server in the plugin's settings first." };
    }
    const cached = this.suggestionCache;
    if (cached && Date.now() - cached.at < SUGGESTION_TTL_MS) return cached.result;

    const seeds = pickSeeds(this.store.allTitles(), options.seedLimit ?? 8);
    if (seeds.length === 0) {
      return {
        suggestions: [],
        note: "Rate or finish a few titles and suggestions will build themselves from those.",
      };
    }

    const candidates: Candidate[] = [];
    await Promise.all(
      seeds.map(async (seed) => {
        const mediaType = mediaTypeForTitle(seed);
        const weight = seedWeightFor(seed);
        try {
          const recommended = await this.overseerr.recommendations(seed.tmdbId as number, mediaType);
          for (const result of recommended) {
            candidates.push({ result, source: "recommendation", seedName: seed.title, seedWeight: weight });
          }
          // Only pad from the noisier list when the good one came up short.
          if (recommended.length < 5) {
            const similar = await this.overseerr.similar(seed.tmdbId as number, mediaType);
            for (const result of similar.slice(0, 10)) {
              candidates.push({ result, source: "similar", seedName: seed.title, seedWeight: weight });
            }
          }
        } catch (err) {
          console.warn("[wrl] suggestions failed for", seed.title, err);
        }
      }),
    );

    const suggestions = rankSuggestions(candidates, {
      owned: this.ownedIds(),
      dismissed: new Set(this.dismissedSuggestions()),
      limit: options.limit ?? 24,
    });
    const result: SuggestionResult = {
      suggestions,
      note:
        suggestions.length === 0
          ? "Nothing new came back — everything suggested is already in your library."
          : "",
      seeds: seeds.map((seed) => seed.title),
    };
    this.suggestionCache = { at: Date.now(), result };
    return result;
  }

  /**
   * "I want a comedy like Ace Ventura."
   *
   * A seed title, a set of genres, or both. With a seed the answer is mostly
   * its recommendations; genres and era then filter that down. Without one it
   * is a discover browse, which is why the vote floor matters — sorted by
   * rating with no floor, TMDB happily returns films with four votes.
   */
  async suggestGuided(query: GuidedQuery): Promise<SuggestionResult> {
    if (!this.overseerr.configured()) {
      return { suggestions: [], note: "Add an Overseerr server in the plugin's settings first." };
    }
    const mediaType = query.mediaType ?? "movie";
    const candidates: Candidate[] = [];

    if (query.seed) {
      try {
        const recommended = await this.overseerr.recommendations(query.seed.tmdbId, mediaType);
        for (const result of recommended) {
          candidates.push({
            result,
            source: "recommendation",
            seedName: query.seed.title,
            seedWeight: 1,
          });
        }
        const similar = await this.overseerr.similar(query.seed.tmdbId, mediaType);
        for (const result of similar.slice(0, 20)) {
          candidates.push({ result, source: "similar", seedName: query.seed.title, seedWeight: 1 });
        }
      } catch (err) {
        console.warn("[wrl] guided suggestions failed for the seed", err);
      }
    }

    // A genre browse always runs: with a seed it widens a thin list, without
    // one it *is* the list.
    if (!query.seed || candidates.length < 12) {
      try {
        const discovered = await this.overseerr.discover({
          mediaType,
          genres: query.genres,
          sortBy: query.sortBy ?? "vote_average.desc",
          voteCountGte: query.minVotes ?? 300,
          ...(query.fromYear ? { releasedAfter: `${query.fromYear}-01-01` as DateString } : {}),
          ...(query.toYear ? { releasedBefore: `${query.toYear}-12-31` as DateString } : {}),
        });
        for (const result of discovered) candidates.push({ result, source: "discover" });
      } catch (err) {
        console.warn("[wrl] guided discover failed", err);
      }
    }

    const wanted = new Set(query.genres ?? []);
    const filtered =
      wanted.size === 0 || !query.strictGenre
        ? candidates
        : // With a seed, the genre answers are a filter on its recommendations:
          // "like Ace Ventura" *and* "a comedy" should not return its thrillers.
          candidates.filter((c) => c.result.genreIds.some((id) => wanted.has(id)));

    const suggestions = rankSuggestions(filtered, {
      owned: query.includeOwned ? new Set<number>() : this.ownedIds(),
      dismissed: new Set(this.dismissedSuggestions()),
      minRating: query.minRating ?? 0,
      ...(query.fromYear !== undefined ? { fromYear: query.fromYear } : {}),
      ...(query.toYear !== undefined ? { toYear: query.toYear } : {}),
      limit: query.limit ?? 24,
    });
    return {
      suggestions,
      note: suggestions.length === 0 ? "Nothing matched — try widening the era or the rating." : "",
    };
  }

  /** Genre vocabulary for the wizard, live rather than hardcoded. */
  async genreOptions(mediaType: MediaType = "movie"): Promise<GenreOption[]> {
    if (!this.overseerr.configured()) return [];
    try {
      return await this.overseerr.genres(mediaType);
    } catch {
      return [];
    }
  }

  /** "Not interested" is persistent, or it is not an answer. */
  dismissedSuggestions(): number[] {
    const raw = readExtra<number[]>(this.store.settings, "dismissedSuggestions");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "number") : [];
  }

  dismissSuggestion(tmdbId: number): void {
    const next = new Set(this.dismissedSuggestions());
    next.add(tmdbId);
    writeExtra(this.store.settings, "dismissedSuggestions", [...next]);
    this.deps.saveSettings("suggestion-dismissed");
    // The cached list still contains what was just refused. Drop it there too
    // rather than waiting for the TTL, or the row comes back on the next mount.
    if (this.suggestionCache) {
      this.suggestionCache.result = {
        ...this.suggestionCache.result,
        suggestions: this.suggestionCache.result.suggestions.filter(
          (s) => s.result.tmdbId !== tmdbId,
        ),
      };
    }
  }

  async refreshAiring(options: { force?: boolean } = {}): Promise<string> {
    if (!this.overseerr.configured() && !this.tmdb.configured()) {
      return "No metadata provider configured — add Overseerr (or a TMDB token) in the plugin's settings.";
    }
    if (this.busy.has("airing")) return "An airing refresh is already running.";
    // Nothing without a TMDB id can be refreshed, so earn one first — and a
    // title whose type disagrees with its media type must be settled before it
    // is used to route anything.
    if (this.store.allTitles().some((title) => needsTmdbBackfill(title))) {
      await this.backfillTmdbIds({ force: options.force ?? false });
    }
    await this.reconcileMediaTypes();
    this.busy.add("airing");
    try {
      const all = [...this.store.allTitles()];
      // An anime title is looked up in a different catalogue, so it is split off
      // before the TMDB sweep sees it. `airingSchedules` gives AniList a whole
      // week of exact per-episode timestamps in one query, which is why the
      // anime engine exists at all rather than being a special case in this one.
      const routing = {
        types: this.store.settings.types,
        typeApiMapping: this.store.settings.typeApiMapping,
        animeApiSource: this.store.settings.animeApiSource,
      };
      const anime = all.filter((title) => isAnimeTypeName(title.type, routing));
      const titles = all.filter((title) => !isAnimeTypeName(title.type, routing));

      const results = await this.airing.refreshAll(titles, { force: options.force ?? true });
      if (anime.length > 0) {
        try {
          const animeResults = await this.anime.airing.refreshAll(anime, {
            force: options.force ?? true,
          });
          results.push(...animeResults);
        } catch (err) {
          console.warn("[wrl] anime airing refresh failed", err);
        }
      }

      const { updated, failed } = this.applyAiringResults(results);

      if (results.length === 0) return "Nothing was due for an airing refresh.";
      const tail = failed > 0 ? `, ${failed} failed` : "";
      return `Airing data: ${updated} title(s) updated${tail}.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] airing refresh failed", err);
      return `Airing refresh failed: ${detail}`;
    } finally {
      this.busy.delete("airing");
    }
  }

  /**
   * Write a batch of airing results through, logging the ones that describe a
   * real change. Silent per title, one repaint at the end.
   */
  private applyAiringResults(
    results: readonly AiringRefreshResult[],
  ): { updated: number; failed: number } {
    let updated = 0;
    let failed = 0;

    for (const result of results) {
      if (result.error || !result.airing) {
        failed += 1;
        continue;
      }
      /**
       * The airing sweep also carries Overseerr's `mediaInfo.status`, which is
       * the one signal that says "Radarr/Sonarr already has this" for a title
       * nobody requested through Overseerr — added straight to Sonarr, imported
       * by Overseerr's own service scan, no request row anywhere. Writing it
       * into the request cache's `mediaStatus` (the field that describes the
       * *media*, never the request row) is what stops the UI offering to
       * request something that is already on its way.
       *
       * Merged, never replaced: a real request row's id/status/seasons must
       * survive a sweep that only knows about the media.
       */
      const patch: Parameters<typeof this.store.updateCaches>[1] = {
        airing: result.airing as TitleV4["airing"],
      };
      if (result.mediaStatus !== undefined) {
        const previous = this.store.getTitle(result.titleId)?.request;
        patch.request = {
          ...previous,
          mediaStatus: result.mediaStatus,
          checkedAt: new Date().toISOString(),
        };
      }
      this.store.updateCaches(result.titleId, patch, {
        reason: "airing-refreshed",
        silent: true,
      });
      this.applySeasonSync(result.titleId, result.seasonSync);
      updated += 1;
      if (!result.change) continue;
      const title = this.store.getTitle(result.titleId);
      this.store.logActivity({
        action: "airing",
        message: result.change,
        titleId: result.titleId,
        ...(title ? { titleName: title.title } : {}),
        source: "Watchlist",
      });
    }

    if (updated > 0) this.store.emitChanged({ reason: "airing-sweep" });
    return { updated, failed };
  }

  /**
   * Keep a followed show's seasons in step with upstream (QA3).
   *
   * The user's complaint was the workflow, not the model: one title already
   * holds every season, but each new one had to be adopted by hand — per-season
   * homework for a show they already follow. So upstream seasons the title lacks
   * are appended here, including a season announced with no episodes yet, and
   * empty seasons are sized as upstream publishes them.
   *
   * Both are real data changes, so they go through `updateTitle`, which re-bases
   * `watchedEpisodes` through the geometry change — appending is a no-op for the
   * numbers, and growing a season in the middle shifts every later one, which is
   * exactly what the rebase exists for.
   */
  private applySeasonSync(titleId: string, plan: SeasonSyncPlan | undefined): void {
    if (isEmptySyncPlan(plan) || !plan) return;
    const title = this.store.getTitle(titleId);
    if (!title) return;

    // Adoption is the setting; *sizing* a season the tracker already has is not
    // — that one is finishing a job the user already started by adding it.
    const adopt = this.store.settings.autoSyncSeasons ? plan.added : [];
    if (adopt.length === 0 && plan.grown.length === 0) return;

    const grownByNumber = new Map(plan.grown.map((u) => [u.seasonNumber, u.episodes]));
    let seasons = title.seasons.map((season, index) => {
      const number = season.seasonNumber ?? index + 1;
      const episodes = grownByNumber.get(number);
      // Only ever grows a season that is still empty — never overwrites a
      // length the user trimmed to what they actually own.
      if (episodes === undefined || season.episodes !== 0) return { ...season };
      return { ...season, episodes };
    });
    for (const add of adopt) {
      seasons = withAddedSeason(seasons, add.seasonNumber, add.episodes, add.airDate);
    }
    recomputeOffsets(seasons);

    // `autoStatus: false`: appending a season to a Completed show must not flip
    // it to Watching and wipe its finish date. The user decides that; the card
    // just grows a "New season" chip (QA3).
    this.store.updateTitle(
      titleId,
      { seasons, totalEpisodes: Math.max(1, totalFromSeasons(seasons)) },
      adopt.length > 0 ? "seasons-synced" : "season-length-filled",
      { autoStatus: false },
    );

    for (const add of adopt) {
      const suffix = add.episodes > 0 ? ` (${add.episodes} episodes)` : " — episode list to come";
      new Notice(`Season ${add.seasonNumber} added to «${title.title}»${suffix}`, 8000);
      this.store.logActivity({
        action: "season",
        message: `Season ${add.seasonNumber} of «${title.title}» was added automatically`,
        titleId,
        titleName: title.title,
        source: "Watchlist",
      });
    }
    for (const update of plan.grown) {
      this.store.logActivity({
        action: "season",
        message: `Season ${update.seasonNumber} of «${title.title}» has ${update.episodes} episode(s) upstream`,
        titleId,
        titleName: title.title,
        source: "Watchlist",
      });
    }
  }

  // -------------------------------------------------------------------------
  // One-title metadata refresh (the ⋮ menu)
  // -------------------------------------------------------------------------

  /**
   * Re-pull everything for one title: metadata, airing and Plex state.
   *
   * The user's own fields are never touched — rating, notes, status, tags,
   * watched episodes, and any `manual*` override all survive. Only the
   * API-sourced columns are rewritten, and only when the provider actually had
   * something to say.
   */
  async refreshTitleMetadata(title: TitleV4): Promise<string> {
    if (!title.tmdbId) {
      return `«${title.title}» has no TMDB id to look up.`;
    }
    const mediaType = mediaTypeForTitle(title);

    let details: OverseerrDetails;
    try {
      if (this.overseerr.configured()) {
        details = await this.overseerr.details(title.tmdbId, mediaType);
      } else if (this.tmdb.configured()) {
        details = await this.tmdb.details(title.tmdbId, mediaType);
      } else {
        return "No metadata provider configured.";
      }
    } catch (err) {
      return `Could not refresh «${title.title}»: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.store.updateTitle(title.id, metadataPatch(title, details), "metadata-refreshed");

    const result = await this.airing.refreshTitle(this.store.getTitle(title.id) ?? title);
    if (result.airing) {
      this.store.updateCaches(title.id, { airing: result.airing }, { reason: "airing-refreshed" });
    }

    const fresh = this.store.getTitle(title.id);
    if (fresh && this.plex.configured()) {
      try {
        await this.refreshTitlePlex(fresh);
      } catch (err) {
        console.warn("[wrl] Plex refresh after metadata failed", err);
      }
    }

    return `Refreshed «${title.title}».`;
  }

  /**
   * How many episodes a given season has upstream (SPEC §4.4).
   *
   * The airing cache usually already knows — it records the count when it
   * detects the season — and only an unlucky cache falls through to a details
   * call. `0` means "nobody could tell us", which the caller must not treat as
   * an empty season.
   */
  async upstreamSeasonEpisodes(title: TitleV4, seasonNumber: number): Promise<number> {
    const airing = title.airing;
    if (airing?.newSeasonDetected === seasonNumber && (airing.newSeasonEpisodes ?? 0) > 0) {
      return airing.newSeasonEpisodes ?? 0;
    }
    if (!title.tmdbId) return 0;
    const mediaType = mediaTypeForTitle(title);
    try {
      let details: OverseerrDetails;
      if (this.overseerr.configured()) {
        details = await this.overseerr.details(title.tmdbId, mediaType);
      } else if (this.tmdb.configured()) {
        details = await this.tmdb.details(title.tmdbId, mediaType);
      } else {
        return 0;
      }
      const summary = details.seasons?.find((season) => season.seasonNumber === seasonNumber);
      return summary?.episodeCount ?? 0;
    } catch (err) {
      console.warn("[wrl] could not look up the new season's episode count", err);
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Request polling lifecycle
  // -------------------------------------------------------------------------

  /**
   * A Watch, Read and Learn view appeared. Start polling if this is the first one, and do a
   * throttled catch-up so opening the view is what fixes stale data.
   */
  viewOpened(): void {
    this.openViews += 1;
    if (this.openViews === 1) this.startPolling();
    void this.catchUpThrottled();
  }

  viewClosed(): void {
    this.openViews = Math.max(0, this.openViews - 1);
    if (this.openViews === 0) this.stopPolling();
  }

  /** Settings changed the cadence — restart the timer with the new interval. */
  restartPolling(): void {
    this.stopPolling();
    if (this.openViews > 0) this.startPolling();
  }

  private startPolling(): void {
    const minutes = this.store.settings.requestPollMinutes;
    if (minutes <= 0) return; // 0 disables polling entirely (SPEC §4.2)
    if (!this.overseerr.configured()) return;
    this.pollTimer = window.setInterval(() => void this.pollRequests(), minutes * 60_000);
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async pollRequests(): Promise<void> {
    try {
      await this.requests.pollOnce();
    } catch (err) {
      console.warn("[wrl] request poll failed", err);
    }
  }

  /**
   * The throttled work done on view open — and on the Upcoming tab being
   * opened, which is the moment a user most expects the schedule to be current
   * (QA2 report 1): poll requests, backfill missing ids, refresh stale airing
   * data, refresh stale Plex badges.
   *
   * Throttled because switching tabs back and forth must not re-scan the
   * server; TTL-respecting, so it is cheap when nothing is stale.
   */
  async catchUpThrottled(): Promise<void> {
    const at = Date.now();
    if (at - this.lastViewOpenSync < VIEW_OPEN_THROTTLE_MS) return;
    this.lastViewOpenSync = at;
    await this.catchUp();
  }

  /**
   * Catch-up pass, also run once on plugin load.
   *
   * v3 only ever learned that something had aired while its view was open, so a
   * week of Obsidian being closed silently swallowed every notification. Running
   * this on load is the fix.
   */
  async catchUp(): Promise<void> {
    await this.pollRequests();

    // FIRST: a title with no TMDB id is invisible to both engines below, so the
    // backfill has to run before them, not after (QA2 report 1).
    try {
      if (this.store.allTitles().some((title) => needsTmdbBackfill(title))) {
        await this.backfillTmdbIds();
      }
    } catch (err) {
      console.warn("[wrl] TMDB backfill failed", err);
    }

    // Then: a title whose display type and media type disagree is looking
    // itself up in a catalogue that may not even contain it (QA3 fix 4).
    try {
      await this.reconcileMediaTypes();
    } catch (err) {
      console.warn("[wrl] type reconcile failed", err);
    }

    try {
      const titles = [...this.store.allTitles()];
      const at = new Date();
      const due = titles.filter((title) => shouldTrackAiring(title, at));
      if (due.length > 0) {
        this.applyAiringResults(await this.airing.refreshAll(titles, { force: false }));
      }
    } catch (err) {
      console.warn("[wrl] airing catch-up failed", err);
    }

    try {
      await this.refreshStalePlex();
    } catch (err) {
      console.warn("[wrl] Plex catch-up failed", err);
    }
  }

  // -------------------------------------------------------------------------
  // Deep links
  // -------------------------------------------------------------------------

  /** `Open in Plex` — needs the machine id, so it discovers one if missing. */
  async openInPlex(title: TitleV4): Promise<void> {
    const ratingKey = title.plex?.ratingKey;
    if (!ratingKey) {
      new Notice(`«${title.title}» has not been matched on Plex yet.`);
      return;
    }
    if (!this.store.settings.plexMachineId) await this.ensureMachineId();
    const url = this.plex.deepLink(ratingKey);
    if (!url) {
      new Notice("Plex's machine identifier is unknown — run the connection test in settings.");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  /** `Open on Overseerr` — the media page, which is where you'd act on it. */
  openInOverseerr(title: TitleV4): void {
    const base = this.store.settings.overseerrUrl.trim().replace(/\/+$/, "");
    if (!base) {
      new Notice("No Overseerr server configured.");
      return;
    }
    if (!title.tmdbId) {
      new Notice(`«${title.title}» has no TMDB id, so there is no Overseerr page for it.`);
      return;
    }
    const type = mediaTypeForTitle(title);
    window.open(`${base}/${type}/${title.tmdbId}`, "_blank", "noopener");
  }

  destroy(): void {
    this.stopPolling();
    this.openViews = 0;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The API-sourced columns a metadata refresh may overwrite.
 *
 * Deliberately excluded: everything the user owns, plus `posterUrl`/`trailerUrl`
 * when the provider came back empty — a blank answer is not a reason to throw
 * away a poster that works.
 */
export function metadataPatch(title: TitleV4, details: OverseerrDetails): TitlePatch {
  const patch: TitlePatch = {
    overview: details.overview || title.overview || "",
    genres: details.genres.length > 0 ? details.genres : (title.genres ?? []),
    director: details.director.length > 0 ? details.director : title.director,
    cast: details.cast.length > 0 ? details.cast : title.cast,
    studio: details.studio.length > 0 ? details.studio : title.studio,
    communityRating: details.voteAverage,
    communityVotes: details.voteCount,
    communitySource: "tmdb",
    communityRatingLastFetched: new Date().toISOString(),
  };

  if (details.posterUrl) patch.posterUrl = details.posterUrl;
  if (details.trailerUrl) patch.trailerUrl = details.trailerUrl;
  if (details.imdbId) patch.imdbId = details.imdbId;
  if (details.releaseDate) {
    patch.releaseDate = details.releaseDate;
    const year = Number.parseInt(details.releaseDate.slice(0, 4), 10);
    if (Number.isFinite(year)) patch.year = year;
  }
  if (details.runtime > 0) patch.episodeDuration = Math.max(0, Math.round(details.runtime));

  // Seasons are only adopted when the tracker has none. Overwriting them would
  // discard the user's skipped-episode choices, which is data loss.
  if (details.mediaType === "tv" && title.seasons.length === 0) {
    const seasons = seasonsFromDetails(details);
    if (seasons.length > 0) {
      patch.seasons = seasons;
      patch.totalEpisodes = Math.max(1, totalFromSeasons(seasons));
    }
  }

  return patch;
}

/** Cheap equality for the Plex cache, ignoring `checkedAt`. */
function sameCache(
  previous: TitleV4["plex"] | undefined,
  next: NonNullable<TitleV4["plex"]>,
): boolean {
  if (!previous) return false;
  return (
    previous.state === next.state &&
    previous.ratingKey === next.ratingKey &&
    previous.leafCount === next.leafCount &&
    (previous.episodes?.length ?? 0) === (next.episodes?.length ?? 0)
  );
}
