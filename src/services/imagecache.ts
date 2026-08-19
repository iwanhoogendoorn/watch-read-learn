/**
 * Optional local copies of poster and cover art, so a library opened on a plane
 * still has pictures in it.
 *
 * Everything here is **off unless the user turns it on**: it writes files into
 * their vault, which is the one thing this plugin is otherwise careful never to
 * do without being asked.
 *
 * Three properties it has to have, because it sits underneath the render path:
 *
 *   - **Lookup is synchronous.** `resolve()` answers from an in-memory index of
 *     what is on disk, primed once at startup. A card asking "do I have this
 *     locally?" must never await, and must never be the thing that starts a
 *     download — that is `ensure()`'s job, called from outside the paint.
 *   - **It cannot break rendering.** Every method swallows its own failures and
 *     answers `""`, which every caller reads as "use the remote URL". A dead
 *     CDN, a full disk and a read-only vault all degrade to today's behaviour.
 *   - **A failed write leaves nothing behind.** Bytes land in a *hidden* staging
 *     sibling and are moved into place, so a download that dies halfway can
 *     never leave a truncated JPEG at a path the index would then trust — and
 *     the staging file is dot-prefixed so Obsidian Sync never sees it at all.
 *
 * Deletion is never automatic. `findOrphans()` reports what is no longer
 * referenced and `purge()` removes exactly the paths it is handed — the user
 * asks, or nothing happens.
 *
 * WHERE THE INDEX LIVES
 * ---------------------
 * Nowhere. There is deliberately no "this poster is cached at X" field on
 * `TitleV4`, no key in `data.json`, and — emphatically — nothing in note
 * frontmatter, which `data/notes.ts` regenerates on every sync and would
 * silently erase.
 *
 * It does not need one: a filename is a pure function of `(scope, id, url)`, so
 * the folder listing *is* the index, rebuilt by `prime()` at startup. That is
 * stronger than persisting it. There is no second copy to drift from the disk,
 * nothing to migrate, and a user who deletes files in Finder is immediately
 * correct rather than leaving the plugin pointing at art that is gone.
 */
import { defaultHttp, type HttpFn } from "./http";
import type { ApiSource } from "../types";

/**
 * The slice of `app.vault.adapter` this needs.
 *
 * Declared structurally rather than as Obsidian's `DataAdapter` so tests can
 * hand over a plain object and so nothing here depends on the Obsidian runtime.
 * `_AdapterFits` below is the compile-time proof that the real adapter still
 * satisfies it.
 */
export interface ImageCacheAdapter {
  exists(path: string): Promise<boolean>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove(path: string): Promise<void>;
  getResourcePath(path: string): string;
  /** Optional: not every stand-in has it, and a write-plus-delete is a fine fallback. */
  rename?(from: string, to: string): Promise<void>;
}

/** Fails `npx tsc --noEmit` the day `app.vault.adapter` stops fitting. */
type Assert<T extends true> = T;
export type VaultAdapterFits = Assert<
  import("obsidian").DataAdapter extends ImageCacheAdapter ? true : false
>;

/** Where images go when the user has not said otherwise. */
export const DEFAULT_IMAGE_CACHE_FOLDER = "WRL/images";

/**
 * Staging name, mirroring `data/backup.ts`. Cleaned up on success and failure.
 *
 * **The leading dot is not cosmetic.** Obsidian treats a dot-prefixed path as
 * hidden — it is not a vault file, so nothing indexes it and Obsidian Sync does
 * not queue it. Without the dot, Sync sees `poster.jpg.writing.tmp` appear, gets
 * as far as opening it, and by then the rename has already moved it away:
 *
 *     Sync Error! {"errno":-2,"code":"ENOENT","syscall":"open",
 *                  "path":".../title-the-odyssey-124gttg1yxhgr4.jpg.writing.tmp"}
 *
 * — one per image, so a first run over a real library is a wall of them.
 *
 * The staging step itself stays: it is the only thing standing between a
 * process killed mid-write and a truncated JPEG sitting at a path that
 * `prime()` would afterwards trust forever. A crash now leaves a hidden
 * `.name.writing.tmp` that priming skips and `findOrphans` offers to the user.
 */
const TEMP_SUFFIX = ".writing.tmp";
const TEMP_PREFIX = ".";

/** Is this a staging leftover rather than a cached image? Both schemes count. */
function isTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX) || name.endsWith(TEMP_SUFFIX);
}

/** The name a staging file was on its way to becoming. Tolerates either scheme. */
function finalNameOfTemp(name: string): string {
  const withoutPrefix = name.startsWith(TEMP_PREFIX) ? name.slice(TEMP_PREFIX.length) : name;
  return withoutPrefix.endsWith(TEMP_SUFFIX)
    ? withoutPrefix.slice(0, -TEMP_SUFFIX.length)
    : withoutPrefix;
}

/**
 * Extensions we are willing to write. Anything else — including whatever a
 * provider happens to put after the last dot — becomes `jpg`, because the
 * filename is ours to choose and a poster is a poster.
 */
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

/** A poster over this is not a poster. Guards against a mis-routed download. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** How many downloads run at once during a warm pass. Politeness, not throughput. */
const DEFAULT_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Pure helpers — the naming rules, tested directly
// ---------------------------------------------------------------------------

/**
 * A folder path with every way out of it removed.
 *
 * `..`, `.`, leading slashes, backslashes and empty segments all disappear, so
 * a setting of `../../../.ssh` normalises to `ssh` rather than escaping the
 * vault. An input that survives as nothing falls back to the default.
 */
export function normalizeCacheFolder(raw: string): string {
  const parts = raw
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "." && part !== "..")
    // Characters no filesystem wants, stripped rather than rejected. Spaces and
    // hyphens stay: `Media/Poster Art` is a reasonable thing to type. A trailing
    // dot goes too, because Windows silently drops it, which would desync the
    // index from the folder that actually got created.
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/\.+$/, "").trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? DEFAULT_IMAGE_CACHE_FOLDER : parts.join("/");
}

/**
 * 32-bit FNV-1a. Two of them at different seeds make the fingerprint below,
 * which is what stops two titles from ever sharing a file.
 */
function hash32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** ~64 bits of "these inputs are not those inputs", in base 36. */
function fingerprint(parts: readonly string[]): string {
  const joined = parts.join("\u0000");
  const a = hash32(joined, 2166136261).toString(36);
  const b = hash32(joined, 0x9e3779b9).toString(36);
  return `${a.padStart(7, "0")}${b.padStart(7, "0")}`;
}

/**
 * The readable half of the filename. Lossy on purpose: it exists so a human
 * scrolling the folder can tell what they are looking at, and the fingerprint
 * is what carries the uniqueness.
 */
function slugify(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug === "" ? "img" : slug;
}

/** The extension to write, taken from the URL's path and then distrusted. */
export function extensionForUrl(url: string): string {
  const path = url.split(/[?#]/)[0] ?? "";
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return "jpg";
  const ext = last.slice(dot + 1).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) ? ext : "jpg";
}

/**
 * What a cached image belongs to.
 *
 * **The scope is not optional and not decoration.** This plugin talks to TMDB,
 * Open Library, Google Books, IGDB, AniList and Steam, and their id spaces
 * overlap: Open Library id `12345` and TMDB id `12345` are different things.
 * Keying a file on a bare id would eventually serve a book cover as a film
 * poster. Scope plus id is what makes the pair unique across all of them.
 */
export interface ImageKey {
  /** The family this id lives in — `title`, `book`, `game`, `person`. */
  scope: string;
  /** Stable id within that scope: a `TitleV4.id`, a book key, a game id. */
  id: string;
}

/** The scopes in use. A new domain adds one rather than reusing another's. */
export const IMAGE_SCOPE = {
  title: "title",
  book: "book",
  game: "game",
  person: "person",
} as const;

/**
 * The file a `(key, url)` pair maps to. Deterministic, and containing no
 * separator of any kind, so it can only ever name a child of the cache folder.
 *
 * Both halves of the key go into the fingerprint, so no amount of id collision
 * between two providers can produce one filename — and the readable prefix
 * carries the scope too, so a glance at the folder says which domain a file
 * belongs to.
 *
 * The URL is in the fingerprint deliberately: when a user pastes a new
 * `manualPosterUrl`, the name changes, the old file stops being referenced, and
 * the new art is fetched — rather than the stale copy being served forever.
 */
export function cacheFileName(key: ImageKey, url: string): string {
  const scope = key.scope.trim();
  const id = key.id.trim();
  const trimmedUrl = url.trim();
  if (scope === "" || id === "" || trimmedUrl === "") return "";
  const stamp = fingerprint([scope, id, trimmedUrl]);
  return `${slugify(scope)}-${slugify(id)}-${stamp}.${extensionForUrl(trimmedUrl)}`;
}

/** Only real remote images are ever fetched — no `file:`, `data:` or `app:`. */
function isFetchableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A resource path we are willing to hand to an `<img src>`.
 *
 * The one shape that must be rejected is a bare vault path: `resolvePosterUrl`
 * treats a leading `/` as a TMDB poster path and would rewrite it into a CDN
 * URL. Every real `getResourcePath` answer is an absolute `app://`-style URL.
 */
function isUsableResourceUrl(url: string): boolean {
  return url !== "" && !url.startsWith("/");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ImageCacheOptions {
  adapter: ImageCacheAdapter;
  /** Off unless the user opted in. */
  enabled?: boolean;
  /** Vault-relative folder; normalised, never trusted. */
  folder?: string;
  /** Injected so tests never reach the network. Defaults to the real transport. */
  http?: HttpFn;
  /**
   * Override how bytes are obtained for a URL. Return `null` to mean "no image".
   *
   * The reason this exists: `domains/reading/covers.ts` fetches Open Library
   * covers through the rate-limited client on purpose — covers count against
   * the same limit as the API, and an `<img src>` straight at the CDN carries
   * none of our headers and passes through none of our limiter. A cache that
   * downloaded those with the raw transport would quietly break that contract.
   *
   * So the reading domain injects a fetcher that routes Open Library through
   * `OpenLibraryClient.coverBytes` and everything else through the default:
   * the cache sits *in front of* the polite path rather than around it.
   */
  fetchBytes?: (url: string) => Promise<ArrayBuffer | null>;
  /** Which provider failures are attributed to. Cosmetic — nothing surfaces them. */
  source?: ApiSource;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface CacheEntryRef {
  key: ImageKey;
  /** The fully resolved remote URL this item would otherwise hotlink. */
  url: string;
  /**
   * Where else the *same picture* can be got, in the order they should be tried.
   *
   * A fallback, not a second image: `warm` stops at the first one that works and
   * counts the entry once either way. Queueing them as separate entries — which
   * is what the reading domain used to do with its Google-by-ISBN fallback —
   * both fetches art nobody needs and reports "4 failed" on a run where the user
   * got every cover they asked for.
   *
   * `findOrphans` treats all of them as referenced, because any one of them may
   * be the file that actually landed.
   */
  alternates?: readonly string[];
  /**
   * Files in this folder the entry references **directly**, by path.
   *
   * For everything downloaded, the filename is a pure function of `(key, url)`
   * and `findOrphans` recomputes it — there is nothing to store. A cover the
   * user set from their own disk has no URL to recompute from: the file is the
   * original, and the entry knows it only by the path it was written to.
   *
   * `findOrphans` treats these as referenced. Without that, the one picture in
   * the folder the user chose deliberately would be the first thing the
   * "remove unreferenced artwork" button offered to delete. `warm` ignores
   * them — there is nothing to fetch.
   */
  paths?: readonly string[];
  /**
   * How this entry's bytes are obtained, when the default transport is the
   * wrong thing to use for it.
   *
   * The case it exists for: a warm pass over the reading shelves. Open Library
   * counts covers against the same rate limit as its API, so those must go
   * through `OpenLibraryClient.coverBytes` — identified, throttled — while the
   * posters in the same batch go through the ordinary transport. Per-entry
   * rather than per-cache, because one `ImageCache` serves every domain and a
   * single injected fetcher would have to know about all of them.
   *
   * Three answers, because one entry's candidates can need different transports:
   * bytes, `null` for "no image, try the next candidate", and `undefined` for
   * "not mine — use the default transport". Ignored by `findOrphans`, which only
   * needs names.
   */
  fetch?: (url: string) => Promise<ArrayBuffer | null | undefined>;
}

export interface WarmResult {
  /**
   * Images obtained this pass — **entries, not URLs**. An entry with a fallback
   * that succeeded on the second try counts once, here, not once here and once
   * under `failed`.
   */
  downloaded: number;
  /** Already on disk. */
  skipped: number;
  /** Entries where every candidate failed; these fall back to the remote URL. */
  failed: number;
}

export interface PurgeResult {
  removed: string[];
  failed: { path: string; error: string }[];
}

export interface ImageCacheStats {
  enabled: boolean;
  folder: string;
  /** Files the index knows about. `prime()` is what fills it. */
  files: number;
  primed: boolean;
}

export class ImageCache {
  private readonly adapter: ImageCacheAdapter;
  private readonly http: HttpFn;
  private readonly fetchBytes: ((url: string) => Promise<ArrayBuffer | null>) | undefined;
  private readonly source: ApiSource;
  private readonly maxBytes: number;
  private readonly timeoutMs: number | undefined;

  private enabled: boolean;
  private folder: string;

  /** Filenames known to exist on disk. The whole point of `resolve()` being sync. */
  private index = new Set<string>();
  /** In-flight downloads by filename, so a name is fetched once even under a burst. */
  private inFlight = new Map<string, Promise<string>>();
  /** Names that failed this session. Cleared by `clearFailures()`, never persisted. */
  private failures = new Set<string>();
  /**
   * Staging files `prime()` found — a write that was interrupted, most likely by
   * the app closing. Reported by `findOrphans` so the user can clear them; never
   * removed on their behalf.
   */
  private staleTemps = new Set<string>();
  private primed = false;

  constructor(options: ImageCacheOptions) {
    this.adapter = options.adapter;
    this.http = options.http ?? defaultHttp;
    this.fetchBytes = options.fetchBytes;
    this.source = options.source ?? "tmdb";
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs;
    this.enabled = options.enabled ?? false;
    this.folder = normalizeCacheFolder(options.folder ?? "");
  }

  // --- configuration ------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  getFolder(): string {
    return this.folder;
  }

  /**
   * Follow a settings change.
   *
   * Turning the feature off leaves every file exactly where it is — this is a
   * cache, not a lifecycle. The user removes them through `purge()` or not at
   * all. Pointing at a different folder drops the index, because what it
   * describes is no longer the folder being read.
   */
  configure(next: { enabled?: boolean; folder?: string }): void {
    if (next.enabled !== undefined) this.enabled = next.enabled;
    if (next.folder !== undefined) {
      const folder = normalizeCacheFolder(next.folder);
      if (folder !== this.folder) {
        this.folder = folder;
        this.index.clear();
        this.staleTemps.clear();
        this.failures.clear();
        this.primed = false;
      }
    }
  }

  /** A settings change or manual refresh — give every failed download another go. */
  clearFailures(): void {
    this.failures.clear();
  }

  stats(): ImageCacheStats {
    return { enabled: this.enabled, folder: this.folder, files: this.index.size, primed: this.primed };
  }

  // --- paths --------------------------------------------------------------

  /**
   * Vault path for a `(key, url)` pair, or `""` when there is not a safe one.
   *
   * The prefix check at the end is belt and braces: `cacheFileName` cannot
   * produce a separator, so this can only fire if that ever regresses.
   */
  pathFor(key: ImageKey, url: string): string {
    const name = cacheFileName(key, url);
    if (name === "") return "";
    const path = `${this.folder}/${name}`;
    return path.startsWith(`${this.folder}/`) && !name.includes("/") && !name.includes("\\")
      ? path
      : "";
  }

  /**
   * Where the bytes for `name` are staged before they are moved into place.
   *
   * A sibling of the final file — same folder, so the move is a rename rather
   * than a copy — but hidden, so Obsidian never treats it as a vault file and
   * Sync never tries to open the thing we are about to rename away.
   */
  private tempFor(name: string): string {
    return `${this.folder}/${TEMP_PREFIX}${name}${TEMP_SUFFIX}`;
  }

  /** Is this path inside the cache folder? The gate every removal passes. */
  ownsPath(path: string): boolean {
    const prefix = `${this.folder}/`;
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    return rest !== "" && !rest.includes("/") && !rest.includes("\\") && !rest.includes("..");
  }

  // --- reading ------------------------------------------------------------

  /**
   * Read the folder into the index. Call once at startup, after a folder change,
   * and after a purge.
   *
   * A missing folder is not an error — it is the normal state before the first
   * download. Nothing here throws.
   */
  async prime(): Promise<void> {
    if (!this.enabled) {
      this.primed = false;
      return;
    }
    const found = new Set<string>();
    const temps = new Set<string>();
    try {
      if (await this.adapter.exists(this.folder)) {
        const listed = await this.adapter.list(this.folder);
        for (const file of listed.files) {
          const name = file.slice(file.lastIndexOf("/") + 1);
          if (name === "") continue;
          // A staging file is never an image, whichever scheme wrote it. Half a
          // JPEG that got into the index would be a permanent broken cover.
          if (isTempName(name)) temps.add(name);
          else found.add(name);
        }
      }
    } catch {
      // An unreadable folder means "nothing cached", which is a working state.
      this.index.clear();
      this.staleTemps.clear();
      this.primed = false;
      return;
    }
    this.index = found;
    this.staleTemps = temps;
    this.primed = true;
  }

  /**
   * The `<img src>` for this item, synchronously: the local file when we have
   * one, `""` when we do not.
   *
   * Never touches the network, never awaits, never throws. `""` means "carry on
   * with the remote URL" — it is not an error.
   */
  resolve(key: ImageKey, url: string): string {
    if (!this.enabled) return "";
    const name = cacheFileName(key, url.trim());
    if (name === "" || !this.index.has(name)) return "";
    const path = this.pathFor(key, url.trim());
    if (path === "") return "";
    try {
      const resourceUrl = this.adapter.getResourcePath(path);
      return isUsableResourceUrl(resourceUrl) ? resourceUrl : "";
    } catch {
      return "";
    }
  }

  // --- writing ------------------------------------------------------------

  /**
   * Make sure this item is cached, downloading it if it is not.
   *
   * Resolves to the vault path on success and `""` on every failure — disabled,
   * unfetchable URL, dead CDN, unwritable vault. Safe to call unconditionally
   * and safe to call concurrently: the same filename is only ever fetched once.
   */
  async ensure(key: ImageKey, url: string, fetch?: CacheEntryRef["fetch"]): Promise<string> {
    if (!this.enabled) return "";
    const remote = url.trim();
    if (!isFetchableUrl(remote)) return "";

    const name = cacheFileName(key, remote);
    if (name === "") return "";
    if (this.index.has(name)) return `${this.folder}/${name}`;
    if (this.failures.has(name)) return "";

    const running = this.inFlight.get(name);
    if (running) return running;

    const path = this.pathFor(key, remote);
    if (path === "") return "";

    const job = this.download(name, path, remote, fetch);
    this.inFlight.set(name, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(name);
    }
  }

  /**
   * Keep bytes the caller has **already** fetched.
   *
   * The reading domain never hands this a URL to download: Open Library counts
   * cover requests against the same 3 req/s the API gets, so those bytes arrive
   * through `OpenLibraryClient.coverBytes` — rate-limited, identified, one
   * request — and this stores the copy. That is the politeness win rather than a
   * cost: a cover kept here is fetched exactly once ever instead of on every
   * render of the shelf it sits on.
   *
   * Same guarantees as `ensure`: `""` on every failure, never throws, and a
   * name that is already on disk is not written twice.
   */
  async store(key: ImageKey, url: string, bytes: ArrayBuffer): Promise<string> {
    if (!this.enabled) return "";
    const remote = url.trim();
    if (!isFetchableUrl(remote)) return "";
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) return "";

    const name = cacheFileName(key, remote);
    if (name === "") return "";
    if (this.index.has(name)) return `${this.folder}/${name}`;
    if (this.failures.has(name)) return "";

    const running = this.inFlight.get(name);
    if (running) return running;

    const path = this.pathFor(key, remote);
    if (path === "") return "";

    const job = this.keep(name, path, bytes);
    this.inFlight.set(name, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(name);
    }
  }

  /**
   * Keep an image the **user** handed over — a cover they picked off their own
   * disk because no catalogue has one.
   *
   * Three things separate this from `store()`, and all three are the point:
   *
   *   - **It ignores the on/off setting.** Everything else here is a cache: a
   *     convenience whose absence costs a round trip. This file is the only
   *     copy of a picture that exists nowhere else, written because the user
   *     asked for it in as many words. Refusing because a *caching* preference
   *     is off would be a bug, not a policy.
   *   - **There is no URL.** `seed` is not fetched and never will be; it exists
   *     only so `cacheFileName` can name the file, so a hand-set cover is
   *     indexed, listed and purgeable exactly like a downloaded one instead of
   *     needing a folder convention of its own.
   *   - **The caller keeps the path.** It goes on the book, and that is what
   *     `CacheEntryRef.paths` hands back to `findOrphans` so this file is never
   *     mistaken for rubbish.
   *
   * Same failure discipline as everything else: `""` on any failure, never
   * throws, staging file cleaned up. Size is capped by the same `maxBytes`.
   */
  async adopt(key: ImageKey, seed: string, bytes: ArrayBuffer): Promise<string> {
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) return "";
    const name = cacheFileName(key, seed.trim());
    if (name === "") return "";
    const path = this.pathFor(key, seed.trim());
    if (path === "") return "";
    try {
      return await this.persist(name, path, bytes);
    } catch {
      await this.removeQuietly(this.tempFor(name));
      return "";
    }
  }

  /**
   * The `<img src>` for a file in this folder, named by path.
   *
   * Not `resolve()`: that answers `""` while the cache is switched off, which
   * is right for a cached copy of something remote and wrong for the only copy
   * of a picture the user chose. A path outside the folder is refused rather
   * than resolved, so this can never be talked into exposing the rest of the
   * vault as an image.
   */
  resourcePath(path: string): string {
    if (!this.ownsPath(path)) return "";
    // Once the folder has been listed we know exactly what is in it, so a file
    // that has since been deleted in Finder answers `""` and the caller falls
    // back to whatever else it has — a broken `<img>` is worse than a
    // placeholder. Unprimed, which is the state while artwork caching is off,
    // nothing has listed the folder: the path the user's own action wrote is
    // then the best answer there is, and refusing it would be a guess.
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (this.primed && !this.index.has(name)) return "";
    try {
      const url = this.adapter.getResourcePath(path);
      return isUsableResourceUrl(url) ? url : "";
    } catch {
      return "";
    }
  }

  /**
   * Cache a batch, a few at a time.
   *
   * The pass a "download missing artwork" command runs. Bounded concurrency
   * because a first run on a large library is otherwise several hundred
   * simultaneous requests to one CDN.
   *
   * **The counts describe images, not attempts.** One entry contributes exactly
   * one to one of the three numbers, whichever of its candidates it took, so
   * "downloaded 21, 4 failed" can only mean four covers the user did not get.
   */
  async warm(
    entries: Iterable<CacheEntryRef>,
    options: { concurrency?: number } = {},
  ): Promise<WarmResult> {
    const result: WarmResult = { downloaded: 0, skipped: 0, failed: 0 };
    if (!this.enabled) return result;

    const queue: { key: ImageKey; urls: string[]; fetch: CacheEntryRef["fetch"] }[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      // Every URL this entry could legitimately be satisfied by, in order.
      const urls: string[] = [];
      const names: string[] = [];
      for (const raw of [entry.url, ...(entry.alternates ?? [])]) {
        const remote = raw.trim();
        if (!isFetchableUrl(remote)) continue;
        const name = cacheFileName(entry.key, remote);
        if (name === "" || names.includes(name)) continue;
        urls.push(remote);
        names.push(name);
      }
      if (names.length === 0) continue;
      // Another entry already covers this file.
      if (names.some((name) => seen.has(name))) continue;
      for (const name of names) seen.add(name);
      // Any candidate already on disk means this image is had. Asking for the
      // others would be fetching a fallback for something that never fell back.
      if (names.some((name) => this.index.has(name))) {
        result.skipped += 1;
        continue;
      }
      queue.push({ key: entry.key, urls, fetch: entry.fetch });
    }

    const width = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = queue[next];
        next += 1;
        if (!entry) return;
        let got = "";
        for (const url of entry.urls) {
          got = await this.ensure(entry.key, url, entry.fetch);
          if (got !== "") break;
        }
        if (got === "") result.failed += 1;
        else result.downloaded += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
    return result;
  }

  /**
   * Fetch, stage, move. Never throws, never leaves a partial file, and only
   * touches the index once the bytes are at their final path.
   */
  private async download(
    name: string,
    path: string,
    url: string,
    fetch?: CacheEntryRef["fetch"],
  ): Promise<string> {
    try {
      // A previous session may have written this before the index was primed.
      // Cheaper than a download and, crucially, not a network call.
      if (await this.adapter.exists(path)) {
        this.index.add(name);
        return path;
      }

      // An entry's own fetcher may answer `undefined` for "not mine" — a book's
      // Google fallback in a batch whose Open Library half needs the client.
      const own = fetch ? await fetch(url) : undefined;
      const bytes = own === undefined ? await this.fetch(url) : own;
      if (!bytes || bytes.byteLength === 0) throw new Error("empty image body");
      if (bytes.byteLength > this.maxBytes) {
        throw new Error(`image is ${bytes.byteLength} bytes, over the ${this.maxBytes} limit`);
      }

      return await this.persist(name, path, bytes);
    } catch (err) {
      // Remember the miss so a broken URL is not re-fetched on every warm pass,
      // and make sure nothing half-written survives.
      this.failures.add(name);
      await this.removeQuietly(this.tempFor(name));
      return "";
    }
  }

  /** `download` without the download: the write half, for bytes we were handed. */
  private async keep(name: string, path: string, bytes: ArrayBuffer): Promise<string> {
    try {
      if (await this.adapter.exists(path)) {
        this.index.add(name);
        return path;
      }
      return await this.persist(name, path, bytes);
    } catch {
      this.failures.add(name);
      await this.removeQuietly(this.tempFor(name));
      return "";
    }
  }

  /**
   * Stage, move, index — the write both paths share. Throws on failure so the
   * caller does the cleanup in one place.
   */
  private async persist(name: string, path: string, bytes: ArrayBuffer): Promise<string> {
    const temp = this.tempFor(name);
    await this.ensureFolder();
    await this.adapter.writeBinary(temp, bytes);
    await this.moveIntoPlace(temp, path, bytes);
    this.index.add(name);
    return path;
  }

  /**
   * The bytes for a URL: the injected fetcher when there is one, otherwise the
   * plugin's own HTTP wrapper. Never `fetch`, and never a second transport.
   */
  private async fetch(url: string): Promise<ArrayBuffer | null> {
    if (this.fetchBytes) return this.fetchBytes(url);
    const response = await this.http<unknown>({
      url,
      source: this.source,
      binary: true,
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    });
    return response.bytes ?? null;
  }

  /** `rename` when the adapter has it, a direct write plus cleanup when it does not. */
  private async moveIntoPlace(temp: string, path: string, bytes: ArrayBuffer): Promise<void> {
    const rename = this.adapter.rename?.bind(this.adapter);
    if (rename) {
      await rename(temp, path);
      return;
    }
    await this.adapter.writeBinary(path, bytes);
    await this.removeQuietly(temp);
  }

  /** Create the folder chain a segment at a time; an existing folder is not an error. */
  private async ensureFolder(): Promise<void> {
    const segments = this.folder.split("/");
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      try {
        if (!(await this.adapter.exists(prefix))) await this.adapter.mkdir(prefix);
      } catch {
        // Concurrent creation, or a folder that is already there. Either way the
        // write that follows is the real test.
      }
    }
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    } catch {
      // A leftover staging file is untidy, never dangerous.
    }
  }

  // --- cleanup ------------------------------------------------------------

  /**
   * Cached files nothing references any more.
   *
   * Deleting a title, or replacing its poster URL, strands whatever was
   * downloaded for it. This reports those paths; it does **not** remove them.
   * The caller shows the list, the user decides, and `purge()` acts.
   *
   * Requires a primed index — an unprimed one knows about no files, so the
   * honest answer is an empty list rather than a guess.
   *
   * **`live` must cover every domain that caches art.** A caller that passes
   * only its titles will be told every book cover is unreferenced and will
   * offer to delete all of them — combine `posterCacheEntries` with
   * `readingCacheEntries` rather than picking one.
   *
   * Staging leftovers from an interrupted write are listed too: they are files
   * this plugin made and nothing will ever read, and this is the one route by
   * which anything here is removed — a user pressing the button.
   */
  findOrphans(live: Iterable<CacheEntryRef>): string[] {
    const referenced = new Set<string>();
    for (const entry of live) {
      // Every candidate, not just the primary: the file on disk may be the
      // fallback that was taken when the primary had no image.
      for (const raw of [entry.url, ...(entry.alternates ?? [])]) {
        const name = cacheFileName(entry.key, raw.trim());
        if (name !== "") referenced.add(name);
      }
      // Files named by path rather than by URL — a cover the user set by hand.
      for (const raw of entry.paths ?? []) {
        const path = raw.trim();
        if (this.ownsPath(path)) referenced.add(path.slice(path.lastIndexOf("/") + 1));
      }
    }
    const orphans: string[] = [];
    for (const name of this.index) {
      if (!referenced.has(name)) orphans.push(`${this.folder}/${name}`);
    }
    for (const name of this.staleTemps) {
      // Not one that is being written right now: that download would then fail
      // for no reason. `inFlight` is keyed on the final name.
      if (!this.inFlight.has(finalNameOfTemp(name))) orphans.push(`${this.folder}/${name}`);
    }
    return orphans.sort();
  }

  /**
   * Remove exactly these paths. **Only ever call this from an explicit user
   * action** — nothing in this module invokes it on its own.
   *
   * A path outside the cache folder is refused rather than removed, so a caller
   * that hands over a bad list cannot delete a user's notes with it.
   */
  async purge(paths: Iterable<string>): Promise<PurgeResult> {
    const result: PurgeResult = { removed: [], failed: [] };
    for (const path of paths) {
      if (!this.ownsPath(path)) {
        result.failed.push({ path, error: "outside the image cache folder" });
        continue;
      }
      try {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
        const name = path.slice(path.lastIndexOf("/") + 1);
        this.index.delete(name);
        this.staleTemps.delete(name);
        result.removed.push(path);
      } catch (err) {
        result.failed.push({ path, error: message(err) });
      }
    }
    return result;
  }
}

/** The usual construction. Kept as a function so callers need not import the class. */
export function createImageCache(options: ImageCacheOptions): ImageCache {
  return new ImageCache(options);
}
