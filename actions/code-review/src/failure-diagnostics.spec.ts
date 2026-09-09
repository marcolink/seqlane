// @test-scope ./failure-diagnostics.ts

import { describe, expect, it } from "vitest";
import {
  createReviewFailureContext,
  formatCodeReviewFailure,
} from "./failure-diagnostics.js";

describe("code review failure diagnostics", () => {
  it("reports structured failure context while bounding and sanitizing text", () => {
    const context = createReviewFailureContext();
    context.observe({
      kind: "task-completed",
      label: "correctness",
      taskId: "review-correctness",
      status: "failed",
    });
    context.observe({
      kind: "review-completed",
      status: "failed",
      elapsedMs: 185_000,
    });

    const message = formatCodeReviewFailure(
      {
        category: "RuntimeError",
        code: "TIMEOUT",
        message: `request timed out\n\u0000${"x".repeat(2_000)} ghp_0123456789abcdef`,
        cause: new Error("must not be logged"),
      },
      context.snapshot(),
    );

    expect(message).toContain("category=RuntimeError");
    expect(message).toContain("code=TIMEOUT");
    expect(message).toContain(
      "last-task=correctness (review-correctness) status=failed",
    );
    expect(message).toContain("elapsed=185.0s");
    expect(message).not.toContain("must not be logged");
    expect(message).not.toContain("ghp_0123456789abcdef");
    expect(
      [...message].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }),
    ).toBe(false);
    expect(message.length).toBeLessThanOrEqual(1_000);
  });
});
