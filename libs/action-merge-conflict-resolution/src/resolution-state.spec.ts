// @test-scope ./resolution-state.ts
// @test-scope ./errors.ts

import { describe, expect, it } from "vitest";
import {
  initialResolutionState,
  isTerminalResolutionState,
  transitionResolutionState,
} from "./resolution-state.js";

const conflicts = [{ path: "src/index.ts", stage: 2 as const }];

describe("resolution attempt state", () => {
  it("models clean integration as terminal no-change", () => {
    let state = initialResolutionState("merge", 10);
    state = transitionResolutionState(state, { type: "integration-started" });
    state = transitionResolutionState(state, { type: "integration-clean" });

    expect(state).toMatchObject({
      phase: "completed",
      outcome: "no-change",
      attempts: 0,
    });
    expect(isTerminalResolutionState(state)).toBe(true);
  });

  it("models a conflicted integration, successful continuation, and completion", () => {
    let state = initialResolutionState("rebase", 10);
    state = transitionResolutionState(state, { type: "integration-started" });
    state = transitionResolutionState(state, {
      type: "integration-conflicted",
      conflicts,
    });
    state = transitionResolutionState(state, { type: "attempt-started" });
    state = transitionResolutionState(state, { type: "agent-prepared" });
    state = transitionResolutionState(state, {
      type: "resolution-completed",
    });
    state = transitionResolutionState(state, { type: "validation-passed" });
    state = transitionResolutionState(state, {
      type: "continued",
      conflicts: [],
    });
    state = transitionResolutionState(state, {
      type: "completed",
      outcome: "updated",
    });

    expect(state).toMatchObject({
      phase: "completed",
      outcome: "updated",
      attempts: 1,
    });
  });

  it("models an empty-commit skip and enforces the attempt limit", () => {
    let state = initialResolutionState("rebase", 1);
    state = transitionResolutionState(state, { type: "integration-started" });
    state = transitionResolutionState(state, {
      type: "integration-conflicted",
      conflicts,
    });
    state = transitionResolutionState(state, { type: "attempt-started" });
    state = transitionResolutionState(state, { type: "agent-prepared" });
    state = transitionResolutionState(state, {
      type: "resolution-completed",
    });
    state = transitionResolutionState(state, { type: "validation-passed" });
    state = transitionResolutionState(state, { type: "empty-commit-skipped" });

    expect(state).toMatchObject({ phase: "conflicted", attempts: 1 });
    state = transitionResolutionState(state, {
      type: "failed",
      error: {
        category: "attempt-limit",
        code: "ATTEMPT_LIMIT_EXCEEDED",
      },
    });
    expect(state).toMatchObject({
      phase: "failed",
      failure: {
        category: "attempt-limit",
        code: "ATTEMPT_LIMIT_EXCEEDED",
      },
    });
    expect(isTerminalResolutionState(state)).toBe(true);
  });

  it("turns an attempt started at the limit into a terminal failure", () => {
    let state = initialResolutionState("rebase", 1);
    state = transitionResolutionState(state, { type: "integration-started" });
    state = transitionResolutionState(state, {
      type: "integration-conflicted",
      conflicts,
    });
    state = transitionResolutionState(state, { type: "attempt-started" });
    state = transitionResolutionState(state, { type: "agent-prepared" });
    state = transitionResolutionState(state, {
      type: "resolution-completed",
    });
    state = transitionResolutionState(state, { type: "validation-passed" });
    state = transitionResolutionState(state, {
      type: "continued",
      conflicts,
    });

    state = transitionResolutionState(state, { type: "attempt-started" });

    expect(state).toMatchObject({
      phase: "failed",
      attempts: 1,
      failure: {
        category: "attempt-limit",
        code: "ATTEMPT_LIMIT_EXCEEDED",
      },
    });
  });
});
