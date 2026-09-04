// @test-scope ./workspace-ordering.ts
import type { RepeatNode, TaskNode } from "@seqlane/core";
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

function repeat(nodeId: string, body: RepeatNode["body"]["nodes"]): RepeatNode {
  return {
    type: "repeat",
    nodeId,
    input: {},
    dependsOn: [],
    maximumIterations: 2,
    body: {
      inputNodeId: `${nodeId}:input`,
      nodes: body,
      output: {},
      until: { type: "ref", nodeId: `${nodeId}:condition`, path: [] },
    },
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
        repeat("repair", [task("repair-task", "exclusive")]),
        task("reader", "shared"),
      ],
      new Map([
        ["repair-task", { key: "/checkout" }],
        ["reader", { key: "/checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], ["repair"]]);
  });

  it("promotes a repeat resource to exclusive when any body task writes", () => {
    const nodes = lowerWorkspaceOrdering(
      [
        repeat("repair", [
          task("repair-reader", "shared"),
          task("repair-writer", "exclusive"),
        ]),
        task("reader", "shared"),
      ],
      new Map([
        ["repair-reader", { key: "/checkout" }],
        ["repair-writer", { key: "/checkout" }],
        ["reader", { key: "/checkout" }],
      ]),
    );

    expect(nodes.map((node) => node.dependsOn)).toEqual([[], ["repair"]]);
  });
});
