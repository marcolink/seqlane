// @test-scope ./runtime.ts
// @test-scope ./session.ts
// @test-scope ./completion.ts
// @test-scope ./client.ts
// @test-scope ./live-events.ts
// @test-scope ./live-event-dispatcher.ts
// @test-scope ./tracked-event-body.ts
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { defineTask } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenCodeV2AgentRuntimeFactory } from "./runtime.js";

const workspace = "/fixture";
const model = {
  providerID: "fixture",
  id: "fixture",
  enabled: true,
  capabilities: { tools: true },
  variants: [{ id: "high" }],
  variant: "high",
};
const task = defineTask({
  id: "parallel-live",
  input: z.object({}),
  output: z.object({ answer: z.string() }),
  execute: async () => ({ answer: "local" }),
});

async function fixture() {
  const events = new Set<ServerResponse>();
  const sessions = new Map<string, { done: boolean; reads: number }>();
  let connections = 0;
  let maximum = 0;
  let prompts = 0;
  const removed = new Set<string>();
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk;
    }
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const sessionID = path.split("/")[3] ?? "";
    const session = () => ({
      id: sessionID,
      location: { directory: workspace },
      model,
    });
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (path === "/api/event") {
      connections++;
      events.add(response);
      maximum = Math.max(maximum, events.size);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"id":"connected","type":"server.connected","data":{}}\n\n',
      );
      response.on("close", () => events.delete(response));
      return;
    }
    if (path === "/api/info")
      return send({ version: "2.1.2", pid: 1, urls: [] });
    if (path === "/api/model") return send({ data: [model] });
    if (path === "/api/model/default") return send({ data: model });
    if (path === "/api/shell") return send({ data: [] });
    if (path === "/api/session/active") return send({ data: {} });
    if (path === "/api/session" && request.method === "POST") {
      const id = `owned_${sessions.size}`;
      sessions.set(id, { done: false, reads: 0 });
      return send({ data: { id, location: { directory: workspace }, model } });
    }
    if (path === "/api/session") return send({ data: [], cursor: {} });
    if (request.method === "DELETE") {
      removed.add(sessionID);
      response.writeHead(204);
      response.end();
      return;
    }
    if (path.endsWith("/interrupt")) return send({});
    if (path.endsWith("/prompt")) {
      prompts++;
      return send({
        data: { id: `input_${sessionID}`, sessionID, type: "user" },
      });
    }
    if (path.endsWith("/permission") || path.endsWith("/form"))
      return send({ data: [] });
    if (path.endsWith("/message")) {
      const state = sessions.get(sessionID)!;
      state.reads++;
      return send({
        data: [
          ...(state.done
            ? [{ id: `idle_${sessionID}`, type: "idle", outcome: "succeeded" }]
            : []),
          {
            id: `assistant_${sessionID}`,
            type: "assistant",
            model,
            time: { created: 1, ...(state.done ? { completed: 2 } : {}) },
            content: [{ type: "text", text: '{"answer":"ok"}' }],
          },
          { id: `input_${sessionID}`, type: "user" },
        ],
        cursor: {},
      });
    }
    return send({ data: session() });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No fixture port");
  const controller = new AbortController();
  const runtime = await createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url: `http://127.0.0.1:${address.port}`,
    workspace,
  })(controller.signal, workspace);
  return {
    runtime,
    sessions,
    removed,
    get connections() {
      return connections;
    },
    get streams() {
      return events.size;
    },
    get maximum() {
      return maximum;
    },
    get prompts() {
      return prompts;
    },
    emit(sessionID: string, type = "session.tool.called") {
      for (const response of events)
        response.write(
          `data: ${JSON.stringify({ id: `event_${sessionID}_${type}`, type, data: { sessionID } })}\n\n`,
        );
    },
    async close() {
      controller.abort();
      await runtime.close?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("parallel adapters with shared native live events", () => {
  it("routes activity from one stream and preserves a peer through cancellation", async () => {
    const h = await fixture();
    const signals = [new AbortController(), new AbortController()];
    const pending = signals.map((controller) => {
      const adapter = h.runtime.createAdapter({ signal: controller.signal });
      const request: AgentAdapterRequest = {
        invocationId: "parallel-live",
        task,
        input: {},
        agent: { goal: "Return an answer" },
        signal: controller.signal,
        onExecutionStarted: vi.fn(),
      };
      return adapter.execute(request).catch((cause: unknown) => cause);
    });
    try {
      await vi.waitFor(() => {
        expect(h.sessions.size).toBe(2);
        for (const state of h.sessions.values()) expect(state.reads).toBe(1);
        expect(h.streams).toBe(1);
      });
      expect(h.connections).toBe(1);
      h.emit("owned_0");
      await vi.waitFor(() => expect(h.sessions.get("owned_0")?.reads).toBe(2), {
        timeout: 400,
      });
      expect(h.sessions.get("owned_1")?.reads).toBe(1);
      signals[0]!.abort();
      expect(await pending[0]).toBeInstanceOf(Error);
      expect(h.removed.has("owned_0")).toBe(true);
      expect(h.streams).toBe(1);
      h.emit("owned_1");
      await vi.waitFor(() => expect(h.sessions.get("owned_1")?.reads).toBe(2), {
        timeout: 400,
      });
      h.sessions.get("owned_1")!.done = true;
      h.emit("owned_1", "session.idle");
      expect(await pending[1]).toEqual({ answer: "ok" });
      await vi.waitFor(() => expect(h.streams).toBe(0));
      expect(h.connections).toBe(1);
      expect(h.maximum).toBe(1);
      expect(h.prompts).toBe(2);
    } finally {
      for (const signal of signals) signal.abort();
      await Promise.all(pending);
      await h.close();
    }
  });
});
