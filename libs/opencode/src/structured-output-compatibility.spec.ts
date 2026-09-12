// @test-scope ./structured-output-compatibility.ts
import { describe, expect, it } from "vitest";
import { isNativeReadbackCompatibilityError } from "./structured-output-compatibility.js";

describe("structured output compatibility errors", () => {
  it("recognizes the persisted format readback failure", () => {
    expect(
      isNativeReadbackCompatibilityError({
        name: "BadRequest",
        data: {
          message:
            'Expected OutputFormatJsonSchema, got {...} at [0]["info"]["format"]',
        },
      }),
    ).toBe(true);
  });

  it("does not classify unrelated bad requests", () => {
    expect(
      isNativeReadbackCompatibilityError({
        name: "BadRequest",
        data: { message: "Invalid model" },
      }),
    ).toBe(false);
    expect(
      isNativeReadbackCompatibilityError(
        new Error("Expected OutputFormatJsonSchema but provider failed"),
      ),
    ).toBe(false);
  });
});
