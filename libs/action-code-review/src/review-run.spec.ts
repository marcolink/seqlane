// @test-scope ./review-run.ts
import type { SeqlaneRunOutcome } from "@seqlane/core";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@seqlane/agent-adapter";
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
  reviewTarget: realpathSync(process.cwd()),
  baseBranch: "main",
  baseRevision,
  headRevision,
  runtime: "https://runtime.example.test",
};

function createGithubPort(
  live: boolean,
  initialReport?: { readonly id: string; readonly body: string },
  options: {
    readonly liveRevisions?: readonly (string | undefined)[];
  } = {},
): GitHubReviewPort & {
  readonly updates: string[];
  readonly reads: { authoritative: number; live: number };
} {
  let report =
    initialReport === undefined
      ? undefined
      : {
          id: initialReport.id,
          body: initialReport.body,
        };
  const updates: string[] = [];
  const reads = { authoritative: 0, live: 0 };
  let liveReadIndex = 0;
  return {
    updates,
    reads,
    readPullRequest: async () => ({
      number: 1,
      title: "Review",
      description: "Description",
    }),
    readLivePullRequest: async () => {
      reads.live += 1;
      const revision =
        options.liveRevisions === undefined
          ? live
            ? headRevision
            : undefined
          : options.liveRevisions[
              Math.min(liveReadIndex++, options.liveRevisions.length - 1)
            ];
      return revision === undefined
        ? { state: "closed" }
        : {
            state: "open",
            draft: false,
            head: {
              repo: { full_name: request.repository },
              sha: revision,
            },
          };
    },
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
    readAuthoritativeReport: async () => {
      reads.authoritative += 1;
      return report === undefined
        ? undefined
        : {
            id: report.id,
            kind: "issue" as const,
            author: "github-actions[bot]",
            authorAssociation: "OWNER",
            body: report.body,
            createdAt: "2026-09-09T00:00:00.000Z",
          };
    },
    readIssueComment: async () => ({
      id: report!.id,
      kind: "issue" as const,
      author: "github-actions[bot]",
      authorAssociation: "OWNER",
      body: report!.body,
      createdAt: "2026-09-09T00:00:00.000Z",
    }),
    createMarker: async (_number, body) => {
      report = { id: "created-marker", body };
      updates.push(body);
      return report.id;
    },
    createReport: async (_number, body) => {
      updates.push(body);
    },
    updateReport: async (_id, body) => {
      updates.push(body);
      if (report !== undefined) report = { ...report, body };
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
    workflow: StartWorkflowRunRequest<Input, Output>,
  ): WorkflowRunHandle => {
    const outcome = outcomes[index++];
    if (outcome === undefined) throw new Error("Unexpected workflow run");
    onRequest?.(workflow as StartWorkflowRunRequest<unknown, unknown>, index);
    return {
      workId: workflow.identity?.workId ?? `work-${index}`,
      runId:
        workflow.identity?.runId ??
        (index === 1 ? "review-run" : "publication-run"),
      outcome: Promise.resolve(outcome),
      cancel: async () => undefined,
    };
  };
}

describe("runCodeReview", () => {
  it("bootstraps the selected runtime after admission and injects it into review only", async () => {
    const aliasedRequest = {
      ...request,
      reviewTarget: `${request.reviewTarget}/.`,
    };
    const runtime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("The test runner does not execute tasks");
      },
      redactAdapter: (adapter) => adapter,
    };
    const lifecycle: string[] = [];
    const receivedRuntimes: unknown[] = [];

    const result = await runCodeReview(aliasedRequest, {
      github: createGithubPort(true),
      onRunStarted: () => {
        lifecycle.push("admitted");
      },
      bootstrapAgentRuntime: async (workspace) => {
        lifecycle.push("bootstrapped");
        expect(workspace).toBe(request.reviewTarget);
        return runtime;
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
          lifecycle.push(index === 1 ? "review" : "publication");
          receivedRuntimes.push(workflow.agentRuntime);
        },
      ),
    });

    expect(result.status).toBe("published");
    expect(lifecycle).toEqual([
      "admitted",
      "bootstrapped",
      "review",
      "publication",
    ]);
    expect(receivedRuntimes).toEqual([runtime, undefined]);
  });

  it("rejects an invalid review target before runtime bootstrap", async () => {
    let bootstrapped = false;
    const result = await runCodeReview(
      {
        ...request,
        reviewTarget: `/tmp/seqlane-missing-review-target-${randomUUID()}`,
      },
      {
        github: createGithubPort(true),
        bootstrapAgentRuntime: async () => {
          bootstrapped = true;
          throw new Error("must not bootstrap");
        },
        runWorkflow: createRunner([]),
      },
    );

    expect(result).toMatchObject({ status: "failed", phase: "review" });
    expect(bootstrapped).toBe(false);
  });

  it("cleans its marker and returns a normalized failure when runtime bootstrap fails", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });

    const result = await runCodeReview(request, {
      github,
      bootstrapAgentRuntime: async () => {
        throw new Error("selected runtime is unavailable");
      },
      runWorkflow: createRunner([]),
    });

    expect(result).toMatchObject({
      status: "failed",
      phase: "review",
      error: {
        category: "RuntimeError",
        cause: { message: "selected runtime is unavailable" },
      },
    });
    expect(github.updates).toEqual([
      expect.stringContaining("seqlane-review-in-progress-run"),
      `\n${marker}`,
    ]);
  });

  it("closes the runtime and clears its marker when review workflow startup throws", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });
    let runtimeClosed = false;
    const runtime: AgentRuntime = {
      identity: "fixture",
      capabilities: {
        execute: true,
        modelSelection: false,
        structuredOutput: true,
        sessionReuse: false,
        checkpoint: false,
        fork: false,
        activity: false,
        sessionUi: false,
      },
      createAdapter: () => {
        throw new Error("The test runner does not execute tasks");
      },
      redactAdapter: (adapter) => adapter,
      close: async () => {
        runtimeClosed = true;
      },
    };

    const result = await runCodeReview(request, {
      github,
      bootstrapAgentRuntime: async () => runtime,
      runWorkflow: () => {
        throw new Error("workflow startup failed");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      phase: "review",
      error: {
        category: "RuntimeError",
        cause: { message: "workflow startup failed" },
      },
    });
    expect(runtimeClosed).toBe(true);
    expect(github.updates).toEqual([
      expect.stringContaining("seqlane-review-in-progress-run"),
      `\n${marker}`,
    ]);
  });

  it("uses the GitHub repository identity in the review report", async () => {
    let reviewInput: unknown;
    const result = await runCodeReview(request, {
      github: createGithubPort(true),
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
          if (index === 1) reviewInput = workflow.input;
        },
      ),
    });

    expect(result).toMatchObject({
      status: "published",
      publicationBody: "published report",
    });
    expect(reviewInput).toMatchObject({ repository: request.repository });
  });

  it("returns stale before starting a workflow when the PR is no longer live", async () => {
    const runner = createRunner([]);
    const result = await runCodeReview(request, {
      github: createGithubPort(false),
      runWorkflow: runner,
    });

    expect(result).toEqual({ status: "stale" });
  });

  it("updates an existing report without an ETag", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });

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
    });

    expect(result).toMatchObject({
      status: "published",
    });
    expect(github.updates).toHaveLength(2);
    expect(github.reads.authoritative).toBe(0);
  });

  it("cleans its marker after the pull-request head changes", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(
      true,
      { id: "report-1", body: marker },
      { liveRevisions: [headRevision, headRevision, "c".repeat(40)] },
    );

    const result = await runCodeReview(request, {
      github,
      runWorkflow: createRunner([{ status: "succeeded", result: {} }]),
    });

    expect(result.status).toBe("stale");
    expect(github.updates).toHaveLength(2);
    expect(github.updates[1]).toBe(`\n${marker}`);
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
      verdict: "approve",
    });
    expect(started).toHaveLength(1);
    expect(github.updates).toHaveLength(2);
    expect(github.updates[0]).toContain(
      `<!-- seqlane-review-in-progress-run: ${started[0]} -->`,
    );
    expect(github.updates[0]).toContain(
      "[View GitHub Actions run](https://github.com/owner/repository/actions/runs/123)",
    );
    expect(github.updates[1]).toBe(`\n${marker}`);
  });

  it("establishes report ownership before starting review execution", async () => {
    const marker = `<!-- seqlane-code-review -->\n<!-- seqlane-code-review-meta-v3: {"schemaVersion":3,"pullRequestNumber":1,"reviewedRevision":"${headRevision}","run":{"id":"0","attempt":1}} -->\nprevious report`;
    const github = createGithubPort(true, { id: "report-1", body: marker });
    let markerAtWorkflowStart: string | undefined;

    const result = await runCodeReview(request, {
      github,
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
          if (index === 1) {
            markerAtWorkflowStart = github.updates[0];
            expect(workflow.identity).toBeDefined();
          }
        },
      ),
    });

    expect(result.status).toBe("published");
    expect(markerAtWorkflowStart).toContain(
      "<!-- seqlane-review-in-progress-run:",
    );
  });

  it("creates and owns a marker before reviewing without a report", async () => {
    const github = createGithubPort(true);
    let markerAtWorkflowStart: string | undefined;
    let publicationInput: unknown;
    const result = await runCodeReview(request, {
      github,
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
          if (index === 1) markerAtWorkflowStart = github.updates[0];
          if (index === 2) publicationInput = workflow.input;
        },
      ),
      onRunStarted: ({ markerId }) => {
        expect(markerId).toBe("created-marker");
      },
    });

    expect(result.status).toBe("published");
    expect(markerAtWorkflowStart).toContain(
      "<!-- seqlane-review-in-progress-run:",
    );
    expect(markerAtWorkflowStart).toContain(
      "<!-- seqlane-code-review-meta-v4:",
    );
    expect(publicationInput).toMatchObject({
      existingReportId: "created-marker",
    });
    expect(github.reads.authoritative).toBe(0);
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
