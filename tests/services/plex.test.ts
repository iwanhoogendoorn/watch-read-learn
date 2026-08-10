import { describe, expect, it } from "vitest";
import {
  createPlexClient,
  guidValue,
  isIndexableSection,
  PLEX_PAGE_SIZE,
  type PlexConfig,
} from "../../src/services/plex";
import type { PlexSection } from "../../src/types";
import { createFakeHttp, type FakeRoute } from "../mocks/http";
import * as fx from "../fixtures/plex";

const CONFIG: PlexConfig = {
  url: "http://192.168.1.10:32400",
  token: "secret-token",
  machineId: "51d31168cdbab4f2f238cac328b3d979b1f3d706",
};

function client(routes: Record<string, FakeRoute>, config: PlexConfig = CONFIG) {
  const fake = createFakeHttp(routes);
  return { fake, api: createPlexClient(() => config, { http: fake.http }) };
}

const MOVIE_SECTION: PlexSection = {
  key: "1",
  type: "movie",
  title: "Movies (Iwan)",
  agent: "tv.plex.agents.movie",
};
const SHOW_SECTION: PlexSection = {
  key: "2",
  type: "show",
  title: "TV Shows (Iwan)",
  agent: "tv.plex.agents.series",
};

describe("section filtering", () => {
  it("keeps modern-agent movie and show libraries", () => {
    expect(isIndexableSection(MOVIE_SECTION)).toBe(true);
    expect(isIndexableSection(SHOW_SECTION)).toBe(true);
  });

  it("skips home videos — type movie, agent .none, no GUIDs ever", () => {
    expect(
      isIndexableSection({ key: "5", type: "movie", title: "Other Videos", agent: "tv.plex.agents.none" }),
    ).toBe(false);
  });

  it("skips music, photos and legacy agents", () => {
    expect(isIndexableSection({ key: "3", type: "artist", title: "Music", agent: "tv.plex.agents.music" })).toBe(false);
    expect(
      isIndexableSection({ key: "9", type: "movie", title: "Old", agent: "com.plexapp.agents.imdb" }),
    ).toBe(false);
  });

  it("reads the section list, keeping `key` a string", async () => {
    const { api } = client({ "/library/sections": { body: fx.sectionsResponse } });
    const sections = await api.sections();
    expect(sections.map((s) => s.key)).toEqual(["1", "2", "3", "4", "5"]);
    expect(sections[0]).toMatchObject({ key: "1", scannedAt: 1785764809, updatedAt: 1785764864 });

    const indexable = await api.indexableSections();
    expect(indexable.map((s) => s.key)).toEqual(["1", "2"]);
  });
});

describe("auth and transport", () => {
  it("sends the token as a header, never as a query param", async () => {
    const { api, fake } = client({ "/library/sections": { body: fx.sectionsResponse } });
    await api.sections();
    expect(fake.calls[0]?.headers).toMatchObject({ "X-Plex-Token": "secret-token" });
    expect(fake.calls[0]?.url).not.toContain("X-Plex-Token=");
  });

  it("probes /identity without a token — the one endpoint that never needs one", async () => {
    const { api, fake } = client({ "/identity": { body: fx.identityResponse } });
    const identity = await api.identity();
    expect(identity).toMatchObject({
      machineIdentifier: "51d31168cdbab4f2f238cac328b3d979b1f3d706",
      version: "1.43.2.10687-563d026ea",
      claimed: true,
    });
    expect(fake.calls[0]?.headers).toEqual({});
  });

  it("works without a token — allowedNetworks LANs answer anyway", () => {
    const { api } = client({}, { ...CONFIG, token: "" });
    expect(api.configured()).toBe(true);
  });

  it("is unconfigured without a URL", async () => {
    const { api } = client({}, { ...CONFIG, url: "" });
    expect(api.configured()).toBe(false);
    await expect(api.sections()).rejects.toMatchObject({ reason: "no-key" });
  });
});

describe("testConnection", () => {
  it("refuses to call a bare 200 proof of a valid token", async () => {
    // The unauthenticated /:/prefs succeeds → allowedNetworks covers us.
    const { api } = client({
      "/identity": { body: fx.identityResponse },
      "/:/prefs": { body: fx.prefsResponseWithAllowedNetworks },
    });
    const info = await api.testConnection();
    expect(info.ok).toBe(true);
    expect(info.tokenUnverified).toBe(true);
    expect(info.message).toContain("10.11.111.0/24");
    expect(info.machineId).toBe("51d31168cdbab4f2f238cac328b3d979b1f3d706");
  });

  it("verifies the token when the server does reject anonymous callers", async () => {
    const { api } = client({
      "/identity": { body: fx.identityResponse },
      "/:/prefs": (request) =>
        request.headers && "X-Plex-Token" in request.headers
          ? { body: fx.prefsResponseLockedDown }
          : { status: 401, text: "" },
    });
    const info = await api.testConnection();
    expect(info).toMatchObject({ ok: true, tokenUnverified: false });
    expect(info.message).toContain("token verified");
  });

  it("reports a rejected token", async () => {
    const { api } = client({
      "/identity": { body: fx.identityResponse },
      "/:/prefs": { status: 401, text: "" },
    });
    const info = await api.testConnection();
    expect(info).toMatchObject({ ok: false, tokenUnverified: false });
    expect(info.message).toContain("rejected the token");
  });

  it("reports an unreachable server without pretending to know about the token", async () => {
    const { api } = client({ "/identity": { status: 500, text: "" } });
    const info = await api.testConnection();
    expect(info).toMatchObject({ ok: false, tokenUnverified: true });
  });
});

describe("sectionItems", () => {
  it("requests includeGuids=1 and the numeric type, and indexes every GUID", async () => {
    const { api, fake } = client({ "/library/sections/1/all": { body: fx.moviesPageResponse } });
    const items = await api.sectionItems(MOVIE_SECTION);

    const url = fake.calls[0]?.url ?? "";
    expect(url).toContain("includeGuids=1");
    expect(url).toContain("type=1");
    expect(url).toContain(`X-Plex-Container-Size=${PLEX_PAGE_SIZE}`);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      ratingKey: "884",
      type: "movie",
      title: "Anora",
      year: 2024,
      librarySectionID: "1",
    });
    expect(items[0]?.guids).toEqual(["imdb://tt28607951", "tmdb://1064213", "tvdb://355641"]);
  });

  it("asks for type=2 on a show section and keeps leafCount", async () => {
    const { api, fake } = client({ "/library/sections/2/all": { body: fx.showsPageResponse } });
    const items = await api.sectionItems(SHOW_SECTION);
    expect(fake.calls[0]?.url).toContain("type=2");
    expect(items[0]).toMatchObject({ ratingKey: "3846", type: "show", leafCount: 33 });
  });

  it("paginates until a short page, counting Metadata rather than `size`", async () => {
    const full = {
      MediaContainer: {
        // A lying `size`, exactly like /search and /hubs/search send.
        size: 9999,
        totalSize: PLEX_PAGE_SIZE + 1,
        Metadata: Array.from({ length: PLEX_PAGE_SIZE }, (_, i) => ({
          ratingKey: `${i}`,
          type: "movie",
          title: `Movie ${i}`,
          Guid: [{ id: `tmdb://${i}` }],
        })),
      },
    };
    const last = {
      MediaContainer: {
        size: 1,
        totalSize: PLEX_PAGE_SIZE + 1,
        Metadata: [{ ratingKey: "last", type: "movie", title: "Last", Guid: [{ id: "tmdb://999" }] }],
      },
    };

    let call = 0;
    const { api, fake } = client({
      "/library/sections/1/all": () => {
        call += 1;
        return { body: call === 1 ? full : last };
      },
    });

    const items = await api.sectionItems(MOVIE_SECTION);
    expect(items).toHaveLength(PLEX_PAGE_SIZE + 1);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.url).toContain(`X-Plex-Container-Start=${PLEX_PAGE_SIZE}`);
  });

  it("skips rows that are not movies or shows", async () => {
    const { api } = client({
      "/library/sections/1/all": {
        body: {
          MediaContainer: {
            size: 2,
            Metadata: [
              { ratingKey: "1", type: "collection", title: "Marvel" },
              { ratingKey: "2", type: "movie", title: "Real", Guid: [{ id: "tmdb://5" }] },
            ],
          },
        },
      },
    });
    const items = await api.sectionItems(MOVIE_SECTION);
    expect(items.map((i) => i.ratingKey)).toEqual(["2"]);
  });
});

describe("metadata and allLeaves", () => {
  it("reads a single item, where Guid needs no param", async () => {
    const { api, fake } = client({ "/library/metadata/3846": { body: fx.showMetadataResponse } });
    const item = await api.metadata("3846");
    expect(fake.calls[0]?.url).not.toContain("includeGuids");
    expect(item).toMatchObject({ ratingKey: "3846", type: "show", leafCount: 33, year: 2023 });
    expect(item?.guids).toContain("tmdb://136311");
  });

  it("returns undefined on a 404 HTML body instead of exploding", async () => {
    const { api } = client({
      "/library/metadata/99999999": { status: 404, text: fx.notFoundHtml },
    });
    expect(await api.metadata("99999999")).toBeUndefined();
  });

  it("maps allLeaves to {s: parentIndex, e: index}", async () => {
    const { api } = client({ "/library/metadata/3846/allLeaves": { body: fx.allLeavesResponse } });
    const episodes = await api.allLeaves("3846");
    expect(episodes).toEqual([
      { s: 1, e: 1, ratingKey: "3852" },
      { s: 1, e: 2, ratingKey: "3853" },
      { s: 1, e: 3, ratingKey: "3854" },
      { s: 2, e: 1, ratingKey: "3901" },
      { s: 2, e: 2, ratingKey: "3902" },
    ]);
  });

  it("returns no episodes for a show Plex has never heard of", async () => {
    const { api } = client({ "/allLeaves": { status: 404, text: fx.notFoundHtml } });
    expect(await api.allLeaves("nope")).toEqual([]);
  });
});

describe("hubs search", () => {
  it("takes only movie and show hubs, ignoring empty hubs and the actor hub", async () => {
    const { api, fake } = client({ "/hubs/search": { body: fx.hubsSearchResponse } });
    const results = await api.search("nora");
    expect(fake.calls[0]?.url).toContain("includeGuids=1");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ratingKey: "884", title: "Anora", librarySectionID: "1" });
    expect(results[0]?.guids).toContain("tmdb://1064213");
  });

  it("short-circuits an empty query", async () => {
    const { api, fake } = client({});
    expect(await api.search("  ")).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("guid helpers and deep links", () => {
  it("extracts a scheme's value and rejects other schemes", () => {
    expect(guidValue("tmdb://1064213", "tmdb")).toBe("1064213");
    expect(guidValue("imdb://tt28607951", "imdb")).toBe("tt28607951");
    expect(guidValue("tmdb://1064213", "imdb")).toBeUndefined();
  });

  it("builds a Plex Web deep link with an encoded key", () => {
    const { api } = client({});
    expect(api.deepLink("884")).toBe(
      "http://192.168.1.10:32400/web/index.html#!/server/51d31168cdbab4f2f238cac328b3d979b1f3d706/details?key=%2Flibrary%2Fmetadata%2F884",
    );
  });

  it("returns an empty link when the machineId is not discovered yet", () => {
    const { api } = client({}, { ...CONFIG, machineId: "" });
    expect(api.deepLink("884")).toBe("");
  });
});
