// @test-scope ./operations.ts
// @test-scope ./validation.ts
// @test-scope ./telemetry-span-snapshot.ts
import { describe, expect, it } from "vitest";
import {
  operationalHealthSchema,
  operationalReadinessSchema,
  operationalRunCancelRequestSchema,
  operationalRunCancelSchema,
  operationalRunEventsRequestSchema,
  operationalRunEventsSchema,
  operationalRunListRequestSchema,
  operationalRunListSchema,
  operationalRunReferenceSchema,
  operationalRunStartRequestSchema,
  operationalRunStatusSchema,
  operationalTraceInspectionSchema,
  operationalWorkflowDetailSchema,
  operationalWorkflowListSchema,
} from "./index.js";

const plan = {
  workflow: { id: "workflow-1" },
  nodes: [
    {
      planNodeId: "task-1",
      type: "task" as const,
      label: "Task 1",
      taskId: "task-1",
      dependsOn: [],
      siblingOrder: 0,
    },
  ],
};

const workflow = {
  id: "workflow-1",
  key: "review",
  input: { schema: { type: "object" }, description: "Input" },
  output: { schema: { type: "string" }, description: "Output" },
  plan,
};

const runSummary = {
  workId: "work-1",
  runId: "run-1",
  workflowKey: "review",
  status: "succeeded" as const,
  createdAt: "2026-10-22T12:00:00.000Z",
  updatedAt: "2026-10-22T12:00:01.000Z",
};

const startedEvent = {
  type: "run.started" as const,
  metadata: {
    schemaVersion: 1 as const,
    eventId: "event-1",
    sequence: 1,
    occurredAt: "2026-10-22T12:00:00.000Z",
  },
  workId: "work-1",
  runId: "run-1",
};

const eventAt = (sequence: number, eventId = `event-${sequence}`) => ({
  ...startedEvent,
  metadata: { ...startedEvent.metadata, eventId, sequence },
});

describe("hosted operational DTOs", () => {
  it("round-trips health, readiness, workflow list and detail DTOs", () => {
    expect(operationalHealthSchema.parse({ version: 1, status: "ok" })).toEqual(
      { version: 1, status: "ok" },
    );
    expect(
      operationalReadinessSchema.parse({
        version: 1,
        status: "ready",
        checks: [{ id: "storage", status: "ready" }],
      }).checks[0]?.id,
    ).toBe("storage");
    expect(
      operationalWorkflowListSchema.parse({ version: 1, workflows: [workflow] })
        .workflows[0]?.plan,
    ).toEqual(plan);
    expect(
      operationalWorkflowDetailSchema.parse({ version: 1, workflow }).workflow,
    ).toEqual(workflow);
  });

  it("validates start, run reference, status and bounded run pagination", () => {
    expect(
      operationalRunStartRequestSchema.parse({
        version: 1,
        input: { falseValue: false, zero: 0, empty: "", nested: [null, true] },
        runtime: { id: "opencode", workspace: "/workspace" },
      }).input,
    ).toEqual({ falseValue: false, zero: 0, empty: "", nested: [null, true] });
    expect(
      operationalRunReferenceSchema.parse({
        version: 1,
        workId: "work-1",
        runId: "run-1",
        status: "queued",
      }).status,
    ).toBe("queued");

    expect(
      operationalRunStatusSchema.parse({
        version: 1,
        ...runSummary,
        output: "done",
        completeness: { inspection: "complete" },
      }).output,
    ).toBe("done");
    expect(operationalRunListRequestSchema.parse({ version: 1 }).limit).toBe(
      50,
    );
    expect(
      operationalRunListSchema.parse({ version: 1, runs: [runSummary] }).runs,
    ).toHaveLength(1);
  });

  it("preserves ordered canonical events, explicit gaps and run status", () => {
    const response = operationalRunEventsSchema.parse({
      version: 1,
      runId: "run-1",
      afterSequence: 0,
      events: [{ sequence: 3, event: eventAt(3) }],
      nextSequence: 3,
      gap: { fromSequence: 1, toSequence: 2 },
      status: "interrupted",
      completeness: { inspection: "incomplete" },
    });
    expect(response.events[0]?.event).toEqual(eventAt(3));
    expect(response.status).toBe("interrupted");
    expect(
      operationalRunEventsRequestSchema.parse({ version: 1 }).afterSequence,
    ).toBe(0);
  });

  it("accepts only an adjacent trailing gap and marks it incomplete", () => {
    const response = operationalRunEventsSchema.parse({
      version: 1,
      runId: "run-1",
      afterSequence: 0,
      events: [
        { sequence: 1, event: eventAt(1) },
        { sequence: 2, event: eventAt(2) },
      ],
      nextSequence: 2,
      gap: { fromSequence: 3, toSequence: 4 },
      status: "succeeded",
      completeness: { inspection: "incomplete" },
    });
    expect(response.gap).toEqual({ fromSequence: 3, toSequence: 4 });

    expect(
      operationalRunEventsSchema.safeParse({
        ...response,
        gap: { fromSequence: 4, toSequence: 4 },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...response,
        completeness: { inspection: "complete" },
      }).success,
    ).toBe(false);
  });

  it("accepts an empty page with a trailing gap after its cursor", () => {
    expect(
      operationalRunEventsSchema.parse({
        version: 1,
        runId: "run-1",
        afterSequence: 4,
        events: [],
        nextSequence: 4,
        gap: { fromSequence: 5, toSequence: 6 },
        status: "interrupted",
        completeness: { inspection: "incomplete" },
      }).gap,
    ).toEqual({ fromSequence: 5, toSequence: 6 });
  });

  it("validates idempotent cancel and correlated trace inspection", () => {
    expect(
      operationalRunCancelRequestSchema.parse({ version: 1, runId: "run-1" })
        .runId,
    ).toBe("run-1");
    expect(
      operationalRunCancelSchema.parse({
        version: 1,
        runId: "run-1",
        status: "running",
        cancellationRequested: true,
      }).cancellationRequested,
    ).toBe(true);
    expect(
      operationalTraceInspectionSchema.parse({
        version: 1,
        runId: "run-1",
        traceId: "0123456789abcdef0123456789abcdef",
        spans: [],
        completeness: { inspection: "complete" },
      }).droppedRecords,
    ).toBe(0);
  });

  it("rejects unknown fields, invalid bounds and mismatched event sequences", () => {
    expect(() =>
      operationalHealthSchema.parse({
        version: 1,
        status: "ok",
        engine: "effect",
      }),
    ).toThrow();
    expect(() =>
      operationalRunStartRequestSchema.parse({
        version: 1,
        input: null,
        runId: "",
      }),
    ).toThrow();
    expect(() =>
      operationalRunListRequestSchema.parse({ version: 1, limit: 101 }),
    ).toThrow();
    expect(() =>
      operationalRunEventsSchema.parse({
        version: 1,
        runId: "run-1",
        afterSequence: 0,
        events: [{ sequence: 2, event: startedEvent }],
        nextSequence: 2,
        status: "running",
        completeness: { inspection: "complete" },
      }),
    ).toThrow(/sequence/i);
    expect(() =>
      operationalTraceInspectionSchema.parse({
        version: 1,
        runId: "run-1",
        traceId: "0".repeat(32),
        spans: [],
        completeness: { inspection: "complete" },
      }),
    ).toThrow();
  });

  it("rejects unordered, duplicate, foreign-run, and uncovered events", () => {
    const base = {
      version: 1 as const,
      runId: "run-1",
      afterSequence: 0,
      status: "running" as const,
      completeness: { inspection: "incomplete" as const },
    };
    const parse = (
      events: Array<{ sequence: number; event: typeof startedEvent }>,
    ) =>
      operationalRunEventsSchema.safeParse({
        ...base,
        events,
        nextSequence: events.at(-1)?.sequence ?? 0,
      });

    expect(
      parse([
        { sequence: 2, event: eventAt(2) },
        { sequence: 1, event: eventAt(1) },
      ]).success,
    ).toBe(false);
    expect(
      parse([
        { sequence: 1, event: eventAt(1) },
        { sequence: 1, event: eventAt(1, "event-copy") },
      ]).success,
    ).toBe(false);
    expect(
      parse([
        { sequence: 1, event: eventAt(1, "duplicate-id") },
        { sequence: 2, event: eventAt(2, "duplicate-id") },
      ]).success,
    ).toBe(false);
    expect(
      parse([{ sequence: 1, event: { ...eventAt(1), runId: "run-2" } }])
        .success,
    ).toBe(false);
    expect(parse([{ sequence: 3, event: eventAt(3) }]).success).toBe(false);
    expect(
      parse([
        { sequence: 1, event: eventAt(1) },
        { sequence: 3, event: eventAt(3) },
      ]).success,
    ).toBe(false);
  });

  it("rejects cursor rollback, invalid gaps, inconsistent completeness, and false terminal events", () => {
    const base = {
      version: 1 as const,
      runId: "run-1",
      afterSequence: 4,
      events: [],
      nextSequence: 4,
      status: "interrupted" as const,
      completeness: { inspection: "incomplete" as const },
    };
    expect(
      operationalRunEventsSchema.safeParse({ ...base, nextSequence: 3 })
        .success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        events: [{ sequence: 5, event: eventAt(5) }],
        nextSequence: 4,
        gap: { fromSequence: 5, toSequence: 5 },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        gap: { fromSequence: 4, toSequence: 5 },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        gap: { fromSequence: 6, toSequence: 5 },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        events: [{ sequence: 7, event: eventAt(7) }],
        nextSequence: 7,
        gap: { fromSequence: 5, toSequence: 5 },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        completeness: {
          inspection: "complete",
          storageError: { category: "RuntimeError", message: "lost" },
        },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        status: "running",
        completeness: { inspection: "complete" },
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        terminalEvent: startedEvent,
      }).success,
    ).toBe(false);
    expect(
      operationalRunEventsSchema.safeParse({
        ...base,
        status: "succeeded",
        terminalEvent: {
          type: "run.succeeded",
          metadata: { ...startedEvent.metadata, eventId: "done", sequence: 5 },
          workId: "work-1",
          runId: "run-2",
          output: false,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts a correlated terminal event and preserves complete JSON values", () => {
    const terminalEvent = {
      type: "run.succeeded" as const,
      metadata: {
        ...startedEvent.metadata,
        eventId: "event-done",
        sequence: 5,
      },
      workId: "work-1",
      runId: "run-1",
      output: {
        result: false,
        count: 0,
        text: "",
        nested: [null, { ok: true }],
      },
    };
    const parsed = operationalRunEventsSchema.parse({
      version: 1,
      runId: "run-1",
      afterSequence: 4,
      events: [{ sequence: 5, event: terminalEvent }],
      nextSequence: 5,
      status: "succeeded",
      completeness: { inspection: "complete" },
      terminalEvent,
    });
    expect(parsed.terminalEvent).toEqual(terminalEvent);
    expect(
      operationalRunEventsSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
  });

  it("rejects active run status with complete inspection", () => {
    expect(() =>
      operationalRunStatusSchema.parse({
        version: 1,
        ...runSummary,
        status: "running",
        completeness: { inspection: "complete" },
      }),
    ).toThrow(/active runs/i);
  });
});
