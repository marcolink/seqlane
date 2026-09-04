// @test-scope ./adapter.ts
// @test-scope ./session.ts
// @test-scope ./transport.ts

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenCodeAdapter } from "./adapter.js";

interface RequestRecord {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

const bodySchema = z.record(z.string(), z.unknown());

const responseInfo = (
  sessionId: string,
  messageId: string,
  result: unknown,
) => ({
  id: messageId,
  sessionID: sessionId,
  role: "assistant",
  time: { created: 1, completed: 3 },
  parentID: "message-0",
  modelID: "controlled-model",
  providerID: "controlled-provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/controlled", root: "/controlled" },
  cost: 0,
  tokens: {
    total: 2,
    input: 1,
    output: 1,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  structured: result,
});

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, {
    connection: "close",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const result = bodySchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function startServer(
  options: { readonly mode?: "success" | "hold" | "permission" } = {},
): Promise<{
  readonly requests: RequestRecord[];
  readonly url: string;
  close(): Promise<void>;
}> {
  const requests: RequestRecord[] = [];
  const eventResponses = new Set<ServerResponse>();
  const pendingPrompts = new Map<string, ServerResponse>();
  let nextSession = 0;

  const sendEvent = (sessionId: string, event: Record<string, unknown>) => {
    for (const response of eventResponses) {
      response.write(
        `data: ${JSON.stringify({
          ...event,
          properties: {
            sessionID: sessionId,
            ...((event.properties as object) ?? {}),
          },
        })}\n\n`,
      );
    }
  };

  const server: Server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      path: requestUrl.pathname,
      body,
    });

    if (request.method === "GET" && requestUrl.pathname === "/event") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      eventResponses.add(response);
      request.on("close", () => eventResponses.delete(response));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/global/health") {
      writeJson(response, { healthy: true, version: "1.14.19" });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/session") {
      nextSession += 1;
      writeJson(response, {
        id: `session-${nextSession}`,
        directory: "/controlled",
      });
      return;
    }

    const sessionMatch = /^\/session\/(session-\d+)$/.exec(requestUrl.pathname);
    if (request.method === "GET" && sessionMatch) {
      writeJson(response, []);
      return;
    }

    const messagesMatch = /^\/session\/(session-\d+)\/message$/.exec(
      requestUrl.pathname,
    );
    if (request.method === "GET" && messagesMatch) {
      writeJson(response, []);
      return;
    }

    const forkMatch = /^\/session\/(session-\d+)\/fork$/.exec(
      requestUrl.pathname,
    );
    if (request.method === "POST" && forkMatch) {
      nextSession += 1;
      writeJson(response, {
        id: `session-${nextSession}`,
        directory: "/controlled",
      });
      return;
    }

    const initMatch = /^\/session\/(session-\d+)\/init$/.exec(
      requestUrl.pathname,
    );
    if (request.method === "POST" && initMatch) {
      writeJson(response, true);
      return;
    }

    const messageMatch = /^\/session\/(session-\d+)\/message$/.exec(
      requestUrl.pathname,
    );
    if (request.method === "POST" && messageMatch) {
      const sessionId = messageMatch[1];
      if (sessionId === undefined) {
        response.writeHead(400);
        response.end();
        return;
      }
      if (options.mode === "hold") {
        pendingPrompts.set(sessionId, response);
        return;
      }
      if (options.mode === "permission") {
        sendEvent(sessionId, {
          type: "permission.asked",
          properties: { callID: "controlled-permission" },
        });
        pendingPrompts.set(sessionId, response);
        return;
      }
      sendEvent(sessionId, {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            callID: "controlled-tool",
            tool: "filesystem.read",
            state: {
              status: "running",
              input: { path: "AGENTS.md" },
            },
          },
        },
      });
      sendEvent(sessionId, {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            callID: "controlled-tool",
            tool: "filesystem.read",
            state: { status: "completed", output: "ok" },
          },
        },
      });
      writeJson(response, {
        info: responseInfo(sessionId, `message-${sessionId}`, {
          result: "done",
        }),
        parts: [],
      });
      return;
    }

    const abortMatch = /^\/session\/(session-\d+)\/abort$/.exec(
      requestUrl.pathname,
    );
    if (request.method === "POST" && abortMatch) {
      const pending = pendingPrompts.get(abortMatch[1] ?? "");
      if (pending !== undefined) {
        pendingPrompts.delete(abortMatch[1] ?? "");
        pending.destroy();
      }
      writeJson(response, true);
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Controlled OpenCode server did not expose a TCP address");
  }

  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const response of eventResponses) response.end();
      for (const response of pendingPrompts.values()) response.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

describe("OpenCode SDK adapter boundary", () => {
  it("uses the configured SDK server, workspace, model, output, and activity", async () => {
    const server = await startServer();
    try {
      const activities: unknown[] = [];
      const adapter = createOpenCodeAdapter({
        url: server.url,
        workspace: "/configured-workspace",
        structuredOutput: { strategy: "native" },
      });
      const result = await adapter.execute({
        invocationId: "controlled-opencode-invocation",
        task: {
          id: "controlled-opencode-task",
          workspace: "shared",
          input: z.string(),
          output: z.object({ result: z.string() }),
          goal: (input) => input,
        },
        input: "Return the controlled result",
        modelSelection: {
          model: { provider: "controlled-provider", model: "controlled-model" },
          reasoning: "high",
        },
        signal: new AbortController().signal,
        onActivity: (activity) => activities.push(activity),
      });

      expect(result).toEqual({ result: "done" });
      expect(activities).toEqual([
        {
          activityId: "controlled-tool",
          kind: "tool",
          name: "filesystem.read",
          state: "started",
          input: { path: "AGENTS.md" },
        },
        {
          activityId: "controlled-tool",
          kind: "tool",
          name: "filesystem.read",
          state: "succeeded",
          output: "ok",
        },
      ]);
      expect(server.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "POST",
            path: "/session",
            body: undefined,
          }),
          expect.objectContaining({
            method: "POST",
            path: "/session/session-1/message",
            body: expect.objectContaining({
              model: {
                providerID: "controlled-provider",
                modelID: "controlled-model",
              },
              parts: expect.any(Array),
            }),
          }),
        ]),
      );
      expect(adapter.capabilities).toMatchObject({
        execute: true,
        modelSelection: true,
        structuredOutput: true,
        activity: true,
        sessionReuse: true,
        checkpoint: true,
        fork: true,
      });
    } finally {
      await server.close();
    }
  });

  it("reuses the selected session, then forks from its exact checkpoint", async () => {
    const server = await startServer();
    try {
      const adapter = createOpenCodeAdapter({
        url: server.url,
        structuredOutput: { strategy: "native" },
      });
      const request = {
        invocationId: "reuse-invocation",
        task: {
          id: "reuse-task",
          input: z.string(),
          output: z.object({ result: z.string() }),
          goal: (input) => input,
        },
        input: "reuse",
        signal: new AbortController().signal,
      };

      await adapter.execute(request);
      await adapter.execute({ ...request, invocationId: "reuse-invocation-2" });
      const checkpoint = await adapter.captureCheckpoint?.();
      const branch = await adapter.fork?.({ checkpoint });
      await branch?.execute({ ...request, invocationId: "branch-invocation" });

      expect(
        server.requests.filter(({ path }) => path === "/session"),
      ).toHaveLength(1);
      expect(
        server.requests.filter(
          ({ method, path }) => method === "POST" && /\/message$/.test(path),
        ),
      ).toHaveLength(3);
      expect(server.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "POST",
            path: "/session/session-1/fork",
            body: { messageID: "message-session-1" },
          }),
          expect.objectContaining({
            method: "POST",
            path: "/session/session-2/message",
          }),
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it("normalizes cancellation and unresolved permission without adapter fallback", async () => {
    const cancellationServer = await startServer({ mode: "hold" });
    try {
      const controller = new AbortController();
      const adapter = createOpenCodeAdapter({
        url: cancellationServer.url,
        structuredOutput: { strategy: "native" },
      });
      const execution = adapter.execute({
        invocationId: "cancel-invocation",
        task: {
          id: "cancel-task",
          input: z.string(),
          output: z.object({ result: z.string() }),
          goal: (input) => input,
        },
        input: "cancel",
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort(new Error("cancelled by test"));
      await expect(execution).rejects.toThrow(/cancelled|abort/i);
      expect(cancellationServer.requests.map(({ path }) => path)).not.toContain(
        "/session/session-2/message",
      );
    } finally {
      await cancellationServer.close();
    }

    const permissionServer = await startServer({ mode: "permission" });
    try {
      const adapter = createOpenCodeAdapter({
        url: permissionServer.url,
        structuredOutput: { strategy: "native" },
      });
      await expect(
        adapter.execute({
          invocationId: "permission-invocation",
          task: {
            id: "permission-task",
            input: z.string(),
            output: z.object({ result: z.string() }),
            goal: (input) => input,
          },
          input: "permission",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        name: "InteractionRequiredError",
        requirement: "user-input",
      });
      expect(permissionServer.requests.map(({ path }) => path)).not.toContain(
        "/session/session-2/message",
      );
    } finally {
      await permissionServer.close();
    }
  });
});
