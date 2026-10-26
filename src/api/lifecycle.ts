/**
 * Starting, stopping and rebinding the local API server, one step at a time.
 *
 * Every start, stop and rebind — from the settings tab, a synced `data.json`,
 * the Tailscale recheck or a bind retry — runs on one chain, and each step
 * waits for the previous listeners' close callbacks before it binds again.
 * That chain lives on `globalThis`, not on the plugin: Obsidian does not await
 * an async `onunload`, so on a reload (disable + enable, an update, Obsidian
 * Sync replacing the plugin) the new instance starts while the old one is
 * still closing. Sharing the chain makes the new bind wait for that close
 * instead of failing with EADDRINUSE on our own previous listener.
 *
 * A bind that fails anyway (another app has the port, the tailnet address is
 * not bindable yet) is retried with a backoff and reported, never left dead.
 *
 * No `obsidian` import: the plugin hands in what it knows, so the races can be
 * tested against real sockets.
 */
import { LOOPBACK_HOST, type ApiHostMode, type BindPlan } from "./addresses";
import type { ApiServer } from "./server";

/** How often Tailscale mode looks for the tailnet address while it is not up. */
export const API_TAILSCALE_RECHECK_MS = 30_000;

/** Waits between failed binds; the last one repeats for as long as it keeps failing. */
export const API_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];

/** What the settings ask for, read afresh at the start of every step. */
export type ApiWanted =
  | {
      serve: false;
      /** Why it cannot run although it is switched on; absent when it is simply off. */
      problem?: string;
    }
  | {
      serve: true;
      port: number;
      host: ApiHostMode;
      /** Listen on `hosts`, all on `port`. Rejects, with nothing left listening, if any one fails. */
      start: (hosts: string[]) => Promise<ApiServer>;
    };

export interface ApiTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * What every instance in this window shares. A later plugin version reads the
 * same object, so its shape only ever grows.
 */
export interface ApiRegistry {
  /** Tail of every step by any instance; never rejects. */
  chain: Promise<void>;
  /** The instance allowed to listen: the newest one. An older one only closes. */
  owner: object | null;
  /** The server listening right now, and which instance holds it. */
  live: { owner: object; server: ApiServer } | null;
}

const REGISTRY_KEY = Symbol.for("watch-read-learn/api-lifecycle");

export function createApiRegistry(): ApiRegistry {
  return { chain: Promise.resolve(), owner: null, live: null };
}

/** The registry for this window, created on first use. */
export function sharedApiRegistry(): ApiRegistry {
  const store = globalThis as unknown as Record<symbol, ApiRegistry | undefined>;
  return (store[REGISTRY_KEY] ??= createApiRegistry());
}

export interface ApiLifecycleOptions {
  wanted: () => ApiWanted;
  /** The hosts to bind for a "Listen on" choice, against the interfaces right now. */
  plan: (mode: ApiHostMode) => BindPlan;
  /** Defaults to `globalThis`' timers. */
  timers?: ApiTimers;
  /** Defaults to the one shared by every instance in this window. */
  registry?: ApiRegistry;
  log?: (message: string) => void;
  /** A failed bind; defaults to `log`. */
  warn?: (message: string) => void;
  /** Told once when the API stops working, not on every retry. */
  notify?: (problem: string) => void;
}

const defaultTimers: ApiTimers = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function describe(err: unknown, port: number): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === "EADDRINUSE" || /EADDRINUSE/.test(message) ? `port ${port} is in use` : message;
}

export class ApiLifecycle {
  /** The running server, possibly on loopback only while a retry is pending. */
  server: ApiServer | null = null;
  /** Why the API is not (fully) running. `null` when nothing is wrong. */
  problem: string | null = null;
  /** Tailscale mode with no tailnet address yet: serving this Mac only and rechecking. */
  waitingForTailscale = false;

  private readonly timers: ApiTimers;
  private readonly registry: ApiRegistry;
  private disposed = false;
  private timer: unknown = undefined;
  /** A restart waiting its turn on the chain; later requests share it. */
  private queued: Promise<void> | null = null;
  /** Steps of this instance queued or running. */
  private busy = 0;
  /** Failed binds in a row, for the backoff. */
  private failures = 0;

  constructor(private readonly opts: ApiLifecycleOptions) {
    this.timers = opts.timers ?? defaultTimers;
    this.registry = opts.registry ?? sharedApiRegistry();
    this.registry.owner = this;
  }

  /**
   * Rebuild the server from the current settings, or stop it when they say
   * off. Resolves once that is done. A call made while one is still waiting
   * its turn joins it: that one reads the settings when it starts anyway.
   */
  restart(): Promise<void> {
    // Asked for, not a retry: the backoff starts over.
    this.failures = 0;
    return this.requeue();
  }

  /** Close for good. Resolves once the listeners' close callbacks have fired. */
  stop(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    if (this.registry.owner === this) this.registry.owner = null;
    return this.enqueue(() => this.closeOwn());
  }

  private requeue(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.enqueue(async () => {
      this.queued = null;
      await this.apply();
    });
    this.queued = run;
    return run;
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const registry = this.registry;
    this.busy++;
    const run = registry.chain.then(step).finally(() => {
      this.busy--;
    });
    registry.chain = run.catch(() => undefined);
    return run;
  }

  private async closeOwn(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    if (this.registry.live?.server === server) this.registry.live = null;
    await server.close();
  }

  private adopt(server: ApiServer): void {
    this.server = server;
    this.registry.live = { owner: this, server };
  }

  private async apply(): Promise<void> {
    this.clearTimer();
    await this.closeOwn();
    this.problem = null;
    this.waitingForTailscale = false;
    if (this.disposed || this.registry.owner !== this) return;
    // A previous instance that never got to close (its unload not run yet, or
    // never) would hold the port against us. It is superseded: close it.
    const stale = this.registry.live;
    if (stale !== null && stale.owner !== this) {
      this.registry.live = null;
      await stale.server.close();
    }

    const wanted = this.opts.wanted();
    if (!wanted.serve) {
      this.problem = wanted.problem ?? null;
      this.failures = 0;
      return;
    }
    const plan = this.opts.plan(wanted.host);
    try {
      this.adopt(await wanted.start(plan.hosts));
      if (this.failures > 0) this.opts.log?.("listening again");
      this.failures = 0;
      if (plan.waitingForTailscale) {
        // Tailscale is often not up yet when Obsidian starts. Serve this Mac
        // now and add the tailnet address as soon as it appears.
        this.waitingForTailscale = true;
        this.schedule(() => this.recheckTailscale(wanted.host), API_TAILSCALE_RECHECK_MS);
      }
    } catch (err) {
      await this.failed(err, wanted.port, plan.hosts, wanted.start);
    }
  }

  /** Keep this Mac served if that much still binds, say so, and try again later. */
  private async failed(
    err: unknown,
    port: number,
    hosts: string[],
    start: (hosts: string[]) => Promise<ApiServer>,
  ): Promise<void> {
    let problem = describe(err, port);
    if (hosts.length > 1 && hosts.includes(LOOPBACK_HOST)) {
      try {
        this.adopt(await start([LOOPBACK_HOST]));
        problem += `; serving ${LOOPBACK_HOST} only`;
      } catch {
        // Loopback was the address that failed; nothing is listening.
      }
    }
    const delay = API_RETRY_DELAYS_MS[Math.min(this.failures, API_RETRY_DELAYS_MS.length - 1)] ?? 60_000;
    this.failures++;
    this.problem = `${problem}; retrying`;
    (this.opts.warn ?? this.opts.log)?.(`could not start: ${problem}; retrying in ${delay / 1000} s`);
    if (this.failures === 1) this.opts.notify?.(this.problem);
    this.schedule(() => this.retry(), delay);
  }

  /**
   * Timers only ever queue a step, so they can never overlap one; one that
   * fires while a step is pending leaves it to that step, which re-reads the
   * interfaces and schedules again if it needs to.
   */
  private recheckTailscale(host: ApiHostMode): void {
    if (this.disposed || this.busy > 0) return;
    if (this.opts.plan(host).waitingForTailscale) {
      this.schedule(() => this.recheckTailscale(host), API_TAILSCALE_RECHECK_MS);
    } else {
      this.requeueQuietly();
    }
  }

  private retry(): void {
    if (this.disposed || this.busy > 0) return;
    this.requeueQuietly();
  }

  /** From a timer, where nobody awaits the result: a failure is logged, not thrown. */
  private requeueQuietly(): void {
    this.requeue().catch((err: unknown) => {
      (this.opts.warn ?? this.opts.log)?.(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private schedule(callback: () => void, ms: number): void {
    this.clearTimer();
    if (this.disposed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      callback();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }
}
