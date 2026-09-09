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
  let version = 1;
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
    readAuthoritativeReportVersioned: async () => undefined,
    readIssueCommentVersioned: async () => ({
      comment: {
        id: report!.id,
        kind: "issue" as const,
        author: "github-actions[bot]",
        authorAssociation: "OWNER",
        body: report!.body,
        createdAt: "2026-09-09T00:00:00.000Z",
      },
      version: `"etag-${version}"`,
    }),
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
    },
    createReportIfAbsent: async (_number, body) => {
      updates.push(body);
      return "written" as const;
    },
    updateReport: async (_id, body) => {
      updates.push(body);
      if (report !== undefined) report = { ...report, body };
    },
    updateReportIfUnchanged: async (_id, body, expectedVersion) => {
      if (expectedVersion !== `"etag-${version}"`) return "stale" as const;
      updates.push(body);
      version += 1;
      if (report !== undefined) report = { ...report, body };
      return "written" as const;
    },
    deleteComment: async () => undefined,
  };
}

function createRunner(
  outcomes: readonly SeqlaneRunOutcome[],
  onRequest?: (
    request: StartWorkflowRunRequest<unknown, unknown>,
    index: number,
  ) => void,
): WorkflowRunner {
  let index = 0;
  return <Input, Output>(
    _workflow: StartWorkflowRunRequest<Input, Output>,
  ): WorkflowRunHandle => {
    const outcome = outcomes[index++];
    if (outcome === undefined) throw new Error("Unexpected workflow run");
    onRequest?.(_workflow as StartWorkflowRunRequest<unknown, unknown>, index);
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

  it("does not overwrite a marker when a competing write wins the version check", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });
    let conditionalWrites = 0;
    github.updateReportIfUnchanged = async () => {
      conditionalWrites += 1;
      return "stale";
    };

    const result = await runCodeReview(request, {
      github,
      runWorkflow: createRunner([{ status: "succeeded", result: {} }]),
    });

    expect(result).toEqual({ status: "stale", runId: "review-run" });
    expect(conditionalWrites).toBe(1);
    expect(github.updates).toHaveLength(0);
  });

  it("clears only the trusted run marker after publication", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });
    const started: string[] = [];
    const result = await runCodeReview(
      { ...request, githubRunId: "123" },
      {
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
      },
    );

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
    expect(github.updates[0]).toContain(
      "[View GitHub Actions run](https://github.com/owner/repository/actions/runs/123)",
    );
    expect(github.updates[1]).toBe(`\n${marker}`);
  });

  it("omits the run link when the GitHub run id is absent or unsafe", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });
    await runCodeReview(request, {
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
    });
    expect(github.updates[0]).not.toContain("https://github.com/");

    const unsafeGithub = createGithubPort(true, {
      id: "report-1",
      body: marker,
    });
    await runCodeReview(
      { ...request, githubRunId: "123\n[evil](https://evil.example)" },
      {
        github: unsafeGithub,
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
      },
    );
    expect(unsafeGithub.updates[0]).not.toContain("https://github.com/");
  });

  it("forwards safe review lifecycle progress from runtime events", async () => {
    const progress: string[] = [];
    let now = 1_000;
    const result = await runCodeReview(request, {
      github: createGithubPort(true),
      now: () => now,
      progress: {
        write: (event) => progress.push(event.kind),
      },
      runWorkflow: createRunner(
        [
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
        ],
        (workflow, index) => {
          if (index !== 1) return;
          const emit = workflow.events?.emit;
          if (emit === undefined) throw new Error("Missing event sink");
          const common = { workId: "work-1", runId: "review-run" };
          emit({ type: "run.started", ...common });
          emit({
            type: "invocation.created",
            ...common,
            invocationId: "invocation-1",
            planNodeId: "node-1",
            subject: { type: "task", taskId: "task-1" },
            taskId: "task-1",
            kind: "task",
            label: "correctness",
            siblingOrder: 0,
            dependencyIds: [],
          });
          emit({
            type: "invocation.started",
            ...common,
            invocationId: "invocation-1",
            subject: { type: "task", taskId: "task-1" },
            taskId: "task-1",
          });
          emit({
            type: "invocation.succeeded",
            ...common,
            invocationId: "invocation-1",
          });
          now = 4_000;
          emit({ type: "run.succeeded", ...common, output: {} });
        },
      ),
    });

    expect(result.status).toBe("published");
    expect(progress).toEqual([
      "review-started",
      "task-started",
      "task-completed",
      "review-completed",
    ]);
  });
});
