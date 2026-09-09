import { jsonValueSchema } from "@seqlane/core";
import type { SeqlaneError } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import {
  startWorkflowRun,
  type StartWorkflowRunRequest,
  type WorkflowRunHandle,
} from "@seqlane/runtime";
import type { GitHubReviewPort } from "./github-port.js";
import {
  buildPublicationWorkflow,
  type PublicationPort,
} from "./publication-workflow.js";
import { guardPublicationTarget } from "./publication-guard.js";
import { publicationResultSchema } from "./publication-workflow.js";
import { type LivePullRequest, type ReviewTargetInput } from "./contracts.js";
import { findAuthoritativeReport } from "./github-port.js";
import { trustedCodeReviewWorkflow } from "./trusted-workflow.js";
import { BoundedEventRecorder } from "./event-recorder.js";

const markerStart = "<!-- seqlane-review-in-progress-start -->";
const markerEnd = "<!-- seqlane-review-in-progress-end -->";

function marker(runId: string): string {
  return [
    markerStart,
    `<!-- seqlane-review-in-progress-run: ${runId} -->`,
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
  adapter: GitHubReviewPort,
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
  )
    return;
  await adapter.updateReport(markerId, removeMarker(report.body));
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

function createPublicationPort(adapter: GitHubReviewPort): PublicationPort {
  return {
    checkLiveState: async ({
      repository,
      pullRequestNumber,
      expectedHeadRevision,
    }) =>
      isLivePullRequest(
        await adapter.readLivePullRequest(pullRequestNumber),
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
      const current = await adapter.readLivePullRequest(pullRequestNumber);
      if (!isLivePullRequest(current, repository, expectedHeadRevision))
        return "stale" as const;
      // Reconcile immediately before writing. This closes the create-vs-create
      // race and prevents an untrusted replacement from being updated merely
      // because its comment ID was observed earlier.
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

export interface ReviewRunStarted {
  readonly workId: string;
  readonly runId: string;
  readonly markerId?: string;
}

export interface CodeReviewRunRequest extends ReviewTargetInput {
  readonly githubRunId?: string;
  readonly attempt?: number;
}

export interface CodeReviewRunPorts {
  readonly github: GitHubReviewPort;
  readonly onRunStarted?: (run: ReviewRunStarted) => void | Promise<void>;
  /** Test seam for lifecycle orchestration; production defaults to runtime. */
  readonly runWorkflow?: WorkflowRunner;
}

export interface WorkflowRunner {
  <Input, Output>(
    request: StartWorkflowRunRequest<Input, Output>,
  ): WorkflowRunHandle;
}

export type CodeReviewRunResult =
  | { readonly status: "stale"; readonly runId?: string }
  | {
      readonly status: "cancelled";
      readonly workId: string;
      readonly runId: string;
      readonly phase: "review" | "publication";
    }
  | {
      readonly status: "failed";
      readonly workId: string;
      readonly runId: string;
      readonly phase: "review" | "publication";
      readonly error: SeqlaneError;
    }
  | {
      readonly status: "published";
      readonly workId: string;
      readonly runId: string;
      readonly verdict: "approve" | "request-changes";
      readonly publicationStatus: "published";
    };

/** Runs the trusted review and model-free publication lifecycle. */
export async function runCodeReview(
  request: CodeReviewRunRequest,
  ports: CodeReviewRunPorts,
): Promise<CodeReviewRunResult> {
  const adapter = ports.github;
  const runWorkflow = ports.runWorkflow ?? startWorkflowRun;
  const pullRequest = await adapter.readPullRequest(request.pullRequestNumber);
  const reviewHistory = await adapter.readComments(request.pullRequestNumber);
  const existingReport = findAuthoritativeReport(reviewHistory);
  const markerId = existingReport?.id;
  const liveBeforeRun = await adapter.readLivePullRequest(
    request.pullRequestNumber,
  );
  if (
    !isLivePullRequest(liveBeforeRun, request.repository, request.headRevision)
  )
    return { status: "stale" };

  const eventRecorder = new BoundedEventRecorder(10_000);
  const handle = runWorkflow({
    workflow: buildWorkflow(trustedCodeReviewWorkflow),
    input: {
      repository: request.reviewTarget,
      baseBranch: request.baseBranch,
      baseRevision: request.baseRevision,
      headRevision: request.headRevision,
      pullRequest,
      reviewHistory,
    },
    runtime: { id: request.runtime, workspace: request.reviewTarget },
    events: { emit: (event) => eventRecorder.emit(event) },
  });
  await ports.onRunStarted?.({
    workId: handle.workId,
    runId: handle.runId,
    ...(markerId === undefined ? {} : { markerId }),
  });
  if (markerId !== undefined) {
    await adapter.updateReport(
      markerId,
      marker(handle.runId) + "\n\n" + removeMarker(existingReport!.body),
    );
  }

  const outcome = await handle.outcome;
  if (outcome.status !== "succeeded") {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    return outcome.status === "cancelled"
      ? {
          status: "cancelled",
          workId: handle.workId,
          runId: handle.runId,
          phase: "review",
        }
      : {
          status: "failed",
          workId: handle.workId,
          runId: handle.runId,
          phase: "review",
          error: outcome.error,
        };
  }

  const live = await adapter.readLivePullRequest(request.pullRequestNumber);
  if (!isLivePullRequest(live, request.repository, request.headRevision)) {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    return { status: "stale", runId: handle.runId };
  }

  const snapshot = Object.freeze({
    report: jsonValueSchema.parse(outcome.result),
    events: jsonValueSchema.parse(eventRecorder.serializedEvents),
    eventsTruncated: eventRecorder.truncated,
    runId: handle.runId,
    ...(request.githubRunId === undefined
      ? {}
      : { githubRunId: request.githubRunId }),
    attempt: request.attempt ?? 1,
    completedAt: new Date().toISOString(),
  });
  const publicationHandle = runWorkflow({
    workflow: buildPublicationWorkflow(createPublicationPort(adapter)),
    input: {
      repository: request.repository,
      pullRequestNumber: request.pullRequestNumber,
      expectedHeadRevision: request.headRevision,
      githubRunId: snapshot.githubRunId ?? "0",
      attempt: snapshot.attempt,
      snapshot,
      existingReportId: markerId ?? "",
    },
    runtime: { id: "local", workspace: request.reviewTarget },
    events: { emit: () => undefined },
  });
  const publicationOutcome = await publicationHandle.outcome;
  if (publicationOutcome.status !== "succeeded") {
    await clearOwnedMarker(adapter, markerId, handle.runId);
    return publicationOutcome.status === "cancelled"
      ? {
          status: "cancelled",
          workId: handle.workId,
          runId: handle.runId,
          phase: "publication",
        }
      : {
          status: "failed",
          workId: handle.workId,
          runId: handle.runId,
          phase: "publication",
          error: publicationOutcome.error,
        };
  }
  const publicationResult = publicationResultSchema.parse(
    publicationOutcome.result,
  );
  await clearOwnedMarker(adapter, markerId, handle.runId);
  if (publicationResult.status === "stale")
    return { status: "stale", runId: handle.runId };
  return {
    status: "published",
    workId: handle.workId,
    runId: handle.runId,
    verdict: publicationResult.publication.verdict,
    publicationStatus: "published",
  };
}
