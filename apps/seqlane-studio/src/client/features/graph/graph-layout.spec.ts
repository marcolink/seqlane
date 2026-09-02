import { describe, expect, it } from "vitest";
import type { StudioRunSnapshot } from "@seqlane/studio/protocol";
import {
  graphFor,
  hasSameGraphRendering,
  positionForNode,
  reconcileGraph,
} from "./graph-layout.js";

describe("graph layout", () => {
  const snapshot: StudioRunSnapshot = {
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
          planNodeId: "repeat:1",
          type: "repeat",
          label: "Repeat",
          dependsOn: ["task-a"],
          siblingOrder: 1,
          maximumIterations: 2,
        },
        {
          planNodeId: "repeat:1/body/task:1",
          type: "task",
          label: "Process",
          taskId: "process",
          dependsOn: [],
          parentPlanNodeId: "repeat:1",
          siblingOrder: 0,
        },
      ],
    },
    invocations: [],
  };

  it("renders every static Plan node and static dependency edge", () => {
    const graph = graphFor(snapshot, undefined, undefined);

    expect(graph.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "plan:task-a",
        "plan:repeat:1",
        "plan:repeat:1/body/task:1",
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "static:task-a->repeat:1",
          source: "plan:task-a",
          target: "plan:repeat:1",
        }),
        expect.objectContaining({
          id: "parent:repeat:1->repeat:1/body/task:1",
          source: "plan:repeat:1",
          target: "plan:repeat:1/body/task:1",
        }),
      ]),
    );
  });

  it("uses compact spacing for static DAG columns", () => {
    const graph = graphFor(snapshot, undefined, undefined);

    expect(
      graph.nodes.find(({ id }) => id === "plan:repeat:1")?.position,
    ).toEqual({ x: 345, y: 0 });
    expect(
      graph.nodes.find(({ id }) => id === "plan:repeat:1/body/task:1")
        ?.position,
    ).toEqual({ x: 690, y: 0 });
  });

  it("leaves room for session metadata between parallel Plan cards", () => {
    const parallel: StudioRunSnapshot = {
      ...snapshot,
      plan: {
        ...snapshot.plan!,
        nodes: [
          ...snapshot.plan!.nodes,
          {
            planNodeId: "task-b",
            type: "task",
            label: "Review",
            taskId: "review",
            dependsOn: [],
            siblingOrder: 1,
            session: { type: "isolated" },
          },
        ],
      },
    };

    const graph = graphFor(parallel, undefined, undefined);

    expect(
      graph.nodes.find(({ id }) => id === "plan:task-b")?.position,
    ).toEqual({
      x: 0,
      y: 256,
    });
  });

  it("renders loop iterations inline in their task node", () => {
    const withInvocations: StudioRunSnapshot = {
      ...snapshot,
      invocations: [
        {
          invocationId: "invocation-1",
          planNodeId: "repeat:1/body/task:1",
          taskId: "process",
          kind: "task",
          label: "Process item",
          siblingOrder: 0,
          dependencyIds: [],
          state: "succeeded",
          output: { persistent: [] },
          iteration: 1,
        },
        {
          invocationId: "invocation-2",
          planNodeId: "repeat:1/body/task:1",
          taskId: "process",
          kind: "task",
          label: "Process item",
          siblingOrder: 1,
          dependencyIds: ["invocation-1"],
          state: "active",
          output: { persistent: [] },
          iteration: 2,
        },
      ],
    };

    const graph = graphFor(withInvocations, "invocation-2", undefined);
    const processNode = graph.nodes.find(
      ({ id }) => id === "plan:repeat:1/body/task:1",
    );

    expect(processNode?.data.kind).toBe("plan");
    if (processNode?.data.kind === "plan") {
      expect(
        processNode.data.invocations.map(({ iteration }) => iteration),
      ).toEqual([1, 2]);
      expect(processNode.selected).toBe(true);
    }
    expect(graph.nodes.map(({ id }) => id)).not.toContain(
      "invocation:invocation-1",
    );
    expect(graph.nodes.map(({ id }) => id)).not.toContain(
      "invocation:invocation-2",
    );
  });

  it("keeps repeated runtime instances in one plan task node", () => {
    const withInvocations: StudioRunSnapshot = {
      ...snapshot,
      invocations: [
        {
          invocationId: "invocation-1",
          planNodeId: "task-a",
          taskId: "prepare",
          kind: "task",
          label: "Prepare",
          siblingOrder: 0,
          dependencyIds: [],
          state: "succeeded",
          output: { persistent: [] },
        },
        {
          invocationId: "invocation-2",
          planNodeId: "task-a",
          taskId: "prepare",
          kind: "task",
          label: "Prepare again",
          siblingOrder: 1,
          dependencyIds: ["invocation-1"],
          state: "active",
          output: { persistent: [] },
        },
      ],
    };

    const graph = graphFor(withInvocations, "invocation-2", undefined);

    const taskNode = graph.nodes.find(({ id }) => id === "plan:task-a");

    expect(taskNode?.data.kind).toBe("plan");
    if (taskNode?.data.kind === "plan") {
      expect(taskNode.data.invocations).toHaveLength(2);
      expect(taskNode.selected).toBe(true);
    }
    expect(graph.nodes.map(({ id }) => id)).not.toContain(
      "invocation:invocation-1",
    );
    expect(graph.nodes.map(({ id }) => id)).not.toContain(
      "invocation:invocation-2",
    );
  });

  it("rerenders a Plan node when its session policy changes", () => {
    const after: StudioRunSnapshot = {
      ...snapshot,
      plan: {
        ...snapshot.plan!,
        nodes: snapshot.plan!.nodes.map((node) =>
          node.planNodeId === "task-a"
            ? {
                ...node,
                session: { type: "isolated" },
              }
            : node,
        ),
      },
    };

    expect(hasSameGraphRendering(snapshot, after)).toBe(false);
  });

  it("keeps a user-arranged position when the graph updates", () => {
    const saved = new Map([["node-1", { x: 480, y: 220 }]]);

    expect(positionForNode("node-1", { x: 0, y: 0 }, saved)).toEqual({
      x: 480,
      y: 220,
    });
  });

  it("uses automatic layout for new nodes", () => {
    expect(positionForNode("node-2", { x: 285, y: 155 }, new Map())).toEqual({
      x: 285,
      y: 155,
    });
  });

  it("keeps React Flow nodes stable for inspector-only activity events", () => {
    const before: StudioRunSnapshot = {
      ...snapshot,
      invocations: [
        {
          invocationId: "invocation-1",
          planNodeId: "task-a",
          taskId: "prepare",
          kind: "task",
          label: "Prepare",
          siblingOrder: 0,
          dependencyIds: [],
          state: "active",
          output: { persistent: [] },
        },
      ],
    };
    const after: StudioRunSnapshot = {
      ...before,
      invocations: [
        {
          ...before.invocations[0]!,
          activities: [
            {
              activityId: "tool-1",
              kind: "tool",
              name: "read_file",
              state: "succeeded",
              occurredAt: "2026-08-18T00:00:01.000Z",
            },
          ],
        },
      ],
    };
    const previous = graphFor(before, undefined, undefined);
    const next = graphFor(after, undefined, undefined);

    expect(hasSameGraphRendering(before, after)).toBe(true);
    expect(reconcileGraph(previous, next)).toBe(previous);
  });

  it("updates only graph nodes whose rendered state changed", () => {
    const before: StudioRunSnapshot = {
      ...snapshot,
      invocations: [
        {
          invocationId: "invocation-1",
          planNodeId: "task-a",
          taskId: "prepare",
          kind: "task",
          label: "Prepare",
          siblingOrder: 0,
          dependencyIds: [],
          state: "active",
          output: { persistent: [] },
        },
      ],
    };
    const after: StudioRunSnapshot = {
      ...before,
      invocations: [{ ...before.invocations[0]!, state: "succeeded" }],
    };
    const previous = graphFor(before, undefined, undefined);
    const reconciled = reconcileGraph(
      previous,
      graphFor(after, undefined, undefined),
    );

    expect(reconciled).not.toBe(previous);
    expect(reconciled.nodes.find(({ id }) => id === "plan:task-a")).not.toBe(
      previous.nodes.find(({ id }) => id === "plan:task-a"),
    );
    expect(reconciled.nodes.find(({ id }) => id === "plan:repeat:1")).toBe(
      previous.nodes.find(({ id }) => id === "plan:repeat:1"),
    );
    expect(reconciled.edges).toBe(previous.edges);
    expect(hasSameGraphRendering(before, after)).toBe(false);
  });
});
