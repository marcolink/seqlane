import { describe, expect, it } from "vitest";
import { buildWorkflow, type Plan } from "@seqlane/core";
import {
  mixedAgentTask,
  mixedStatusTask,
  mixedWorkflow,
} from "./mixed-workflow.js";
import {
  createRenovatePlan,
  RENOVATE_INVOCATIONS,
  renovateTaskDefinitions,
  renovateValidatorDefinitions,
  renovateWorkflow,
} from "./renovate-workflow.js";

describe("generic Renovate workflow fixture", () => {
  it("builds the expected four-step Plan and output bindings", () => {
    const plan: Plan = buildWorkflow(renovateWorkflow).plan;

    expect(plan.workflow.id).toBe("fix-renovate-update");
    expect(
      plan.nodes
        .filter((node) => node.type === "task")
        .map(({ taskId }) => taskId),
    ).toEqual([
      RENOVATE_INVOCATIONS.investigate.taskId,
      RENOVATE_INVOCATIONS.plan.taskId,
      RENOVATE_INVOCATIONS.fix.taskId,
      RENOVATE_INVOCATIONS.verify.taskId,
    ]);
    expect(plan.nodes.map(({ dependsOn }) => dependsOn)).toEqual([
      [],
      [RENOVATE_INVOCATIONS.investigate.nodeId],
      [RENOVATE_INVOCATIONS.plan.nodeId],
      [RENOVATE_INVOCATIONS.fix.nodeId],
      [RENOVATE_INVOCATIONS.verify.nodeId],
      [RENOVATE_INVOCATIONS.verify.nodeId, "validation.check:1"],
    ]);
    expect(plan.nodes.at(-1)).toMatchObject({
      type: "validation.gate",
      policy: "fail",
      dependsOn: [RENOVATE_INVOCATIONS.verify.nodeId, "validation.check:1"],
    });
    expect(plan.nodes.every((node) => !Object.hasOwn(node, "executor"))).toBe(
      true,
    );
    expect(plan.output).toMatchObject({
      change: { nodeId: RENOVATE_INVOCATIONS.fix.nodeId },
      verification: {
        nodeId: RENOVATE_INVOCATIONS.verify.nodeId,
      },
    });
    expect(createRenovatePlan()).toEqual(plan);
  });

  it("retains generic definitions for private binding providers", () => {
    expect(renovateTaskDefinitions.size).toBe(4);
    expect(renovateValidatorDefinitions.size).toBe(1);
    expect(
      [...renovateTaskDefinitions.values()].every(
        (task) => typeof task.goal === "function",
      ),
    ).toBe(true);
  });

  it("builds a mixed agent and operation workflow", () => {
    const built = buildWorkflow(mixedWorkflow);

    expect(typeof built.taskDefinitions.get(mixedAgentTask.id)?.goal).toBe(
      "function",
    );
    expect(typeof built.taskDefinitions.get(mixedStatusTask.id)?.goal).toBe(
      "function",
    );
    expect(
      built.plan.nodes
        .filter((node) => node.type === "task")
        .map(({ taskId }) => taskId),
    ).toEqual([mixedAgentTask.id, mixedStatusTask.id]);
    expect(built.validatorDefinitions.size).toBe(1);
    expect(
      built.plan.nodes.some((node) => node.type === "validation.gate"),
    ).toBe(true);
  });
});
