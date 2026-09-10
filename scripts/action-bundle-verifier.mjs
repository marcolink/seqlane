import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
function normalizedPath(path) {
  return path.replaceAll("\\", "/");
}

function relativePath(root, path) {
  return normalizedPath(relative(root, path));
}

function targetOutputPaths(projectRoot, target) {
  const outputDirectories = new Set();
  const outputs = target.outputs ?? [];
  for (const output of outputs) {
    const expanded = output
      .replaceAll("{projectRoot}", projectRoot)
      .replaceAll("{workspaceRoot}", ".");
    if (expanded.endsWith(".js")) outputDirectories.add(dirname(expanded));
    else outputDirectories.add(expanded);
  }

  if (target.options?.outputPath) {
    outputDirectories.add(
      target.options.outputPath
        .replaceAll("{projectRoot}", projectRoot)
        .replaceAll("{workspaceRoot}", "."),
    );
  }

  const fileNames = new Set();
  if (target.options?.outputFileName) {
    fileNames.add(basename(target.options.outputFileName));
  }

  const command = target.options?.command;
  if (typeof command === "string") {
    for (const match of command.matchAll(
      /--outfile(?:=|\s+)(?:\\?["'])?([^\\"'\s]+)(?:\\?["'])?/g,
    )) {
      fileNames.add(basename(match[1]));
    }
  }

  if (outputDirectories.size === 0 || fileNames.size === 0) {
    throw new Error(
      `Cannot derive Action bundle outputs for target ${projectRoot}:${
        target.name ?? "unknown"
      } from project metadata.`,
    );
  }

  return [...outputDirectories].flatMap((directory) =>
    [...fileNames].map((fileName) => normalizedPath(join(directory, fileName))),
  );
}

export function discoverActionBundles(root = repositoryRoot) {
  const actionsRoot = join(root, "actions");
  if (!existsSync(actionsRoot)) return [];

  return readdirSync(actionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const projectRoot = normalizedPath(join("actions", entry.name));
      const projectFile = join(root, projectRoot, "project.json");
      if (!existsSync(projectFile)) return null;

      const project = JSON.parse(readFileSync(projectFile, "utf8"));
      const targets = {};
      for (const targetName of ["build", "build-post"]) {
        const target = project.targets?.[targetName];
        if (!target) continue;
        targets[targetName] = {
          outputPaths: targetOutputPaths(projectRoot, {
            ...target,
            name: targetName,
          }),
        };
      }

      if (!targets.build) return null;
      return { name: project.name ?? entry.name, projectRoot, targets };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function actionBundleDriftArgs(base, head) {
  return [
    "exec",
    "nx",
    "affected",
    "-t",
    "bundle-drift",
    "--output-style=static",
    "--skip-nx-cache",
    `--base=${base}`,
    `--head=${head}`,
  ];
}

export function bundleVerificationIssues({
  expectedPaths,
  existingPaths,
  trackedPaths,
  changedPaths,
}) {
  const expected = new Set(expectedPaths);
  const existing = new Set(existingPaths);
  const tracked = new Set(trackedPaths);

  return {
    missing: expectedPaths.filter((path) => !existing.has(path)),
    untracked: existingPaths.filter((path) => !tracked.has(path)),
    extra: existingPaths.filter((path) => !expected.has(path)),
    changed: changedPaths.filter((path) => expected.has(path)),
  };
}

function captureGit(args, root) {
  const result = spawnSync("git", args, {
    cwd: root,
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

function allFiles(root, directory) {
  const absoluteDirectory = resolve(root, directory);
  if (!existsSync(absoluteDirectory)) return [];

  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const path = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) files.push(...allFiles(root, path));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(relativePath(root, path));
    }
  }
  return files;
}

export function inspectActionBundles(root = repositoryRoot) {
  const bundles = discoverActionBundles(root);
  const expectedPaths = bundles.flatMap((bundle) =>
    Object.values(bundle.targets).flatMap((target) => target.outputPaths),
  );
  const outputDirectories = [
    ...new Set(expectedPaths.map((path) => dirname(path))),
  ];
  const existingPaths = outputDirectories.flatMap((directory) =>
    allFiles(root, directory),
  );
  const trackedPaths = captureGit(
    ["ls-files", "--", ...outputDirectories],
    root,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const changedPaths = captureGit(
    ["diff", "--name-only", "--", ...outputDirectories],
    root,
  )
    .split(/\r?\n/)
    .filter(Boolean);

  return {
    bundles,
    ...bundleVerificationIssues({
      expectedPaths,
      existingPaths,
      trackedPaths,
      changedPaths,
    }),
  };
}

export function formatBundleVerificationIssues(issues) {
  const lines = [];
  for (const [kind, paths] of Object.entries(issues)) {
    if (paths.length === 0) continue;
    lines.push(`${kind}:`);
    for (const path of paths) lines.push(`- ${path}`);
  }
  return lines.join("\n");
}

function runPnpm(args) {
  console.log(`\n> pnpm ${args.join(" ")}`);
  const result = spawnSync("pnpm", args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  return !result.error && result.status === 0;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) {
    throw new Error(`Missing ${name} value.`);
  }
  return args[index + 1];
}

function verify() {
  const inspection = inspectActionBundles();
  const issues = { ...inspection };
  delete issues.bundles;
  const issueText = formatBundleVerificationIssues(issues);
  if (issueText) {
    console.error(`Generated Action bundles are invalid:\n${issueText}`);
    return 1;
  }
  console.log("Committed Action bundles are present, tracked, and clean.");
  return 0;
}

function main(args) {
  if (args.includes("--drift")) {
    return runPnpm(
      actionBundleDriftArgs(
        argumentValue(args, "--base"),
        argumentValue(args, "--head"),
      ),
    )
      ? 0
      : 1;
  }
  if (args.includes("--verify")) return verify();
  throw new Error("Expected one of --drift or --verify.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
