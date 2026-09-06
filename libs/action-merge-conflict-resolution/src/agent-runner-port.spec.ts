// @test-scope ./agent-runner-port.ts

import { describe, expect, it } from "vitest";

import {
  seqlaneAgentExecutionResultSchema,
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
});
