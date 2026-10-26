# Watch, Read and Learn — local HTTP API

The same pattern as Helm's and Food Spot's APIs: an HTTP server inside
Obsidian, off by default, every request authenticated with a bearer token. It
exists so scripts, shortcuts and tools on this Mac (or on your tailnet) can
read the library and log what you have watched or read without opening
Obsidian's UI. Every write goes through the same store methods the views use,
so derived state (auto-complete on the last episode, `dateModified`, the
activity log, note mirroring, change events) stays consistent.

## Switching it on

Settings → Watch, Read and Learn → **Local API**. Enabling it the first time
generates a token. The token is stored **in cleartext** in the plugin's
`data.json`, next to the Plex and Overseerr keys — treat it like a password.
It is never logged, and `data.json` must never be committed anywhere.

- **Listen on** (default *This Mac + Tailscale*):
  - *This Mac only* binds 127.0.0.1. Nothing on the network can connect.
  - *This Mac + Tailscale* binds 127.0.0.1 **and** this machine's tailnet
    address (100.64.0.0/10), so local scripts keep working and tailnet
    traffic is encrypted by WireGuard. If Tailscale is not up when Obsidian
    starts, the API serves 127.0.0.1 only and checks again every 30 s.
  - *All interfaces* binds 0.0.0.0. **This is plain HTTP**: on a network you
    do not control, anyone watching the traffic can copy the token. Settings
    shows a warning while it runs this way.
- **Other devices are read-only** by default. A request whose TCP peer is not
  loopback gets `403` for any method other than `GET`/`HEAD`, unless *Allow
  writes from other devices* is on. Requests from this Mac are never limited,
  and the toggle applies immediately. The token alone is enough for remote
  reads; there is no allow-list.
- Default port **27129**; configurable. The family sits side by side: Helm
  27125, Food Spot 27126, Product Tracker 27127, Maestro 27128, Watch, Read
  and Learn 27129.
- Runs only while Obsidian is open and the toggle is on; torn down on unload.
  A reload of the plugin waits for the old listener to close before it binds
  again.
- If the port cannot be bound (another app has it, or another vault runs the
  API on the same port), Settings shows *port 27129 is in use; retrying* and
  the API tries again after 2 s, 5 s, 10 s and 30 s, then every minute until
  it binds or is switched off. When only the tailnet address fails, 127.0.0.1
  is served in the meantime.
- Desktop only — mobile Obsidian has no `node:http`, and the plugin still
  loads there with the API simply absent.

## Requests

- Base path: `http://127.0.0.1:27129/wrl/v1`
- Auth: `Authorization: Bearer <token>` on every request → `401` otherwise.
- Bodies are JSON (`content-type: application/json`).
- Every authenticated response carries **`x-wrl-revision`**: an integer that
  goes up on every change to the library, whether it came from the API or
  from the UI. A client can poll `GET /health` (which carries the same
  `revision`) and only re-fetch when it has moved.
- **Every write is flushed to disk before the `2xx` is sent.** A success means
  the change is in `data.json`; if the write fails, the answer is `500` and
  the change is still in memory, where Obsidian will retry it.
- Errors are JSON, always `{ "error": "message" }`:

| Status | When |
| --- | --- |
| `400` | Invalid input: a bad date, an unknown status, a malformed id, a missing parameter |
| `401` | Missing or wrong bearer token |
| `403` | A write from another device while *Allow writes from other devices* is off |
| `404` | No such film, show, book, audiobook, season or route |
| `405` | The path exists but not with that method |
| `409` | The request conflicts with the library: an episode marked as skipped or not yet aired, or a duplicate (see below) |
| `413` | Body larger than 1 MB |
| `500` | Something broke, including a write that did not reach disk |

- **Lists** all answer `{ "items": [...], "total": <n> }`, where `total` is
  the number of matches before `limit` / `offset` cut the page. `limit`
  defaults to **200** and is capped at **1000** (asking for more returns
  1000; `0` or a non-number is a `400`). `/films`, `/shows`, `/books` and
  `/audiobooks` also take `offset` (default `0`) to page through the rest.
- **Deletes** answer `200` with `{ "deleted": true, "id": "<id>" }`.
- **Duplicates** are a `409`, within one collection: a film, show, book or
  audiobook whose title matches an existing one in that collection (trimmed,
  any case), and for films and shows also one with the same TMDB id. The same
  name in two collections — a film and a show both called *Fargo* — is
  fine. A remake that shares a film's name needs a title that tells them
  apart (*Dune (2021)*).

### What counts as what

- **Film**: a title watched in one sitting (TMDB says movie, or the type is
  *Movie*, or it has a single episode).
- **Show**: every other title — TV, anime, mini-series, documentaries.
- **Audiobook**: a book whose `format` is `"audiobook"`. Progress is in
  minutes (`listenedMinutes` / `totalMinutes`).
- **Book**: every other book. `/books` and `/audiobooks` never overlap.
- Manga and games are not served by the API.

Ids are the plugin's own ids (the slug the title or book was created with, e.g.
`the-matrix`), as returned by every list, `/search`, `/lookup` and `/items`.
URL-encode as usual.

## Routes

| Method + path | What it does |
| --- | --- |
| `GET /health` | `{ ok, version, ready, revision, counts: { films, shows, books, audiobooks } }` |
| `GET /films` | List films, most recently modified first. Filters: `status`, `type`, `q` (title substring), `limit`, `offset` |
| `POST /films` | Add a film. Body: `title` (required), plus any of the `PATCH` fields → `201` |
| `GET /films/:id` | One film |
| `PATCH /films/:id` | Update: `title`, `type`, `status`, `rating`, `review`, `watchedVia`, `favorite`, `tags`, `notes`, `year`, `dates`, `ids` |
| `DELETE /films/:id` | Remove the film → `{ deleted: true, id }` |
| `POST /films/:id/watched` | Log it as watched. Body (all optional): `date` (`YYYY-MM-DD`, default today), `rating`, `review`, `watchedVia` |
| `GET /shows` | List shows. Same filters as `/films` |
| `POST /shows` | Add a show. Body: `title` (required), `seasons` or `totalEpisodes`, plus any of the `PATCH` fields → `201` |
| `GET /shows/:id` | One show |
| `PATCH /shows/:id` | Update; same fields as a film |
| `DELETE /shows/:id` | Remove the show → `{ deleted: true, id }` |
| `GET /shows/:id/progress` | The show's status and its watched / total episode counts, overall and per season |
| `POST /shows/:id/episodes` | Mark one episode. Body: `{ season, episode, watched }` or `{ absolute, watched }` (`watched` defaults to `true`) |
| `POST /shows/:id/seasons/:n` | Mark every non-skipped episode of season `n`. Body: `{ watched }` |
| `POST /shows/:id/watched` | Log the whole show as watched. Body as for a film |
| `GET /books` | List books (never audiobooks), most recently modified first. Filters: `status`, `limit`, `offset` |
| `POST /books` | Add a book. Body: `title` (required), `author`, `status`, `rating`, `favorite`, `categories`, `coverUrl`, `externalLink`, `dates`, `review`, `googleBooksId`, `openLibraryKey`, progress counters → `201` |
| `GET /books/:id` | One book |
| `PATCH /books/:id` | Update any of the `POST` fields |
| `DELETE /books/:id` | Remove the book → `{ deleted: true, id }` |
| `POST /books/:id/read` | Log it as read. Body (all optional): `date` (default today), `rating`, `review`, `progress` |
| `GET /audiobooks` | List audiobooks, most recently modified first. Filters: `status`, `limit`, `offset` |
| `POST /audiobooks` | Add an audiobook. As `POST /books`, with `listenedMinutes` / `totalMinutes` as the progress → `201` |
| `GET /audiobooks/:id` | One audiobook |
| `PATCH /audiobooks/:id` | Update any of the `POST` fields |
| `DELETE /audiobooks/:id` | Remove the audiobook → `{ deleted: true, id }` |
| `POST /audiobooks/:id/read` | Log it as listened to. Body as for a book; `progress` is in minutes |
| `GET /search` | Title search across films, shows, books and audiobooks. `q` (required), `kind`, `limit`. See below |
| `GET /lookup` | Find items by external id. See below |
| `GET /items` | One flat list across every kind, filtered by kind, status and a date range. See below |

### Request bodies in detail

- **Log watched** (`POST /films/:id/watched`, `POST /shows/:id/watched`):
  `{ "date": "2026-10-25", "rating": 4, "review": "Loved it", "watchedVia": "Cinema" }`.
  `rating` is 0–5 (half steps when half-star ratings are on); `review` and
  `watchedVia` must be one of the names configured in Settings.
  Logging a show as watched sets its status, dates, rating and so on; it does
  **not** tick its episodes. Mark those with `POST /shows/:id/seasons/:n` (a
  whole season) or `POST /shows/:id/episodes` (one episode), and read the
  result back with `GET /shows/:id/progress`.
- **`review` means two different things.** On a film or show it is one of the
  review labels configured in Settings (anything else is a `400`), and it is
  tied to the rating the way the stars and the review select are in the
  detail view. On a book or audiobook it is free text, stored on the book as
  it was sent; `null` or `""` clears it.
- **Log read** (`POST /books/:id/read`, `POST /audiobooks/:id/read`):
  `{ "date": "2026-10-25", "rating": 5, "review": "…", "progress": { … } }`.
  For a book, `progress` takes `pagesRead` / `totalPages`, `wordsRead` /
  `totalWords`, `chaptersRead` / `totalChapters` and `unit` (`pages` or
  `words`); for an audiobook, `listenedMinutes` / `totalMinutes`. `date`
  becomes the start date too when there is none, or when the one there is
  later than `date`, so a book is never started after it was finished.
- **Book status** is one of `Reading`, `Completed`, `Plan to Read`, `Dropped`
  or `To be released`, exactly as written; film and show statuses are the
  ones configured in Settings, matched in any case.
- **An unknown status is a `400`**, in a body and in a list filter alike
  (`status` on `/films`, `/shows`, `/books`, `/audiobooks` and `/items`). The
  error lists the valid names; a misspelt filter never quietly returns an
  empty list.
- **Episodes** (`POST /shows/:id/episodes`): `{ "season": 2, "episode": 5, "watched": true }`
  uses TMDB season numbering; `{ "absolute": 13, "watched": true }` counts
  from the first episode of the show. Marking a skipped or unaired episode is
  a `409`.
- **Open Library**: `openLibraryKey` is the work key as Open Library writes
  it, e.g. `"/works/OL893414W"`.

### Search, lookup and items

These three answer "what do I have?" across every kind at once. They are
read-only, and each match comes back in one small summary shape:

```json
{
  "kind": "film",
  "id": "the-matrix",
  "title": "The Matrix",
  "year": 1999,
  "status": "Watched",
  "rating": 5,
  "ids": { "tmdb": 603, "imdb": "tt0133093", "tvdb": null, "plexRatingKey": "1001" }
}
```

A book's `ids` are `{ "googleBooks": …, "openLibrary": … }` instead. Fetch the
full record from the matching domain route (`/films/:id`, `/books/:id`, …).

**`GET /search?q=&kind=&limit=`** → `{ items: [...], total }`. A
case-insensitive, accent-insensitive substring match on the title. An exact
title comes first, then titles that start with `q`, then the rest.

**`GET /lookup`** → `{ items: [...], total }`, every match, unpaged. Pass at least one of the parameters
below (none at all is a `400`); several widen the search rather than narrow it,
so a script can pass every GUID Plex gave it and take whatever comes back. An
id nobody has is `200` with an empty list, not a `404`.

| Parameter | Matches |
| --- | --- |
| `tmdb=603` | A title's TMDB id |
| `imdb=tt0133093` | A title's IMDb id |
| `tvdb=81189` | A title's TVDB id |
| `plexGuid=tmdb://603` | `tmdb://`, `imdb://` and `tvdb://` GUIDs, mapped onto the ids above. **`plex://` GUIDs are a `400`**: WRL does not store them, so use `plexRatingKey` or one of the external GUIDs instead |
| `plexRatingKey=1001` | The Plex item a title was last matched to |
| `openLibrary=/works/OL893414W` | A book's or audiobook's Open Library work key (the bare `OL893414W` works too) |
| `googleBooks=…` | A book's or audiobook's Google Books id |

**`GET /items?kind=&status=&from=&to=&dateField=&limit=`** → `{ items: [...], total }`.

- `kind`: `film`, `show`, `book` or `audiobook`; comma-separate for several.
- `status`: a status name, case-insensitive; comma-separate for several.
  Titles use the statuses configured in Settings (`Watching`, `Watched`, …),
  books use `Reading`, `Completed`, `Plan to Read`, `Dropped` and
  `To be released`. A name that none of the kinds asked for can have is a
  `400` listing the ones they can (`kind=book&status=Watching` is refused).
- `from` / `to`: `YYYY-MM-DD`, **both inclusive**. With a range, items that
  have no value in the chosen date field are left out.
- `dateField`: `dateFinished` (default), `dateStarted`, `dateAdded` or
  `dateModified`. The last two are timestamps and are compared on the local
  calendar day.
- Sorted newest first on `dateField`, undated items last.

**Order.** `/films`, `/shows`, `/books` and `/audiobooks` put the most recently
modified first (ties by id), so whatever a caller just changed is on page one.
`/search` ranks by relevance (above), `/items` by its `dateField`, and
`/lookup` keeps library order. `limit` works as on every list.

## Examples

```sh
TOKEN=…   # Settings → Local API → Copy token
BASE=http://127.0.0.1:27129/wrl/v1
# From another device on your tailnet, use the Mac's Tailscale address instead:
# BASE=http://100.x.y.z:27129/wrl/v1

curl -s $BASE/health -H "Authorization: Bearer $TOKEN"

# Is this Plex item already in the library?
curl -s "$BASE/lookup?plexGuid=tmdb://603" -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/lookup?plexRatingKey=1001" -H "Authorization: Bearer $TOKEN"

# Everything finished in January, books included
curl -s "$BASE/items?from=2026-01-01&to=2026-01-31" -H "Authorization: Bearer $TOKEN"

# Shows started this year that I am still watching
curl -s "$BASE/items?kind=show&status=Watching&dateField=dateStarted&from=2026-01-01" \
  -H "Authorization: Bearer $TOKEN"

# Find a title
curl -s "$BASE/search?q=matrix" -H "Authorization: Bearer $TOKEN"

# Log tonight's film
curl -s -X POST "$BASE/films/the-matrix/watched" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rating": 5, "watchedVia": "Plex"}'

# Tick off S02E05
curl -s -X POST "$BASE/shows/breaking-bad/episodes" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"season": 2, "episode": 5, "watched": true}'

# Mark the whole of season 3 as watched
curl -s -X POST "$BASE/shows/breaking-bad/seasons/3" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"watched": true}'

# An hour more of the audiobook
curl -s -X PATCH "$BASE/audiobooks/project-hail-mary" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"listenedMinutes": 180, "totalMinutes": 970}'

# Finished a book
curl -s -X POST "$BASE/books/dune/read" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"date": "2026-10-25", "rating": 4, "review": "The spice must flow"}'

# Writing from another device needs "Allow writes from other devices";
# without it this is a 403:
curl -s -X POST "http://100.x.y.z:27129/wrl/v1/films/the-matrix/watched" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

**HTTPS with `tailscale serve`.** Some clients (iOS Shortcuts with App
Transport Security, browsers) prefer TLS. Leave the API on *This Mac only* and
let Tailscale terminate HTTPS in front of it:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:27129
tailscale serve status
tailscale serve reset     # stop
```

The API is then at `https://<mac-name>.<tailnet>.ts.net/wrl/v1`, reachable
from your tailnet only (unlike `tailscale funnel`, which is public). Requests
proxied this way arrive from loopback, so they count as *this Mac* for the
write rule — only share the tailnet with devices you trust to write.

## Source

- `src/api/server.ts` — plumbing: bind, auth, body limit, `x-wrl-revision`,
  the remote-write rule.
- `src/api/addresses.ts` — the bind plan and loopback/Tailscale detection.
- `src/api/auth.ts` — token generation and comparison.
- `src/api/revision.ts` — the revision counter.
- `src/api/router.ts` — `GET /health` and dispatch to the route modules.
- `src/api/types.ts` — the contract every route module is written against.
- `src/api/routes/titles.ts` — `/films` and `/shows`.
- `src/api/routes/reading.ts` — `/books` and `/audiobooks`.
- `src/api/routes/search.ts` — `/search`, `/lookup` and `/items`.
- `tests/api-e2e.test.ts` — every route in the table above against a real
  server and store, including a check that this table and the routers agree
  and that a write never loses a key it did not mean to change.
- `src/api/query.ts` — query-string parsing shared by the list routes
  (`limit`, dates, `kind`, `status`, Plex GUIDs).
