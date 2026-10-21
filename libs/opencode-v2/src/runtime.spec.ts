// @test-scope ./runtime.ts
// @test-scope ./client.ts
// @test-scope ./models.ts
// @test-scope ./session.ts
// @test-scope ./session-model.ts
// @test-scope ./completion.ts
// @test-scope ./messages.ts
// @test-scope ./schemas.ts
// @test-scope ./owned-work.ts
// @test-scope ./prompt.ts
// @test-scope ./observations.ts
import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentAdapterRequest } from "@seqlane/agent-adapter";
import { defineTask, InteractionRequiredError } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenCodeV2AgentRuntimeFactory } from "./runtime.js";

const workspace = process.cwd();
const selection = {
  model: { provider: "fixture", model: "fixture" },
  reasoning: "high" as const,
};
const model = {
  providerID: "fixture",
  id: "fixture",
  enabled: true,
  capabilities: { tools: true },
  variants: [{ id: "high" }],
};
const output = z.object({ answer: z.string() });
const task = defineTask({
  id: "v2-test",
  input: z.object({}),
  output,
  execute: async () => ({ answer: "local" }),
});
function request(
  overrides: Partial<AgentAdapterRequest> = {},
): AgentAdapterRequest {
  return {
    invocationId: "v2-test",
    task,
    input: {},
    agent: {
      goal: "Return an answer",
      instructions: ["Use repository context"],
    },
    signal: AbortSignal.timeout(5000),
    onExecutionStarted: vi.fn(),
    ...overrides,
  };
}
async function fixture() {
  const calls: {
    method: string;
    path: string;
    body: unknown;
    auth: string | undefined;
  }[] = [];
  const state = {
    version: "2.1.2",
    changedModel: false,
    usage: true,
    text: '{"answer":"ok"}',
    pending: "",
    delayed: false,
    malformed: false,
    disconnect: false,
    wrongInput: false,
    shell: "",
    active: false,
    removed: false,
    reads: 0,
    prompts: 0,
    creates: 0,
    failCleanup: false,
    oversized: false,
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    const value: unknown = body.length === 0 ? undefined : JSON.parse(body);
    calls.push({
      method: req.method ?? "GET",
      path,
      body: value,
      auth: req.headers.authorization,
    });
    const send = (value: unknown) => {
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      const wrapped =
        path === "/api/session/active" ||
        path === "/api/session/ses_owned" ||
        (path === "/api/session" && req.method === "POST") ||
        path.endsWith("/prompt") ||
        path.endsWith("/permission") ||
        path.endsWith("/form");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(wrapped ? { data: value } : value));
    };
    if (path === "/api/info")
      return send({ version: state.version, pid: 1, urls: [] });
    if (path === "/api/model") return send({ data: [model] });
    if (path === "/api/model/default") return send({ data: model });
    if (path === "/api/session/active")
      return send(state.active && !state.removed ? { ses_owned: {} } : {});
    if (path === "/api/shell")
      return send({
        data:
          state.shell && !state.removed
            ? [
                {
                  id: "sh_owned",
                  status: "running",
                  metadata:
                    state.shell === "unknown" ? {} : { sessionID: state.shell },
                },
              ]
            : [],
      });
    if (path === "/api/shell/sh_owned" && req.method === "DELETE") {
      state.shell = "";
      return send({});
    }
    if (path === "/api/session" && req.method === "POST") {
      state.creates++;
      return send({
        id: "ses_owned",
        location: { directory: workspace },
        model: { ...model, variant: "high" },
      });
    }
    if (path === "/api/session") return send({ data: [], cursor: {} });
    if (path.endsWith("/prompt")) {
      state.prompts++;
      return send({
        id: `usr_${state.prompts}`,
        sessionID: "ses_owned",
        type: "user",
      });
    }
    if (path.endsWith("/permission"))
      return send(
        state.pending === "permission" ? [{ id: "permission_1" }] : [],
      );
    if (path.endsWith("/form"))
      return send(state.pending === "form" ? [{ id: "form_1" }] : []);
    if (path.endsWith("/message")) {
      state.reads++;
      if (state.disconnect) {
        req.socket.destroy();
        return;
      }
      if (state.oversized) return send({ data: "x".repeat(1_048_576) });
      const user = { id: `usr_${state.prompts}`, type: "user" };
      if (state.delayed) return send({ data: [user], cursor: {} });
      const assistant = {
        id: `msg_${state.prompts}`,
        type: "assistant",
        model,
        time: { created: 1, completed: 2 },
        ...(state.usage
          ? {
              cost: 0.01,
              tokens: {
                input: 10,
                output: 5,
                reasoning: 2,
                cache: { read: 3, write: 4 },
              },
            }
          : {}),
        content: [
          { type: "text", text: state.text },
          {
            id: `tool_${state.prompts}`,
            type: "tool",
            name: "read",
            time: { created: 1, completed: 2 },
            state: { status: "completed" },
          },
        ],
      };
      return send({
        data: state.malformed
          ? [{ type: "assistant", id: "bad" }]
          : [
              { id: "idle", type: "idle", outcome: "succeeded" },
              assistant,
              ...(state.wrongInput ? [{ id: "other", type: "user" }] : []),
              user,
            ],
        cursor: {},
      });
    }
    if (path.endsWith("/interrupt")) {
      if (state.failCleanup) {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      state.active = false;
      return send({});
    }
    if (path === "/api/session/ses_owned") {
      if (req.method === "DELETE") {
        state.removed = true;
        return send({});
      }
      return send({
        id: "ses_owned",
        location: { directory: workspace },
        model: {
          ...model,
          id: state.changedModel ? "changed" : model.id,
          variant: "high",
        },
      });
    }
    res.writeHead(404);
    res.end(path);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no fixture address");
  const url = `http://127.0.0.1:${address.port}`;
  const factory = createOpenCodeV2AgentRuntimeFactory({
    adapter: "opencode-v2",
    url,
    authorization: "Basic fixture-secret",
  });
  const runtime = await factory(new AbortController().signal, workspace);
  const adapter = runtime.redactAdapter(
    runtime.createAdapter({
      signal: new AbortController().signal,
      modelSelection: selection,
    }),
  );
  return {
    state,
    calls,
    url,
    runtime,
    adapter,
    async close() {
      await runtime.close?.().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("OpenCode V2 real-client execution", () => {
  it("applies the model, validates JSON, maps observations, and reuses one session", async () => {
    const h = await fixture();
    try {
      const onMetrics = vi.fn();
      const onActivity = vi.fn();
      const onObservation = vi.fn();
      const first = request({ onMetrics, onActivity, onObservation });
      await expect(h.adapter.execute(first)).resolves.toEqual({ answer: "ok" });
      await expect(h.adapter.execute(request())).resolves.toEqual({
        answer: "ok",
      });
      expect(first.onExecutionStarted).toHaveBeenCalledTimes(1);
      expect(h.state.creates).toBe(1);
      expect(h.state.prompts).toBe(2);
      expect(
        h.calls.find(
          (call) => call.path === "/api/session" && call.method === "POST",
        )?.body,
      ).toMatchObject({
        location: { directory: workspace },
        model: { providerID: "fixture", id: "fixture", variant: "high" },
      });
      expect(
        h.calls.find((call) => call.path.endsWith("/prompt"))?.body,
      ).toMatchObject({
        text: expect.stringContaining("Use repository context"),
      });
      expect(
        h.calls.every((call) => call.auth === "Basic fixture-secret"),
      ).toBe(true);
      expect(onMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cacheRead: 3,
            cacheWrite: 4,
          },
          cost: 0.01,
        }),
      );
      expect(onActivity.mock.calls.map(([event]) => event.state)).toEqual([
        "started",
        "succeeded",
      ]);
      expect(onObservation).toHaveBeenCalledTimes(1);
      expect(h.adapter.capabilities).toMatchObject({
        checkpoint: false,
        fork: false,
        sessionUi: false,
      });
      await h.runtime.close?.();
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("deduplicates repeated snapshots and isolates consumer callback failures", async () => {
    const h = await fixture();
    try {
      h.state.active = true;
      const onObservation = vi.fn(() => {
        throw new Error("consumer failed");
      });
      const onActivity = vi.fn(() => {
        throw new Error("consumer failed");
      });
      const onMetrics = vi.fn();
      const pending = h.adapter.execute(
        request({ onObservation, onActivity, onMetrics }),
      );
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(1));
      h.state.active = false;
      await expect(pending).resolves.toEqual({ answer: "ok" });
      expect(onObservation).toHaveBeenCalledTimes(1);
      expect(onActivity).toHaveBeenCalledTimes(2);
      expect(onMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ cost: 0.01 }),
      );
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it("preserves absent usage and redacts the connection credential in observations", async () => {
    const h = await fixture();
    try {
      h.state.usage = false;
      h.state.text = JSON.stringify({ answer: "Basic fixture-secret" });
      const onMetrics = vi.fn();
      const onObservation = vi.fn();
      await h.adapter.execute(request({ onMetrics, onObservation }));
      expect(onMetrics).toHaveBeenCalledWith({
        provider: "fixture",
        model: "fixture",
      });
      expect(JSON.stringify(onObservation.mock.calls)).not.toContain(
        "fixture-secret",
      );
      expect(JSON.stringify(onObservation.mock.calls)).toContain("[REDACTED]");
    } finally {
      await h.close();
    }
  });
  it("does not treat admission as completion or retry submission", async () => {
    const h = await fixture();
    try {
      h.state.delayed = true;
      const done = vi.fn();
      const pending = h.adapter.execute(request()).then(done);
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(0));
      expect(done).not.toHaveBeenCalled();
      h.state.delayed = false;
      await pending;
      expect(done).toHaveBeenCalledWith({ answer: "ok" });
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it.each(["permission", "form"])(
    "fails pending %s without replying",
    async (pending) => {
      const h = await fixture();
      try {
        h.state.pending = pending;
        await expect(h.adapter.execute(request())).rejects.toBeInstanceOf(
          InteractionRequiredError,
        );
        expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(
          false,
        );
        expect(h.state.removed).toBe(true);
      } finally {
        await h.close();
      }
    },
  );
  it.each([
    '```json\n{"answer":"ok"}\n```',
    '{"answer":2}',
    '{"answer":"ok"} trailing',
    "",
  ])("rejects invalid output %j without repair", async (text) => {
    const h = await fixture();
    try {
      h.state.text = text;
      await expect(h.adapter.execute(request())).rejects.toMatchObject({
        code: "output",
      });
      expect(h.state.prompts).toBe(1);
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it.each(["malformed", "disconnect", "wrongInput", "oversized"] as const)(
    "fails %s without replay",
    async (key) => {
      const h = await fixture();
      try {
        h.state[key] = true;
        await expect(h.adapter.execute(request())).rejects.toThrow();
        expect(h.state.prompts).toBe(1);
        expect(h.state.removed).toBe(true);
        await expect(h.adapter.execute(request())).rejects.toThrow(
          "unavailable",
        );
      } finally {
        await h.close();
      }
    },
  );
  it("waits for owned background work and cancels only owned work", async () => {
    const h = await fixture();
    try {
      h.state.shell = "ses_owned";
      h.state.active = true;
      const controller = new AbortController();
      const finished = vi.fn();
      const pending = h.adapter
        .execute(request({ signal: controller.signal }))
        .then(finished, (cause) => cause);
      await vi.waitFor(() =>
        expect(h.calls.some((call) => call.path === "/api/shell")).toBe(true),
      );
      expect(finished).not.toHaveBeenCalled();
      controller.abort();
      await pending;
      expect(
        h.calls.some(
          (call) =>
            call.path === "/api/shell/sh_owned" && call.method === "DELETE",
        ),
      ).toBe(true);
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("preserves unrelated shells and reports unknown ownership", async () => {
    const h = await fixture();
    try {
      h.state.shell = "ses_unrelated";
      await expect(h.adapter.execute(request())).resolves.toEqual({
        answer: "ok",
      });
      expect(
        h.calls.some(
          (call) =>
            call.path === "/api/shell/sh_owned" && call.method === "DELETE",
        ),
      ).toBe(false);
      h.state.shell = "unknown";
      const onUncertainActivity = vi.fn();
      await expect(
        h.adapter.execute(request({ onUncertainActivity })),
      ).rejects.toMatchObject({ code: "termination" });
      expect(onUncertainActivity).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });
  it("close cancels an active invocation, then confirms cleanup", async () => {
    const h = await fixture();
    try {
      h.state.delayed = true;
      const pending = h.adapter.execute(request()).catch((cause) => cause);
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(0));
      await h.runtime.close?.();
      await pending;
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("rejects model changes and unknown reasoning before another prompt", async () => {
    const h = await fixture();
    try {
      await h.adapter.execute(request());
      await expect(
        h.adapter.execute(
          request({ modelSelection: { model: selection.model } }),
        ),
      ).rejects.toThrow("reuse cannot change");
      expect(h.state.prompts).toBe(1);
      await expect(
        h.runtime.modelCapabilities?.validateModelSelection?.({
          ...selection,
          reasoning: "low",
        }),
      ).rejects.toThrow("variant");
    } finally {
      await h.close();
    }
  });
  it("rejects a native model change before reusing the session", async () => {
    const h = await fixture();
    try {
      await h.adapter.execute(request());
      h.state.changedModel = true;
      await expect(h.adapter.execute(request())).rejects.toThrow(
        "changed the selected model",
      );
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it("rejects unproved versions before creating a session", async () => {
    const h = await fixture();
    try {
      h.state.version = "2.1.3";
      await expect(
        createOpenCodeV2AgentRuntimeFactory({
          adapter: "opencode-v2",
          url: h.url,
        })(new AbortController().signal, workspace),
      ).rejects.toMatchObject({ code: "compatibility" });
      expect(h.state.creates).toBe(0);
    } finally {
      await h.close();
    }
  });
  it.each([
    { adapter: "opencode-v2", url: "http://user:password@localhost" },
    { adapter: "opencode-v2", url: "http://localhost", unknown: true },
    { adapter: "opencode", url: "http://localhost" },
  ])("rejects invalid configuration before HTTP", (value) => {
    expect(() => createOpenCodeV2AgentRuntimeFactory(value)).toThrow();
  });
});
