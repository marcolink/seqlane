import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const prettierExtensions =
  /\.(?:cjs|css|html|js|json|jsonc|jsx|mjs|md|mdx|mts|sh|ts|tsx|yaml|yml)$/i;
const eslintExtensions = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i;

export function stagedPathsFromGitOutput(output) {
  return output.split("\0").filter(Boolean);
}

export function isPrettierPath(path) {
  return prettierExtensions.test(path);
}

export function eslintPaths(paths) {
  return paths.filter((path) => eslintExtensions.test(path));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    return false;
  }

  if (result.status !== 0) {
    return false;
  }

  return true;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ?? `${command} exited with status ${result.status}`,
    );
  }

  return result.stdout;
}

export function main() {
  if (!run("git", ["diff", "--cached", "--check"])) return 1;

  const paths = stagedPathsFromGitOutput(
    capture("git", [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=ACMR",
    ]),
  );
  const prettierPaths = paths.filter(isPrettierPath);
  const javascriptPaths = eslintPaths(paths);

  if (prettierPaths.length === 0 && javascriptPaths.length === 0) {
    console.log("Staged checks passed (no formatted source files).");
    return 0;
  }

  if (!existsSync(resolve(repositoryRoot, "node_modules"))) {
    console.error(
      "Dependencies are not installed in this worktree; run pnpm install --frozen-lockfile.",
    );
    return 1;
  }

  if (
    prettierPaths.length > 0 &&
    !run("pnpm", ["exec", "prettier", "--check", ...prettierPaths])
  ) {
    return 1;
  }

  if (
    javascriptPaths.length > 0 &&
    !run("pnpm", ["exec", "eslint", ...javascriptPaths])
  ) {
    return 1;
  }

  console.log("Staged checks passed.");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
