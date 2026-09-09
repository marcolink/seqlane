import { gzipSync } from "node:zlib";
import type { JsonValue, SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";
import { reviewPublicationSchema, type ReviewPublication } from "./contracts.js";
import { deriveRunMetrics, reviewRunMetricsSchema, type ReviewRunMetrics } from "./metrics.js";

const reviewFindingSchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(["critical", "required", "optional", "nit"]),
  effectiveSeverity: z.enum(["critical", "required", "optional", "nit"]).default("nit"),
  disposition: z.enum(["open", "fixed", "wont-fix", "downgraded", "not-reproducible"]).default("open"),
  status: z.enum(["new", "open", "addressed", "resolved", "reopened", "dismissed"]).default("open"),
  axis: z.string().min(1).max(64).default("architecture"),
  summary: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  file: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  aliases: z.array(z.string().min(1).max(128)).max(8).default([]),
  dispositionReason: z.string().max(2_000).optional(),
  dispositionBy: z.string().min(1).max(256).optional(),
  dispositionAt: z.string().min(1).max(64).optional(),
  dispositionCommentId: z.string().min(1).max(128).optional(),
  dispositionCommit: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  evidenceHeadRevision: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
});

const ratingSchema = z.strictObject({
  axis: z.enum(["correctness", "readability", "architecture", "security", "performance"]),
  rating: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(2_000),
});

const reportSchema = z.strictObject({
  repository: z.string().min(1).default(""),
  baseBranch: z.string().min(1).default(""),
  baseRevision: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  overallRating: z.number().int().min(1).max(5).optional(),
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1).max(6_000),
  ratings: z.array(ratingSchema).max(5).default([]),
  findings: z.array(reviewFindingSchema).max(40),
  verification: z.array(z.string().max(1_000)).max(20).default([]),
  headRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  pullRequestNumber: z.number().int().positive().optional(),
  previousReviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i).optional(),
  nextFindingIndex: z.number().int().positive().default(1),
  limitations: z.array(z.string().max(1_000)).max(20).default([]),
  stateTruncated: z.boolean().default(false),
  runMetricsLedger: z.object({
    schemaVersion: z.literal(1),
    runs: z.array(z.strictObject({
      githubRunId: z.string().regex(/^\d+$/).max(128),
      attempt: z.number().int().positive(),
      completedAt: z.string().min(1).max(64),
      reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
      metrics: reviewRunMetricsSchema,
    })).max(40),
  }).strict().optional(),
});

const ledgerEntrySchema = z.strictObject({
  githubRunId: z.string().regex(/^\d+$/).max(128),
  attempt: z.number().int().positive(),
  completedAt: z.string().min(1).max(64),
  reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  metrics: z.object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    durationMs: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      reasoning: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    tasks: z.array(z.strictObject({
      invocationId: z.string().min(1).max(256),
      task: z.string().min(1).max(512),
      taskId: z.string().min(1).max(256).optional(),
      resultState: z.enum(["queued", "waiting", "active", "retrying", "succeeded", "failed", "skipped", "cancelled"]),
      durationMs: z.number().nonnegative(),
      model: z.string().min(1).max(256).optional(),
      provider: z.string().min(1).max(256).optional(),
      tokens: z.strictObject({
        input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
        reasoning: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(), total: z.number().int().nonnegative().optional(),
      }).optional(),
      cost: z.number().nonnegative().optional(),
    })).max(40),
  }).strict(),
}).strict();

const ledgerSchema = z.object({ schemaVersion: z.literal(1), runs: z.array(ledgerEntrySchema) }).strict();
const EMPTY_LEDGER = { schemaVersion: 1 as const, runs: [] as z.infer<typeof ledgerEntrySchema>[] };

export interface PublicationSnapshot {
  readonly report: z.infer<typeof reportSchema>;
  readonly events: readonly SeqlaneEvent[];
  readonly runId: string;
  readonly githubRunId?: string;
  readonly attempt?: number;
  readonly completedAt?: string;
}
export interface DerivedPublication {
  readonly metrics: ReviewRunMetrics;
  readonly publication: ReviewPublication;
}

const boundedIdSchema = z.string().min(1).max(256);
const boundedJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(8_000), z.number(), z.boolean(), z.null(),
  z.array(boundedJsonValueSchema).max(200),
  z.record(z.string().max(128), boundedJsonValueSchema).superRefine((value, context) => {
    if (Object.keys(value).length > 200) context.addIssue({ code: "too_big", maximum: 200, origin: "object", inclusive: true });
  }),
]));
const eventSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("task"), taskId: boundedIdSchema }),
  z.strictObject({ type: z.literal("validator"), validatorId: boundedIdSchema }),
  z.strictObject({ type: z.literal("validation-gate"), planNodeId: boundedIdSchema }),
]);
const eventSummarySchema = z.strictObject({
  kind: z.enum(["null", "boolean", "number", "string", "array", "object"]),
  size: z.number().nonnegative().optional(),
  fields: z.array(z.string().max(128)).max(200).optional(),
});
const eventDisplayValueSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("present"), value: boundedJsonValueSchema }),
  z.strictObject({ state: z.literal("redacted"), summary: eventSummarySchema.optional() }),
  z.strictObject({ state: z.literal("truncated"), summary: eventSummarySchema }),
  z.strictObject({ state: z.literal("omitted"), reason: z.enum(["policy", "unavailable"]) }),
]);
const eventMetricsSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  model: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(256).optional(),
  modelSelection: z.strictObject({
    model: z.strictObject({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) }),
    reasoning: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  }).optional(),
  cost: z.number().nonnegative().optional(),
  tokens: z.strictObject({
    total: z.number().int().nonnegative().optional(), input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(), reasoning: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(), cacheWrite: z.number().int().nonnegative(),
  }).optional(),
});
const eventErrorSchema = z.strictObject({
  category: z.enum(["InputValidationError", "ExecutorError", "OutputValidationError", "ValidationError", "RuntimeError"]),
  message: z.string().max(4_000),
  name: z.string().max(128).optional(),
  taskId: boundedIdSchema.optional(),
  nodeId: boundedIdSchema.optional(),
  sourceId: boundedIdSchema.optional(),
  maximumIterations: z.number().int().positive().optional(),
  issues: z.array(z.strictObject({
    code: z.string().max(256),
    message: z.string().max(4_000),
    path: z.string().max(2_000).optional(),
  })).max(200).optional(),
  evidence: boundedJsonValueSchema.optional(),
});
const eventBase = { workId: boundedIdSchema, runId: boundedIdSchema };
const publicationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("run.started") }),
  z.strictObject({ ...eventBase, type: z.literal("run.succeeded"), output: boundedJsonValueSchema }),
  z.strictObject({ ...eventBase, type: z.literal("run.failed"), error: eventErrorSchema }),
  z.strictObject({ ...eventBase, type: z.literal("run.cancelled") }),
  z.strictObject({ ...eventBase, type: z.literal("run.heartbeat"), activeInvocationIds: z.array(boundedIdSchema).max(200), elapsedMs: z.number().nonnegative() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.created"), invocationId: boundedIdSchema, planNodeId: boundedIdSchema, subject: eventSubjectSchema, taskId: boundedIdSchema.optional(), kind: z.enum(["workflow", "loop", "task", "validation"]), label: z.string().min(1).max(512), parentInvocationId: boundedIdSchema.optional(), iteration: z.number().int().nonnegative().optional(), siblingOrder: z.number().int().nonnegative(), dependencyIds: z.array(boundedIdSchema).max(200) }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.progress"), invocationId: boundedIdSchema, state: z.enum(["active", "waiting"]), phase: z.string().min(1).max(256), message: z.string().max(4_000).optional(), label: z.string().max(512).optional(), waitingReason: z.string().max(256).optional(), workspace: z.enum(["shared", "exclusive"]).optional(), blockingInvocationId: boundedIdSchema.optional(), dependencyIds: z.array(boundedIdSchema).max(200).optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.output"), invocationId: boundedIdSchema, policy: z.enum(["transient", "persistent"]), channel: z.enum(["task", "run"]), content: z.string().max(8_000), metrics: eventMetricsSchema.optional(), summary: eventSummarySchema.optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.input"), invocationId: boundedIdSchema, input: eventDisplayValueSchema, iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.result"), invocationId: boundedIdSchema, result: eventDisplayValueSchema, iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.activity"), invocationId: boundedIdSchema, activityId: boundedIdSchema, kind: z.enum(["tool", "skill"]), name: z.string().min(1).max(512), state: z.enum(["started", "progress", "succeeded", "failed"]), input: eventDisplayValueSchema.optional(), output: eventDisplayValueSchema.optional(), activityMetadata: eventDisplayValueSchema.optional(), startedAt: z.number().nonnegative().optional(), endedAt: z.number().nonnegative().optional(), message: z.string().max(4_000).optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.started"), invocationId: boundedIdSchema, subject: eventSubjectSchema, taskId: boundedIdSchema.optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.succeeded"), invocationId: boundedIdSchema, iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.failed"), invocationId: boundedIdSchema, error: eventErrorSchema, disposition: z.enum(["retry_scheduled", "fail_run", "continue_siblings", "skip_dependents", "cancelled_by_policy"]), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.skipped"), invocationId: boundedIdSchema, reason: z.string().max(4_000), dependencyIds: z.array(boundedIdSchema).max(200).optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.cancelled"), invocationId: boundedIdSchema, reason: z.string().max(4_000).optional(), iteration: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...eventBase, type: z.literal("invocation.retrying"), invocationId: boundedIdSchema, attempt: z.number().int().positive(), maximumAttempts: z.number().int().positive().optional(), delayMs: z.number().nonnegative().optional(), nextAttemptAt: z.string().max(64).optional(), lastError: eventErrorSchema, iteration: z.number().int().nonnegative().optional() }),
]) as z.ZodType<SeqlaneEvent>;

/** The frozen data accepted by the model-free publication workflow. */
export const publicationSnapshotSchema = z.strictObject({
  report: reportSchema,
  events: z.array(publicationEventSchema).max(10_000),
  runId: z.string().min(1).max(128),
  githubRunId: z.string().regex(/^\d+$/).max(128).optional(),
  attempt: z.number().int().positive().optional(),
  completedAt: z.string().min(1).max(64).optional(),
});
export type PublicationSnapshotInput = z.infer<typeof publicationSnapshotSchema>;

function safeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;").replaceAll(String.fromCharCode(96), "&#96;").replaceAll("@", "@&#8203;")
    .replace(/[\r\n]+/g, " ");
}
function severityRank(value: string): number {
  return value === "critical" ? 0 : value === "required" ? 1 : value === "optional" ? 2 : 3;
}
function active(status: string): boolean {
  return status === "new" || status === "open" || status === "addressed" || status === "reopened";
}
function parseLedger(value: unknown): z.infer<typeof ledgerSchema> {
  const parsed = ledgerSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_LEDGER;
}
function encodeState(report: z.infer<typeof reportSchema>): string {
  return gzipSync(JSON.stringify({
    schemaVersion: 3,
    pullRequestNumber: report.pullRequestNumber ?? 1,
    baseRevision: report.baseRevision ?? report.headRevision,
    reviewedRevision: report.headRevision,
    ...(report.previousReviewedRevision === undefined ? {} : { previousReviewedRevision: report.previousReviewedRevision }),
    nextFindingIndex: report.nextFindingIndex,
    findings: report.findings,
    limitations: report.limitations,
    truncated: report.stateTruncated,
  })).toString("base64");
}

const MAX_STATE_PAYLOAD_CHARS = 20_000;
const MAX_PUBLICATION_BODY_CHARS = 60_000;
const STATE_COMPACTION_NOTICE = "The machine-readable review state was compacted to fit the publication limit.";
const PUBLICATION_TRUNCATION_NOTICE = "⚠️ Publication text was truncated to fit the GitHub comment limit.";

function shorten(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function stateReport(report: z.infer<typeof reportSchema>): z.infer<typeof reportSchema> {
  let candidate = report;
  let payload = encodeState(candidate);
  if (payload.length <= MAX_STATE_PAYLOAD_CHARS) return candidate;

  candidate = {
    ...candidate,
    findings: candidate.findings.map((finding) => ({
      ...finding,
      summary: shorten(finding.summary, 320),
      recommendation: shorten(finding.recommendation, 320),
      ...(finding.file === undefined ? {} : { file: shorten(finding.file, 256) }),
    })),
    limitations: [...candidate.limitations.filter((value) => value !== STATE_COMPACTION_NOTICE).slice(0, 19), STATE_COMPACTION_NOTICE],
    stateTruncated: true,
  };
  payload = encodeState(candidate);
  if (payload.length <= MAX_STATE_PAYLOAD_CHARS) return candidate;

  candidate = {
    ...candidate,
    findings: candidate.findings.map((finding) => ({
      ...finding,
      summary: "Historical finding retained in compact state.",
      recommendation: "Re-evaluate this finding against the current head.",
      file: undefined,
      line: undefined,
      dispositionReason: undefined,
    })),
    limitations: [...candidate.limitations.filter((value) => value !== STATE_COMPACTION_NOTICE).slice(0, 19), STATE_COMPACTION_NOTICE],
    stateTruncated: true,
  };
  payload = encodeState(candidate);
  if (payload.length > MAX_STATE_PAYLOAD_CHARS) {
    throw new Error("The bounded Seqlane review state is too large to publish safely.");
  }
  return candidate;
}

/** Derives metrics from the immutable review event stream. */
export function derivePublicationMetrics(snapshot: PublicationSnapshot): ReviewRunMetrics {
  return deriveRunMetrics(snapshot.events, snapshot.runId);
}

/** Deterministically renders one bounded v3 report from frozen review data. */
export function renderPublication(
  snapshot: PublicationSnapshot,
  metrics: ReviewRunMetrics,
): ReviewPublication {
  const report = stateReport(reportSchema.parse(snapshot.report));
  const priorLedger = parseLedger(report.runMetricsLedger);
  const githubRunId = /^\d+$/.test(snapshot.githubRunId ?? "") ? snapshot.githubRunId! : "0";
  const attempt = snapshot.attempt ?? 1;
  const current = { githubRunId, attempt, completedAt: snapshot.completedAt ?? new Date().toISOString(), reviewedRevision: report.headRevision, metrics };
  const runs = priorLedger.runs.some((run) => run.githubRunId === githubRunId && run.attempt === attempt)
    ? priorLedger.runs : [...priorLedger.runs, current];
  const ledger = { schemaVersion: 1 as const, runs };
  const mark = String.fromCharCode(96);
  const fence = mark.repeat(3);
  const metadata = JSON.stringify({
    schemaVersion: 3, pullRequestNumber: report.pullRequestNumber ?? 1,
    reviewedRevision: report.headRevision,
    ...(report.previousReviewedRevision === undefined ? {} : { previousReviewedRevision: report.previousReviewedRevision }),
    run: { id: githubRunId, attempt },
  });
  const stateEnvelope = JSON.stringify({ schemaVersion: 3, encoding: "gzip+base64", data: encodeState(report) });
  const findings = [...report.findings].sort((left, right) =>
    (active(left.status) ? 0 : 1) - (active(right.status) ? 0 : 1) ||
    severityRank(left.effectiveSeverity ?? left.severity) - severityRank(right.effectiveSeverity ?? right.severity) ||
    left.id.localeCompare(right.id));
  const blockers = findings.filter((finding) => active(finding.status) && ["critical", "required"].includes(finding.effectiveSeverity ?? finding.severity)).length;
  const advisories = findings.filter((finding) => active(finding.status) && (finding.effectiveSeverity ?? finding.severity) === "optional").length;
  const totalCost = runs.reduce((sum, run) => sum + run.metrics.totalCost, 0);
  const visible = findings.slice(0, 20);
  const rows = visible.length === 0 ? ["✅ No findings."] : [
    "| ID | Severity | Status | Area | Finding |", "| --- | --- | --- | --- | --- |",
    ...visible.map((finding) => "| " + mark + safeText(finding.id) + mark + " | " + safeText(finding.effectiveSeverity ?? finding.severity) + " | " + safeText(finding.status) + " | " + safeText(finding.axis) + " | " + safeText(finding.summary) + " — " + safeText(finding.recommendation) + " |"),
  ];
  const body = [
    "<!-- seqlane-code-review -->", "<!-- seqlane-code-review-meta-v3: " + metadata + " -->",
    "# Seqlane review", "",
    "**" + (report.verdict === "approve" ? "✅ Approved" : "🛑 Changes requested") + "**" +
      (blockers === 0 ? "" : " · **" + blockers + " blocker" + (blockers === 1 ? "" : "s") + "**") +
      (advisories === 0 ? "" : " · **" + advisories + " advisories**"),
    "Static review of " + mark + report.headRevision.slice(0, 8) + mark, "", safeText(report.summary), "",
    "## Findings", ...rows,
    ...(findings.length > visible.length ? ["", "⚠️ Showing " + visible.length + " of " + findings.length + " retained findings. The machine-readable state contains the complete bounded set."] : []),
    ...(report.limitations.length === 0 ? [] : ["", "## Review limitations", ...report.limitations.map((value) => "- ⚠️ " + safeText(value))]),
    "", "<details>",
    "<summary>Run metrics (" + runs.length + " " + (runs.length === 1 ? "run" : "runs") + ") · PR cost: $" + totalCost.toFixed(6) + " · last run: $" + (runs.at(-1)?.metrics.totalCost ?? 0).toFixed(6) + "</summary>", "",
    "Mechanically aggregated from Seqlane execution events:", "",
    "<!-- seqlane-code-review-run-metrics-v1-start -->", fence + "json", JSON.stringify(ledger, null, 2), fence,
    "<!-- seqlane-code-review-run-metrics-v1-end -->", "", "</details>", "",
    ...(report.verification.length === 0 ? [] : ["<details>", "<summary>Verification evidence (showing up to 10 entries)</summary>", "", ...report.verification.slice(0, 10).map((entry) => "- 🔎 " + safeText(entry)), "", "</details>", ""]),
    "<details>", "<summary>Machine-readable review state</summary>", "",
    "<!-- seqlane-code-review-state-v3-start -->", fence + "json", stateEnvelope, fence,
    "<!-- seqlane-code-review-state-v3-end -->", "", "</details>", "",
    "_Static review only. Review agents did not execute pull-request code, tests, builds, scripts, or checks._",
  ].join("\n");
  const boundedBody = body.length <= MAX_PUBLICATION_BODY_CHARS
    ? body
    : body.slice(0, MAX_PUBLICATION_BODY_CHARS - PUBLICATION_TRUNCATION_NOTICE.length - 2) +
      "\n\n" + PUBLICATION_TRUNCATION_NOTICE;
  return reviewPublicationSchema.parse({ verdict: report.verdict, reviewedRevision: report.headRevision, body: boundedBody });
}

/** Convenience API for callers that do not need the workflow stages. */
export function derivePublication(snapshot: PublicationSnapshot): DerivedPublication {
  const metrics = derivePublicationMetrics(snapshot);
  return { metrics, publication: renderPublication(snapshot, metrics) };
}
