# Watch, Read and Learn

An Obsidian plugin for the things you watch, read and play — films, TV, books,
manga and games in one library, wired into a home media stack.

- **Suggestions, both ways** — a "Suggested for you" panel built from what you
  already rated and finished, a **More like this** section inside any title or
  book, and a wizard for "I want a comedy, something like Ace Ventura". Nothing
  already in your library is ever suggested back, and "not interested" sticks.
- **Plex availability** — every film and show says whether it is already on your
  server, matched by GUID rather than by title.
- **Overseerr requests** — request something you do not have without leaving
  Obsidian, and watch the status come back (pending → approved → downloading →
  available). Nothing is ever requested without an explicit yes.
- **Upcoming** — one feed for the next episode, an announced season, a film's
  release, a book's publication date and a game's launch, with the same filter
  toolbar as everywhere else and an `.ics` export.
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
  data/          schema · migrate · backup · adopt · paths · store · episodes · notes
  services/      http (requestUrl wrapper + ApiError taxonomy), providers,
                 airing, availability, suggest
  search/        query language, filters, sorting
  domains/       reading · games · anime · lists · drafts · csv · upcoming
  ui/            view shell, tabs, components, modals
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
