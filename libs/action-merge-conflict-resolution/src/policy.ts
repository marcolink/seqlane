import {
  actionInputsSchema,
  conflictSetSchema,
  DEFAULT_MAX_ATTEMPTS,
  positiveIntegerSchema,
  pullRequestMetadataSchema,
  repositoryIdentitySchema,
  resolveMergeConflictsRequestSchema,
  type TerminalOutcome,
  type ConflictSet,
  type PullRequestMetadata,
  type ResolveMergeConflictsRequest,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";

export interface ClassifiedConflicts {
  readonly agent: ConflictSet;
  readonly lockfile: ConflictSet;
}

export interface MutationPermissions {
  readonly commit: boolean;
  readonly push: boolean;
}

function inputError(
  code: "INVALID_ACTION_INPUT" | "INVALID_REQUEST",
  cause: unknown,
): ActionResolutionError {
  return new ActionResolutionError(
    "input-validation",
    code,
    code === "INVALID_ACTION_INPUT"
      ? "Action inputs are invalid."
      : "The resolver request is invalid.",
    cause,
  );
}

export function parseActionInputs(
  value: unknown,
): ResolveMergeConflictsRequest {
  const parsed = actionInputsSchema.safeParse(value);
  if (!parsed.success) throw inputError("INVALID_ACTION_INPUT", parsed.error);

  return {
    pullRequestNumber: Number(parsed.data.pullRequestNumber),
    strategy: parsed.data.resolutionStrategy,
    sourceDirectory: parsed.data.sourceDirectory,
    targetDirectory: parsed.data.targetDirectory,
    commit: parsed.data.commit === "true",
    push: parsed.data.push === "true",
    maxAttempts: Number(parsed.data.maxAttempts),
  };
}

export function validateRequest(value: unknown): ResolveMergeConflictsRequest {
  const parsed = resolveMergeConflictsRequestSchema.safeParse(value);
  if (!parsed.success) throw inputError("INVALID_REQUEST", parsed.error);
  return parsed.data;
}

export function parsePullRequestMetadata(value: unknown): PullRequestMetadata {
  const parsed = pullRequestMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new ActionResolutionError(
      "pull-request-preflight",
      "MALFORMED_PULL_REQUEST",
      "Pull-request metadata is malformed.",
      parsed.error,
    );
  }
  return parsed.data;
}

export function validatePullRequestPreflight(
  value: unknown,
  currentRepositoryValue: unknown,
): PullRequestMetadata {
  const metadata = parsePullRequestMetadata(value);
  const currentRepositoryResult = repositoryIdentitySchema.safeParse(
    currentRepositoryValue,
  );
  if (!currentRepositoryResult.success) {
    throw new ActionResolutionError(
      "pull-request-preflight",
      "MALFORMED_PULL_REQUEST",
      "The current repository identity is malformed.",
      currentRepositoryResult.error,
    );
  }
  const currentRepository = currentRepositoryResult.data;
  if (metadata.state !== "open") {
    throw new ActionResolutionError(
      "pull-request-preflight",
      "PULL_REQUEST_NOT_OPEN",
      "The pull request is not open.",
    );
  }
  if (
    metadata.headRepository.owner !== currentRepository.owner ||
    metadata.headRepository.name !== currentRepository.name
  ) {
    throw new ActionResolutionError(
      "pull-request-preflight",
      "FORK_PULL_REQUEST",
      "The pull request head is not in the current repository.",
    );
  }
  return metadata;
}

export function classifyConflicts(conflicts: unknown): ClassifiedConflicts {
  const parsed = conflictSetSchema.safeParse(conflicts);
  if (!parsed.success) {
    throw new ActionResolutionError(
      "git",
      "CONFLICT_SET_REQUIRED",
      "The conflict set is malformed.",
      parsed.error,
    );
  }

  return parsed.data.reduce<ClassifiedConflicts>(
    (classified, conflict) => {
      const destination =
        conflict.path === "pnpm-lock.yaml"
          ? classified.lockfile
          : classified.agent;
      destination.push(conflict);
      return classified;
    },
    { agent: [], lockfile: [] },
  );
}

export function isAttemptAllowed(
  completedAttempts: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): boolean {
  return (
    Number.isSafeInteger(completedAttempts) &&
    completedAttempts >= 0 &&
    positiveIntegerSchema.safeParse(maxAttempts).success &&
    completedAttempts < maxAttempts
  );
}

export function assertAttemptAllowed(
  completedAttempts: number,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): void {
  if (!isAttemptAllowed(completedAttempts, maxAttempts)) {
    throw new ActionResolutionError(
      "attempt-limit",
      "ATTEMPT_LIMIT_EXCEEDED",
      "The maximum number of resolution attempts was exceeded.",
    );
  }
}

export function mutationPermissions(
  request: Pick<ResolveMergeConflictsRequest, "commit" | "push">,
): MutationPermissions {
  return { commit: request.commit, push: request.push };
}

export function canCommit(
  request: Pick<ResolveMergeConflictsRequest, "commit">,
): boolean {
  return request.commit;
}

export function canPush(
  request: Pick<ResolveMergeConflictsRequest, "push">,
): boolean {
  return request.push;
}

export function terminalOutcome(
  integration: "clean" | "resolved",
  permissions: MutationPermissions,
): TerminalOutcome {
  return {
    result: integration === "clean" ? "no-change" : "updated",
    shouldCommit: integration === "resolved" && permissions.commit,
    shouldPush: integration === "resolved" && permissions.push,
  };
}
