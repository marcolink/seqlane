import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildWorkflow, jsonValueSchema } from "@seqlane/core";
import { startWorkflowRun } from "@seqlane/runtime";
import {
  buildPublicationWorkflow,
  GitHubReviewAdapter,
  type GitHubReviewClient,
  publicationResultSchema,
  repositorySchema,
  reviewTargetInputSchema,
  trustedCodeReviewWorkflow,
  type PublicationPort,
  BoundedEventRecorder,
  guardPublicationTarget,
} from "@seqlane/action-code-review";

function input(name: string): string {
  return core.getInput(name, { required: true });
}
const markerStart = "<!-- seqlane-review-in-progress-start -->";
const markerEnd = "<!-- seqlane-review-in-progress-end -->";
function marker(runId: string): string {
  return [
    markerStart,
    "<!-- seqlane-review-in-progress-run: " + runId + " -->",
    "# ⏳ Another Seqlane review is currently in progress",
    "",
    "This report is being refreshed for a newer review run and will be updated when it finishes.",
    markerEnd,
  ].join("\n");
}
function removeMarker(body: string): string {
  return body.replace(
    /<!-- seqlane-review-in-progress-start -->[\s\S]*?<!-- seqlane-review-in-progress-end -->\n?/g,
    "",
  );
}
async function clearOwnedMarker(
  adapter: GitHubReviewAdapter,
  markerId: string | undefined,
  runId: string,
): Promise<void> {
  if (markerId === undefined) return;
  const report = await adapter.readIssueComment(markerId);
  const ownedByBot =
    report.author === "github-actions" ||
    report.author === "github-actions[bot]";
  const ownedMarker = `<!-- seqlane-review-in-progress-run: ${runId} -->`;
  if (
    !ownedByBot ||
    !report.body.includes(markerStart) ||
    !report.body.includes(markerEnd) ||
    !report.body.includes(ownedMarker)
  ) {
    return;
  }
  await adapter.updateReport(markerId, removeMarker(report.body));
}

type GitHubClient = ReturnType<typeof github.getOctokit>;
interface LivePullRequest {
  readonly state?: string;
  readonly draft?: boolean;
  readonly head?: {
    readonly repo?: { readonly full_name?: string };
    readonly sha?: string;
  };
}

function isLivePullRequest(
  pullRequest: LivePullRequest,
  repository: string,
  expectedHeadRevision: string,
): boolean {
  return (
    pullRequest.state === "open" &&
    pullRequest.draft !== true &&
    pullRequest.head?.repo?.full_name === repository &&
    pullRequest.head?.sha === expectedHeadRevision
  );
}

async function readPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<LivePullRequest> {
  return (await client.rest.pulls.get({ owner, repo, pull_number: number }))
    .data;
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

function createIssueCommentMethods(
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

function createReviewAdapter(
  client: GitHubClient,
  owner: string,
  repo: string,
): GitHubReviewAdapter {
  return new GitHubReviewAdapter(createGitHubReviewClient(client, owner, repo));
}

function createPublicationPort(
  client: GitHubClient,
  adapter: GitHubReviewAdapter,
  owner: string,
  repo: string,
): PublicationPort {
  return {
    checkLiveState: async ({
      repository,
      pullRequestNumber,
      expectedHeadRevision,
    }) =>
      isLivePullRequest(
        await readPullRequest(client, owner, repo, pullRequestNumber),
        repository,
        expectedHeadRevision,
      )
        ? "live"
        : "stale",
    publishReport: async ({
      repository,
      pullRequestNumber,
      expectedHeadRevision,
      workflowRunId,
      githubRunId,
      attempt,
      existingReportId,
      publication,
    }) => {
      const current = await readPullRequest(
        client,
        owner,
        repo,
        pullRequestNumber,
      );
      if (!isLivePullRequest(current, repository, expectedHeadRevision))
        return "stale" as const;
      // Reconcile the authoritative report immediately before writing. This
      // closes the create-vs-create race and prevents an untrusted replacement
      // from being updated merely because its comment ID was observed earlier.
      const authoritative =
        await adapter.readAuthoritativeReport(pullRequestNumber);
      const target = guardPublicationTarget(authoritative, {
        pullRequestNumber,
        expectedHeadRevision,
        workflowRunId,
        githubRunId,
        attempt,
      });
      if (target.status === "stale") return "stale" as const;
      if (target.status === "create") {
        if (existingReportId !== undefined) return "stale" as const;
        await adapter.createReport(pullRequestNumber, publication.body);
        return "published" as const;
      }
      await adapter.updateReport(target.report.id, publication.body);
      return "published" as const;
    },
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
  const adapter = createReviewAdapter(client, owner, repo);
  const pr = await adapter.readPullRequest(parsed.data.pullRequestNumber);
  const reviewHistory = await adapter.readComments(
    parsed.data.pullRequestNumber,
  );
  const existingReport = await adapter.readAuthoritativeReport(
    parsed.data.pullRequestNumber,
  );
  // The admission job and this Action run are separated by an arbitrary
  // queueing delay. Re-check the immutable review identity immediately before
  // writing the in-progress marker so a newer push cannot be claimed by this
  // run.
  const liveBeforeRun = await readPullRequest(
    client,
    owner,
    repo,
    parsed.data.pullRequestNumber,
  );
  if (
    !isLivePullRequest(
      liveBeforeRun,
      parsed.data.repository,
      parsed.data.headRevision,
    )
  ) {
    core.setOutput("publication-status", "stale");
    core.setOutput("verdict", "stale");
    return;
  }
  let markerId: string | undefined;
  if (existingReport !== undefined) {
    markerId = existingReport.id;
  }
  const eventRecorder = new BoundedEventRecorder(10_000);
  const handle = startWorkflowRun({
    workflow: buildWorkflow(trustedCodeReviewWorkflow),
    input: {
      repository: parsed.data.reviewTarget,
      baseBranch: parsed.data.baseBranch,
      baseRevision: parsed.data.baseRevision,
      headRevision: parsed.data.headRevision,
      pullRequest: pr,
      reviewHistory,
    },
    runtime: { id: parsed.data.runtime, workspace: parsed.data.reviewTarget },
    events: { emit: (event) => eventRecorder.emit(event) },
  });
  core.setOutput("work-id", handle.workId);
  core.setOutput("run-id", handle.runId);
  core.setOutput("reviewed-revision", parsed.data.headRevision);
  core.setOutput("publication-status", "not-published");
  core.saveState("review-run-id", handle.runId);
  if (markerId !== undefined) {
    core.saveState("review-marker-id", markerId);
    await adapter.updateReport(
      markerId,
      marker(handle.runId) + "\n\n" + removeMarker(existingReport!.body),
    );
  }
  const outcome = await handle.outcome;
  if (outcome.status !== "succeeded") {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    core.saveState("review-marker-id", "");
    core.setOutput(
      "verdict",
      outcome.status === "cancelled" ? "cancelled" : "error",
    );
    if (outcome.status === "failed") core.setFailed(outcome.error.category);
    return;
  }
  const live = await readPullRequest(
    client,
    owner,
    repo,
    parsed.data.pullRequestNumber,
  );
  if (
    !isLivePullRequest(live, parsed.data.repository, parsed.data.headRevision)
  ) {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    core.saveState("review-marker-id", "");
    core.setOutput("publication-status", "stale");
    return;
  }

  // Freeze the review boundary before starting the independent, model-free
  // publication run. Publication tasks can therefore never observe a mutable
  // event sink while the review run is still completing.
  const snapshot = Object.freeze({
    report: jsonValueSchema.parse(outcome.result),
    events: jsonValueSchema.parse(eventRecorder.events),
    eventsTruncated: eventRecorder.truncated,
    runId: handle.runId,
    ...(process.env.GITHUB_RUN_ID === undefined
      ? {}
      : { githubRunId: process.env.GITHUB_RUN_ID }),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    completedAt: new Date().toISOString(),
  });
  const publicationPort = createPublicationPort(client, adapter, owner, repo);
  const publicationHandle = startWorkflowRun({
    workflow: buildPublicationWorkflow(publicationPort),
    input: {
      repository: parsed.data.repository,
      pullRequestNumber: parsed.data.pullRequestNumber,
      expectedHeadRevision: parsed.data.headRevision,
      githubRunId: snapshot.githubRunId ?? "0",
      attempt: snapshot.attempt ?? 1,
      snapshot,
      existingReportId: markerId ?? "",
    },
    runtime: { id: "local", workspace: parsed.data.reviewTarget },
    events: { emit: () => undefined },
  });
  const publicationOutcome = await publicationHandle.outcome;
  if (publicationOutcome.status !== "succeeded") {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    core.saveState("review-marker-id", "");
    core.setOutput(
      "verdict",
      publicationOutcome.status === "cancelled" ? "cancelled" : "error",
    );
    core.setOutput("publication-status", "not-published");
    if (publicationOutcome.status === "failed")
      core.setFailed(publicationOutcome.error.category);
    return;
  }
  const publicationResult = publicationResultSchema.parse(
    publicationOutcome.result,
  );
  core.setOutput("verdict", publicationResult.publication.verdict);
  core.setOutput("publication-status", publicationResult.status);
  await clearOwnedMarker(adapter, markerId, handle.runId);
  core.saveState("review-marker-id", "");
}

if (process.env.NODE_ENV !== "test")
  run().catch((error: unknown) =>
    core.setFailed(
      error instanceof Error ? error.message : "Code review failed.",
    ),
  );
