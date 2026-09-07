import {
  branchNameSchema,
  gitRevisionSchema,
  type BranchName,
  type CommitAndPushPort,
  type GitRevision,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import type { GitWorkspacePort } from "./git-port.js";

function pushError(
  code:
    | "REMOTE_BASE_CHANGED"
    | "REMOTE_HEAD_CHANGED"
    | "PUSH_REFUSED"
    | "OPERATION_FAILED",
  message: string,
  cause?: unknown,
): ActionResolutionError {
  return new ActionResolutionError("push", code, message, cause);
}

async function requireCommand(
  git: GitWorkspacePort,
  args: readonly string[],
): Promise<void> {
  const result = await git.run(args);
  if (result.exitCode !== 0) {
    throw pushError("OPERATION_FAILED", "The Git command failed.", result);
  }
}

async function readRemoteRevision(
  git: GitWorkspacePort,
  branch: BranchName,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<GitRevision> {
  const args = ["rev-parse", "--verify", `refs/remotes/origin/${branch}`];
  const result =
    git.runWithEnvironment === undefined
      ? await git.run(args)
      : await git.runWithEnvironment(args, env);
  const parsed = gitRevisionSchema.safeParse(result.stdout.trim());
  if (result.exitCode !== 0 || !parsed.success) {
    throw pushError(
      "OPERATION_FAILED",
      "The remote branch revision could not be read.",
      result,
    );
  }
  return parsed.data;
}

export class NodeCommitAndPush implements CommitAndPushPort {
  private readonly git: GitWorkspacePort;
  private readonly token: string | undefined;
  private authenticationEnvironment:
    Readonly<Record<string, string | undefined>> | undefined;

  constructor(git: GitWorkspacePort, token?: string) {
    this.git = git;
    this.token = token;
  }

  async beforePush(): Promise<void> {
    if (this.token === undefined || this.token.length === 0) {
      throw pushError(
        "OPERATION_FAILED",
        "A GitHub token is required before push.",
      );
    }
    const authorization = Buffer.from(`x-access-token:${this.token}`).toString(
      "base64",
    );
    this.authenticationEnvironment = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    };
  }

  async commit(baseBranch: BranchName): Promise<void> {
    const branch = branchNameSchema.parse(baseBranch);
    await requireCommand(this.git, [
      "config",
      "user.name",
      "Seqlane conflict resolver",
    ]);
    await requireCommand(this.git, [
      "config",
      "user.email",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ]);
    await requireCommand(this.git, [
      "commit",
      "-m",
      `Merge ${branch} and resolve conflicts`,
    ]);
  }

  async push(options: {
    readonly baseBranch: BranchName;
    readonly headBranch: BranchName;
    readonly baseRevision: GitRevision;
    readonly headRevision: GitRevision;
  }): Promise<void> {
    const baseBranch = branchNameSchema.parse(options.baseBranch);
    const headBranch = branchNameSchema.parse(options.headBranch);
    await this.requirePushCommand([
      "fetch",
      "origin",
      `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ]);
    await this.requirePushCommand([
      "fetch",
      "origin",
      `refs/heads/${headBranch}:refs/remotes/origin/${headBranch}`,
    ]);
    const liveBase = await readRemoteRevision(
      this.git,
      baseBranch,
      this.authenticationEnvironment,
    );
    if (liveBase !== options.baseRevision) {
      throw pushError(
        "REMOTE_BASE_CHANGED",
        "The pull-request base changed during resolution.",
      );
    }
    const liveHead = await readRemoteRevision(
      this.git,
      headBranch,
      this.authenticationEnvironment,
    );
    if (liveHead !== options.headRevision) {
      throw pushError(
        "REMOTE_HEAD_CHANGED",
        "The pull-request head changed during resolution.",
      );
    }
    const result = await this.runPushCommand([
      "push",
      `--force-with-lease=refs/heads/${headBranch}:${options.headRevision}`,
      "origin",
      `HEAD:refs/heads/${headBranch}`,
    ]);
    if (result.exitCode !== 0) {
      throw pushError(
        "PUSH_REFUSED",
        "The resolved pull request could not be pushed.",
        result,
      );
    }
  }

  private async requirePushCommand(args: readonly string[]): Promise<void> {
    const result = await this.runPushCommand(args);
    if (result.exitCode !== 0) {
      throw pushError("OPERATION_FAILED", "The Git command failed.", result);
    }
  }

  private runPushCommand(args: readonly string[]) {
    return this.git.runWithEnvironment === undefined
      ? this.git.run(args)
      : this.git.runWithEnvironment(args, this.authenticationEnvironment ?? {});
  }
}
