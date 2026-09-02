import { describe, expect, it } from "vitest";
import { isJsonValue, isPlainRecord } from "./json.js";

describe("JSON value guards", () => {
  it("accepts plain records, including null-prototype records", () => {
    expect(isPlainRecord({ value: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it("rejects non-record objects and accessors", () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new Date())).toBe(false);

    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(isPlainRecord(accessor)).toBe(false);
  });

  it("accepts nested JSON values and rejects non-JSON primitives", () => {
    expect(
      isJsonValue({
        answer: 42,
        nested: ["value", true, null],
      }),
    ).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Infinity)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
  });

  it("rejects sparse and cyclic JSON structures", () => {
    const sparse = [] as unknown[];
    sparse.length = 1;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(isJsonValue(sparse)).toBe(false);
    expect(isJsonValue(cyclic)).toBe(false);
  });
});
