import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  conflictPathSchema,
  type ConflictPath,
  type ConflictSet,
} from "./contracts.js";
import {
  ActionResolutionError,
  formatWorkspaceLimitDiagnostic,
} from "./errors.js";

const ownerSuffix = ".seqlane-agent-workspace-owner";

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

type BeforeCopy = (path: ConflictPath) => Promise<void>;

interface PreparedCopyFile {
  readonly path: ConflictPath;
  readonly contents: Buffer;
}

export function workspaceError(
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

export function asPaths(
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

export async function assertSafeRoot(
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

export async function copyFiles(
  roots: WorkspacePaths,
  paths: readonly ConflictPath[],
  limits: CopyLimits,
  beforeCopy?: BeforeCopy,
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

  const files = await prepareCopyFiles(
    roots.sourceRoot,
    paths,
    limits,
    beforeCopy,
  );

  for (const { path, contents } of files) {
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

async function prepareCopyFiles(
  sourceRoot: string,
  paths: readonly ConflictPath[],
  limits: CopyLimits,
  beforeCopy?: BeforeCopy,
): Promise<readonly PreparedCopyFile[]> {
  let totalBytes = 0;
  const files: PreparedCopyFile[] = [];
  for (const path of paths) {
    const source = await regularFile(sourceRoot, path);
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
            aggregate: {
              offendingFileBytes: details.size,
              accumulatedBytes: totalBytes,
            },
          },
        ),
      );
    }

    if (beforeCopy !== undefined) await beforeCopy(path);
    const contents = await readFile(source);
    if (limits.rejectBinary && contents.includes(0)) {
      throw workspaceError(
        "UNSUPPORTED_AGENT_FILE",
        `Binary conflict file is not supported: ${path}`,
      );
    }
    totalBytes += details.size;
    files.push({ path, contents });
  }
  return files;
}

export async function claimWorkspace(
  root: string,
  runId: string,
): Promise<void> {
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
