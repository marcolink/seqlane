// @test-scope ../../../examples/release-doctor.ts

import { describe, expect, it } from "vitest";
import { buildWorkflow } from "@seqlane/core";

const { default: releaseDoctorWorkflow } = await import(
  new URL("../../../examples/release-doctor.ts", import.meta.url).href,
);

describe("repository release doctor example workflow", () => {
  it("gives every readiness check the same structured task contract", () => {
    const builtWorkflow = buildWorkflow(releaseDoctorWorkflow);
    const checkTaskIds = [
      "release-doctor.tests",
      "release-doctor.dependencies",
      "release-doctor.documentation",
      "release-doctor.boundaries",
    ];

    for (const taskId of checkTaskIds) {
      const task = builtWorkflow.taskDefinitions.get(taskId);
      expect(task).toBeDefined();
      if (task === undefined)
        throw new Error(`Missing task definition: ${taskId}`);

      expect(
        task.input.parse({
          snapshot: {
            repository: "/repo",
            baseBranch: "main",
            packageManager: "pnpm",
            changedFiles: [],
          },
        }),
      ).toEqual({
        snapshot: {
          repository: "/repo",
          baseBranch: "main",
          packageManager: "pnpm",
          changedFiles: [],
        },
      });
      expect(
        task.output.parse({
          check: "tests",
          status: "pass",
          summary: "All checks pass",
          recommendation: "None",
        }),
      ).toEqual({
        check: "tests",
        status: "pass",
        summary: "All checks pass",
        recommendation: "None",
      });
      expect(task.instructions).toEqual([
        "Inspect the repository without modifying files.",
        "Return one structured finding with pass, warning, or fail status.",
        "Include a concrete recommendation when status is warning or fail.",
      ]);
      expect(task.observability).toEqual({
        studio: { result: { includePaths: ["/status", "/summary"] } },
      });
    }
  });

  it("builds a fan-out, fan-in, and bounded remediation plan", () => {
    const plan = buildWorkflow(releaseDoctorWorkflow).plan;
    const taskNodes = plan.nodes.filter((node) => node.type === "task");
    const repeatNode = plan.nodes.find((node) => node.type === "repeat");

    expect(plan.workflow.id).toBe("repository-release-doctor");
    expect(taskNodes.map((node) => node.taskId)).toEqual([
      "release-doctor.inspect",
      "release-doctor.tests",
      "release-doctor.dependencies",
      "release-doctor.documentation",
      "release-doctor.boundaries",
      "release-doctor.aggregate",
      "release-doctor.report",
    ]);
    expect(repeatNode).toMatchObject({
      type: "repeat",
      maximumIterations: 3,
    });
    if (repeatNode?.type !== "repeat") throw new Error("repeat node missing");
    expect(
      repeatNode.body.nodes.some(
        (node) =>
          node.type === "validation.check" &&
          node.source.type === "mechanical" &&
          node.source.validatorId === "release-doctor.readiness",
      ),
    ).toBe(true);
    expect(
      repeatNode.body.nodes.some(
        (node) =>
          node.type === "validation.gate" &&
          node.policy === "repeat-postcondition",
      ),
    ).toBe(true);
    expect(buildWorkflow(releaseDoctorWorkflow).validatorDefinitions.size).toBe(
      1,
    );
    expect(plan.nodes.every((node) => !Object.hasOwn(node, "executor"))).toBe(
      true,
    );
  });
});
