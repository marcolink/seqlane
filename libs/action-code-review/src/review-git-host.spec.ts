// @test-scope ./review-git-host.ts
// @test-scope ./review-git-supervisor.ts
// @test-scope ./review-git-supervisor-source.ts
// @test-scope ./review-git-supervisor-cleanup.ts
// @test-scope ./review-git-host-preflight.ts
// @test-scope ./review-git-host-fetch.ts
// @test-scope ./review-git-transport.ts
// @test-scope ./review-git-host-admission.ts
// @test-scope ./review-scope-admission.ts
import { describe, expect, it } from "vitest";
import { createReviewGitHost } from "./review-git-host.js";
import { verifyReviewGitHost } from "./review-git-host.linux.test-support.js";

describe("production review Git host", () => {
  it("returns a typed setup failure for malformed host options", async () => {
    await expect(
      createReviewGitHost({ reviewTarget: "relative", cgroupRoot: "/groups" }),
    ).rejects.toMatchObject({ code: "GIT_HOST_SETUP_FAILED" });
  });
  it.skipIf(process.platform === "linux")(
    "fails closed on unsupported hosts",
    async () => {
      await expect(
        createReviewGitHost({ reviewTarget: "/repo", cgroupRoot: "/groups" }),
      ).rejects.toMatchObject({ code: "GIT_HOST_UNSUPPORTED" });
    },
  );
  it.skipIf(process.env.SEQLANE_REVIEW_CGROUP_ROOT === undefined)(
    "proves resource enforcement and v5 admission with real Git",
    async () => {
      expect(
        (
          await verifyReviewGitHost(
            process.env.SEQLANE_REVIEW_CGROUP_ROOT ?? "",
          )
        ).status,
      ).toBe("verified");
    },
    30_000,
  );
});
