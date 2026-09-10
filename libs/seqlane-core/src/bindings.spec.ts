import { describe, expect, it } from "vitest";
import { valueRefSchema } from "./bindings.js";

describe("valueRefSchema", () => {
  it("rejects references with additional properties", () => {
    expect(
      valueRefSchema.safeParse({
        type: "ref",
        nodeId: "task:1",
        path: ["output"],
        label: "result",
      }).success,
    ).toBe(false);
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
