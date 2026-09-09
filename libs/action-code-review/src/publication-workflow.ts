import { buildWorkflow, createFlow, defineTask } from "@seqlane/core";
import type { SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";
import {
  derivePublicationMetrics,
  publicationSnapshotSchema,
  renderPublication,
  type PublicationSnapshotInput,
} from "./publication.js";
import {
  reviewRunMetricsSchema,
  type ReviewRunMetrics,
} from "./metrics.js";
import { gitRevisionSchema, reviewPublicationSchema, type ReviewPublication } from "./contracts.js";

export interface PublicationLiveStateRequest {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly expectedHeadRevision: string;
}

export interface PublicationPort {
  checkLiveState(
    request: PublicationLiveStateRequest,
  ): Promise<"live" | "stale">;
  publishReport(request: {
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly expectedHeadRevision: string;
    readonly workflowRunId: string;
    readonly githubRunId: string;
    readonly attempt: number;
    readonly existingReportId?: string;
    readonly publication: ReviewPublication;
  }): Promise<"published" | "stale">;
}

const publicationInputSchema = z.object({
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  expectedHeadRevision: gitRevisionSchema,
  githubRunId: z.string().regex(/^\d+$/).max(128),
  attempt: z.number().int().positive(),
  snapshot: publicationSnapshotSchema,
  existingReportId: z.string().max(128),
});

const metricsTask = defineTask({
  id: "pr-code-review.publication.metrics",
  workspace: "shared",
  input: publicationSnapshotSchema,
  output: reviewRunMetricsSchema,
  execute: async (snapshot: PublicationSnapshotInput) =>
    derivePublicationMetrics(snapshot),
});

const renderTask = defineTask({
  id: "pr-code-review.publication.report",
  workspace: "shared",
  input: z.object({
    snapshot: publicationSnapshotSchema,
    metrics: metricsTask.output,
  }),
  output: reviewPublicationSchema,
  execute: async ({ snapshot, metrics }: {
    readonly snapshot: PublicationSnapshotInput;
    readonly metrics: ReviewRunMetrics;
  }) => renderPublication(snapshot, metrics),
});

const decisionSchema = z.object({
  status: z.enum(["publish", "stale"]),
  publication: reviewPublicationSchema,
});
export const publicationResultSchema = z.object({
  status: z.enum(["published", "stale"]),
  publication: reviewPublicationSchema,
});

const decisionTask = defineTask({
  id: "pr-code-review.publication.decision",
  workspace: "shared",
  input: z.object({
    liveState: z.enum(["live", "stale"]),
    publication: reviewPublicationSchema,
  }),
  output: decisionSchema,
  execute: async ({ liveState, publication }) => ({
    status: liveState === "live" ? "publish" as const : "stale" as const,
    publication,
  }),
});

/**
 * The narrow port is captured by local task definitions. It is never
 * serialized into the Plan or task input, and the publication workflow has no
 * GitHub SDK or platform types in its contract.
 */
export const publicationWorkflow = (port: PublicationPort) => createFlow({
  id: "pull-request-code-review-publication",
  input: publicationInputSchema,
  output: publicationResultSchema,
})
  .task("metrics", metricsTask, ({ input }) => input.snapshot)
  .task("report", renderTask, ({ input, tasks }) => ({
    snapshot: input.snapshot,
    metrics: tasks.metrics.output,
  }))
  .task("liveState", defineTask({
    id: "pr-code-review.publication.live-state",
    workspace: "shared",
    input: z.object({
      repository: z.string().min(1),
      pullRequestNumber: z.number().int().positive(),
      expectedHeadRevision: gitRevisionSchema,
    }),
    output: z.enum(["live", "stale"]),
    execute: (input) => port.checkLiveState(input),
  }), ({ input }) => ({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadRevision: input.expectedHeadRevision,
  }))
  .task("decision", decisionTask, ({ tasks }) => ({
    liveState: tasks.liveState.output,
    publication: tasks.report.output,
  }))
  .task("publish", defineTask({
    id: "pr-code-review.publication.publish",
    workspace: "shared",
    input: z.object({
      repository: z.string().min(1),
      pullRequestNumber: z.number().int().positive(),
      expectedHeadRevision: gitRevisionSchema,
      workflowRunId: z.string().min(1).max(128),
      githubRunId: z.string().regex(/^\d+$/).max(128),
      attempt: z.number().int().positive(),
      existingReportId: z.string().max(128),
      decision: decisionSchema,
    }),
  output: publicationResultSchema,
  execute: async (input) => {
      if (input.decision.status === "stale") {
        return { status: "stale" as const, publication: input.decision.publication };
      }
      const status = await port.publishReport({
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        expectedHeadRevision: input.expectedHeadRevision,
        workflowRunId: input.workflowRunId,
        githubRunId: input.githubRunId,
        attempt: input.attempt,
        ...(input.existingReportId.length === 0
          ? {}
          : { existingReportId: input.existingReportId }),
        publication: input.decision.publication,
      });
      return { status, publication: input.decision.publication };
    },
  }), ({ input, tasks }) => ({
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadRevision: input.expectedHeadRevision,
    workflowRunId: input.snapshot.runId,
    githubRunId: input.githubRunId,
    attempt: input.attempt,
    existingReportId: input.existingReportId,
    decision: tasks.decision.output,
  }))
  .output(({ tasks }) => tasks.publish.output)
  .define();

export type PublicationWorkflow = ReturnType<typeof publicationWorkflow>;

/** Builds the trusted static plan used by the Action's second direct run. */
export function buildPublicationWorkflow(port: PublicationPort) {
  return buildWorkflow(publicationWorkflow(port));
}

// Keep the imported event type in the module's public type surface. This
// documents that the snapshot is the canonical Seqlane event stream.
export type PublicationEvent = SeqlaneEvent;
