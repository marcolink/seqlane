// @test-scope ../../../workflows/nested-example/workflow.ts

import { buildWorkflow } from "@seqlane/core";
import { createOperationalWorkflow } from "@seqlane/runtime/operational-host";
import { describe, expect, it } from "vitest";

const { default: nestedWorkflow } = await import(
  new URL("../../../workflows/nested-example/workflow.ts", import.meta.url).href
);

describe("nested workflow example", () => {
  it("composes and compiles a child workflow", () => {
    const built = buildWorkflow(nestedWorkflow);

    expect(built.plan.nodes).toMatchObject([
      {
        type: "workflow",
        workflowId: "nested-example-calculate",
        dependsOn: [],
      },
      {
        type: "task",
        taskId: "nested-example-summarize-total",
        dependsOn: ["nested-example-calculate:1"],
      },
    ]);
    expect(
      built.workflowDefinitions.get("nested-example-calculate")?.plan.workflow,
    ).toEqual({ id: "nested-example-calculate" });
    expect(() =>
      createOperationalWorkflow({
        key: "repository:nested-example",
        plan: built.plan,
        workflow: nestedWorkflow,
        taskDefinitions: built.taskDefinitions,
        validatorDefinitions: built.validatorDefinitions,
        workflowDefinitions: built.workflowDefinitions,
      }),
    ).not.toThrow();
  });
});
