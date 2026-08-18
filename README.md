# Watch, Read and Learn

An Obsidian plugin for the things you watch, read and play — films, TV, books,
manga and games in one library, wired into a home media stack.

- **An episode you have not seen yet cannot be ticked** — a show halfway
  through a season only lets you mark what has actually aired, and "mark season
  watched" stops at the last broadcast episode instead of quietly completing the
  show. It refuses only when it can point at a future date it actually holds, so
  a title with no air data behaves exactly as before, and un-ticking is always
  allowed — a guard that traps you in a mistake is worse than no guard.
- **Poster-forward cards** — the artwork is the card, with the caption on a
  blurred scrim that fades into it rather than a panel sitting on top of it.
  The scrim stays dark in both themes because it sits over a poster, not over
  the page.
- **People are places you can go** — open any actor or director for their
  biography, personal details and full filmography, and add anything from it to
  your library in one click. What you already own is marked as owned rather than
  offered again.
- **A title screen with room to breathe** — the detail view opens as a real
  workspace pane: poster, synopsis, time left and time watched, season
  accordions, and dates with a "Today" button beside each one. The compact modal
  is still there when you just want a quick look.
- **Bring your history with you** — import from Trakt (including the full ZIP
  export), Letterboxd, Simkl, IMDb and Ryot. Nothing is written until you have
  seen what will change, and merging into a title you already have never
  overwrites your own rating, review, notes or ticked episodes.
- **Layouts, not opinions** — Dashboard and Upcoming each ship a second, denser
  layout you can switch to from the toolbar, poster shelves you can turn on and
  off one by one, and a light/dark switch that drives Obsidian's own theme
  rather than a private one.
- **It keeps itself current** — an optional background sweep refreshes stale
  metadata across the whole library, skipping what cannot change (dropped
  titles, finished films) while still re-checking finished *shows*, because that
  is how a new season gets noticed.
- **Posters can live in your vault** — off by default; turn it on and artwork is
  cached locally so the library renders with no network at all.
- **Logging what you watched, in one go** — marking something finished asks
  the three things you know at that moment: when (defaulted to today), how good,
  and what you thought. A film gets one date rather than a start and an end,
  because a film is watched in an evening. Every date field has a calendar
  beside it, and there is a way back out: "Not watched" clears the status, the
  dates and every ticked episode in one move.
- **A rating and a review that are one judgement** — change either and the
  other follows, because "4 stars" and "Awesome" were always the same sentence
  twice. The two lists ship the same length so they line up one-for-one, and
  they are configurable, so the mapping is proportional rather than hardcoded.
- **Suggestions, both ways** — a "Suggested for you" panel built from what you
  already rated and finished, a **More like this** section inside any title or
  book, and a wizard for "I want a comedy, something like Ace Ventura". Nothing
  already in your library is ever suggested back, and "not interested" sticks.
- **Plex availability** — every film and show says whether it is already on your
  server, matched by GUID rather than by title.
- **The right studio** — a show reports the network it airs on, a film reports
  its production companies. TMDB sends both on a TV payload and the two are not
  spellings of one field.
- **IMDb, one click away** — when the title actually has an id. Never a search
  URL built from the name, which looks identical and is wrong often enough to
  matter; ids are backfilled from the provider, and from any IMDb link already
  pasted into a title.
- **Overseerr requests** — request something you do not have without leaving
  Obsidian, and watch the status come back (pending → approved → downloading →
  available). Nothing is ever requested without an explicit yes.
- **Upcoming** — one feed for the next episode, an announced season, a film's
  release, a book's publication date and a game's launch, with the same filter
  toolbar as everywhere else, an `.ics` export, and a per-row link that drops the
  thing straight into Google Calendar.
- **Books and manga** — Open Library and Google Books lookup, public ratings,
  store links, categories, and per-book progress that follows the page you are
  on in a linked PDF. Page counts are read out of the PDF itself when neither
  catalogue knows them, and book suggestions come from Open Library's subjects
  and authors — the closest thing books have to a recommendation graph.
- **Games** — IGDB metadata and optional Steam import, with playtime and
  achievements.
- **Anime as a first-class type** — routed to AniList/Jikan instead of TMDB, so
  per-cour seasons and exact airing times are right.
- **Notes and code blocks** — a note per title, and a `watchlog` fence that
  renders live views of your library anywhere in the vault.
- **It follows your vault** — rename the folder your notes live in and every
  stored path moves with it, because Obsidian rewrites links but knows nothing
  about a plugin's own JSON.

Everything is optional: with no API keys at all it is a perfectly good manual
tracker. Keys unlock the automatic parts.

## Install via BRAT

1. Install [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) from the
   Community plugins browser and enable it.
2. In BRAT settings choose **Add beta plugin**, paste
   `https://github.com/iwanhoogendoorn/watch-read-learn`, pick the latest
   release, and confirm.
3. Enable **Watch, Read and Learn** in *Settings → Community plugins*.

BRAT installs from GitHub releases. Each release carries exactly the three
assets Obsidian needs — `main.js`, `manifest.json`, `styles.css` — published
automatically by [`release.yml`](.github/workflows/release.yml) when a version
tag is pushed.

### Coming from the old WatchLog plugin

The plugin's id changed with the rename, and Obsidian keys a plugin's data
folder off its id — so the first load looks empty. It is not. On startup it
looks for a previous install (`watchlog-v4`, then `watchlog`) and offers to
copy that `data.json` across. The old folder is only ever **read**: whichever
way you answer, the previous install stays intact and can be re-enabled.

Blocks you have already written as ` ```watchlog ` keep rendering, and
`obsidian://watchlog` links keep working. Both new spellings are registered
alongside them.

## Cutting a release

```
npm version minor        # bumps package.json, manifest.json, versions.json
git push && git push --tags
```

The tag must equal the manifest version with no leading `v` (`1.1.0`, not
`v1.1.0`).

Pushing the tag is all it takes:
[`release.yml`](.github/workflows/release.yml) checks that the tag matches the
manifest version, runs the test suite, builds, and attaches `main.js`,
`manifest.json` and `styles.css` to a GitHub release — the three files BRAT
installs.

## Commands

```
npm install
npm run build     # tsc --noEmit + esbuild -> build/{main.js,styles.css,manifest.json}
npm test          # vitest, no network
npm run dev       # esbuild watch
node scripts/deploy.mjs "/path/to/Vault"
```

## Layout

```
src/
  main.ts        plugin entry, view registration, ribbon, commands
  settings.ts    settings tab
  types.ts       FROZEN cross-module contract — read the header before editing
  constants.ts
  data/          schema · migrate · backup · adopt · paths · review · store · episodes ·
                 notes · aired (has this episode happened yet — the store asks, not the grid)
  services/      http (requestUrl wrapper + ApiError taxonomy), providers,
                 airing, availability, suggest, sweep, imagecache, tmdb-person
  search/        query language, filters, sorting
  domains/       reading · games · anime · lists · drafts · csv · import · shelves · upcoming
  ui/            view shell, tabs, components, modals, theme,
                 views/  the workspace panes (title detail, person)
                 detail/ the controls both the pane and the modal render from
  widgets/       the code-fence renderer
styles/          numbered partials, concatenated into build/styles.css
tests/           vitest, no network
scripts/         deploy.mjs and the smoke harnesses
```

## Three rules that matter more than they look

**Never rebuild `WatchLogData`, `Settings` or a `TitleV4` from an object
literal.** Keys the core does not own — `reading`, `games`, `drafts`, `airtime`,
`omdbApiKey`, … — ride along on those objects invisibly to TypeScript, and
rebuilding drops them. Mutate in place or spread the existing object. The full
contract is in the header of `src/types.ts`.

**Zero hardcoded colours in CSS.** Every colour comes from an Obsidian CSS
variable or a `--wl-*` custom property set from settings. That is what makes
dark mode free.

**No class is declared in two style partials.** They are concatenated, so a
duplicate declaration is a silent override that only shows up in a real vault.
The smoke harness fails the build if one appears.

## Licence

MIT — see [LICENSE](LICENSE).
