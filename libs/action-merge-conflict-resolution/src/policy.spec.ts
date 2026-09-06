// @test-scope ./policy.ts
// @test-scope ./errors.ts

import { describe, expect, it } from "vitest";
import {
  assertAttemptAllowed,
  classifyConflicts,
  canCommit,
  canPush,
  isAttemptAllowed,
  mutationPermissions,
  parseActionInputs,
  parsePullRequestMetadata,
  terminalOutcome,
  validatePullRequestPreflight,
} from "./policy.js";
import { ActionResolutionError } from "./errors.js";

const metadata = {
  number: 42,
  state: "open" as const,
  baseBranch: "main",
  headBranch: "feature/conflicts",
  baseRevision: "a".repeat(40),
  headRevision: "b".repeat(40),
  baseRepository: { owner: "org", name: "repo" },
  headRepository: { owner: "org", name: "repo" },
};

describe("action merge-conflict policies", () => {
  it("maps validated action inputs to the application request", () => {
    expect(
      parseActionInputs({
        pullRequestNumber: "42",
        resolutionStrategy: "merge",
        sourceDirectory: ".",
        targetDirectory: "resolution-target",
        commit: "true",
        push: "false",
        maxAttempts: "3",
      }),
    ).toEqual({
      pullRequestNumber: 42,
      strategy: "merge",
      sourceDirectory: ".",
      targetDirectory: "resolution-target",
      commit: true,
      push: false,
      maxAttempts: 3,
    });
  });

  it("wraps malformed action input with a typed error and cause", () => {
    try {
      parseActionInputs({ pullRequestNumber: "not-a-number" });
      expect.fail("Expected input validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ActionResolutionError);
      expect((error as ActionResolutionError).category).toBe(
        "input-validation",
      );
      expect((error as ActionResolutionError).code).toBe(
        "INVALID_ACTION_INPUT",
      );
      expect((error as ActionResolutionError).cause).toBeDefined();
    }
  });

  it("rejects closed and fork pull requests", () => {
    expect(() =>
      parsePullRequestMetadata({ ...metadata, baseRevision: "bad" }),
    ).toThrowError(
      expect.objectContaining({
        category: "pull-request-preflight",
        code: "MALFORMED_PULL_REQUEST",
      }),
    );
    expect(() =>
      validatePullRequestPreflight(
        { ...metadata, state: "closed" },
        metadata.baseRepository,
      ),
    ).toThrowError(ActionResolutionError);
    expect(() =>
      validatePullRequestPreflight(
        {
          ...metadata,
          headRepository: { owner: "someone-else", name: "repo" },
        },
        metadata.baseRepository,
      ),
    ).toThrowError(ActionResolutionError);
    expect(() =>
      validatePullRequestPreflight(metadata, { owner: "org" }),
    ).toThrowError(expect.objectContaining({ code: "MALFORMED_PULL_REQUEST" }));
  });

  it("classifies lockfile conflicts separately, including an empty set", () => {
    expect(classifyConflicts([])).toEqual({ agent: [], lockfile: [] });
    expect(
      classifyConflicts([
        { path: "src/index.ts", stage: 2 },
        { path: "pnpm-lock.yaml", stage: 1 },
      ]),
    ).toEqual({
      agent: [{ path: "src/index.ts", stage: 2 }],
      lockfile: [{ path: "pnpm-lock.yaml", stage: 1 }],
    });
    expect(() =>
      classifyConflicts(
        Array.from({ length: 201 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          stage: 2 as const,
        })),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONFLICT_SET_REQUIRED" }));
  });

  it("enforces the default attempt limit and reports a stable failure", () => {
    expect(isAttemptAllowed(0)).toBe(true);
    expect(isAttemptAllowed(9)).toBe(true);
    expect(isAttemptAllowed(10)).toBe(false);
    expect(() => assertAttemptAllowed(10)).toThrowError(
      expect.objectContaining({
        category: "attempt-limit",
        code: "ATTEMPT_LIMIT_EXCEEDED",
      }),
    );
  });

  it("keeps commit and push permissions explicit and independent", () => {
    const permissions = mutationPermissions({ commit: true, push: false });
    expect(permissions).toEqual({ commit: true, push: false });
    expect(canCommit({ commit: true })).toBe(true);
    expect(canPush({ push: false })).toBe(false);
    expect(terminalOutcome("resolved", permissions)).toEqual({
      result: "updated",
      shouldCommit: true,
      shouldPush: false,
    });
    expect(terminalOutcome("clean", { commit: true, push: true })).toEqual({
      result: "no-change",
      shouldCommit: false,
      shouldPush: false,
    });
  });
});
