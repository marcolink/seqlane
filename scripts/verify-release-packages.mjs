import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryUrl = "git+https://github.com/marcolink/seqlane.git";
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?$/;
const excludedArchivePath =
  /(?:^|\/)(?:__tests__|tests?\/)|\.(?:spec|test)\.[^/]+$|\.tsbuildinfo$/;

export const expectedReleases = new Map([
  ["adapter", "@seqlane/agent-adapter"],
  ["cli", "seqlane"],
  ["codex-adapter", "@seqlane/codex-adapter"],
  ["core", "@seqlane/core"],
  ["opencode", "@seqlane/opencode-adapter"],
  ["protocol", "@seqlane/protocol"],
  ["runtime", "@seqlane/runtime"],
  ["tui", "@seqlane/tui"],
]);

const expectedProjects = [...expectedReleases.keys()];
const expectedPackages = new Set(expectedReleases.values());

function fail(message) {
  throw new Error(message);
}

function capture(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      ...options,
    }).trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    fail(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

function captureJson(command, args) {
  return JSON.parse(capture(command, args));
}

function productionDependencies(manifest) {
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
}

export function validateProjectSet(label, actualProjects) {
  const actual = [...actualProjects].sort();
  if (
    actual.length !== expectedProjects.length ||
    actual.some((project, index) => project !== expectedProjects[index])
  ) {
    fail(`${label} must contain exactly: ${expectedProjects.join(", ")}`);
  }
}

export function validateSourceManifest(project, projectRoot, manifest) {
  const expectedName = expectedReleases.get(project);
  if (manifest.name !== expectedName) {
    fail(`${project} has unexpected package name ${String(manifest.name)}`);
  }
  if (
    typeof manifest.version !== "string" ||
    !versionPattern.test(manifest.version) ||
    manifest.version === "0.0.0"
  ) {
    fail(`${expectedName} has invalid release version ${manifest.version}`);
  }
  if (
    manifest.private === true ||
    manifest.license !== "Apache-2.0" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== repositoryUrl ||
    manifest.repository?.directory !== projectRoot ||
    manifest.engines?.node !== ">=24.0.0" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.provenance !== true
  ) {
    fail(`${expectedName} has invalid public package metadata`);
  }

  for (const [dependency, version] of Object.entries(
    productionDependencies(manifest),
  )) {
    if (!dependency.startsWith("@seqlane/")) continue;
    if (!expectedPackages.has(dependency)) {
      fail(
        `${expectedName} depends on private workspace package ${dependency}`,
      );
    }
    if (version !== "workspace:*") {
      fail(`${expectedName} must use workspace:* for ${dependency}`);
    }
  }

  return manifest.version;
}

export function validateArchiveEntries(packageName, entries) {
  if (!entries.includes("package/LICENSE")) {
    fail(`${packageName} archive does not contain LICENSE`);
  }
  const excludedPath = entries.find((entry) => excludedArchivePath.test(entry));
  if (excludedPath) {
    fail(`${packageName} archive contains excluded file ${excludedPath}`);
  }
}

export function validatePackedManifest(packageName, releaseVersion, manifest) {
  if (manifest.name !== packageName || manifest.version !== releaseVersion) {
    fail(`${packageName} archive metadata does not match ${releaseVersion}`);
  }

  for (const [dependency, version] of Object.entries(
    productionDependencies(manifest),
  )) {
    if (typeof version === "string" && version.startsWith("workspace:")) {
      fail(
        `${packageName} archive contains workspace dependency ${dependency}`,
      );
    }
    if (!dependency.startsWith("@seqlane/")) continue;
    if (!expectedPackages.has(dependency)) {
      fail(
        `${packageName} archive depends on unpublished package ${dependency}`,
      );
    }
    if (version !== releaseVersion) {
      fail(
        `${packageName} archive has ${dependency}@${version}; expected ${releaseVersion}`,
      );
    }
  }
}

function verifyReleaseProject(
  project,
  packageName,
  outputDirectory,
  expectedVersion,
) {
  const projectConfiguration = captureJson("pnpm", [
    "exec",
    "nx",
    "show",
    "project",
    project,
    "--json",
  ]);
  const projectRoot = projectConfiguration.root;
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, projectRoot, "package.json"), "utf8"),
  );
  const packageVersion = validateSourceManifest(project, projectRoot, manifest);
  if (expectedVersion && packageVersion !== expectedVersion) {
    fail(
      `${packageName} has version ${packageVersion}; expected ${expectedVersion}`,
    );
  }
  const releaseVersion = expectedVersion ?? packageVersion;

  const archive = join(outputDirectory, `${project}.tgz`);
  capture("pnpm", ["--dir", projectRoot, "pack", "--json", "--out", archive]);
  const entries = capture("tar", ["-tzf", archive]).split("\n");
  validateArchiveEntries(packageName, entries);
  const packedManifest = JSON.parse(
    capture("tar", ["-xOf", archive, "package/package.json"]),
  );
  validatePackedManifest(packageName, releaseVersion, packedManifest);
  return releaseVersion;
}

export function main() {
  validateProjectSet(
    "The release:npm tag",
    captureJson("pnpm", [
      "exec",
      "nx",
      "show",
      "projects",
      "--projects=tag:release:npm",
      "--json",
    ]),
  );
  validateProjectSet(
    "The nx-release-publish target",
    captureJson("pnpm", [
      "exec",
      "nx",
      "show",
      "projects",
      "--with-target=nx-release-publish",
      "--json",
    ]),
  );

  const outputDirectory = resolve(repositoryRoot, ".nx/release-validation");
  mkdirSync(outputDirectory, { recursive: true });
  let releaseVersion;

  for (const [project, packageName] of expectedReleases) {
    releaseVersion = verifyReleaseProject(
      project,
      packageName,
      outputDirectory,
      releaseVersion,
    );
  }

  console.log(
    `Verified ${expectedReleases.size} release packages at ${releaseVersion}.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
