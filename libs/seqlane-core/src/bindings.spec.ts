import { describe, expect, it } from "vitest";
import { valueRefSchema } from "./bindings.js";

describe("valueRefSchema", () => {
  it("accepts references with additional authoring properties", () => {
    expect(
      valueRefSchema.safeParse({
        type: "ref",
        nodeId: "task:1",
        path: ["output"],
        label: "result",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed reference paths", () => {
    expect(
      valueRefSchema.safeParse({
        type: "ref",
        nodeId: "task:1",
        path: ["output", 0],
      }).success,
    ).toBe(false);
  });
});
