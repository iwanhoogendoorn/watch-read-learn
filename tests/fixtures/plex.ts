/**
 * Plex response fixtures, from `docs/research/report-plex.md` — every body was
 * captured off a live PMS 1.43.2.10687, so the traps are real: `key` is a
 * string, `score` is a string, `size` counts things that are not results, and
 * `Guid` children only appear where the report says they do.
 */

/** §2 — the unauthenticated reachability probe. */
export const identityResponse = {
  MediaContainer: {
    size: 0,
    apiVersion: "1.2.2",
    claimed: true,
    machineIdentifier: "51d31168cdbab4f2f238cac328b3d979b1f3d706",
    version: "1.43.2.10687-563d026ea",
  },
};

/**
 * §3 — note section 4: a `type: "movie"` library on `tv.plex.agents.none`.
 * That is a home-video library; TMDB-matching it would be nonsense.
 */
export const sectionsResponse = {
  MediaContainer: {
    size: 5,
    title1: "Plex Library",
    Directory: [
      {
        allowSync: false,
        key: "1",
        type: "movie",
        title: "Movies (Iwan)",
        agent: "tv.plex.agents.movie",
        scanner: "Plex Movie",
        language: "en-US",
        uuid: "0ba600d0-7a74-4232-b593-d7538a2803f5",
        updatedAt: 1785764864,
        createdAt: 1726998951,
        scannedAt: 1785764809,
        hidden: 0,
        Location: [{ id: 1, path: "/data/media/movies" }],
      },
      {
        key: "2",
        type: "show",
        title: "TV Shows (Iwan)",
        agent: "tv.plex.agents.series",
        scanner: "Plex TV Series",
        uuid: "b41b2082-df12-4b1e-8ee3-0eb9427cd8b9",
        updatedAt: 1785764900,
        scannedAt: 1785764880,
      },
      { key: "3", type: "artist", title: "Music (Iwan)", agent: "tv.plex.agents.music" },
      { key: "4", type: "photo", title: "Photos (Iwan)", agent: "tv.plex.agents.none" },
      { key: "5", type: "movie", title: "Other Videos", agent: "tv.plex.agents.none" },
    ],
  },
};

/** §5 — a listing WITH `includeGuids=1`: `Guid` children are present. */
export const moviesPageResponse = {
  MediaContainer: {
    size: 2,
    totalSize: 2,
    offset: 0,
    librarySectionID: 1,
    librarySectionTitle: "Movies (Iwan)",
    viewGroup: "movie",
    Metadata: [
      {
        ratingKey: "884",
        key: "/library/metadata/884",
        guid: "plex://movie/64d57c2ea5e751c7bafbc457",
        slug: "anora-2024",
        studio: "Cre Film",
        type: "movie",
        title: "Anora",
        librarySectionID: 1,
        contentRating: "R",
        year: 2024,
        addedAt: 1734408937,
        Guid: [{ id: "imdb://tt28607951" }, { id: "tmdb://1064213" }, { id: "tvdb://355641" }],
      },
      {
        ratingKey: "506",
        key: "/library/metadata/506",
        guid: "plex://movie/5f4a2b2ea5e751c7bafbc999",
        type: "movie",
        title: "Alien: Romulus",
        librarySectionID: 1,
        year: 2024,
        Guid: [{ id: "imdb://tt18412256" }, { id: "tmdb://945961" }],
      },
    ],
  },
};

/** A modern-agent show, indexed at show level. */
export const showsPageResponse = {
  MediaContainer: {
    size: 1,
    totalSize: 1,
    offset: 0,
    librarySectionID: 2,
    Metadata: [
      {
        ratingKey: "3846",
        key: "/library/metadata/3846/children",
        guid: "plex://show/6168243f1c627ddb697e2a46",
        type: "show",
        title: "Shrinking",
        librarySectionID: 2,
        year: 2023,
        childCount: 3,
        leafCount: 33,
        Guid: [{ id: "imdb://tt15677150" }, { id: "tmdb://136311" }, { id: "tvdb://411364" }],
      },
    ],
  },
};

/** §6 — `/library/metadata/{rk}`: `Guid` is included without any param. */
export const showMetadataResponse = {
  MediaContainer: {
    size: 1,
    Metadata: [
      {
        ratingKey: "3846",
        key: "/library/metadata/3846/children",
        guid: "plex://show/6168243f1c627ddb697e2a46",
        slug: "shrinking",
        type: "show",
        title: "Shrinking",
        year: 2023,
        childCount: 3,
        leafCount: 33,
        viewedLeafCount: 0,
        index: 1,
        addedAt: 1769616653,
        updatedAt: 1783994584,
        originallyAvailableAt: "2023-01-27",
        librarySectionID: 2,
        Guid: [{ id: "imdb://tt15677150" }, { id: "tmdb://136311" }, { id: "tvdb://411364" }],
      },
    ],
  },
};

/**
 * §6 — `allLeaves`: every episode of a show in one call.
 * `parentIndex` is the season number; `index` is the episode number.
 */
export const allLeavesResponse = {
  MediaContainer: {
    size: 5,
    viewGroup: "episode",
    Metadata: [
      {
        ratingKey: "3852",
        type: "episode",
        title: "Coin Flip",
        index: 1,
        parentIndex: 1,
        grandparentTitle: "Shrinking",
        originallyAvailableAt: "2023-01-26",
        addedAt: 1769616882,
        duration: 2278528,
      },
      { ratingKey: "3853", type: "episode", title: "Fortress of Solitude", index: 2, parentIndex: 1 },
      { ratingKey: "3854", type: "episode", title: "Fifteen Minutes", index: 3, parentIndex: 1 },
      { ratingKey: "3901", type: "episode", title: "Jimmying", index: 1, parentIndex: 2 },
      { ratingKey: "3902", type: "episode", title: "Changing Patterns", index: 2, parentIndex: 2 },
    ],
  },
};

/**
 * §4 — `/hubs/search`. `size: 17` counts every hub including the empty ones,
 * `score` is a string, and the `actor` hub is not a library item.
 */
export const hubsSearchResponse = {
  MediaContainer: {
    size: 17,
    Hub: [
      {
        title: "Movies",
        type: "movie",
        hubIdentifier: "movie",
        size: 1,
        Metadata: [
          {
            ratingKey: "884",
            key: "/library/metadata/884",
            guid: "plex://movie/64d57c2ea5e751c7bafbc457",
            type: "movie",
            title: "Anora",
            year: 2024,
            librarySectionID: 1,
            librarySectionTitle: "Movies (Iwan)",
            score: "0.93084",
            Guid: [{ id: "imdb://tt28607951" }, { id: "tmdb://1064213" }],
          },
        ],
      },
      { title: "Shows", type: "show", hubIdentifier: "show", size: 0 },
      {
        title: "Actors",
        type: "actor",
        hubIdentifier: "actor",
        size: 1,
        Directory: [{ id: 99, tag: "Nora Zehetner" }],
      },
      {
        title: "Episodes",
        type: "episode",
        hubIdentifier: "episode",
        size: 1,
        Metadata: [{ ratingKey: "3852", type: "episode", title: "Coin Flip", index: 1, parentIndex: 1 }],
      },
    ],
  },
};

/** A show hit, for the fuzzy-then-confirm path. */
export const hubsSearchShowResponse = {
  MediaContainer: {
    size: 17,
    Hub: [
      {
        title: "Shows",
        type: "show",
        hubIdentifier: "show",
        size: 1,
        Metadata: [
          {
            ratingKey: "3846",
            type: "show",
            title: "Shrinking",
            year: 2023,
            librarySectionID: 2,
            score: "0.88",
            Guid: [{ id: "tmdb://136311" }],
          },
        ],
      },
    ],
  },
};

/** §1 — the pref that makes a bare 200 meaningless on LAN. */
export const prefsResponseWithAllowedNetworks = {
  MediaContainer: {
    size: 3,
    Setting: [
      { id: "FriendlyName", label: "Friendly name", type: "text", value: "Iwan's Plex Server" },
      {
        id: "allowedNetworks",
        label: "List of IP addresses and networks that are allowed without auth",
        type: "text",
        default: "",
        value: "10.11.111.0/24",
        advanced: true,
        group: "network",
      },
      { id: "LanNetworksBandwidth", label: "LAN networks", type: "text", value: "" },
    ],
  },
};

export const prefsResponseLockedDown = {
  MediaContainer: {
    size: 1,
    Setting: [{ id: "allowedNetworks", label: "Allowed networks", type: "text", value: "" }],
  },
};

/** §6 — a 404 answers with HTML, not a `MediaContainer`. */
export const notFoundHtml = `<html><head><title>404 Not Found</title></head><body>Not Found</body></html>`;
