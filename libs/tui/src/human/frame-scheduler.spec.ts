// @test-scope ./frame-scheduler.ts
import { describe, expect, it } from "vitest";
import { FrameScheduler } from "./frame-scheduler.js";

class FakeTimers {
  readonly scheduled: {
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }[] = [];

  schedule(callback: () => void, delayMs: number): object {
    const timer = { callback, delayMs, cancelled: false };
    this.scheduled.push(timer);
    return timer;
  }

  cancel(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  runNext(): void {
    const timer = this.scheduled.shift();
    if (timer !== undefined && !timer.cancelled) timer.callback();
  }
}

describe("FrameScheduler", () => {
  it("coalesces ordinary frames and limits their rate", () => {
    let now = 0;
    const timers = new FakeTimers();
    let frames = 0;
    const scheduler = new FrameScheduler(
      () => {
        frames += 1;
      },
      { clock: { now: () => now }, timers },
    );

    scheduler.request();
    scheduler.request();
    expect(timers.scheduled).toHaveLength(1);
    timers.runNext();
    expect(frames).toBe(1);

    scheduler.request();
    expect(timers.scheduled[0]?.delayMs).toBe(84);
    now = 84;
    timers.runNext();
    expect(frames).toBe(2);
  });

  it("flushes immediate frames and cancels all future work on stop", () => {
    const timers = new FakeTimers();
    let frames = 0;
    const scheduler = new FrameScheduler(
      () => {
        frames += 1;
      },
      { clock: { now: () => 0 }, timers },
    );

    scheduler.request();
    scheduler.requestImmediate();
    expect(frames).toBe(1);
    scheduler.stop();
    timers.runNext();
    scheduler.request();
    expect(frames).toBe(1);
  });
});
