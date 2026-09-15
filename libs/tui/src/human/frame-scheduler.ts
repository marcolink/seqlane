export interface FrameSchedulerClock {
  now(): number;
}

export interface FrameSchedulerTimers {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface FrameSchedulerOptions {
  readonly clock: FrameSchedulerClock;
  readonly timers: FrameSchedulerTimers;
  readonly maxFramesPerSecond?: number;
}

/** Coalesces ordinary updates while allowing terminal and input frames through. */
export class FrameScheduler {
  private readonly minimumIntervalMs: number;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private pending: unknown;
  private stopped = false;

  constructor(
    private readonly render: () => void,
    private readonly options: FrameSchedulerOptions,
  ) {
    this.minimumIntervalMs = Math.ceil(
      1_000 / (options.maxFramesPerSecond ?? 12),
    );
  }

  requestImmediate(): void {
    if (this.stopped) return;
    if (this.pending !== undefined) {
      this.options.timers.cancel(this.pending);
      this.pending = undefined;
    }
    this.flush();
  }

  request(): void {
    if (this.stopped || this.pending !== undefined) return;
    const delayMs = Math.max(
      0,
      this.minimumIntervalMs - (this.options.clock.now() - this.lastFrameAt),
    );
    this.pending = this.options.timers.schedule(() => {
      this.pending = undefined;
      if (!this.stopped) this.flush();
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) this.options.timers.cancel(pending);
  }

  private flush(): void {
    this.lastFrameAt = this.options.clock.now();
    this.render();
  }
}
