import { type ConflictPath, type ConflictSet } from "./contracts.js";
import { ActionResolutionError } from "./errors.js";
import { NodeGitCli } from "./git-cli.js";
import { type GitWorkspacePort } from "./git-port.js";
import { uniqueConflictPaths } from "./git-port.js";

export const conflictMarkerPattern =
  /^(?:<{7,}(?: .*)?|\|{7,}(?: .*)?|={7,}|>{7,}(?: .*)?)\r?$/m;

export function containsConflictMarker(content: string): boolean {
  return conflictMarkerPattern.test(content);
}

function pathsFrom(
  value: readonly ConflictPath[] | ConflictSet,
): readonly ConflictPath[] {
  const paths: ConflictPath[] = [];
  const conflicts: ConflictSet = [];
  for (const entry of value) {
    if (typeof entry === "string") paths.push(entry);
    else conflicts.push(entry);
  }
  return conflicts.length > 0 ? uniqueConflictPaths(conflicts) : paths;
}

export async function validateStagedConflictMarkers(
  targetRoot: string,
  paths: readonly ConflictPath[] | ConflictSet,
  git: GitWorkspacePort = new NodeGitCli(targetRoot),
): Promise<void> {
  for (const path of pathsFrom(paths)) {
    const staged = await git.run(["show", "--format=", `:${path}`]);
    if (staged.exitCode === 128) continue;
    if (staged.exitCode !== 0) {
      throw new ActionResolutionError(
        "validation",
        "OPERATION_FAILED",
        "The staged conflict file could not be read.",
        staged,
      );
    }
    if (containsConflictMarker(staged.stdout)) {
      throw new ActionResolutionError(
        "validation",
        "CONFLICT_MARKER_REMAINS",
        `Conflict marker remains in ${path}.`,
      );
    }
  }

  const whitespace = await git.run(["diff", "--cached", "--check"]);
  if (whitespace.exitCode !== 0) {
    throw new ActionResolutionError(
      "validation",
      "STAGED_WHITESPACE_ERROR",
      "The staged resolution contains whitespace errors.",
      whitespace,
    );
  }
}

export async function validateStagedWhitespaceAndMarkers(
  git: GitWorkspacePort,
  paths: readonly ConflictPath[] | ConflictSet,
): Promise<void> {
  await validateStagedConflictMarkers(git.cwd, paths, git);
}
