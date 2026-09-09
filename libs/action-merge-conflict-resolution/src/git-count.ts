import type { GitRevision } from "./contracts.js";
import { gitCommandError, type GitCommandResult } from "./git-port.js";

export async function readRebaseCommitCount(
  requiredCommand: (args: readonly string[]) => Promise<GitCommandResult>,
  baseRevision: GitRevision,
): Promise<number> {
  const result = await requiredCommand([
    "rev-list",
    "--count",
    `${baseRevision}..HEAD`,
  ]);
  const count = result.stdout.trim();
  if (!/^\d+$/.test(count)) {
    throw gitCommandError(
      "GIT_OUTPUT_MALFORMED",
      "Git returned a malformed rebase commit count.",
      result,
    );
  }
  const parsed = Number(count);
  if (!Number.isSafeInteger(parsed)) {
    throw gitCommandError(
      "GIT_OUTPUT_MALFORMED",
      "Git returned an unsafe rebase commit count.",
      result,
    );
  }
  return parsed;
}
