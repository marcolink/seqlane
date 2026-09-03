import { describe, expect, expectTypeOf, it } from "vitest";
import type { SeqlaneExecutionEvent } from "./contracts.js";
import {
  isJsonValue,
  isSeqlaneExecutionEvent,
  type ReadonlySchemaOutput,
  seqlaneExecutionEventSchema,
} from "./validation.js";

const metadata = {
  schemaVersion: 1 as const,
  eventId: "event-1",
  sequence: 1,
  occurredAt: "2026-08-22T12:00:00.000Z",
};

const started = {
  type: "run.started" as const,
  metadata,
  workId: "work-1",
  runId: "run-1",
};

describe("event validation schemas", () => {
  it("derives the public event contract from the canonical schema", () => {
    expectTypeOf<SeqlaneExecutionEvent>().toEqualTypeOf<
      ReadonlySchemaOutput<typeof seqlaneExecutionEventSchema>
    >();
  });

  it("preserves the JSON contract for finite, acyclic values", () => {
    expect(isJsonValue({ nested: [null, true, 2, "value"] })).toBe(true);
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "value";
    expect(isJsonValue(sparse)).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(isJsonValue(cycle)).toBe(false);
  });

  it("rejects unknown fields and explicitly undefined optional fields", () => {
    expect(isSeqlaneExecutionEvent({ ...started, extra: true })).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, traceparent: undefined },
      }),
    ).toBe(false);
  });

  it("accepts workspace-admission progress without permission metadata", () => {
    expect(
      isSeqlaneExecutionEvent({
        type: "invocation.progress",
        metadata,
        workId: "work-1",
        runId: "run-1",
        invocationId: "invocation-1",
        state: "waiting",
        phase: "admission",
        waitingReason: "workspace_unavailable",
        workspace: "exclusive",
        blockingInvocationId: "invocation-0",
      }),
    ).toBe(true);
  });

  it("accepts portable model selection metrics and rejects malformed selections", () => {
    const output = {
      type: "invocation.output" as const,
      metadata,
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      policy: "persistent" as const,
      channel: "task" as const,
      content: "Task completed",
      metrics: {
        modelSelection: {
          model: { provider: "openai", model: "gpt-5.2" },
          reasoning: "high" as const,
        },
      },
    };

    expect(isSeqlaneExecutionEvent(output)).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        ...output,
        metrics: {
          modelSelection: {
            model: { provider: "openai", model: "gpt-5.2" },
            reasoning: "unsupported",
          },
        },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...output,
        metrics: {
          modelSelection: {
            model: { provider: "openai", model: "gpt-5.2" },
            nativePayload: { secret: true },
          },
        },
      }),
    ).toBe(false);
  });

  it("preserves canonical timestamp, trace, and integer boundaries", () => {
    expect(isSeqlaneExecutionEvent(started)).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, occurredAt: "2026-08-22T12:00:00.00Z" },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, occurredAt: "2026-08-22T12:00:00.000+00:00" },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: { ...metadata, occurredAt: "2026-02-30T12:00:00.000Z" },
      }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({
        ...started,
        metadata: {
          ...metadata,
          sequence: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toBe(false);
  });

  it("enforces cross-field invocation and plan invariants", () => {
    expect(
      isSeqlaneExecutionEvent({
        type: "invocation.started",
        metadata,
        workId: "work-1",
        runId: "run-1",
        invocationId: "invocation-1",
        subject: { type: "validator", validatorId: "validator-1" },
        taskId: "task-1",
      }),
    ).toBe(false);

    expect(
      isSeqlaneExecutionEvent({
        type: "run.plan",
        metadata,
        workId: "work-1",
        runId: "run-1",
        plan: {
          workflow: { id: "workflow-1" },
          nodes: [
            {
              planNodeId: "task-1",
              type: "task",
              label: "Task",
              dependsOn: ["task-1"],
              siblingOrder: 0,
              maximumIterations: 1,
            },
          ],
        },
      }),
    ).toBe(false);

    expect(
      isSeqlaneExecutionEvent({
        type: "run.plan",
        metadata,
        workId: "work-1",
        runId: "run-1",
        plan: {
          workflow: { id: "workflow-1" },
          nodes: [
            {
              planNodeId: "local-1",
              type: "task",
              label: "local",
              taskId: "local-task",
              execution: "local",
              dependsOn: [],
              siblingOrder: 0,
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        type: "run.plan",
        metadata,
        workId: "work-1",
        runId: "run-1",
        plan: {
          workflow: { id: "workflow-1" },
          nodes: [
            {
              planNodeId: "local-1",
              type: "task",
              label: "local",
              taskId: "local-task",
              execution: "local",
              session: { type: "isolated" },
              dependsOn: [],
              siblingOrder: 0,
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("validates bounded tool activity events", () => {
    const activity = {
      type: "invocation.activity" as const,
      metadata,
      workId: "work-1",
      runId: "run-1",
      invocationId: "invocation-1",
      activityId: "call-1",
      kind: "tool" as const,
      name: "filesystem.read",
      state: "succeeded" as const,
      input: { state: "omitted" as const, reason: "policy" as const },
      output: { state: "omitted" as const, reason: "policy" as const },
    };

    expect(isSeqlaneExecutionEvent(activity)).toBe(true);
    expect(
      isSeqlaneExecutionEvent({
        ...activity,
        kind: "skill",
        activityMetadata: { state: "present", value: { name: "web-perf" } },
        startedAt: 100,
        endedAt: 125,
      }),
    ).toBe(true);
    expect(
      isSeqlaneExecutionEvent({ ...activity, name: "x".repeat(257) }),
    ).toBe(false);
    expect(
      isSeqlaneExecutionEvent({ ...activity, message: "x".repeat(2_001) }),
    ).toBe(false);
  });
});
