import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDeniedSkillDiagnostics,
  resolveCodeReviewSkills,
} from "./resolve-code-review-skills.mjs";

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function skill(directory, path, content) {
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

test("stages only skills unchanged from the base revision", () => {
  const repository = mkdtempSync(join(tmpdir(), "seqlane-review-skills-"));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  skill(repository, ".agents/skills/base/SKILL.md", "base");
  skill(repository, ".agents/skills/nested/base/SKILL.md", "nested base");
  skill(repository, ".claude/skills/changed/SKILL.md", "old");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const base = git(repository, "rev-parse", "HEAD");

  skill(repository, ".claude/skills/changed/SKILL.md", "new");
  skill(repository, ".opencode/skills/new/SKILL.md", "new skill");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "head");
  const head = git(repository, "rev-parse", "HEAD");
  skill(repository, ".agents/skills/untracked/SKILL.md", "untracked");

  const staging = join(repository, "staging");
  const result = resolveCodeReviewSkills({
    reviewTarget: repository,
    baseRevision: base,
    headRevision: head,
    stagingDirectory: staging,
  });

  assert.deepEqual(
    result.allowed.map(({ relativePath }) => relativePath),
    [".agents/skills/base", ".agents/skills/nested/base"],
  );
  assert.deepEqual(
    result.denied.map(({ relativePath }) => relativePath),
    [".claude/skills/changed", ".opencode/skills/new"],
  );
  assert.equal(
    readFileSync(join(staging, ".agents/skills/base/SKILL.md"), "utf8"),
    "base",
  );
  assert.equal(
    readFileSync(join(staging, ".agents/skills/nested/base/SKILL.md"), "utf8"),
    "nested base",
  );
  assert.equal(
    existsSync(join(staging, ".claude/skills/changed/SKILL.md")),
    false,
  );
  assert.equal(
    existsSync(join(staging, ".opencode/skills/new/SKILL.md")),
    false,
  );
});

test("keeps project configuration disabled and permits only staged skills", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/seqlane-code-review.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /OPENCODE_DISABLE_PROJECT_CONFIG: "true"/);
  assert.match(workflow, /OPENCODE_DISABLE_EXTERNAL_SKILLS: "true"/);
  assert.match(workflow, /"skills"\s*:\s*\{\s*"paths"\s*:\s*\[/s);
  assert.match(workflow, /"skill"\s*:\s*"allow"/);
  assert.match(workflow, /"bash"\s*:\s*"deny"/);
  assert.match(workflow, /"external_directory"\s*:\s*"deny"/);
});

test("fails closed when skill discovery exceeds its bounded path limits", () => {
  const repository = mkdtempSync(join(tmpdir(), "seqlane-review-skills-"));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  for (let index = 0; index < 129; index += 1)
    skill(repository, `.agents/skills/skill-${index}/SKILL.md`, "skill");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const revision = git(repository, "rev-parse", "HEAD");

  assert.throws(
    () =>
      resolveCodeReviewSkills({
        reviewTarget: repository,
        baseRevision: revision,
        headRevision: revision,
        stagingDirectory: join(repository, "staging"),
      }),
    /discovered skill count exceeds limit of 128/,
  );
});

test("fails closed when a skill path exceeds the path-length limit", () => {
  const repository = mkdtempSync(join(tmpdir(), "seqlane-review-skills-"));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  const longPath = [
    ".agents/skills",
    ...Array.from({ length: 26 }, () => "long-skill-directory"),
  ].join("/");
  skill(repository, `${longPath}/SKILL.md`, "skill");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "base");
  const revision = git(repository, "rev-parse", "HEAD");

  assert.throws(
    () =>
      resolveCodeReviewSkills({
        reviewTarget: repository,
        baseRevision: revision,
        headRevision: revision,
        stagingDirectory: join(repository, "staging"),
      }),
    /path longer than 512 characters/,
  );
});

test("keeps denied-skill diagnostics to one bounded summary", () => {
  const diagnostic = formatDeniedSkillDiagnostics(
    Array.from({ length: 20 }, (_, index) => ({
      relativePath: `.agents/skills/skill-${index}`,
    })),
  );

  assert.match(diagnostic, /"count":20/);
  assert.equal((diagnostic.match(/skill-\d/g) ?? []).length, 16);
});
