// @test-scope ./agent-runner-port.ts

import { describe, expect, it } from "vitest";

import {
  seqlaneAgentExecutionResultSchema,
  validateSeqlaneAgentWorkflowOutput,
  validateAgentResolutionRequest,
} from "./agent-runner-port.js";

describe("agent runner port", () => {
  it("keeps lockfile conflicts out of the agent request contract", () => {
    expect(
      validateAgentResolutionRequest({
        paths: ["src/file.ts"],
        baseRevision: "a".repeat(40),
        headRevision: "b".repeat(40),
      }),
    ).toEqual({
      paths: ["src/file.ts"],
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
    });
  });

  it("validates structured runner results", () => {
    expect(
      seqlaneAgentExecutionResultSchema.safeParse({
        status: "succeeded",
        output: { resolvedFiles: ["src/file.ts"] },
      }).success,
    ).toBe(true);
    expect(
      seqlaneAgentExecutionResultSchema.safeParse({ status: "failed" }).success,
    ).toBe(false);
  });

  it("propagates only validated workflow output", () => {
    expect(
      validateSeqlaneAgentWorkflowOutput({
        summary: "Resolved the file.",
        resolvedFiles: ["src/file.ts"],
        decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
      }),
    ).toEqual({
      summary: "Resolved the file.",
      resolvedFiles: ["src/file.ts"],
      decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
    });
    expect(() =>
      validateSeqlaneAgentWorkflowOutput({ summary: "missing" }),
    ).toThrow("malformed");
  });
});
