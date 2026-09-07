import { describe, expect, it } from "vitest";
import {
  buildReadinessArguments,
  mcpUrl,
  parseListenAddress,
} from "./readiness.js";

describe("zvec-grep readiness", () => {
  it("binds readiness to the configured instance home", () => {
    expect(
      buildReadinessArguments("@zvec/zvec-grep@0.2.1", "/tmp/zvec-grep"),
    ).toEqual([
      "dlx",
      "@zvec/zvec-grep@0.2.1",
      "server",
      "status",
      "--check-ready",
      "--home",
      "/tmp/zvec-grep",
    ]);
  });

  it("builds the MCP endpoint from the configured listen address", () => {
    expect(mcpUrl("127.0.0.1:7999")).toBe("http://127.0.0.1:7999/mcp");
  });

  it.each([
    "127.0.0.1",
    "127.0.0.1:",
    "127.0.0.1:0",
    "127.0.0.1:80",
    "not a listen address",
  ])(
    "rejects a listen address without a non-default explicit port: %s",
    (listen) => {
      expect(() => parseListenAddress(listen)).toThrow(
        "listen must contain a hostname and non-default port",
      );
    },
  );

  it("returns one canonical listen address and MCP URL", () => {
    expect(parseListenAddress("127.0.0.1:07999")).toEqual({
      listen: "127.0.0.1:7999",
      mcpUrl: "http://127.0.0.1:7999/mcp",
    });
  });

  it("supports bracketed IPv6 listen addresses", () => {
    expect(parseListenAddress("[::1]:7999")).toEqual({
      listen: "[::1]:7999",
      mcpUrl: "http://[::1]:7999/mcp",
    });
  });
});
