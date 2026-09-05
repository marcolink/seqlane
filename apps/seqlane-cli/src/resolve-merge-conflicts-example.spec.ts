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

  it("enforces conflict-resolution safety invariants in the workflow", async () => {
    const workflow = await readFile(
      new URL(
        "../../../.github/workflows/seqlane-resolve-merge-conflicts.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("MAX_REBASE_ATTEMPTS=10");
    expect(workflow).toContain("diff --name-only --diff-filter=U -z");
    expect(workflow).toContain(
      'validate-workspace "$RESOLUTION_TARGET" "$CONFLICT_FILES"',
    );
    expect(workflow).toContain(
      'validate-markers "$RESOLUTION_TARGET" "$CONFLICT_FILES"',
    );
    expect(workflow).toContain('path !== "pnpm-lock.yaml"');
    expect(workflow).toContain("AGENT_CONFLICT_FILES");
    expect(workflow).toContain("has_agent_conflicts");
    expect(workflow).toContain(
      'node --experimental-strip-types "$PWD/scripts/resolve-merge-conflicts-workflow.ts"',
    );
    expect(workflow).toContain("prepare-agent");
    expect(workflow).toContain("copy-agent");
    expect(workflow).toContain("prepare-lockfile");
    expect(workflow).toContain("validate-workspace");
    expect(workflow).toContain("validate-markers");
    expect(workflow).toContain(
      "No agent-resolvable conflict files; the lockfile will be regenerated mechanically.",
    );
    expect(workflow).toContain(
      'mktemp -d "$RUNNER_TEMP/seqlane-lockfile-workspace.XXXXXX"',
    );
    expect(workflow).toContain("trap 'rm -rf -- \"$LOCKFILE_WORKSPACE\"' EXIT");
    expect(workflow).not.toContain('mkdir "$LOCKFILE_WORKSPACE"');
    expect(workflow).toContain(
      "node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa",
    );
    expect(workflow).toContain("COREPACK_ENABLE_PROJECT_SPEC=0");
    expect(workflow).toContain(
      "COREPACK_NPM_REGISTRY=https://registry.npmjs.org",
    );
    expect(workflow).toContain(
      'const { packageManager } = require("./package.json");',
    );
    expect(workflow).toContain(
      "version: ${{ steps.package-manager.outputs.pnpm_version }}",
    );
    expect(workflow).toContain(
      'corepack install --global "pnpm@$PNPM_VERSION"',
    );
    expect(workflow).toContain('--user "$(id -u):$(id -g)"');
    expect(workflow).toContain(
      'test "$(COREPACK_ENABLE_PROJECT_SPEC=0 corepack pnpm --version)" = "$PNPM_VERSION"',
    );
    expect(workflow).toContain(
      "COREPACK_ENABLE_PROJECT_SPEC=0 corepack pnpm install",
    );
    expect(workflow).toContain("--config.registry=https://registry.npmjs.org/");
    expect(workflow).not.toContain("node:24-bookworm-slim");
    expect(workflow).toContain(
      'git push --force-with-lease="refs/heads/$HEAD_REF:$HEAD_SHA"',
    );
    expect(workflow).toContain("OPENCODE_ARCHIVE_SHA256");
    expect(workflow).toContain(
      "--lockfile-only --ignore-scripts --ignore-pnpmfile",
    );
    expect(workflow).toContain("docker run --rm --network bridge");
    expect(workflow).not.toContain("https://opencode.ai/install | bash");
  });

  it("detects diff3 and non-default conflict markers with CRLF endings", () => {
    const marker = /^(?:<{7,}(?: .*)?|\|{7,}(?: .*)?|={7,}|>{7,}(?: .*)?)\r?$/m;

    expect(marker.test("resolved\r\n=======\r\ncontent\r\n")).toBe(true);
    expect(marker.test("||||||| base\r\n")).toBe(true);
    expect(marker.test("<<<<<<<<<<< HEAD\r\n")).toBe(true);
  });
});
