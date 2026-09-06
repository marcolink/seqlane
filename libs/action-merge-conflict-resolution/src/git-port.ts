import {
  conflictSetSchema,
  type ConflictPath,
  type ConflictSet,
  type GitRevision,
  type IntegrationOperation,
  type IntegrationResult,
} from "./contracts.js";
import {
  ActionResolutionError,
  type ResolutionErrorCategory,
  type ResolutionErrorCode,
} from "./errors.js";

export interface GitCommandResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandPort {
  readonly run: (args: readonly string[]) => Promise<GitCommandResult>;
}

export interface GitWorkspacePort extends GitCommandPort {
  readonly cwd: string;
}

export function uniqueConflictPaths(
  conflicts: ConflictSet,
): readonly ConflictPath[] {
  return [...new Set(conflicts.map(({ path }) => path))];
}

export function parseUnmergedIndex(output: string): ConflictSet {
  const entries = output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const tabIndex = entry.indexOf("\t");
      if (tabIndex < 0) return undefined;

      const [mode, objectId, stage] = entry.slice(0, tabIndex).split(" ");
      const path = entry.slice(tabIndex + 1);
      if (
        !/^\d{6}$/.test(mode ?? "") ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(objectId ?? "") ||
        !/^[123]$/.test(stage ?? "")
      ) {
        return undefined;
      }

      return { path, stage: Number(stage) as 1 | 2 | 3 };
    });

  if (entries.some((entry) => entry === undefined)) {
    throw new ActionResolutionError(
      "git",
      "GIT_OUTPUT_MALFORMED",
      "Git returned a malformed unmerged index record.",
    );
  }

  const parsed = conflictSetSchema.safeParse(entries);
  if (!parsed.success) {
    throw new ActionResolutionError(
      "git",
      "GIT_OUTPUT_MALFORMED",
      "Git returned an invalid unmerged index path.",
      parsed.error,
    );
  }
  return parsed.data;
}

export function gitCommandError(
  code: ResolutionErrorCode,
  message: string,
  command: GitCommandResult | undefined,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError("git", code, message, cause ?? command);
}

export function integrationFailure(
  operation: IntegrationOperation,
  headBefore: GitRevision,
  targetRevision: GitRevision,
  error: {
    readonly category: ResolutionErrorCategory;
    readonly code: ResolutionErrorCode;
  },
  command?: GitCommandResult,
): IntegrationResult {
  return {
    kind: "error",
    operation,
    headBefore,
    targetRevision,
    exitCode: command?.exitCode ?? -1,
    stderr: command?.stderr ?? "",
    error,
  };
}
