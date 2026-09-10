import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const skillRoots = [".agents/skills", ".claude/skills", ".opencode/skills"];
const revisionPattern = /^[0-9a-f]{40,64}$/i;

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

function isUnchanged(target, baseRevision, headRevision, path) {
  try {
    git(target, ["diff", "--quiet", baseRevision, headRevision, "--", path], {
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
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
  return git(target, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    headRevision,
    "--",
    ...skillRoots,
  ])
    .split("\0")
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => ({
      relativePath: path.slice(0, -"/SKILL.md".length),
    }));
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

  const allowed = [];
  const denied = [];
  for (const skill of discover(target, headRevision)) {
    if (isUnchanged(target, baseRevision, headRevision, skill.relativePath)) {
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
  for (const skill of result.denied) {
    console.error(
      `[skill-policy] excluded ${JSON.stringify(skill.relativePath)}: changed from base revision`,
    );
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
