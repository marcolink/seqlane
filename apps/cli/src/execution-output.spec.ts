// @test-scope ./execution-output.ts

import { describe, expect, it, vi } from "vitest";
import { withExecutionOutputBoundary } from "./execution-output.js";

describe("withExecutionOutputBoundary", () => {
  it("redirects execution stdout to diagnostics and restores stdout", async () => {
    const diagnostic = vi.fn();
    const write = process.stdout.write;

    await withExecutionOutputBoundary(
      true,
      async () => {
        process.stdout.write("workflow output\n");
      },
      diagnostic,
    );

    expect(diagnostic).toHaveBeenCalledWith("workflow output\n");
    expect(process.stdout.write).toBe(write);
  });
});
