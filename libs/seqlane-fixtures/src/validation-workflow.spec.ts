import { buildWorkflow, type Plan } from "@seqlane/core";
import { describe, expect, it } from "vitest";
import {
  evaluatorRepeatWorkflow,
  taskOutputValidationWorkflow,
} from "./validation-workflow.js";

function expectSerializablePlan(plan: Plan): void {
  expect(plan.nodes.every((node) => !Object.hasOwn(node, "executor"))).toBe(
    true,
  );
  expect(JSON.stringify(plan)).not.toContain("function");
  expect(JSON.stringify(plan)).not.toContain("validate");
}

describe("semantic validation workflow fixtures", () => {
  it("builds a task-output gate before its dependent", () => {
    const built = buildWorkflow(taskOutputValidationWorkflow);
    const plan = built.plan;

    expect(
      plan.nodes.map((node) =>
        node.type === "task" ? node.taskId : node.type,
      ),
    ).toEqual([
      "validation.fixture.produce",
      "validation.check",
      "validation.gate",
      "validation.fixture.dependent",
    ]);
    expect(plan.nodes.at(-1)).toMatchObject({
      type: "task",
      taskId: "validation.fixture.dependent",
      dependsOn: ["validation.gate:1"],
    });
    expectSerializablePlan(plan);
  });

  it("builds an evaluator-backed bounded repeat postcondition", () => {
    const built = buildWorkflow(evaluatorRepeatWorkflow);
    const plan = built.plan;
    const repeat = plan.nodes[0];

    expect(repeat).toMatchObject({
      type: "repeat",
      maximumIterations: 3,
      body: {
        nodes: [
          { type: "task", taskId: "validation.fixture.repair" },
          {
            type: "validation.check",
            source: {
              type: "task",
              taskId: "validation.fixture.evaluator",
            },
          },
          {
            type: "validation.gate",
            policy: "repeat-postcondition",
          },
        ],
      },
    });
    expectSerializablePlan(plan);
  });

  it("validates evaluator results at the task boundary", () => {
    const evaluator = buildWorkflow(
      evaluatorRepeatWorkflow,
    ).taskDefinitions.get("validation.fixture.evaluator");

    if (!evaluator) {
      throw new Error("Expected evaluator fixture task definition");
    }

    expect(() => evaluator.output.parse({ success: "unknown" })).toThrow();
    expect(
      evaluator.output.parse({
        success: false,
        issues: [{ code: "not-ready", message: "State is not ready" }],
      }),
    ).toMatchObject({ success: false });
  });
});
