// @test-scope ./session-ordering.ts
import type { PlanNode, TaskNode } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { lowerReuseSessionOrdering } from "./session-ordering.js";

function task(
  nodeId: string,
  session: TaskNode["session"],
  dependsOn: readonly string[] = [],
): PlanNode {
  return {
    type: "task",
    taskId: nodeId,
    nodeId,
    workspace: "shared",
    input: {},
    dependsOn,
    ...(session === undefined ? {} : { session }),
  };
}

describe("reuse session graph ordering", () => {
  it("chains reuse consumers in deterministic input order", () => {
    const nodes = lowerReuseSessionOrdering([
      task("source", { type: "isolated" }),
      task("first", { type: "reuse", from: "source" }),
      task("second", { type: "reuse", from: "source" }),
    ]);

    expect(nodes.map((node) => [node.nodeId, node.dependsOn])).toEqual([
      ["source", []],
      ["first", ["source"]],
      ["second", ["source", "first"]],
    ]);
  });

  it("does not serialize independent branch consumers", () => {
    const nodes = lowerReuseSessionOrdering([
      task("source", { type: "isolated" }),
      task("first", { type: "branch", from: "source" }, ["other"]),
      task("second", { type: "branch", from: "source" }),
    ]);

    expect(nodes[1]?.dependsOn).toEqual(["other", "source"]);
    expect(nodes[2]?.dependsOn).toEqual(["source"]);
  });
});
