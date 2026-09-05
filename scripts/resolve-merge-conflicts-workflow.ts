import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

export const maximumAgentFileBytes = 512 * 1024;
export const maximumAgentTotalBytes = 2 * 1024 * 1024;
export const maximumLockfileInputFiles = 64;
export const maximumLockfileInputFileBytes = 512 * 1024;
export const maximumLockfileInputTotalBytes = 2 * 1024 * 1024;

const conflictMarker =
  /^(?:<{7,}(?: .*)?|\|{7,}(?: .*)?|={7,}|>{7,}(?: .*)?)\r?$/m;

export function readNullDelimitedPaths(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function safePath(root: string, path: string): string {
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Unsafe conflict path: ${path}`);
  }
  return candidate;
}

function regularFile(root: string, path: string): string {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is not allowed: ${path}`);
    }
  }
  if (!lstatSync(current).isFile()) {
    throw new Error(`Conflict path is not a regular file: ${path}`);
  }
  return current;
}

function clearDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Agent workspace is not a regular directory.");
  }
  for (const entry of readdirSync(path)) {
    rmSync(join(path, entry), { recursive: true, force: true });
  }
}

function copyFiles(
  sourceRoot: string,
  outputRoot: string,
  paths: string[],
  limits: {
    maximumFileBytes: number;
    maximumTotalBytes: number;
    maximumFiles?: number;
    rejectBinary?: boolean;
  },
): void {
  if (limits.maximumFiles !== undefined && paths.length > limits.maximumFiles) {
    throw new Error(
      `The workspace input contains too many files: ${paths.length} > ${limits.maximumFiles}.`,
    );
  }

  let totalBytes = 0;
  for (const path of paths) {
    const source = regularFile(sourceRoot, path);
    const size = statSync(source).size;
    if (
      size > limits.maximumFileBytes ||
      totalBytes + size > limits.maximumTotalBytes
    ) {
      throw new Error(
        `Conflict payload exceeds the configured size limit: ${path}`,
      );
    }

    const contents = readFileSync(source);
    if (limits.rejectBinary && contents.includes(0)) {
      throw new Error(`Binary conflict file is not supported: ${path}`);
    }
    totalBytes += size;

    const target = safePath(outputRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

export function prepareAgentWorkspace(
  sourceRoot: string,
  agentRoot: string,
  conflictFileList: string,
): void {
  clearDirectory(agentRoot);
  copyFiles(sourceRoot, agentRoot, readNullDelimitedPaths(conflictFileList), {
    maximumFileBytes: maximumAgentFileBytes,
    maximumTotalBytes: maximumAgentTotalBytes,
    rejectBinary: true,
  });
}

export function copyAgentEdits(
  agentRoot: string,
  targetRoot: string,
  conflictFileList: string,
): void {
  copyFiles(agentRoot, targetRoot, readNullDelimitedPaths(conflictFileList), {
    maximumFileBytes: maximumAgentFileBytes,
    maximumTotalBytes: maximumAgentTotalBytes,
    rejectBinary: true,
  });
}

export function prepareLockfileWorkspace(
  sourceRoot: string,
  lockfileRoot: string,
): void {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--", "pnpm-workspace.yaml", ":(glob)**/package.json"],
    { cwd: sourceRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);

  copyFiles(sourceRoot, lockfileRoot, paths, {
    maximumFileBytes: maximumLockfileInputFileBytes,
    maximumTotalBytes: maximumLockfileInputTotalBytes,
    maximumFiles: maximumLockfileInputFiles,
  });
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function validateResolutionWorkspace(
  targetRoot: string,
  conflictFileList: string,
): void {
  const allowed = new Set(readNullDelimitedPaths(conflictFileList));
  const changed = gitOutput(targetRoot, ["diff", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected edited paths: ${unexpected.join(", ")}`);
  }

  const untracked = [
    ...gitOutput(targetRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).split("\0"),
    ...gitOutput(targetRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]).split("\0"),
  ].filter(Boolean);
  if (untracked.length > 0) {
    throw new Error(`Unexpected untracked paths: ${untracked.join(", ")}`);
  }
}

export function validateStagedConflictMarkers(
  targetRoot: string,
  conflictFileList: string,
): void {
  for (const path of readNullDelimitedPaths(conflictFileList)) {
    try {
      const content = gitOutput(targetRoot, ["show", `:${path}`]);
      if (conflictMarker.test(content)) {
        throw new Error(`Conflict marker remains in ${path}.`);
      }
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 128
      ) {
        continue;
      }
      throw error;
    }
  }
}

function usage(): never {
  throw new Error(
    "Usage: resolve-merge-conflicts-workflow.ts <prepare-agent|copy-agent|prepare-lockfile|validate-workspace|validate-markers> ...",
  );
}

function requiredArgument(args: string[], index: number): string {
  const argument = args[index];
  if (argument === undefined || argument.length === 0) usage();
  return argument;
}

export function main(args = process.argv.slice(2)): void {
  const [command, ...commandArguments] = args;
  switch (command) {
    case "prepare-agent": {
      if (commandArguments.length !== 3) usage();
      const sourceRoot = requiredArgument(commandArguments, 0);
      const agentRoot = requiredArgument(commandArguments, 1);
      const conflictFileList = requiredArgument(commandArguments, 2);
      prepareAgentWorkspace(sourceRoot, agentRoot, conflictFileList);
      return;
    }
    case "copy-agent": {
      if (commandArguments.length !== 3) usage();
      const agentRoot = requiredArgument(commandArguments, 0);
      const targetRoot = requiredArgument(commandArguments, 1);
      const conflictFileList = requiredArgument(commandArguments, 2);
      copyAgentEdits(agentRoot, targetRoot, conflictFileList);
      return;
    }
    case "prepare-lockfile": {
      if (commandArguments.length !== 2) usage();
      const sourceRoot = requiredArgument(commandArguments, 0);
      const lockfileRoot = requiredArgument(commandArguments, 1);
      prepareLockfileWorkspace(sourceRoot, lockfileRoot);
      return;
    }
    case "validate-workspace": {
      if (commandArguments.length !== 2) usage();
      const targetRoot = requiredArgument(commandArguments, 0);
      const conflictFileList = requiredArgument(commandArguments, 1);
      validateResolutionWorkspace(targetRoot, conflictFileList);
      return;
    }
    case "validate-markers": {
      if (commandArguments.length !== 2) usage();
      const targetRoot = requiredArgument(commandArguments, 0);
      const conflictFileList = requiredArgument(commandArguments, 1);
      validateStagedConflictMarkers(targetRoot, conflictFileList);
      return;
    }
    default:
      usage();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
