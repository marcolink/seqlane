// @test-scope ./contracts.ts
import { describe, expect, it } from "vitest";
import { reviewTargetInputSchema } from "./contracts.js";

describe("code-review Action contracts", () => {
  it("rejects unbounded or malformed Action input", () => {
    expect(reviewTargetInputSchema.safeParse({}).success).toBe(false);
    expect(reviewTargetInputSchema.safeParse({ repository: "owner/repo", pullRequestNumber: 1, reviewTarget: "/tmp/review", baseBranch: "main", baseRevision: "x", headRevision: "y", runtime: "not-url" }).success).toBe(false);
  });
});
