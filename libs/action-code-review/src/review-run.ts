import { randomUUID } from "node:crypto";
import type { SeqlaneError } from "@seqlane/core";
import { buildWorkflow } from "@seqlane/core";
import { z } from "zod";
import {
  startWorkflowRun,
  type StartWorkflowRunRequest,
  type WorkflowRunHandle,
} from "@seqlane/runtime";
import {
  findAuthoritativeReport,
  type GitHubReviewPort,
} from "./github-port.js";
import {
  buildPublicationWorkflow,
  type PublicationPort,
} from "./workflows/publication-workflow.js";
import {
  guardPublicationTarget,
  type PublicationGuardInput,
} from "./publication-guard.js";
import { publicationResultSchema } from "./workflows/publication-workflow.js";
import { type LivePullRequest, type ReviewTargetInput } from "./contracts.js";
import trustedCodeReviewWorkflow from "@seqlane/code-review-workflow";
import { BoundedEventRecorder } from "./event-recorder.js";
import {
  createReviewProgress,
  type ReviewProgressPort,
} from "./review-progress.js";
import { githubActionsRunUrl } from "./publication-rendering.js";
import { normalizeReviewHistory } from "./review-history.js";

const markerStart = "<!-- seqlane-review-in-progress-start -->";
const markerEnd = "<!-- seqlane-review-in-progress-end -->";

function marker(runId: string, runUrl: string | undefined): string {
  return [
    markerStart,
    `<!-- seqlane-review-in-progress-run: ${runId} -->`,
    "# ⏳ Another Seqlane review is currently in progress",
    "",
    ...(runUrl === undefined
      ? []
      : [`[View GitHub Actions run](${runUrl})`, ""]),
    "This report is being refreshed for a newer review run and will be updated when it finishes.",
    markerEnd,
  ].join("\n");
}

function markerReport(request: CodeReviewRunRequest, runId: string): string {
  const metadata = JSON.stringify({
    schemaVersion: 3,
    pullRequestNumber: request.pullRequestNumber,
    reviewedRevision: request.headRevision,
    run: {
      id: request.githubRunId ?? "0",
      attempt: request.attempt ?? 1,
    },
  });
  return [
    "<!-- seqlane-code-review -->",
    `<!-- seqlane-code-review-meta-v3: ${metadata} -->`,
    marker(
      runId,
      githubActionsRunUrl(request.repository, request.githubRunId ?? ""),
    ),
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
  deleteMarker: boolean,
  input: PublicationGuardInput & {
    readonly repository: string;
  },
): Promise<void> {
  if (markerId === undefined) return;
  const report = await adapter.readIssueComment(markerId);
  const ownedMarker = `<!-- seqlane-review-in-progress-run: ${input.workflowRunId} -->`;
  const hasMarkerBoundary =
    report.body.includes(markerStart) || report.body.includes(markerEnd);
  // A report without a marker is already clean. Once a marker is present,
  // cleanup must prove both trusted ownership and the exact run identity. Do
  // not use the reviewed head here: a head change is precisely when cleanup
  // must still reclaim this run's marker.
  if (!hasMarkerBoundary) return;
  if (
    (report.author !== "github-actions" &&
      report.author !== "github-actions[bot]") ||
    !report.body.includes(markerStart) ||
    !report.body.includes(markerEnd) ||
    !report.body.includes(ownedMarker)
  ) {
    throw new Error("Could not prove ownership of the review marker.");
  }
  if (deleteMarker) await adapter.deleteComment(markerId);
  else await adapter.updateReport(markerId, removeMarker(report.body));
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

function publicationGuardInput(
  request: CodeReviewRunRequest,
  workflowRunId: string,
): PublicationGuardInput & { readonly repository: string } {
  return {
    repository: request.repository,
    pullRequestNumber: request.pullRequestNumber,
    expectedHeadRevision: request.headRevision,
    workflowRunId,
    githubRunId: request.githubRunId ?? "0",
    attempt: request.attempt ?? 1,
  };
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
      // Reconcile immediately before the conditional write. This prevents an
      // untrusted replacement or newer same-head run from being updated merely
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
        if (existingReportId !== "") return "stale" as const;
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
  readonly progress?: ReviewProgressPort;
  /** Test seam for deterministic Action-local progress elapsed time. */
  readonly now?: () => number;
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
      /** The exact bounded report body written to the pull-request comment. */
      readonly publicationBody: string;
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
  const normalizedHistory = normalizeReviewHistory(
    request.pullRequestNumber,
    reviewHistory,
  );
  const liveBeforeRun = await adapter.readLivePullRequest(
    request.pullRequestNumber,
  );
  if (
    !isLivePullRequest(liveBeforeRun, request.repository, request.headRevision)
  )
    return { status: "stale" };

  // Reserve the runtime identity before touching the report. The marker must
  // own the same identity that is passed to startWorkflowRun, so another run
  // cannot replace it between admission and execution.
  const reservedIdentity = { workId: randomUUID(), runId: randomUUID() };
  // The normalized history already fetched for the review is sufficient for
  // report discovery unless its bounded result was truncated. Keep the
  // authoritative reread in the publication path, immediately before its
  // mutation, where the latest state is required.
  const existingReport = reviewHistory.truncated
    ? await adapter.readAuthoritativeReport(request.pullRequestNumber)
    : findAuthoritativeReport(reviewHistory);
  let markerId = existingReport?.id;
  const markerCreated = markerId === undefined;
  const guardInput = publicationGuardInput(request, reservedIdentity.runId);

  if (markerId !== undefined) {
    // Save the bounded marker identity before the marker mutation and before
    // starting the expensive review. Post cleanup can therefore recover from
    // a failure during marker establishment itself.
    await ports.onRunStarted?.({
      workId: reservedIdentity.workId,
      runId: reservedIdentity.runId,
      markerId,
    });
    const liveForMarker = await adapter.readLivePullRequest(
      request.pullRequestNumber,
    );
    if (
      !isLivePullRequest(
        liveForMarker,
        request.repository,
        request.headRevision,
      )
    )
      return { status: "stale", runId: reservedIdentity.runId };
    const report = await adapter.readIssueComment(markerId);
    const target = guardPublicationTarget(report, guardInput);
    if (target.status !== "eligible")
      return { status: "stale", runId: reservedIdentity.runId };
    await adapter.updateReport(
      markerId,
      marker(
        reservedIdentity.runId,
        githubActionsRunUrl(request.repository, request.githubRunId ?? ""),
      ) +
        "\n\n" +
        removeMarker(report.body),
    );
  } else {
    // A missing report still needs an owned comment before expensive review
    // work starts. Workflow serialization makes the initial report discovery
    // the admission boundary for this create.
    const liveForMarker = await adapter.readLivePullRequest(
      request.pullRequestNumber,
    );
    if (
      !isLivePullRequest(
        liveForMarker,
        request.repository,
        request.headRevision,
      )
    )
      return { status: "stale", runId: reservedIdentity.runId };
    markerId = await adapter.createMarker(
      request.pullRequestNumber,
      markerReport(request, reservedIdentity.runId),
    );
    await ports.onRunStarted?.({
      workId: reservedIdentity.workId,
      runId: reservedIdentity.runId,
      markerId,
    });
  }

  const eventRecorder = new BoundedEventRecorder(10_000);
  const reviewProgress = createReviewProgress(ports.progress, {
    headRevision: request.headRevision,
    now: ports.now,
  });
  const handle = runWorkflow({
    workflow: buildWorkflow(trustedCodeReviewWorkflow),
    input: {
      repository: request.repository,
      baseBranch: request.baseBranch,
      baseRevision: request.baseRevision,
      headRevision: request.headRevision,
      pullRequest,
      reviewHistory: normalizedHistory.reviewHistory,
    },
    runtime: { id: request.runtime, workspace: request.reviewTarget },
    identity: reservedIdentity,
    events: {
      emit: (event) => {
        eventRecorder.emit(event);
        reviewProgress.emit(event);
      },
    },
  });

  const outcome = await handle.outcome;
  reviewProgress.complete(outcome.status);
  if (outcome.status !== "succeeded") {
    await clearOwnedMarker(
      adapter,
      markerId,
      markerCreated,
      publicationGuardInput(request, handle.runId),
    );
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
    await clearOwnedMarker(
      adapter,
      markerId,
      markerCreated,
      publicationGuardInput(request, handle.runId),
    );
    return { status: "stale", runId: handle.runId };
  }

  const workflowReport = z
    .record(z.string(), z.unknown())
    .parse(outcome.result);
  const snapshot = Object.freeze({
    report: {
      ...workflowReport,
      runMetricsLedger: normalizedHistory.runMetricsLedger,
    },
    events: eventRecorder.events,
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
    await clearOwnedMarker(
      adapter,
      markerId,
      markerCreated,
      publicationGuardInput(request, handle.runId),
    );
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
  await clearOwnedMarker(
    adapter,
    markerId,
    false,
    publicationGuardInput(request, handle.runId),
  );
  if (publicationResult.status === "stale")
    return { status: "stale", runId: handle.runId };
  return {
    status: "published",
    workId: handle.workId,
    runId: handle.runId,
    verdict: publicationResult.publication.verdict,
    publicationStatus: "published",
    publicationBody: publicationResult.publication.body,
  };
}
