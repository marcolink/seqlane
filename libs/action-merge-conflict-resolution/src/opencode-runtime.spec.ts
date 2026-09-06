// @test-scope ./opencode-runtime.ts

import { describe, expect, it } from "vitest";

import {
  OPENCODE_ARCHIVE_SHA256,
  OPENCODE_CONFIG,
  OPENCODE_HOST,
  OPENCODE_PORT,
  OPENCODE_VERSION,
  verifyOpenCodeArchive,
} from "./opencode-runtime.js";

describe("resolver OpenCode runtime", () => {
  it("keeps the pinned version, policy, and loopback binding", () => {
    expect(OPENCODE_VERSION).toBe("1.18.27");
    expect(OPENCODE_ARCHIVE_SHA256).toBe(
      "4af5494f9433f59db8c1e344198f0ee72a50c06ec009fb4a8aeab4c2d4abd702",
    );
    expect(OPENCODE_HOST).toBe("127.0.0.1");
    expect(OPENCODE_PORT).toBe(4096);
    expect(OPENCODE_CONFIG).toContain('"bash":"deny"');
    expect(OPENCODE_CONFIG).toContain('"external_directory":"deny"');
  });

  it("rejects an archive before extraction when its hash is wrong", () => {
    expect(() => verifyOpenCodeArchive(new Uint8Array([1, 2, 3]))).toThrow(
      /archive hash/i,
    );
  });
});
