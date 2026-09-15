// @test-scope ./workspace-ordering.ts
import type { RepeatNode, TaskNode, WorkflowNode } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { lowerWorkspaceOrdering } from "./workspace-ordering.js";

function task(
  nodeId: string,
  workspace: TaskNode["workspace"],
  dependsOn: readonly string[] = [],
): TaskNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace,
    input: {},
    dependsOn,
  };
}

function repeat(nodeId: string, attempt: RepeatNode["attempt"]): RepeatNode {
  return {
    type: "repeat",
    nodeId,
    input: {},
    dependsOn: [],
    maximumIterations: 2,
    attempt,
    until: { type: "ref", nodeId: attempt.nodeId, path: ["output", "done"] },
  };
}

function workflow(nodeId: string): WorkflowNode {
  return {
    type: "workflow",
    workflowId: "composed",
    nodeId,
    workspace: "exclusive",
    input: {},
    dependsOn: [],
  };
}

describe("workspace graph ordering", () => {
  it("serializes exclusive access after an earlier shared access", () => {
    const nodes = lowerWorkspaceOrdering(
      [task("reader", "shared"), task("writer", "exclusive")],
      new Map([
        ["reader", { key: "/checkout" }],
        ["writer", { key: "/checkout" }],
      ]),
    );

    expect(nodes[0]?.dependsOn).toEqual([]);
    expect(nodes[1]?.dependsOn).toEqual(["reader"]);
  });

  it("allows compatible shared access and separate resources to overlap", () => {
    const nodes = lowerWorkspaceOrdering(
      [
        task("first-reader", "shared"),
        task("second-reader", "shared"),
        task("other-writer", "exclusive"),
      ],
      new Map([
        ["first-reader", { key: "/checkout" }],
        ["second-reader", { key: "/checkout" }],
        ["other-writer", { key: "/other-checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], [], []]);
  });

  it("preserves an existing dependency order for conflicting access", () => {
    const nodes = lowerWorkspaceOrdering(
      [task("first", "exclusive", ["second"]), task("second", "exclusive")],
      new Map([
        ["first", { key: "/checkout" }],
        ["second", { key: "/checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([["second"], []]);
  });

  it("serializes a repeat against conflicting top-level workspace access", () => {
    const nodes = lowerWorkspaceOrdering(
      [
        repeat("repair", task("repair-task", "exclusive")),
        task("reader", "shared"),
      ],
      new Map([
        ["repair-task", { key: "/checkout" }],
        ["reader", { key: "/checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], ["repair"]]);
  });

  it("uses the repeat attempt workspace policy", () => {
    const nodes = lowerWorkspaceOrdering(
      [
        repeat("repair", task("repair-writer", "exclusive")),
        task("reader", "shared"),
      ],
      new Map([
        ["repair-writer", { key: "/checkout" }],
        ["reader", { key: "/checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], ["repair"]]);
  });

  it("uses every resource touched by a composed workflow", () => {
    const nodes = lowerWorkspaceOrdering(
      [workflow("composed:1"), task("second-checkout", "shared")],
      new Map([
        [
          "composed",
          {
            key: "/checkout-a|/checkout-b",
            resources: [{ key: "/checkout-a" }, { key: "/checkout-b" }],
          },
        ],
        ["second-checkout", { key: "/checkout-b" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], ["composed:1"]]);
  });
});
