import { describe, expect, it } from "vitest";
import { toSeqlaneDisplayValue } from "./display-value.js";

describe("Seqlane display values", () => {
  it("includes full values without task configuration", () => {
    expect(toSeqlaneDisplayValue({ safe: "ok", secret: "no" })).toEqual({
      state: "present",
      value: { safe: "ok", secret: "no" },
    });
  });

  it("preserves values larger than the former byte limit", () => {
    const value = { text: "x".repeat(33 * 1024) };
    expect(toSeqlaneDisplayValue(value)).toEqual({
      state: "present",
      value,
    });
  });

  it("omits non-JSON values", () => {
    for (const value of [undefined, new Date(), { unsupported: new Date() }]) {
      expect(toSeqlaneDisplayValue(value)).toEqual({
        state: "omitted",
        reason: "unavailable",
      });
    }
  });

  it("preserves values deeper and wider than the former shape limits", () => {
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 17; index += 1) {
      current.next = {};
      current = current.next as Record<string, unknown>;
    }

    const wide = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [String(index), index]),
    );
    for (const value of [deep, wide]) {
      expect(toSeqlaneDisplayValue(value)).toEqual({ state: "present", value });
    }
  });
});
