// @test-scope ./checkpoint.ts
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
// @test-scope ./questions.ts
import { once } from "node:events";
import { createServer } from "node:http";
import type {
  AgentAdapterRequest,
  UserInputAnswer,
} from "@seqlane/agent-adapter";
import { defineTask, InteractionRequiredError } from "@seqlane/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenCodeV2AgentRuntimeFactory } from "./runtime.js";
import { OpenCodeV2Error } from "./errors.js";

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
function questionForm() {
  return {
    id: "form_native",
    sessionID: "ses_owned",
    title: "Questions",
    metadata: {
      kind: "question",
      tool: { messageID: "msg_tool", id: "tool_question" },
    },
    fields: [
      {
        key: "q0",
        title: "Name Basic fixture-secret",
        description: "What name?",
        type: "string",
        custom: true,
        options: [],
      },
      {
        key: "q1",
        title: "Region",
        description: "Where?",
        type: "string",
        custom: true,
        options: [
          {
            label: "Europe Basic fixture-secret",
            description: "Nearby",
            value: "native value / Europe",
          },
        ],
      },
    ],
  };
}
function deferredAnswer() {
  let resolve!: (value: UserInputAnswer) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<UserInputAnswer>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const toolDetails: {
    input?: unknown;
    content?: unknown;
    metadata?: unknown;
  } = {};
  const calls: {
    method: string;
    path: string;
    body: unknown;
    auth: string | undefined;
  }[] = [];
  const sessions = new Map<
    string,
    { history: string[]; model: typeof model & { variant: string } }
  >();
  const state = {
    sessions,
    forks: 0,
    failForkModel: false,
    forkGate: undefined as Promise<void> | undefined,
    failSwitch: false,
    ignoreSwitch: false,
    removedRoots: [] as string[],
    toolDetails,
    nativeOverflow: false,
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
    question: false,
    questionOwner: "ses_owned",
    formList: [questionForm()] as unknown[],
    formDetail: { ...questionForm(), state: { status: "pending" } } as unknown,
    repeatForm: false,
    failFormCancel: false,
    failFormReply: false,
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
      if (
        req.method === "DELETE" ||
        (req.method === "POST" && path.endsWith("/model"))
      ) {
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
        path.endsWith("/fork") ||
        path.endsWith("/prompt") ||
        path.endsWith("/permission") ||
        path.endsWith("/form") ||
        path.includes("/form/");
      res.writeHead(200, { "content-type": "application/json" });
      const serialized = JSON.stringify(wrapped ? { data: value } : value);
      res.end(
        state.nativeOverflow
          ? serialized.replaceAll('"__native_overflow__"', "1e400")
          : serialized,
      );
    };
    if (path === "/api/info")
      return send({ version: state.version, pid: 1, urls: [] });
    if (path === "/api/model")
      return send({
        data: [model, { ...model, id: "branch", variants: [{ id: "low" }] }],
      });
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
      sessions.set("ses_owned", {
        history: [],
        model: { ...model, variant: "high" },
      });
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
    const nativeID = path.split("/")[3] ?? "";
    if (path.endsWith("/fork")) {
      const source = sessions.get(nativeID);
      if (!source) throw new Error("missing fork source");
      const id = `ses_fork_${++state.forks}`;
      sessions.set(id, {
        history: [...source.history],
        model: { ...source.model },
      });
      await state.forkGate;
      return send({
        id,
        location: { directory: workspace },
        model: state.failForkModel ? {} : source.model,
        fork: {
          sessionID: nativeID,
          boundary: { type: "through", messageID: "idle" },
        },
      });
    }
    if (path.endsWith("/model")) {
      if (state.failSwitch) {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      const selected = z
        .object({
          model: z.object({
            providerID: z.string(),
            id: z.string(),
            variant: z.string(),
          }),
        })
        .parse(value);
      const session = sessions.get(nativeID);
      if (session && !state.ignoreSwitch)
        session.model = { ...model, ...selected.model };
      return send({});
    }
    if (path.endsWith("/prompt")) {
      state.prompts++;
      sessions.get(nativeID)?.history.push(`usr_${state.prompts}`);
      return send({
        id: `usr_${state.prompts}`,
        sessionID: nativeID,
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
    if (path.includes("/form/")) {
      if (path.endsWith("/reply")) {
        if (state.failFormReply) {
          res.writeHead(503);
          res.end("unavailable");
          return;
        }
        if (!state.repeatForm) state.question = false;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        if (state.failFormCancel) {
          res.writeHead(503);
          res.end("unavailable");
          return;
        }
        state.question = false;
        return send({});
      }
      return send(state.formDetail);
    }
    if (path.endsWith("/form"))
      return send(
        state.question && path === `/api/session/${state.questionOwner}/form`
          ? state.formList
          : state.pending === "form"
            ? [{ id: "form_1" }]
            : [],
      );
    if (path.endsWith("/message")) {
      state.reads++;
      if (state.disconnect) {
        req.socket.destroy();
        return;
      }
      if (state.oversized) return send({ data: "x".repeat(1_048_576) });
      const inputID =
        sessions.get(nativeID)?.history.at(-1) ?? `usr_${state.prompts}`;
      const user = { id: inputID, type: "user" };
      if (state.delayed) return send({ data: [user], cursor: {} });
      const assistant = {
        id: `msg_${state.prompts}`,
        type: "assistant",
        model: {
          ...model,
          id: state.changedResponseModel
            ? "changed"
            : (sessions.get(nativeID)?.model.id ?? model.id),
          ...(state.omitResponseVariant
            ? {}
            : {
                variant:
                  nativeID === "ses_owned"
                    ? state.responseVariant
                    : sessions.get(nativeID)?.model.variant,
              }),
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
            state: {
              status: state.runningTool ? "running" : "completed",
              ...state.toolDetails,
            },
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
      if (req.method === "DELETE") {
        state.removedRoots.push(sessionID);
        sessions.delete(sessionID);
      }
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
      if (
        sessions.has(sessionID) ||
        (req.method === "DELETE" && sessionID.startsWith("ses_fork_"))
      )
        return send({
          id: sessionID,
          location: { directory: workspace },
          model: sessions.get(sessionID)?.model,
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
  it("retains immutable checkpoints across source reuse and two parallel forks", async () => {
    const h = await fixture();
    try {
      await h.adapter.execute(request());
      expect(h.state.forks).toBe(0);
      const checkpoint = await h.adapter.captureCheckpoint!();
      expect(h.state.forks).toBe(1);
      expect(await h.adapter.captureCheckpoint!()).toEqual(checkpoint);
      expect(h.state.forks).toBe(1);
      await h.adapter.execute(request());
      const [left, right] = await Promise.all([
        h.adapter.fork!({ checkpoint, modelSelection: selection }),
        h.adapter.fork!({ checkpoint }),
      ]);
      expect(h.state.prompts).toBe(2);
      expect(h.state.sessions.get("ses_fork_2")?.history).toEqual(["usr_1"]);
      expect(h.state.sessions.get("ses_fork_3")?.history).toEqual(["usr_1"]);
      await expect(left.fork!({ checkpoint })).rejects.toThrow(
        "checkpoint does not belong to this session",
      );
      expect(
        h.calls
          .filter((c) => c.path.endsWith("/fork"))
          .every(
            (c) => c.body === undefined || JSON.stringify(c.body) === "{}",
          ),
      ).toBe(true);
      await Promise.all([left.execute(request()), right.execute(request())]);
      expect(h.state.prompts).toBe(4);
      await h.runtime.close?.();
      expect(h.state.sessions.size).toBe(0);
    } finally {
      await h.close();
    }
  });
  it("rejects empty, busy, malformed, foreign, and closed checkpoints", async () => {
    const h = await fixture();
    const other = await fixture();
    try {
      await expect(h.adapter.captureCheckpoint!()).rejects.toThrow();
      await h.adapter.execute(request());
      const checkpoint = await h.adapter.captureCheckpoint!();
      await expect(other.adapter.fork!({ checkpoint })).rejects.toThrow();
      await expect(h.adapter.fork!({ checkpoint: {} })).rejects.toThrow();
      h.state.delayed = true;
      const pending = h.adapter.execute(request()).catch((cause) => cause);
      await vi.waitFor(() => expect(h.state.prompts).toBe(2));
      await expect(h.adapter.captureCheckpoint!()).rejects.toThrow();
      await h.runtime.close?.();
      await pending;
      await expect(h.adapter.captureCheckpoint!()).rejects.toThrow();
      await expect(h.adapter.fork!({ checkpoint })).rejects.toThrow();
    } finally {
      await h.close();
      await other.close();
    }
  });
  it("cleans a partially validated native fork and preserves successful output", async () => {
    const h = await fixture();
    try {
      h.state.failForkModel = true;
      await expect(h.adapter.execute(request())).resolves.toEqual({
        answer: "ok",
      });
      await expect(h.adapter.captureCheckpoint!()).rejects.toThrow();
      expect(h.state.removedRoots).toContain("ses_fork_1");
      h.state.failForkModel = false;
      await h.adapter.execute(request());
      const checkpoint = await h.adapter.captureCheckpoint!();
      h.state.failForkModel = true;
      await expect(h.adapter.fork!({ checkpoint })).rejects.toThrow();
      expect(h.state.removedRoots).toContain("ses_fork_3");
      expect(h.state.sessions.has("ses_owned")).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("cancels a fork without deleting its source, snapshot, or peer", async () => {
    const h = await fixture();
    try {
      await h.adapter.execute(request());
      const checkpoint = await h.adapter.captureCheckpoint!();
      const left = await h.adapter.fork!({ checkpoint });
      const right = await h.adapter.fork!({ checkpoint });
      h.state.delayed = true;
      const controller = new AbortController();
      const pending = left
        .execute(request({ signal: controller.signal }))
        .catch((cause) => cause);
      await vi.waitFor(() => expect(h.state.prompts).toBe(2));
      controller.abort();
      expect(await pending).toBeInstanceOf(Error);
      expect(h.state.removedRoots).toEqual(["ses_fork_2"]);
      h.state.delayed = false;
      await expect(right.execute(request())).resolves.toEqual({ answer: "ok" });
      await expect(h.adapter.fork!({ checkpoint })).resolves.toBeDefined();
    } finally {
      await h.close();
    }
  });
  it("switches the fork model and reasoning before execution without a prompt", async () => {
    const h = await fixture();
    try {
      await h.adapter.execute(request());
      const checkpoint = await h.adapter.captureCheckpoint!();
      const branch = await h.adapter.fork!({
        checkpoint,
        modelSelection: {
          model: { provider: "fixture", model: "branch" },
          reasoning: "low",
        },
      });
      expect(h.state.prompts).toBe(1);
      expect(h.state.sessions.get("ses_fork_2")?.model).toMatchObject({
        id: "branch",
        variant: "low",
      });
      await expect(branch.execute(request())).resolves.toEqual({
        answer: "ok",
      });
    } finally {
      await h.close();
    }
  });
  it.each(["failSwitch", "ignoreSwitch"] as const)(
    "cleans a fork after %s without affecting its checkpoint",
    async (key) => {
      const h = await fixture();
      try {
        await h.adapter.execute(request());
        const checkpoint = await h.adapter.captureCheckpoint!();
        h.state[key] = true;
        await expect(
          h.adapter.fork!({
            checkpoint,
            modelSelection: {
              model: { provider: "fixture", model: "branch" },
              reasoning: "low",
            },
          }),
        ).rejects.toThrow();
        expect(h.state.removedRoots).toEqual(["ses_fork_2"]);
        expect(h.state.prompts).toBe(1);
        h.state[key] = false;
        await expect(h.adapter.fork!({ checkpoint })).resolves.toBeDefined();
      } finally {
        await h.close();
      }
    },
  );
  it("closes a fork acquired while runtime cleanup starts", async () => {
    const h = await fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await h.adapter.execute(request());
      const checkpoint = await h.adapter.captureCheckpoint!();
      h.state.forkGate = gate;
      const pending = h.adapter.fork!({ checkpoint }).catch((cause) => cause);
      await vi.waitFor(() => expect(h.state.forks).toBe(2));
      const closing = h.runtime.close?.();
      release();
      expect(await pending).toBeInstanceOf(Error);
      await closing;
      expect(h.state.sessions.size).toBe(0);
    } finally {
      release();
      await h.close();
    }
  });
  it("closes a snapshot acquired while runtime cleanup starts", async () => {
    const h = await fixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await h.adapter.execute(request());
      h.state.forkGate = gate;
      const pending = h.adapter.captureCheckpoint!().catch((cause) => cause);
      await vi.waitFor(() => expect(h.state.forks).toBe(1));
      await expect(h.adapter.execute(request())).rejects.toThrow();
      const closing = h.runtime.close?.();
      release();
      expect(await pending).toBeInstanceOf(Error);
      await closing;
      expect(h.state.sessions.size).toBe(0);
    } finally {
      release();
      await h.close();
    }
  });
  it("pauses for a native question, redacts display text, and resumes one prompt", async () => {
    const h = await fixture();
    try {
      h.state.question = true;
      const answer = deferredAnswer();
      const callback = vi.fn<
        NonNullable<AgentAdapterRequest["requestUserInput"]>
      >(() => answer.promise);
      const done = vi.fn();
      const execution = h.adapter
        .execute(request({ requestUserInput: callback }))
        .then(done);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(done).not.toHaveBeenCalled();
      expect(h.state.prompts).toBe(1);
      const question = callback.mock.calls[0]![0];
      expect(JSON.stringify(question)).not.toContain("fixture-secret");
      expect(JSON.stringify(question)).toContain("[REDACTED]");
      expect(question.questions).toMatchObject([
        { id: "question_0", allowFreeText: true },
        {
          id: "question_1",
          options: [{ value: "option_0" }],
          allowFreeText: true,
        },
      ]);
      answer.resolve({
        status: "answered",
        answers: { question_0: "Ada", question_1: "option_0" },
      });
      await execution;
      expect(done).toHaveBeenCalledWith({ answer: "ok" });
      expect(
        h.calls.filter((call) => call.path.endsWith("/reply")),
      ).toMatchObject([
        {
          path: "/api/session/ses_owned/form/form_native/reply",
          body: { answer: { q0: "Ada", q1: "native value / Europe" } },
        },
      ]);
      expect(h.state.prompts).toBe(1);
      expect(h.adapter.capabilities.userInput).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("deduplicates repeated form IDs and snapshots", async () => {
    const h = await fixture();
    try {
      h.state.question = true;
      h.state.repeatForm = true;
      h.state.active = true;
      h.state.formList.push(questionForm());
      const callback = vi.fn().mockResolvedValue({
        status: "answered",
        answers: { question_0: "Ada", question_1: "custom region" },
      });
      const execution = h.adapter.execute(
        request({ requestUserInput: callback }),
      );
      await vi.waitFor(() => expect(h.state.reads).toBeGreaterThan(1), {
        timeout: 4000,
      });
      h.state.active = false;
      await execution;
      expect(callback).toHaveBeenCalledTimes(1);
      expect(
        h.calls.filter((call) => call.path.endsWith("/reply")),
      ).toHaveLength(1);
      expect(
        h.calls.filter((call) => call.path.endsWith("/form/form_native")),
      ).toHaveLength(1);
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it("answers only the child session that owns the question", async () => {
    const h = await fixture();
    try {
      h.state.question = true;
      h.state.childSessions = ["ses_child"];
      h.state.questionOwner = "ses_child";
      const form = { ...questionForm(), sessionID: "ses_child" };
      h.state.formList = [form];
      h.state.formDetail = { ...form, state: { status: "pending" } };
      await h.adapter.execute(
        request({
          requestUserInput: async () => ({
            status: "answered",
            answers: { question_0: "Ada", question_1: "custom" },
          }),
        }),
      );
      expect(
        h.calls.filter((call) => call.path.endsWith("/reply")),
      ).toMatchObject([
        { path: "/api/session/ses_child/form/form_native/reply" },
      ]);
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it.each([
    "list-owner",
    "detail-owner",
    "detail-id",
    "detail-state",
    "detail-fields",
    "optional-field",
  ])("rejects malformed question %s", async (mode) => {
    const h = await fixture();
    try {
      h.state.question = true;
      if (mode === "list-owner")
        h.state.formList = [{ ...questionForm(), sessionID: "ses_unrelated" }];
      if (mode === "detail-owner")
        h.state.formDetail = {
          ...questionForm(),
          sessionID: "ses_unrelated",
          state: { status: "pending" },
        };
      if (mode === "detail-id")
        h.state.formDetail = {
          ...questionForm(),
          id: "other",
          state: { status: "pending" },
        };
      if (mode === "detail-state")
        h.state.formDetail = {
          ...questionForm(),
          state: { status: "invalid" },
        };
      if (mode === "detail-fields")
        h.state.formDetail = {
          ...questionForm(),
          fields: [{ key: "q0", type: "multiselect" }],
          state: { status: "pending" },
        };
      if (mode === "optional-field") {
        const form = questionForm();
        h.state.formDetail = {
          ...form,
          fields: form.fields.map((field) => ({ ...field, required: false })),
          state: { status: "pending" },
        };
      }
      const callback = vi.fn();
      await expect(
        h.adapter.execute(request({ requestUserInput: callback })),
      ).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(false);
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it.each(["abort", "timeout", "callback-timeout", "cancel-failure"])(
    "cancels the native form before owned cleanup after %s",
    async (mode) => {
      const h = await fixture();
      const controller = new AbortController();
      try {
        h.state.question = true;
        h.state.failFormCancel = mode === "cancel-failure";
        const late = deferredAnswer();
        const callback = vi.fn(() => late.promise);
        const execution = h.adapter
          .execute(
            request({
              requestUserInput: callback,
              signal:
                mode === "timeout"
                  ? AbortSignal.timeout(200)
                  : controller.signal,
            }),
          )
          .catch((cause: unknown) => cause);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
        if (mode === "callback-timeout")
          late.reject(new Error("input deadline"));
        else if (mode !== "timeout") controller.abort();
        const error = await execution;
        expect(error).toBeInstanceOf(Error);
        if (mode === "cancel-failure")
          expect(error).toMatchObject({
            code: "termination",
            cause: expect.any(AggregateError),
          });
        const cancel = h.calls.findIndex(
          (call) =>
            call.path.endsWith("/form/form_native") && call.method === "DELETE",
        );
        const interrupt = h.calls.findIndex((call) =>
          call.path.endsWith("/interrupt"),
        );
        expect(cancel).toBeGreaterThan(-1);
        expect(interrupt).toBeGreaterThan(cancel);
        expect(h.state.removed).toBe(true);
        late.resolve({
          status: "answered",
          answers: { question_0: "late", question_1: "late" },
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(
          false,
        );
        expect(h.state.prompts).toBe(1);
      } finally {
        controller.abort();
        await h.close();
      }
    },
  );
  it("rejects permissions even with a question callback", async () => {
    const h = await fixture();
    try {
      h.state.pending = "permission";
      h.state.question = true;
      const callback = vi.fn();
      await expect(
        h.adapter.execute(request({ requestUserInput: callback })),
      ).rejects.toBeInstanceOf(InteractionRequiredError);
      expect(callback).not.toHaveBeenCalled();
      expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(false);
      expect(h.state.removed).toBe(true);
    } finally {
      await h.close();
    }
  });
  it.each([
    { status: "cancelled" },
    { status: "answered", answers: {} },
    {
      status: "answered",
      answers: { question_0: "Ada", question_1: ["option_0"] },
    },
    {
      status: "answered",
      answers: { question_0: "Ada", question_1: "option_0", extra: "bad" },
    },
  ])(
    "cancels malformed callback answers without a native reply",
    async (answer) => {
      const h = await fixture();
      try {
        h.state.question = true;
        await expect(
          h.adapter.execute(
            request({ requestUserInput: vi.fn().mockResolvedValue(answer) }),
          ),
        ).rejects.toThrow();
        expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(
          false,
        );
        expect(
          h.calls.some(
            (call) =>
              call.path.endsWith("/form/form_native") &&
              call.method === "DELETE",
          ),
        ).toBe(true);
        expect(h.state.removed).toBe(true);
        expect(h.state.prompts).toBe(1);
      } finally {
        await h.close();
      }
    },
  );
  it("never retries a failed native reply", async () => {
    const h = await fixture();
    try {
      h.state.question = true;
      h.state.failFormReply = true;
      const callback = vi.fn().mockResolvedValue({
        status: "answered",
        answers: { question_0: "Ada", question_1: "option_0" },
      });
      await expect(
        h.adapter.execute(request({ requestUserInput: callback })),
      ).rejects.toThrow();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(
        h.calls.filter((call) => call.path.endsWith("/reply")),
      ).toHaveLength(1);
      expect(h.state.removed).toBe(true);
      expect(h.state.prompts).toBe(1);
    } finally {
      await h.close();
    }
  });
  it.each(["answered", "cancelled"])(
    "does not answer a native form that is already %s",
    async (status) => {
      const h = await fixture();
      try {
        h.state.question = true;
        h.state.formDetail = { ...questionForm(), state: { status } };
        const callback = vi.fn();
        await expect(
          h.adapter.execute(request({ requestUserInput: callback })),
        ).resolves.toEqual({ answer: "ok" });
        expect(callback).not.toHaveBeenCalled();
        expect(h.calls.some((call) => call.path.endsWith("/reply"))).toBe(
          false,
        );
      } finally {
        await h.close();
      }
    },
  );
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
        checkpoint: true,
        fork: true,
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
  it.each(["input", "content", "metadata"] as const)(
    "rejects a configured credential in nested tool %s keys with a safe typed error",
    async (field) => {
      const h = await fixture();
      try {
        const nested = {
          wrapper: [{ "prefix-Basic fixture-secret-suffix": "detail" }],
        };
        h.state.toolDetails[field] = field === "content" ? [nested] : nested;
        const onActivity = vi.fn();
        const onObservation = vi.fn();
        const onMetrics = vi.fn();
        const execution = h.adapter.execute(
          request({ onActivity, onObservation, onMetrics }),
        );
        await expect(execution).rejects.toBeInstanceOf(OpenCodeV2Error);
        await expect(execution).rejects.toMatchObject({
          code: "protocol",
          message:
            "OpenCode V2: native observation contains a credential in a property name",
          cause: undefined,
        });
        expect(onActivity).not.toHaveBeenCalled();
        expect(onObservation).not.toHaveBeenCalled();
        expect(onMetrics).not.toHaveBeenCalled();
        expect(h.state.prompts).toBe(1);
        expect(h.state.removed).toBe(true);
      } finally {
        await h.close();
      }
    },
  );
  it.each(["input", "content", "metadata"] as const)(
    "rejects overflowing JSON numbers in tool %s before observation callbacks",
    async (field) => {
      const h = await fixture();
      try {
        h.state.nativeOverflow = true;
        const value = { overflow: "__native_overflow__" };
        h.state.toolDetails[field] = field === "content" ? [value] : value;
        const onActivity = vi.fn();
        const onObservation = vi.fn();
        const onMetrics = vi.fn();
        await expect(
          h.adapter.execute(request({ onActivity, onObservation, onMetrics })),
        ).rejects.toMatchObject({
          code: "protocol",
          message: "OpenCode V2: native observation contains invalid JSON data",
        });
        expect(onActivity).not.toHaveBeenCalled();
        expect(onObservation).not.toHaveBeenCalled();
        expect(onMetrics).not.toHaveBeenCalled();
        expect(h.state.prompts).toBe(1);
        expect(h.state.removed).toBe(true);
      } finally {
        await h.close();
      }
    },
  );
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
