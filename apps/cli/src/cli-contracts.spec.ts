// @test-scope ./cli-contracts.ts
// @test-scope ./command.ts

import { describe, expect, it } from "vitest";
import { runCommandResultSchema } from "./cli-contracts.js";
import { contextualizeCommandError, serializeCommandError } from "./command.js";
import { remoteError, runTiming } from "./run-result.js";

const timing = {
  startedAt: "2026-09-15T13:27:14.816Z",
  finishedAt: "2026-09-15T13:27:15.816Z",
  durationMs: 1_000,
};

const identity = {
  workflow: { id: "repository:review", reference: "repository:review" },
  workId: "work-1",
  runId: "run-1",
  ...timing,
};

describe("RunCommandResult", () => {
  it.each([null, false, 0])("preserves false-like output %j", (output) => {
    const result = runCommandResultSchema.parse({
      schemaVersion: 1,
      status: "succeeded",
      ...identity,
      output,
    });

    expect(result).toMatchObject({ status: "succeeded", output });
  });

  it("requires the fields for cancellation and failure variants", () => {
    expect(() =>
      runCommandResultSchema.parse({
        schemaVersion: 1,
        status: "cancelled",
        ...identity,
      }),
    ).toThrow();
    expect(() =>
      runCommandResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        phase: "execution",
        error: { category: "RuntimeError", message: "failed" },
        output: false,
      }),
    ).toThrow();
  });

  it("accepts a command failure before run identity exists", () => {
    expect(
      runCommandResultSchema.parse({
        schemaVersion: 1,
        status: "failed",
        phase: "command",
        error: { category: "RuntimeError", message: "invalid input" },
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "failed",
      phase: "command",
      error: { category: "RuntimeError", message: "invalid input" },
    });
  });

  it("preserves canonical serialized error details", () => {
    const error = {
      category: "ValidationError" as const,
      message: "output is invalid",
      validation: {
        validationNodeId: "check-output",
        sourceId: "task-output",
        issues: [
          {
            code: "invalid_type" as const,
            path: "answer",
            message: "Expected string",
          },
        ],
        evidence: { state: "present", value: { answer: 42 } },
      },
    };

    expect(serializeCommandError(error)).toEqual(error);
    expect(
      serializeCommandError(
        contextualizeCommandError("Could not execute workflow", error),
      ),
    ).toMatchObject({
      category: error.category,
      validation: error.validation,
    });
  });

  it("rejects malformed runtime timing and error metadata", () => {
    expect(() => runTiming("not-a-timestamp", timing.finishedAt)).toThrow();

    const malformed = remoteError({
      message: "remote failure",
      category: "not-a-category",
      suggestions: [42],
    });
    expect(malformed.message).toBe("remote failure");
    expect("category" in malformed).toBe(false);
    expect("suggestions" in malformed).toBe(false);
  });
});
