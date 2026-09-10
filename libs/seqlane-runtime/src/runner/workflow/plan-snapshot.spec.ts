import type { Plan } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { createSeqlanePlanSnapshot } from "./plan-snapshot.js";

function adaptLegacyLocalExecutionFixture(plan: Plan): Plan {
  const [node] = plan.nodes;
  if (node?.type !== "task") return plan;

  const { execute: _execute, ...input } = node.input as {
    execute?: unknown;
    readonly [key: string]: unknown;
  };
  return {
    ...plan,
    nodes: [{ ...node, input }],
  };
}

describe("Seqlane Plan snapshots", () => {
  it("keeps graph topology while redacting bindings and bounding identities", () => {
    const longTaskId = "task-" + "x".repeat(300);
    const plan: Plan = {
      workflow: { id: "workflow", version: "1" },
      nodes: [
        {
          type: "task",
          nodeId: "finish:1",
          taskId: "finish-task",
          workspace: "shared",
          session: { type: "reuse", from: "prepare:1" },
          input: {
            credential: "super-secret",
            result: { type: "ref", nodeId: "repeat:1", path: ["output"] },
          },
          dependsOn: ["repeat:1", "prepare:1"],
        },
        {
          type: "repeat",
          nodeId: "repeat:1",
          input: { prompt: "private prompt", state: { value: 42 } },
          dependsOn: ["prepare:1"],
          maximumIterations: 3,
          body: {
            inputNodeId: "repeat:1:input",
            nodes: [
              {
                type: "task",
                nodeId: "repeat:1/body:1",
                taskId: longTaskId,
                workspace: "shared",
                input: {
                  callback: "private callback",
                  state: {
                    type: "ref",
                    nodeId: "repeat:1:input",
                    path: [],
                  },
                },
                dependsOn: ["repeat:1:input"],
              },
              {
                type: "validation.check",
                nodeId: "repeat:1/check:1",
                source: {
                  type: "mechanical",
                  validatorId: "private-validator",
                },
                input: {
                  candidate: {
                    type: "ref",
                    nodeId: "repeat:1/body:1",
                    path: ["output"],
                  },
                },
                dependsOn: ["repeat:1/body:1"],
              },
            ],
            output: {
              type: "ref",
              nodeId: "repeat:1/body:1",
              path: ["output"],
            },
            until: {
              type: "ref",
              nodeId: "repeat:1/body:1",
              path: ["output", "done"],
            },
          },
        },
        {
          type: "task",
          nodeId: "fork:1",
          taskId: "fork-task",
          workspace: "shared",
          session: {
            type: "branch",
            from: "prepare:1",
            model: {
              model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            },
          },
          input: { source: "prepare" },
          dependsOn: ["prepare:1"],
        },
        {
          type: "task",
          nodeId: "prepare:1",
          taskId: "prepare-task",
          workspace: "shared",
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
          input: { secret: "do-not-serialize" },
          dependsOn: [],
        },
      ],
      output: {
        type: "ref",
        nodeId: "finish:1",
        path: ["output"],
      },
    };

    const snapshot = createSeqlanePlanSnapshot(plan);

    expect(snapshot).toEqual({
      workflow: { id: "workflow", version: "1" },
      nodes: [
        {
          planNodeId: "prepare:1",
          type: "task",
          label: "prepare-task",
          taskId: "prepare-task",
          dependsOn: [],
          siblingOrder: 0,
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
        },
        {
          planNodeId: "fork:1",
          type: "task",
          label: "fork-task",
          taskId: "fork-task",
          dependsOn: ["prepare:1"],
          siblingOrder: 1,
          session: {
            type: "branch",
            from: "prepare:1",
            model: {
              model: { provider: "anthropic", model: "claude-sonnet-4-6" },
            },
          },
        },
        {
          planNodeId: "repeat:1",
          type: "repeat",
          label: "repeat:1",
          dependsOn: ["prepare:1"],
          siblingOrder: 2,
          maximumIterations: 3,
        },
        {
          planNodeId: "finish:1",
          type: "task",
          label: "finish-task",
          taskId: "finish-task",
          dependsOn: ["repeat:1", "prepare:1"],
          siblingOrder: 3,
          session: { type: "reuse", from: "prepare:1" },
        },
        {
          planNodeId: "repeat:1/body:1",
          type: "task",
          label: longTaskId.slice(0, 512),
          taskId: longTaskId.slice(0, 256),
          dependsOn: [],
          parentPlanNodeId: "repeat:1",
          siblingOrder: 0,
        },
        {
          planNodeId: "repeat:1/check:1",
          type: "validation.check",
          label: "private-validator",
          dependsOn: ["repeat:1/body:1"],
          parentPlanNodeId: "repeat:1",
          siblingOrder: 1,
        },
      ],
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private callback");
    expect(serialized).not.toContain("do-not-serialize");
    expect(snapshot.nodes.every(({ label }) => label.length <= 512)).toBe(true);
    expect(
      snapshot.nodes.every(({ planNodeId }) => planNodeId.length <= 256),
    ).toBe(true);
  });

  it("projects local execution without callback or process data", () => {
    const plan: Plan = {
      workflow: { id: "local-workflow" },
      nodes: [
        {
          type: "task",
          nodeId: "local:1",
          taskId: "local-task",
          workspace: "shared",
          input: {
            command: "git",
            args: ["status"],
            execute: async () => undefined,
          } as never,
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "local:1", path: ["output"] },
    };

    const snapshot = createSeqlanePlanSnapshot(
      adaptLegacyLocalExecutionFixture(plan),
    );

    expect(snapshot.nodes[0]).toMatchObject({
      type: "task",
      taskId: "local-task",
    });
    expect(snapshot.nodes[0]).not.toHaveProperty("session");
    expect(JSON.stringify(snapshot)).not.toContain("execute");
    expect(JSON.stringify(snapshot)).not.toContain("git");
  });
});
