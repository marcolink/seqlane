import { z } from "zod";

export const gitRevisionSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const repositoryTextSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
export const repositorySchema = z
  .string()
  .pipe(repositoryTextSchema)
  .transform((value) => {
    const separator = value.indexOf("/");
    return {
      owner: value.slice(0, separator),
      repo: value.slice(separator + 1),
    };
  });
export type Repository = z.infer<typeof repositorySchema>;

export const reviewTargetInputSchema = z.strictObject({
  repository: repositoryTextSchema,
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

/** The mutable pull-request fields used by review admission and publication. */
export const livePullRequestSchema = z.strictObject({
  state: z.string().optional(),
  draft: z.boolean().optional(),
  head: z
    .strictObject({
      repo: z.strictObject({ full_name: z.string().optional() }).optional(),
      sha: z.string().optional(),
    })
    .optional(),
});
export type LivePullRequest = z.infer<typeof livePullRequestSchema>;

export const reviewCommentSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(["issue", "review"]),
  author: z.string().min(1).max(256),
  authorAssociation: z.string().min(1).max(64),
  body: z.string().max(65_536),
  bodyTruncated: z.boolean().optional(),
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

/** Trusted identity metadata embedded in one authoritative review report. */
export const reviewPublicationMetadataSchema = z.strictObject({
  schemaVersion: z.literal(3),
  pullRequestNumber: z.number().int().positive(),
  reviewedRevision: gitRevisionSchema,
  previousReviewedRevision: gitRevisionSchema.optional(),
  run: z.strictObject({
    id: z.string().regex(/^\d+$/).max(128),
    attempt: z.number().int().positive(),
  }),
});
export type ReviewPublicationMetadata = z.infer<
  typeof reviewPublicationMetadataSchema
>;
