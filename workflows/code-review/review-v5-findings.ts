import { z } from "zod";
import {
  reviewFindingEvidenceSchema,
  reviewLocationStatusSchema,
  reviewVerificationEvidenceSchema,
} from "./review-v5-evidence.js";
import {
  reviewCanonicalPathSchema,
  reviewCommitIdSchema,
  reviewDigestSchema,
  reviewSanitizedTextSchema,
  reviewUtf8StringSchema,
  reviewV5FindingIdSchema,
} from "./review-v5-primitives.js";

export const reviewFindingIdentitySchema = z.strictObject({
  schemaVersion: z.literal("review.finding-identity/v1"),
  defectKind: reviewUtf8StringSchema(64),
  anchorKind: z.enum(["changed-text", "changed-tree-entry"]),
  causeDigest: reviewDigestSchema,
});

const findingLifecycleSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("new"),
    comparisonOutcome: z.enum(["new", "not_reviewed"]),
    verificationOutcome: z.enum(["none", "present", "uncertain"]),
  }),
  z.object({
    status: z.literal("open"),
    comparisonOutcome: z.enum(["persisting", "not_reviewed"]),
    verificationOutcome: z.enum(["none", "present", "uncertain"]),
  }),
  z.object({
    status: z.literal("addressed"),
    comparisonOutcome: z.enum(["persisting", "not_reviewed"]),
    verificationOutcome: z.enum(["none", "uncertain"]),
  }),
  z.object({
    status: z.literal("resolved"),
    comparisonOutcome: z.enum(["resolved", "not_reviewed"]),
    verificationOutcome: z.literal("absent"),
  }),
  z.object({
    status: z.literal("reopened"),
    comparisonOutcome: z.enum(["persisting", "not_reviewed"]),
    verificationOutcome: z.literal("present"),
  }),
]);
export const retainedFindingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: reviewV5FindingIdSchema,
    identity: reviewFindingIdentitySchema,
    identityKey: reviewDigestSchema,
    occurrenceKey: reviewDigestSchema,
    severity: z.enum(["critical", "required", "optional", "nit"]),
    status: z.enum(["new", "open", "addressed", "resolved", "reopened"]),
    comparisonOutcome: z.enum([
      "new",
      "persisting",
      "resolved",
      "not_reviewed",
    ]),
    axis: reviewUtf8StringSchema(64),
    summary: reviewSanitizedTextSchema,
    recommendation: reviewSanitizedTextSchema,
    file: reviewCanonicalPathSchema,
    firstObservedRevision: reviewCommitIdSchema,
    evidenceHeadRevision: reviewCommitIdSchema,
    evidenceRunId: reviewUtf8StringSchema(128),
    evidence: reviewFindingEvidenceSchema,
    location: reviewLocationStatusSchema,
    verification: z
      .strictObject({
        headRevision: reviewCommitIdSchema,
        outcome: z.enum(["present", "absent", "uncertain"]),
        evidence: z.array(reviewVerificationEvidenceSchema).min(1).max(4),
      })
      .nullable(),
  })
  .superRefine((finding, ctx) => {
    if (
      finding.file !== finding.evidence.path ||
      finding.identity.anchorKind !== finding.evidence.anchorKind
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Finding identity and primary evidence must agree",
      });
    }
    if (
      finding.evidence.anchorKind === "changed-tree-entry" &&
      finding.location.kind === "located"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Tree-entry evidence cannot have an invented text location",
      });
    }
    if (
      finding.evidence.anchorKind === "changed-text" &&
      finding.location.kind === "located" &&
      (finding.location.side !== finding.evidence.side ||
        finding.location.startLine < finding.evidence.changedStartLine ||
        finding.location.endLine > finding.evidence.changedEndLine)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Finding location differs from its changed cause",
      });
    }
    const verification = finding.verification;
    if (verification !== null) {
      if (
        verification.headRevision !== finding.evidenceHeadRevision ||
        verification.evidence.some(
          (evidence) =>
            evidence.source.findingId !== finding.id ||
            evidence.source.sourceRevision !== verification.headRevision ||
            (verification.outcome === "present" &&
              evidence.source.kind === "absent"),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Verification belongs to another finding or revision",
        });
      }
    }
    if (
      !findingLifecycleSchema.safeParse({
        status: finding.status,
        comparisonOutcome: finding.comparisonOutcome,
        verificationOutcome: verification?.outcome ?? "none",
      }).success
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Finding lifecycle, comparison, and verification disagree",
      });
  });
export type RetainedFinding = z.infer<typeof retainedFindingSchema>;
