// @test-scope ./token.ts

import { describe, expect, it } from "vitest";
import { createSessionToken } from "./token.js";

describe("Ripwire session token", () => {
  it("generates a unique cryptographic token without a seed", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("derives a unique token from a secret seed without returning the seed", () => {
    const first = createSessionToken("secret-seed");
    const second = createSessionToken("secret-seed");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("secret-seed");
  });
});
