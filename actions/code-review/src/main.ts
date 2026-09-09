import "./require-shim.js";

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  GitHubReviewAdapter,
  type GitHubReviewClient,
  repositorySchema,
  reviewTargetInputSchema,
  formatReviewProgressEvent,
  runCodeReview,
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
  request: () => Promise<{
    readonly data: unknown[];
    readonly headers: { readonly link?: string };
  }>,
): Promise<unknown> {
  const response = await request();
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
  request: () => Promise<{ readonly data: unknown }>,
): Promise<unknown> {
  return request().then((response) => response.data);
}

export function createIssueCommentMethods(
  client: GitHubClient,
  owner: string,
  repo: string,
): Pick<
  GitHubReviewClient,
  | "getIssueComment"
  | "createIssueComment"
  | "updateIssueComment"
  | "deleteIssueComment"
> {
  return {
    getIssueComment: (commentId) =>
      issueCommentRequest(() =>
        client.rest.issues.getComment({
          owner,
          repo,
          comment_id: Number(commentId),
        }),
      ),
    createIssueComment: (number, body) =>
      issueCommentRequest(() =>
        client.rest.issues.createComment({
          owner,
          repo,
          issue_number: number,
          body,
        }),
      ),
    updateIssueComment: (commentId, body) =>
      issueCommentRequest(() =>
        client.rest.issues.updateComment({
          owner,
          repo,
          comment_id: Number(commentId),
          body,
        }),
      ),
    deleteIssueComment: (commentId) =>
      issueCommentRequest(() =>
        client.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: Number(commentId),
        }),
      ),
  };
}

function createGitHubReviewClient(
  client: GitHubClient,
  owner: string,
  repo: string,
): GitHubReviewClient {
  return {
    getPullRequest: async (number) =>
      (await client.rest.pulls.get({ owner, repo, pull_number: number })).data,
    listIssueComments: (number, page = 1) =>
      fetchCommentPage(() =>
        client.rest.issues.listComments({
          owner,
          repo,
          issue_number: number,
          ...commentPageOptions(page),
        }),
      ),
    listReviewComments: (number, page = 1) =>
      fetchCommentPage(() =>
        client.rest.pulls.listReviewComments({
          owner,
          repo,
          pull_number: number,
          ...commentPageOptions(page),
        }),
      ),
    ...createIssueCommentMethods(client, owner, repo),
  };
}

export async function run(): Promise<void> {
  const token = input("github-token");
  core.setSecret(token);
  const raw = {
    repository: input("repository"),
    pullRequestNumber: Number(input("pull-request-number")),
    reviewTarget: input("review-target"),
    baseBranch: input("base-branch"),
    baseRevision: input("base-revision"),
    headRevision: input("head-revision"),
    runtime: input("runtime"),
  };
  const parsed = reviewTargetInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid code-review Action inputs.");
  const { owner, repo } = repositorySchema.parse(parsed.data.repository);
  const client = github.getOctokit(token);
  const adapter = new GitHubReviewAdapter(
    createGitHubReviewClient(client, owner, repo),
  );
  core.setOutput("reviewed-revision", parsed.data.headRevision);
  core.setOutput("publication-status", "not-published");
  const failureContext = createReviewFailureContext();

  const result = await runCodeReview(
    {
      ...parsed.data,
      ...(process.env.GITHUB_RUN_ID === undefined
        ? {}
        : { githubRunId: process.env.GITHUB_RUN_ID }),
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    },
    {
      github: adapter,
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
  await appendPublicationSummary(result.publicationBody);
  core.saveState("review-marker-id", "");
}

if (process.env.NODE_ENV !== "test")
  run().catch((error: unknown) =>
    core.setFailed(
      error instanceof Error ? error.message : "Code review failed.",
    ),
  );
