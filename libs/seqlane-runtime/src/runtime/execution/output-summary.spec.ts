import { describe, expect, it } from "vitest";
import { summarizeSeqlaneOutput } from "./output-summary.js";

describe("task output summaries", () => {
  it("reports shape and bounded object field names without values", () => {
    const value = {
      files: ["package.json"],
      summary: "safe",
      secret: "must not be copied",
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
    };

    expect(summarizeSeqlaneOutput(value)).toEqual({
      kind: "object",
      size: 12,
      fields: [
        "files",
        "summary",
        "secret",
        "one",
        "two",
        "three",
        "four",
        "five",
      ],
    });
    expect(summarizeSeqlaneOutput(["one", "two"])).toEqual({
      kind: "array",
      size: 2,
    });
    expect(summarizeSeqlaneOutput("safe")).toEqual({
      kind: "string",
      size: 4,
    });
  });
});
