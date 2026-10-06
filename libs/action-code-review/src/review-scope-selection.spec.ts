// @test-scope ./review-scope-contracts.ts
import { describe, expect, it } from "vitest";
import { selectReviewScope } from "./review-scope-selection.js";
import {
  reviewScopeIdentitySchema,
  reviewScopePathSchema,
} from "./review-scope-contracts.js";

const common = {
  pullRequestNumber: 112,
  targetBranch: "release",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
};

describe("review scope selection", () => {
  it("selects the complete baseline and records nested exclusions", () => {
    const selected = selectReviewScope({ ...common, mode: "new-baseline" }, [
      "z.ts",
      "a.ts",
      "nested/pnpm-lock.yaml",
      "nested/dist/a.js",
      "dist.ts",
    ]);
    expect(selected.reviewablePaths).toEqual(["a.ts", "dist.ts", "z.ts"]);
    expect(selected.excludedPaths).toEqual([
      "nested/dist/a.js",
      "nested/pnpm-lock.yaml",
    ]);
  });

  it("intersects tree changes with current PR paths before exclusions", () => {
    const selected = selectReviewScope(
      {
        ...common,
        mode: "incremental",
        checkpointRevision: "c".repeat(40),
        reportId: "42",
      },
      ["old.ts", "new.ts", "pnpm-lock.yaml"],
      ["new.ts", "target-only.ts", "pnpm-lock.yaml"],
    );
    expect(selected.eligiblePaths).toEqual(["new.ts", "pnpm-lock.yaml"]);
    expect(selected.reviewablePaths).toEqual(["new.ts"]);
  });

  it("rejects changed paths in a declared no-change admission", () => {
    expect(() =>
      selectReviewScope(
        {
          ...common,
          mode: "no-change",
          checkpointRevision: "c".repeat(40),
          reportId: "42",
        },
        ["a.ts"],
        ["a.ts"],
      ),
    ).toThrow("No-change");
  });

  it("caps eligible paths before exclusions at 200", () => {
    const paths = Array.from(
      { length: 200 },
      (_, index) => `p${index}/pnpm-lock.yaml`,
    );
    expect(
      selectReviewScope({ ...common, mode: "new-baseline" }, paths)
        .eligiblePaths,
    ).toHaveLength(200);
    expect(() =>
      selectReviewScope({ ...common, mode: "new-baseline" }, [
        ...paths,
        "last.ts",
      ]),
    ).toThrow("eligiblePaths");
  });

  it.each([
    "",
    "/absolute",
    "../outside",
    "a/../b",
    "a/./b",
    "a//b",
    "a\0b",
    "C:/outside",
    "a\ud800",
    "é".repeat(257),
  ])("rejects unsafe or noncanonical path %j", (path) => {
    expect(reviewScopePathSchema.safeParse(path).success).toBe(false);
  });

  it.each([
    "space name.ts",
    "tab\tname.ts",
    "line\nname.ts",
    ":(glob)*.ts",
    "-flag.ts",
    "é".repeat(256),
  ])("preserves literal path %j", (path) => {
    expect(reviewScopePathSchema.parse(path)).toBe(path);
  });

  it("keeps legacy identity separate from a published current checkpoint", () => {
    const legacy = {
      ...common,
      mode: "legacy-replacement",
      reportId: "42",
      legacyMarker: { schemaVersion: 4, markerDigest: "d".repeat(64) },
    };
    expect(reviewScopeIdentitySchema.safeParse(legacy).success).toBe(true);
    expect(
      reviewScopeIdentitySchema.safeParse({
        ...legacy,
        checkpointRevision: "c".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      reviewScopeIdentitySchema.safeParse({
        ...common,
        mode: "incremental",
        schemaVersion: 4,
        reviewedRevision: "c".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      reviewScopeIdentitySchema.safeParse({
        ...common,
        mode: "new-baseline",
        checkpointRevision: "c".repeat(40),
      }).success,
    ).toBe(false);
  });
});
