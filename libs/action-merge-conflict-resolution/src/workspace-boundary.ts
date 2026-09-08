import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  conflictSetSchema,
  MAX_AGENT_FILE_BYTES,
  MAX_AGENT_TOTAL_BYTES,
  MAX_LOCKFILE_INPUT_FILES,
  MAX_LOCKFILE_INPUT_FILE_BYTES,
  MAX_LOCKFILE_INPUT_TOTAL_BYTES,
  type AgentResolutionRequest,
  type ConflictPath,
  type ConflictSet,
  type GitRevision,
  type WorkspaceFilesPort,
} from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { NodeGitCli } from "./git-cli.js";
import {
  type GitCommandPort,
  type GitCommandResult,
  type GitWorkspacePort,
} from "./git-port.js";
import { validateLockfileInput } from "./lockfile-policy.js";
import {
  asPaths,
  assertSafeRoot,
  assertSeparateWorkspaceRootPaths,
  claimWorkspace,
  clearOwnedAgentWorkspace,
  copyFiles,
  createOwnedAgentWorkspace,
  validateSafeDirectoryWithinRoot,
  validateSafeFileWithinRoot,
  validateSeparateWorkspaceRoots,
  workspaceError,
  readNullDelimitedPaths,
} from "./workspace-boundary-filesystem.js";

export {
  assertSafeRoot,
  assertSeparateWorkspaceRootPaths,
  copyFiles,
  createOwnedAgentWorkspace,
  readNullDelimitedPaths,
  validateSafeDirectoryWithinRoot,
  validateSafeFileWithinRoot,
  validateSeparateWorkspaceRoots,
};

export const maximumAgentFileBytes = MAX_AGENT_FILE_BYTES;
export const maximumAgentTotalBytes = MAX_AGENT_TOTAL_BYTES;
export const maximumLockfileInputFiles = MAX_LOCKFILE_INPUT_FILES;
export const maximumLockfileInputFileBytes = MAX_LOCKFILE_INPUT_FILE_BYTES;
export const maximumLockfileInputTotalBytes = MAX_LOCKFILE_INPUT_TOTAL_BYTES;

const lockfilePath = "pnpm-lock.yaml";

export async function prepareAgentWorkspace(
  sourceRoot: string,
  agentRoot: string,
  paths: readonly string[],
  runId: string = randomUUID(),
): Promise<void> {
  const source = await assertSafeRoot(sourceRoot, "Agent source");
  const agent = await assertSafeRoot(agentRoot, "Agent workspace");
  await claimWorkspace(agent, runId);
  await clearOwnedAgentWorkspace(agent, runId);
  await copyFiles({ sourceRoot: source, outputRoot: agent }, asPaths(paths), {
    maximumFileBytes: maximumAgentFileBytes,
    maximumTotalBytes: maximumAgentTotalBytes,
    rejectBinary: true,
  });
}

export async function prepareAgentResolutionWorkspace(
  sourceRoot: string,
  agentRoot: string,
  conflicts: ConflictSet,
  baseRevision: GitRevision,
  headRevision: GitRevision,
  runId: string = randomUUID(),
): Promise<AgentResolutionRequest> {
  const parsed = conflictSetSchema.safeParse(conflicts);
  if (!parsed.success) {
    throw workspaceError(
      "UNSAFE_PATH",
      "The conflict set is malformed.",
      parsed.error,
    );
  }
  const agentConflicts = parsed.data.filter(
    ({ path }) => path !== lockfilePath,
  );
  const paths = [...new Set(asPaths(agentConflicts))];
  if (paths.length === 0) {
    throw new ActionResolutionError(
      "workspace",
      "CONFLICT_SET_REQUIRED",
      "An agent workspace requires at least one agent conflict.",
    );
  }
  await prepareAgentWorkspace(sourceRoot, agentRoot, paths, runId);
  return { paths: [...paths], baseRevision, headRevision };
}

export async function copyAgentEdits(
  agentRoot: string,
  targetRoot: string,
  paths: readonly string[],
): Promise<void> {
  const agent = await assertSafeRoot(agentRoot, "Agent workspace");
  const target = await assertSafeRoot(targetRoot, "Resolution target");
  await copyFiles({ sourceRoot: agent, outputRoot: target }, asPaths(paths), {
    maximumFileBytes: maximumAgentFileBytes,
    maximumTotalBytes: maximumAgentTotalBytes,
    rejectBinary: true,
  });
}

function commandError(
  result: GitCommandResult,
  message: string,
): ActionResolutionError {
  return new ActionResolutionError(
    "workspace",
    "UNEXPECTED_TARGET_CHANGE",
    message,
    result,
  );
}

async function requiredGitCommand(
  git: GitCommandPort,
  args: readonly string[],
): Promise<string> {
  const result = await git.run(args);
  if (result.exitCode !== 0) {
    throw commandError(result, "The target workspace could not be inspected.");
  }
  return result.stdout;
}

export async function readWorkspaceChangePaths(
  git: GitCommandPort,
): Promise<readonly ConflictPath[]> {
  const trackedChanges = [
    readNullDelimitedPaths(
      await requiredGitCommand(git, ["diff", "--name-only", "-z"]),
    ),
    readNullDelimitedPaths(
      await requiredGitCommand(git, ["diff", "--cached", "--name-only", "-z"]),
    ),
  ].flat();
  const untracked = readNullDelimitedPaths(
    await requiredGitCommand(git, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  );
  const ignored = readNullDelimitedPaths(
    await requiredGitCommand(git, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]),
  );
  return asPaths([...trackedChanges, ...untracked, ...ignored]);
}

export async function validateResolutionWorkspace(
  targetRoot: string,
  allowedPaths: readonly string[],
  git: GitCommandPort = new NodeGitCli(targetRoot),
): Promise<void> {
  await assertSafeRoot(targetRoot, "Resolution target");
  const allowed = new Set(asPaths(allowedPaths));
  const changedPaths = await readWorkspaceChangePaths(git);
  const unexpected = changedPaths.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw workspaceError(
      "UNEXPECTED_TARGET_CHANGE",
      `Unexpected target paths: ${unexpected.join(", ")}`,
    );
  }
}

export async function prepareLockfileWorkspace(
  sourceRoot: string,
  lockfileRoot: string,
  git: GitCommandPort = new NodeGitCli(sourceRoot),
): Promise<void> {
  const output = await assertSafeRoot(lockfileRoot, "Lockfile workspace");
  const trackedPaths = readNullDelimitedPaths(
    await requiredGitCommand(git, [
      "ls-files",
      "-z",
      "--",
      "pnpm-workspace.yaml",
      ":(glob)**/package.json",
    ]),
  );
  const paths = asPaths(trackedPaths);
  const safeSourceRoot = await assertSafeRoot(sourceRoot, "Lockfile source");
  await copyFiles(
    {
      sourceRoot: safeSourceRoot,
      outputRoot: output,
    },
    paths,
    {
      maximumFiles: maximumLockfileInputFiles,
      maximumFileBytes: maximumLockfileInputFileBytes,
      maximumTotalBytes: maximumLockfileInputTotalBytes,
    },
    async (path) => validateLockfileInput(safeSourceRoot, path),
  );
}

export interface NodeWorkspaceBoundaryOptions {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly agentRoot: string;
  readonly baseRevision: GitRevision;
  readonly headRevision: GitRevision;
  readonly git?: GitWorkspacePort;
  readonly runId?: string;
}

export class NodeWorkspaceBoundary implements WorkspaceFilesPort {
  private readonly runId: string;
  private readonly options: NodeWorkspaceBoundaryOptions;
  private readonly git: GitWorkspacePort;
  private originalConflicts: ConflictSet = [];
  private originalAgentPaths: readonly ConflictPath[] = [];
  private readonly integrationBaselinePaths = new Set<ConflictPath>();

  constructor(options: NodeWorkspaceBoundaryOptions) {
    this.options = options;
    const sourceRoot = resolve(options.sourceRoot);
    const targetRoot = resolve(options.targetRoot);
    const agentRoot = resolve(options.agentRoot);
    this.git = options.git ?? new NodeGitCli(targetRoot);
    assertSeparateWorkspaceRootPaths(sourceRoot, targetRoot);
    const targetRelativeToAgent = relative(targetRoot, agentRoot);
    const agentRelativeToTarget = relative(agentRoot, targetRoot);
    if (
      sourceRoot === agentRoot ||
      targetRoot === agentRoot ||
      (targetRelativeToAgent.length > 0 &&
        !targetRelativeToAgent.startsWith(`..${sep}`) &&
        !isAbsolute(targetRelativeToAgent)) ||
      (agentRelativeToTarget.length > 0 &&
        !agentRelativeToTarget.startsWith(`..${sep}`) &&
        !isAbsolute(agentRelativeToTarget))
    ) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The agent workspace must be outside the repository workspaces.",
      );
    }
    this.runId = options.runId ?? randomUUID();
  }

  async captureIntegrationBaseline(): Promise<void> {
    for (const path of await readWorkspaceChangePaths(this.git)) {
      this.integrationBaselinePaths.add(path);
    }
  }

  private rememberConflicts(conflicts: ConflictSet): void {
    this.originalConflicts = [
      ...new Map(
        [...this.originalConflicts, ...conflicts].map((conflict) => [
          conflict.path,
          conflict,
        ]),
      ).values(),
    ];
    this.originalAgentPaths = [
      ...new Set([
        ...this.originalAgentPaths,
        ...asPaths(conflicts.filter(({ path }) => path !== lockfilePath)),
      ]),
    ];
  }

  async prepareAgentWorkspace(
    conflicts: ConflictSet,
  ): Promise<AgentResolutionRequest> {
    const parsed = conflictSetSchema.safeParse(conflicts);
    if (!parsed.success) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The conflict set is malformed.",
        parsed.error,
      );
    }
    this.rememberConflicts(parsed.data);
    return prepareAgentResolutionWorkspace(
      this.options.targetRoot,
      this.options.agentRoot,
      parsed.data,
      this.options.baseRevision,
      this.options.headRevision,
      this.runId,
    );
  }

  async copyAgentEdits(paths: readonly ConflictPath[]): Promise<void> {
    const requested = asPaths(paths);
    const allowed = new Set(this.originalAgentPaths);
    const unexpected = requested.filter((path) => !allowed.has(path));
    if (unexpected.length > 0) {
      throw workspaceError(
        "UNSAFE_PATH",
        `Agent edits are outside the conflict set: ${unexpected.join(", ")}`,
      );
    }
    await copyAgentEdits(
      this.options.agentRoot,
      this.options.targetRoot,
      requested,
    );
  }

  async validateTarget(
    conflicts: ConflictSet,
    generatedPaths: readonly ConflictPath[] = [],
  ): Promise<void> {
    const parsed = conflictSetSchema.safeParse(conflicts);
    if (!parsed.success) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The conflict set is malformed.",
        parsed.error,
      );
    }
    this.rememberConflicts(parsed.data);
    const allowed = [
      ...asPaths(this.originalConflicts),
      ...this.integrationBaselinePaths,
      ...asPaths(generatedPaths ?? []),
    ];
    await validateResolutionWorkspace(this.options.targetRoot, allowed);
  }
}
