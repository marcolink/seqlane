import { z } from "zod";

export const reviewRunSkillUsageSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(256),
        count: z.number().int().positive(),
      })
      .strict(),
  )
  .max(128);

// Review rubric: https://github.com/addyosmani/agent-skills/blob/main/skills/code-review-and-quality/SKILL.md
export const reviewAxisSchema = z.enum([
  "correctness",
  "readability",
  "architecture",
  "security",
  "performance",
]);
export const reviewSeveritySchema = z.enum([
  "critical",
  "required",
  "optional",
  "nit",
]);
export const reviewFindingIdSchema = z
  .string()
  .regex(/^(?:F-[A-Za-z0-9][A-Za-z0-9_-]{0,63}|SEQ-PR[1-9]\d*-\d{3,})$/i);
export const reviewFindingStatusSchema = z.enum([
  "new",
  "open",
  "addressed",
  "resolved",
  "reopened",
]);
export const gitRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const pullRequestContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(256),
  description: z.string().max(65_536),
});

export const reviewCommentSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["issue", "review"]),
  author: z.string().min(1).max(256),
  authorAssociation: z.string().min(1).max(64),
  body: z.string().max(65_536),
  bodyTruncated: z.boolean().optional(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64).optional(),
  url: z.string().url().max(2_000).optional(),
  path: z.string().min(1).max(512).optional(),
  line: z.number().int().positive().optional(),
  commitId: gitRevisionSchema.optional(),
  inReplyTo: z.string().min(1).max(128).optional(),
});

export const reviewHistoryInputSchema = z.object({
  comments: z.array(reviewCommentSchema).max(200),
  truncated: z.boolean().default(false),
});

export const gitCommandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string().max(8_000),
  stderr: z.string().max(8_000),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

export const gitReviewEvidenceOutputSchema = z.object({
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
  changedFiles: z.array(z.string().min(1).max(512)).max(200),
  changedFileCount: z.number().int().nonnegative(),
  changedFilesTruncated: z.boolean(),
  diffStat: z.string().max(8_000),
  diffStatTruncated: z.boolean(),
  patch: z.string().max(512_256),
  patchByteLength: z.number().int().nonnegative(),
  patchTruncated: z.boolean(),
  diffCheck: gitCommandResultSchema,
  previousReviewedRevision: gitRevisionSchema.optional(),
  previousRevisionComparable: z.boolean(),
});

export const reviewRatingSchema = z.object({
  axis: reviewAxisSchema,
  rating: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(2_000),
});

export const reviewFindingSchema = z.strictObject({
  id: reviewFindingIdSchema,
  axis: reviewAxisSchema,
  severity: reviewSeveritySchema,
  summary: z.string().min(1).max(2_000),
  recommendation: z.string().min(1).max(2_000),
  file: z.string().min(1).max(512).optional(),
  line: z.number().int().positive().optional(),
});

export const synthesizedReviewFindingSchema = reviewFindingSchema;

export const reviewReportFindingSchema = reviewFindingSchema.extend({
  status: reviewFindingStatusSchema,
  aliases: z.array(reviewFindingIdSchema).max(8).default([]),
});

export const reviewRunTokensSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    cacheWrite: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reviewRunTaskMetricsSchema = z
  .object({
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
    tokens: reviewRunTokensSchema.optional(),
    cost: z.number().nonnegative().optional(),
    /** Bounded per-task usage telemetry; this field does not authorize skills. */
    skills: reviewRunSkillUsageSchema.optional(),
  })
  .strict();

export const reviewRunMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(128),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    durationMs: z.number().nonnegative(),
    totalCost: z.number().nonnegative(),
    totalTokens: reviewRunTokensSchema,
    tasks: z.array(reviewRunTaskMetricsSchema).max(40),
  })
  .strict();

export const reviewStateSchema = z
  .object({
    schemaVersion: z.literal(4),
    pullRequestNumber: z.number().int().positive(),
    baseRevision: gitRevisionSchema,
    reviewedRevision: gitRevisionSchema,
    previousReviewedRevision: gitRevisionSchema.optional(),
    nextFindingIndex: z.number().int().positive(),
    findings: z.array(reviewReportFindingSchema.strict()).max(40),
    limitations: z.array(z.string().min(1).max(1_000)).max(20),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((state, context) => {
    const identities = new Set<string>();
    let highestIndex = 0;
    for (const [findingIndex, finding] of state.findings.entries()) {
      if (!isStableFindingId(finding.id, state.pullRequestNumber)) {
        context.addIssue({
          code: "custom",
          path: ["findings", findingIndex, "id"],
          message: "Finding ID does not belong to this pull request",
        });
      }
      const parsedIndex = Number(finding.id.split("-").at(-1));
      if (Number.isSafeInteger(parsedIndex)) {
        highestIndex = Math.max(highestIndex, parsedIndex);
      }
      for (const identity of [finding.id, ...finding.aliases]) {
        const identityKey = findingIdentityKey(identity);
        if (identities.has(identityKey)) {
          context.addIssue({
            code: "custom",
            path: ["findings", findingIndex],
            message: "Finding IDs and aliases must be unique",
          });
        }
        identities.add(identityKey);
      }
    }
    if (state.nextFindingIndex <= highestIndex) {
      context.addIssue({
        code: "custom",
        path: ["nextFindingIndex"],
        message: "Next finding index must not reuse an allocated index",
      });
    }
  });

export const reviewStateEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(4),
    encoding: z.literal("gzip+base64"),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/=]+$/)
      .max(20_000),
  })
  .strict();

export const reviewCommentMetadataSchema = z
  .object({
    schemaVersion: z.literal(4),
    pullRequestNumber: z.number().int().positive(),
    reviewedRevision: gitRevisionSchema,
    previousReviewedRevision: gitRevisionSchema.optional(),
    run: z
      .object({
        id: z.string().regex(/^\d+$/).max(128),
        attempt: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const reviewHistoryOutputSchema = z.object({
  comments: z.array(reviewCommentSchema).max(200),
  truncated: z.boolean(),
  previousReport: reviewCommentSchema.optional(),
  previousState: reviewStateSchema.optional(),
  previousReviewedRevision: gitRevisionSchema.optional(),
});

export const codeReviewInputSchema = z.object({
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
  pullRequest: pullRequestContextSchema,
  reviewHistory: reviewHistoryOutputSchema,
});

export const reviewHistoryVerificationSchema = z.object({
  findingId: reviewFindingIdSchema,
  headRevision: gitRevisionSchema,
  outcome: z.enum(["present", "addressed", "resolved", "uncertain"]),
  evidence: z.string().min(1).max(1_000),
  file: z.string().min(1).max(512).optional(),
  line: z.number().int().positive().optional(),
});

export const reviewHistoryVerificationOutputSchema = z.object({
  headRevision: gitRevisionSchema,
  verifications: z.array(reviewHistoryVerificationSchema).max(40),
  limitations: z.array(z.string().min(1).max(1_000)).max(10),
});

export const reviewEvidenceContextSchema = codeReviewInputSchema.extend({
  gitEvidence: gitReviewEvidenceOutputSchema,
  reviewHistory: reviewHistoryOutputSchema,
});

export const reviewContextSchema = reviewEvidenceContextSchema.extend({
  historyVerification: reviewHistoryVerificationOutputSchema,
});

export const reviewLaneInputSchema = z.object({
  review: reviewContextSchema,
});

export const reviewLaneResultSchema = z.object({
  ratings: z.array(reviewRatingSchema).min(1).max(2),
  findings: z.array(reviewFindingSchema).max(20),
  verification: z.array(z.string().min(1).max(1_000)).max(20),
});

export const synthesizedReviewReportSchema = z.object({
  repository: z.string(),
  baseBranch: z.string().min(1),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
  overallRating: z.number().int().min(1).max(5),
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string().min(1).max(6_000),
  ratings: z.array(reviewRatingSchema).length(5),
  findings: z.array(synthesizedReviewFindingSchema).max(40),
  verification: z.array(z.string().min(1).max(1_000)).max(20),
});

export const codeReviewReportSchema = synthesizedReviewReportSchema.extend({
  pullRequestNumber: z.number().int().positive(),
  previousReviewedRevision: gitRevisionSchema.optional(),
  nextFindingIndex: z.number().int().positive(),
  findings: z.array(reviewReportFindingSchema).max(40),
  limitations: z.array(z.string().min(1).max(1_000)).max(20),
  stateTruncated: z.boolean(),
});

export function findingIdentityKey(id: string): string {
  return id.toLowerCase();
}

export function isStableFindingId(
  id: string,
  pullRequestNumber: number,
): boolean {
  return id.startsWith(`SEQ-PR${pullRequestNumber}-`);
}

export function stableFindingId(
  pullRequestNumber: number,
  index: number,
): string {
  return `SEQ-PR${pullRequestNumber}-${String(index).padStart(3, "0")}`;
}

export const REVIEW_SEVERITY_RANK: Record<
  z.infer<typeof reviewSeveritySchema>,
  number
> = {
  nit: 1,
  optional: 2,
  required: 3,
  critical: 4,
};

export const MAX_REVIEW_FINDINGS = 40;
