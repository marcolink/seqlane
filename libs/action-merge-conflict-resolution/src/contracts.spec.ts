// @test-scope ./contracts.ts

import { describe, expect, it } from "vitest";
import {
  actionInputsSchema,
  conflictSetSchema,
  gitRevisionSchema,
  positiveIntegerSchema,
  positiveIntegerStringSchema,
  pullRequestMetadataSchema,
  resolveMergeConflictsRequestSchema,
  resolveMergeConflictsResultSchema,
  terminalOutcomeSchema,
} from "./contracts.js";

const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);

describe("action merge-conflict contracts", () => {
  it("accepts action inputs and applies safe defaults", () => {
    expect(actionInputsSchema.parse({ pullRequestNumber: "42" })).toMatchObject(
      {
        pullRequestNumber: "42",
        resolutionStrategy: "rebase",
        sourceDirectory: ".",
        targetDirectory: "resolution-target",
        commit: "false",
        push: "false",
        maxAttempts: "10",
      },
    );
  });

  it("rejects malformed strategies, revisions, paths, and input values", () => {
    expect(positiveIntegerSchema.safeParse(0).success).toBe(false);
    expect(positiveIntegerSchema.safeParse(1).success).toBe(true);
    expect(positiveIntegerStringSchema.safeParse("01").success).toBe(false);
    expect(positiveIntegerStringSchema.safeParse("1").success).toBe(true);
    expect(
      actionInputsSchema.safeParse({
        pullRequestNumber: "0",
        resolutionStrategy: "squash",
      }).success,
    ).toBe(false);
    expect(gitRevisionSchema.safeParse("a".repeat(39)).success).toBe(false);
    expect(gitRevisionSchema.safeParse("A".repeat(40)).success).toBe(true);
    expect(
      actionInputsSchema.safeParse({
        pullRequestNumber: "1",
        sourceDirectory: "../trusted",
      }).success,
    ).toBe(false);
    expect(
      resolveMergeConflictsRequestSchema.safeParse({
        pullRequestNumber: 1,
        strategy: "merge",
        sourceDirectory: ".",
        targetDirectory: "target",
        commit: "true",
        push: false,
        maxAttempts: 10,
      }).success,
    ).toBe(false);
  });

  it("validates pull-request metadata and conflict index stages", () => {
    expect(
      pullRequestMetadataSchema.safeParse({
        number: 42,
        state: "open",
        baseBranch: "main",
        headBranch: "feature/conflicts",
        baseRevision,
        headRevision,
        baseRepository: { owner: "org", name: "repo" },
        headRepository: { owner: "org", name: "repo" },
      }).success,
    ).toBe(true);
    expect(
      conflictSetSchema.safeParse([
        { path: "src/index.ts", stage: 1 },
        { path: "src/index.ts", stage: 2 },
        { path: "src/index.ts", stage: 3 },
      ]).success,
    ).toBe(true);
    expect(
      conflictSetSchema.safeParse([{ path: "pnpm-lock.yaml", stage: 0 }])
        .success,
    ).toBe(false);
    expect(
      conflictSetSchema.safeParse(
        Array.from({ length: 201 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          stage: 1,
        })),
      ).success,
    ).toBe(false);
  });

  it("allows an empty conflict set and validates terminal result unions", () => {
    expect(conflictSetSchema.parse([])).toEqual([]);
    expect(
      terminalOutcomeSchema.safeParse({
        result: "updated",
        shouldCommit: true,
        shouldPush: false,
      }).success,
    ).toBe(true);
    expect(
      resolveMergeConflictsResultSchema.safeParse({
        kind: "resolved",
        result: "updated",
        strategy: "rebase",
        baseSha: baseRevision,
        headSha: headRevision,
        attempts: 1,
        pushed: false,
      }).success,
    ).toBe(true);
    expect(
      resolveMergeConflictsResultSchema.safeParse({
        kind: "resolved",
        result: "no-change",
        strategy: "rebase",
        baseSha: baseRevision,
        headSha: headRevision,
        attempts: 1,
        pushed: false,
      }).success,
    ).toBe(false);
  });
});
