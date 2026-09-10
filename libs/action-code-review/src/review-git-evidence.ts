import { defineTask } from "@seqlane/core";
import {
  codeReviewInputSchema,
  gitReviewEvidenceOutputSchema,
  reviewHistoryOutputSchema,
} from "./review-contracts.js";

const MAX_GIT_TEXT_LENGTH = 8_000;
const MAX_PATCH_BYTES = 512_000;
const MAX_CHANGED_FILES_BYTES = 128_000;
const PATCH_EXCLUDED_PATHS = [
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/yarn.lock",
  ":(exclude,glob)**/bun.lock",
  ":(exclude,glob)**/bun.lockb",
  ":(exclude,glob)**/npm-shrinkwrap.json",
  ":(exclude,glob)**/Cargo.lock",
  ":(exclude,glob)**/Gemfile.lock",
  ":(exclude,glob)**/composer.lock",
  ":(exclude,glob)**/poetry.lock",
  ":(exclude,glob)**/Pipfile.lock",
  ":(exclude,glob)**/uv.lock",
  ":(exclude,glob)**/dist/**",
] as const;
const PATCH_TRUNCATION_MARKER =
  "\n[patch truncated; omitted hunks were not reviewed]\n";
const MAX_CHANGED_FILES = 200;
const MAX_CHANGED_FILE_LENGTH = 512;
function boundGitText(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  if (value.length <= MAX_GIT_TEXT_LENGTH) {
    return { value, truncated: false };
  }
  return {
    value: value.slice(0, MAX_GIT_TEXT_LENGTH - 1) + "…",
    truncated: true,
  };
}

function boundPatchOutput(value: string): {
  readonly value: string;
  readonly byteLength: number;
  readonly truncated: boolean;
} {
  const normalized = value.endsWith("\uFFFD") ? value.slice(0, -1) : value;
  const bytes = new TextEncoder().encode(normalized);
  const truncated = value.endsWith("\uFFFD") || bytes.length > MAX_PATCH_BYTES;
  const boundedBytes = bytes.subarray(0, MAX_PATCH_BYTES);
  let end = boundedBytes.length;
  if (truncated) {
    const lastNewline = boundedBytes.lastIndexOf(10, end - 1);
    end = lastNewline >= 0 ? lastNewline + 1 : 0;
  }

  return {
    value:
      new TextDecoder().decode(boundedBytes.subarray(0, end)) +
      (truncated ? PATCH_TRUNCATION_MARKER : ""),
    byteLength: truncated ? MAX_PATCH_BYTES + 1 : bytes.length,
    truncated,
  };
}

function boundCompleteGitLines(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const normalized = value.endsWith("\uFFFD") ? value.slice(0, -1) : value;
  const bytes = new TextEncoder().encode(normalized);
  const truncated = value.endsWith("\uFFFD") || bytes.length > maxBytes;
  if (!truncated) return { value: normalized, truncated: false };
  const boundedBytes = bytes.subarray(0, maxBytes);
  const lastNewline = boundedBytes.lastIndexOf(10, boundedBytes.length - 1);
  return {
    value:
      lastNewline < 0
        ? ""
        : new TextDecoder().decode(boundedBytes.subarray(0, lastNewline + 1)),
    truncated: true,
  };
}

const gitReviewEvidenceInputSchema = codeReviewInputSchema.extend({
  normalizedReviewHistory: reviewHistoryOutputSchema.optional(),
});

export const gitReviewEvidenceTask = defineTask({
  id: "pr-code-review.git-evidence",
  input: gitReviewEvidenceInputSchema,
  output: gitReviewEvidenceOutputSchema,
  execute: async ({
    input: { baseRevision, headRevision, normalizedReviewHistory },
    context: { exec },
  }) => {
    const previousReviewedRevision =
      normalizedReviewHistory?.previousReviewedRevision;
    const range = `${baseRevision}...${headRevision}`;
    const patchPathspecs = PATCH_EXCLUDED_PATHS.map((path) => `'${path}'`).join(
      " ",
    );
    const boundedPatchCommand = [
      "set -o pipefail",
      `git diff --no-ext-diff --no-textconv --no-color --patch --unified=10 ${range} -- . ${patchPathspecs} | head -c ${MAX_PATCH_BYTES + 1}`,
      "gitStatus=${PIPESTATUS[0]}",
      '[ "$gitStatus" -eq 0 ] || [ "$gitStatus" -eq 141 ]',
    ].join("; ");
    const boundedChangedFilesCommand = [
      "set -o pipefail",
      `git diff --no-ext-diff --no-textconv --name-status ${range} | head -c ${MAX_CHANGED_FILES_BYTES + 1}`,
      "gitStatus=${PIPESTATUS[0]}",
      '[ "$gitStatus" -eq 0 ] || [ "$gitStatus" -eq 141 ]',
    ].join("; ");
    const boundedStatCommand = [
      "set -o pipefail",
      `git diff --no-ext-diff --no-textconv --stat ${range} | head -c ${MAX_GIT_TEXT_LENGTH + 1}`,
      "gitStatus=${PIPESTATUS[0]}",
      '[ "$gitStatus" -eq 0 ] || [ "$gitStatus" -eq 141 ]',
    ].join("; ");
    const boundedCheckCommand = [
      "set -o pipefail",
      `git diff --no-ext-diff --no-textconv --check ${range} | head -c ${MAX_GIT_TEXT_LENGTH + 1}`,
      "gitStatus=${PIPESTATUS[0]}",
      'exit "$gitStatus"',
    ].join("; ");
    const [head, base, changed, stat, patch, check] = await Promise.all([
      exec({ executable: "git", argv: ["rev-parse", "--verify", "HEAD"] }),
      exec({
        executable: "git",
        argv: ["cat-file", "-e", `${baseRevision}^{commit}`],
      }),
      exec({
        executable: "bash",
        argv: ["-c", boundedChangedFilesCommand],
      }),
      exec({
        executable: "bash",
        argv: ["-c", boundedStatCommand],
      }),
      exec({
        executable: "bash",
        argv: ["-c", boundedPatchCommand],
      }),
      exec({
        executable: "bash",
        argv: ["-c", boundedCheckCommand],
      }),
    ]);

    if (head.exitCode !== 0 || head.stdout.trim() !== headRevision) {
      throw new Error("Git HEAD does not match the requested head revision");
    }
    if (base.exitCode !== 0) {
      throw new Error("The requested base revision is not available");
    }
    if (changed.exitCode !== 0 || stat.exitCode !== 0 || patch.exitCode !== 0) {
      throw new Error("Git could not inspect the requested review range");
    }

    const changedEvidence = boundCompleteGitLines(
      changed.stdout,
      MAX_CHANGED_FILES_BYTES,
    );
    const allChangedFiles = [
      ...new Set(
        changedEvidence.value
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .flatMap((line) => line.split("\t").slice(1)),
      ),
    ];
    const changedFiles = allChangedFiles
      .filter((file) => file.length <= MAX_CHANGED_FILE_LENGTH)
      .slice(0, MAX_CHANGED_FILES);
    const diffStat = boundGitText(stat.stdout);
    const patchEvidence = boundPatchOutput(patch.stdout);
    const diffCheckStdout = boundGitText(check.stdout);
    const diffCheckStderr = boundGitText(check.stderr);
    const previousRevisionComparable =
      previousReviewedRevision === undefined
        ? false
        : (
            await exec({
              executable: "git",
              argv: [
                "merge-base",
                "--is-ancestor",
                previousReviewedRevision,
                headRevision,
              ],
            })
          ).exitCode === 0;

    return {
      baseRevision,
      headRevision,
      changedFiles,
      changedFileCount: allChangedFiles.length,
      changedFilesTruncated:
        changedEvidence.truncated ||
        changedFiles.length !== allChangedFiles.length,
      diffStat: diffStat.value,
      diffStatTruncated: diffStat.truncated,
      patch: patchEvidence.value,
      patchByteLength: patchEvidence.byteLength,
      patchTruncated: patchEvidence.truncated,
      diffCheck: {
        exitCode: check.exitCode,
        stdout: diffCheckStdout.value,
        stderr: diffCheckStderr.value,
        stdoutTruncated: diffCheckStdout.truncated,
        stderrTruncated: diffCheckStderr.truncated,
      },
      ...(previousReviewedRevision === undefined
        ? {}
        : { previousReviewedRevision }),
      previousRevisionComparable,
    };
  },
});
