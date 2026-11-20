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
    changedResponseModel: false,
    responseVariant: "high",
    omitResponseVariant: false,
    childSessions: [] as string[],
    pendingRequests: 0,
    maxPendingRequests: 0,
    createChildOnRootInterrupt: false,
    activeChildSessions: [] as string[],
    interruptedSessions: [] as string[],
    removedOwnedShell: false,
    sessionListCalls: 0,
    nonAdvancingCursor: false,
    usage: true,
    text: '{"answer":"ok"}',
    pending: "",
    runningTool: false,
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
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://fixture");
    const path = url.pathname;
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
        (path.startsWith("/api/session/") &&
          !path.slice("/api/session/".length).includes("/") &&
          req.method === "GET") ||
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
      return send({
        ...(state.active && !state.removed ? { ses_owned: {} } : {}),
        ...Object.fromEntries(state.activeChildSessions.map((id) => [id, {}])),
      });
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
      state.removedOwnedShell = true;
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
    if (path === "/api/session") {
      state.sessionListCalls += 1;
      if (
        state.nonAdvancingCursor &&
        url.searchParams.get("parentID") === "ses_owned"
      )
        return send({
          data: [],
          cursor: { next: `cursor-${state.sessionListCalls}` },
        });
      const children =
        url.searchParams.get("parentID") === "ses_owned"
          ? state.childSessions.map((id) => ({
              id,
              parentID: "ses_owned",
              location: { directory: workspace },
            }))
          : [];
      return send({ data: children, cursor: {} });
    }
    if (path.endsWith("/prompt")) {
      state.prompts++;
      return send({
        id: `usr_${state.prompts}`,
        sessionID: "ses_owned",
        type: "user",
      });
    }
    if (path.endsWith("/permission") || path.endsWith("/form")) {
      state.pendingRequests += 1;
      state.maxPendingRequests = Math.max(
        state.maxPendingRequests,
        state.pendingRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.pendingRequests -= 1;
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
        model: {
          ...model,
          id: state.changedResponseModel ? "changed" : model.id,
          ...(state.omitResponseVariant
            ? {}
            : { variant: state.responseVariant }),
        },
        time: {
          created: 1,
          ...(state.runningTool ? {} : { completed: 2 }),
        },
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
            time: {
              created: 1,
              ...(state.runningTool ? {} : { completed: 2 }),
            },
            state: { status: state.runningTool ? "running" : "completed" },
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
      const sessionID = path.split("/").at(-2);
      if (sessionID === "ses_owned") {
        state.active = false;
        if (state.createChildOnRootInterrupt) {
          state.createChildOnRootInterrupt = false;
          state.childSessions.push("ses_child");
          state.activeChildSessions.push("ses_child");
          state.shell = "ses_child";
        }
      } else if (sessionID !== undefined) {
        state.activeChildSessions = state.activeChildSessions.filter(
          (id) => id !== sessionID,
        );
      }
      if (sessionID !== undefined) state.interruptedSessions.push(sessionID);
      return send({});
    }
    if (path.startsWith("/api/session/")) {
      const sessionID = path.slice("/api/session/".length);
      if (req.method === "DELETE" && sessionID === "ses_owned") {
        state.removed = true;
        return send({});
      }
      if (sessionID === "ses_owned")
        return send({
          id: "ses_owned",
          location: { directory: workspace },
          model: {
            ...model,
            id: state.changedModel ? "changed" : model.id,
            variant: "high",
          },
        });
      if (state.childSessions.includes(sessionID))
        return send({
          id: sessionID,
          parentID: "ses_owned",
          location: { directory: workspace },
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
  it("submits task input that is absent from the goal and instructions", async () => {
    const h = await fixture();
    try {
      const input = { issue: 188, files: ["src/example.ts"], enabled: true };
      await expect(h.adapter.execute(request({ input }))).resolves.toEqual({
        answer: "ok",
      });
      const prompt = z
        .object({ text: z.string() })
        .parse(h.calls.find((call) => call.path.endsWith("/prompt"))?.body);
      expect(prompt.text).toContain(`Task input:\n${JSON.stringify(input)}`);
    } finally {
      await h.close();
    }
  });
  it.each([
    { name: "undefined", input: undefined },
    { name: "nested undefined", input: { value: undefined } },
    { name: "BigInt", input: { value: 1n } },
    { name: "NaN", input: { value: NaN } },
  ])(
    "rejects non-JSON task input before creating native work: $name",
    async ({ input }) => {
      const h = await fixture();
      try {
        await expect(
          h.adapter.execute(request({ input })),
        ).rejects.toMatchObject({ code: "configuration" });
        expect(h.state.creates).toBe(0);
        expect(h.state.prompts).toBe(0);
      } finally {
        await h.close();
      }
    },
  );
  it("rejects cyclic task input with the original cause", async () => {
    const h = await fixture();
    const input: { self?: unknown } = {};
    input.self = input;
    try {
      await expect(h.adapter.execute(request({ input }))).rejects.toMatchObject(
        { code: "configuration", cause: expect.any(Error) },
      );
      expect(h.state.creates).toBe(0);
    } finally {
      await h.close();
    }
  });
  it("bounds serialized task input by UTF-8 bytes before creating native work", async () => {
    const h = await fixture();
    try {
      await expect(
        h.adapter.execute(request({ input: "é".repeat(524_288) })),
      ).rejects.toMatchObject({ code: "limit" });
      expect(h.state.creates).toBe(0);
      expect(h.state.prompts).toBe(0);
    } finally {
      await h.close();
    }
  });
  it("accepts task input at the serialized JSON byte limit", async () => {
    const h = await fixture();
    try {
      const input = "é".repeat(524_287);
      await expect(h.adapter.execute(request({ input }))).resolves.toEqual({
        answer: "ok",
      });
      const prompt = z
        .object({ text: z.string() })
        .parse(h.calls.find((call) => call.path.endsWith("/prompt"))?.body);
      expect(prompt.text.includes(JSON.stringify(input))).toBe(true);
    } finally {
      await h.close();
    }
  });
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
  it("caps concurrent pending checks for a large session tree", async () => {
    const h = await fixture();
    try {
      h.state.childSessions = Array.from(
        { length: 39 },
        (_, index) => `ses_child_${index}`,
      );
      await expect(h.adapter.execute(request())).resolves.toEqual({
        answer: "ok",
      });
      expect(h.state.maxPendingRequests).toBeLessThanOrEqual(32);
    } finally {
      await h.close();
    }
  });
  it("rejects an assistant response from a different model", async () => {
    const h = await fixture();
    try {
      h.state.changedResponseModel = true;
      await expect(h.adapter.execute(request())).rejects.toMatchObject({
        code: "protocol",
      });
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it.each(["omitted", "mismatched"])(
    "rejects %s reasoning variants in assistant responses",
    async (variant) => {
      const h = await fixture();
      try {
        h.state.omitResponseVariant = variant === "omitted";
        h.state.responseVariant = "low";
        await expect(h.adapter.execute(request())).rejects.toMatchObject({
          code: "protocol",
        });
        expect(h.state.prompts).toBe(1);
        expect(h.state.removed).toBe(true);
      } finally {
        await h.close();
      }
    },
  );
  it("rejects a child cursor that advances without adding sessions", async () => {
    const h = await fixture();
    try {
      h.state.nonAdvancingCursor = true;
      await expect(h.adapter.execute(request())).rejects.toMatchObject({
        code: "termination",
      });
      expect(h.state.sessionListCalls).toBe(2);
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
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(1), {
        timeout: 4_000,
      });
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
  it.each(["permission", "form", "cancellation"])(
    "closes running tool activity after %s",
    async (mode) => {
      const h = await fixture();
      const controller = new AbortController();
      const onActivity =
        vi.fn<NonNullable<AgentAdapterRequest["onActivity"]>>();
      try {
        h.state.active = true;
        h.state.runningTool = true;
        const settled = h.adapter
          .execute(request({ signal: controller.signal, onActivity }))
          .catch((cause: unknown) => cause);
        await vi.waitFor(() => expect(onActivity).toHaveBeenCalled(), {
          timeout: 4000,
        });
        if (mode === "cancellation") controller.abort();
        else h.state.pending = mode;
        const result = await settled;
        expect(result).toBeInstanceOf(
          mode === "cancellation" ? Error : InteractionRequiredError,
        );
        expect(
          onActivity.mock.calls.map(([event]) => ({
            activityId: event.activityId,
            state: event.state,
          })),
        ).toEqual([
          { activityId: "tool_1", state: "started" },
          { activityId: "tool_1", state: "failed" },
        ]);
        expect(h.state.prompts).toBe(1);
        expect(h.state.removed).toBe(true);
      } finally {
        controller.abort();
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
  it("finds and stops a child session created during cancellation", async () => {
    const h = await fixture();
    try {
      h.state.active = true;
      h.state.createChildOnRootInterrupt = true;
      const controller = new AbortController();
      const pending = h.adapter.execute(request({ signal: controller.signal }));
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(0));
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(h.state.interruptedSessions).toContain("ses_child");
      expect(h.state.removedOwnedShell).toBe(true);
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
