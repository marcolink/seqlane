import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import { describe, expect, it } from "vitest";
import {
  formatInvocationContext,
  invocationContextMap,
} from "./invocation-context.js";

const baseInvocation = {
  planNodeId: "node-a",
  taskId: "process-item",
  kind: "task" as const,
  label: "Process item",
  state: "succeeded" as const,
  dependencyIds: [],
  output: { persistent: [] },
};

const snapshot: StudioRunSnapshot = {
  summary: {
    workId: "work-1",
    runId: "run-1",
    workflowId: "workflow-1",
    state: "active",
    isIncomplete: false,
    activeInvocationCount: 0,
    lastEventSequence: 1,
  },
  cursor: 1,
  plan: {
    workflow: { id: "workflow-1" },
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
        dependsOn: [],
        parentPlanNodeId: "repeat:1",
        siblingOrder: 0,
      },
    ],
  },
  invocations: [
    {
      invocationId: "repeat-invocation",
      planNodeId: "repeat:1",
      taskId: "repeat:1",
      kind: "loop",
      label: "Repeat items",
      siblingOrder: 0,
      dependencyIds: [],
      state: "active",
      output: { persistent: [] },
    },
    {
      ...baseInvocation,
      invocationId: "iteration-1",
      planNodeId: "repeat:1/body/task:1",
      parentInvocationId: "repeat-invocation",
      siblingOrder: 0,
      iteration: 1,
    },
    {
      ...baseInvocation,
      invocationId: "iteration-2",
      planNodeId: "repeat:1/body/task:1",
      parentInvocationId: "repeat-invocation",
      siblingOrder: 1,
      iteration: 2,
    },
  ],
};

describe("invocation context", () => {
  it("labels repeated nested instances with iteration and scope", () => {
    const contexts = invocationContextMap(snapshot);

    expect(formatInvocationContext(contexts.get("iteration-1"))).toBe(
      "Iteration 1/3 · in Repeat items",
    );
    expect(formatInvocationContext(contexts.get("iteration-2"))).toBe(
      "Iteration 2/3 · in Repeat items",
    );
  });

  it("labels repeated instances without iteration metadata", () => {
    const contexts = invocationContextMap({
      ...snapshot,
      plan: undefined,
      invocations: [
        { ...baseInvocation, invocationId: "first", siblingOrder: 0 },
        { ...baseInvocation, invocationId: "second", siblingOrder: 1 },
      ],
    });

    expect(formatInvocationContext(contexts.get("first"))).toBe("Instance 1/2");
    expect(formatInvocationContext(contexts.get("second"))).toBe(
      "Instance 2/2",
    );
  });
});
