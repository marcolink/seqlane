// @test-scope ./config.ts
// @test-scope ./readiness.ts

import { describe, expect, it } from "vitest";
import { parseRipwireInputs } from "./config.js";

const base = { workingDirectory: "/tmp/project" };

describe("Ripwire input validation", () => {
  it("applies secure defaults and normalizes version and paths", () => {
    expect(parseRipwireInputs({ ...base, version: "v0.4.0" })).toMatchObject({
      workingDirectory: "/tmp/project",
      version: "0.4.0",
      listen: "127.0.0.1:7998",
      mcpUrl: "http://127.0.0.1:7998/mcp",
      topK: 200,
      stableOrder: true,
      redact: true,
      allowRemoteEdits: false,
      startupTimeoutSeconds: 30,
    });
  });

  it.each(["", "v0.4", "0.4.0-rc.1", "latest", "../0.4.0"])(
    "rejects invalid version %s",
    (version) =>
      expect(() => parseRipwireInputs({ ...base, version })).toThrow("version"),
  );

  it.each([
    ["topK", "-1"],
    ["topK", "1.5"],
    ["startupTimeoutSeconds", "0"],
    ["startupTimeoutSeconds", "1.5"],
  ] as const)("rejects invalid integer input %s=%s", (key, value) => {
    expect(() => parseRipwireInputs({ ...base, [key]: value })).toThrow(
      key === "topK" ? "top-k" : "startup-timeout",
    );
  });

  it.each([
    ["stableOrder", "yes"],
    ["redact", "1"],
    ["allowRemoteEdits", "no"],
  ] as const)("rejects invalid boolean input %s=%s", (key, value) => {
    expect(() => parseRipwireInputs({ ...base, [key]: value })).toThrow();
  });

  it.each([
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1",
    "::1:7998",
    "not-host:7998",
    "1.2.3.999:7998",
  ])("rejects invalid listen address %s", (listen) =>
    expect(() => parseRipwireInputs({ ...base, listen })).toThrow("listen"),
  );

  it("canonicalizes ports and accepts localhost", () => {
    expect(
      parseRipwireInputs({ ...base, listen: "localhost:07998" }),
    ).toMatchObject({
      listen: "localhost:7998",
      mcpUrl: "http://localhost:7998/mcp",
    });
  });

  it("requires a token for non-loopback binds and remote edits", () => {
    expect(() =>
      parseRipwireInputs({ ...base, listen: "0.0.0.0:7998" }),
    ).toThrow("mcp-token");
    expect(() =>
      parseRipwireInputs({ ...base, listen: "127.0.0.2:7998" }),
    ).toThrow("mcp-token");
    expect(() =>
      parseRipwireInputs({ ...base, allowRemoteEdits: "true" }),
    ).toThrow("mcp-token");
    expect(
      parseRipwireInputs({
        ...base,
        listen: "0.0.0.0:7998",
        mcpToken: "secret",
        allowRemoteEdits: "true",
      }),
    ).toMatchObject({ mcpToken: "secret", allowRemoteEdits: true });
  });
});
