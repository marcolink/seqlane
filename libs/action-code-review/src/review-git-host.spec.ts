// @test-scope ./review-git-host-admission.ts
// @test-scope ./review-scope-admission.ts
import { describe, expect, it } from "vitest";
import { createReviewGitHost } from "./review-git-host.js";
import { createReviewGitFixture } from "./review-git-fixture.test-support.js";
import { admitReviewScopeWithGitHost } from "./review-git-host-admission.js";
import { reviewGitResultSchema } from "./review-git-budget.js";

describe("native review Git host", () => {
  it("returns typed failures for malformed options and unavailable checkouts", async () => {
    for (const reviewTarget of ["relative", "/missing-seqlane-checkout"])
      await expect(createReviewGitHost({ reviewTarget })).rejects.toMatchObject(
        { code: "GIT_HOST_SETUP_FAILED" },
      );
  });
  it("produces complete baseline admission through real Git", async () => {
    const fixture = await createReviewGitFixture();
    try {
      await fixture.write("first.ts", "export const value = 1;\n");
      const baseRevision = await fixture.commit();
      await fixture.write("first.ts", "export const value = 2;\n");
      const headRevision = await fixture.commit();
      const admission = await admitReviewScopeWithGitHost(
        {
          pullRequest: {
            repositoryId: "1",
            pullRequestNumber: 112,
            targetBranch: "release",
            baseRevision,
            headRevision,
          },
        },
        { reviewTarget: fixture.cwd },
        () => ({
          listIssueComments: async () => ({ items: [], hasNextPage: false }),
        }),
      );
      expect(admission.evidence.reviewablePaths).toEqual(["first.ts"]);
      expect(admission.evidence.batches[0]?.patch).toContain(
        "+export const value = 2;",
      );
    } finally {
      await fixture.dispose();
    }
  });
  it("rejects invalid requests and cancellation after close", async () => {
    const fixture = await createReviewGitFixture();
    const host = await createReviewGitHost({ reviewTarget: fixture.cwd });
    const request = {
      argv: [
        "--no-replace-objects",
        "rev-parse",
        "--show-object-format=storage",
      ],
      limits: { wallMs: 3000, outputBytes: 100 },
    };
    try {
      expect(
        reviewGitResultSchema.parse(await host.git.run(request)).exitCode,
      ).toBe(0);
      await expect(
        host.git.run({ ...request, limits: { ...request.limits, wallMs: 0 } }),
      ).rejects.toMatchObject({ code: "GIT_HOST_REQUEST" });
      await host.close();
      await expect(host.git.run(request)).rejects.toMatchObject({
        code: "REVIEW_SCOPE_CANCELLED",
      });
    } finally {
      await host.close();
      await fixture.dispose();
    }
  });
});
