// @test-scope ./observability.ts

import { describe, expect, it, vi } from "vitest";
import { createBoundedNormalizedNameAllocator } from "./observability.js";

describe("bounded normalized telemetry names", () => {
  it("normalizes accepted names and falls back for invalid names", () => {
    const allocator = createBoundedNormalizedNameAllocator({
      fallback: "tool call",
    });

    expect(allocator.resolve("ｅｃｈｏ")).toBe("echo");
    expect(allocator.resolve("not valid")).toBe("tool call");
    expect(allocator.resolve("")).toBe("tool call");
  });

  it("rejects oversized raw input before NFKC normalization", () => {
    const normalize = vi.spyOn(String.prototype, "normalize");
    const allocator = createBoundedNormalizedNameAllocator({
      fallback: "tool call",
    });

    expect(allocator.resolve("ｅ".repeat(257))).toBe("tool call");
    expect(normalize).not.toHaveBeenCalled();

    normalize.mockRestore();
  });

  it("bounds distinct names and reports overflow", () => {
    const overflows: string[] = [];
    const allocator = createBoundedNormalizedNameAllocator({
      fallback: "tool call",
      maximumNames: 1,
      onOverflow: () => overflows.push("overflow"),
    });

    expect(allocator.resolve("first")).toBe("first");
    expect(allocator.resolve("first")).toBe("first");
    expect(allocator.resolve("second")).toBe("tool call");
    expect(overflows).toEqual(["overflow"]);
  });
});
