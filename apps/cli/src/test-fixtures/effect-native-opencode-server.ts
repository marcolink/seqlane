import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";

const objectSchema = z.record(z.string(), z.unknown());
export const nativeFixtureResult = {
  done: false,
  count: 0,
  text: "",
  items: [""],
};

function respond(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readFixtureResponse(
  url: URL,
  history: ReadonlyMap<string, readonly unknown[]>,
  messages: ReadonlyMap<string, readonly unknown[]>,
): unknown {
  const provider = {
    id: "openai",
    models: { "fixture-model": { id: "fixture-model" } },
  };
  const defaults = { openai: "fixture-model" };
  if (url.pathname === "/global/health")
    return { healthy: true, version: "1.18.27" };
  if (url.pathname === "/provider")
    return { all: [provider], connected: ["openai"], default: defaults };
  if (url.pathname === "/config/providers")
    return { providers: [provider], default: defaults };
  const sessionId = /\/session\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
  if (url.pathname.endsWith("/history"))
    return {
      data: (history.get(sessionId) ?? []).slice(
        Number(url.searchParams.get("after") ?? 0),
      ),
      hasMore: false,
    };
  if (
    url.pathname.endsWith("/permission") ||
    url.pathname.endsWith("/question")
  )
    return { data: [] };
  return url.pathname.endsWith("/message")
    ? (messages.get(sessionId) ?? [])
    : [];
}

function createNativeMessage(
  sessionId: string,
  messageId: string,
  text: string,
) {
  const info = {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: 100, completed: 200 },
    parentID: "parent-message",
    modelID: "fixture-model",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: { cwd: "/fixture", root: "/fixture" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    structured: nativeFixtureResult,
  };
  const parts = ["filesystem.read", "skill"].map((tool, index) => ({
    id: `${messageId}-part-${index}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool" as const,
    callID: `${messageId}-call-${index}`,
    tool,
    state: {
      status: "completed",
      input: {
        name: "fixture-skill",
        enabled: false,
        count: 0,
        text: "",
        nested: { items: [""] },
      },
      output: JSON.stringify(nativeFixtureResult),
      metadata: {
        enabled: false,
        count: 0,
        text: "",
        nested: { items: [""] },
      },
      time: { start: 100, end: 200 },
    },
  }));
  return { info, parts: [...parts, { type: "text" as const, text }] };
}

function recordToolHistory(
  history: Map<string, unknown[]>,
  message: ReturnType<typeof createNativeMessage>,
  states: readonly ("running" | "completed")[],
): void {
  const sessionId = message.info.sessionID;
  const events = history.get(sessionId) ?? [];
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    for (const status of states) {
      const state =
        status === "running"
          ? {
              status,
              input: part.state.input,
              metadata: part.state.metadata,
              time: { start: 100 },
            }
          : { ...part.state, status };
      events.push({
        type: "message.part.updated",
        data: { sessionID: sessionId, part: { ...part, state } },
        durable: {
          aggregateID: sessionId,
          seq: events.length + 1,
          version: 1,
        },
      });
    }
  }
  history.set(sessionId, events);
}

/** A controlled HTTP peer; callers still use the installed OpenCode SDK. */
export async function startNativeOpenCodeServer(mode: "success" | "hold") {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const history = new Map<string, unknown[]>();
  const messages = new Map<string, unknown[]>();
  const pending = new Set<ServerResponse>();
  let nextSession = 0;
  let nextMessage = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body =
      text.length === 0 ? undefined : objectSchema.parse(JSON.parse(text));
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "", path: url.pathname, body });
    const sessionId = /\/session\/([^/]+)/.exec(url.pathname)?.[1];
    if (request.method === "GET") {
      respond(response, readFixtureResponse(url, history, messages));
      return;
    }
    if (url.pathname === "/session" || url.pathname.endsWith("/fork")) {
      respond(response, {
        id: `session-${++nextSession}`,
        directory: "/fixture",
      });
      return;
    }
    if (url.pathname.endsWith("/init")) {
      respond(response, true);
      return;
    }
    if (url.pathname.endsWith("/abort")) {
      for (const held of pending) held.destroy();
      pending.clear();
      respond(response, true);
      return;
    }
    if (sessionId !== undefined && url.pathname.endsWith("/message")) {
      if (mode === "hold") {
        const message = createNativeMessage(sessionId, "held-message", "");
        recordToolHistory(history, message, ["running"]);
        pending.add(response);
        return;
      }
      const messageId = `message-${++nextMessage}`;
      const message = createNativeMessage(
        sessionId,
        messageId,
        nextMessage === 1 && body?.format === undefined
          ? '{"done":"invalid-first-attempt"}'
          : JSON.stringify(nativeFixtureResult),
      );
      recordToolHistory(history, message, ["running", "completed"]);
      messages.set(sessionId, [...(messages.get(sessionId) ?? []), message]);
      respond(response, message);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture server has no TCP address");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const held of pending) held.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      );
    },
  };
}
