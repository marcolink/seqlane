import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  NodeGitCli,
  maximumAgentFileBytes,
  maximumAgentTotalBytes,
  maximumLockfileInputFiles,
  maximumLockfileInputFileBytes,
  maximumLockfileInputTotalBytes,
  prepareAgentWorkspace as prepareAgentWorkspaceFiles,
  prepareLockfileWorkspace as prepareLockfileWorkspaceFiles,
  copyAgentEdits as copyAgentEditsFiles,
  readNullDelimitedPaths,
  validateResolutionWorkspace as validateResolutionWorkspaceFiles,
  validateStagedConflictMarkers as validateStagedConflictMarkersFiles,
} from "@seqlane/action-merge-conflict-resolution";

export {
  maximumAgentFileBytes,
  maximumAgentTotalBytes,
  maximumLockfileInputFiles,
  maximumLockfileInputFileBytes,
  maximumLockfileInputTotalBytes,
  readNullDelimitedPaths,
};

async function readPathsFile(path: string): Promise<string[]> {
  return readNullDelimitedPaths(await readFile(path, "utf8"));
}

export async function prepareAgentWorkspace(
  sourceRoot: string,
  agentRoot: string,
  conflictFileList: string,
): Promise<void> {
  await prepareAgentWorkspaceFiles(
    sourceRoot,
    agentRoot,
    await readPathsFile(conflictFileList),
    randomUUID(),
  );
}

export async function copyAgentEdits(
  agentRoot: string,
  targetRoot: string,
  conflictFileList: string,
): Promise<void> {
  await copyAgentEditsFiles(
    agentRoot,
    targetRoot,
    await readPathsFile(conflictFileList),
  );
}

export async function prepareLockfileWorkspace(
  sourceRoot: string,
  lockfileRoot: string,
): Promise<void> {
  await prepareLockfileWorkspaceFiles(
    sourceRoot,
    lockfileRoot,
    new NodeGitCli(sourceRoot),
  );
}

export async function validateResolutionWorkspace(
  targetRoot: string,
  conflictFileList: string,
): Promise<void> {
  await validateResolutionWorkspaceFiles(
    targetRoot,
    await readPathsFile(conflictFileList),
    new NodeGitCli(targetRoot),
  );
}

export async function validateStagedConflictMarkers(
  targetRoot: string,
  conflictFileList: string,
): Promise<void> {
  await validateStagedConflictMarkersFiles(
    targetRoot,
    await readPathsFile(conflictFileList),
    new NodeGitCli(targetRoot),
  );
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArguments] = args;
  switch (command) {
    case "prepare-agent": {
      if (commandArguments.length !== 3) usage();
      await prepareAgentWorkspace(
        requiredArgument(commandArguments, 0),
        requiredArgument(commandArguments, 1),
        requiredArgument(commandArguments, 2),
      );
      return;
    }
    case "copy-agent": {
      if (commandArguments.length !== 3) usage();
      await copyAgentEdits(
        requiredArgument(commandArguments, 0),
        requiredArgument(commandArguments, 1),
        requiredArgument(commandArguments, 2),
      );
      return;
    }
    case "prepare-lockfile": {
      if (commandArguments.length !== 2) usage();
      await prepareLockfileWorkspace(
        requiredArgument(commandArguments, 0),
        requiredArgument(commandArguments, 1),
      );
      return;
    }
    case "validate-workspace": {
      if (commandArguments.length !== 2) usage();
      await validateResolutionWorkspace(
        requiredArgument(commandArguments, 0),
        requiredArgument(commandArguments, 1),
      );
      return;
    }
    case "validate-markers": {
      if (commandArguments.length !== 2) usage();
      await validateStagedConflictMarkers(
        requiredArgument(commandArguments, 0),
        requiredArgument(commandArguments, 1),
      );
      return;
    }
    default:
      usage();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
