import { z } from "zod";

import {
  branchNameSchema,
  gitRevisionSchema,
  repositoryIdentitySchema,
  type BranchName,
  type GitRevision,
  type PullRequestMetadataPort,
  type RepositoryIdentity,
} from "./contracts.js";

export interface WorkflowDefinitionMetadata {
  readonly ref: BranchName;
  readonly sha: GitRevision;
}

export const workflowDefinitionMetadataSchema = z.strictObject({
  ref: branchNameSchema,
  sha: gitRevisionSchema,
});
export const workflowDefinitionInputSchema = z.strictObject({
  workflowRef: branchNameSchema,
  workflowRevision: gitRevisionSchema,
});
export type WorkflowDefinitionInput = z.infer<
  typeof workflowDefinitionInputSchema
>;

const githubOwnerSchema = z.object({
  login: z.string().min(1),
});

const githubFullRepositoryNameSchema = z
  .string()
  .min(3)
  .regex(/^[^/\s]+\/[^/\s]+$/);

export const githubRepositoryResponseSchema = z.union([
  z.object({
    name: z.string().min(1),
    full_name: githubFullRepositoryNameSchema,
    owner: githubOwnerSchema.optional(),
  }),
  z.object({
    name: z.string().min(1),
    owner: githubOwnerSchema,
    full_name: githubFullRepositoryNameSchema.optional(),
  }),
]);
export type GitHubRepositoryResponse = z.infer<
  typeof githubRepositoryResponseSchema
>;

const githubBranchResponseSchema = z.object({
  ref: z.string().min(1),
  sha: gitRevisionSchema,
  repo: githubRepositoryResponseSchema,
});

export const githubPullRequestResponseSchema = z.object({
  number: z.number().int().positive().safe(),
  state: z.enum(["open", "closed"]),
  base: githubBranchResponseSchema,
  head: githubBranchResponseSchema,
});
export type GitHubPullRequestResponse = z.infer<
  typeof githubPullRequestResponseSchema
>;

export const githubBranchRefResponseSchema = z.object({
  ref: z.string().min(1),
  object: z.object({
    sha: gitRevisionSchema,
  }),
});
export type GitHubBranchRefResponse = z.infer<
  typeof githubBranchRefResponseSchema
>;

export interface GitHubPullRequestRequest {
  readonly owner: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface GitHubBranchRefRequest {
  readonly owner: string;
  readonly repository: string;
  /** The GitHub API ref, without the `refs/` prefix. */
  readonly ref: string;
}

/**
 * The Action entrypoint adapts its authenticated Octokit client to this
 * resolver-scoped, platform-neutral interface.
 */
export interface GitHubMetadataClient {
  readonly getPullRequest: (
    request: GitHubPullRequestRequest,
  ) => Promise<unknown>;
  readonly getBranchRef: (request: GitHubBranchRefRequest) => Promise<unknown>;
}

export type GitHubMetadataPort = GitHubMetadataClient;

export interface GitHubMetadataAdapterOptions {
  readonly client: GitHubMetadataClient;
  readonly repository: RepositoryIdentity;
  readonly workflow?: WorkflowDefinitionMetadata;
}

export function repositoryIdentityFromGitHubResponse(
  value: GitHubRepositoryResponse,
): RepositoryIdentity {
  const fullName = value.full_name;
  if (fullName !== undefined) {
    const separator = fullName.indexOf("/");
    const repository = {
      owner: fullName.slice(0, separator),
      name: fullName.slice(separator + 1),
    };
    const parsed = repositoryIdentitySchema.safeParse(repository);
    if (parsed.success) return parsed.data;
  }

  const owner = value.owner?.login;
  const parsed = repositoryIdentitySchema.safeParse({
    owner,
    name: value.name,
  });
  if (!parsed.success) {
    throw new TypeError("GitHub repository metadata is malformed.");
  }
  return parsed.data;
}

export function githubResponseRepositoryIdentity(
  value: unknown,
): RepositoryIdentity {
  const parsed = githubRepositoryResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("GitHub repository metadata is malformed.");
  }
  return repositoryIdentityFromGitHubResponse(parsed.data);
}

export function workflowDefinitionMetadata(
  ref: unknown,
  sha: unknown,
): WorkflowDefinitionMetadata {
  const parsed = workflowDefinitionMetadataSchema.safeParse({ ref, sha });
  if (!parsed.success) {
    throw new TypeError("Workflow definition metadata is malformed.");
  }
  return parsed.data;
}

export type { BranchName, GitRevision, PullRequestMetadataPort };
