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

  it("builds a task-backed bounded until repeat", () => {
    const built = buildWorkflow(evaluatorRepeatWorkflow);
    const plan = built.plan;
    const repeat = plan.nodes[0];

    expect(repeat).toMatchObject({
      type: "repeat",
      maximumIterations: 3,
      attempt: {
        type: "task",
        taskId: "validation.fixture.repair",
      },
    });
    expectSerializablePlan(plan);
  });

  it("validates repeated task results at the task boundary", () => {
    const repair = buildWorkflow(evaluatorRepeatWorkflow).taskDefinitions.get(
      "validation.fixture.repair",
    );

    if (!repair) throw new Error("Expected repair fixture task definition");

    expect(() =>
      repair.output.parse({ value: "x", attempt: "bad", ready: false }),
    ).toThrow();
    expect(
      repair.output.parse({ value: "x", attempt: 1, ready: true }),
    ).toEqual({
      value: "x",
      attempt: 1,
      ready: true,
    });
  });
});
