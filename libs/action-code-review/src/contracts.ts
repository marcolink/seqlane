import { z } from "zod";

export const gitRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
export const reviewTargetInputSchema = z.strictObject({
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  reviewTarget: z.string().min(1),
  baseBranch: z.string().min(1),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema,
  runtime: z.string().url(),
});
export type ReviewTargetInput = z.infer<typeof reviewTargetInputSchema>;

export const pullRequestContextSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().max(256),
  description: z.string().max(65_536),
});
export type PullRequestContext = z.infer<typeof pullRequestContextSchema>;

export const reviewCommentSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(["issue", "review"]),
  author: z.string().min(1).max(256),
  authorAssociation: z.string().min(1).max(64),
  body: z.string().max(65_536),
  bodyTruncated: z.boolean().optional(),
  omittedDispositionCommands: z.array(z.strictObject({
    findingId: z.string().regex(/^(?:F-[A-Za-z0-9][A-Za-z0-9_-]{0,63}|SEQ-PR[1-9]\d*-[0-9]{3,})$/i),
    action: z.enum(["fixed", "wont-fix", "downgrade"]),
    authorized: z.boolean(),
    effectiveSeverity: z.enum(["critical", "required", "optional", "nit"]).optional(),
  })).max(200).optional(),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().max(64).optional(),
  path: z.string().min(1).max(512).optional(),
  line: z.number().int().positive().optional(),
  commitId: gitRevisionSchema.optional(),
  inReplyTo: z.string().min(1).max(128).optional(),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewHistorySchema = z.strictObject({
  comments: z.array(reviewCommentSchema).max(200),
  truncated: z.boolean(),
});
export type ReviewHistory = z.infer<typeof reviewHistorySchema>;

export const reviewPublicationSchema = z.strictObject({
  verdict: z.enum(["approve", "request-changes"]),
  reviewedRevision: gitRevisionSchema,
  body: z.string().max(60_000),
});
export type ReviewPublication = z.infer<typeof reviewPublicationSchema>;
