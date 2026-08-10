/**
 * Client-side response cache for the anime providers.
 *
 * This is not an optimisation, it is a requirement. Jikan publishes **no ETag
 * and no `If-None-Match`** (report §1.1) — a conditional request is impossible,
 * so a 304 will never come and every repeat is a full request against a 3/s,
 * 60/min budget. AniList is worse off still at 30/min. Caching is the only
 * mechanism either provider leaves us.
 *
 * Two behaviours the callers depend on:
 *
 *   - `get` returns only *fresh* entries, but `stale` returns an expired one.
 *     During a Jikan upstream outage (`504 BadResponseException`) serving stale
 *     data beats serving an error — the alternative is a blank card because
 *     MyAnimeList is down, which has nothing to do with the user.
 *   - eviction is oldest-first at a hard cap, so a long session cannot grow the
 *     cache without bound.
 *
 * It lives under `domains/anime/` rather than `services/` because both provider
 * clients are the anime domain's plumbing; the services own no other cache.
 */

export interface CacheClock {
  now(): number;
}

export interface TtlCache<T> {
  /** The value, when present and not past its TTL. */
  get(key: string): T | undefined;
  /** The value even if expired. For outage fallback only. */
  stale(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

export const DEFAULT_CACHE_MAX = 200;

export function createTtlCache<T>(
  ttlMs: number,
  clock: CacheClock = Date,
  max: number = DEFAULT_CACHE_MAX,
): TtlCache<T> {
  const entries = new Map<string, Entry<T>>();

  const fresh = (entry: Entry<T>): boolean => clock.now() - entry.storedAt < ttlMs;

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      return fresh(entry) ? entry.value : undefined;
    },
    stale(key) {
      return entries.get(key)?.value;
    },
    set(key, value) {
      // Re-inserting moves the key to the end of the Map's iteration order, so
      // the first key is always the least recently written one.
      entries.delete(key);
      entries.set(key, { value, storedAt: clock.now() });
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
