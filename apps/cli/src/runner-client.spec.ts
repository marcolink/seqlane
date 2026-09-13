import { EventEmitter } from "node:events";
import {
  encodeSeqlaneExecutionEvent,
  type SeqlaneExecutionEvent,
} from "@seqlane/protocol";
import { encodeRuntimeSessionUiAvailable } from "@seqlane/runtime";
import type { RunRequest } from "@seqlane/protocol";
import { describe, expect, it } from "vitest";
import {
  mapRunnerOutcomeToStatus,
  superviseRunner,
  type RunnerChild,
} from "./runner-client.js";

const validInput = {
  dependency: "demo",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  failure: "Renovate update failed",
};

const request: RunRequest = {
  type: "run.start",
  workflow: {
    id: "renovate",
    moduleSpecifier: "@seqlane/fixtures/renovate-workflow",
    exportName: "renovateWorkflow",
  },
  input: validInput,
  runtime: { id: "test-fixture" },
};

type EventWithoutMetadata = SeqlaneExecutionEvent extends infer Event
  ? Event extends { metadata: unknown }
    ? Omit<Event, "metadata">
    : never
  : never;

function event<T extends EventWithoutMetadata>(
  value: T,
  sequence = 1,
): T & Pick<SeqlaneExecutionEvent, "metadata"> {
  return {
    ...value,
    metadata: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-08-22T12:00:00.000Z",
    },
  } as T & Pick<SeqlaneExecutionEvent, "metadata">;
}

class FakeChild extends EventEmitter implements RunnerChild {
  readonly messages: string[] = [];
  killed = false;

  send(message: string, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitEvent(candidate: EventWithoutMetadata): void {
    this.emit("message", encodeSeqlaneExecutionEvent(event(candidate)));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

describe("runner client", () => {
  it.each([
    [
      event({
        type: "run.succeeded",
        workId: "work-1",
        runId: "run-1",
        output: null,
      }),
      0,
    ],
    [
      event({
        type: "run.failed",
        workId: "work-1",
        runId: "run-1",
        error: { category: "RuntimeError", message: "failed" },
      }),
      1,
    ],
    [event({ type: "run.cancelled", workId: "work-1", runId: "run-1" }), 130],
  ] as const)("maps $0 to status $1", (candidate, status) => {
    expect(
      mapRunnerOutcomeToStatus(
        candidate as Extract<
          SeqlaneExecutionEvent,
          { type: "run.succeeded" | "run.failed" | "run.cancelled" }
        >,
      ),
    ).toBe(status);
  });

  it("supervises canonical terminal events", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request);
    const terminal = event({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });

    child.emit("message", encodeSeqlaneExecutionEvent(terminal));

    await expect(result).resolves.toMatchObject({
      status: 0,
      terminalEvent: terminal,
    });
  });

  it("returns a protocol failure for malformed events", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request);

    child.emit("message", '{"type":"run.unknown"}');

    await expect(result).resolves.toMatchObject({
      status: 1,
      failure: {
        type: "runner.failure",
        message: "Invalid Seqlane execution event",
      },
    });
  });

  it("forwards canonical plan and execution events to one callback", async () => {
    const child = new FakeChild();
    const received: SeqlaneExecutionEvent[] = [];
    const result = superviseRunner(child, request, {
      signalSource: null,
      onExecutionEvent: (candidate) => received.push(candidate),
    });
    const plan = event(
      {
        type: "run.plan",
        workId: "work-1",
        runId: "run-1",
        plan: { workflow: { id: "workflow" }, nodes: [] },
      },
      2,
    );

    child.emit(
      "message",
      encodeSeqlaneExecutionEvent(
        event({
          type: "run.started",
          workId: "work-1",
          runId: "run-1",
        }),
      ),
    );
    child.emit("message", encodeSeqlaneExecutionEvent(plan));
    child.emit(
      "message",
      encodeSeqlaneExecutionEvent(
        event(
          {
            type: "run.succeeded",
            workId: "work-1",
            runId: "run-1",
            output: null,
          },
          3,
        ),
      ),
    );

    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(received.map(({ type }) => type)).toEqual([
      "run.started",
      "run.plan",
      "run.succeeded",
    ]);
    expect(received.every((candidate) => candidate.metadata)).toBe(true);
  });

  it("forwards a runtime session UI message without treating it as an execution event", async () => {
    const child = new FakeChild();
    const sessionUiNotifications: unknown[] = [];
    const executionEvents: SeqlaneExecutionEvent[] = [];
    const result = superviseRunner(child, request, {
      signalSource: null,
      onExecutionEvent: (event) => executionEvents.push(event),
      onRuntimeSessionUiAvailable: (notification) =>
        sessionUiNotifications.push(notification),
    });

    child.emit(
      "message",
      encodeRuntimeSessionUiAvailable({
        type: "runtime.session.ui-available",
        invocationId: "invocation-1",
        browserUrl: "http://127.0.0.1:4096/L3JlcG8/session/ses_123",
      }),
    );
    child.emitEvent({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });

    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(sessionUiNotifications).toEqual([
      {
        type: "runtime.session.ui-available",
        invocationId: "invocation-1",
        browserUrl: "http://127.0.0.1:4096/L3JlcG8/session/ses_123",
      },
    ]);
    expect(executionEvents.map(({ type }) => type)).toEqual(["run.succeeded"]);
  });

  it("rejects duplicate terminal events", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request);

    child.emitEvent({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });
    child.emitEvent({
      type: "run.failed",
      workId: "work-1",
      runId: "run-1",
      error: { category: "RuntimeError", message: "late failure" },
    });

    await expect(result).resolves.toMatchObject({
      status: 1,
      failure: {
        type: "runner.failure",
        message: "Received duplicate terminal runner event",
      },
    });
  });

  it("sends one cancellation command for repeated signals", async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();
    const result = superviseRunner(child, request, { signalSource: signals });

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    child.emitEvent({
      type: "run.cancelled",
      workId: "work-1",
      runId: "run-1",
    });

    await expect(result).resolves.toMatchObject({ status: 130 });
    expect(child.messages).toHaveLength(2);
    expect(child.messages[1]).toBe(JSON.stringify({ type: "run.cancel" }));
  });
});
