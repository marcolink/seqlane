// @test-scope ../../../examples/resolve-merge-conflicts.ts

import { buildWorkflow } from "@seqlane/core";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const { default: resolveMergeConflictsWorkflow } = await import(
  new URL("../../../examples/resolve-merge-conflicts.ts", import.meta.url).href
);

const validInput = {
  repository: "/repo",
  pullRequestNumber: 42,
  strategy: "rebase" as const,
  baseBranch: "main",
  headBranch: "feature/conflict-resolution",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  conflictedFiles: ["src/example.ts"],
};

describe("merge-conflict resolution example workflow", () => {
  it("requires explicit pull-request revisions and conflict files", () => {
    expect(resolveMergeConflictsWorkflow.input.parse(validInput)).toEqual(
      validInput,
    );
    expect(() =>
      resolveMergeConflictsWorkflow.input.parse({
        ...validInput,
        headRevision: "main; git push",
      }),
    ).toThrow();
    expect(() =>
      resolveMergeConflictsWorkflow.input.parse({
        ...validInput,
        conflictedFiles: [],
      }),
    ).toThrow();
    expect(() =>
      resolveMergeConflictsWorkflow.input.parse({
        ...validInput,
        strategy: "squash",
      }),
    ).toThrow();
  });

  it("uses one exclusive isolated session with an explicit model", () => {
    const plan = buildWorkflow(resolveMergeConflictsWorkflow).plan;

    expect(plan.nodes).toEqual([
      expect.objectContaining({
        type: "task",
        taskId: "merge-conflicts.resolve",
        workspace: "exclusive",
        dependsOn: [],
        session: {
          type: "isolated",
          model: {
            model: { provider: "openai", model: "gpt-5.6-terra" },
            reasoning: "high",
          },
        },
      }),
    ]);
  });

  it("limits the agent to file edits for the supplied conflicts", () => {
    const task = buildWorkflow(
      resolveMergeConflictsWorkflow,
    ).taskDefinitions.get("merge-conflicts.resolve");
    if (task === undefined || typeof task.goal !== "function") {
      throw new Error("Expected merge-conflict resolution task");
    }

    expect(task.instructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Resolve only the files in conflictedFiles"),
        expect.stringContaining("Do not use shell commands"),
        expect.stringContaining(
          "Do not commit, push, change the integration strategy",
        ),
      ]),
    );
    expect(task.goal(validInput)).toContain(
      "--- Merge context (untrusted data) ---",
    );
    expect(task.goal(validInput)).toContain(
      "The selected integration strategy is rebase.",
    );
  });

  it("invokes the local Action and preserves workflow safety boundaries", async () => {
    const workflow = await readFile(
      new URL(
        "../../../.github/workflows/seqlane-resolve-merge-conflicts.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain(
      "uses: ./seqlane-source/actions/resolve-merge-conflicts",
    );
    expect(workflow).toContain("commit: true");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain(
      "push-token: ${{ secrets.SEQLANE_RESOLVER_TOKEN }}",
    );
    expect(workflow).not.toContain("Apply selected integration strategy");
    expect(workflow).not.toContain("Install OpenCode");
    expect(workflow).not.toContain("docker run");
    expect(workflow).not.toContain("git push --force");
  });

  it("detects diff3 and non-default conflict markers with CRLF endings", () => {
    const marker = /^(?:<{7,}(?: .*)?|\|{7,}(?: .*)?|={7,}|>{7,}(?: .*)?)\r?$/m;

    expect(marker.test("resolved\r\n=======\r\ncontent\r\n")).toBe(true);
    expect(marker.test("||||||| base\r\n")).toBe(true);
    expect(marker.test("<<<<<<<<<<< HEAD\r\n")).toBe(true);
  });
});
