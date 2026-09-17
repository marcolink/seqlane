// @test-scope ../../../workflows/resolve-merge-conflicts/workflow.ts
// @test-scope ../../../libs/runtime/src/workflows/resolve-merge-conflicts.ts

import { buildWorkflow } from "@seqlane/core";
import canonicalWorkflow, {
  conflictResolutionOutputSchema,
} from "@seqlane/resolve-merge-conflicts-workflow";
import runtimeWorkflow, {
  conflictResolutionOutputSchema as runtimeConflictResolutionOutputSchema,
} from "@seqlane/runtime/workflows/resolve-merge-conflicts";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const { default: resolveMergeConflictsWorkflow } = await import(
  new URL(
    "../../../workflows/resolve-merge-conflicts/workflow.ts",
    import.meta.url,
  ).href
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

describe("merge-conflict resolution workflow", () => {
  it("is the runtime compatibility export", () => {
    expect(runtimeWorkflow).toBe(canonicalWorkflow);
    expect(runtimeConflictResolutionOutputSchema).toBe(
      conflictResolutionOutputSchema,
    );
  });

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
        taskId: "resolve-merge-conflicts-task",
        workspace: "exclusive",
        dependsOn: [],
        session: {
          type: "isolated",
          model: {
            model: { provider: "openai", model: "gpt-5.6-luna" },
            reasoning: "high",
          },
        },
      }),
    ]);
  });

  it("limits the agent to file edits for the supplied conflicts", () => {
    const workflow = buildWorkflow(resolveMergeConflictsWorkflow);
    expect(
      workflow.taskDefinitions.get("resolve-merge-conflicts-task"),
    ).toBeDefined();
    expect(workflow.plan.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          taskId: "resolve-merge-conflicts-task",
          workspace: "exclusive",
        }),
      ]),
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
    expect(workflow).not.toContain(".nx/cache");
    expect(workflow).toContain("Materialize resolver Action");
    expect(workflow).toContain(
      "uses: ./seqlane-source/actions/resolve-merge-conflicts",
    );
    expect(workflow.indexOf("Materialize resolver Action")).toBeLessThan(
      workflow.indexOf(
        "uses: ./seqlane-source/actions/resolve-merge-conflicts",
      ),
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
