// @test-scope ./plan-ordering.ts

import type { Plan } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import { orderParsedPlanNodes } from "./plan-ordering.js";

describe("orderParsedPlanNodes", () => {
  it("orders a canonical Plan without reparsing it", () => {
    const plan: Plan = {
      workflow: { id: "ordering" },
      nodes: [
        {
          type: "task",
          taskId: "second",
          nodeId: "second:1",
          workspace: "shared",
          input: { type: "ref", nodeId: "first:1", path: ["output"] },
          dependsOn: ["first:1"],
        },
        {
          type: "task",
          taskId: "first",
          nodeId: "first:1",
          workspace: "shared",
          input: null,
          dependsOn: [],
        },
      ],
      output: { type: "ref", nodeId: "second:1", path: ["output"] },
    };

    expect(orderParsedPlanNodes(plan).map(({ nodeId }) => nodeId)).toEqual([
      "first:1",
      "second:1",
    ]);
  });
});
