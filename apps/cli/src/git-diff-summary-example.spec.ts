// @test-scope ../../../workflows/git-diff-summary-example/workflow.ts

import { buildWorkflow } from "@seqlane/core";
import { createOperationalWorkflow } from "@seqlane/runtime/operational-host";
import { describe, expect, it } from "vitest";

const { default: workflow } = await import(
  new URL(
    "../../../workflows/git-diff-summary-example/workflow.ts",
    import.meta.url,
  ).href
);

describe("git diff summary workflow example", () => {
  it("keeps the direct and evidence lanes independent", () => {
    const built = buildWorkflow(workflow);
    const direct = built.plan.nodes.find(
      (node) =>
        node.type === "task" &&
        node.taskId === "git-diff-summary-example-direct-agent",
    );
    const evidence = built.plan.nodes.find(
      (node) =>
        node.type === "workflow" &&
        node.workflowId === "git-diff-summary-example-evidence-lane",
    );

    expect(built.plan.workflow.id).toBe("git-diff-summary-example");
    expect(direct?.dependsOn).toEqual([]);
    expect(evidence?.dependsOn).toEqual([]);

    const child = built.workflowDefinitions.get(
      "git-diff-summary-example-evidence-lane",
    );
    const childSummary = child?.plan.nodes.find(
      (node) =>
        node.type === "task" &&
        node.taskId === "git-diff-summary-example-summarize-evidence",
    );
    expect(child?.plan.nodes).toMatchObject([
      {
        type: "task",
        taskId: "git-diff-summary-example-collect-diff",
        dependsOn: [],
        workspace: "shared",
      },
      {
        type: "task",
        taskId: "git-diff-summary-example-summarize-evidence",
        dependsOn: ["git-diff-summary-example-collect-diff:1"],
        workspace: "shared",
        session: { type: "isolated" },
      },
    ]);
    expect(direct?.session).toEqual(childSummary?.session);

    const directDefinition = built.taskDefinitions.get(
      "git-diff-summary-example-direct-agent",
    );
    const evidenceDefinition = built.taskDefinitions.get(
      "git-diff-summary-example-summarize-evidence",
    );
    expect(directDefinition?.output).toBe(evidenceDefinition?.output);
  });

  it("uses direct git argv for the evidence lane", async () => {
    const built = buildWorkflow(workflow);
    const collectDiff = built.taskDefinitions.get(
      "git-diff-summary-example-collect-diff",
    );

    expect(collectDiff).toBeDefined();
    if (collectDiff === undefined) return;

    const calls: Array<{
      executable: string;
      argv: readonly string[];
    }> = [];

    await collectDiff.execute({
      input: { branch: "feature/example" },
      signal: new AbortController().signal,
      context: {
        exec: async (request) => {
          calls.push({
            executable: request.executable,
            argv: request.argv ?? [],
          });
          return { exitCode: 0, stdout: "diff", stderr: "" };
        },
        runAgent: async () => ({}),
      },
    });

    expect(calls).toEqual([
      {
        executable: "git",
        argv: [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--patch",
          "--stat",
          "--unified=3",
          "feature/example~2",
          "feature/example",
          "--",
        ],
      },
    ]);
  });

  it("compiles the nested lane through the operational runtime", () => {
    const built = buildWorkflow(workflow);

    expect(() =>
      createOperationalWorkflow({
        key: "repository:git-diff-summary-example",
        plan: built.plan,
        workflow,
        taskDefinitions: built.taskDefinitions,
        validatorDefinitions: built.validatorDefinitions,
        workflowDefinitions: built.workflowDefinitions,
      }),
    ).not.toThrow();
  });
});
