import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const zeroSha = /^0+$/;

export function parsePrePushInput(input) {
  return input
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        throw new Error(`Invalid pre-push ref line: ${line}`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export function selectOutgoingRevision(refs, headRevision) {
  if (refs.length === 0) {
    return { kind: "verify", revision: headRevision };
  }

  if (refs.length > 1) {
    throw new Error(
      "Pre-push verification supports one branch update at a time.",
    );
  }

  const [update] = refs;
  if (zeroSha.test(update.localSha)) return { kind: "skip" };

  const revision = update.localSha;
  if (headRevision && revision !== headRevision) {
    throw new Error(
      `Outgoing revision ${revision} does not match current HEAD ${headRevision}.`,
    );
  }

  return { kind: "verify", revision };
}

export function nxAffectedArgs(target, base, head) {
  return [
    "exec",
    "nx",
    "affected",
    "-t",
    target,
    "--output-style=static",
    `--base=${base}`,
    `--head=${head}`,
  ];
}

export function cacheDirectories(worktreeRoot, temporaryRoot = tmpdir()) {
  const digest = createHash("sha256")
    .update(worktreeRoot)
    .digest("hex")
    .slice(0, 16);
  const root = join(temporaryRoot, `seqlane-nx-${digest}`);
  return {
    workspaceData: join(root, "workspace-data"),
    cache: join(root, "cache"),
  };
}

export function assertCleanWorktree(statusOutput) {
  if (statusOutput) {
    throw new Error(
      "Pre-push verification requires a clean worktree; commit or stash local changes first.",
    );
  }
}

export function cleanGitEnvironment(environment, gitEnvironmentVariables) {
  const cleanEnvironment = { ...environment };
  for (const variable of gitEnvironmentVariables) {
    delete cleanEnvironment[variable];
  }
  return cleanEnvironment;
}

export function useWorktreeNxDirectories(environment, directories) {
  return {
    ...environment,
    NX_WORKSPACE_DATA_DIRECTORY: directories.workspaceData,
    NX_CACHE_DIRECTORY: directories.cache,
  };
}

function captureGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        `git ${args.join(" ")} failed with status ${result.status}`,
    );
  }

  return result.stdout.trim();
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  return !result.error && result.status === 0;
}

function runPnpm(args, env) {
  console.log(`\n> pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Could not run pnpm: ${result.error.message}`);
    return false;
  }

  return result.status === 0;
}

function runBundleVerifier(args, env) {
  console.log(`\n> node scripts/action-bundle-verifier.mjs ${args.join(" ")}`);
  const result = spawnSync(
    process.execPath,
    ["scripts/action-bundle-verifier.mjs", ...args],
    {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
    },
  );
  return !result.error && result.status === 0;
}

function readHookInput() {
  if (process.stdin.isTTY) return Promise.resolve("");

  return new Promise((resolveInput, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolveInput(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const headRevision = captureGit(["rev-parse", "HEAD"]);
  const refs = parsePrePushInput(await readHookInput());
  const selection = selectOutgoingRevision(refs, headRevision);
  const worktreeRoot = captureGit(["rev-parse", "--show-toplevel"]);
  if (resolve(worktreeRoot) !== repositoryRoot) {
    throw new Error(
      `Worktree root mismatch: expected ${repositoryRoot}, got ${worktreeRoot}.`,
    );
  }

  assertCleanWorktree(captureGit(["status", "--porcelain=v1"]));

  if (selection.kind === "skip") {
    console.log("Skipping verification for ref deletion.");
    return 0;
  }

  const base =
    process.env.SEQLANE_VERIFY_BASE ??
    captureGit(["merge-base", "origin/main", selection.revision]);
  if (!runGit(["diff", "--check", `${base}..${selection.revision}`])) {
    throw new Error("Committed changes contain whitespace errors.");
  }

  const directories = cacheDirectories(worktreeRoot);
  mkdirSync(dirname(directories.workspaceData), { recursive: true });
  const gitEnvironmentVariables = captureGit(["rev-parse", "--local-env-vars"])
    .split(/\r?\n/)
    .filter(Boolean);
  const env = useWorktreeNxDirectories(
    cleanGitEnvironment(process.env, gitEnvironmentVariables),
    directories,
  );
  if (!existsSync(resolve(repositoryRoot, "node_modules"))) {
    throw new Error(
      "Dependencies are not installed in this worktree; run pnpm install --frozen-lockfile.",
    );
  }

  const checks = [
    [
      "formatting",
      [
        "exec",
        "nx",
        "format:check",
        `--base=${base}`,
        `--head=${selection.revision}`,
      ],
    ],
    ["SDLC validation", ["docs:validate"]],
    ["SDLC tests", ["docs:test"]],
    ["test mapping", ["test:mapping"]],
    ["workflow helper", ["test:workflow-helper"]],
    [
      "affected typecheck",
      nxAffectedArgs("typecheck", base, selection.revision),
    ],
    ["affected lint", nxAffectedArgs("lint", base, selection.revision)],
    ["affected tests", nxAffectedArgs("test", base, selection.revision)],
    ["affected build", nxAffectedArgs("build", base, selection.revision)],
  ];

  for (const [name, args] of checks) {
    console.log(`\n=== ${name} ===`);
    if (!runPnpm(args, env)) return 1;
  }

  console.log("\n=== Action bundle drift ===");
  if (!runBundleVerifier(["--drift"], env)) {
    return 1;
  }
  if (!runBundleVerifier(["--verify"], env)) return 1;

  console.log("\nPre-push verification passed.");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
