import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";
import { Effect } from "effect";
import { createOpenCodeAgentRuntimeFactory } from "@seqlane/opencode-adapter";
import {
  GitHubReviewAdapter,
  type GitHubReviewClient,
  repositorySchema,
  reviewTargetInputSchema,
  formatReviewProgressEvent,
  runCodeReviewEffect,
} from "@seqlane/action-code-review";
import {
  createReviewFailureContext,
  formatCodeReviewFailure,
} from "./failure-diagnostics.js";

function input(name: string): string {
  return core.getInput(name, { required: true });
}

export type GitHubClient = ReturnType<typeof github.getOctokit>;

interface SummaryWriter {
  addRaw(value: string): { write(): Promise<unknown> };
}

/** Appends the same rendered report that was published to the PR comment. */
export async function appendPublicationSummary(
  body: string,
  summary: SummaryWriter = core.summary,
): Promise<void> {
  await summary.addRaw(body).write();
}

async function fetchCommentPage(
  request: (signal?: AbortSignal) => Promise<{
    readonly data: unknown[];
    readonly headers: { readonly link?: string };
  }>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await request(signal);
  return {
    items: response.data,
    hasNextPage: response.headers.link?.includes('rel="next"') === true,
  };
}

function commentPageOptions(page: number): {
  readonly per_page: 100;
  readonly page: number;
  readonly sort: "updated";
  readonly direction: "desc";
} {
  return { per_page: 100, page, sort: "updated", direction: "desc" };
}

function issueCommentRequest(
  request: (signal?: AbortSignal) => Promise<{ readonly data: unknown }>,
  signal?: AbortSignal,
): Promise<unknown> {
  return request(signal).then((response) => response.data);
}

function requestOptions(signal: AbortSignal | undefined): {
  readonly request?: { readonly signal: AbortSignal };
} {
  return signal === undefined ? {} : { request: { signal } };
}

export function createIssueCommentMethods(
  client: GitHubClient,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Pick<
  GitHubReviewClient,
  | "getIssueComment"
  | "createIssueComment"
  | "updateIssueComment"
  | "deleteIssueComment"
> {
  return {
    getIssueComment: (commentId, requestSignal) =>
      issueCommentRequest(
        (activeSignal) =>
          client.rest.issues.getComment({
            owner,
            repo,
            comment_id: Number(commentId),
            ...requestOptions(activeSignal ?? signal),
          }),
        requestSignal ?? signal,
      ),
    createIssueComment: (number, body, requestSignal) =>
      issueCommentRequest(
        (activeSignal) =>
          client.rest.issues.createComment({
            owner,
            repo,
            issue_number: number,
            body,
            ...requestOptions(activeSignal ?? signal),
          }),
        requestSignal ?? signal,
      ),
    updateIssueComment: (commentId, body, requestSignal) =>
      issueCommentRequest(
        (activeSignal) =>
          client.rest.issues.updateComment({
            owner,
            repo,
            comment_id: Number(commentId),
            body,
            ...requestOptions(activeSignal ?? signal),
          }),
        requestSignal ?? signal,
      ),
    deleteIssueComment: (commentId, requestSignal) =>
      issueCommentRequest(
        (activeSignal) =>
          client.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: Number(commentId),
            ...requestOptions(activeSignal ?? signal),
          }),
        requestSignal ?? signal,
      ),
  };
}

function createGitHubReviewClient(
  client: GitHubClient,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): GitHubReviewClient {
  return {
    getPullRequest: async (number, requestSignal) =>
      (
        await client.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
          ...requestOptions(requestSignal ?? signal),
        })
      ).data,
    listIssueComments: (number, page = 1, requestSignal) =>
      fetchCommentPage(
        (activeSignal) =>
          client.rest.issues.listComments({
            owner,
            repo,
            issue_number: number,
            ...commentPageOptions(page),
            ...requestOptions(activeSignal ?? requestSignal ?? signal),
          }),
        requestSignal,
      ),
    ...createIssueCommentMethods(client, owner, repo, signal),
  };
}

function interruptionSignal(): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onInt = () =>
    controller.abort(new Error("Action interrupted by SIGINT."));
  const onTerm = () =>
    controller.abort(new Error("Action interrupted by SIGTERM."));
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    },
  };
}

export async function run(): Promise<void> {
  const { signal, dispose } = interruptionSignal();
  const program = Effect.gen(function* () {
    const token = yield* Effect.sync(() => input("github-token"));
    yield* Effect.sync(() => core.setSecret(token));
    const raw = {
      repository: yield* Effect.sync(() => input("repository")),
      pullRequestNumber: Number(
        yield* Effect.sync(() => input("pull-request-number")),
      ),
      reviewTarget: yield* Effect.sync(() => input("review-target")),
      baseBranch: yield* Effect.sync(() => input("base-branch")),
      baseRevision: yield* Effect.sync(() => input("base-revision")),
      headRevision: yield* Effect.sync(() => input("head-revision")),
      runtime: yield* Effect.sync(() => input("runtime")),
    };
    const parsed = reviewTargetInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid code-review Action inputs.");
    const { owner, repo } = repositorySchema.parse(parsed.data.repository);
    const client = yield* Effect.sync(() => github.getOctokit(token));
    const adapter = new GitHubReviewAdapter(
      createGitHubReviewClient(client, owner, repo, signal),
    );
    core.setOutput("reviewed-revision", parsed.data.headRevision);
    core.setOutput("publication-status", "not-published");
    const failureContext = createReviewFailureContext();
    const createAgentRuntime = createOpenCodeAgentRuntimeFactory({
      adapter: "opencode",
      url: parsed.data.runtime,
    });

    const result = yield* runCodeReviewEffect(
      {
        ...parsed.data,
        ...(process.env.GITHUB_RUN_ID === undefined
          ? {}
          : { githubRunId: process.env.GITHUB_RUN_ID }),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
      },
      {
        github: adapter,
        bootstrapAgentRuntime: (workspace) =>
          createAgentRuntime(signal, workspace),
        signal,
        onRunStarted: ({ workId, runId, markerId }) => {
          core.setOutput("work-id", workId);
          core.setOutput("run-id", runId);
          core.saveState("review-run-id", runId);
          core.saveState("review-marker-id", markerId ?? "");
        },
        progress: {
          write: (event) => {
            failureContext.observe(event);
            core.info(formatReviewProgressEvent(event));
          },
        },
      },
    );

    if (result.status === "stale") {
      core.setOutput("publication-status", "stale");
      if (result.runId === undefined) core.setOutput("verdict", "stale");
      core.saveState("review-marker-id", "");
      return;
    }
    if (result.status === "cancelled") {
      core.setOutput("verdict", "cancelled");
      core.saveState("review-marker-id", "");
      return;
    }
    if (result.status === "failed") {
      core.setOutput("verdict", "error");
      core.saveState("review-marker-id", "");
      core.setFailed(
        formatCodeReviewFailure(result.error, failureContext.snapshot()),
      );
      return;
    }
    core.setOutput("verdict", result.verdict);
    core.setOutput("publication-status", result.publicationStatus);
    yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () => appendPublicationSummary(result.publicationBody),
        catch: (cause) => cause,
      }),
    );
    core.saveState("review-marker-id", "");
  });
  try {
    await Effect.runPromise(Effect.scoped(program), { signal });
  } catch (cause) {
    if (!signal.aborted) throw cause;
    core.setOutput("verdict", "cancelled");
    core.setOutput("publication-status", "not-published");
  } finally {
    dispose();
  }
}

if (process.env.NODE_ENV !== "test")
  run().catch((error: unknown) =>
    core.setFailed(
      error instanceof Error ? error.message : "Code review failed.",
    ),
  );
