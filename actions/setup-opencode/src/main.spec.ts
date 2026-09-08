// @test-scope ./main.ts

import { describe, expect, it } from "vitest";
import { parseVersion } from "./version.js";

describe("setup-opencode entrypoint contract", () => {
  it("requires an exact version before setup", () => {
    expect(() => parseVersion("latest")).toThrow();
    expect(parseVersion("1.18.27")).toBe("1.18.27");
  });
});
