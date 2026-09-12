import { describe, expect, it } from "vitest";
import { extractStructuredOutput } from "./structured-output.js";

describe("extractStructuredOutput", () => {
  it("returns structured output from a valid response", () => {
    expect(
      extractStructuredOutput({ info: { structured: { answer: "ok" } } }),
    ).toEqual({ answer: "ok" });
  });

  it("rejects responses without structured output", () => {
    expect(() => extractStructuredOutput({ info: {} })).toThrow(
      "OpenCode response did not contain structured output",
    );
  });
});
