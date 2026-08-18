/**
 * Lazy poster loading — **one** shared `IntersectionObserver` for the whole
 * plugin, plus a negative-result cache so a dead CDN URL is never retried.
 *
 * Ported from foodspot's photo subsystem (`report-foodspot.md` §4, convention 14).
 * The two failure modes it exists to prevent:
 *   - one observer per card, stranded when the grid re-renders;
 *   - a broken poster re-requested on every scroll pass.
 *
 * DOM-only, obsidian-free. The pure helpers at the bottom are what tests cover.
 */
import { TMDB_IMAGE_BASE, TMDB_POSTER_SIZE } from "../../constants";
import type { PosterLoader, TitleV4 } from "../../types";

/** URLs that failed to load. Module-level: survives re-renders, cleared on unload. */
const failedUrls = new Set<string>();

export function isPosterFailed(url: string): boolean {
  return failedUrls.has(url);
}

export function markPosterFailed(url: string): void {
  if (url) failedUrls.add(url);
}

/** Settings changed / manual refresh — give every dead URL one more chance. */
export function clearPosterFailures(): void {
  failedUrls.clear();
}

/**
 * The remote poster for a title: the user's override wins, then the API value.
 * `""` means "render the placeholder" — never the v3 `"none"` sentinel.
 *
 * This is the precedence rule on its own, with no cache in it, because the
 * cache is keyed on the URL this returns.
 */
export function posterSourceUrl(title: TitleV4): string {
  const manual = title.manualPosterUrl.trim();
  if (manual && manual !== "none") return manual;
  const api = title.posterUrl.trim();
  if (api && api !== "none") return api;
  return "";
}

/**
 * The read side of `services/imagecache.ts`, narrowed to what rendering needs.
 *
 * Declared here rather than imported so this module stays free of the service —
 * a lane with its own stand-in cache can satisfy this with four lines.
 */
export interface PosterCacheLookup {
  /** Vault resource URL for a cached image, or `""`. Must not await or throw. */
  resolve(key: { scope: string; id: string }, remoteUrl: string): string;
}

/**
 * The cache scope titles live in.
 *
 * Ids are only unique *within* a domain — this plugin also holds books, games
 * and people, and a bare id from one provider can equal a bare id from another.
 * Everything a poster hands the cache is qualified with this.
 */
export const POSTER_CACHE_SCOPE = "title";

/**
 * The poster a card should show.
 *
 * Without a cache this is exactly `posterSourceUrl` — the behaviour every
 * existing caller already has. With one, a locally cached copy is preferred,
 * and the precedence above is untouched by that: the cache is asked about the
 * URL that already won, so a `manualPosterUrl` still beats the API value, it
 * just gets served off disk.
 *
 * A cache that misses, misbehaves or throws falls back to the remote URL. This
 * runs inside the paint; it is not allowed to be the reason a library is blank.
 */
export function posterUrlFor(title: TitleV4, cache?: PosterCacheLookup): string {
  const source = posterSourceUrl(title);
  if (source === "" || !cache) return source;
  let local = "";
  try {
    local = cache.resolve({ scope: POSTER_CACHE_SCOPE, id: title.id }, resolvePosterUrl(source));
  } catch {
    local = "";
  }
  // A cached answer that looks like a bare vault path is discarded: the caller
  // pipes this through `resolvePosterUrl`, which would read a leading `/` as a
  // TMDB poster path and rewrite it into a CDN URL.
  return local !== "" && !local.startsWith("/") ? local : source;
}

/**
 * `(key, url)` pairs for a set of titles, ready for `ImageCache.warm()`.
 *
 * Titles with no poster at all are skipped, and the URL is fully resolved, so
 * what gets cached is the same string `posterUrlFor` will later look up.
 */
export function posterCacheEntries(
  titles: Iterable<TitleV4>,
): { key: { scope: string; id: string }; url: string }[] {
  const entries: { key: { scope: string; id: string }; url: string }[] = [];
  for (const title of titles) {
    const source = posterSourceUrl(title);
    if (source === "") continue;
    entries.push({ key: { scope: POSTER_CACHE_SCOPE, id: title.id }, url: resolvePosterUrl(source) });
  }
  return entries;
}

/** A bare TMDB poster path (`/abc.jpg`) becomes a full CDN URL; anything else passes through. */
export function resolvePosterUrl(raw: string, size: string = TMDB_POSTER_SIZE): string {
  const url = raw.trim();
  if (url === "") return "";
  if (url.startsWith("/")) return `${TMDB_IMAGE_BASE}/${size}${url}`;
  return url;
}

/**
 * Deterministic tint bucket (0–3) for the placeholder, hashed from the title so
 * a poster-less card still looks intentional and is distinguishable from its
 * neighbours. Same string always yields the same tint.
 */
export function tintBucket(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 4;
}

/** Tint strength per bucket, fed to `color-mix()` in CSS as `--wl-tint`. */
export const TINT_STRENGTHS = ["8%", "14%", "20%", "26%"] as const;

export function tintFor(seed: string): string {
  return TINT_STRENGTHS[tintBucket(seed)] ?? TINT_STRENGTHS[0];
}

/** First visible character, uppercased — the placeholder glyph. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "?" : (trimmed[0] as string).toUpperCase();
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

interface Pending {
  url: string;
  seed: string;
}

export interface PosterLoaderOptions {
  /** How far ahead of the viewport to start fetching. */
  rootMargin?: string;
  /** Explicit scroll container; defaults to the viewport. */
  root?: Element | null;
}

/**
 * Build a loader. One per mounted surface (Library grid, a widget) is fine — the
 * cost is one observer, and `destroy()` releases it. Cards never make their own.
 */
export function createPosterLoader(options: PosterLoaderOptions = {}): PosterLoader {
  const pending = new WeakMap<HTMLElement, Pending>();
  /**
   * The elements currently observed.
   *
   * `IntersectionObserver` holds a **strong** reference to every target, so a
   * surface that re-renders without unobserving strands its old thumbs for the
   * lifetime of the loader — and a plugin-level loader lives as long as the
   * plugin. This set is what makes `releaseWithin` possible; entries leave it
   * the moment they load or are unobserved.
   */
  const observed = new Set<HTMLElement>();
  let observer: IntersectionObserver | null = null;

  const load = (el: HTMLElement): void => {
    const entry = pending.get(el);
    if (!entry) return;
    pending.delete(el);
    observed.delete(el);
    observer?.unobserve(el);

    const img = el.createEl("img", { cls: "wl-poster-img" });
    img.setAttribute("decoding", "async");
    img.setAttribute("loading", "lazy");
    img.setAttribute("alt", "");
    img.addEventListener("load", () => {
      img.addClass("is-loaded");
      el.addClass("has-poster");
    });
    img.addEventListener("error", () => {
      // Cache the negative result and fall back for good.
      markPosterFailed(entry.url);
      img.remove();
      el.removeClass("has-poster");
      renderPosterPlaceholder(el, entry.seed);
    });
    img.src = entry.url;
  };

  const ensureObserver = (): IntersectionObserver | null => {
    if (observer) return observer;
    if (typeof IntersectionObserver === "undefined") return null;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target instanceof HTMLElement) load(entry.target);
        }
      },
      { root: options.root ?? null, rootMargin: options.rootMargin ?? "300px" },
    );
    return observer;
  };

  return {
    observe(el: HTMLElement, url: string): void {
      const seed = el.dataset.posterSeed ?? "";
      const resolved = resolvePosterUrl(url);
      if (resolved === "" || isPosterFailed(resolved)) {
        renderPosterPlaceholder(el, seed);
        return;
      }
      pending.set(el, { url: resolved, seed });
      const obs = ensureObserver();
      // No IntersectionObserver (older mobile webviews, tests) — load eagerly
      // rather than showing nothing.
      if (obs) {
        observed.add(el);
        obs.observe(el);
      } else {
        load(el);
      }
    },
    unobserve(el: HTMLElement): void {
      pending.delete(el);
      observed.delete(el);
      observer?.unobserve(el);
    },
    /**
     * Release every still-pending thumb inside `root`.
     *
     * The call a surface makes before it empties itself. Iterating the observed
     * set rather than querying the DOM means it also catches thumbs whose class
     * names the caller does not know about.
     */
    releaseWithin(root: HTMLElement): void {
      for (const el of [...observed]) {
        if (el === root || root.contains(el)) {
          pending.delete(el);
          observed.delete(el);
          observer?.unobserve(el);
        }
      }
    },
    destroy(): void {
      observed.clear();
      observer?.disconnect();
      observer = null;
    },
  };
}

/**
 * The no-poster fallback: a hashed tint behind the title's initial. Sets
 * `--wl-tint` rather than a colour, so the actual hue still comes from the theme.
 */
export function renderPosterPlaceholder(el: HTMLElement, seed: string): void {
  el.addClass("is-placeholder");
  el.style.setProperty("--wl-tint", tintFor(seed));
  if (el.querySelector(".wl-poster-initial")) return;
  el.createDiv({ cls: "wl-poster-initial", text: initialOf(seed) });
}
