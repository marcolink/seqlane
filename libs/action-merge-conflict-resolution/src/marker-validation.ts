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

async function readStagedConflictContent(
  git: GitWorkspacePort,
  paths: readonly ConflictPath[],
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const index = await git.run(["ls-files", "--stage", "-z", "--", ...paths]);
  if (index.exitCode !== 0) return index;
  const stagedPaths = index.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const tabIndex = entry.indexOf("\t");
      const stage = entry.slice(0, tabIndex).split(" ")[2];
      return tabIndex >= 0 && stage === "0" ? [entry.slice(tabIndex + 1)] : [];
    });
  if (stagedPaths.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  return git.run([
    "show",
    "--format=",
    "--no-ext-diff",
    ...stagedPaths.map((path) => `:${path}`),
  ]);
}

export async function validateStagedConflictMarkers(
  targetRoot: string,
  paths: readonly ConflictPath[] | ConflictSet,
  git: GitWorkspacePort = new NodeGitCli(targetRoot),
): Promise<void> {
  const conflictPaths = pathsFrom(paths);
  const staged = await readStagedConflictContent(git, conflictPaths);
  if (staged.exitCode !== 0) {
    throw new ActionResolutionError(
      "validation",
      "OPERATION_FAILED",
      "The staged conflict files could not be read.",
      staged,
    );
  }
  if (containsConflictMarker(staged.stdout)) {
    throw new ActionResolutionError(
      "validation",
      "CONFLICT_MARKER_REMAINS",
      `Conflict marker remains in the staged conflict set: ${conflictPaths.join(", ")}.`,
    );
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
