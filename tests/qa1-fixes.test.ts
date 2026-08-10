/**
 * QA round 1 regressions (`BUGS-QA1.md`).
 *
 * One describe per reported bug, each pinning the behaviour the live vault test
 * showed to be wrong. The DOM-level B1 case lives in `ui-virtual-dom.test.ts`
 * because it needs its own layout stub.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import { createOverseerrClient } from "../src/services/overseerr";
import type { OverseerrClient, Settings, TitleV4 } from "../src/types";
import { createFakeHttp } from "./mocks/http";
import * as fx from "./fixtures/overseerr";
import {
  buildTitleForHit,
  defaultTypeFor,
  manualDefaultType,
} from "../src/ui/modals/add";
import { progressAffordance, renderModalPoster } from "../src/ui/modals/detail";
import {
  acknowledgePatch,
  buildUpcomingEntries,
  countDue,
  countEntries,
  formatCountdown,
  formatDate,
  isDue,
  summarizeCounts,
} from "../src/ui/tabs/upcoming";
import { clearPosterFailures, markPosterFailed } from "../src/ui/components/posters";
import { dateFormatPlaceholder, parseDisplayDate } from "../src/ui/components/dates";

const CONFIG = { url: "http://192.168.1.10:5055", apiKey: "test-key" };

/**
 * The few DOM affordances the poster helper touches. Obsidian's `createDiv` /
 * `createEl` / `addClass` extensions are part of that surface, which is why this
 * is a stub rather than a jsdom document.
 */
class StubEl {
  children: StubEl[] = [];
  classes = new Set<string>();
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  text = "";
  src = "";
  listeners = new Map<string, (() => void)[]>();
  style = { setProperty: (): void => undefined };

  constructor(public cls = "") {
    for (const c of cls.split(" ").filter(Boolean)) this.classes.add(c);
  }

  createDiv(options: { cls?: string; text?: string } = {}): StubEl {
    const child = new StubEl(options.cls ?? "");
    child.text = options.text ?? "";
    this.children.push(child);
    return child;
  }

  createEl(_tag: string, options: { cls?: string } = {}): StubEl {
    return this.createDiv(options);
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  removeClass(cls: string): void {
    this.classes.delete(cls);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  addEventListener(name: string, fn: () => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  fire(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }

  remove(): void {
    /* the tests inspect `children` directly */
  }

  querySelector(selector: string): StubEl | null {
    const cls = selector.replace(".", "");
    return this.children.find((c) => c.classes.has(cls)) ?? null;
  }

  find(cls: string): StubEl | undefined {
    return this.children.find((c) => c.classes.has(cls));
  }
}

function overseerr(): OverseerrClient {
  const fake = createFakeHttp({
    "/api/v1/search": { body: fx.searchResponse },
    "/api/v1/tv/136311": { body: fx.tvDetailsShrinking },
    "/api/v1/movie/1064213": { body: fx.movieDetailsAnora },
  });
  return createOverseerrClient(() => CONFIG, { http: fake.http });
}

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: overrides.id ?? "t",
    title: overrides.title ?? "Title",
    type: overrides.type ?? "Movie",
    ...overrides,
  });
}

/** The settings that produced the bug: "last used" was a TV type. */
function lastUsedTvSettings(): Settings {
  const settings = createDefaultSettings();
  settings.defaultAddType = "__wl_last_used__";
  settings.lastAddedType = "TV Show";
  return settings;
}

// ---------------------------------------------------------------------------
// B2 — the movie/TV chimera
// ---------------------------------------------------------------------------

describe("B2 — the add flow maps mediaType, not the last-used type", () => {
  it("makes a picked movie a one-episode Movie even when the last add was a show", async () => {
    // Exactly the reported sequence: add a show, then add Spider-Man (2002).
    const settings = lastUsedTvSettings();
    const details = await overseerr().details(1064213, "movie");
    const built = buildTitleForHit(details, settings, []);

    expect(built.type).toBe("Movie");
    expect(built.tmdbMediaType).toBe("movie");
    expect(built.totalEpisodes).toBe(1);
    expect(built.seasons).toEqual([]);
    expect(built.episodeDuration).toBe(139); // the film's runtime, on a film
    expect(progressAffordance(built)).toBe("movie-toggle");
  });

  it("builds a show's seasons — counts, offsets and per-episode runtime — from /tv", async () => {
    const settings = createDefaultSettings();
    settings.defaultAddType = "__wl_last_used__";
    settings.lastAddedType = "Movie"; // the last add was a film; this one is not
    const details = await overseerr().details(136311, "tv");
    const built = buildTitleForHit(details, settings, []);

    expect(built.type).not.toBe("Movie");
    expect(built.tmdbMediaType).toBe("tv");
    // Specials (season 0) dropped; the rest keep their upstream numbering.
    expect(built.seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
    expect(built.seasons.map((s) => s.episodes)).toEqual([10, 12, 12]);
    expect(built.seasons.map((s) => s.offset)).toEqual([0, 10, 22]);
    expect(built.totalEpisodes).toBe(34);
    // `episodeRunTime: [30, 30, 38]` → the modal value, not a film runtime.
    expect(built.episodeDuration).toBe(30);
    expect(progressAffordance(built)).toBe("season-grid");
  });

  it("still gives a show one season when upstream enumerates none", () => {
    const built = buildTitleForHit(
      {
        tmdbId: 999,
        mediaType: "tv",
        title: "Undated Show",
        overview: "",
        posterUrl: "",
        backdropUrl: "",
        releaseDate: "2026-01-01",
        genres: [],
        runtime: 42,
        voteAverage: 0,
        voteCount: 0,
        trailerUrl: "",
        director: [],
        cast: [],
        studio: [],
        seasons: [],
        numberOfSeasons: 1,
        numberOfEpisodes: 8,
      },
      createDefaultSettings(),
      [],
    );

    expect(built.seasons).toHaveLength(1);
    expect(built.seasons[0]?.episodes).toBe(8);
    expect(built.totalEpisodes).toBe(8);
    expect(progressAffordance(built)).toBe("season-grid");
  });

  it("never lets a type preference cross the movie/show line", () => {
    const settings = lastUsedTvSettings();
    expect(defaultTypeFor("movie", settings)).toBe("Movie");
    expect(defaultTypeFor("tv", settings)).toBe("TV Show");

    settings.defaultAddType = "Movie";
    expect(defaultTypeFor("movie", settings)).toBe("Movie");
    expect(defaultTypeFor("tv", settings)).toBe("Anime"); // first episodic type

    // An episodic preference is still honoured for shows.
    settings.defaultAddType = "Korean TV Show";
    expect(defaultTypeFor("tv", settings)).toBe("Korean TV Show");
    expect(defaultTypeFor("movie", settings)).toBe("Movie");
  });

  it("leaves the manual form free to start on whatever the user prefers", () => {
    const settings = createDefaultSettings();
    settings.defaultAddType = "Movie";
    expect(manualDefaultType(settings)).toBe("Movie");
    settings.defaultAddType = "__wl_last_used__";
    settings.lastAddedType = "Anime";
    expect(manualDefaultType(settings)).toBe("Anime");
    settings.lastAddedType = "Deleted Type";
    expect(manualDefaultType(settings)).toBe("Anime"); // first configured type
  });
});

describe("B2 — the detail modal's Progress section", () => {
  it("shows the season grid for every show that has seasons, even a single one", () => {
    const oneSeason = title({
      type: "TV Show",
      tmdbMediaType: "tv",
      totalEpisodes: 10,
      seasons: [
        { name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 },
      ],
    });
    expect(progressAffordance(oneSeason)).toBe("season-grid");
  });

  it("offers 'Mark as watched' to films only", () => {
    expect(progressAffordance(title({ type: "Movie", tmdbMediaType: "movie" }))).toBe(
      "movie-toggle",
    );
    // The chimera already in the user's vault: labelled "TV Show", but Overseerr
    // said movie. `tmdbMediaType` is the truth, so it gets the film affordance.
    expect(progressAffordance(title({ type: "TV Show", tmdbMediaType: "movie" }))).toBe(
      "movie-toggle",
    );
    // A show with no seasons filled in is NOT a film: no watched toggle.
    expect(
      progressAffordance(title({ type: "TV Show", tmdbMediaType: "tv", totalEpisodes: 1 })),
    ).toBe("needs-seasons");
  });

  it("falls back to the type name when nothing upstream is known", () => {
    expect(progressAffordance(title({ type: "Movie" }))).toBe("movie-toggle");
    expect(progressAffordance(title({ type: "Anime", totalEpisodes: 12 }))).toBe(
      "needs-seasons",
    );
  });
});

// ---------------------------------------------------------------------------
// B3 — the detail modal showed a placeholder for a title that has a poster
// ---------------------------------------------------------------------------

describe("B3 — the detail modal poster loads eagerly", () => {
  const render = (t: TitleV4): StubEl => {
    const host = new StubEl();
    renderModalPoster(host as unknown as HTMLElement, t);
    return host.children[0] as StubEl;
  };

  it("renders the image without needing an injected PosterLoader", () => {
    // The Library's own `openDetail` injects none — this used to be a guaranteed
    // letter placeholder even though the card behind the modal showed a poster.
    const poster = render(
      title({ title: "Spider-Man", posterUrl: "https://image.tmdb.org/t/p/w342/nXd.jpg" }),
    );
    const img = poster.find("wl-poster-img");
    expect(img?.src).toBe("https://image.tmdb.org/t/p/w342/nXd.jpg");
    expect(poster.find("wl-poster-initial")).toBeUndefined();
  });

  it("expands a bare TMDB poster path against the CDN base", () => {
    const poster = render(title({ posterUrl: "/abc.jpg" }));
    expect(poster.find("wl-poster-img")?.src).toBe("https://image.tmdb.org/t/p/w342/abc.jpg");
  });

  it("prefers the manual override, and ignores the v3 'none' sentinel", () => {
    const overridden = render(
      title({ posterUrl: "/api.jpg", manualPosterUrl: "https://example.com/mine.jpg" }),
    );
    expect(overridden.find("wl-poster-img")?.src).toBe("https://example.com/mine.jpg");

    const sentinel = render(title({ title: "Alien", posterUrl: "none" }));
    expect(sentinel.find("wl-poster-img")).toBeUndefined();
    expect(sentinel.find("wl-poster-initial")?.text).toBe("A");
  });

  it("falls back to the tinted initial when there is no poster, or it fails", () => {
    clearPosterFailures();
    const none = render(title({ title: "Dexter", posterUrl: "" }));
    expect(none.classes.has("is-placeholder")).toBe(true);
    expect(none.find("wl-poster-initial")?.text).toBe("D");

    const broken = render(title({ title: "Dexter", posterUrl: "https://dead.example/x.jpg" }));
    broken.find("wl-poster-img")?.fire("error");
    expect(broken.find("wl-poster-initial")?.text).toBe("D");

    // And the negative result is cached, so re-opening does not re-request it.
    const again = render(title({ title: "Dexter", posterUrl: "https://dead.example/x.jpg" }));
    expect(again.find("wl-poster-img")).toBeUndefined();
    clearPosterFailures();
  });

  it("honours a URL already known to be dead", () => {
    clearPosterFailures();
    markPosterFailed("https://image.tmdb.org/t/p/w342/gone.jpg");
    const poster = render(title({ title: "Nope", posterUrl: "/gone.jpg" }));
    expect(poster.find("wl-poster-img")).toBeUndefined();
    clearPosterFailures();
  });
});

// ---------------------------------------------------------------------------
// B4 — Upcoming wording, released-item state, and the counters
// ---------------------------------------------------------------------------

describe("B4 — the Upcoming tab", () => {
  const NOW = new Date(2026, 7, 3); // 2026-08-03 local, the QA session's date

  const movie = (overrides: Partial<TitleV4> = {}): TitleV4 =>
    createTitle({
      id: overrides.id ?? "brand-new-day",
      title: overrides.title ?? "Spider-Man: Brand New Day",
      type: "Movie",
      tmdbMediaType: "movie",
      releaseDate: "2026-07-31",
      ...overrides,
    });

  it("says 'Released' once, not 'Release' and 'Released'", () => {
    const [entry] = buildUpcomingEntries([movie()], NOW);
    expect(entry?.label).toBe("Released");
    expect(entry?.detail).toBe("");
    // The row's own date + countdown carry the rest: "31-07-2026 · 3 days ago".
    expect(formatDate(entry?.date, "european")).toBe("31-07-2026");
    expect(formatCountdown(entry?.daysUntil ?? null)).toBe("3 days ago");
  });

  it("counts each row once — a single released film is '1 due', not '1 scheduled · 1 due'", () => {
    const entries = buildUpcomingEntries([movie()], NOW);
    expect(countEntries(entries)).toEqual({ upcoming: 0, due: 1, announced: 0 });
    expect(summarizeCounts(countEntries(entries))).toBe("1 due");

    const mixed = buildUpcomingEntries(
      [
        movie(),
        movie({ id: "later", title: "Later", releaseDate: "2026-09-01" }),
        createTitle({
          id: "show",
          title: "Show",
          type: "TV Show",
          airing: { newSeasonDetected: 4 },
        }),
      ],
      NOW,
    );
    expect(countEntries(mixed)).toEqual({ upcoming: 1, due: 1, announced: 1 });
    expect(summarizeCounts(countEntries(mixed))).toBe("1 scheduled · 1 due · 1 announced");
  });

  it("acknowledging a row clears it, and only it", () => {
    const [entry] = buildUpcomingEntries([movie()], NOW);
    expect(entry).toBeDefined();
    if (!entry) return;

    const patch = acknowledgePatch(entry, NOW);
    expect(patch.upcomingAcknowledged).toEqual({
      kind: "release",
      date: "2026-07-31",
      at: NOW.toISOString(),
    });

    const acked = movie({ ...patch });
    expect(buildUpcomingEntries([acked], NOW)).toEqual([]);
    expect(countDue(buildUpcomingEntries([acked], NOW))).toBe(0);

    // A different date is new news and comes back.
    const redated = movie({ ...patch, releaseDate: "2026-08-02" });
    expect(buildUpcomingEntries([redated], NOW)).toHaveLength(1);

    // So is a different kind of row for the same title.
    const show = createTitle({
      id: "dexter",
      title: "Dexter",
      type: "TV Show",
      totalEpisodes: 10,
      airing: { nextEpisode: { season: 2, episode: 1, airDate: "2026-08-01" } },
      upcomingAcknowledged: { kind: "release", date: "2026-08-01", at: NOW.toISOString() },
    });
    expect(buildUpcomingEntries([show], NOW).map((e) => e.kind)).toEqual(["episode"]);
  });

  it("knows which rows are due at all", () => {
    const entries = buildUpcomingEntries(
      [movie(), movie({ id: "future", releaseDate: "2026-08-20" })],
      NOW,
    );
    expect(entries.map(isDue)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// B5 — dates in the user's configured format
// ---------------------------------------------------------------------------

describe("B5 — editable dates honour settings.dateFormat", () => {
  it("advertises the configured pattern", () => {
    expect(dateFormatPlaceholder("european")).toBe("dd-mm-yyyy");
    expect(dateFormatPlaceholder("american")).toBe("mm/dd/yyyy");
    expect(dateFormatPlaceholder("iso")).toBe("yyyy-mm-dd");
  });

  it("renders a stored date in each format", () => {
    expect(formatDate("2026-07-31", "european")).toBe("31-07-2026");
    expect(formatDate("2026-07-31", "american")).toBe("07/31/2026");
    expect(formatDate("2026-07-31", "iso")).toBe("2026-07-31");
    expect(formatDate(null, "european")).toBe("");
    expect(formatDate("not a date", "european")).toBe("");
  });

  it("round-trips what the user types back to storage form", () => {
    expect(parseDisplayDate("31-07-2026", "european")).toEqual({ ok: true, value: "2026-07-31" });
    expect(parseDisplayDate("07/31/2026", "american")).toEqual({ ok: true, value: "2026-07-31" });
    expect(parseDisplayDate("2026-07-31", "iso")).toEqual({ ok: true, value: "2026-07-31" });
    // Separators and leading zeros are typing noise, not intent.
    expect(parseDisplayDate("3.8.2026", "european")).toEqual({ ok: true, value: "2026-08-03" });
    expect(parseDisplayDate("3/8/2026", "european")).toEqual({ ok: true, value: "2026-08-03" });
    // An ISO value is unambiguous, so it is accepted under any format.
    expect(parseDisplayDate("2026-08-03", "european")).toEqual({ ok: true, value: "2026-08-03" });
  });

  it("clears on an empty field, and refuses anything that is not a date", () => {
    expect(parseDisplayDate("", "european")).toEqual({ ok: true, value: null });
    expect(parseDisplayDate("   ", "american")).toEqual({ ok: true, value: null });
    expect(parseDisplayDate("tomorrow", "european")).toEqual({ ok: false });
    expect(parseDisplayDate("31-07", "european")).toEqual({ ok: false });
    expect(parseDisplayDate("31-02-2026", "european")).toEqual({ ok: false }); // no such day
    expect(parseDisplayDate("13/31/2026", "american")).toEqual({ ok: false }); // no such month
  });

  it("never guesses between day-first and month-first", () => {
    // 03-08-2026 is 3 August in Europe and nonsense in America — silently
    // reading it as 8 March is exactly the failure this refuses to make.
    expect(parseDisplayDate("03-08-2026", "european")).toEqual({ ok: true, value: "2026-08-03" });
    expect(parseDisplayDate("08/03/2026", "american")).toEqual({ ok: true, value: "2026-08-03" });
    expect(parseDisplayDate("31-07-2026", "american")).toEqual({ ok: false });
  });
});
