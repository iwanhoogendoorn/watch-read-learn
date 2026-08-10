import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../src/services/ratelimit";
import { createTestClock } from "../mocks/http";

describe("createRateLimiter", () => {
  it("runs tasks in call order", async () => {
    const { clock } = createTestClock();
    const limiter = createRateLimiter(1000, clock);
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      limiter.run(async () => {
        order.push(n);
        return n;
      }),
    );

    expect(await Promise.all(tasks)).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("leaves at least minGapMs between task starts", async () => {
    const { clock } = createTestClock();
    const limiter = createRateLimiter(1000, clock);
    const starts: number[] = [];

    await Promise.all(
      [0, 1, 2].map(() =>
        limiter.run(async () => {
          starts.push(clock.now());
        }),
      ),
    );

    // First is immediate; the rest are staggered one second apart.
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("measures the gap from the previous start, so a slow task costs nothing extra", async () => {
    const { clock, advance } = createTestClock();
    const limiter = createRateLimiter(1000, clock);
    const starts: number[] = [];

    const first = limiter.run(async () => {
      starts.push(clock.now());
      advance(5000); // a five-second request
    });
    const second = limiter.run(async () => {
      starts.push(clock.now());
    });
    await Promise.all([first, second]);

    // The gap has already elapsed during the slow call — no further wait.
    expect(starts).toEqual([0, 5000]);
  });

  it("does not wait at all when the gap is zero", async () => {
    const { clock, sleeps } = createTestClock();
    const limiter = createRateLimiter(0, clock);
    await Promise.all([limiter.run(async () => 1), limiter.run(async () => 2)]);
    expect(sleeps).toEqual([]);
  });

  it("keeps draining after a task rejects", async () => {
    const { clock } = createTestClock();
    const limiter = createRateLimiter(10, clock);

    const failing = limiter.run(async () => {
      throw new Error("boom");
    });
    const following = limiter.run(async () => "still here");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("still here");
  });

  it("tracks pending work and settles to idle", async () => {
    const { clock } = createTestClock();
    const limiter = createRateLimiter(10, clock);
    const task = limiter.run(async () => "done");
    expect(limiter.pending).toBe(1);
    await task;
    await limiter.idle();
    expect(limiter.pending).toBe(0);
  });
});
