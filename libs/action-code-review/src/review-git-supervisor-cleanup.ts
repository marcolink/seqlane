import { readFile, rmdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { z } from "zod";
import { ReviewScopeError } from "./review-scope-errors.js";

const missingFileSchema = z.object({ code: z.literal("ENOENT") });

/** Parent fallback: a failed trusted supervisor must not strand its workload. */
export async function removeReviewGitGroup(group: string): Promise<void> {
  try {
    await writeFile(join(group, "cgroup.kill"), "1");
    const deadline = performance.now() + 5000;
    while (
      !(await readFile(join(group, "cgroup.events"), "utf8"))
        .split("\n")
        .includes("populated 0")
    ) {
      if (performance.now() >= deadline)
        throw new ReviewScopeError(
          "GIT_SUPERVISOR_CLEANUP",
          "Git descendants did not exit before the cleanup deadline.",
        );
      await delay(10);
    }
    await rmdir(group);
  } catch (cause) {
    if (missingFileSchema.safeParse(cause).success) return; // Normal supervisor cleanup already removed it.
    if (cause instanceof ReviewScopeError) throw cause;
    throw new ReviewScopeError(
      "GIT_SUPERVISOR_CLEANUP",
      "The owned Git cgroup could not be cleaned.",
      cause,
    );
  }
}
