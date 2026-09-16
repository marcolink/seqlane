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
import type { AgentTaskRequest, TaskDefinition } from "@seqlane/core";
import { createOpenCodeAdapter } from "./adapter.js";

function adapterTask(id: string): TaskDefinition {
  return {
    id,
    input: z.string(),
    output: z.object({ result: z.string() }),
    execute: async () => ({ result: "done" }),
  };
}

const adapterAgent: AgentTaskRequest = {
  goal: "Complete the controlled input",
};

interface RequestRecord {
  readonly method: string;
  readonly url: string;
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

function handleReadRequest(
  method: string | undefined,
  requestUrl: URL,
  response: ServerResponse,
  eventsBySession: ReadonlyMap<string, Record<string, unknown>[]>,
  pendingPermissions: ReadonlySet<string>,
): boolean {
  if (method !== "GET") return false;
  if (requestUrl.pathname === "/global/health") {
    writeJson(response, { healthy: true, version: "1.14.19" });
    return true;
  }

  const historyMatch = /^\/api\/session\/(session-\d+)\/history$/.exec(
    requestUrl.pathname,
  );
  if (historyMatch) {
    const sessionId = historyMatch[1] ?? "";
    const after = Number(requestUrl.searchParams.get("after") ?? 0);
    writeJson(response, {
      data: (eventsBySession.get(sessionId) ?? []).slice(after),
      hasMore: false,
    });
    return true;
  }

  const permissionMatch = /^\/api\/session\/(session-\d+)\/permission$/.exec(
    requestUrl.pathname,
  );
  if (permissionMatch) {
    const sessionId = permissionMatch[1] ?? "";
    writeJson(response, {
      data: pendingPermissions.has(sessionId)
        ? [{ id: "controlled-permission", sessionID: sessionId }]
        : [],
    });
    return true;
  }

  if (/^\/api\/session\/(session-\d+)\/question$/.test(requestUrl.pathname)) {
    writeJson(response, { data: [] });
    return true;
  }
  if (/^\/session\/(session-\d+)(?:\/message)?$/.test(requestUrl.pathname)) {
    writeJson(response, []);
    return true;
  }
  return false;
}

async function startServer(
  options: { readonly mode?: "success" | "hold" | "permission" } = {},
): Promise<{
  readonly promptStarted: Promise<void>;
  readonly abortStarted: Promise<void>;
  readonly requests: RequestRecord[];
  readonly url: string;
  close(): Promise<void>;
}> {
  const requests: RequestRecord[] = [];
  const eventsBySession = new Map<string, Record<string, unknown>[]>();
  const pendingPermissions = new Set<string>();
  const pendingPrompts = new Map<string, ServerResponse>();
  let resolvePromptStarted: () => void = () => undefined;
  const promptStarted = new Promise<void>((resolve) => {
    resolvePromptStarted = resolve;
  });
  let resolveAbortStarted: () => void = () => undefined;
  const abortStarted = new Promise<void>((resolve) => {
    resolveAbortStarted = resolve;
  });
  let nextSession = 0;
  let nextMessage = 0;

  const sendEvent = (sessionId: string, event: Record<string, unknown>) => {
    const events = eventsBySession.get(sessionId) ?? [];
    const { properties, ...envelope } = event;
    const recorded = {
      ...envelope,
      data: {
        sessionID: sessionId,
        ...((properties as object) ?? {}),
      },
      durable: {
        aggregateID: sessionId,
        seq: events.length + 1,
        version: 1,
      },
    };
    events.push(recorded);
    eventsBySession.set(sessionId, events);
  };

  const server: Server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "/",
      path: requestUrl.pathname,
      body,
    });

    if (
      handleReadRequest(
        request.method,
        requestUrl,
        response,
        eventsBySession,
        pendingPermissions,
      )
    )
      return;

    if (request.method === "POST" && requestUrl.pathname === "/session") {
      nextSession += 1;
      writeJson(response, {
        id: `session-${nextSession}`,
        directory: "/controlled",
      });
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
      resolvePromptStarted();
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
        pendingPermissions.add(sessionId);
        sendEvent(sessionId, {
          type: "permission.asked",
          properties: { callID: "controlled-permission" },
        });
        pendingPrompts.set(sessionId, response);
        return;
      }
      nextMessage += 1;
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
        info: responseInfo(sessionId, `message-${sessionId}-${nextMessage}`, {
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
      resolveAbortStarted();
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
    promptStarted,
    abortStarted,
    requests,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
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
        observability: {},
        task: adapterTask("controlled-opencode-task"),
        agent: adapterAgent,
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
            url: expect.stringContaining("directory=%2Fconfigured-workspace"),
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

  it("reuses the selected session, then forks from its latest checkpoint", async () => {
    const server = await startServer();
    try {
      const adapter = createOpenCodeAdapter({
        url: server.url,
        structuredOutput: { strategy: "native" },
      });
      const request = {
        invocationId: "reuse-invocation",
        observability: {},
        task: adapterTask("reuse-task"),
        agent: adapterAgent,
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
            body: { messageID: "message-session-1-2" },
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
        observability: {},
        task: adapterTask("cancel-task"),
        agent: adapterAgent,
        input: "cancel",
        signal: controller.signal,
      });
      await cancellationServer.promptStarted;
      controller.abort(new Error("cancelled by test"));
      await cancellationServer.abortStarted;
      await expect(execution).rejects.toThrow(/cancelled|abort/i);
      expect(cancellationServer.requests.map(({ path }) => path)).toContain(
        "/session/session-1/abort",
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
          observability: {},
          task: adapterTask("permission-task"),
          agent: adapterAgent,
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
