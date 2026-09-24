// @test-scope ../../../workflows/code-review/workflow.ts
// @test-scope ../../../libs/action-code-review/src/review-history.ts

import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import type { TaskContext, TaskDefinition } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import {
  reviewStateSchema,
  synthesizedReviewFindingSchema,
} from "@seqlane/code-review-workflow/contracts";
import { normalizeReviewHistory } from "./review-history.js";
import { describe, expect, it } from "vitest";

const { default: prCodeReviewWorkflow } = await import(
  new URL("../../../workflows/code-review/workflow.ts", import.meta.url).href
);

const REVIEW_TEST_BASE_REVISION = "a".repeat(40);
const REVIEW_TEST_HEAD_REVISION = "b".repeat(40);

const reviewContextTask = {
  execute: async ({
    input,
  }: {
    readonly input: {
      readonly pullRequestNumber: number;
      readonly reviewHistory?: NonNullable<
        Parameters<typeof normalizeReviewHistory>[1]
      >;
    };
  }) => {
    const normalized = normalizeReviewHistory(
      input.pullRequestNumber,
      input.reviewHistory,
    );
    return {
      ...normalized.reviewHistory,
      runMetricsLedger: normalized.runMetricsLedger,
    };
  },
};

function createReviewInput(
  reviewHistory: object,
  baseRevision = REVIEW_TEST_BASE_REVISION,
  headRevision = REVIEW_TEST_HEAD_REVISION,
) {
  return {
    repository: "/repo",
    baseBranch: "main",
    baseRevision,
    headRevision,
    pullRequest: {
      number: 44,
      title: "Review history test",
      description: "Exercise deterministic review policy handling.",
    },
    gitEvidence: {
      baseRevision,
      headRevision,
      changedFiles: ["src/review.ts"],
      changedFileCount: 1,
      changedFilesTruncated: false,
      diffStat: "1 file changed",
      diffStatTruncated: false,
      patch: "diff",
      patchByteLength: 4,
      patchTruncated: false,
      diffCheck: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      previousRevisionComparable: false,
    },
    reviewHistory,
    historyVerification: {
      headRevision,
      verifications: [],
      limitations: [],
    },
  };
}

function createReport(findings: readonly object[]) {
  return {
    repository: "/repo",
    baseBranch: "main",
    baseRevision: REVIEW_TEST_BASE_REVISION,
    headRevision: REVIEW_TEST_HEAD_REVISION,
    overallRating: 4,
    verdict: "approve",
    summary: "Review result.",
    ratings: [
      "correctness",
      "readability",
      "architecture",
      "security",
      "performance",
    ].map((axis) => ({ axis, rating: 4, rationale: "No new concern." })),
    findings,
    verification: [],
  };
}

function createV4ReviewComment(
  state: Record<string, unknown>,
  metadataOverrides: Record<string, unknown> = {},
): string {
  const envelope = JSON.stringify({
    schemaVersion: 4,
    encoding: "gzip+base64",
    data: gzipSync(JSON.stringify(state)).toString("base64"),
  });
  const metadata = JSON.stringify({
    schemaVersion: 4,
    pullRequestNumber: state.pullRequestNumber,
    reviewedRevision: state.reviewedRevision,
    ...(state.previousReviewedRevision === undefined
      ? {}
      : { previousReviewedRevision: state.previousReviewedRevision }),
    ...metadataOverrides,
  });
  return [
    "<!-- seqlane-code-review -->",
    `<!-- seqlane-code-review-meta-v4: ${metadata} -->`,
    "<!-- seqlane-code-review-state-v4-start -->",
    "```json",
    envelope,
    "```",
    "<!-- seqlane-code-review-state-v4-end -->",
  ].join("\n");
}

function appendRunMetricsLedger(comment: string, ledger: unknown): string {
  return [
    comment,
    "<!-- seqlane-code-review-run-metrics-v1-start -->",
    "```json",
    JSON.stringify(ledger, null, 2),
    "```",
    "<!-- seqlane-code-review-run-metrics-v1-end -->",
  ].join("\n");
}

type TestExecRequest = {
  readonly command: string;
  readonly args?: readonly string[];
};
type TestTaskContext = {
  readonly exec?: (request: TestExecRequest) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly runAgent?: TaskContext["runAgent"];
};

const REVIEW_CONTEXT_TEST_CONTEXT: TestTaskContext = {
  exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  runAgent: async () => ({}),
};

async function executeTask<Input, Output>(
  task: Pick<TaskDefinition<Input, Output>, "execute">,
  input: Input,
  context: TestTaskContext = REVIEW_CONTEXT_TEST_CONTEXT,
): Promise<Output> {
  return task.execute({
    input,
    signal: new AbortController().signal,
    context: {
      exec: async ({ executable, argv }) => {
        if (context.exec === undefined) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return context.exec({ command: executable, args: argv });
      },
      runAgent: context.runAgent ?? (async () => ({})),
    },
  });
}

function workflowJobBlock(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainingWorkflow = workflow.slice(start + 1);
  const nextJobOffset = remainingWorkflow.search(/\n {2}\S/);
  const end = nextJobOffset === -1 ? -1 : start + 1 + nextJobOffset;
  return workflow.slice(start, end === -1 ? workflow.length : end);
}

describe("pull-request code review example workflow", () => {
  it("keeps review tooling on the immutable workflow source", async () => {
    const workflow = await readFile(
      new URL(
        "../../../.github/workflows/seqlane-code-review.yml",
        import.meta.url,
      ),
      "utf8",
    );

    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("issue_comment:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("path: seqlane-source");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).not.toContain(
      "ref: ${{ steps.pull-request.outputs.source_revision }}",
    );
    expect(workflow).toContain("path: review-target");
    expect(workflow).toContain(
      "ref: ${{ steps.pull-request.outputs.head_revision }}",
    );
    expect(workflow).toContain("working-directory: seqlane-source");
    expect(workflow).not.toContain(".nx/cache");
    expect(workflow).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    expect(workflow).toContain("Materialize code-review Actions");
    expect(workflow).toContain("uses: ./seqlane-source/actions/code-review");
    expect(workflow.indexOf("Materialize code-review Actions")).toBeLessThan(
      workflow.indexOf("uses: ./seqlane-source/actions/code-review"),
    );
    expect(workflow).toContain("SEQLANE_RUNTIME_ADAPTER_CONFIG: >-");
    expect(workflow).toContain(
      '{"adapter":"opencode","url":"${{ steps.opencode.outputs.url }}"}',
    );
    const mastraSecretMappings =
      workflow.match(
        /^\s+MASTRA_[A-Z_]+: \$\{\{ secrets\.MASTRA_[A-Z_]+ \}\}$/gm,
      ) ?? [];
    expect(mastraSecretMappings).toHaveLength(3);
    expect(mastraSecretMappings).toEqual(
      expect.arrayContaining([
        "          MASTRA_PLATFORM_ACCESS_TOKEN: ${{ secrets.MASTRA_PLATFORM_ACCESS_TOKEN }}",
        "          MASTRA_PLATFORM_OBSERVABILITY_ENDPOINT: ${{ secrets.MASTRA_PLATFORM_OBSERVABILITY_ENDPOINT }}",
        "          MASTRA_PROJECT_ID: ${{ secrets.MASTRA_PROJECT_ID }}",
      ]),
    );
    expect(workflow).toContain(
      "SEQLANE_REDACT_VALUES: |-\n            ${{ secrets.OPENAI_API_KEY }}\n            ${{ steps.ripwire.outputs.mcp-token }}\n            ${{ secrets.MASTRA_PLATFORM_ACCESS_TOKEN }}",
    );
    expect(workflow).not.toContain(
      './apps/cli/bin/dev.js run "$PWD/workflows/code-review/workflow.ts"',
    );
    expect(workflow).not.toContain("## Available commands");
    expect(workflow).not.toContain("- `/seqlane review`");
  });

  it("runs one review job for eligible pull requests and manual dispatch", async () => {
    const workflow = await readFile(
      new URL(
        "../../../.github/workflows/seqlane-code-review.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const review = workflowJobBlock(workflow, "code-review");
    const manualAdmission = workflowJobBlock(workflow, "validate-dispatch");
    const closeCancellation = workflowJobBlock(
      workflow,
      "cancel-closed-review",
    );

    expect(workflow).not.toMatch(/^concurrency:/m);
    expect(workflow).not.toContain("admit-review:");
    expect(manualAdmission).toContain(
      "if: github.event_name == 'workflow_dispatch'",
    );
    expect(manualAdmission).toContain('.state == "open" and .draft == false');
    expect(manualAdmission).toContain(".head.repo.full_name == $repository");
    expect(manualAdmission).not.toContain("concurrency:");
    expect(manualAdmission).not.toContain("pull-requests: write");
    expect(review).toContain("needs: validate-dispatch");
    expect(review).toContain("always() &&");
    expect(review).toContain(
      "needs.validate-dispatch.outputs.eligible == 'true'",
    );
    expect(review).toContain("github.event_name == 'workflow_dispatch'");
    expect(review).toContain("github.event.pull_request.draft == false");
    expect(review).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(review).toContain(
      "group: seqlane-code-review-${{ github.event.pull_request.number || needs.validate-dispatch.outputs.number }}",
    );
    expect(review).toContain("cancel-in-progress: true");
    expect(review).toContain("pull-requests: write");
    expect(workflow.match(/^ {6}pull-requests: write$/gm)).toHaveLength(1);
    expect(review).not.toContain("Validate review trigger");

    expect(closeCancellation).toContain(
      "if: github.event_name == 'pull_request_target' && github.event.action == 'closed'",
    );
    expect(closeCancellation).toContain(
      "group: seqlane-code-review-${{ github.event.pull_request.number }}",
    );
    expect(closeCancellation).toContain("cancel-in-progress: true");
    expect(closeCancellation).toContain("contents: none");
    expect(closeCancellation).toContain("issues: none");
    expect(closeCancellation).toContain("pull-requests: none");
    expect(closeCancellation).not.toContain("actions/checkout");
    expect(closeCancellation).not.toContain("Publish code review");
  });

  it("requires explicit revisions and pull-request context", () => {
    const input = {
      repository: "/repo",
      baseBranch: "release/2026.09",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      pullRequest: {
        number: 44,
        title: "Add automated review",
        description: "Run Seqlane for every pull request.",
      },
      reviewHistory: {
        comments: [],
        truncated: false,
      },
    };

    expect(prCodeReviewWorkflow.input.parse(input)).toEqual(input);
    expect(() =>
      prCodeReviewWorkflow.input.parse({
        ...input,
        headRevision: "main; rm -rf .",
      }),
    ).toThrow();
  });

  it("uses the directory-era workflow identity convention", () => {
    const plan = buildWorkflow(prCodeReviewWorkflow).plan;

    expect(plan.workflow.id).toBe("code-review");
    expect(
      plan.nodes
        .filter((node) => node.type === "task")
        .map((node) => node.taskId),
    ).toEqual(
      expect.arrayContaining([
        "code-review-git-evidence",
        "code-review-verify-history",
        "code-review-correctness",
        "code-review-maintainability",
        "code-review-risk",
        "code-review-summarize",
        "code-review-finalize",
      ]),
    );
  });

  it("selects session models for Git evidence and review lanes", () => {
    const plan = buildWorkflow(prCodeReviewWorkflow).plan;
    const reviewLanes = plan.nodes.filter(
      (node) =>
        node.type === "task" &&
        [
          "code-review-correctness",
          "code-review-maintainability",
          "code-review-risk",
        ].includes(node.taskId),
    );
    const summarize = plan.nodes.find(
      (node) => node.type === "task" && node.taskId === "code-review-summarize",
    );
    const gitEvidence = plan.nodes.find(
      (node) =>
        node.type === "task" && node.taskId === "code-review-git-evidence",
    );
    const historyVerification = plan.nodes.find(
      (node) =>
        node.type === "task" && node.taskId === "code-review-verify-history",
    );
    const finalizeReview = plan.nodes.find(
      (node) => node.type === "task" && node.taskId === "code-review-finalize",
    );
    expect(gitEvidence).toMatchObject({
      workspace: "shared",
      dependsOn: [],
    });
    expect(gitEvidence).not.toHaveProperty("execution");
    expect(finalizeReview?.dependsOn).toEqual(
      expect.arrayContaining([
        gitEvidence?.nodeId,
        historyVerification?.nodeId,
        summarize?.nodeId,
      ]),
    );
    expect(finalizeReview?.dependsOn).toHaveLength(3);
    expect(historyVerification).toMatchObject({
      workspace: "shared",
      dependsOn: expect.arrayContaining([gitEvidence?.nodeId]),
    });
    expect(historyVerification?.dependsOn).toHaveLength(1);
    expect(reviewLanes).toHaveLength(3);
    for (const reviewLane of reviewLanes) {
      expect(reviewLane.dependsOn).toEqual(
        expect.arrayContaining([
          gitEvidence?.nodeId,
          historyVerification?.nodeId,
        ]),
      );
      expect(reviewLane.dependsOn).toHaveLength(2);
    }
    expect(reviewLanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "code-review-correctness",
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
        }),
        expect.objectContaining({
          taskId: "code-review-maintainability",
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
        }),
        expect.objectContaining({
          taskId: "code-review-risk",
          session: {
            type: "isolated",
            model: {
              model: { provider: "openai", model: "gpt-5.6-luna" },
              reasoning: "high",
            },
          },
        }),
      ]),
    );
    expect(summarize).toMatchObject({
      session: {
        type: "isolated",
        model: {
          model: { provider: "openai", model: "gpt-5.6-luna" },
          reasoning: "high",
        },
      },
    });
  });

  it("allows read-only indexed search only within the review workspace", () => {
    const workflow = buildWorkflow(prCodeReviewWorkflow);
    expect(
      workflow.taskDefinitions.get("code-review-correctness"),
    ).toBeDefined();
    expect(workflow.plan.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task",
          taskId: "code-review-correctness",
          workspace: "shared",
        }),
      ]),
    );
  });

  it("reads strict version 4 state from the trusted bot comment", async () => {
    const task = reviewContextTask;

    const state = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 2,
      findings: [
        {
          id: "SEQ-PR44-001",
          axis: "correctness",
          severity: "required",
          status: "open",
          aliases: ["F-old"],
          summary: "Previous finding",
          recommendation: "Fix the previous finding.",
        },
      ],
      limitations: [],
      truncated: false,
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "report",
              kind: "issue",
              author: "github-actions[bot]",
              authorAssociation: "NONE",
              body: createV4ReviewComment(state),
              createdAt: "2026-09-05T10:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {},
    );

    expect(result.previousState).toEqual(state);
    expect(result.previousReviewedRevision).toBe(REVIEW_TEST_HEAD_REVISION);
  });

  it("rejects prior state with embedded run history", async () => {
    const task = reviewContextTask;

    const state = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
      runs: [
        { id: "100", attempt: 1, completedAt: "2026-09-05T10:00:00Z" },
        { id: "101", attempt: 1, completedAt: "2026-09-05T11:00:00Z" },
      ],
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "report",
              kind: "issue",
              author: "github-actions[bot]",
              authorAssociation: "NONE",
              body: createV4ReviewComment(state, {
                run: { id: "101", attempt: 1 },
              }),
              createdAt: "2026-09-05T11:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {},
    );

    expect(result.previousState).toBeUndefined();
  });

  it("reads a strict run metrics ledger independently of review state", async () => {
    const task = reviewContextTask;
    const state = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
    };
    const metrics = {
      schemaVersion: 1,
      runId: "seqlane-run-1",
      outcome: "succeeded",
      durationMs: 42,
      totalCost: 0.0042,
      totalTokens: {
        input: 20,
        output: 12,
        reasoning: 8,
        cacheRead: 2,
        cacheWrite: 0,
        total: 42,
      },
      tasks: [],
    };
    const ledger = {
      schemaVersion: 1,
      runs: [
        {
          githubRunId: "123",
          attempt: 1,
          completedAt: "2026-09-05T10:00:00Z",
          reviewedRevision: REVIEW_TEST_HEAD_REVISION,
          metrics,
        },
      ],
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "report",
              kind: "issue",
              author: "github-actions[bot]",
              authorAssociation: "NONE",
              body: appendRunMetricsLedger(
                createV4ReviewComment(state),
                ledger,
              ),
              createdAt: "2026-09-05T10:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      REVIEW_CONTEXT_TEST_CONTEXT,
    );

    expect(result).toMatchObject({
      previousState: state,
      runMetricsLedger: ledger,
    });
  });

  it("starts an empty ledger for malformed, legacy, or unsupported metrics data", async () => {
    const task = reviewContextTask;
    const state = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
    };
    const base = createV4ReviewComment(state);
    const comments = [
      appendRunMetricsLedger(base, { schemaVersion: 1, runs: "invalid" }),
      `${base}\n<!-- seqlane-code-review-run-metrics-v1: {"schemaVersion":1} -->`,
      appendRunMetricsLedger(base, { schemaVersion: 2, runs: [] }),
    ];

    for (const [index, body] of comments.entries()) {
      const result = await executeTask<any, any>(
        task,
        {
          pullRequestNumber: 44,
          reviewHistory: {
            comments: [
              {
                id: `report-${index}`,
                kind: "issue",
                author: "github-actions[bot]",
                authorAssociation: "NONE",
                body,
                createdAt: "2026-09-05T10:00:00Z",
              },
            ],
            truncated: false,
          },
        },
        REVIEW_CONTEXT_TEST_CONTEXT,
      );

      expect(result).toMatchObject({
        previousState: state,
        runMetricsLedger: { schemaVersion: 1, runs: [] },
      });
    }
  });

  it("rejects version 4 state with unknown fields", async () => {
    const task = reviewContextTask;
    const invalidState = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
      unexpected: true,
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "report",
              kind: "issue",
              author: "github-actions[bot]",
              authorAssociation: "NONE",
              body: createV4ReviewComment(invalidState),
              createdAt: "2026-09-05T10:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {},
    );

    expect(result.previousState).toBeUndefined();
    expect(result.previousReviewedRevision).toBeUndefined();
  });

  it("rejects version 4 state with both legacy and history run fields", async () => {
    const task = reviewContextTask;
    const invalidState = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
      run: { id: "100", attempt: 1, completedAt: "2026-09-05T10:00:00Z" },
      runs: [{ id: "100", attempt: 1, completedAt: "2026-09-05T10:00:00Z" }],
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "report",
              kind: "issue",
              author: "github-actions[bot]",
              authorAssociation: "NONE",
              body: createV4ReviewComment(invalidState, {
                run: { id: "100", attempt: 1 },
              }),
              createdAt: "2026-09-05T10:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {},
    );

    expect(result.previousState).toBeUndefined();
  });

  it("rejects ambiguous or mismatched version 4 state framing", async () => {
    const task = reviewContextTask;
    const state = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
    };
    const validComment = createV4ReviewComment(state);
    const stateBlock = validComment.match(
      /<!-- seqlane-code-review-state-v4-start -->[\s\S]*?<!-- seqlane-code-review-state-v4-end -->/,
    )?.[0];
    if (stateBlock === undefined) throw new Error("Expected state block");

    const comments = [
      `${validComment}\n${stateBlock}`,
      createV4ReviewComment(state, { reviewedRevision: "c".repeat(40) }),
      createV4ReviewComment(state, { run: { id: "123", attempt: 1 } }),
    ];

    for (const [index, body] of comments.entries()) {
      const result = await executeTask<any, any>(
        task,
        {
          pullRequestNumber: 44,
          reviewHistory: {
            comments: [
              {
                id: `report-${index}`,
                kind: "issue",
                author: "github-actions[bot]",
                authorAssociation: "NONE",
                body,
                createdAt: "2026-09-05T10:00:00Z",
              },
            ],
            truncated: false,
          },
        },
        {},
      );

      if (index < 2) {
        expect(result.previousState).toBeUndefined();
        expect(result.previousReviewedRevision).toBeUndefined();
      } else {
        expect(result.previousState).toEqual(state);
        expect(result.previousReviewedRevision).toBe(REVIEW_TEST_HEAD_REVISION);
      }
    }
  });

  it("rejects review state that exceeds the decompression bound", async () => {
    const task = reviewContextTask;
    const oversizedState = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 1,
      findings: [],
      limitations: [],
      truncated: false,
      overflow: "x".repeat(512_001),
    };
    const result = await executeTask<any, any>(
      task,
      {
        pullRequestNumber: 44,
        reviewHistory: {
          comments: [
            {
              id: "oversized-state",
              kind: "issue",
              author: "github-actions",
              authorAssociation: "NONE",
              body: createV4ReviewComment(oversizedState),
              createdAt: "2026-09-05T10:00:00Z",
            },
          ],
          truncated: false,
        },
      },
      {},
    );

    expect(result.previousState).toBeUndefined();
  });

  it("collects deterministic Git review evidence with command-level bounds", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-git-evidence",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected local Git evidence task definition");
    }

    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const patchText =
      "diff --git a/src/review.ts b/src/review.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const requests: Array<{
      readonly command: string;
      readonly args?: readonly string[];
    }> = [];
    const responses = [
      { exitCode: 0, stdout: `${headRevision}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "M\tsrc/review.ts\n", stderr: "" },
      { exitCode: 0, stdout: " 1 file changed, 1 insertion(+)\n", stderr: "" },
      { exitCode: 0, stdout: patchText, stderr: "" },
      {
        exitCode: 2,
        stdout: "src/review.ts: trailing whitespace.\n",
        stderr: "",
      },
    ];
    const result = await executeTask<any, any>(
      task,
      {
        repository: "/repo",
        baseBranch: "release/2026.09",
        baseRevision,
        headRevision,
        pullRequest: {
          number: 44,
          title: "Add automated review",
          description: "Run Seqlane for every pull request.",
        },
      },
      {
        exec: async (request) => {
          requests.push(request);
          const response = responses.shift();
          if (response === undefined) throw new Error("Unexpected Git command");
          return response;
        },
      },
    );

    expect(requests).toEqual([
      { command: "git", args: ["rev-parse", "--verify", "HEAD"] },
      { command: "git", args: ["cat-file", "-e", `${baseRevision}^{commit}`] },
      {
        command: "bash",
        args: ["-c", expect.stringContaining("--name-status")],
      },
      {
        command: "bash",
        args: ["-c", expect.stringContaining("--stat")],
      },
      {
        command: "bash",
        args: ["-c", expect.stringContaining(`head -c ${512_000 + 1}`)],
      },
      {
        command: "bash",
        args: ["-c", expect.stringContaining("--check")],
      },
    ]);
    expect(requests[2]?.args?.[1]).toContain(`head -c ${128_000 + 1}`);
    expect(requests[3]?.args?.[1]).toContain(`head -c ${8_000 + 1}`);
    expect(requests[4]?.args?.[1]).toContain("--unified=10");
    expect(requests[4]?.args?.[1]).toContain(
      "':(exclude,glob)**/pnpm-lock.yaml'",
    );
    expect(requests[4]?.args?.[1]).toContain(
      "':(exclude,glob)**/package-lock.json'",
    );
    expect(requests[5]?.args?.[1]).toContain(`head -c ${8_000 + 1}`);
    expect(task.output.parse(result)).toEqual({
      baseRevision,
      headRevision,
      changedFiles: ["src/review.ts"],
      changedFileCount: 1,
      changedFilesTruncated: false,
      diffStat: " 1 file changed, 1 insertion(+)\n",
      diffStatTruncated: false,
      patch: patchText,
      patchByteLength: Buffer.byteLength(patchText),
      patchTruncated: false,
      diffCheck: {
        exitCode: 2,
        stdout: "src/review.ts: trailing whitespace.\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
      previousRevisionComparable: false,
    });
  });

  it("uses only an ancestor review revision as the comparable predecessor", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-git-evidence",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected local Git evidence task definition");
    }
    const previousRevision = "c".repeat(40);
    const requests: Array<{ command: string; args?: readonly string[] }> = [];
    const responses = [
      { exitCode: 0, stdout: `${REVIEW_TEST_HEAD_REVISION}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const result = await executeTask<any, any>(
      task,
      {
        repository: "/repo",
        baseBranch: "main",
        baseRevision: REVIEW_TEST_BASE_REVISION,
        headRevision: REVIEW_TEST_HEAD_REVISION,
        pullRequest: {
          number: 44,
          title: "Compare reviews",
          description: "Compare with a prior review.",
        },
        normalizedReviewHistory: {
          comments: [],
          truncated: false,
          previousReviewedRevision: previousRevision,
        },
      },
      {
        exec: async (request) => {
          requests.push(request);
          const response = responses.shift();
          if (response === undefined) throw new Error("Unexpected Git command");
          return response;
        },
      },
    );

    expect(requests.at(-1)).toEqual({
      command: "git",
      args: [
        "merge-base",
        "--is-ancestor",
        previousRevision,
        REVIEW_TEST_HEAD_REVISION,
      ],
    });
    expect(result).toMatchObject({
      previousReviewedRevision: previousRevision,
      previousRevisionComparable: true,
    });
  });

  it("bounds oversized Git evidence and records overflow", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-git-evidence",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected local Git evidence task definition");
    }

    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const changedOutput =
      Array.from({ length: 200 }, (_, index) => `M\tsrc/file-${index}.ts`).join(
        "\n",
      ) +
      "\nM\t" +
      "x".repeat(128_001);
    const oversizedOutput = "x".repeat(8_001);
    const oversizedPatch = "prefix\n" + "x".repeat(511_991) + "😀" + "\nrest";
    const responses = [
      { exitCode: 0, stdout: `${headRevision}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: changedOutput, stderr: "" },
      { exitCode: 0, stdout: oversizedOutput, stderr: "" },
      { exitCode: 0, stdout: oversizedPatch, stderr: "" },
      {
        exitCode: 2,
        stdout: oversizedOutput,
        stderr: oversizedOutput,
      },
    ];
    const result = await executeTask<any, any>(
      task,
      {
        repository: "/repo",
        baseBranch: "release/2026.09",
        baseRevision,
        headRevision,
        pullRequest: {
          number: 44,
          title: "Add automated review",
          description: "Run Seqlane for every pull request.",
        },
      },
      {
        exec: async (request) => {
          const response = responses.shift();
          if (response === undefined) throw new Error("Unexpected Git command");
          return response;
        },
      },
    );

    expect(task.output.parse(result)).toMatchObject({
      baseRevision,
      headRevision,
      changedFiles: Array.from(
        { length: 200 },
        (_, index) => `src/file-${index}.ts`,
      ),
      changedFileCount: 200,
      changedFilesTruncated: true,
      diffStat: oversizedOutput.slice(0, 7_999) + "…",
      diffStatTruncated: true,
      patchByteLength: 512_001,
      patchTruncated: true,
      diffCheck: {
        exitCode: 2,
        stdout: oversizedOutput.slice(0, 7_999) + "…",
        stderr: oversizedOutput.slice(0, 7_999) + "…",
        stdoutTruncated: true,
        stderrTruncated: true,
      },
    });
    const parsed = task.output.parse(result) as { readonly patch: string };
    expect(parsed.patch).toBe(
      "prefix\n\n[patch truncated; omitted hunks were not reviewed]\n",
    );
    expect(parsed.patch).not.toContain("�");
    expect(parsed.patch.length).toBeLessThan(512_256);
  });

  it("preserves complete UTF-8 patch lines and records patch size", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-git-evidence",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected local Git evidence task definition");
    }

    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const patchText =
      "diff --git a/renamed.ts b/renamed.ts\nrename from old.ts\nrename to renamed.ts\nBinary files a/data.bin and b/data.bin differ\n";
    const responses = [
      { exitCode: 0, stdout: `${headRevision}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 0,
        stdout: "R100\told.ts\trenamed.ts\nM\tdata.bin\n",
        stderr: "",
      },
      { exitCode: 0, stdout: " 2 files changed\n", stderr: "" },
      { exitCode: 0, stdout: patchText, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const result = await executeTask<any, any>(
      task,
      {
        repository: "/repo",
        baseBranch: "release/2026.09",
        baseRevision,
        headRevision,
        pullRequest: {
          number: 44,
          title: "Add automated review",
          description: "Run Seqlane for every pull request.",
        },
      },
      {
        exec: async (request) => {
          const response = responses.shift();
          if (response === undefined) throw new Error("Unexpected Git command");
          return response;
        },
      },
    );

    expect(task.output.parse(result)).toMatchObject({
      baseRevision,
      headRevision,
      patch: patchText,
      patchByteLength: Buffer.byteLength(patchText),
      patchTruncated: false,
    });
  });

  it("does not retain a partial first patch line when it exceeds the bound", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-git-evidence",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected local Git evidence task definition");
    }

    const baseRevision = "a".repeat(40);
    const headRevision = "b".repeat(40);
    const oversizedFirstLine = "x".repeat(512_000) + "\nrest";
    const responses = [
      { exitCode: 0, stdout: `${headRevision}\n`, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "M\tsrc/review.ts\n", stderr: "" },
      { exitCode: 0, stdout: " 1 file changed\n", stderr: "" },
      { exitCode: 0, stdout: oversizedFirstLine, stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ];
    const result = await executeTask<any, any>(
      task,
      {
        repository: "/repo",
        baseBranch: "release/2026.09",
        baseRevision,
        headRevision,
        pullRequest: {
          number: 44,
          title: "Add automated review",
          description: "Run Seqlane for every pull request.",
        },
      },
      {
        exec: async (request) => {
          const response = responses.shift();
          if (response === undefined) throw new Error("Unexpected Git command");
          return response;
        },
      },
    );

    const parsed = task.output.parse(result) as {
      readonly patch: string;
      readonly patchTruncated: boolean;
    };
    expect(parsed.patchTruncated).toBe(true);
    expect(parsed.patch).toBe(
      "\n[patch truncated; omitted hunks were not reviewed]\n",
    );
  });

  it("keeps review tasks on shared workspaces with explicit schemas", () => {
    const workflow = buildWorkflow(prCodeReviewWorkflow);
    const sharedReviewTaskIds = [
      "code-review-git-evidence",
      "code-review-verify-history",
      "code-review-correctness",
      "code-review-maintainability",
      "code-review-risk",
      "code-review-summarize",
      "code-review-finalize",
    ];
    for (const taskId of sharedReviewTaskIds) {
      expect(workflow.taskDefinitions.get(taskId)).toBeDefined();
      expect(
        workflow.plan.nodes.filter(
          (node) => node.type === "task" && node.taskId === taskId,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspace: "shared" }),
        ]),
      );
    }
  });

  it("rejects former command decisions from current findings and state", () => {
    const finding = {
      id: "SEQ-PR44-001",
      aliases: ["F-9"],
      axis: "correctness",
      severity: "required",
      status: "open",
      summary: "Broken boundary",
      recommendation: "Restore validation",
    };
    expect(
      synthesizedReviewFindingSchema.safeParse({
        ...finding,
        disposition: "wont-fix",
      }).success,
    ).toBe(false);
    const previousState = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 2,
      findings: [{ ...finding, disposition: "wont-fix" }],
      limitations: [],
      truncated: false,
    };
    expect(reviewStateSchema.safeParse(previousState).success).toBe(false);
    expect(
      reviewStateSchema.safeParse({
        ...previousState,
        schemaVersion: 3,
        findings: [],
      }).success,
    ).toBe(false);
    expect(
      normalizeReviewHistory(44, {
        comments: [
          {
            id: "prior-report",
            kind: "issue",
            author: "github-actions[bot]",
            authorAssociation: "NONE",
            body: createV4ReviewComment(previousState),
            createdAt: "2026-09-24T00:00:00Z",
          },
        ],
        truncated: false,
      }).reviewHistory.previousState,
    ).toBeUndefined();
  });

  it("bounds merged current and historical findings", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-finalize",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected review finalizer");
    }

    const historicalFindings = Array.from({ length: 40 }, (_, index) => ({
      id: `SEQ-PR44-${String(index + 1).padStart(3, "0")}`,
      aliases: [],
      axis: "architecture",
      severity: "optional",
      status: "open",
      summary: "Historical finding",
      recommendation: "Re-evaluate the finding.",
    }));
    const currentFindings = Array.from({ length: 40 }, (_, index) => ({
      id: `F-C${index}`,
      axis: "correctness",
      severity: "optional",
      summary: "Current finding",
      recommendation: "Review the current change.",
    }));
    const result = await executeTask<any, any>(
      task,
      {
        review: createReviewInput({
          comments: [],
          truncated: false,
          previousState: {
            schemaVersion: 4,
            pullRequestNumber: 44,
            baseRevision: REVIEW_TEST_BASE_REVISION,
            reviewedRevision: REVIEW_TEST_HEAD_REVISION,
            nextFindingIndex: 41,
            findings: historicalFindings,
            limitations: [],
            truncated: false,
          },
        }),
        report: createReport(currentFindings),
      },
      {},
    );

    expect(result.findings).toHaveLength(40);
    expect(
      result.findings.map((finding: { readonly id: string }) => finding.id),
    ).toEqual(
      Array.from(
        { length: 40 },
        (_, index) => `SEQ-PR44-${String(index + 41).padStart(3, "0")}`,
      ),
    );
    expect(
      result.findings.map(
        (finding: { readonly aliases: readonly string[] }) =>
          finding.aliases[0],
      ),
    ).toEqual(currentFindings.map((finding) => finding.id));
    expect(result.limitations).toContain(
      "40 lower-priority finding(s) were omitted because the report is bounded to 40 findings.",
    );
    expect(result.limitations[0]).toBe(
      "40 lower-priority finding(s) were omitted because the report is bounded to 40 findings.",
    );
    expect(result.stateTruncated).toBe(true);
  });

  it("deduplicates temporary finding identifiers before allocating stable IDs", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-finalize",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected review finalizer");
    }
    const duplicate = {
      id: "F-duplicate",
      axis: "correctness",
      severity: "required",
      summary: "Duplicate current finding",
      recommendation: "Keep one stable finding.",
    };

    const result = await executeTask<any, any>(
      task,
      {
        review: createReviewInput({
          comments: [],
          truncated: false,
        }),
        report: createReport([duplicate, duplicate]),
      },
      {},
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "SEQ-PR44-001",
        aliases: ["F-duplicate"],
      }),
    ]);
    expect(result.nextFindingIndex).toBe(2);
  });

  it("reconciles retained findings from current-head evidence", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-finalize",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected review finalizer");
    }
    const previousFinding = (index: number, status: "open" | "resolved") => ({
      id: `SEQ-PR44-${String(index).padStart(3, "0")}`,
      aliases: [],
      axis: "correctness",
      severity: "required",
      status,
      summary: `Finding ${index}`,
      recommendation: "Restore the guard.",
    });
    const previousState = {
      schemaVersion: 4,
      pullRequestNumber: 44,
      baseRevision: REVIEW_TEST_BASE_REVISION,
      reviewedRevision: REVIEW_TEST_HEAD_REVISION,
      nextFindingIndex: 7,
      findings: [
        previousFinding(1, "open"),
        previousFinding(2, "open"),
        previousFinding(3, "open"),
        previousFinding(4, "open"),
        previousFinding(5, "resolved"),
        previousFinding(6, "open"),
      ],
      limitations: [],
      truncated: false,
    };
    const verifications = (
      [
        [1, "present"],
        [2, "addressed"],
        [3, "resolved"],
        [4, "uncertain"],
      ] as const
    ).map(([index, outcome]) => ({
      findingId: previousFinding(index, "open").id,
      headRevision: REVIEW_TEST_HEAD_REVISION,
      outcome,
      evidence: `Current-head evidence for ${index}`,
    }));

    const result = await executeTask<any, any>(
      task,
      {
        review: {
          ...createReviewInput({
            comments: [],
            truncated: false,
            previousState,
          }),
          historyVerification: {
            headRevision: REVIEW_TEST_HEAD_REVISION,
            verifications,
            limitations: [],
          },
        },
        report: createReport([
          {
            id: "SEQ-PR44-005",
            axis: "correctness",
            severity: "required",
            summary: "Finding 5 persists",
            recommendation: "Restore the guard.",
          },
          {
            id: "SEQ-PR44-006",
            axis: "correctness",
            severity: "optional",
            summary: "Finding 6 persists",
            recommendation: "Restore the guard.",
          },
        ]),
      },
      {},
    );

    expect(
      task.output.parse(result).findings.map((finding) => finding.status),
    ).toEqual([
      "reopened",
      "open",
      "reopened",
      "addressed",
      "resolved",
      "open",
    ]);
    expect(
      result.findings.find(
        (finding: { id: string }) => finding.id === "SEQ-PR44-006",
      ).severity,
    ).toBe("required");
    expect(result.verdict).toBe("request-changes");
  });

  it("ignores stale-head verification when retaining a finding", async () => {
    const task = buildWorkflow(prCodeReviewWorkflow).taskDefinitions.get(
      "code-review-finalize",
    );
    if (task === undefined || typeof task.execute !== "function") {
      throw new Error("Expected review finalizer");
    }
    const finding = {
      id: "SEQ-PR44-001",
      aliases: [],
      axis: "correctness",
      severity: "required",
      status: "open",
      summary: "Previous finding",
      recommendation: "Restore the guard.",
    };
    const result = await executeTask<any, any>(task, {
      review: {
        ...createReviewInput({
          comments: [],
          truncated: false,
          previousState: {
            schemaVersion: 4,
            pullRequestNumber: 44,
            baseRevision: REVIEW_TEST_BASE_REVISION,
            reviewedRevision: REVIEW_TEST_HEAD_REVISION,
            nextFindingIndex: 2,
            findings: [finding],
            limitations: [],
            truncated: false,
          },
        }),
        historyVerification: {
          headRevision: "c".repeat(40),
          verifications: [
            {
              findingId: finding.id,
              headRevision: "c".repeat(40),
              outcome: "resolved",
              evidence: "Evidence from an older run.",
            },
          ],
          limitations: [],
        },
      },
      report: createReport([]),
    });

    expect(task.output.parse(result).findings[0].status).toBe("open");
    expect(result.verdict).toBe("request-changes");
  });

  it("returns the complete validated lifecycle report", () => {
    const output = buildWorkflow(prCodeReviewWorkflow).plan.output;
    expect(output).toEqual({
      type: "ref",
      nodeId: "code-review-finalize:1",
      path: ["output"],
    });
  });
});
