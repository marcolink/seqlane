import type { SeqlaneExecutionEvent } from "@seqlane/events";
import { describe, expect, it } from "vitest";
import { StudioRegistry, StudioRegistryError } from "./registry.js";

function event(
  runId: string,
  sequence: number,
  type: SeqlaneExecutionEvent["type"],
): SeqlaneExecutionEvent {
  const metadata = {
    schemaVersion: 1 as const,
    eventId: `${runId}-${sequence}`,
    sequence,
    occurredAt: `2026-08-18T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
  };
  if (type === "run.started") {
    return { type, metadata, workId: `work-${runId}`, runId };
  }
  if (type === "run.succeeded") {
    return {
      type,
      metadata,
      workId: `work-${runId}`,
      runId,
      output: { ok: true },
    };
  }
  return {
    type: "invocation.created",
    metadata,
    workId: `work-${runId}`,
    runId,
    invocationId: `invocation-${runId}`,
    planNodeId: "node-a",
    subject: { type: "task", taskId: "task-a" },
    taskId: "task-a",
    kind: "task",
    label: "Task A",
    siblingOrder: 0,
    dependencyIds: [],
  };
}

function ingest(
  registry: StudioRegistry,
  runId: string,
  sequence: number,
  type: SeqlaneExecutionEvent["type"],
  workflowId = `workflow-${runId}`,
): void {
  registry.ingest({ workflowId, event: event(runId, sequence, type) });
}

describe("Studio registry", () => {
  it("stores and replays the canonical run.plan snapshot", () => {
    const registry = new StudioRegistry();
    const started: SeqlaneExecutionEvent = {
      type: "run.started",
      metadata: {
        schemaVersion: 1,
        eventId: "canonical-1",
        sequence: 1,
        occurredAt: "2026-08-22T00:00:00.000Z",
      },
      workId: "work-canonical",
      runId: "run-canonical",
    };
    const plan: SeqlaneExecutionEvent = {
      type: "run.plan",
      metadata: {
        schemaVersion: 1,
        eventId: "canonical-2",
        sequence: 2,
        occurredAt: "2026-08-22T00:00:01.000Z",
      },
      workId: "work-canonical",
      runId: "run-canonical",
      plan: {
        workflow: { id: "workflow-canonical" },
        nodes: [
          {
            planNodeId: "repeat:1",
            type: "repeat",
            label: "Repeat items",
            dependsOn: [],
            siblingOrder: 0,
            maximumIterations: 3,
          },
          {
            planNodeId: "repeat:1/body/task:1",
            type: "task",
            label: "Process item",
            taskId: "process-item",
            dependsOn: [],
            parentPlanNodeId: "repeat:1",
            siblingOrder: 0,
          },
        ],
      },
    };
    const succeeded: SeqlaneExecutionEvent = {
      type: "run.succeeded",
      metadata: {
        schemaVersion: 1,
        eventId: "canonical-3",
        sequence: 3,
        occurredAt: "2026-08-22T00:00:02.000Z",
      },
      workId: "work-canonical",
      runId: "run-canonical",
      output: null,
    };

    expect(
      registry.ingest({ workflowId: "workflow-canonical", event: started }),
    ).toEqual({
      accepted: true,
      cursor: 1,
    });
    expect(
      registry.ingest({ workflowId: "workflow-canonical", event: plan }),
    ).toEqual({
      accepted: true,
      cursor: 2,
    });
    expect(
      registry.ingest({ workflowId: "workflow-canonical", event: succeeded }),
    ).toEqual({
      accepted: true,
      cursor: 3,
    });

    expect(
      registry.replayAfter(0).events.map(({ event }) => event.type),
    ).toEqual(["run.started", "run.plan", "run.succeeded"]);
    expect(registry.getRun("run-canonical")).toMatchObject({
      plan: plan.plan,
      invocations: [],
      summary: { isIncomplete: false },
    });
  });

  it("marks no-plan runs incomplete without creating invocations", () => {
    const registry = new StudioRegistry();
    ingest(registry, "run-no-plan", 1, "run.started");
    ingest(registry, "run-no-plan", 2, "run.succeeded");

    expect(registry.getRun("run-no-plan")).toMatchObject({
      summary: { isIncomplete: true },
      invocations: [],
    });
  });

  it("isolates interleaved runs and snapshots", () => {
    const registry = new StudioRegistry();
    ingest(registry, "run-1", 1, "run.started");
    ingest(registry, "run-2", 1, "run.started");
    ingest(registry, "run-1", 2, "invocation.created");
    ingest(registry, "run-2", 2, "invocation.created");

    expect(registry.listRuns().runs).toHaveLength(2);
    expect(registry.getRun("run-1").invocations).toHaveLength(1);
    expect(registry.getRun("run-1").invocations[0]?.invocationId).toBe(
      "invocation-run-1",
    );
    expect(registry.getRun("run-2").invocations[0]?.invocationId).toBe(
      "invocation-run-2",
    );
  });

  it("preserves repeat iteration metadata in live snapshots", () => {
    const registry = new StudioRegistry();
    const identity = { workId: "work-iteration", runId: "run-iteration" };
    registry.ingest({
      workflowId: "workflow-iteration",
      event: {
        type: "run.started",
        ...identity,
        metadata: {
          schemaVersion: 1,
          eventId: "iteration-1",
          sequence: 1,
          occurredAt: "2026-08-18T00:00:00.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-iteration",
      event: {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-iteration-2",
        planNodeId: "repeat:1/body/task:1",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "Process item",
        parentInvocationId: "repeat-invocation",
        siblingOrder: 1,
        dependencyIds: [],
        iteration: 2,
        metadata: {
          schemaVersion: 1,
          eventId: "iteration-2",
          sequence: 2,
          occurredAt: "2026-08-18T00:00:01.000Z",
        },
      },
    });

    expect(registry.getRun("run-iteration").invocations[0]?.iteration).toBe(2);
  });

  it("retains bounded activity history in invocation snapshots", () => {
    const registry = new StudioRegistry();
    registry.ingest({
      workflowId: "workflow-activity",
      event: {
        type: "run.started",
        workId: "work-activity",
        runId: "run-activity",
        metadata: {
          schemaVersion: 1,
          eventId: "activity-1",
          sequence: 1,
          occurredAt: "2026-08-18T00:00:00.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-activity",
      event: {
        type: "invocation.created",
        workId: "work-activity",
        runId: "run-activity",
        invocationId: "invocation-activity",
        planNodeId: "task-1",
        subject: { type: "task", taskId: "task-1" },
        taskId: "task-1",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
        metadata: {
          schemaVersion: 1,
          eventId: "activity-2",
          sequence: 2,
          occurredAt: "2026-08-18T00:00:01.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-activity",
      event: {
        type: "invocation.activity",
        workId: "work-activity",
        runId: "run-activity",
        invocationId: "invocation-activity",
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
        input: { state: "omitted", reason: "policy" },
        output: { state: "omitted", reason: "policy" },
        metadata: {
          schemaVersion: 1,
          eventId: "activity-3",
          sequence: 3,
          occurredAt: "2026-08-18T00:00:02.000Z",
        },
      },
    });

    expect(registry.getRun("run-activity").invocations[0]?.activities).toEqual([
      expect.objectContaining({
        activityId: "call-1",
        output: { state: "omitted", reason: "policy" },
        occurredAt: "2026-08-18T00:00:02.000Z",
      }),
    ]);
  });

  it("retains aggregate tool usage after activity history is bounded", () => {
    const registry = new StudioRegistry();
    ingest(registry, "run-tool-usage", 1, "run.started");
    ingest(registry, "run-tool-usage", 2, "invocation.created");
    registry.ingest({
      workflowId: "workflow-run-tool-usage",
      event: {
        type: "invocation.activity",
        workId: "work-run-tool-usage",
        runId: "run-tool-usage",
        invocationId: "invocation-run-tool-usage",
        activityId: "legacy-call",
        kind: "tool",
        name: "legacy.tool",
        state: "succeeded",
        metadata: {
          schemaVersion: 1,
          eventId: "tool-usage-3",
          sequence: 3,
          occurredAt: "2026-08-18T00:00:02.000Z",
        },
      },
    });
    for (let sequence = 4; sequence <= 103; sequence += 1) {
      registry.ingest({
        workflowId: "workflow-run-tool-usage",
        event: {
          type: "invocation.activity",
          workId: "work-run-tool-usage",
          runId: "run-tool-usage",
          invocationId: "invocation-run-tool-usage",
          activityId: `recent-call-${sequence}`,
          kind: "tool",
          name: "recent.tool",
          state: "succeeded",
          metadata: {
            schemaVersion: 1,
            eventId: `tool-usage-${sequence}`,
            sequence,
            occurredAt: "2026-08-18T00:00:03.000Z",
          },
        },
      });
    }
    registry.ingest({
      workflowId: "workflow-run-tool-usage",
      event: {
        type: "invocation.activity",
        workId: "work-run-tool-usage",
        runId: "run-tool-usage",
        invocationId: "invocation-run-tool-usage",
        activityId: "skill-call",
        kind: "skill",
        name: "web-perf",
        state: "succeeded",
        metadata: {
          schemaVersion: 1,
          eventId: "tool-usage-104",
          sequence: 104,
          occurredAt: "2026-08-18T00:00:04.000Z",
        },
      },
    });

    const snapshot = registry.getRun("run-tool-usage") as unknown as {
      readonly toolUsage?: readonly {
        readonly name: string;
        readonly count: number;
      }[];
      readonly skillUsage?: readonly {
        readonly name: string;
        readonly count: number;
      }[];
    };
    expect(snapshot.toolUsage).toEqual([
      { name: "legacy.tool", count: 1 },
      { name: "recent.tool", count: 100 },
    ]);
    expect(snapshot.skillUsage).toEqual([{ name: "web-perf", count: 1 }]);
  });

  it("deduplicates exact events and marks observed sequence gaps", () => {
    const registry = new StudioRegistry();
    ingest(registry, "run-1", 1, "run.started");
    ingest(registry, "run-1", 3, "invocation.created");
    const duplicate = registry.ingest({
      workflowId: "workflow-run-1",
      event: event("run-1", 3, "invocation.created"),
    });

    expect(duplicate).toEqual({ accepted: false, cursor: 2 });
    expect(registry.listRuns().runs[0]?.isIncomplete).toBe(true);
    expect(() =>
      registry.ingest({
        workflowId: "other-workflow",
        event: event("run-1", 4, "invocation.created"),
      }),
    ).toThrow(StudioRegistryError);
  });

  it("requires canonical metadata and bounds replay", () => {
    const registry = new StudioRegistry();
    expect(() =>
      registry.ingest({
        workflowId: "workflow-run-1",
        event: {
          ...event("run-1", 1, "run.started"),
          metadata: undefined as never,
        },
      }),
    ).toThrow("Invalid Seqlane execution event");

    for (let index = 1; index <= 2_050; index += 1) {
      ingest(registry, `run-${index}`, 1, "run.started");
    }
    expect(registry.replayAfter(0).reset).toBe(true);
    expect(
      registry.replayAfter(registry.currentCursor - 1).events,
    ).toHaveLength(1);
  });

  it("retains no more than one hundred terminal projections", () => {
    const registry = new StudioRegistry();
    for (let index = 1; index <= 101; index += 1) {
      const runId = `run-${index}`;
      ingest(registry, runId, 1, "run.started");
      ingest(registry, runId, 2, "run.succeeded");
    }
    expect(registry.listRuns().runs).toHaveLength(100);
    expect(() => registry.getRun("run-1")).toThrow("not found");
    expect(registry.getRun("run-101").summary.state).toBe("succeeded");
  });

  it("projects validation identity, verdict, issues, and repeat continuation", () => {
    const registry = new StudioRegistry();
    const identity = { workId: "work-run-1", runId: "run-1" };
    registry.ingest({
      workflowId: "workflow-run-1",
      event: {
        type: "run.started",
        ...identity,
        metadata: {
          schemaVersion: 1,
          eventId: "run-1-1",
          sequence: 1,
          occurredAt: "2026-08-18T00:00:00.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-run-1",
      event: {
        type: "invocation.created",
        ...identity,
        invocationId: "validation-gate",
        planNodeId: "repeat:1/validation.gate:1",
        subject: {
          type: "validation-gate",
          planNodeId: "repeat:1/validation.gate:1",
        },
        kind: "validation",
        label: "Repeat postcondition",
        siblingOrder: 0,
        dependencyIds: [],
        metadata: {
          schemaVersion: 1,
          eventId: "run-1-2",
          sequence: 2,
          occurredAt: "2026-08-18T00:00:01.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-run-1",
      event: {
        type: "invocation.result",
        ...identity,
        invocationId: "validation-gate",
        result: {
          state: "present",
          value: {
            success: false,
            issues: [{ code: "missing", message: "Missing summary" }],
            evidence: { summary: null },
          },
        },
        metadata: {
          schemaVersion: 1,
          eventId: "run-1-3",
          sequence: 3,
          occurredAt: "2026-08-18T00:00:02.000Z",
        },
      },
    });
    registry.ingest({
      workflowId: "workflow-run-1",
      event: {
        type: "invocation.succeeded",
        ...identity,
        invocationId: "validation-gate",
        metadata: {
          schemaVersion: 1,
          eventId: "run-1-4",
          sequence: 4,
          occurredAt: "2026-08-18T00:00:03.000Z",
        },
      },
    });

    expect(registry.getRun("run-1").invocations[0]).toMatchObject({
      state: "succeeded",
      validation: {
        validationNodeId: "repeat:1/validation.gate:1",
        sourceId: "repeat:1/validation.gate:1",
        sourceType: "validation-gate",
        verdict: "failed",
        continued: true,
        issues: [{ code: "missing" }],
        evidence: { state: "present", value: { summary: null } },
      },
    });
  });

  it("keeps an invocation succeeded after workspace release progress", () => {
    const registry = new StudioRegistry();
    const identity = { workId: "work-1", runId: "run-1" };
    const metadata = (sequence: number) => ({
      schemaVersion: 1 as const,
      eventId: `event-${sequence}`,
      sequence,
      occurredAt: "2026-08-18T00:00:00.000Z",
    });

    registry.ingest({
      workflowId: "workflow-1",
      event: { type: "run.started", ...identity, metadata: metadata(1) },
    });
    registry.ingest({
      workflowId: "workflow-1",
      event: {
        type: "invocation.created",
        ...identity,
        metadata: metadata(2),
        invocationId: "task",
        planNodeId: "task",
        subject: { type: "task", taskId: "task" },
        taskId: "task",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      },
    });
    registry.ingest({
      workflowId: "workflow-1",
      event: {
        type: "invocation.succeeded",
        ...identity,
        metadata: metadata(3),
        invocationId: "task",
      },
    });
    registry.ingest({
      workflowId: "workflow-1",
      event: {
        type: "invocation.progress",
        ...identity,
        metadata: metadata(4),
        invocationId: "task",
        state: "active",
        phase: "workspace_released",
        workspace: "exclusive",
      },
    });

    expect(registry.getRun("run-1").invocations[0]?.state).toBe("succeeded");
  });
});
