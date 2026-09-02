import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import { invocationProgress } from "./invocation-progress.js";

const snapshot = {
  summary: {
    workId: "work-1",
    runId: "run-1",
    workflowId: "workflow-1",
    state: "active" as const,
    isIncomplete: false,
    activeInvocationCount: 2,
    lastEventSequence: 12,
  },
  cursor: 12,
  invocations: [
    {
      invocationId: "queued",
      planNodeId: "node-1",
      taskId: "task-1",
      kind: "task" as const,
      label: "Queued task",
      siblingOrder: 0,
      dependencyIds: [],
      state: "queued" as const,
      output: { persistent: [] },
    },
    {
      invocationId: "active",
      planNodeId: "node-2",
      taskId: "task-2",
      kind: "task" as const,
      label: "Active task",
      siblingOrder: 1,
      dependencyIds: [],
      state: "active" as const,
      output: { persistent: [] },
    },
    {
      invocationId: "retrying",
      planNodeId: "node-3",
      taskId: "task-3",
      kind: "task" as const,
      label: "Retrying task",
      siblingOrder: 2,
      dependencyIds: [],
      state: "retrying" as const,
      output: { persistent: [] },
    },
    {
      invocationId: "succeeded",
      planNodeId: "node-4",
      taskId: "task-4",
      kind: "task" as const,
      label: "Succeeded task",
      siblingOrder: 3,
      dependencyIds: [],
      state: "succeeded" as const,
      output: { persistent: [] },
    },
    {
      invocationId: "failed",
      planNodeId: "node-5",
      taskId: "task-5",
      kind: "task" as const,
      label: "Failed task",
      siblingOrder: 4,
      dependencyIds: [],
      state: "failed" as const,
      output: { persistent: [] },
    },
  ],
} satisfies StudioRunSnapshot;

describe("invocation progress", () => {
  it("counts finished work and exposes every currently running invocation", () => {
    const progress = invocationProgress(snapshot);

    expect(progress.total).toBe(5);
    expect(progress.finished).toBe(2);
    expect(progress.percent).toBe(40);
    expect(progress.current.map(({ invocationId }) => invocationId)).toEqual([
      "active",
      "retrying",
    ]);
  });

  it("returns an empty progress state before invocations are created", () => {
    const progress = invocationProgress({ ...snapshot, invocations: [] });

    expect(progress).toMatchObject({
      total: 0,
      finished: 0,
      percent: 0,
      current: [],
    });
  });
});
