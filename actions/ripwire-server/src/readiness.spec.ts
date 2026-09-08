// @test-scope ./readiness.ts

import { describe, expect, it, vi } from "vitest";
import {
  checkMcpInitialize,
  MCP_INITIALIZE_REQUEST,
  MAX_STARTUP_TIMEOUT_MILLISECONDS,
  parseMcpResponseBody,
  parseListenAddress,
  RIPWIRE_SERVER_INFO_VERSION,
  waitForMcpHealth,
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
            serverInfo: {
              name: "ripwire",
              version: RIPWIRE_SERVER_INFO_VERSION,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await checkMcpInitialize(
      "http://127.0.0.1:7998/mcp",
      "secret",
      3_000,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts a conforming server-sent event response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"ripwire","version":"${RIPWIRE_SERVER_INFO_VERSION}"}}}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    await checkMcpInitialize(
      "http://127.0.0.1:7998/mcp",
      undefined,
      3_000,
      fetchImpl as unknown as typeof fetch,
    );
  });

  it("accepts one SSE event with a multi-line data field", () => {
    expect(
      parseMcpResponseBody(
        'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1}\n\n',
      ),
    ).toEqual({ jsonrpc: "2.0", id: 1 });
  });

  it("rejects non-OK and malformed initialize responses", async () => {
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        3_000,
        async () => new Response("unauthorized", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        3_000,
        async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            status: 200,
          }),
      ),
    ).rejects.toThrow("invalid initialize response");
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        3_000,
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                serverInfo: {
                  name: "other",
                  version: RIPWIRE_SERVER_INFO_VERSION,
                },
              },
            }),
            { status: 200 },
          ),
      ),
    ).rejects.toThrow("invalid initialize response");
    await expect(
      checkMcpInitialize(
        "http://127.0.0.1:7998/mcp",
        undefined,
        3_000,
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: {
                  name: "ripwire",
                  version: "0.4.0",
                },
              },
            }),
            { status: 200 },
          ),
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

  it("enforces one hard startup deadline, including a slow probe", async () => {
    const seen: number[] = [];
    const started = Date.now();
    await expect(
      waitForMcpHealth(async (remainingMilliseconds) => {
        seen.push(remainingMilliseconds);
        await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
      }, 1_000),
    ).rejects.toThrow("startup timeout");
    expect(seen[0]).toBeLessThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(1_700);
  });

  it("rejects invalid probe and wait deadlines immediately", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    for (const timeout of [0, -1, Number.MAX_SAFE_INTEGER + 1, 600_001]) {
      await expect(
        checkMcpInitialize(
          "http://127.0.0.1:7998/mcp",
          undefined,
          timeout,
          fetchImpl as unknown as typeof fetch,
        ),
      ).rejects.toThrow("safe integer");
      await expect(
        waitForMcpHealth(async () => undefined, timeout),
      ).rejects.toThrow("safe integer");
    }
    expect(MAX_STARTUP_TIMEOUT_MILLISECONDS).toBe(600_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
