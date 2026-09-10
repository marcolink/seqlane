import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Stages base-revision copies of repository skills for the privileged review.
 * The code-review workflow calls this before OpenCode starts; only skills that
 * are unchanged from the pull request base are made visible to that process.
 */
const skillRoots = [".agents/skills", ".claude/skills", ".opencode/skills"];
const revisionPattern = /^[0-9a-f]{40,64}$/i;
const MAX_DISCOVERED_SKILLS = 128;
const MAX_CHANGED_PATHS = 4096;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_VOLUME = 256 * 1024;
const MAX_DIAGNOSTIC_SAMPLES = 16;

function revision(value, name) {
  if (value === undefined || !revisionPattern.test(value)) {
    throw new Error(`${name} must be a full Git revision`);
  }
  return value;
}

function git(target, args, options = {}) {
  return execFileSync("git", ["-C", target, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function assertRevision(target, value, name) {
  const resolved = git(target, [
    "rev-parse",
    "--verify",
    `${value}^{commit}`,
  ]).trim();
  if (resolved.length === 0) throw new Error(`${name} is not a commit`);
}

function stageFromBase(target, baseRevision, stagingDirectory, path) {
  const archive = execFileSync("git", [
    "-C",
    target,
    "archive",
    baseRevision,
    "--",
    path,
  ]);
  execFileSync("tar", ["-x", "-f", "-", "-C", stagingDirectory], {
    input: archive,
    stdio: ["pipe", "ignore", "pipe"],
  });
}

function discover(target, headRevision) {
  const paths = git(target, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    headRevision,
    "--",
    ...skillRoots,
  ])
    .split("\0")
    .filter((path) => path.length > 0 && path.endsWith("/SKILL.md"));
  assertPathBounds(paths, "discovered skill paths");
  if (paths.length > MAX_DISCOVERED_SKILLS) {
    throw new Error(
      `discovered skill count exceeds limit of ${MAX_DISCOVERED_SKILLS}`,
    );
  }
  return paths.map((path) => ({
    relativePath: path.slice(0, -"/SKILL.md".length),
  }));
}

function changedPaths(target, baseRevision, headRevision) {
  const paths = git(target, [
    "diff",
    "--name-only",
    "-z",
    baseRevision,
    headRevision,
    "--",
    ...skillRoots,
  ])
    .split("\0")
    .filter((path) => path.length > 0);
  assertPathBounds(paths, "changed skill paths");
  if (paths.length > MAX_CHANGED_PATHS) {
    throw new Error(
      `changed skill path count exceeds limit of ${MAX_CHANGED_PATHS}`,
    );
  }
  return paths;
}

function assertPathBounds(paths, label) {
  let volume = 0;
  for (const path of paths) {
    if (path.length > MAX_PATH_LENGTH) {
      throw new Error(
        `${label} contain a path longer than ${MAX_PATH_LENGTH} characters`,
      );
    }
    volume += Buffer.byteLength(path) + 1;
    if (volume > MAX_PATH_VOLUME) {
      throw new Error(
        `${label} exceed the ${MAX_PATH_VOLUME}-byte volume limit`,
      );
    }
  }
}

function isChanged(changed, skillPath) {
  return changed.some(
    (path) => path === skillPath || path.startsWith(`${skillPath}/`),
  );
}

export function formatDeniedSkillDiagnostics(denied) {
  return `[skill-policy] excluded ${JSON.stringify({
    count: denied.length,
    samplePaths: denied
      .slice(0, MAX_DIAGNOSTIC_SAMPLES)
      .map(({ relativePath }) => relativePath),
  })}: changed from base revision`;
}

export function resolveCodeReviewSkills({
  reviewTarget,
  baseRevision: rawBaseRevision,
  headRevision: rawHeadRevision,
  stagingDirectory,
}) {
  const target = resolve(reviewTarget);
  const baseRevision = revision(rawBaseRevision, "baseRevision");
  const headRevision = revision(rawHeadRevision, "headRevision");
  const staging = resolve(stagingDirectory);

  assertRevision(target, baseRevision, "baseRevision");
  assertRevision(target, headRevision, "headRevision");
  if (git(target, ["rev-parse", "HEAD"]).trim() !== headRevision) {
    throw new Error("review target is not checked out at headRevision");
  }

  rmSync(staging, { recursive: true, force: true });
  for (const root of skillRoots)
    mkdirSync(resolve(staging, root), { recursive: true });

  const changed = changedPaths(target, baseRevision, headRevision);
  const allowed = [];
  const denied = [];
  for (const skill of discover(target, headRevision)) {
    if (!isChanged(changed, skill.relativePath)) {
      stageFromBase(target, baseRevision, staging, skill.relativePath);
      allowed.push(skill);
    } else {
      denied.push(skill);
    }
  }

  return {
    allowed,
    denied,
  };
}

function main() {
  const result = resolveCodeReviewSkills({
    reviewTarget: process.env.REVIEW_TARGET,
    baseRevision: process.env.BASE_REVISION,
    headRevision: process.env.HEAD_REVISION,
    stagingDirectory: process.env.SKILL_STAGING_DIR,
  });
  console.log(`allowed_count=${result.allowed.length}`);
  console.log(`denied_count=${result.denied.length}`);
  if (result.denied.length > 0)
    console.error(formatDeniedSkillDiagnostics(result.denied));
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
