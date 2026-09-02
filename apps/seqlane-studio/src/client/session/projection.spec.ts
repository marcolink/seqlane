import type { StudioExecutionEvent } from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  createBrowserState,
  displayValueText,
  formatEventDuration,
  refreshBrowserState,
  setRunSnapshot,
  timelineAnnotation,
} from "./projection.js";

function event(
  sequence: number,
  event: Record<string, unknown>,
  cursor = sequence,
  occurredAt = "2026-08-18T00:00:00.000Z",
): { cursor: number; workflowId: string; event: StudioExecutionEvent } {
  return {
    cursor,
    workflowId: "workflow-1",
    event: {
      ...event,
      metadata: {
        schemaVersion: 1,
        eventId: `event-${sequence}`,
        sequence,
        occurredAt,
      },
    } as StudioExecutionEvent,
  };
}

const identity = {
  workId: "work-1",
  runId: "run-1",
};

describe("Studio browser projection", () => {
  it("projects a complete nested static Plan before invocation events", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "run.plan",
        ...identity,
        plan: {
          workflow: { id: "workflow-1", version: "1" },
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
      }),
    );

    const snapshot = state.snapshots.get("run-1");
    expect(snapshot?.plan?.nodes.map(({ planNodeId }) => planNodeId)).toEqual([
      "repeat:1",
      "repeat:1/body/task:1",
    ]);
    expect(snapshot?.invocations).toEqual([]);
    expect(snapshot?.summary.isIncomplete).toBe(false);
  });

  it("marks a run without run.plan incomplete", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, { type: "run.succeeded", ...identity, output: null }),
    );

    expect(state.snapshots.get("run-1")?.summary.isIncomplete).toBe(true);
  });

  it("keeps repeated Plan nodes as separate invocation instances", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-1",
        planNodeId: "node-a",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "First",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    state = applyStreamEvent(
      state,
      event(3, {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-2",
        planNodeId: "node-a",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "Second",
        siblingOrder: 1,
        dependencyIds: ["invocation-1"],
      }),
    );
    const snapshot = state.snapshots.get("run-1");
    expect(
      snapshot?.invocations.map(({ invocationId }) => invocationId),
    ).toEqual(["invocation-1", "invocation-2"]);
    expect(snapshot?.invocations[1]?.dependencyIds).toEqual(["invocation-1"]);
    expect(snapshot?.invocations.map(({ planNodeId }) => planNodeId)).toEqual([
      "node-a",
      "node-a",
    ]);
  });

  it("preserves repeat iteration metadata on invocation snapshots", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
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
      }),
    );

    expect(state.snapshots.get("run-1")?.invocations[0]?.iteration).toBe(2);
  });

  it("applies state updates without losing protected display values", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-1",
        planNodeId: "node-a",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    state = applyStreamEvent(
      state,
      event(3, {
        type: "invocation.input",
        ...identity,
        invocationId: "invocation-1",
        input: { state: "redacted" },
      }),
    );
    state = applyStreamEvent(
      state,
      event(4, {
        type: "invocation.started",
        ...identity,
        invocationId: "invocation-1",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
      }),
    );

    const invocation = state.snapshots.get("run-1")?.invocations[0];
    expect(invocation?.state).toBe("active");
    expect(displayValueText(invocation?.input)).toEqual({
      label: "Redacted",
      detail: "Raw value is protected.",
    });
    expect(displayValueText(invocation?.input).raw).toBeUndefined();
  });

  it("preserves replayed events when the initial snapshot refresh completes", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    const summary = state.runs.get("run-1");
    const snapshot = state.snapshots.get("run-1");
    if (summary === undefined || snapshot === undefined) {
      throw new Error("expected the run.started event to create a snapshot");
    }

    const refreshed = refreshBrowserState(
      state,
      { runs: [summary], cursor: 1 },
      snapshot,
    );

    expect(refreshed.timeline.get("run-1")).toHaveLength(1);
    expect(refreshed.cursor).toBe(1);
  });

  it("keeps a streamed Plan when an older initial run snapshot resolves", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    const staleSnapshot = state.snapshots.get("run-1");
    if (staleSnapshot === undefined) {
      throw new Error("expected the run.started event to create a snapshot");
    }

    state = applyStreamEvent(
      state,
      event(2, {
        type: "run.plan",
        ...identity,
        plan: {
          workflow: { id: "workflow-1" },
          nodes: [
            {
              planNodeId: "node-a",
              type: "task",
              label: "Task",
              dependsOn: [],
              siblingOrder: 0,
            },
          ],
        },
      }),
    );

    state = setRunSnapshot(state, staleSnapshot);

    expect(
      state.snapshots
        .get("run-1")
        ?.plan?.nodes.map(({ planNodeId }) => planNodeId),
    ).toEqual(["node-a"]);
  });

  it("formats elapsed time between ordered runner events", () => {
    const first = event(1, { type: "run.started", ...identity });
    const second = event(
      2,
      {
        type: "run.heartbeat",
        ...identity,
        activeInvocationIds: [],
        elapsedMs: 1250,
      },
      2,
      "2026-08-18T00:00:01.250Z",
    );

    expect(formatEventDuration(undefined, first)).toBe("Start");
    expect(formatEventDuration(first, second)).toBe("+1.25 s");
  });

  it("annotates invocation events with their node and invocation identity", () => {
    const invocation = {
      invocationId: "invocation-123456789",
      planNodeId: "node-a",
      taskId: "task-a",
      kind: "task" as const,
      label: "Prepare",
      siblingOrder: 0,
      dependencyIds: [],
      state: "active" as const,
      output: { persistent: [] },
    };
    const stream = event(2, {
      type: "invocation.started",
      ...identity,
      invocationId: invocation.invocationId,
      subject: { type: "task", taskId: invocation.taskId },
      taskId: invocation.taskId,
    });

    expect(timelineAnnotation(stream.event, [invocation])).toEqual({
      label: "Prepare",
      invocationId: "invocation-123456789",
    });
    expect(
      timelineAnnotation(event(1, { type: "run.started", ...identity }).event, [
        invocation,
      ]),
    ).toEqual({ label: "Run" });
  });

  it("preserves a failed repeat verdict while keeping the invocation succeeded", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
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
      }),
    );
    state = applyStreamEvent(
      state,
      event(3, {
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
      }),
    );
    state = applyStreamEvent(
      state,
      event(4, {
        type: "invocation.succeeded",
        ...identity,
        invocationId: "validation-gate",
      }),
    );

    expect(state.snapshots.get("run-1")?.invocations[0]).toMatchObject({
      state: "succeeded",
      validation: {
        verdict: "failed",
        continued: true,
        issues: [{ code: "missing" }],
      },
    });
  });

  it("keeps an invocation succeeded after workspace release progress", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "invocation.created",
        ...identity,
        invocationId: "task",
        planNodeId: "task",
        subject: { type: "task", taskId: "task" },
        taskId: "task",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    state = applyStreamEvent(
      state,
      event(3, {
        type: "invocation.succeeded",
        ...identity,
        invocationId: "task",
      }),
    );
    state = applyStreamEvent(
      state,
      event(4, {
        type: "invocation.progress",
        ...identity,
        invocationId: "task",
        state: "active",
        phase: "workspace_released",
        workspace: "exclusive",
      }),
    );

    expect(state.snapshots.get("run-1")?.invocations[0]?.state).toBe(
      "succeeded",
    );
  });

  it("projects bounded tool activity onto the invocation snapshot", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-1",
        planNodeId: "node-a",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    state = applyStreamEvent(
      state,
      event(3, {
        type: "invocation.activity",
        ...identity,
        invocationId: "invocation-1",
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
      }),
    );
    state = applyStreamEvent(
      state,
      event(4, {
        type: "invocation.activity",
        ...identity,
        invocationId: "invocation-1",
        activityId: "skill-call-1",
        kind: "skill",
        name: "web-perf",
        state: "succeeded",
        activityMetadata: { state: "present", value: { name: "web-perf" } },
        startedAt: 100,
        endedAt: 125,
      }),
    );

    expect(state.snapshots.get("run-1")?.invocations[0]?.activities).toEqual([
      {
        activityId: "call-1",
        kind: "tool",
        name: "filesystem.read",
        state: "succeeded",
        occurredAt: "2026-08-18T00:00:00.000Z",
      },
      expect.objectContaining({
        activityId: "skill-call-1",
        kind: "skill",
        name: "web-perf",
        state: "succeeded",
        occurredAt: "2026-08-18T00:00:00.000Z",
        activityMetadata: { state: "present", value: { name: "web-perf" } },
        startedAt: 100,
        endedAt: 125,
      }),
    ]);
    expect([...(state.toolUsage.get("run-1")?.entries() ?? [])]).toEqual([
      ["filesystem.read", 1],
    ]);
    expect([...(state.skillUsage.get("run-1")?.entries() ?? [])]).toEqual([
      ["web-perf", 1],
    ]);
    expect(
      state.snapshots.get("run-1")?.invocations[0]?.activities?.[1],
    ).toEqual(
      expect.objectContaining({
        kind: "skill",
        activityMetadata: { state: "present", value: { name: "web-perf" } },
        startedAt: 100,
        endedAt: 125,
      }),
    );
  });

  it("restores aggregate tool usage and merges events after a snapshot cursor", () => {
    let state = createBrowserState();
    state = applyStreamEvent(
      state,
      event(1, { type: "run.started", ...identity }),
    );
    state = applyStreamEvent(
      state,
      event(2, {
        type: "invocation.created",
        ...identity,
        invocationId: "invocation-1",
        planNodeId: "node-a",
        subject: { type: "task", taskId: "task-a" },
        taskId: "task-a",
        kind: "task",
        label: "Task",
        siblingOrder: 0,
        dependencyIds: [],
      }),
    );
    state = applyStreamEvent(
      state,
      event(
        3,
        {
          type: "invocation.activity",
          ...identity,
          invocationId: "invocation-1",
          activityId: "call-1",
          kind: "tool",
          name: "recent.tool",
          state: "succeeded",
        },
        3,
      ),
    );

    const current = state.snapshots.get("run-1");
    if (current === undefined) throw new Error("Expected run snapshot");
    state = setRunSnapshot(state, {
      ...current,
      cursor: 2,
      summary: { ...current.summary, lastEventSequence: 2 },
      toolUsage: [
        { name: "legacy.tool", count: 4 },
        { name: "recent.tool", count: 2 },
      ],
    });

    expect([...(state.toolUsage.get("run-1")?.entries() ?? [])]).toEqual([
      ["legacy.tool", 4],
      ["recent.tool", 3],
    ]);
  });
});
