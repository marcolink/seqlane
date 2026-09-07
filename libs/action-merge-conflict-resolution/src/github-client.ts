import {
  githubBranchRefResponseSchema,
  githubPullRequestResponseSchema,
  workflowDefinitionMetadataSchema,
  type GitHubMetadataAdapterOptions,
  type GitHubMetadataClient,
  githubResponseRepositoryIdentity,
} from "./github-port.js";
import {
  branchNameSchema,
  liveBaseRevisionSchema,
  positiveIntegerSchema,
  pullRequestMetadataSchema,
  repositoryIdentitySchema,
  type BranchName,
  type LiveBaseRevision,
  type PullRequestMetadata,
  type PullRequestMetadataPort,
  type RepositoryIdentity,
} from "./contracts.js";
import type { WorkflowDefinitionMetadata } from "./github-port.js";
import { ActionResolutionError } from "./errors.js";

function metadataError(
  message: string,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError(
    "pull-request-preflight",
    "MALFORMED_PULL_REQUEST",
    message,
    cause,
  );
}

function operationError(
  message: string,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError(
    "operational",
    "OPERATION_FAILED",
    message,
    cause,
  );
}

function validateRepository(value: unknown): RepositoryIdentity {
  const parsed = repositoryIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw metadataError(
      "The current repository identity is malformed.",
      parsed.error,
    );
  }
  return parsed.data;
}

function validateWorkflow(
  value: WorkflowDefinitionMetadata | undefined,
): WorkflowDefinitionMetadata | undefined {
  if (value === undefined) return undefined;
  // The schema is also applied at the adapter boundary so callers cannot
  // smuggle an unvalidated workflow ref or revision through a cast.
  const parsed = workflowDefinitionMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw metadataError(
      "The workflow definition metadata is malformed.",
      parsed.error,
    );
  }
  return parsed.data;
}

export class GitHubMetadataAdapter implements PullRequestMetadataPort {
  private readonly client: GitHubMetadataClient;
  private readonly repository: RepositoryIdentity;
  private readonly workflow: WorkflowDefinitionMetadata | undefined;

  constructor(options: GitHubMetadataAdapterOptions) {
    this.client = options.client;
    this.repository = validateRepository(options.repository);
    this.workflow = validateWorkflow(options.workflow);
  }

  async readPullRequest(
    pullRequestNumber: number,
  ): Promise<PullRequestMetadata> {
    const parsedNumber = positiveIntegerSchema.safeParse(pullRequestNumber);
    if (!parsedNumber.success) {
      throw new ActionResolutionError(
        "input-validation",
        "INVALID_REQUEST",
        "The pull-request number is invalid.",
        parsedNumber.error,
      );
    }

    let response: unknown;
    try {
      response = await this.client.getPullRequest({
        owner: this.repository.owner,
        repository: this.repository.name,
        pullRequestNumber,
      });
    } catch (error: unknown) {
      throw operationError("The pull-request metadata request failed.", error);
    }

    const parsed = githubPullRequestResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw metadataError(
        "The GitHub pull-request response is malformed.",
        parsed.error,
      );
    }
    if (parsed.data.number !== pullRequestNumber) {
      throw metadataError(
        "The GitHub pull-request response is malformed.",
        new Error("The response number does not match the request."),
      );
    }

    let baseRepository: RepositoryIdentity;
    let headRepository: RepositoryIdentity;
    try {
      baseRepository = githubResponseRepositoryIdentity(parsed.data.base.repo);
      headRepository = githubResponseRepositoryIdentity(parsed.data.head.repo);
    } catch (error: unknown) {
      throw metadataError(
        "The GitHub pull-request response is malformed.",
        error,
      );
    }

    const metadata = pullRequestMetadataSchema.safeParse({
      number: parsed.data.number,
      state: parsed.data.state,
      baseBranch: parsed.data.base.ref,
      headBranch: parsed.data.head.ref,
      baseRevision: parsed.data.base.sha,
      headRevision: parsed.data.head.sha,
      baseRepository,
      headRepository,
      workflowRef: this.workflow?.ref,
      workflowRevision: this.workflow?.sha,
    });
    if (!metadata.success) {
      throw metadataError(
        "The GitHub pull-request response is malformed.",
        metadata.error,
      );
    }
    return metadata.data;
  }

  async readLiveBaseRevision(branch: BranchName): Promise<LiveBaseRevision> {
    const parsedBranch = branchNameSchema.safeParse(branch);
    if (!parsedBranch.success) {
      throw metadataError(
        "The base branch name is malformed.",
        parsedBranch.error,
      );
    }

    let response: unknown;
    try {
      response = await this.client.getBranchRef({
        owner: this.repository.owner,
        repository: this.repository.name,
        ref: `heads/${parsedBranch.data}`,
      });
    } catch (error: unknown) {
      throw operationError("The live base branch request failed.", error);
    }

    const parsed = githubBranchRefResponseSchema.safeParse(response);
    const expectedRef = `refs/heads/${parsedBranch.data}`;
    if (!parsed.success) {
      throw metadataError(
        "The live base branch response is malformed.",
        parsed.error,
      );
    }
    if (parsed.data.ref !== expectedRef) {
      throw metadataError(
        "The live base branch response is malformed.",
        new Error("The live base branch ref does not match the request."),
      );
    }

    const liveBase = liveBaseRevisionSchema.safeParse({
      branch: parsedBranch.data,
      revision: parsed.data.object.sha,
    });
    if (!liveBase.success) {
      throw metadataError(
        "The live base branch response is malformed.",
        liveBase.error,
      );
    }
    return liveBase.data;
  }
}

export class NodeGitHubMetadataAdapter extends GitHubMetadataAdapter {}

export function createGitHubMetadataAdapter(
  options: GitHubMetadataAdapterOptions,
): PullRequestMetadataPort {
  return new GitHubMetadataAdapter(options);
}
