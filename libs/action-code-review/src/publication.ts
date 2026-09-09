import { gzipSync } from "node:zlib";
import type { JsonValue, SeqlaneEvent } from "@seqlane/core";
import { z } from "zod";
import {
  reviewPublicationSchema,
  type ReviewPublication,
} from "./contracts.js";
import {
  deriveRunMetrics,
  reviewRunMetricsSchema,
  type ReviewRunMetrics,
} from "./metrics.js";

const reviewFindingSchema = z.strictObject({
  id: z.string().min(1).max(128),
  severity: z.enum(["critical", "required", "optional", "nit"]),
  effectiveSeverity: z.enum(["critical", "required", "optional", "nit"]),
  disposition: z.enum([
    "open",
    "fixed",
    "wont-fix",
    "downgraded",
    "not-reproducible",
  ]),
  status: z.enum([
    "new",
    "open",
    "addressed",
    "resolved",
    "reopened",
    "dismissed",
  ]),
  axis: z.string().min(1).max(64),
  summary: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  file: z.string().max(512).optional(),
  line: z.number().int().positive().optional(),
  aliases: z.array(z.string().min(1).max(128)).max(8),
  dispositionReason: z.string().max(2_000).optional(),
  dispositionBy: z.string().min(1).max(256).optional(),
  dispositionAt: z.string().min(1).max(64).optional(),
  dispositionCommentId: z.string().min(1).max(128).optional(),
  dispositionCommit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
  evidenceHeadRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
});

const ratingSchema = z.strictObject({
  axis: z.enum([
    "correctness",
    "readability",
    "architecture",
    "security",
    "performance",
  ]),
  rating: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(2_000),
});

const reportSchema = z.strictObject({
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  baseRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  overallRating: z.number().int().min(1).max(5),
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1).max(6_000),
  ratings: z.array(ratingSchema).length(5),
  findings: z.array(reviewFindingSchema).max(40),
  verification: z.array(z.string().max(1_000)).max(20),
  headRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
  pullRequestNumber: z.number().int().positive(),
  previousReviewedRevision: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .optional(),
  nextFindingIndex: z.number().int().positive(),
  limitations: z.array(z.string().max(1_000)).max(20),
  stateTruncated: z.boolean(),
  runMetricsLedger: z.strictObject({
    schemaVersion: z.literal(1),
    runs: z
      .array(
        z.strictObject({
          githubRunId: z.string().regex(/^\d+$/).max(128),
          attempt: z.number().int().positive(),
          completedAt: z.string().min(1).max(64),
          reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
          metrics: reviewRunMetricsSchema,
        }),
      )
      .max(40),
  }),
});

const ledgerEntrySchema = z
  .strictObject({
    githubRunId: z.string().regex(/^\d+$/).max(128),
    attempt: z.number().int().positive(),
    completedAt: z.string().min(1).max(64),
    reviewedRevision: z.string().regex(/^[0-9a-f]{40,64}$/i),
    metrics: z
      .object({
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
        tasks: z
          .array(
            z.strictObject({
              invocationId: z.string().min(1).max(256),
              task: z.string().min(1).max(512),
              taskId: z.string().min(1).max(256).optional(),
              resultState: z.enum([
                "queued",
                "waiting",
                "active",
                "retrying",
                "succeeded",
                "failed",
                "skipped",
                "cancelled",
              ]),
              durationMs: z.number().nonnegative(),
              model: z.string().min(1).max(256).optional(),
              provider: z.string().min(1).max(256).optional(),
              tokens: z
                .strictObject({
                  input: z.number().int().nonnegative(),
                  output: z.number().int().nonnegative(),
                  reasoning: z.number().int().nonnegative(),
                  cacheRead: z.number().int().nonnegative(),
                  cacheWrite: z.number().int().nonnegative(),
                  total: z.number().int().nonnegative().optional(),
                })
                .optional(),
              cost: z.number().nonnegative().optional(),
            }),
          )
          .max(40),
      })
      .strict(),
  })
  .strict();

const ledgerSchema = z
  .object({ schemaVersion: z.literal(1), runs: z.array(ledgerEntrySchema) })
  .strict();
const EMPTY_LEDGER = {
  schemaVersion: 1 as const,
  runs: [] as z.infer<typeof ledgerEntrySchema>[],
};

export interface PublicationSnapshot {
  readonly report: z.infer<typeof reportSchema>;
  readonly events: readonly SeqlaneEvent[];
  readonly eventsTruncated?: boolean;
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
const boundedJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(8_000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(boundedJsonValueSchema).max(200),
    z
      .record(z.string().max(128), boundedJsonValueSchema)
      .superRefine((value, context) => {
        if (Object.keys(value).length > 200)
          context.addIssue({
            code: "too_big",
            maximum: 200,
            origin: "object",
            inclusive: true,
          });
      }),
  ]),
);
const eventSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("task"), taskId: boundedIdSchema }),
  z.strictObject({
    type: z.literal("validator"),
    validatorId: boundedIdSchema,
  }),
  z.strictObject({
    type: z.literal("validation-gate"),
    planNodeId: boundedIdSchema,
  }),
]);
const eventSummarySchema = z.strictObject({
  kind: z.enum(["null", "boolean", "number", "string", "array", "object"]),
  size: z.number().nonnegative().optional(),
  fields: z.array(z.string().max(128)).max(200).optional(),
});
const eventDisplayValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("present"),
    value: boundedJsonValueSchema,
  }),
  z.strictObject({
    state: z.literal("redacted"),
    summary: eventSummarySchema.optional(),
  }),
  z.strictObject({
    state: z.literal("truncated"),
    summary: eventSummarySchema,
  }),
  z.strictObject({
    state: z.literal("omitted"),
    reason: z.enum(["policy", "unavailable"]),
  }),
]);
const eventMetricsSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  model: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(256).optional(),
  modelSelection: z
    .strictObject({
      model: z.strictObject({
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
      }),
      reasoning: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional(),
    })
    .optional(),
  cost: z.number().nonnegative().optional(),
  tokens: z
    .strictObject({
      total: z.number().int().nonnegative().optional(),
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      reasoning: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
    })
    .optional(),
});
const eventErrorSchema = z.strictObject({
  category: z.enum([
    "InputValidationError",
    "ExecutorError",
    "OutputValidationError",
    "ValidationError",
    "RuntimeError",
  ]),
  message: z.string().max(4_000),
  name: z.string().max(128).optional(),
  taskId: boundedIdSchema.optional(),
  nodeId: boundedIdSchema.optional(),
  sourceId: boundedIdSchema.optional(),
  maximumIterations: z.number().int().positive().optional(),
  issues: z
    .array(
      z.strictObject({
        code: z.string().max(256),
        message: z.string().max(4_000),
        path: z.string().max(2_000).optional(),
      }),
    )
    .max(200)
    .optional(),
  evidence: boundedJsonValueSchema.optional(),
});
const eventBase = { workId: boundedIdSchema, runId: boundedIdSchema };
const publicationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("run.started") }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.succeeded"),
    output: boundedJsonValueSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.failed"),
    error: eventErrorSchema,
  }),
  z.strictObject({ ...eventBase, type: z.literal("run.cancelled") }),
  z.strictObject({
    ...eventBase,
    type: z.literal("run.heartbeat"),
    activeInvocationIds: z.array(boundedIdSchema).max(200),
    elapsedMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.created"),
    invocationId: boundedIdSchema,
    planNodeId: boundedIdSchema,
    subject: eventSubjectSchema,
    taskId: boundedIdSchema.optional(),
    kind: z.enum(["workflow", "loop", "task", "validation"]),
    label: z.string().min(1).max(512),
    parentInvocationId: boundedIdSchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
    siblingOrder: z.number().int().nonnegative(),
    dependencyIds: z.array(boundedIdSchema).max(200),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.progress"),
    invocationId: boundedIdSchema,
    state: z.enum(["active", "waiting"]),
    phase: z.string().min(1).max(256),
    message: z.string().max(4_000).optional(),
    label: z.string().max(512).optional(),
    waitingReason: z.string().max(256).optional(),
    workspace: z.enum(["shared", "exclusive"]).optional(),
    blockingInvocationId: boundedIdSchema.optional(),
    dependencyIds: z.array(boundedIdSchema).max(200).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.output"),
    invocationId: boundedIdSchema,
    policy: z.enum(["transient", "persistent"]),
    channel: z.enum(["task", "run"]),
    content: z.string().max(8_000),
    metrics: eventMetricsSchema.optional(),
    summary: eventSummarySchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.input"),
    invocationId: boundedIdSchema,
    input: eventDisplayValueSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.result"),
    invocationId: boundedIdSchema,
    result: eventDisplayValueSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.activity"),
    invocationId: boundedIdSchema,
    activityId: boundedIdSchema,
    kind: z.enum(["tool", "skill"]),
    name: z.string().min(1).max(512),
    state: z.enum(["started", "progress", "succeeded", "failed"]),
    input: eventDisplayValueSchema.optional(),
    output: eventDisplayValueSchema.optional(),
    activityMetadata: eventDisplayValueSchema.optional(),
    startedAt: z.number().nonnegative().optional(),
    endedAt: z.number().nonnegative().optional(),
    message: z.string().max(4_000).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.started"),
    invocationId: boundedIdSchema,
    subject: eventSubjectSchema,
    taskId: boundedIdSchema.optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.succeeded"),
    invocationId: boundedIdSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.failed"),
    invocationId: boundedIdSchema,
    error: eventErrorSchema,
    disposition: z.enum([
      "retry_scheduled",
      "fail_run",
      "continue_siblings",
      "skip_dependents",
      "cancelled_by_policy",
    ]),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.skipped"),
    invocationId: boundedIdSchema,
    reason: z.string().max(4_000),
    dependencyIds: z.array(boundedIdSchema).max(200).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.cancelled"),
    invocationId: boundedIdSchema,
    reason: z.string().max(4_000).optional(),
    iteration: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("invocation.retrying"),
    invocationId: boundedIdSchema,
    attempt: z.number().int().positive(),
    maximumAttempts: z.number().int().positive().optional(),
    delayMs: z.number().nonnegative().optional(),
    nextAttemptAt: z.string().max(64).optional(),
    lastError: eventErrorSchema,
    iteration: z.number().int().nonnegative().optional(),
  }),
]) as z.ZodType<SeqlaneEvent>;

/** The frozen data accepted by the model-free publication workflow. */
export const publicationSnapshotSchema = z.strictObject({
  report: reportSchema,
  events: z.array(publicationEventSchema).max(10_000),
  eventsTruncated: z.boolean().default(false),
  runId: z.string().min(1).max(128),
  githubRunId: z.string().regex(/^\d+$/).max(128).optional(),
  attempt: z.number().int().positive().optional(),
  completedAt: z.string().min(1).max(64).optional(),
});
export type PublicationSnapshotInput = z.infer<
  typeof publicationSnapshotSchema
>;

function safeText(value: string): string {
  return value
    .replace(/\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi, "[external URL omitted]")
    .replace(/\bwww\.[^\s<>"'`]+/gi, "[external URL omitted]")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll(String.fromCharCode(96), "&#96;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;")
    .replaceAll("@", "@&#8203;")
    .replace(/[\r\n]+/g, " ");
}
function severityRank(value: string): number {
  return value === "critical"
    ? 0
    : value === "required"
      ? 1
      : value === "optional"
        ? 2
        : 3;
}
function active(status: string): boolean {
  return (
    status === "new" ||
    status === "open" ||
    status === "addressed" ||
    status === "reopened"
  );
}
function parseLedger(value: unknown): z.infer<typeof ledgerSchema> {
  const parsed = ledgerSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_LEDGER;
}
function encodeState(report: z.infer<typeof reportSchema>): string {
  return gzipSync(
    JSON.stringify({
      schemaVersion: 3,
      pullRequestNumber: report.pullRequestNumber ?? 1,
      baseRevision: report.baseRevision ?? report.headRevision,
      reviewedRevision: report.headRevision,
      ...(report.previousReviewedRevision === undefined
        ? {}
        : { previousReviewedRevision: report.previousReviewedRevision }),
      nextFindingIndex: report.nextFindingIndex,
      findings: report.findings,
      limitations: report.limitations,
      truncated: report.stateTruncated,
    }),
  ).toString("base64");
}

const MAX_STATE_PAYLOAD_CHARS = 20_000;
const MAX_PUBLICATION_BODY_CHARS = 60_000;
const STATE_COMPACTION_NOTICE =
  "The machine-readable review state was compacted to fit the publication limit.";
const METRICS_LEDGER_TRUNCATION_NOTICE =
  "The run metrics ledger was bounded to the latest 40 runs.";
const EVENT_TRUNCATION_NOTICE =
  "The execution event stream was bounded; some non-terminal events were omitted.";
const MAX_PUBLICATION_BODY_BYTES = 60_000;

function shorten(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}

function shortenUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  const suffix = new TextEncoder().encode("…");
  const bounded = bytes.subarray(0, Math.max(0, maxBytes - suffix.length));
  return new TextDecoder().decode(bounded) + "…";
}

function publicationBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stateReport(
  report: z.infer<typeof reportSchema>,
): z.infer<typeof reportSchema> {
  let candidate = report;
  let payload = encodeState(candidate);
  if (payload.length <= MAX_STATE_PAYLOAD_CHARS) return candidate;

  candidate = {
    ...candidate,
    findings: candidate.findings.map((finding) => ({
      ...finding,
      summary: shorten(finding.summary, 320),
      recommendation: shorten(finding.recommendation, 320),
      ...(finding.file === undefined
        ? {}
        : { file: shorten(finding.file, 256) }),
    })),
    limitations: [
      ...candidate.limitations
        .filter((value) => value !== STATE_COMPACTION_NOTICE)
        .slice(0, 19),
      STATE_COMPACTION_NOTICE,
    ],
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
    limitations: [
      ...candidate.limitations
        .filter((value) => value !== STATE_COMPACTION_NOTICE)
        .slice(0, 19),
      STATE_COMPACTION_NOTICE,
    ],
    stateTruncated: true,
  };
  payload = encodeState(candidate);
  if (payload.length > MAX_STATE_PAYLOAD_CHARS) {
    throw new Error(
      "The bounded Seqlane review state is too large to publish safely.",
    );
  }
  return candidate;
}

type PublicationReport = z.infer<typeof reportSchema>;
type PublicationLedger = z.infer<typeof ledgerSchema>;
type RenderBodyOptions = {
  readonly visibleFindings: number;
  readonly includeVerification: boolean;
};

function preparePublication(
  snapshot: PublicationSnapshot,
  metrics: ReviewRunMetrics,
): {
  readonly report: PublicationReport;
  readonly ledger: PublicationLedger;
  readonly githubRunId: string;
  readonly attempt: number;
} {
  let report = stateReport(reportSchema.parse(snapshot.report));
  const priorLedger = parseLedger(report.runMetricsLedger);
  const githubRunId = /^\d+$/.test(snapshot.githubRunId ?? "")
    ? snapshot.githubRunId!
    : "0";
  const attempt = snapshot.attempt ?? 1;
  const current = {
    githubRunId,
    attempt,
    completedAt: snapshot.completedAt ?? new Date().toISOString(),
    reviewedRevision: report.headRevision,
    metrics,
  };
  const hasCurrentRun = priorLedger.runs.some(
    (run) => run.githubRunId === githubRunId && run.attempt === attempt,
  );
  const evictedRun = !hasCurrentRun && priorLedger.runs.length >= 40;
  const runs = hasCurrentRun
    ? priorLedger.runs
    : [...priorLedger.runs, current].slice(-40);
  const ledger: PublicationLedger = { schemaVersion: 1, runs };
  const limitations = [
    ...report.limitations,
    ...(evictedRun ? [METRICS_LEDGER_TRUNCATION_NOTICE] : []),
    ...(snapshot.eventsTruncated ? [EVENT_TRUNCATION_NOTICE] : []),
  ].filter((value, index, values) => values.indexOf(value) === index);
  report = stateReport({
    ...report,
    limitations: limitations.slice(-20),
    stateTruncated:
      report.stateTruncated || evictedRun || snapshot.eventsTruncated === true,
    runMetricsLedger: ledger,
  });
  return { report, ledger, githubRunId, attempt };
}

function sortFindings(
  findings: PublicationReport["findings"],
): PublicationReport["findings"] {
  return [...findings].sort(
    (left, right) =>
      (active(left.status) ? 0 : 1) - (active(right.status) ? 0 : 1) ||
      severityRank(left.effectiveSeverity) -
        severityRank(right.effectiveSeverity) ||
      left.id.localeCompare(right.id),
  );
}

function renderFindingRows(
  findings: PublicationReport["findings"],
  visibleFindings: number,
  mark: string,
): string[] {
  const visible = findings.slice(0, visibleFindings);
  if (visible.length === 0) return ["✅ No findings."];
  return [
    "| ID | Severity | Status | Area | Finding |",
    "| --- | --- | --- | --- | --- |",
    ...visible.map(
      (finding) =>
        "| " +
        mark +
        safeText(finding.id) +
        mark +
        " | " +
        safeText(finding.effectiveSeverity) +
        " | " +
        safeText(finding.status) +
        " | " +
        safeText(finding.axis) +
        " | " +
        safeText(shortenUtf8(finding.summary, 1_200)) +
        " — " +
        safeText(shortenUtf8(finding.recommendation, 1_200)) +
        " |",
    ),
  ];
}

function renderMetricsSection(
  ledger: PublicationLedger,
  fence: string,
): string[] {
  const totalCost = ledger.runs.reduce(
    (sum, run) => sum + run.metrics.totalCost,
    0,
  );
  return [
    "<details>",
    `<summary>Run metrics (${ledger.runs.length} ${ledger.runs.length === 1 ? "run" : "runs"}) · PR cost: $${totalCost.toFixed(6)} · last run: $${(ledger.runs.at(-1)?.metrics.totalCost ?? 0).toFixed(6)}</summary>`,
    "",
    "Mechanically aggregated from Seqlane execution events:",
    "",
    "<!-- seqlane-code-review-run-metrics-v1-start -->",
    fence + "json",
    JSON.stringify(ledger, null, 2),
    fence,
    "<!-- seqlane-code-review-run-metrics-v1-end -->",
    "",
    "</details>",
  ];
}

function renderVerificationSection(
  report: PublicationReport,
  options: RenderBodyOptions,
): string[] {
  if (!options.includeVerification || report.verification.length === 0)
    return [];
  return [
    "<details>",
    "<summary>Verification evidence (showing up to 10 entries)</summary>",
    "",
    ...report.verification
      .slice(0, 10)
      .map((entry) => "- 🔎 " + safeText(shortenUtf8(entry, 800))),
    "",
    "</details>",
    "",
  ];
}

function renderStateSection(stateEnvelope: string, fence: string): string[] {
  return [
    "<details>",
    "<summary>Machine-readable review state</summary>",
    "",
    "<!-- seqlane-code-review-state-v3-start -->",
    fence + "json",
    stateEnvelope,
    fence,
    "<!-- seqlane-code-review-state-v3-end -->",
    "",
    "</details>",
    "",
  ];
}

function renderPublicationHeader(
  report: PublicationReport,
  metadata: string,
  mark: string,
  blockers: number,
  advisories: number,
): string[] {
  return [
    "<!-- seqlane-code-review -->",
    "<!-- seqlane-code-review-meta-v3: " + metadata + " -->",
    "# Seqlane review",
    "",
    "**" +
      (report.verdict === "approve" ? "✅ Approved" : "🛑 Changes requested") +
      "**" +
      (blockers === 0
        ? ""
        : " · **" +
          blockers +
          " blocker" +
          (blockers === 1 ? "" : "s") +
          "**") +
      (advisories === 0 ? "" : " · **" + advisories + " advisories**"),
    "Static review of " + mark + report.headRevision.slice(0, 8) + mark,
    "",
    safeText(shortenUtf8(report.summary, 2_000)),
    "",
  ];
}

function renderFindingsSection(
  report: PublicationReport,
  findings: PublicationReport["findings"],
  options: RenderBodyOptions,
  mark: string,
): string[] {
  return [
    "## Findings",
    ...renderFindingRows(findings, options.visibleFindings, mark),
    ...(findings.length > options.visibleFindings
      ? [
          "",
          `⚠️ Showing ${options.visibleFindings} of ${findings.length} retained findings.`,
        ]
      : []),
    ...(report.limitations.length === 0
      ? []
      : [
          "",
          "## Review limitations",
          ...report.limitations.map(
            (value) => "- ⚠️ " + safeText(shortenUtf8(value, 800)),
          ),
        ]),
    "",
  ];
}

function renderPublicationBody(
  report: PublicationReport,
  options: RenderBodyOptions,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): string {
  const mark = String.fromCharCode(96);
  const fence = mark.repeat(3);
  const metadata = JSON.stringify({
    schemaVersion: 3,
    pullRequestNumber: report.pullRequestNumber,
    reviewedRevision: report.headRevision,
    ...(report.previousReviewedRevision === undefined
      ? {}
      : { previousReviewedRevision: report.previousReviewedRevision }),
    run: { id: githubRunId, attempt },
  });
  const stateEnvelope = JSON.stringify({
    schemaVersion: 3,
    encoding: "gzip+base64",
    data: encodeState(report),
  });
  const findings = sortFindings(report.findings);
  const blockers = findings.filter(
    (finding) =>
      active(finding.status) &&
      ["critical", "required"].includes(finding.effectiveSeverity),
  ).length;
  const advisories = findings.filter(
    (finding) =>
      active(finding.status) && finding.effectiveSeverity === "optional",
  ).length;
  return [
    ...renderPublicationHeader(report, metadata, mark, blockers, advisories),
    ...renderFindingsSection(report, findings, options, mark),
    ...renderMetricsSection(ledger, fence),
    ...renderVerificationSection(report, options),
    ...renderStateSection(stateEnvelope, fence),
    "_Static review only. Review agents did not execute pull-request code, tests, builds, scripts, or checks._",
  ].join("\n");
}

function compactPublicationReport(
  report: PublicationReport,
): PublicationReport {
  return stateReport({
    ...report,
    summary: shortenUtf8(report.summary, 1_000),
    findings: report.findings.map((finding) => ({
      ...finding,
      summary: shortenUtf8(finding.summary, 320),
      recommendation: shortenUtf8(finding.recommendation, 320),
    })),
    verification: report.verification.map((entry) => shortenUtf8(entry, 320)),
  });
}

function compactLedger(ledger: PublicationLedger): PublicationLedger {
  return {
    schemaVersion: 1,
    runs: ledger.runs.map((run) => ({
      ...run,
      metrics: { ...run.metrics, tasks: [] },
    })),
  };
}

function compactLedgerPublication(
  report: PublicationReport,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): { readonly report: PublicationReport; readonly body: string } {
  const boundedLedger = compactLedger(ledger);
  const compactedReport = stateReport({
    ...report,
    limitations: [
      ...report.limitations,
      "Detailed task metrics were compacted to fit the publication limit.",
    ].slice(-20),
    stateTruncated: true,
    runMetricsLedger: boundedLedger,
  });
  return {
    report: compactedReport,
    body: renderPublicationBody(
      compactedReport,
      { visibleFindings: 0, includeVerification: false },
      boundedLedger,
      githubRunId,
      attempt,
    ),
  };
}

function fitPublicationBody(
  initialReport: PublicationReport,
  ledger: PublicationLedger,
  githubRunId: string,
  attempt: number,
): { readonly report: PublicationReport; readonly body: string } {
  let report = initialReport;
  let body = renderPublicationBody(
    report,
    { visibleFindings: 20, includeVerification: true },
    ledger,
    githubRunId,
    attempt,
  );
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    report = compactPublicationReport(report);
    body = renderPublicationBody(
      report,
      { visibleFindings: 20, includeVerification: true },
      ledger,
      githubRunId,
      attempt,
    );
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    body = renderPublicationBody(
      report,
      { visibleFindings: 0, includeVerification: false },
      ledger,
      githubRunId,
      attempt,
    );
  }
  if (publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES) {
    ({ report, body } = compactLedgerPublication(
      report,
      ledger,
      githubRunId,
      attempt,
    ));
  }
  if (
    publicationBytes(body) > MAX_PUBLICATION_BODY_BYTES ||
    body.length > MAX_PUBLICATION_BODY_CHARS
  ) {
    throw new Error(
      "The bounded Seqlane review publication is too large to publish safely.",
    );
  }
  return { report, body };
}

/** Derives metrics from the immutable review event stream. */
export function derivePublicationMetrics(
  snapshot: PublicationSnapshot,
): ReviewRunMetrics {
  return deriveRunMetrics(snapshot.events, snapshot.runId);
}

/** Deterministically renders one bounded v3 report from frozen review data. */
export function renderPublication(
  snapshot: PublicationSnapshot,
  metrics: ReviewRunMetrics,
): ReviewPublication {
  const prepared = preparePublication(snapshot, metrics);
  const { report, body } = fitPublicationBody(
    prepared.report,
    prepared.ledger,
    prepared.githubRunId,
    prepared.attempt,
  );
  return reviewPublicationSchema.parse({
    verdict: report.verdict,
    reviewedRevision: report.headRevision,
    body,
  });
}

/** Convenience API for callers that do not need the workflow stages. */
export function derivePublication(
  snapshot: PublicationSnapshot,
): DerivedPublication {
  const metrics = derivePublicationMetrics(snapshot);
  return { metrics, publication: renderPublication(snapshot, metrics) };
}
