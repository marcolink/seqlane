// @test-scope ./executable-path.ts
import { describe, expect, it } from "vitest";
import { isAbsoluteCodexExecutablePath } from "./executable-path.js";

describe("Codex executable paths", () => {
  it("uses the target platform path rules", () => {
    expect(
      isAbsoluteCodexExecutablePath(String.raw`C:\tools\codex.exe`, "win32"),
    ).toBe(true);
    expect(isAbsoluteCodexExecutablePath("tools/codex", "win32")).toBe(false);
    expect(isAbsoluteCodexExecutablePath("/opt/codex", "linux")).toBe(true);
  });
});
