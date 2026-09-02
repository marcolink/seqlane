import { describe, expect, it } from "vitest";
import { graphFor } from "./graph-layout.js";
import {
  applyGraphMeasurements,
  measurementsFromNodeChanges,
} from "./graph-measurements.js";

const graph = graphFor(
  {
    summary: {
      workId: "work-1",
      runId: "run-1",
      workflowId: "workflow-1",
      state: "active",
      isIncomplete: false,
      activeInvocationCount: 0,
      lastEventSequence: 2,
    },
    cursor: 2,
    plan: {
      workflow: { id: "workflow-1" },
      nodes: [
        {
          planNodeId: "task-a",
          type: "task",
          label: "Prepare",
          taskId: "prepare",
          dependsOn: [],
          siblingOrder: 0,
        },
      ],
    },
    invocations: [],
  },
  undefined,
  undefined,
);

const parallelGraph = graphFor(
  {
    summary: {
      workId: "work-1",
      runId: "run-1",
      workflowId: "workflow-1",
      state: "active",
      isIncomplete: false,
      activeInvocationCount: 0,
      lastEventSequence: 2,
    },
    cursor: 2,
    plan: {
      workflow: { id: "workflow-1" },
      nodes: [
        {
          planNodeId: "task-a",
          type: "task",
          label: "Prepare",
          taskId: "prepare",
          dependsOn: [],
          siblingOrder: 0,
        },
        {
          planNodeId: "task-b",
          type: "task",
          label: "Review",
          taskId: "review",
          dependsOn: [],
          siblingOrder: 1,
        },
      ],
    },
    invocations: [],
  },
  undefined,
  undefined,
);

describe("graph measurements", () => {
  it("keeps measured node dimensions when graph data is replaced", () => {
    const measured = applyGraphMeasurements(
      graph,
      new Map([["plan:task-a", { width: 240, height: 120 }]]),
    );

    expect(measured.nodes[0]?.measured).toEqual({ width: 240, height: 120 });
  });

  it("does not replace a graph when no saved measurements apply", () => {
    expect(applyGraphMeasurements(graph, new Map())).toBe(graph);
  });

  it("reflows parallel Plan cards from their measured heights", () => {
    const measured = applyGraphMeasurements(
      parallelGraph,
      new Map([
        ["plan:task-a", { width: 240, height: 300 }],
        ["plan:task-b", { width: 240, height: 140 }],
      ]),
    );

    expect(
      measured.nodes.find(({ id }) => id === "plan:task-b")?.position,
    ).toEqual({ x: 0, y: 320 });
  });

  it("accepts complete React Flow dimension changes only", () => {
    expect(
      measurementsFromNodeChanges([
        {
          id: "plan:task-a",
          type: "dimensions",
          dimensions: { width: 240, height: 120 },
        },
        {
          id: "plan:task-b",
          type: "dimensions",
          dimensions: { width: 240 },
        },
        { id: "plan:task-c", type: "position" },
      ]),
    ).toEqual([["plan:task-a", { width: 240, height: 120 }]]);
  });
});
