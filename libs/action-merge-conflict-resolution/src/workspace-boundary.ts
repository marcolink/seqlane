import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  conflictPathSchema,
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
import {
  ActionResolutionError,
  formatWorkspaceLimitDiagnostic,
} from "./errors.js";
import { NodeGitCli } from "./git-cli.js";
import {
  type GitCommandPort,
  type GitCommandResult,
  type GitWorkspacePort,
} from "./git-port.js";
import { validateLockfileInput } from "./lockfile-policy.js";

export const maximumAgentFileBytes = MAX_AGENT_FILE_BYTES;
export const maximumAgentTotalBytes = MAX_AGENT_TOTAL_BYTES;
export const maximumLockfileInputFiles = MAX_LOCKFILE_INPUT_FILES;
export const maximumLockfileInputFileBytes = MAX_LOCKFILE_INPUT_FILE_BYTES;
export const maximumLockfileInputTotalBytes = MAX_LOCKFILE_INPUT_TOTAL_BYTES;

const ownerSuffix = ".seqlane-agent-workspace-owner";
const lockfilePath = "pnpm-lock.yaml";

interface CopyLimits {
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly maximumFiles?: number;
  readonly rejectBinary?: boolean;
}

interface WorkspacePaths {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

function workspaceError(
  code:
    | "UNSAFE_PATH"
    | "UNSUPPORTED_AGENT_FILE"
    | "WORKSPACE_LIMIT_EXCEEDED"
    | "UNEXPECTED_TARGET_CHANGE",
  message: string,
  cause?: unknown,
): ActionResolutionError {
  const category: "validation" | "workspace" =
    code === "UNEXPECTED_TARGET_CHANGE" ? "validation" : "workspace";
  return new ActionResolutionError(category, code, message, cause);
}

function asPaths(
  value: readonly string[] | ConflictSet,
): readonly ConflictPath[] {
  const paths = value.map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
  for (const path of paths) {
    if (!conflictPathSchema.safeParse(path).success) {
      throw workspaceError("UNSAFE_PATH", `Unsafe workspace path: ${path}`);
    }
  }
  return [...new Set(paths)];
}

export function readNullDelimitedPaths(contents: string): string[] {
  return contents.split("\0").filter((entry) => entry.length > 0);
}

async function assertDirectory(
  path: string,
  description: string,
): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw workspaceError(
        "UNSAFE_PATH",
        `${description} is not a regular directory.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionResolutionError) throw error;
    throw workspaceError(
      "UNSAFE_PATH",
      `${description} is not available.`,
      error,
    );
  }
}

async function assertSafeRoot(
  path: string,
  description: string,
): Promise<string> {
  const requestedRoot = resolve(path);
  await assertDirectory(requestedRoot, description);
  try {
    return await realpath(requestedRoot);
  } catch (error: unknown) {
    throw workspaceError(
      "UNSAFE_PATH",
      `${description} cannot be resolved safely.`,
      error,
    );
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const firstRoot = resolve(first);
  const secondRoot = resolve(second);
  const secondFromFirst = relative(firstRoot, secondRoot);
  const firstFromSecond = relative(secondRoot, firstRoot);
  return (
    secondFromFirst.length === 0 ||
    firstFromSecond.length === 0 ||
    (!secondFromFirst.startsWith(`..${sep}`) && !isAbsolute(secondFromFirst)) ||
    (!firstFromSecond.startsWith(`..${sep}`) && !isAbsolute(firstFromSecond))
  );
}

export function assertSeparateWorkspaceRootPaths(
  sourceRoot: string,
  targetRoot: string,
): void {
  if (pathsOverlap(sourceRoot, targetRoot)) {
    throw workspaceError(
      "UNSAFE_PATH",
      "The trusted source and resolution target must be separate directories.",
    );
  }
}

export async function validateSeparateWorkspaceRoots(
  sourceRoot: string,
  targetRoot: string,
): Promise<{ readonly sourceRoot: string; readonly targetRoot: string }> {
  const source = await assertSafeRoot(sourceRoot, "Trusted source");
  const target = await assertSafeRoot(targetRoot, "Resolution target");
  assertSeparateWorkspaceRootPaths(source, target);
  return { sourceRoot: source, targetRoot: target };
}

export async function validateSafeDirectoryWithinRoot(
  root: string,
  path: string,
  description: string,
): Promise<string> {
  const safeRoot = await assertSafeRoot(root, `${description} root`);
  if (path === ".") return safeRoot;
  const candidate = ensureRelativePath(safeRoot, path);
  await assertNoSymlinkComponents(safeRoot, path);
  await assertDirectory(candidate, description);
  return candidate;
}

export async function validateSafeFileWithinRoot(
  root: string,
  path: string,
  description: string,
): Promise<string> {
  const safeRoot = await assertSafeRoot(root, `${description} root`);
  const candidate = await assertNoSymlinkComponents(safeRoot, path);
  try {
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw workspaceError(
        "UNSAFE_PATH",
        `${description} is not a regular file.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionResolutionError) throw error;
    throw workspaceError(
      "UNSAFE_PATH",
      `${description} is not available.`,
      error,
    );
  }
  return candidate;
}

function ensureRelativePath(root: string, path: string): string {
  if (!conflictPathSchema.safeParse(path).success) {
    throw workspaceError("UNSAFE_PATH", `Unsafe workspace path: ${path}`);
  }
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw workspaceError("UNSAFE_PATH", `Unsafe workspace path: ${path}`);
  }
  return candidate;
}

async function assertNoSymlinkComponents(
  root: string,
  path: string,
  allowMissingFinal = false,
): Promise<string> {
  const candidate = ensureRelativePath(root, path);
  const parts = path.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      throw workspaceError(
        "UNSAFE_PATH",
        `Workspace path is malformed: ${path}`,
      );
    }
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw workspaceError("UNSAFE_PATH", `Symlink is not allowed: ${path}`);
      }
    } catch (error: unknown) {
      if (
        allowMissingFinal &&
        index === parts.length - 1 &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      if (error instanceof ActionResolutionError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw workspaceError(
          "UNSUPPORTED_AGENT_FILE",
          `Workspace file is missing: ${path}`,
          error,
        );
      }
      throw workspaceError(
        "UNSAFE_PATH",
        `Workspace path cannot be inspected: ${path}`,
        error,
      );
    }
  }
  return candidate;
}

async function ensureDestinationDirectory(
  root: string,
  path: string,
): Promise<void> {
  const candidate = ensureRelativePath(root, path);
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw workspaceError(
          "UNSAFE_PATH",
          `Workspace directory is unsafe: ${path}`,
        );
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        try {
          await mkdir(current);
        } catch (mkdirError: unknown) {
          throw workspaceError(
            "UNSAFE_PATH",
            `Workspace directory cannot be created: ${path}`,
            mkdirError,
          );
        }
        continue;
      }
      if (error instanceof ActionResolutionError) throw error;
      throw workspaceError(
        "UNSAFE_PATH",
        `Workspace directory cannot be inspected: ${path}`,
        error,
      );
    }
  }
}

async function regularFile(root: string, path: string): Promise<string> {
  const candidate = await assertNoSymlinkComponents(root, path);
  try {
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw workspaceError(
        "UNSUPPORTED_AGENT_FILE",
        `Workspace path is not a regular file: ${path}`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionResolutionError) throw error;
    throw workspaceError(
      "UNSUPPORTED_AGENT_FILE",
      `Workspace path is not a regular file: ${path}`,
      error,
    );
  }
  return candidate;
}

async function enforceLockfileInputLimits(
  sourceRoot: string,
  paths: readonly ConflictPath[],
): Promise<void> {
  if (paths.length > maximumLockfileInputFiles) {
    throw workspaceError(
      "WORKSPACE_LIMIT_EXCEEDED",
      formatWorkspaceLimitDiagnostic(
        "The workspace input contains too many files",
        {
          observed: paths.length,
          limit: maximumLockfileInputFiles,
          unit: "files",
        },
      ),
    );
  }

  let totalBytes = 0;
  for (const path of paths) {
    const source = await regularFile(sourceRoot, path);
    const details = await stat(source);
    if (details.size > maximumLockfileInputFileBytes) {
      throw workspaceError(
        "WORKSPACE_LIMIT_EXCEEDED",
        formatWorkspaceLimitDiagnostic(
          "Lockfile input exceeds the configured per-file size limit",
          {
            path,
            observed: details.size,
            limit: maximumLockfileInputFileBytes,
            unit: "bytes",
          },
        ),
      );
    }
    if (totalBytes + details.size > maximumLockfileInputTotalBytes) {
      throw workspaceError(
        "WORKSPACE_LIMIT_EXCEEDED",
        formatWorkspaceLimitDiagnostic(
          "Lockfile input exceeds the configured total size limit",
          {
            path,
            observed: totalBytes + details.size,
            limit: maximumLockfileInputTotalBytes,
            unit: "bytes",
          },
        ),
      );
    }
    totalBytes += details.size;
  }
}

async function copyFiles(
  roots: WorkspacePaths,
  paths: readonly ConflictPath[],
  limits: CopyLimits,
): Promise<void> {
  if (limits.maximumFiles !== undefined && paths.length > limits.maximumFiles) {
    throw workspaceError(
      "WORKSPACE_LIMIT_EXCEEDED",
      formatWorkspaceLimitDiagnostic(
        "The workspace input contains too many files",
        {
          observed: paths.length,
          limit: limits.maximumFiles,
          unit: "files",
        },
      ),
    );
  }
  await assertSafeRoot(roots.sourceRoot, "Workspace source");
  await assertSafeRoot(roots.outputRoot, "Workspace output");

  let totalBytes = 0;
  for (const path of paths) {
    const source = await regularFile(roots.sourceRoot, path);
    const details = await stat(source);
    if (details.size > limits.maximumFileBytes) {
      throw workspaceError(
        "WORKSPACE_LIMIT_EXCEEDED",
        formatWorkspaceLimitDiagnostic(
          "Conflict file exceeds the configured size limit",
          {
            path,
            observed: details.size,
            limit: limits.maximumFileBytes,
            unit: "bytes",
          },
        ),
      );
    }
    if (totalBytes + details.size > limits.maximumTotalBytes) {
      throw workspaceError(
        "WORKSPACE_LIMIT_EXCEEDED",
        formatWorkspaceLimitDiagnostic(
          "Conflict payload exceeds the configured total size limit",
          {
            path,
            observed: totalBytes + details.size,
            limit: limits.maximumTotalBytes,
            unit: "bytes",
          },
        ),
      );
    }

    const contents = await readFile(source);
    if (limits.rejectBinary && contents.includes(0)) {
      throw workspaceError(
        "UNSUPPORTED_AGENT_FILE",
        `Binary conflict file is not supported: ${path}`,
      );
    }
    totalBytes += details.size;

    const target = ensureRelativePath(roots.outputRoot, path);
    const parent = dirname(path).replaceAll(sep, "/");
    if (parent !== ".") {
      await ensureDestinationDirectory(roots.outputRoot, parent);
    }
    await assertNoSymlinkComponents(roots.outputRoot, path, true);
    try {
      const targetDetails = await lstat(target);
      if (targetDetails.isSymbolicLink() || targetDetails.isDirectory()) {
        throw workspaceError(
          "UNSAFE_PATH",
          `Workspace output path is unsafe: ${path}`,
        );
      }
    } catch (error: unknown) {
      if (error instanceof ActionResolutionError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code !== "ENOENT"
      ) {
        throw workspaceError(
          "UNSAFE_PATH",
          `Workspace output path cannot be inspected: ${path}`,
          error,
        );
      }
    }
    await writeFile(target, contents, { flag: "w" });
  }
}

async function claimWorkspace(root: string, runId: string): Promise<void> {
  const ownerPath = `${resolve(root)}${ownerSuffix}`;
  try {
    const owner = (await readFile(ownerPath, "utf8")).trim();
    if (owner !== runId) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The agent workspace is owned by another run.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionResolutionError) throw error;
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The agent workspace owner cannot be checked.",
        error,
      );
    }
    try {
      await writeFile(ownerPath, `${runId}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (writeError: unknown) {
      throw workspaceError(
        "UNSAFE_PATH",
        "The agent workspace owner cannot be recorded.",
        writeError,
      );
    }
  }
}

export async function createOwnedAgentWorkspace(
  parentDirectory: string,
  prefix = ".seqlane-agent-",
): Promise<{ readonly path: string; readonly runId: string }> {
  const parent = await assertSafeRoot(
    parentDirectory,
    "Agent workspace parent",
  );
  const path = await mkdtemp(join(parent, prefix));
  const runId = randomUUID();
  await claimWorkspace(path, runId);
  return { path, runId };
}

export async function clearOwnedAgentWorkspace(
  agentRoot: string,
  runId: string,
): Promise<void> {
  const root = await assertSafeRoot(agentRoot, "Agent workspace");
  await claimWorkspace(root, runId);
  for (const entry of await readdir(root)) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

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

async function readWorkspaceChangePaths(
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
  await enforceLockfileInputLimits(safeSourceRoot, paths);
  for (const path of paths) {
    await validateLockfileInput(safeSourceRoot, path);
  }
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
  private integrationBaselinePaths: readonly ConflictPath[] = [];

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
    this.integrationBaselinePaths = await readWorkspaceChangePaths(this.git);
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

  async validateTarget(conflicts: ConflictSet): Promise<void> {
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
    ];
    await validateResolutionWorkspace(this.options.targetRoot, allowed);
  }
}
