/**
 * Minimum-gap rate limiter, promise-chained.
 *
 * Same discipline as `data/store.ts`'s save chain: every task is appended to a
 * single promise, so N concurrent callers are serialised in call order and no
 * two requests to the same provider can leave less than `minGapMs` apart.
 *
 * Used for two different jobs:
 *   - provider politeness (`RATE_LIMIT_MS` — TMDB 100 ms, LAN services 0), and
 *   - the airing refresh queue's deliberate 1 req/s stagger (SPEC §4.4).
 *
 * A rejected task must not poison the chain, so the tail is always the settled
 * promise, never the caller's. Callers still see their own rejection.
 */

export interface RateLimiter {
  /** Queue `fn`; resolves with its result once the gap has elapsed. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Tasks queued but not yet finished. Drives "refreshing 3 of 12" chrome. */
  readonly pending: number;
  /** Resolves when everything queued so far has settled. */
  idle(): Promise<void>;
}

/** Injectable clock, so tests never wait on real time. */
export interface LimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * `minGapMs` is measured from the **start** of the previous task, so a slow
 * request does not earn the next one an extra delay — 1 req/s means one request
 * begins every second, which is what the Plex/Overseerr stagger is about.
 */
export function createRateLimiter(minGapMs: number, clock: LimiterClock = realClock): RateLimiter {
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  let pending = 0;

  return {
    get pending() {
      return pending;
    },

    run<T>(fn: () => Promise<T>): Promise<T> {
      pending += 1;
      const task = chain.then(async () => {
        if (minGapMs > 0 && lastStart !== Number.NEGATIVE_INFINITY) {
          const wait = minGapMs - (clock.now() - lastStart);
          if (wait > 0) await clock.sleep(wait);
        }
        lastStart = clock.now();
        return fn();
      });
      // The chain advances on the settled task; a rejection here is the
      // caller's problem, not the queue's.
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      task.then(
        () => {
          pending -= 1;
        },
        () => {
          pending -= 1;
        },
      );
      return task;
    },

    async idle(): Promise<void> {
      await chain;
    },
  };
}

/** A limiter that never waits. Handy for tests and for LAN providers. */
export function createPassthroughLimiter(): RateLimiter {
  return createRateLimiter(0, realClock);
}
