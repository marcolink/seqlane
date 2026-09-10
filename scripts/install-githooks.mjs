import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        `git ${args.join(" ")} failed with status ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function optionalGitValue(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const hooksDirectory = resolve(repositoryRoot, ".githooks");
if (!existsSync(hooksDirectory)) {
  throw new Error(`Missing hooks directory: ${hooksDirectory}`);
}

const worktreeRoot = resolve(runGit(["rev-parse", "--show-toplevel"]));
if (worktreeRoot !== repositoryRoot) {
  throw new Error(
    `Worktree root mismatch: expected ${repositoryRoot}, got ${worktreeRoot}.`,
  );
}

if (
  optionalGitValue(["config", "--get", "extensions.worktreeConfig"]) !== "true"
) {
  runGit(["config", "extensions.worktreeConfig", "true"]);
}
runGit(["config", "--worktree", "core.hooksPath", ".githooks"]);
console.log(`Installed native Git hooks for ${repositoryRoot}.`);
