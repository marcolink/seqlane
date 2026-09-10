// @test-scope ./version.ts

import { describe, expect, it } from "vitest";
import { parseVersion } from "./version.js";

describe("parseVersion", () => {
  it.each([
    "1.18.27",
    "0.1.0",
    "1.18.27-0.1",
    "1.18.27-rc.1",
    "1.18.27+build.4",
  ])("accepts exact release version %s", (value) => {
    expect(parseVersion(value)).toBe(value);
  });

  it.each([
    "",
    " latest",
    "latest",
    "1.18",
    "^1.18.27",
    "v1.18.27",
    "/tmp/opencode",
    "1.2.3-01",
    "1.2.3-1.02",
    "1.2.3-00.1",
  ])("rejects non-exact version %j", (value) => {
    expect(() => parseVersion(value)).toThrow(/exact semantic release version/);
  });
});
