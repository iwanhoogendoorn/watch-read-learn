/**
 * Starting, stopping and rebinding the local API (`src/api/lifecycle.ts`),
 * against real servers on 127.0.0.1. No network beyond loopback.
 *
 * The port is fixed for each test (a free one, found first), so two of our own
 * listeners overlapping would fail with EADDRINUSE here exactly as it did live.
 * Timers are a hand-cranked fake: a test sees each delay that was asked for
 * and fires it when it chooses.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOOPBACK_HOST, type BindPlan } from "../src/api/addresses";
import {
  API_TAILSCALE_RECHECK_MS,
  ApiLifecycle,
  createApiRegistry,
  type ApiRegistry,
  type ApiTimers,
  type ApiWanted,
} from "../src/api/lifecycle";
import { startApiServer, type ApiServer } from "../src/api/server";
import type { ApiDeps } from "../src/api/types";

const TOKEN = "t".repeat(48);
/** TEST-NET-1: never assigned to this machine, so binding it always fails. */
const UNBINDABLE = "192.0.2.1";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function manualTimers(): ApiTimers & { delays(): number[]; fire(): void } {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    set(callback, ms) {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire() {
      const due = [...pending.entries()];
      for (const [id] of due) pending.delete(id);
      for (const [, entry] of due) entry.callback();
    },
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, LOOPBACK_HOST, resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK_HOST);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Another app on the port. */
async function holdPort(port: number): Promise<net.Server> {
  const foreign = net.createServer();
  await new Promise<void>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(port, LOOPBACK_HOST, resolve);
  });
  return foreign;
}

/**
 * Real `startApiServer`, counted: how many listen calls overlap, how many
 * servers are open, and whether any bind began while one was still open.
 */
function recorder(opts: { startDelay?: number; closeDelay?: number } = {}) {
  const open = new Set<ApiServer>();
  const stats = { starts: 0, inFlight: 0, maxInFlight: 0, bindWhileOpen: 0 };
  const start = async (hosts: string[], port: number): Promise<ApiServer> => {
    stats.starts++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    try {
      if (opts.startDelay) await wait(opts.startDelay);
      if (open.size > 0) stats.bindWhileOpen++;
      const server = await startApiServer({
        hosts,
        port,
        token: TOKEN,
        deps: {} as ApiDeps,
        routes: [],
        allowRemoteWrites: () => false,
      });
      open.add(server);
      const close = server.close.bind(server);
      server.close = async () => {
        if (opts.closeDelay) await wait(opts.closeDelay);
        await close();
        open.delete(server);
      };
      return server;
    } finally {
      stats.inFlight--;
    }
  };
  return { start, open, stats };
}

interface Harness {
  lifecycle: ApiLifecycle;
  timers: ReturnType<typeof manualTimers>;
  notices: string[];
  /** Change what the settings ask for. */
  set(next: Partial<{ serve: boolean; hosts: string[]; waitingForTailscale: boolean }>): void;
}

let registry: ApiRegistry;
let port: number;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  registry = createApiRegistry();
  port = await freePort();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function harness(start: (hosts: string[], port: number) => Promise<ApiServer>, reg = registry): Harness {
  const timers = manualTimers();
  const notices: string[] = [];
  const state = { serve: true, hosts: [LOOPBACK_HOST], waitingForTailscale: false };
  const lifecycle = new ApiLifecycle({
    wanted: (): ApiWanted =>
      state.serve
        ? { serve: true, port, host: "tailscale", start: (hosts) => start(hosts, port) }
        : { serve: false },
    plan: (): BindPlan => ({ hosts: [...state.hosts], waitingForTailscale: state.waitingForTailscale }),
    timers,
    registry: reg,
    notify: (problem) => notices.push(problem),
  });
  cleanups.push(() => lifecycle.stop());
  return { lifecycle, timers, notices, set: (next) => Object.assign(state, next) };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe("restarts and the Tailscale recheck", () => {
  it("concurrent restarts with the recheck firing among them end with exactly one listening server", async () => {
    const rec = recorder({ startDelay: 15, closeDelay: 15 });
    const h = harness(rec.start);
    h.set({ waitingForTailscale: true });
    await h.lifecycle.restart();
    expect(h.lifecycle.waitingForTailscale).toBe(true);
    expect(h.timers.delays()).toEqual([API_TAILSCALE_RECHECK_MS]);

    // The tailnet comes up just as a synced data.json and the settings tab
    // both ask for a restart.
    h.set({ waitingForTailscale: false });
    const all: Promise<void>[] = [];
    all.push(h.lifecycle.restart());
    h.timers.fire();
    all.push(h.lifecycle.restart());
    await wait(5);
    all.push(h.lifecycle.restart());
    h.timers.fire();
    await wait(20);
    all.push(h.lifecycle.restart());
    h.timers.fire();
    await Promise.all(all);
    await registry.chain;

    expect(rec.stats.maxInFlight).toBe(1);
    expect(rec.stats.bindWhileOpen).toBe(0);
    expect(rec.open.size).toBe(1);
    expect([...rec.open][0]).toBe(h.lifecycle.server);
    expect(h.lifecycle.problem).toBeNull();
    expect(h.lifecycle.waitingForTailscale).toBe(false);
    expect(h.timers.delays()).toEqual([]);
    expect(await listening(port)).toBe(true);
  });

  it("the recheck fired during an in-flight restart leaves it to that restart", async () => {
    const rec = recorder({ startDelay: 20 });
    const h = harness(rec.start);
    h.set({ waitingForTailscale: true });
    await h.lifecycle.restart();
    const before = rec.stats.starts;

    h.set({ waitingForTailscale: false });
    const running = h.lifecycle.restart();
    await wait(5); // the restart is inside its bind now
    h.timers.fire(); // cleared when the restart began: nothing to fire
    await running;
    expect(rec.stats.starts).toBe(before + 1);
    expect(rec.stats.maxInFlight).toBe(1);
    expect(rec.open.size).toBe(1);
  });

  it("a recheck that still finds no tailnet waits again without rebinding", async () => {
    const rec = recorder();
    const h = harness(rec.start);
    h.set({ waitingForTailscale: true });
    await h.lifecycle.restart();
    h.timers.fire();
    await registry.chain;
    expect(rec.stats.starts).toBe(1);
    expect(h.timers.delays()).toEqual([API_TAILSCALE_RECHECK_MS]);
  });
});

// ---------------------------------------------------------------------------
// A second instance (plugin reload, update, Obsidian Sync)
// ---------------------------------------------------------------------------

describe("a second plugin instance", () => {
  it("binds once the first has closed, although the first's unload was not awaited", async () => {
    const recA = recorder({ closeDelay: 40 });
    const a = harness(recA.start);
    await a.lifecycle.restart();
    expect(await listening(port)).toBe(true);

    // Obsidian calls onunload without awaiting it, then loads the new copy.
    const stopping = a.lifecycle.stop();
    const recB = recorder();
    const b = harness(recB.start);
    await b.lifecycle.restart();

    expect(b.lifecycle.problem).toBeNull();
    expect(b.lifecycle.server).not.toBeNull();
    expect(recA.open.size).toBe(0);
    await stopping;
    expect(recB.open.size).toBe(1);
    expect(await listening(port)).toBe(true);
  });

  it("takes the port over from an instance that was never unloaded, which then leaves it alone", async () => {
    const recA = recorder();
    const a = harness(recA.start);
    await a.lifecycle.restart();

    const recB = recorder();
    const b = harness(recB.start);
    await b.lifecycle.restart();
    expect(b.lifecycle.problem).toBeNull();
    expect(recA.open.size).toBe(0);

    // The old one's timers and late unload must not touch the new server.
    await a.lifecycle.restart();
    await a.lifecycle.stop();
    expect(recA.open.size).toBe(0);
    expect(recB.open.size).toBe(1);
    expect(await listening(port)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bind errors
// ---------------------------------------------------------------------------

describe("a bind that fails", () => {
  it("retries with a backoff while another app holds the port, then binds once it is free", async () => {
    const foreign = await holdPort(port);
    const rec = recorder();
    const h = harness(rec.start);
    await h.lifecycle.restart();

    expect(h.lifecycle.server).toBeNull();
    expect(h.lifecycle.problem).toBe(`port ${port} is in use; retrying`);
    expect(h.notices).toEqual([`port ${port} is in use; retrying`]);

    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(...h.timers.delays());
      h.timers.fire();
      await registry.chain;
    }
    expect(delays).toEqual([2_000, 5_000, 10_000, 30_000, 60_000, 60_000]);
    // Told once, not on every retry.
    expect(h.notices).toHaveLength(1);
    expect(h.lifecycle.problem).toBe(`port ${port} is in use; retrying`);

    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    h.timers.fire();
    await registry.chain;
    expect(h.lifecycle.server).not.toBeNull();
    expect(h.lifecycle.problem).toBeNull();
    expect(h.timers.delays()).toEqual([]);
    expect(await listening(port)).toBe(true);
  });

  it("keeps loopback served and retries when only the tailnet address fails", async () => {
    const rec = recorder();
    const h = harness(rec.start);
    h.set({ hosts: [LOOPBACK_HOST, UNBINDABLE] });
    await h.lifecycle.restart();

    expect(h.lifecycle.server?.hosts).toEqual([LOOPBACK_HOST]);
    expect(h.lifecycle.problem).toMatch(/; serving 127\.0\.0\.1 only; retrying$/);
    expect(h.timers.delays()).toEqual([2_000]);
    expect(await listening(port)).toBe(true);

    // The retry closes the fallback before it binds the full set again.
    h.timers.fire();
    await registry.chain;
    expect(rec.stats.bindWhileOpen).toBe(0);
    expect(rec.open.size).toBe(1);
    expect(h.timers.delays()).toEqual([5_000]);
  });

  it("a restart the user asks for starts the backoff over", async () => {
    const foreign = await holdPort(port);
    cleanups.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
    const h = harness(recorder().start);
    await h.lifecycle.restart();
    h.timers.fire();
    await registry.chain;
    expect(h.timers.delays()).toEqual([5_000]);
    await h.lifecycle.restart();
    expect(h.timers.delays()).toEqual([2_000]);
  });
});

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

describe("cancelling retries", () => {
  it("unload cancels a pending retry, so nothing binds after it", async () => {
    const foreign = await holdPort(port);
    const rec = recorder();
    const h = harness(rec.start);
    await h.lifecycle.restart();
    expect(h.timers.delays()).toEqual([2_000]);

    await h.lifecycle.stop();
    expect(h.timers.delays()).toEqual([]);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    h.timers.fire();
    await registry.chain;
    expect(rec.stats.starts).toBe(1);
    expect(await listening(port)).toBe(false);
  });

  it("switching the API off cancels a pending retry and clears the problem", async () => {
    const foreign = await holdPort(port);
    cleanups.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
    const h = harness(recorder().start);
    await h.lifecycle.restart();
    expect(h.lifecycle.problem).not.toBeNull();

    h.set({ serve: false });
    await h.lifecycle.restart();
    expect(h.timers.delays()).toEqual([]);
    expect(h.lifecycle.problem).toBeNull();
    expect(h.lifecycle.server).toBeNull();
  });

  it("unload during a start closes what that start bound", async () => {
    const rec = recorder({ startDelay: 20 });
    const h = harness(rec.start);
    const starting = h.lifecycle.restart();
    await wait(5);
    await h.lifecycle.stop();
    await starting;
    expect(rec.open.size).toBe(0);
    expect(await listening(port)).toBe(false);
  });
});
