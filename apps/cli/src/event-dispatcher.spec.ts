import type { SeqlaneExecutionEvent } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  createEventDispatcher,
  type SeqlaneExecutionEventConsumer,
} from "./event-dispatcher.js";

const runStarted = (sequence: number): SeqlaneExecutionEvent => ({
  type: "run.started",
  metadata: {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-08-22T12:00:00.000Z",
  },
  workId: "work-1",
  runId: "run-1",
});

function consumer(
  onConsume: (event: SeqlaneExecutionEvent) => void,
  onFlush: () => Promise<void> = async () => undefined,
  onClose: () => Promise<void> = async () => undefined,
): SeqlaneExecutionEventConsumer {
  return { consume: onConsume, flush: onFlush, close: onClose };
}

describe("CLI event dispatcher", () => {
  it("preserves ordering independently for each consumer", async () => {
    const slowRelease: { resolve?: () => void } = {};
    const slowGate = new Promise<void>((resolve) => {
      slowRelease.resolve = resolve;
    });
    const fast: number[] = [];
    const slow: number[] = [];
    const dispatcher = createEventDispatcher([
      {
        name: "slow",
        consumer: consumer(async (event) => {
          slow.push(event.metadata.sequence);
          await slowGate;
        }),
      },
      {
        name: "fast",
        consumer: consumer((event) => fast.push(event.metadata.sequence)),
      },
    ]);

    dispatcher.consume(runStarted(1));
    dispatcher.consume(runStarted(2));
    await Promise.resolve();
    expect(fast).toEqual([1, 2]);
    expect(slow).toEqual([1]);

    slowRelease.resolve?.();
    await dispatcher.flush();
    expect(slow).toEqual([1, 2]);
  });

  it("isolates a failed consumer and reports one bounded diagnostic", async () => {
    const diagnostics: string[] = [];
    const healthy: number[] = [];
    let attempts = 0;
    const dispatcher = createEventDispatcher(
      [
        {
          name: "broken",
          consumer: consumer(() => {
            attempts += 1;
            throw new Error("broken consumer");
          }),
        },
        {
          name: "healthy",
          consumer: consumer((event) => healthy.push(event.metadata.sequence)),
        },
      ],
      { onDiagnostic: (message) => diagnostics.push(message) },
    );

    dispatcher.consume(runStarted(1));
    dispatcher.consume(runStarted(2));
    await dispatcher.flush();

    expect(attempts).toBe(1);
    expect(healthy).toEqual([1, 2]);
    expect(diagnostics).toEqual(["broken consumer disabled: broken consumer"]);
  });

  it("flushes and closes every consumer after queued events drain", async () => {
    const lifecycle: string[] = [];
    const dispatcher = createEventDispatcher([
      {
        name: "recording",
        consumer: consumer(
          () => lifecycle.push("consume"),
          async () => {
            lifecycle.push("flush");
          },
          async () => {
            lifecycle.push("close");
          },
        ),
      },
    ]);

    dispatcher.consume(runStarted(1));
    await dispatcher.flush();
    await dispatcher.close();
    dispatcher.consume(runStarted(2));

    expect(lifecycle).toEqual(["consume", "flush", "close"]);
  });

  it("disables a consumer when its bounded queue overflows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumed: number[] = [];
    const diagnostics: string[] = [];
    const dispatcher = createEventDispatcher(
      [
        {
          name: "slow",
          consumer: consumer(async (event) => {
            consumed.push(event.metadata.sequence);
            await gate;
          }),
        },
      ],
      { maxQueueSize: 1, onDiagnostic: (message) => diagnostics.push(message) },
    );

    dispatcher.consume(runStarted(1));
    dispatcher.consume(runStarted(2));
    dispatcher.consume(runStarted(3));
    release();
    await dispatcher.flush();

    expect(consumed).toEqual([1]);
    expect(diagnostics).toEqual([
      "slow consumer disabled: event queue is full",
    ]);
  });
});
