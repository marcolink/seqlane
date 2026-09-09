// @test-scope ./review-run.ts
import type { SeqlaneRunOutcome } from "@seqlane/core";
import type {
  StartWorkflowRunRequest,
  WorkflowRunHandle,
} from "@seqlane/runtime";
import { describe, expect, it } from "vitest";
import type { GitHubReviewPort } from "./github-port.js";
import {
  runCodeReview,
  type CodeReviewRunRequest,
  type WorkflowRunner,
} from "./review-run.js";

const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);

const request: CodeReviewRunRequest = {
  repository: "owner/repository",
  pullRequestNumber: 1,
  reviewTarget: "/tmp/review-target",
  baseBranch: "main",
  baseRevision,
  headRevision,
  runtime: "https://runtime.example.test",
};

function createGithubPort(
  live: boolean,
  initialReport?: { readonly id: string; readonly body: string },
): GitHubReviewPort & { readonly updates: string[] } {
  let report =
    initialReport === undefined
      ? undefined
      : {
          id: initialReport.id,
          body: initialReport.body,
        };
  const updates: string[] = [];
  return {
    updates,
    readPullRequest: async () => ({
      number: 1,
      title: "Review",
      description: "Description",
    }),
    readLivePullRequest: async () =>
      live
        ? {
            state: "open",
            draft: false,
            head: {
              repo: { full_name: request.repository },
              sha: headRevision,
            },
          }
        : { state: "closed" },
    readComments: async () => ({
      comments:
        report === undefined
          ? []
          : [
              {
                id: report.id,
                kind: "issue" as const,
                author: "github-actions[bot]",
                authorAssociation: "OWNER",
                body: report.body,
                createdAt: "2026-09-09T00:00:00.000Z",
              },
            ],
      truncated: false,
    }),
    readAuthoritativeReport: async () => undefined,
    readIssueComment: async () => ({
      id: report!.id,
      kind: "issue" as const,
      author: "github-actions[bot]",
      authorAssociation: "OWNER",
      body: report!.body,
      createdAt: "2026-09-09T00:00:00.000Z",
    }),
    createReport: async (_number, body) => {
      updates.push(body);
      report = { id: "new-report", body };
    },
    updateReport: async (_id, body) => {
      updates.push(body);
      if (report !== undefined) report = { ...report, body };
    },
    deleteComment: async () => undefined,
  };
}

function createRunner(outcomes: readonly SeqlaneRunOutcome[]): WorkflowRunner {
  let index = 0;
  return <Input, Output>(
    _workflow: StartWorkflowRunRequest<Input, Output>,
  ): WorkflowRunHandle => {
    const outcome = outcomes[index++];
    if (outcome === undefined) throw new Error("Unexpected workflow run");
    return {
      workId: `work-${index}`,
      runId: index === 1 ? "review-run" : "publication-run",
      outcome: Promise.resolve(outcome),
      cancel: async () => undefined,
    };
  };
}

describe("runCodeReview", () => {
  it("returns stale before starting a workflow when the PR is no longer live", async () => {
    const runner = createRunner([]);
    const result = await runCodeReview(request, {
      github: createGithubPort(false),
      runWorkflow: runner,
    });

    expect(result).toEqual({ status: "stale" });
  });

  it("clears only the trusted run marker after publication", async () => {
    const marker = "<!-- seqlane-code-review -->\nprevious report";
    const github = createGithubPort(true, { id: "report-1", body: marker });
    const started: string[] = [];
    const result = await runCodeReview(request, {
      github,
      runWorkflow: createRunner([
        { status: "succeeded", result: {} },
        {
          status: "succeeded",
          result: {
            status: "published",
            publication: {
              verdict: "approve",
              reviewedRevision: headRevision,
              body: "published report",
            },
          },
        },
      ]),
      onRunStarted: ({ runId }) => {
        started.push(runId);
      },
    });

    expect(result).toMatchObject({
      status: "published",
      runId: "review-run",
      verdict: "approve",
    });
    expect(started).toEqual(["review-run"]);
    expect(github.updates).toHaveLength(2);
    expect(github.updates[0]).toContain(
      "<!-- seqlane-review-in-progress-run: review-run -->",
    );
    expect(github.updates[1]).toBe(`\n${marker}`);
  });
});
