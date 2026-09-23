// @test-scope ../../../workflows/git-diff-summary-example/workflow.ts

import { buildWorkflow, shellTaskResultSchema } from "@seqlane/core";
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
        taskId: "git-diff-summary-example-bound-evidence",
        dependsOn: ["git-diff-summary-example-collect-diff:1"],
        workspace: "shared",
      },
      {
        type: "task",
        taskId: "git-diff-summary-example-summarize-evidence",
        dependsOn: ["git-diff-summary-example-bound-evidence:1"],
        workspace: "shared",
        session: { type: "isolated" },
      },
    ]);
    if (direct?.type !== "task" || childSummary?.type !== "task") {
      throw new Error("Expected agent task nodes in both lanes");
    }
    expect(direct.session).toEqual(childSummary.session);

    const directDefinition = built.taskDefinitions.get(
      "git-diff-summary-example-direct-agent",
    );
    const evidenceDefinition = built.taskDefinitions.get(
      "git-diff-summary-example-summarize-evidence",
    );
    expect(directDefinition?.output).toBe(evidenceDefinition?.output);
  });

  it("uses bounded Git argv for the evidence lane", async () => {
    const built = buildWorkflow(workflow);
    const collectDiff = built.taskDefinitions.get(
      "git-diff-summary-example-collect-diff",
    );

    expect(collectDiff).toBeDefined();
    if (collectDiff === undefined) return;

    const calls: Array<{
      executable: string;
      argv: readonly string[];
      timeoutMs: number | undefined;
    }> = [];

    await collectDiff.execute({
      input: { branch: "feature/example" },
      signal: new AbortController().signal,
      context: {
        exec: async (request) => {
          calls.push({
            executable: request.executable,
            argv: request.argv ?? [],
            timeoutMs: request.timeoutMs,
          });
          return { exitCode: 0, stdout: "diff", stderr: "" };
        },
        runAgent: async () => ({}),
      },
    });

    expect(calls).toEqual([
      {
        executable: "bash",
        argv: [
          "-c",
          expect.stringContaining(
            "git diff --no-ext-diff --no-textconv --no-color --patch --stat --unified=3",
          ),
          "git-diff-summary-example",
          "feature/example~1",
          "feature/example",
        ],
        timeoutMs: 30_000,
      },
    ]);
    expect(calls[0]?.argv[1]).toContain("--no-textconv");
    expect(calls[0]?.argv[1]).toContain("2>&1");
    expect(calls[0]?.argv[1]).toContain("head -c 512001");
  });

  it("bounds evidence and fails closed on Git errors", async () => {
    const built = buildWorkflow(workflow);
    const boundEvidence = built.taskDefinitions.get(
      "git-diff-summary-example-bound-evidence",
    );

    expect(boundEvidence).toBeDefined();
    if (boundEvidence === undefined) return;

    const context = {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      runAgent: async () => ({}),
    };

    await expect(
      boundEvidence.execute({
        input: {
          branch: "feature/example",
          evidence: { exitCode: 2, stdout: "ignored", stderr: "failure" },
        },
        signal: new AbortController().signal,
        context,
      }),
    ).rejects.toThrow("Git diff failed with exit code 2");

    const result = await boundEvidence.execute({
      input: {
        branch: "feature/example",
        evidence: {
          exitCode: 0,
          stdout: "x".repeat(512_001),
          stderr: "ignored",
        },
      },
      signal: new AbortController().signal,
      context,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
      truncated: true,
    });
    const parsed = shellTaskResultSchema.parse(result);
    expect(parsed.stdout).toContain("[git evidence truncated]");
    expect(parsed.stdout.length).toBeLessThan(512_000 + 100);
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
