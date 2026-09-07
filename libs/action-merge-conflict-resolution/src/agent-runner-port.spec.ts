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
    const requestedPaths = ["src/file.ts"];
    expect(
      validateSeqlaneAgentWorkflowOutput(
        {
          summary: "Resolved the file.",
          resolvedFiles: ["src/file.ts"],
          decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
        },
        requestedPaths,
      ),
    ).toEqual({
      summary: "Resolved the file.",
      resolvedFiles: ["src/file.ts"],
      decisions: [{ file: "src/file.ts", decision: "Kept both changes." }],
    });
    expect(() =>
      validateSeqlaneAgentWorkflowOutput(
        { summary: "missing" },
        requestedPaths,
      ),
    ).toThrow("malformed");
  });

  it.each([
    ["missing resolved file", ["src/file.ts", "src/other.ts"], ["src/file.ts"]],
    ["extra resolved file", ["src/file.ts"], ["src/file.ts", "src/other.ts"]],
    [
      "duplicate resolved file",
      ["src/file.ts"],
      ["src/file.ts", "src/file.ts"],
    ],
  ])("rejects %s", (_label, requestedPaths, resolvedFiles) => {
    expect(() =>
      validateSeqlaneAgentWorkflowOutput(
        {
          summary: "Resolved the files.",
          resolvedFiles,
          decisions: requestedPaths.map((file) => ({
            file,
            decision: "Resolved.",
          })),
        },
        requestedPaths,
      ),
    ).toThrow("malformed");
  });

  it("rejects missing, extra, and duplicate decision paths", () => {
    const requestedPaths = ["src/file.ts", "src/other.ts"];
    for (const decisions of [
      [{ file: "src/file.ts", decision: "Resolved." }],
      [
        { file: "src/file.ts", decision: "Resolved." },
        { file: "src/other.ts", decision: "Resolved." },
        { file: "src/extra.ts", decision: "Unexpected." },
      ],
      [
        { file: "src/file.ts", decision: "Resolved." },
        { file: "src/file.ts", decision: "Repeated." },
      ],
    ]) {
      expect(() =>
        validateSeqlaneAgentWorkflowOutput(
          {
            summary: "Resolved the files.",
            resolvedFiles: requestedPaths,
            decisions,
          },
          requestedPaths,
        ),
      ).toThrow("malformed");
    }
  });
});
