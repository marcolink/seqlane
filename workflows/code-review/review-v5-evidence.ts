import { z } from "zod";
import {
  reviewCanonicalPathSchema,
  reviewCommitIdSchema,
  reviewDigestSchema,
  reviewPositiveIntegerSchema,
  reviewSanitizedTextSchema,
  reviewUtf8StringSchema,
  reviewV5FindingIdSchema,
} from "./review-v5-primitives.js";

export const reviewEvidenceExcerptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clear"),
    value: reviewUtf8StringSchema(500),
    excerptDigest: reviewDigestSchema,
  }),
  z.strictObject({
    kind: z.literal("withheld"),
    excerptDigest: reviewDigestSchema,
    redactionPolicyId: z.literal("review.secret-redaction/v1"),
    ruleIds: z.array(reviewUtf8StringSchema(64)).min(1).max(8),
  }),
]);
const supportingEvidenceSchema = z.strictObject({
  role: z.enum(["cause", "source", "sink", "guard"]),
  path: reviewCanonicalPathSchema,
  sourceRevision: reviewCommitIdSchema,
  sourceDigest: reviewDigestSchema,
  excerpt: reviewEvidenceExcerptSchema,
});
const findingEvidenceCommon = {
  itemId: reviewUtf8StringSchema(128),
  evidenceForm: z.enum(["pr-patch", "change-evidence"]),
  itemEvidenceDigest: reviewDigestSchema,
  path: reviewCanonicalPathSchema,
  supportingEvidence: z.array(supportingEvidenceSchema).max(4),
};
export const reviewFindingEvidenceSchema = z.discriminatedUnion("anchorKind", [
  z
    .strictObject({
      ...findingEvidenceCommon,
      anchorKind: z.literal("changed-text"),
      side: z.enum(["old", "new"]),
      sourceRevision: reviewCommitIdSchema,
      sourceDigest: reviewDigestSchema,
      excerpt: reviewEvidenceExcerptSchema,
      changedStartLine: reviewPositiveIntegerSchema,
      changedEndLine: reviewPositiveIntegerSchema,
    })
    .superRefine((value, ctx) => {
      if (value.changedEndLine < value.changedStartLine)
        ctx.addIssue({
          code: "custom",
          message: "Changed line range is reversed",
        });
    }),
  z
    .strictObject({
      ...findingEvidenceCommon,
      anchorKind: z.literal("changed-tree-entry"),
      beforeEntryDigest: reviewDigestSchema.optional(),
      afterEntryDigest: reviewDigestSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.beforeEntryDigest === undefined &&
        value.afterEntryDigest === undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "Changed tree entry requires at least one side",
        });
      if (value.beforeEntryDigest === value.afterEntryDigest)
        ctx.addIssue({ code: "custom", message: "Tree entry did not change" });
    }),
]);
export const reviewLocationStatusSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("located"),
      side: z.enum(["old", "new"]),
      startLine: reviewPositiveIntegerSchema,
      endLine: reviewPositiveIntegerSchema,
    })
    .superRefine((value, ctx) => {
      if (value.endLine < value.startLine)
        ctx.addIssue({
          code: "custom",
          message: "Location line range is reversed",
        });
    }),
  z.strictObject({
    kind: z.literal("unlocated"),
    reason: reviewSanitizedTextSchema,
  }),
  z.strictObject({
    kind: z.literal("ambiguous"),
    reason: reviewSanitizedTextSchema,
    candidateCount: reviewPositiveIntegerSchema,
  }),
]);
const verificationSourceCommon = {
  sourceId: reviewDigestSchema,
  findingId: reviewV5FindingIdSchema,
  path: reviewCanonicalPathSchema,
  sourceRevision: reviewCommitIdSchema,
  treeObjectId: reviewCommitIdSchema,
};
export const reviewVerificationSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...verificationSourceCommon,
    kind: z.literal("present"),
    entryDigest: reviewDigestSchema,
    sourceDigest: reviewDigestSchema,
  }),
  z.strictObject({ ...verificationSourceCommon, kind: z.literal("absent") }),
]);
export const reviewVerificationEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("text"),
      source: reviewVerificationSourceSchema,
      startLine: reviewPositiveIntegerSchema,
      endLine: reviewPositiveIntegerSchema,
      excerpt: reviewEvidenceExcerptSchema,
    })
    .superRefine((value, ctx) => {
      if (value.source.kind !== "present" || value.endLine < value.startLine)
        ctx.addIssue({
          code: "custom",
          message:
            "Text verification requires a present source and valid line range",
        });
    }),
  z.strictObject({
    kind: z.literal("tree-entry"),
    source: reviewVerificationSourceSchema,
  }),
]);

export type FindingEvidence = z.infer<typeof reviewFindingEvidenceSchema>;
export type LocationStatus = z.infer<typeof reviewLocationStatusSchema>;
export type VerificationSource = z.infer<typeof reviewVerificationSourceSchema>;
export type VerificationEvidence = z.infer<
  typeof reviewVerificationEvidenceSchema
>;
