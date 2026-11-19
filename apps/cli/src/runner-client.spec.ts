import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import {
  encodeSeqlaneExecutionEvent,
  decodeRunnerCommand,
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
  private nextSequence = 1;

  send(message: string, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    if (message === JSON.stringify({ type: "run.cancel" })) {
      queueMicrotask(() => this.emit("close", 0, null));
    }
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitEvent(candidate: EventWithoutMetadata): void {
    this.emit(
      "message",
      encodeSeqlaneExecutionEvent(event(candidate, this.nextSequence++)),
    );
    if (
      candidate.type === "run.succeeded" ||
      candidate.type === "run.failed" ||
      candidate.type === "run.cancelled"
    ) {
      queueMicrotask(() => this.emit("close", 0, null));
    }
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

describe("runner client", () => {
  it("cancels terminal loss during startup after sending run.start", async () => {
    const child = new FakeChild();
    const result = await superviseRunner(child, request, {
      signalSource: null,
      onReady: (cancelRun) => cancelRun(),
    });
    expect(result.status).toBe(130);
    expect(
      child.messages.map((message) => decodeRunnerCommand(message).type),
    ).toEqual(["run.start", "run.cancel"]);
  });

  it("wakes supervision when an asynchronous question consumer fails", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request, {
      signalSource: null,
      onInteractionRequested: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("question consumer failed");
      },
    });
    child.emitEvent({
      type: "interaction.requested",
      kind: "user-input",
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      requestId: "request-1",
      subject: { type: "task", taskId: "task-1" },
      questions: [{ id: "note", prompt: "Note?", allowFreeText: true }],
      expiresAt: "2026-10-24T12:00:00.000Z",
    });
    await expect(result).resolves.toMatchObject({
      status: 1,
      failure: { message: "Runner process error: question consumer failed" },
    });
    expect(
      child.messages.map((message) => decodeRunnerCommand(message).type),
    ).toEqual(["run.start", "run.cancel"]);
  });

  it("forwards a validated interaction answer as a runner command", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request, {
      signalSource: null,
      onInteractionRequested: async (interaction, respond) => {
        await respond({
          type: "interaction.respond",
          runId: interaction.runId,
          invocationId: interaction.invocationId,
          requestId: interaction.requestId,
          answers: { region: "eu-west" },
        });
      },
    });

    child.emitEvent({
      type: "interaction.requested",
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      requestId: "request-1",
      subject: { type: "task", taskId: "task-1" },
      taskId: "task-1",
      kind: "user-input",
      questions: [
        {
          id: "region",
          prompt: "Choose a region",
          allowFreeText: false,
          options: [
            { value: "eu-west", label: "Europe West" },
            { value: "us-east", label: "US East" },
          ],
        },
      ],
      expiresAt: "2026-10-24T12:00:00.000Z",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const answer = child.messages
      .map((message) => decodeRunnerCommand(message))
      .find((command) => command.type === "interaction.respond");
    expect(answer).toMatchObject({
      type: "interaction.respond",
      runId: "run-1",
      invocationId: "invocation-1",
      requestId: "request-1",
      answers: { region: "eu-west" },
    });

    child.emitEvent({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });
    await expect(result).resolves.toMatchObject({ status: 0 });
  });

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

    child.emitEvent(terminal);

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

  it.each([
    { label: "undefined", cause: undefined },
    { label: "null", cause: null },
    { label: "frozen", cause: Object.freeze({ reason: "sink failure" }) },
  ])(
    "preserves the first sink failure cause ($label) through disconnect and exit",
    async ({ cause }) => {
      class DisconnectingChild extends FakeChild {
        override send(
          message: string,
          callback?: (error: Error | null) => void,
        ): boolean {
          this.messages.push(message);
          callback?.(null);
          if (message === JSON.stringify({ type: "run.cancel" })) {
            queueMicrotask(() => {
              this.emit("disconnect");
              this.emitExit(1);
            });
          }
          return true;
        }
      }
      const child = new DisconnectingChild();
      const result = superviseRunner(child, request, {
        signalSource: null,
        onExecutionEvent: () => {
          throw cause;
        },
      });

      child.emit(
        "message",
        encodeSeqlaneExecutionEvent(
          event({
            type: "run.succeeded",
            workId: "work-1",
            runId: "run-1",
            output: null,
          }),
        ),
      );

      const outcome = await result;
      expect(outcome.status).toBe(1);
      if (!("failure" in outcome)) throw new Error("Expected runner failure");
      expect(outcome.failure.message).toBe(
        `Runner output failed: ${String(cause)}`,
      );
      expect(Object.hasOwn(outcome.failure, "cause")).toBe(true);
      expect(outcome.failure.cause).toBe(cause);
      expect(JSON.stringify(outcome.failure)).toBe(
        JSON.stringify({
          type: "runner.failure",
          message: outcome.failure.message,
        }),
      );
    },
  );

  it("waits for close after an accepted terminal event and earlier exit", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request, { signalSource: null });
    child.emit(
      "message",
      encodeSeqlaneExecutionEvent(
        event({
          type: "run.succeeded",
          workId: "work-1",
          runId: "run-1",
          output: null,
        }),
      ),
    );
    child.emitExit(0);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ status: 0 });
  });

  it("drains a terminal frame queued between exit and disconnect", async () => {
    const child = new FakeChild();
    const result = superviseRunner(child, request, { signalSource: null });
    child.emitExit(0);
    child.emit(
      "message",
      encodeSeqlaneExecutionEvent(
        event({
          type: "run.succeeded",
          workId: "work-1",
          runId: "run-1",
          output: null,
        }),
      ),
    );
    child.emit("disconnect");
    child.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({ status: 0 });
  });

  it("diagnoses malformed telemetry frames without failing canonical supervision", async () => {
    const child = new FakeChild();
    const diagnostics: number[] = [];
    const result = superviseRunner(child, request, {
      signalSource: null,
      onTelemetryDiagnostic: () => diagnostics.push(1),
    });

    child.emit(
      "message",
      JSON.stringify({ type: "runner.telemetry.spans", spans: "bad" }),
    );
    child.emitEvent({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });

    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(diagnostics).toHaveLength(1);
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
    child.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(received.map(({ type }) => type)).toEqual([
      "run.started",
      "run.plan",
      "run.succeeded",
    ]);
    expect(received.every((candidate) => candidate.metadata)).toBe(true);
  });

  it("fails and cancels after accepted large frames exceed the aggregate byte budget", async () => {
    const child = new FakeChild();
    const received: SeqlaneExecutionEvent[] = [];
    const diagnostics: unknown[] = [];
    const result = superviseRunner(child, request, {
      signalSource: null,
      onExecutionEvent: (candidate) => received.push(candidate),
      onProtocolError: (error) => diagnostics.push(error),
    });
    const largeOutput = (sequence: number): string =>
      encodeSeqlaneExecutionEvent(
        event(
          {
            type: "invocation.output",
            workId: "work-1",
            runId: "run-1",
            invocationId: `invocation-${sequence}`,
            policy: "transient",
            channel: "task",
            content: "x".repeat(8 * 1024 * 1024),
          },
          sequence,
        ),
      );

    const frames = [largeOutput(1), largeOutput(2), largeOutput(3)];
    expect(
      frames.every(
        (frame) => Buffer.byteLength(frame, "utf8") < 16 * 1024 * 1024,
      ),
    ).toBe(true);
    for (const frame of frames) child.emit("message", frame);

    await expect(result).resolves.toMatchObject({
      status: 1,
      failure: { type: "runner.failure" },
    });
    expect(received.map(({ type }) => type)).toEqual(["invocation.output"]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        message: "Runner supervisor message queue overflowed",
      }),
    );
    expect(child.messages).toContain(JSON.stringify({ type: "run.cancel" }));
  });

  it("releases frame bytes after sink handling completes", async () => {
    const child = new FakeChild();
    const receivedSequences: number[] = [];
    let notifyReceived: (() => void) | undefined;
    let received = new Promise<void>((resolve) => {
      notifyReceived = resolve;
    });
    const result = superviseRunner(child, request, {
      signalSource: null,
      onExecutionEvent: (candidate) => {
        receivedSequences.push(candidate.metadata.sequence);
        notifyReceived?.();
      },
    });
    const largeOutput = (sequence: number): string =>
      encodeSeqlaneExecutionEvent(
        event(
          {
            type: "invocation.output",
            workId: "work-1",
            runId: "run-1",
            invocationId: `invocation-${sequence}`,
            policy: "transient",
            channel: "task",
            content: "x".repeat(8 * 1024 * 1024),
          },
          sequence,
        ),
      );

    child.emit("message", largeOutput(1));
    await received;
    received = new Promise<void>((resolve) => {
      notifyReceived = resolve;
    });
    child.emit("message", largeOutput(2));
    await received;
    child.emitEvent({
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });

    await expect(result).resolves.toMatchObject({ status: 0 });
    expect(receivedSequences).toEqual([1, 2, 1]);
  });

  it("routes nonstring IPC frames to an infrastructure failure without serializing them", async () => {
    const child = new FakeChild();
    const diagnostics: unknown[] = [];
    const result = superviseRunner(child, request, {
      signalSource: null,
      onProtocolError: (error) => diagnostics.push(error),
    });

    child.emit("message", {
      type: "run.succeeded",
      workId: "work-1",
      runId: "run-1",
      output: null,
    });

    await expect(result).resolves.toMatchObject({
      status: 1,
      failure: {
        type: "runner.failure",
        message: "Invalid runner message",
      },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ message: "Invalid runner message" }),
    );
    expect(child.messages).toContain(JSON.stringify({ type: "run.cancel" }));
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

    await expect(result).resolves.toMatchObject({
      status: 130,
      cancellationSignal: "SIGINT",
    });
    expect(child.messages).toHaveLength(2);
    expect(child.messages[1]).toBe(JSON.stringify({ type: "run.cancel" }));
  });

  it("bounds repeated interaction cancellation when the worker is unresponsive", async () => {
    class UnresponsiveChild extends FakeChild {
      override send(
        message: string,
        callback?: (error: Error | null) => void,
      ): boolean {
        this.messages.push(message);
        callback?.(null);
        return true;
      }
    }
    const child = new UnresponsiveChild();
    let cancelRun: (() => void) | undefined;
    const result = superviseRunner(child, request, {
      signalSource: null,
      gracePeriodMs: 5,
      closeGracePeriodMs: 5,
      onInteractionRequested: (_interaction, _respond, cancel) => {
        cancelRun = cancel;
      },
    });

    child.emitEvent({
      type: "interaction.requested",
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      requestId: "request-1",
      subject: { type: "task", taskId: "task-1" },
      taskId: "task-1",
      kind: "user-input",
      questions: [
        {
          id: "region",
          prompt: "Choose a region",
          allowFreeText: false,
          options: [{ value: "eu-west", label: "Europe West" }],
        },
      ],
      expiresAt: "2026-10-24T12:00:00.000Z",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelRun).toBeTypeOf("function");
    cancelRun?.();
    cancelRun?.();

    const outcome = await result;
    expect(outcome).toMatchObject({
      status: 130,
      failure: {
        type: "runner.failure",
        message: "Runner did not close after forced cleanup",
      },
    });
    expect(outcome).not.toHaveProperty("cancellationSignal");
    expect(
      child.messages.filter(
        (message) =>
          message ===
          JSON.stringify({
            type: "run.cancel",
          }),
      ),
    ).toHaveLength(1);
    expect(child.killed).toBe(true);
  });
});
