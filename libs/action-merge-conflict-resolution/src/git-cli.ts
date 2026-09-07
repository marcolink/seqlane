import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  conflictSetSchema,
  conflictPathSchema,
  gitRevisionSchema,
  type ConflictPath,
  type ConflictSet,
  type GitPort,
  type GitRevision,
  type IntegrationResult,
  type ResolutionStrategy,
} from "./contracts.js";
import { ActionResolutionError, type ResolutionErrorCode } from "./errors.js";
import {
  gitCommandError,
  integrationFailure,
  parseUnmergedIndex,
  uniqueConflictPaths,
  type GitCommandResult,
  type GitWorkspacePort,
} from "./git-port.js";

const maximumGitOutputBytes = 8 * 1024 * 1024;

export function runGitCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      executable,
      [...args],
      {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        maxBuffer: maximumGitOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveResult({
          executable,
          args: [...args],
          cwd,
          exitCode,
          stdout,
          stderr,
        });
      },
    );
  });
}

function operationPath(cwd: string, output: string): string {
  const path = output.trim();
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export class NodeGitCli implements GitPort, GitWorkspacePort {
  readonly cwd: string;
  private readonly executable: string;

  constructor(cwd: string, executable = "git") {
    this.cwd = resolve(cwd);
    this.executable = executable;
  }

  run(args: readonly string[]): Promise<GitCommandResult> {
    return runGitCommand(this.executable, args, this.cwd);
  }

  runWithEnvironment(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<GitCommandResult> {
    return runGitCommand(this.executable, args, this.cwd, env);
  }

  private async requiredCommand(
    args: readonly string[],
    code: ResolutionErrorCode = "GIT_OPERATION_FAILED",
  ): Promise<GitCommandResult> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw gitCommandError(code, "The Git command failed.", result);
    }
    return result;
  }

  private async headRevision(): Promise<GitRevision> {
    const result = await this.requiredCommand([
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const revision = result.stdout.trim();
    const parsed = gitRevisionSchema.safeParse(revision);
    if (!parsed.success) {
      throw gitCommandError(
        "GIT_OUTPUT_MALFORMED",
        "Git returned a malformed HEAD revision.",
        result,
        parsed.error,
      );
    }
    return parsed.data;
  }

  private async operationInProgress(name: string): Promise<boolean> {
    const result = await this.requiredCommand([
      "rev-parse",
      "--git-path",
      name,
    ]);
    const path = operationPath(this.cwd, result.stdout);
    try {
      const stats = lstatSync(path);
      return stats.isFile() || stats.isDirectory();
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw new ActionResolutionError(
        "git",
        "GIT_OPERATION_FAILED",
        "The Git operation state could not be inspected.",
        error,
      );
    }
  }

  async inspectState(): Promise<{
    readonly mergeInProgress: boolean;
    readonly rebaseInProgress: boolean;
    readonly worktreeClean: boolean;
  }> {
    const status = await this.requiredCommand([
      "status",
      "--porcelain=v2",
      "-z",
    ]);
    const [mergeInProgress, rebaseMergeInProgress, rebaseApplyInProgress] =
      await Promise.all([
        this.operationInProgress("MERGE_HEAD"),
        this.operationInProgress("rebase-merge"),
        this.operationInProgress("rebase-apply"),
      ]);

    return {
      mergeInProgress,
      rebaseInProgress: rebaseMergeInProgress || rebaseApplyInProgress,
      worktreeClean: status.stdout.length === 0,
    };
  }

  async readConflictSet(): Promise<ConflictSet> {
    const result = await this.requiredCommand(["ls-files", "--unmerged", "-z"]);
    return parseUnmergedIndex(result.stdout);
  }

  async integrate(
    strategy: ResolutionStrategy,
    baseRevision: GitRevision,
  ): Promise<IntegrationResult> {
    const operation = strategy;
    const headBefore = await this.headRevision();
    let state: Awaited<ReturnType<NodeGitCli["inspectState"]>>;
    try {
      state = await this.inspectState();
    } catch (error: unknown) {
      return integrationFailure(
        operation,
        headBefore,
        baseRevision,
        error instanceof ActionResolutionError
          ? { category: error.category, code: error.code }
          : { category: "git", code: "GIT_OPERATION_FAILED" },
      );
    }

    if (state.mergeInProgress || state.rebaseInProgress) {
      return integrationFailure(operation, headBefore, baseRevision, {
        category: "git",
        code: "PRE_EXISTING_OPERATION",
      });
    }
    if (!state.worktreeClean) {
      return integrationFailure(operation, headBefore, baseRevision, {
        category: "git",
        code: "WORKTREE_NOT_CLEAN",
      });
    }

    if (strategy === "rebase") {
      try {
        await this.configureIdentity();
      } catch (error: unknown) {
        return integrationFailure(
          operation,
          headBefore,
          baseRevision,
          error instanceof ActionResolutionError
            ? { category: error.category, code: error.code }
            : { category: "git", code: "GIT_OPERATION_FAILED" },
        );
      }
    }

    const command = await this.run(
      strategy === "rebase"
        ? ["rebase", baseRevision]
        : ["merge", "--no-commit", "--no-ff", baseRevision],
    );
    let conflicts: ConflictSet;
    try {
      conflicts = await this.readConflictSet();
    } catch (error: unknown) {
      return integrationFailure(
        operation,
        headBefore,
        baseRevision,
        {
          category: "git",
          code:
            error instanceof ActionResolutionError
              ? error.code
              : "GIT_OPERATION_FAILED",
        },
        command,
      );
    }

    if (conflicts.length > 0) {
      return {
        kind: "conflicted",
        operation,
        headBefore,
        targetRevision: baseRevision,
        conflicts,
      };
    }
    if (command.exitCode !== 0) {
      return integrationFailure(
        operation,
        headBefore,
        baseRevision,
        {
          category: "git",
          code: "GIT_OPERATION_FAILED",
        },
        command,
      );
    }

    if (strategy === "merge") {
      if (await this.operationInProgress("MERGE_HEAD")) {
        const abort = await this.run(["merge", "--abort"]);
        if (abort.exitCode !== 0) {
          return integrationFailure(
            operation,
            headBefore,
            baseRevision,
            {
              category: "git",
              code: "GIT_OPERATION_FAILED",
            },
            abort,
          );
        }
      }
    }

    const headAfter = await this.headRevision();
    return {
      kind: "clean",
      operation,
      headBefore,
      targetRevision: baseRevision,
      headAfter,
    };
  }

  async stageConflictSet(conflicts: ConflictSet): Promise<void> {
    const parsed = conflictSetSchema.safeParse(conflicts);
    if (!parsed.success) {
      throw new ActionResolutionError(
        "git",
        "CONFLICT_SET_REQUIRED",
        "The conflict set is malformed.",
        parsed.error,
      );
    }
    const paths = uniqueConflictPaths(parsed.data);
    if (paths.length === 0) return;

    const result = await this.run(["add", "--", ...paths]);
    if (result.exitCode !== 0) {
      throw gitCommandError(
        "GIT_OPERATION_FAILED",
        "The conflict paths could not be staged.",
        result,
      );
    }
  }

  continueRebase(): Promise<GitCommandResult> {
    return this.configureIdentity().then(() =>
      this.runWithEnvironment(["rebase", "--continue"], {
        GIT_EDITOR: "true",
      }),
    );
  }

  async configureIdentity(): Promise<void> {
    await this.requiredCommand([
      "config",
      "--local",
      "user.name",
      "Seqlane conflict resolver",
    ]);
    await this.requiredCommand([
      "config",
      "--local",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
  }

  skipRebase(): Promise<GitCommandResult> {
    return this.run(["rebase", "--skip"]);
  }

  async readTrackedPaths(): Promise<readonly ConflictPath[]> {
    const result = await this.requiredCommand(["ls-files", "-z"]);
    const paths: ConflictPath[] = [];
    for (const path of result.stdout.split("\0").filter(Boolean)) {
      const parsed = conflictPathSchema.safeParse(path);
      if (!parsed.success) {
        throw gitCommandError(
          "GIT_OUTPUT_MALFORMED",
          "Git returned an invalid tracked path.",
          result,
          parsed.error,
        );
      }
      paths.push(parsed.data);
    }
    return paths;
  }

  async readStagedPath(path: ConflictPath): Promise<GitCommandResult> {
    return this.run(["show", "--format=", `:${path}`]);
  }

  async validateCachedWhitespace(): Promise<void> {
    const result = await this.run(["diff", "--cached", "--check"]);
    if (result.exitCode !== 0) {
      throw gitCommandError(
        "STAGED_WHITESPACE_ERROR",
        "The staged resolution contains whitespace errors.",
        result,
      );
    }
  }
}
