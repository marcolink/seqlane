import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildWorkflow,
  jsonValueSchema,
  type SeqlaneEvent,
} from "@seqlane/core";
import { startWorkflowRun } from "@seqlane/runtime";
import {
  buildPublicationWorkflow,
  GitHubReviewAdapter,
  publicationResultSchema,
  repositorySchema,
  reviewPublicationMetadataSchema,
  reviewTargetInputSchema,
  trustedCodeReviewWorkflow,
  type PublicationPort,
} from "@seqlane/action-code-review";

function input(name: string): string { return core.getInput(name, { required: true }); }
const markerStart = "<!-- seqlane-review-in-progress-start -->";
const markerEnd = "<!-- seqlane-review-in-progress-end -->";
function marker(runId: string): string {
  return [markerStart, "<!-- seqlane-review-in-progress-run: " + runId + " -->", "# ⏳ Another Seqlane review is currently in progress", "", "This report is being refreshed for a newer review run and will be updated when it finishes.", markerEnd].join("\n");
}
function removeMarker(body: string): string {
  return body.replace(/<!-- seqlane-review-in-progress-start -->[\s\S]*?<!-- seqlane-review-in-progress-end -->\n?/g, "");
}
function reportRunMetadata(body: string):
  | { readonly id: string; readonly attempt: number; readonly reviewedRevision: string }
  | undefined {
  const matches = [
    ...body.matchAll(/<!-- seqlane-code-review-meta-v3: ([^\r\n]+) -->/g),
  ];
  if (matches.length !== 1) return undefined;
  try {
    const parsed = reviewPublicationMetadataSchema.safeParse(
      JSON.parse(matches[0]![1]!),
    );
    if (!parsed.success) return undefined;
    return {
      id: parsed.data.run.id,
      attempt: parsed.data.run.attempt,
      reviewedRevision: parsed.data.reviewedRevision,
    };
  } catch {
    return undefined;
  }
}
function compareRunIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, "") || "0";
  const normalizedRight = right.replace(/^0+/, "") || "0";
  return normalizedLeft.length === normalizedRight.length
    ? normalizedLeft.localeCompare(normalizedRight)
    : normalizedLeft.length - normalizedRight.length;
}
async function clearOwnedMarker(
  adapter: GitHubReviewAdapter,
  markerId: string | undefined,
  runId: string,
): Promise<void> {
  if (markerId === undefined) return;
  const report = await adapter.readIssueComment(markerId);
  const ownedByBot =
    report.author === "github-actions" || report.author === "github-actions[bot]";
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
  const adapter = new GitHubReviewAdapter({
    getPullRequest: async (number) => (await client.rest.pulls.get({ owner, repo, pull_number: number })).data,
    listIssueComments: async (number) => client.paginate(client.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    listReviewComments: async (number) => client.paginate(client.rest.pulls.listReviewComments, { owner, repo, pull_number: number, per_page: 100 }),
    getIssueComment: async (commentId) => (await client.rest.issues.getComment({ owner, repo, comment_id: Number(commentId) })).data,
    createIssueComment: async (number, body) => (await client.rest.issues.createComment({ owner, repo, issue_number: number, body })).data,
    updateIssueComment: async (commentId, body) => (await client.rest.issues.updateComment({ owner, repo, comment_id: Number(commentId), body })).data,
    deleteIssueComment: async (commentId) => (await client.rest.issues.deleteComment({ owner, repo, comment_id: Number(commentId) })).data,
  });
  const pr = await adapter.readPullRequest(parsed.data.pullRequestNumber);
  const reviewHistory = await adapter.readComments(
    parsed.data.pullRequestNumber,
  );
  const existingReport = await adapter.readAuthoritativeReport(parsed.data.pullRequestNumber);
  // The admission job and this Action run are separated by an arbitrary
  // queueing delay. Re-check the immutable review identity immediately before
  // writing the in-progress marker so a newer push cannot be claimed by this
  // run.
  const liveBeforeRun = (await client.rest.pulls.get({ owner, repo, pull_number: parsed.data.pullRequestNumber })).data;
  if (liveBeforeRun.state !== "open" || liveBeforeRun.draft === true ||
      liveBeforeRun.head?.repo?.full_name !== parsed.data.repository ||
      liveBeforeRun.head?.sha !== parsed.data.headRevision) {
    core.setOutput("publication-status", "stale");
    core.setOutput("verdict", "stale");
    return;
  }
  let markerId: string | undefined;
  if (existingReport !== undefined) {
    markerId = existingReport.id;
  }
  const events: SeqlaneEvent[] = [];
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
    events: { emit: (event) => events.push(event) },
  });
  core.setOutput("work-id", handle.workId);
  core.setOutput("run-id", handle.runId);
  core.setOutput("reviewed-revision", parsed.data.headRevision);
  core.setOutput("publication-status", "not-published");
  core.saveState("review-run-id", handle.runId);
  if (markerId !== undefined) {
    core.saveState("review-marker-id", markerId);
    await adapter.updateReport(markerId, marker(handle.runId) + "\n\n" + removeMarker(existingReport!.body));
  }
  const outcome = await handle.outcome;
  if (outcome.status !== "succeeded") {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    core.saveState("review-marker-id", "");
    core.setOutput("verdict", outcome.status === "cancelled" ? "cancelled" : "error");
    if (outcome.status === "failed") core.setFailed(outcome.error.category);
    return;
  }
  const live = (await client.rest.pulls.get({ owner, repo, pull_number: parsed.data.pullRequestNumber })).data;
  if (live.state !== "open" || live.draft === true ||
      live.head?.repo?.full_name !== parsed.data.repository ||
      live.head?.sha !== parsed.data.headRevision) {
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
    events: jsonValueSchema.parse(events),
    runId: handle.runId,
    ...(process.env.GITHUB_RUN_ID === undefined ? {} : { githubRunId: process.env.GITHUB_RUN_ID }),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    completedAt: new Date().toISOString(),
  });
  const publicationPort: PublicationPort = {
    checkLiveState: async ({ repository, pullRequestNumber, expectedHeadRevision }) => {
      const current = (await client.rest.pulls.get({ owner, repo, pull_number: pullRequestNumber })).data;
      return current.state === "open" && current.draft !== true &&
        current.head?.repo?.full_name === repository && current.head?.sha === expectedHeadRevision
        ? "live" : "stale";
    },
    publishReport: async ({ repository, pullRequestNumber, expectedHeadRevision, workflowRunId, githubRunId, attempt, existingReportId, publication }) => {
      const current = (await client.rest.pulls.get({ owner, repo, pull_number: pullRequestNumber })).data;
      if (current.state !== "open" || current.draft === true ||
          current.head?.repo?.full_name !== repository || current.head?.sha !== expectedHeadRevision) {
        return "stale" as const;
      }
      if (existingReportId === undefined) {
        await adapter.createReport(pullRequestNumber, publication.body);
        return "published" as const;
      }
      const existing = await adapter.readIssueComment(existingReportId);
      const markerMatch = existing.body.match(
        /<!-- seqlane-review-in-progress-run: ([^\r\n]+) -->/,
      );
      if (markerMatch !== null && markerMatch[1] !== workflowRunId) {
        return "stale" as const;
      }
      const prior = reportRunMetadata(existing.body);
      if (prior?.reviewedRevision === expectedHeadRevision) {
        if (
          compareRunIds(prior.id, githubRunId) > 0 ||
          (compareRunIds(prior.id, githubRunId) === 0 && prior.attempt > attempt)
        ) {
          return "stale" as const;
        }
      }
      await adapter.updateReport(existingReportId, publication.body);
      return "published" as const;
    },
  };
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
    core.setOutput("verdict", publicationOutcome.status === "cancelled" ? "cancelled" : "error");
    core.setOutput("publication-status", "not-published");
    if (publicationOutcome.status === "failed") core.setFailed(publicationOutcome.error.category);
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

if (process.env.NODE_ENV !== "test") run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : "Code review failed."));
