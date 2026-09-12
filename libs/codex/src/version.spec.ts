// @test-scope ./version.ts
import { describe, expect, it } from "vitest";
import {
  TESTED_CODEX_VERSIONS,
  parseCodexVersion,
  versionDiagnostic,
} from "./version.js";

describe("Codex version policy", () => {
  it("records the current confirmed CLI version", () => {
    expect(TESTED_CODEX_VERSIONS).toContain("0.147.0");
    expect(parseCodexVersion("codex-cli 0.147.0")).toBe("0.147.0");
    expect(versionDiagnostic("0.147.0")).toBeUndefined();
  });

  it("warns but does not reject an unconfirmed version", () => {
    expect(versionDiagnostic("0.148.0")).toMatchObject({
      code: "codex-version-unconfirmed",
      version: "0.148.0",
      testedVersions: ["0.147.0"],
    });
    expect(versionDiagnostic(undefined)?.code).toBe(
      "codex-version-unconfirmed",
    );
  });
});
