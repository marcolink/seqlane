// @test-scope ./errors.ts

import { describe, expect, it } from "vitest";
import { ActionResolutionError, resolutionErrorDetails } from "./errors.js";

describe("action resolution errors", () => {
  it("preserves a stable category, code, and original cause", () => {
    const cause = new Error("provider detail that callers must not parse");
    const error = new ActionResolutionError(
      "lockfile",
      "LOCKFILE_REGENERATION_FAILED",
      "Lockfile regeneration failed.",
      cause,
    );

    expect(error).toBeInstanceOf(ActionResolutionError);
    expect(error.category).toBe("lockfile");
    expect(error.code).toBe("LOCKFILE_REGENERATION_FAILED");
    expect(error.cause).toBe(cause);
    expect(resolutionErrorDetails(error)).toEqual({
      category: "lockfile",
      code: "LOCKFILE_REGENERATION_FAILED",
    });
  });
});
