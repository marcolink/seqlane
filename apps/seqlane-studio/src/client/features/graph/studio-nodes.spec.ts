import { describe, expect, it } from "vitest";
import { sessionLabel } from "./studio-nodes.js";

describe("sessionLabel", () => {
  it("renders executor-neutral Plan session policies", () => {
    expect(sessionLabel({ type: "isolated" })).toBe("isolated");
    expect(sessionLabel({ type: "reuse", from: "prepare:1" })).toBe(
      "reuse ← prepare:1",
    );
    expect(sessionLabel({ type: "branch", from: "prepare:1" })).toBe(
      "branch ← prepare:1",
    );
  });

  it("does not invent session detail for older recordings", () => {
    expect(sessionLabel(undefined)).toBeUndefined();
  });
});
