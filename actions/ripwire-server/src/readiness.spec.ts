// @test-scope ./readiness.ts

import { describe, expect, it, vi } from "vitest";
import {
  checkMcpInitialize,
  MCP_INITIALIZE_REQUEST,
  parseListenAddress,
} from "./readiness.js";

describe("Ripwire MCP readiness", () => {
  it("validates the HTTP status, headers, bearer token, and initialize response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      });
      expect(JSON.parse(String(init.body))).toEqual(MCP_INITIALIZE_REQUEST);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "ripwire", version: "0.4.0" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await checkMcpInitialize(
      "http://127.0.0.1:7998/mcp",
      "secret",
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts a conforming server-sent event response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"ripwire","version":"0.4.0"}}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    await checkMcpInitialize(
      "http://127.0.0.1:7998/mcp",
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
  });

  it("rejects non-OK and malformed initialize responses", async () => {
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        async () => new Response("unauthorized", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            status: 200,
          }),
      ),
    ).rejects.toThrow("invalid initialize response");
  });

  it("canonicalizes only supported host and port forms", () => {
    expect(parseListenAddress("127.0.0.1:07998")).toEqual({
      host: "127.0.0.1",
      port: 7998,
      listen: "127.0.0.1:7998",
      mcpUrl: "http://127.0.0.1:7998/mcp",
    });
  });
});
