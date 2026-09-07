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

  it("bounds and sanitizes rejected push diagnostics", () => {
    const error = new ActionResolutionError(
      "push",
      "PUSH_REFUSED",
      "The resolved pull request could not be pushed.",
      {
        stderr: `remote: \u001b[31mhttps://user:password@example.com/repo.git\u001b[0m\n${"x".repeat(2_000)}`,
      },
    );

    const details = resolutionErrorDetails(error);

    expect(details.category).toBe("push");
    expect(details.code).toBe("PUSH_REFUSED");
    expect(details.diagnostic).toContain("https://[REDACTED]@example.com");
    expect(details.diagnostic).not.toContain("password");
    expect(
      Array.from(details.diagnostic ?? "").some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
        );
      }),
    ).toBe(false);
    expect(details.diagnostic?.length).toBeLessThanOrEqual(1_025);
    expect(details.diagnostic?.endsWith("…")).toBe(true);
  });
});
