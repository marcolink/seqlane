import {
  access,
  mkdir,
  readFile,
  realpath,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  reviewGitHostOptionsSchema,
  type ReviewGitHostOptions,
} from "./review-git-host-policy.js";
import { ReviewScopeError } from "./review-scope-errors.js";
import { REVIEW_GIT_LIMITS } from "./review-scope-contracts.js";

export function requireReviewGitActive(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ReviewScopeError(
      "REVIEW_SCOPE_CANCELLED",
      "Review Git work was cancelled.",
      signal.reason,
    );
}

/** Probe delegated controls before any target Git operation. */
export async function prepareReviewGitHost(value: ReviewGitHostOptions) {
  try {
    const options = reviewGitHostOptionsSchema.parse(value);
    requireReviewGitActive(options.signal);
    if (
      process.platform !== "linux" ||
      !["x64", "arm64"].includes(process.arch)
    )
      throw new ReviewScopeError(
        "GIT_HOST_UNSUPPORTED",
        "The bounded Git host requires Linux x64 or arm64 with cgroup v2.",
      );
    const cwd = await realpath(options.reviewTarget);
    const cgroupRoot = await realpath(options.cgroupRoot);
    const enabled = (
      await readFile(join(cgroupRoot, "cgroup.subtree_control"), "utf8")
    )
      .trim()
      .split(/\s+/);
    if (["cpu", "memory", "pids"].some((name) => !enabled.includes(name)))
      throw new ReviewScopeError(
        "GIT_HOST_UNSUPPORTED",
        "The Git host requires delegated cpu, memory, and pids controllers.",
      );
    requireReviewGitActive(options.signal);
    const group = join(cgroupRoot, `seqlane-${randomUUID()}`);
    await mkdir(group);
    try {
      for (const [name, control] of Object.entries({
        "cpu.max": "1000 1000",
        "memory.max": String(REVIEW_GIT_LIMITS.peakMemoryBytes),
        "memory.swap.max": "0",
        "memory.oom.group": "1",
        "pids.max": "128",
      }))
        await writeFile(join(group, name), control);
      for (const name of [
        "cpu.stat",
        "memory.peak",
        "memory.events",
        "cgroup.events",
        "cgroup.kill",
        "cgroup.procs",
      ])
        await access(join(group, name));
    } finally {
      await rmdir(group);
    }
    await access("/usr/bin/git");
    await access("/usr/bin/python3");
    requireReviewGitActive(options.signal);
    return { options, cwd, cgroupRoot };
  } catch (cause) {
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "GIT_HOST_SETUP_FAILED",
      "The bounded Git host could not establish its required controls.",
      cause,
    );
  }
}
