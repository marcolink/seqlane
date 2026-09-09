// @test-scope ./contracts.ts
import { describe, expect, it } from "vitest";
import { repositorySchema, reviewTargetInputSchema } from "./contracts.js";

describe("code-review Action contracts", () => {
  it("rejects unbounded or malformed Action input", () => {
    expect(reviewTargetInputSchema.safeParse({}).success).toBe(false);
    expect(
      reviewTargetInputSchema.safeParse({
        repository: "owner/repo",
        pullRequestNumber: 1,
        reviewTarget: "/tmp/review",
        baseBranch: "main",
        baseRevision: "x",
        headRevision: "y",
        runtime: "not-url",
      }).success,
    ).toBe(false);
  });

  it("normalizes a repository with exactly one owner/name separator", () => {
    expect(repositorySchema.parse("octo/repo")).toEqual({
      owner: "octo",
      repo: "repo",
    });
    expect(repositorySchema.safeParse("octo/repo/extra").success).toBe(false);
    expect(repositorySchema.safeParse("/repo").success).toBe(false);
  });
});
