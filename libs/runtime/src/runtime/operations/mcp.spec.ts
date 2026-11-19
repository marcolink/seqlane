import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";
import type {
  OperationalRunStartRequest,
  OperationalRunStatus,
  OperationalWorkflow,
} from "@seqlane/protocol";
import { z } from "zod";
import { OPERATIONAL_MCP_PATH, operationalMcpLayer } from "./mcp.js";

const endpoint = `http://localhost${OPERATIONAL_MCP_PATH}`;
const protocolVersion = "2025-11-25";

const workflow: OperationalWorkflow = {
  id: "workflow-id",
  key: "demo",
  input: {
    schema: { type: "object", properties: { value: { type: "string" } } },
  },
  output: { schema: { type: "object" } },
  plan: { workflow: { id: "workflow-id" }, nodes: [] },
};

function status(
  overrides: Partial<OperationalRunStatus> = {},
): OperationalRunStatus {
  return {
    version: 1,
    workId: "work-1",
    runId: "run-1",
    workflowKey: "demo",
    status: "succeeded",
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:01.000Z",
    output: { value: "done" },
    completeness: { inspection: "complete" },
    ...overrides,
  };
}

const mcpJsonRpcResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.record(z.string(), z.unknown()).optional(),
});

function readJsonRpc(text: string) {
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return mcpJsonRpcResponseSchema.parse(JSON.parse(data ?? text));
}

async function withServer(
  invoke: (
    key: string,
    request: OperationalRunStartRequest,
  ) => Effect.Effect<OperationalRunStatus, unknown>,
  run: (handler: (request: Request) => Promise<Response>) => Promise<void>,
) {
  const app = HttpRouter.toWebHandler(
    operationalMcpLayer({ workflows: [workflow], invoke }).pipe(
      Layer.provide(HttpRouter.layer),
    ),
    { disableLogger: true },
  );
  try {
    await run((request) => app.handler(request));
  } finally {
    await app.dispose();
  }
}

async function post(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": protocolVersion,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function postModern(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const method =
    typeof body === "object" && body !== null && "method" in body
      ? String(body.method)
      : "";
  return post(handler, body, {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...headers,
  });
}

async function initialize(handler: (request: Request) => Promise<Response>) {
  const response = await post(handler, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "mcp-spec", version: "1.0.0" },
    },
  });
  return { response, sessionId: response.headers.get("mcp-session-id") ?? "" };
}

function sessionHeaders(sessionId: string) {
  return { "mcp-session-id": sessionId };
}

describe("native operational MCP", () => {
  it("negotiates supported legacy protocols and lists the workflow tool", async () => {
    const invoked: Array<{ key: string; request: OperationalRunStartRequest }> =
      [];
    await withServer(
      (key, request) => {
        invoked.push({ key, request });
        return Effect.succeed(status());
      },
      async (handler) => {
        const { response, sessionId } = await initialize(handler);
        expect(response.status).toBe(200);
        expect(sessionId).not.toBe("");
        expect(readJsonRpc(await response.text())).toMatchObject({
          result: { protocolVersion },
        });

        const tools = await post(
          handler,
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          sessionHeaders(sessionId),
        );
        const listed = readJsonRpc(await tools.text());
        expect(listed).toMatchObject({
          result: {
            tools: [
              {
                name: "run_demo",
                inputSchema: {
                  type: "object",
                  properties: {
                    version: { const: 1 },
                    workId: expect.any(Object),
                    runId: expect.any(Object),
                    runtime: expect.any(Object),
                    input: workflow.input.schema,
                  },
                },
              },
            ],
          },
        });

        const called = await post(
          handler,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 1, input: { value: "hello" } },
            },
          },
          sessionHeaders(sessionId),
        );
        const result = readJsonRpc(await called.text());
        const structured = (result.result as Record<string, unknown>)
          .structuredContent;
        expect(result).toMatchObject({
          result: {
            isError: false,
            structuredContent: status(),
            content: [{ type: "text", text: JSON.stringify(structured) }],
          },
        });
        expect(invoked).toEqual([
          {
            key: "demo",
            request: { version: 1, input: { value: "hello" } },
          },
        ]);
      },
    );
  });

  it("supports the negotiated 2026 sessionless protocol", async () => {
    await withServer(
      () => Effect.succeed(status()),
      async (handler) => {
        const response = await postModern(handler, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).toBeNull();
        expect(readJsonRpc(await response.text())).toMatchObject({
          result: { tools: [{ name: "run_demo" }] },
        });
        const called = await postModern(
          handler,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 1, input: { value: "modern" } },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          },
          { "mcp-name": "run_demo" },
        );
        expect(readJsonRpc(await called.text())).toMatchObject({
          result: { isError: false, structuredContent: status() },
        });
      },
    );
  });

  it("falls back to a supported legacy protocol when initialize asks for 2026", async () => {
    await withServer(
      () => Effect.succeed(status()),
      async (handler) => {
        const response = await post(handler, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "mcp-spec", version: "1.0.0" },
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("mcp-session-id")).not.toBeNull();
        expect(readJsonRpc(await response.text())).toMatchObject({
          result: { protocolVersion: "2025-03-26" },
        });
      },
    );
  });

  it("rejects unsupported versions, invalid origins, malformed JSON, and invalid tool envelopes", async () => {
    await withServer(
      () => Effect.succeed(status()),
      async (handler) => {
        const { sessionId } = await initialize(handler);
        const unsupported = await post(
          handler,
          {
            jsonrpc: "2.0",
            id: 8,
            method: "tools/list",
          },
          {
            ...sessionHeaders(sessionId),
            "mcp-protocol-version": "1900-01-01",
          },
        );
        expect(unsupported.status).toBe(400);

        const badOrigin = await post(
          handler,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: "mcp-spec", version: "1.0.0" },
            },
          },
          { origin: "https://untrusted.example" },
        );
        expect(badOrigin.status).toBe(403);

        const invalidJson = await handler(
          new Request(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-protocol-version": protocolVersion,
            },
            body: "{",
          }),
        );
        expect(invalidJson.status).toBe(200);
        expect(readJsonRpc(await invalidJson.text())).toMatchObject({
          error: { code: -32700 },
        });

        const malformed = await post(
          handler,
          {
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 2, input: null },
            },
          },
          sessionHeaders(sessionId),
        );
        expect(readJsonRpc(await malformed.text())).toMatchObject({
          result: {
            isError: true,
            content: [{ text: "Invalid workflow run request" }],
          },
        });
      },
    );
  });

  it("accepts cancellation after terminal settlement and deletes the session", async () => {
    let invoked = 0;
    await withServer(
      () => {
        invoked += 1;
        return Effect.succeed(status());
      },
      async (handler) => {
        const { sessionId } = await initialize(handler);
        const call = await post(
          handler,
          {
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 1, input: { value: "done" } },
            },
          },
          sessionHeaders(sessionId),
        );
        expect(readJsonRpc(await call.text())).toMatchObject({
          result: { isError: false },
        });

        const cancelled = await post(
          handler,
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 12 },
          },
          sessionHeaders(sessionId),
        );
        expect(cancelled.status).toBe(202);
        expect(invoked).toBe(1);

        const deletion = await handler(
          new Request(endpoint, {
            method: "DELETE",
            headers: {
              ...sessionHeaders(sessionId),
              "mcp-protocol-version": protocolVersion,
            },
          }),
        );
        expect(deletion.status).toBe(204);

        const afterDelete = await post(
          handler,
          { jsonrpc: "2.0", id: 13, method: "tools/list" },
          sessionHeaders(sessionId),
        );
        expect(afterDelete.status).toBe(404);
      },
    );
  });

  it("interrupts a running tool call through the native cancel notification", async () => {
    let markStarted!: () => void;
    let markInterrupted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const interrupted = new Promise<void>(
      (resolve) => (markInterrupted = resolve),
    );

    await withServer(
      () => {
        markStarted();
        return Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(markInterrupted)),
        );
      },
      async (handler) => {
        const { sessionId } = await initialize(handler);
        const call = post(
          handler,
          {
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 1, input: { value: "active" } },
            },
          },
          sessionHeaders(sessionId),
        );
        await started;
        const cancellation = await post(
          handler,
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 12 },
          },
          sessionHeaders(sessionId),
        );
        expect(cancellation.status).toBe(202);
        await interrupted;
        await call;
      },
    );
  });

  it("interrupts a running tool call when the client deletes its session", async () => {
    let markStarted!: () => void;
    let markInterrupted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const interrupted = new Promise<void>(
      (resolve) => (markInterrupted = resolve),
    );

    await withServer(
      () => {
        markStarted();
        return Effect.never.pipe(
          Effect.onInterrupt(() => Effect.sync(markInterrupted)),
        );
      },
      async (handler) => {
        const { sessionId } = await initialize(handler);
        const call = post(
          handler,
          {
            jsonrpc: "2.0",
            id: 14,
            method: "tools/call",
            params: {
              name: "run_demo",
              arguments: { version: 1, input: { value: "active" } },
            },
          },
          sessionHeaders(sessionId),
        );
        await started;
        const deletion = await handler(
          new Request(endpoint, {
            method: "DELETE",
            headers: {
              ...sessionHeaders(sessionId),
              "mcp-protocol-version": protocolVersion,
            },
          }),
        );
        expect(deletion.status).toBe(204);
        await interrupted;
        await call;
      },
    );
  });

  it("returns explicit tool errors for failed and oversized results", async () => {
    await withServer(
      (_key, request) =>
        Effect.succeed(
          status(
            request.input === "large"
              ? { output: "x".repeat(16 * 1024 * 1024 + 1) }
              : { status: "failed" },
          ),
        ),
      async (handler) => {
        const { sessionId } = await initialize(handler);
        const call = async (input: unknown, id: number) =>
          post(
            handler,
            {
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: "run_demo", arguments: { version: 1, input } },
            },
            sessionHeaders(sessionId),
          );

        const failed = readJsonRpc(await (await call({}, 15)).text());
        expect(failed).toMatchObject({ result: { isError: true } });

        const oversized = readJsonRpc(await (await call("large", 16)).text());
        expect(oversized).toMatchObject({
          result: {
            isError: true,
            content: [
              {
                text: expect.stringContaining(
                  "exceeds the MCP response byte limit",
                ),
              },
            ],
          },
        });
        expect(JSON.stringify(oversized).length).toBeLessThan(2_000);
      },
    );
  });
});
