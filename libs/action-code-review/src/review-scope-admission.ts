import { z, ZodError } from "zod";
import {
  retainedFindingSchema,
  reviewDecimalIdSchema,
  reviewPositiveIntegerSchema,
} from "@seqlane/code-review-workflow/contracts";
import { gitRevisionSchema } from "./contracts.js";
import {
  classifyReviewReport,
  reviewReportClassificationSchema,
} from "./review-report-classification.js";
import { collectReviewScopeEvidence } from "./review-scope-evidence.js";
import { ReviewScopeError } from "./review-scope-errors.js";
import {
  reviewScopeEvidenceSchema,
  reviewScopeIdentitySchema,
} from "./review-scope-contracts.js";

const frozenPullRequestSchema = z.strictObject({
  repositoryId: reviewDecimalIdSchema,
  pullRequestNumber: reviewPositiveIntegerSchema,
  targetBranch: z.string().min(1).max(512),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
});
const admissionInputSchema = z.strictObject({
  pullRequest: frozenPullRequestSchema,
  history: z.unknown(),
});
const admittedReportSchema = z.discriminatedUnion("kind", [
  reviewReportClassificationSchema.options[0],
  reviewReportClassificationSchema.options[1],
  reviewReportClassificationSchema.options[2],
]);
export const reviewScopeAdmissionSchema = z.strictObject({
  classification: admittedReportSchema,
  scopeIdentity: reviewScopeIdentitySchema,
  retainedFindings: z.array(retainedFindingSchema).max(40),
  evidence: reviewScopeEvidenceSchema,
});
export type ReviewScopeAdmission = z.infer<typeof reviewScopeAdmissionSchema>;

function scopeIdentityFor(
  pullRequest: z.infer<typeof frozenPullRequestSchema>,
  classification: z.infer<typeof reviewReportClassificationSchema>,
) {
  const common = {
    pullRequestNumber: pullRequest.pullRequestNumber,
    targetBranch: pullRequest.targetBranch,
    baseRevision: pullRequest.baseRevision,
    headRevision: pullRequest.headRevision,
  };
  if (classification.kind === "invalid-current")
    throw new ReviewScopeError(
      "REVIEW_REPORT_INVALID",
      "Review report is invalid; its checkpoint is preserved.",
      classification.cause,
    );
  if (classification.kind === "absent")
    return { ...common, mode: "new-baseline" };
  if (classification.kind === "legacy")
    return {
      ...common,
      mode: "legacy-replacement",
      reportId: classification.reportId,
      legacyMarker: classification.legacyMarker,
    };
  return {
    ...common,
    mode:
      classification.state.reviewedRevision === pullRequest.headRevision
        ? "no-change"
        : "incremental",
    reportId: classification.reportId,
    checkpointRevision: classification.state.reviewedRevision,
  };
}

export async function admitReviewScope(
  inputValue: unknown,
  host: Parameters<typeof collectReviewScopeEvidence>[1] & {
    readonly botAuthors?: readonly string[];
  },
): Promise<ReviewScopeAdmission> {
  try {
    const { pullRequest, history } = admissionInputSchema.parse(inputValue);
    host.signal?.throwIfAborted();
    const classification = await classifyReviewReport(
      history,
      {
        repositoryId: pullRequest.repositoryId,
        pullRequestNumber: pullRequest.pullRequestNumber,
      },
      host,
    );
    host.signal?.throwIfAborted();
    const scopeIdentity = scopeIdentityFor(pullRequest, classification);
    const evidence = await collectReviewScopeEvidence(scopeIdentity, host);
    return reviewScopeAdmissionSchema.parse({
      classification,
      scopeIdentity: evidence.scopeIdentity,
      retainedFindings:
        classification.kind === "current" ? classification.state.findings : [],
      evidence,
    });
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      host.signal?.aborted
        ? "REVIEW_ADMISSION_CANCELLED"
        : cause instanceof ZodError
          ? "REVIEW_ADMISSION_INVALID"
          : "REVIEW_ADMISSION_FAILED",
      "Review scope admission failed.",
      cause,
    );
  }
}
