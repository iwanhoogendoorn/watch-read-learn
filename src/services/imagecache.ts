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
 *   - **A failed write leaves nothing behind.** Bytes land in a staging sibling
 *     and are moved into place, so a download that dies halfway can never leave
 *     a truncated JPEG at a path the index would then trust.
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
export const DEFAULT_IMAGE_CACHE_FOLDER = "WatchLog/images";

/** Staging suffix, mirroring `data/backup.ts`. Cleaned up on success and failure. */
const TEMP_SUFFIX = ".writing.tmp";

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
}

export interface WarmResult {
  /** Newly downloaded this pass. */
  downloaded: number;
  /** Already on disk. */
  skipped: number;
  /** Tried and failed; these fall back to the remote URL. */
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
    try {
      if (await this.adapter.exists(this.folder)) {
        const listed = await this.adapter.list(this.folder);
        for (const file of listed.files) {
          const name = file.slice(file.lastIndexOf("/") + 1);
          if (name !== "" && !name.endsWith(TEMP_SUFFIX)) found.add(name);
        }
      }
    } catch {
      // An unreadable folder means "nothing cached", which is a working state.
      this.index.clear();
      this.primed = false;
      return;
    }
    this.index = found;
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
  async ensure(key: ImageKey, url: string): Promise<string> {
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

    const job = this.download(name, path, remote);
    this.inFlight.set(name, job);
    try {
      return await job;
    } finally {
      this.inFlight.delete(name);
    }
  }

  /**
   * Cache a batch, a few at a time.
   *
   * The pass a "download missing artwork" command runs. Bounded concurrency
   * because a first run on a large library is otherwise several hundred
   * simultaneous requests to one CDN.
   */
  async warm(
    entries: Iterable<CacheEntryRef>,
    options: { concurrency?: number } = {},
  ): Promise<WarmResult> {
    const result: WarmResult = { downloaded: 0, skipped: 0, failed: 0 };
    if (!this.enabled) return result;

    const queue: CacheEntryRef[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const remote = entry.url.trim();
      if (!isFetchableUrl(remote)) continue;
      const name = cacheFileName(entry.key, remote);
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      if (this.index.has(name)) {
        result.skipped += 1;
        continue;
      }
      queue.push({ key: entry.key, url: remote });
    }

    const width = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = queue[next];
        next += 1;
        if (!entry) return;
        const path = await this.ensure(entry.key, entry.url);
        if (path === "") result.failed += 1;
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
  private async download(name: string, path: string, url: string): Promise<string> {
    const temp = `${path}${TEMP_SUFFIX}`;
    try {
      // A previous session may have written this before the index was primed.
      // Cheaper than a download and, crucially, not a network call.
      if (await this.adapter.exists(path)) {
        this.index.add(name);
        return path;
      }

      const bytes = await this.fetch(url);
      if (!bytes || bytes.byteLength === 0) throw new Error("empty image body");
      if (bytes.byteLength > this.maxBytes) {
        throw new Error(`image is ${bytes.byteLength} bytes, over the ${this.maxBytes} limit`);
      }

      await this.ensureFolder();
      await this.adapter.writeBinary(temp, bytes);
      await this.moveIntoPlace(temp, path, bytes);
      this.index.add(name);
      return path;
    } catch (err) {
      // Remember the miss so a broken URL is not re-fetched on every warm pass,
      // and make sure nothing half-written survives.
      this.failures.add(name);
      await this.removeQuietly(temp);
      return "";
    }
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
   */
  findOrphans(live: Iterable<CacheEntryRef>): string[] {
    const referenced = new Set<string>();
    for (const entry of live) {
      const name = cacheFileName(entry.key, entry.url.trim());
      if (name !== "") referenced.add(name);
    }
    const orphans: string[] = [];
    for (const name of this.index) {
      if (!referenced.has(name)) orphans.push(`${this.folder}/${name}`);
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
        this.index.delete(path.slice(path.lastIndexOf("/") + 1));
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
