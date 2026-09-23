// @test-scope ./payload-limits.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeBoundedJsonDocument } from "./payload-limits.js";

afterEach(() => vi.restoreAllMocks());

describe("classifier payload limits", () => {
  it("validates and serializes a bounded document once", () => {
    const stringify = vi.spyOn(JSON, "stringify");

    const document = serializeBoundedJsonDocument(
      { model: "monkey-model", state: "keyboard change" },
      "request body",
      undefined,
      "key",
    );

    expect(document).toEqual({
      value: { model: "monkey-model", state: "keyboard change" },
      hasExactString: false,
      text: '{"model":"monkey-model","state":"keyboard change"}',
    });
    expect(stringify).toHaveBeenCalledTimes(1);
  });

  it("finds exact credentials in JSON keys and values", () => {
    expect(
      serializeBoundedJsonDocument(
        { nested: { credential: "secret" } },
        "request body",
        undefined,
        "secret",
      ).hasExactString,
    ).toBe(true);
    expect(
      serializeBoundedJsonDocument(
        { secret: "value" },
        "request body",
        undefined,
        "secret",
      ).hasExactString,
    ).toBe(true);
  });
});
