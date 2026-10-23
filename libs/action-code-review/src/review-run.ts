import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { RuntimeError, type SeqlaneError } from "@seqlane/core";
import { CodeReviewError } from "./errors.js";
import type { AgentRuntime } from "@seqlane/agent-adapter";
import { buildWorkflow } from "@seqlane/core";
import { z } from "zod";
import { Effect } from "effect";
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
import {
  type LivePullRequest,
  type PullRequestContext,
  type ReviewHistory,
  type ReviewTargetInput,
} from "./contracts.js";
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
    schemaVersion: 4,
    pullRequestNumber: request.pullRequestNumber,
    reviewedRevision: request.headRevision,
    run: {
      id: request.githubRunId ?? "0",
      attempt: request.attempt ?? 1,
    },
  });
  return [
    "<!-- seqlane-code-review -->",
    `<!-- seqlane-code-review-meta-v4: ${metadata} -->`,
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

const io = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const promise = Promise.resolve().then(() => run(controller.signal));
          return { controller, promise };
        }),
        ({ controller, promise }) =>
          Effect.promise(async () => {
            controller.abort(new Error("Review operation interrupted."));
            await promise.then(
              () => undefined,
              () => undefined,
            );
          }),
      );
      return yield* Effect.tryPromise({
        try: () => request.promise,
        catch: (cause) => cause,
      });
    }),
  );

function clearOwnedMarker(
  adapter: GitHubReviewPort,
  markerId: string | undefined,
  deleteMarker: boolean,
  input: PublicationGuardInput & {
    readonly repository: string;
  },
): Effect.Effect<void, unknown> {
  if (markerId === undefined) return Effect.void;
  return Effect.gen(function* () {
    const report = yield* io((signal) =>
      adapter.readIssueComment(markerId, signal),
    );
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
    if (deleteMarker)
      yield* io((signal) => adapter.deleteComment(markerId, signal));
    else
      yield* io((signal) =>
        adapter.updateReport(markerId, removeMarker(report.body), signal),
      );
  });
}

function startWorkflowWithCleanup(
  start: () => WorkflowRunHandle,
  identity: { readonly workId: string; readonly runId: string },
  cleanup: readonly (() => Effect.Effect<unknown, unknown>)[],
  onStarted?: () => void,
): Effect.Effect<WorkflowRunHandle, never> {
  return Effect.uninterruptible(
    Effect.try({
      try: () => {
        const handle = start();
        onStarted?.();
        return handle;
      },
      catch: (cause) => cause,
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const cleanupResults = yield* Effect.all(
          cleanup.map((step) =>
            Effect.match(step(), {
              onFailure: (error) => ({
                status: "rejected" as const,
                reason: error,
              }),
              onSuccess: () => ({ status: "fulfilled" as const }),
            }),
          ),
          { concurrency: "unbounded" },
        );
        const cleanupFailures = cleanupResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        const failureCause =
          cleanupFailures.length === 0
            ? cause
            : new AggregateError(
                [cause, ...cleanupFailures],
                "Workflow startup and cleanup failed",
              );
        return {
          ...identity,
          outcome: Promise.resolve({
            status: "failed" as const,
            error: new RuntimeError(failureCause),
          }),
          cancel: async () => undefined,
        };
      }),
    ),
  );
}

type ReviewWorkflowStartRequest = {
  readonly request: CodeReviewRunRequest;
  readonly pullRequest: PullRequestContext;
  readonly reviewHistory: ReviewHistory;
  readonly agentRuntime: AgentRuntime | undefined;
  readonly reviewTarget: string;
  readonly identity: NonNullable<StartWorkflowRunRequest["identity"]>;
  readonly events: StartWorkflowRunRequest["events"];
  readonly onObservation: StartWorkflowRunRequest["onObservation"];
  readonly adapter: GitHubReviewPort;
  readonly markerId: string | undefined;
  readonly markerCreated: boolean;
  readonly signal?: AbortSignal;
  readonly onStarted?: () => void;
};

function startReviewWorkflow(
  runWorkflow: WorkflowRunner,
  start: ReviewWorkflowStartRequest,
): Effect.Effect<WorkflowRunHandle, never> {
  return startWorkflowWithCleanup(
    () =>
      runWorkflow({
        workflow: buildWorkflow(trustedCodeReviewWorkflow),
        input: {
          repository: start.request.repository,
          baseBranch: start.request.baseBranch,
          baseRevision: start.request.baseRevision,
          headRevision: start.request.headRevision,
          pullRequest: start.pullRequest,
          reviewHistory: start.reviewHistory,
        },
        agentRuntime: start.agentRuntime,
        workspace: start.reviewTarget,
        identity: start.identity,
        events: start.events,
        onObservation: start.onObservation,
        signal: start.signal,
      }),
    start.identity,
    [
      () =>
        clearOwnedMarker(
          start.adapter,
          start.markerId,
          start.markerCreated,
          publicationGuardInput(start.request, start.identity.runId),
        ),
    ],
    start.onStarted,
  );
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

export function createPublicationPort(
  adapter: GitHubReviewPort,
  signal?: AbortSignal,
): PublicationPort {
  return {
    checkLiveState: async ({
      repository,
      pullRequestNumber,
      expectedHeadRevision,
    }) =>
      isLivePullRequest(
        await adapter.readLivePullRequest(pullRequestNumber, signal),
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
      const current = await adapter.readLivePullRequest(
        pullRequestNumber,
        signal,
      );
      if (!isLivePullRequest(current, repository, expectedHeadRevision))
        return "stale" as const;
      // Reconcile immediately before the conditional write. This prevents an
      // untrusted replacement or newer same-head run from being updated merely
      // because its comment ID was observed earlier.
      const authoritative = await adapter.readAuthoritativeReport(
        pullRequestNumber,
        signal,
      );
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
        await adapter.createReport(pullRequestNumber, publication.body, signal);
      } else {
        await adapter.updateReport(target.report.id, publication.body, signal);
      }
      const confirmed = await adapter.readAuthoritativeReport(
        pullRequestNumber,
        signal,
      );
      const confirmation = guardPublicationTarget(confirmed, {
        pullRequestNumber,
        expectedHeadRevision,
        workflowRunId,
        githubRunId,
        attempt,
      });
      if (
        confirmed === undefined ||
        confirmed.body !== publication.body ||
        (target.status === "eligible" && confirmed.id !== target.report.id) ||
        confirmation.status !== "eligible"
      ) {
        throw new CodeReviewError(
          "publication",
          "PUBLICATION_NOT_CONFIRMED",
          "GitHub did not confirm the exact review report write.",
        );
      }
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
  /** Bootstraps the selected agent runtime after review admission succeeds. */
  readonly bootstrapAgentRuntime?: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<AgentRuntime>;
  readonly onRunStarted?: (run: ReviewRunStarted) => void | Promise<void>;
  readonly progress?: ReviewProgressPort;
  /** Receives the complete canonical observations produced by the run. */
  readonly onObservation?: StartWorkflowRunRequest["onObservation"];
  /** Test seam for deterministic Action-local progress elapsed time. */
  readonly now?: () => number;
  /** Test seam for lifecycle orchestration; production defaults to runtime. */
  readonly runWorkflow?: WorkflowRunner;
  /** Action composition signal for the review and publication executions. */
  readonly signal?: AbortSignal;
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
export function runCodeReviewEffect(
  request: CodeReviewRunRequest,
  ports: CodeReviewRunPorts,
): Effect.Effect<CodeReviewRunResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const adapter = ports.github;
      const runWorkflow = ports.runWorkflow ?? startWorkflowRun;
      const pullRequest = yield* io((signal) =>
        adapter.readPullRequest(request.pullRequestNumber, signal),
      );
      const reviewHistory = yield* io((signal) =>
        adapter.readComments(request.pullRequestNumber, signal),
      );
      const normalizedHistory = normalizeReviewHistory(
        request.pullRequestNumber,
        reviewHistory,
      );
      const liveBeforeRun = yield* io((signal) =>
        adapter.readLivePullRequest(request.pullRequestNumber, signal),
      );
      if (
        !isLivePullRequest(
          liveBeforeRun,
          request.repository,
          request.headRevision,
        )
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
        ? yield* io((signal) =>
            adapter.readAuthoritativeReport(request.pullRequestNumber, signal),
          )
        : findAuthoritativeReport(reviewHistory);
      let markerId = existingReport?.id;
      const markerCreated = markerId === undefined;
      const guardInput = publicationGuardInput(request, reservedIdentity.runId);

      if (markerId !== undefined) {
        // Save the bounded marker identity before the marker mutation and before
        // starting the expensive review. Post cleanup can therefore recover from
        // a failure during marker establishment itself.
        yield* io(() =>
          Promise.resolve(
            ports.onRunStarted?.({
              workId: reservedIdentity.workId,
              runId: reservedIdentity.runId,
              markerId,
            }),
          ),
        );
        const liveForMarker = yield* io((signal) =>
          adapter.readLivePullRequest(request.pullRequestNumber, signal),
        );
        if (
          !isLivePullRequest(
            liveForMarker,
            request.repository,
            request.headRevision,
          )
        )
          return { status: "stale", runId: reservedIdentity.runId };
        const report = yield* io((signal) =>
          adapter.readIssueComment(markerId!, signal),
        );
        const target = guardPublicationTarget(report, guardInput);
        if (target.status !== "eligible")
          return { status: "stale", runId: reservedIdentity.runId };
        yield* io((signal) =>
          adapter.updateReport(
            markerId!,
            marker(
              reservedIdentity.runId,
              githubActionsRunUrl(
                request.repository,
                request.githubRunId ?? "",
              ),
            ) +
              "\n\n" +
              removeMarker(report.body),
            signal,
          ),
        );
      } else {
        // A missing report still needs an owned comment before expensive review
        // work starts. Workflow serialization makes the initial report discovery
        // the admission boundary for this create.
        const liveForMarker = yield* io((signal) =>
          adapter.readLivePullRequest(request.pullRequestNumber, signal),
        );
        if (
          !isLivePullRequest(
            liveForMarker,
            request.repository,
            request.headRevision,
          )
        )
          return { status: "stale", runId: reservedIdentity.runId };
        markerId = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const created = yield* io((signal) =>
              adapter.createMarker(
                request.pullRequestNumber,
                markerReport(request, reservedIdentity.runId),
                signal,
              ),
            );
            yield* io(() =>
              Promise.resolve(
                ports.onRunStarted?.({
                  workId: reservedIdentity.workId,
                  runId: reservedIdentity.runId,
                  markerId: created,
                }),
              ),
            );
            return created;
          }),
        );
      }

      const eventRecorder = new BoundedEventRecorder(10_000);
      const reviewProgress = createReviewProgress(ports.progress, {
        headRevision: request.headRevision,
        now: ports.now,
      });
      let agentRuntimeTransferred = false;
      const bootstrap = yield* Effect.match(
        Effect.gen(function* () {
          const reviewTarget = yield* io(() => realpath(request.reviewTarget));
          const agentRuntime = yield* Effect.acquireRelease(
            io(
              (signal) =>
                ports.bootstrapAgentRuntime?.(reviewTarget, signal) ??
                Promise.resolve(undefined),
            ),
            (runtime) => {
              const close = runtime?.close;
              return close === undefined || agentRuntimeTransferred
                ? Effect.void
                : io(() => close.call(runtime)).pipe(Effect.orDie);
            },
          );
          return { reviewTarget, agentRuntime };
        }),
        {
          onFailure: (cause) => ({ error: cause }),
          onSuccess: (value) => ({ value }),
        },
      );
      if ("error" in bootstrap) {
        yield* clearOwnedMarker(
          adapter,
          markerId,
          markerCreated,
          publicationGuardInput(request, reservedIdentity.runId),
        );
        return {
          status: "failed",
          workId: reservedIdentity.workId,
          runId: reservedIdentity.runId,
          phase: "review",
          error: new RuntimeError(bootstrap.error),
        };
      }
      const { reviewTarget, agentRuntime } = bootstrap.value;
      let reviewSettled = false;
      const handle = yield* Effect.acquireRelease(
        startReviewWorkflow(runWorkflow, {
          request,
          pullRequest,
          reviewHistory: normalizedHistory.reviewHistory,
          agentRuntime,
          reviewTarget,
          identity: reservedIdentity,
          adapter,
          markerId,
          markerCreated,
          events: {
            emit: (event) => {
              eventRecorder.emit(event);
              reviewProgress.emit(event);
            },
          },
          onObservation: ports.onObservation,
          signal: ports.signal,
          onStarted: () => {
            agentRuntimeTransferred = true;
          },
        }),
        (handle) =>
          reviewSettled
            ? Effect.void
            : Effect.uninterruptible(
                io(() => handle.cancel())
                  .pipe(Effect.andThen(io(() => handle.outcome)), Effect.asVoid)
                  .pipe(Effect.catchCause(() => Effect.void)),
              ),
      );

      const outcome = yield* io(() => handle.outcome);
      reviewSettled = true;
      reviewProgress.complete(outcome.status);
      if (outcome.status !== "succeeded") {
        yield* clearOwnedMarker(
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

      const live = yield* io((signal) =>
        adapter.readLivePullRequest(request.pullRequestNumber, signal),
      );
      if (!isLivePullRequest(live, request.repository, request.headRevision)) {
        yield* clearOwnedMarker(
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
      let publicationSettled = false;
      const publicationHandle = yield* startWorkflowWithCleanup(
        () =>
          runWorkflow({
            workflow: buildPublicationWorkflow(
              createPublicationPort(adapter, ports.signal),
            ),
            input: {
              repository: request.repository,
              pullRequestNumber: request.pullRequestNumber,
              expectedHeadRevision: request.headRevision,
              githubRunId: snapshot.githubRunId ?? "0",
              attempt: snapshot.attempt,
              snapshot,
              existingReportId: markerId ?? "",
            },
            workspace: reviewTarget,
            events: { emit: () => undefined },
            signal: ports.signal,
          }),
        handle.workId === undefined
          ? reservedIdentity
          : { workId: handle.workId, runId: handle.runId },
        [],
      );
      const publicationOutcome = yield* Effect.acquireRelease(
        Effect.succeed(publicationHandle),
        (current) =>
          publicationSettled
            ? Effect.void
            : Effect.uninterruptible(
                io(() => current.cancel())
                  .pipe(
                    Effect.andThen(io(() => current.outcome)),
                    Effect.asVoid,
                  )
                  .pipe(Effect.catchCause(() => Effect.void)),
              ),
      ).pipe(Effect.flatMap((current) => io(() => current.outcome)));
      publicationSettled = true;
      if (publicationOutcome.status !== "succeeded") {
        yield* clearOwnedMarker(
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
      yield* clearOwnedMarker(
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
    }),
  );
}

export function runCodeReview(
  request: CodeReviewRunRequest,
  ports: CodeReviewRunPorts,
): Promise<CodeReviewRunResult> {
  return Effect.runPromise(Effect.scoped(runCodeReviewEffect(request, ports)), {
    ...(ports.signal === undefined ? {} : { signal: ports.signal }),
  });
}
