// @test-scope ./review-scope-admission.ts
import { describe, expect, it } from "vitest";
import { createReviewGitAdapter } from "./review-git-adapter.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { admitReviewScope } from "./review-scope-admission.js";
import { reviewGitResultSchema } from "./review-git-budget.js";

describe("native review Git adapter", () => {
  it("types invalid configuration and unavailable checkout failures", async () => {
    expect(() =>
      createReviewGitAdapter({ reviewTarget: "relative" }),
    ).toThrowError(
      expect.objectContaining({ code: "GIT_CONFIGURATION_INVALID" }),
    );
    await expect(
      createReviewGitAdapter({ reviewTarget: "/missing-seqlane-checkout" }).run(
        {
          argv: ["--no-replace-objects", "rev-parse", "--verify", "HEAD"],
          limits: { wallMs: 3000, outputBytes: 100 },
        },
      ),
    ).rejects.toMatchObject({ code: "GIT_HOST_FAILED" });
  });
  it("produces complete baseline admission through the existing entry point", async () => {
    const fixture = await createReviewGitFixture();
    try {
      await fixture.write("first.ts", "export const value = 1;\n");
      const baseRevision = await fixture.commit();
      await fixture.write("first.ts", "export const value = 2;\n");
      const headRevision = await fixture.commit();
      const admission = await admitReviewScope(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision,
            headRevision,
          },
        },
        {
          git: fixture.git,
          authority: {
            listIssueComments: async () => ({ items: [], hasNextPage: false }),
          },
        },
      );
      expect(admission.evidence.reviewablePaths).toEqual(["first.ts"]);
      expect(admission.evidence.batches[0]?.patch).toContain(
        "+export const value = 2;",
      );
    } finally {
      await fixture.dispose();
    }
  });
  it("rejects malformed requests and honors the operation signal", async () => {
    const fixture = await createReviewGitFixture();
    const git = createReviewGitAdapter({ reviewTarget: fixture.cwd });
    const request = {
      argv: [
        "--no-replace-objects",
        "rev-parse",
        "--show-object-format=storage",
      ],
      limits: { wallMs: 3000, outputBytes: 100 },
    };
    try {
      expect(reviewGitResultSchema.parse(await git.run(request)).exitCode).toBe(
        0,
      );
      await expect(
        git.run({ ...request, limits: { ...request.limits, wallMs: 0 } }),
      ).rejects.toMatchObject({ code: "GIT_REQUEST_INVALID" });
      await expect(
        git.run({ ...request, signal: AbortSignal.abort("stopped") }),
      ).rejects.toMatchObject({
        code: "REVIEW_SCOPE_CANCELLED",
        cause: "stopped",
      });
    } finally {
      await fixture.dispose();
    }
  });
});
