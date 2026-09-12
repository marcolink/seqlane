import { describe, expect, it } from "vitest";
import { toSeqlaneDisplayValue } from "./display-value.js";

describe("Seqlane display values", () => {
  it("includes bounded values without an explicit Studio selection", () => {
    expect(
      toSeqlaneDisplayValue({ safe: "ok", secret: "no" }, undefined),
    ).toEqual({ state: "present", value: { safe: "ok", secret: "no" } });
    expect(toSeqlaneDisplayValue({ safe: "ok" }, { includePaths: [] })).toEqual(
      { state: "omitted", reason: "policy" },
    );
  });

  it("truncates oversized default values", () => {
    const value = { text: "x".repeat(33 * 1024) };
    expect(toSeqlaneDisplayValue(value, undefined)).toEqual({
      state: "truncated",
      summary: { kind: "object", size: 1, fields: ["text"] },
    });
  });

  it("projects only selected RFC 6901 paths", () => {
    expect(
      toSeqlaneDisplayValue(
        { safe: { name: "task", secret: "no" }, other: true },
        { includePaths: ["/safe/name"] },
      ),
    ).toEqual({ state: "present", value: { safe: { name: "task" } } });
    expect(
      toSeqlaneDisplayValue(
        { "a/b": { "~key": 1 } },
        { includePaths: ["/a~1b/~0key"] },
      ),
    ).toEqual({ state: "present", value: { "a/b": { "~key": 1 } } });
    expect(
      toSeqlaneDisplayValue(
        { safe: "ok", unsupported: new Date() },
        { includePaths: ["/safe"] },
      ),
    ).toEqual({ state: "present", value: { safe: "ok" } });
  });

  it("allows the root pointer and omits unavailable paths", () => {
    expect(
      toSeqlaneDisplayValue({ value: true }, { includePaths: [""] }),
    ).toEqual({ state: "present", value: { value: true } });
    expect(
      toSeqlaneDisplayValue({ value: true }, { includePaths: ["/missing"] }),
    ).toEqual({ state: "omitted", reason: "unavailable" });
  });

  it("truncates oversized projections without sending partial values", () => {
    const value = { text: "x".repeat(33 * 1024) };
    expect(toSeqlaneDisplayValue(value, { includePaths: [""] })).toEqual({
      state: "truncated",
      summary: { kind: "object", size: 1, fields: ["text"] },
    });
  });

  it("truncates projections that exceed shape limits", () => {
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 17; index += 1) {
      current.next = {};
      current = current.next as Record<string, unknown>;
    }

    expect(toSeqlaneDisplayValue(deep, { includePaths: [""] }).state).toBe(
      "truncated",
    );
    expect(
      toSeqlaneDisplayValue(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [String(index), index]),
        ),
        { includePaths: [""] },
      ).state,
    ).toBe("truncated");
  });
});
