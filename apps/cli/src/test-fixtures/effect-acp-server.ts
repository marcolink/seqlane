import { appendFileSync } from "node:fs";
import { z } from "zod";

const jsonRpcMessageSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const environmentSchema = z.strictObject({
  mode: z.enum([
    "success",
    "hold",
    "permission",
    "missing-model",
    "invalid-first",
  ]),
  trace: z.string().min(1),
  persist: z.enum(["true", "false"]).transform((value) => value === "true"),
});
const configOptions = (model: string, includeFixtureModel: boolean) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "fixture-default", name: "Default" },
      ...(includeFixtureModel
        ? [{ value: "fixture-model", name: "Fixture" }]
        : []),
    ],
  },
];
const invocationInput = {
  enabled: false,
  count: 0,
  text: "",
  nested: { items: [""] },
};
const invocationOutput = {
  content: [{ type: "text", text: "fixture tool output" }],
  structuredContent: { done: false, count: 0, text: "", items: [""] },
};
const toolContent = [
  {
    type: "content",
    content: { type: "text", text: "initial fixture tool content" },
  },
];
const toolLocations = [{ path: "/fixture/result.json", line: 1 }];

const environment = environmentSchema.parse({
  mode: process.env.SEQLANE_ACP_FIXTURE_MODE,
  trace: process.env.SEQLANE_ACP_FIXTURE_TRACE,
  persist: process.env.SEQLANE_ACP_FIXTURE_PERSIST,
});
const sessions = new Set<string>();
const promptWaiters = new Map<string, () => void>();
const pendingClientRequests = new Map<
  string | number,
  (message: z.output<typeof jsonRpcMessageSchema>) => void
>();
let nextSession = 0;
let nextTool = 0;
let nextClientRequest = 0;
let nextMessage = 0;
let inputBuffer = "";
let currentModel = "fixture-default";

function record(event: string, details: Record<string, unknown> = {}): void {
  appendFileSync(
    environment.trace,
    `${JSON.stringify({ event, ...details })}\n`,
  );
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: Record<string, unknown>): void {
  record(method, { params });
  send({ jsonrpc: "2.0", method, params });
}

function requestClient(
  method: string,
  params: Record<string, unknown>,
): Promise<z.output<typeof jsonRpcMessageSchema>> {
  const id = `fixture-client-${++nextClientRequest}`;
  record(method, { params });
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingClientRequests.set(id, resolve));
}

function update(
  sessionId: string,
  value: Record<string, unknown>,
  notificationMetadata?: Record<string, unknown>,
): void {
  notify("session/update", {
    sessionId,
    update: value,
    ...(notificationMetadata === undefined
      ? {}
      : { _meta: notificationMetadata }),
  });
}

function toolStart(sessionId: string): string {
  const toolCallId = `fixture-tool-${++nextTool}`;
  update(
    sessionId,
    {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Fixture activity",
      name: "fixture.echo",
      status: "in_progress",
      rawInput: invocationInput,
      content: toolContent,
      locations: toolLocations,
      _meta: { fixture: { retained: false, text: "" } },
    },
    { fixtureNotice: { visible: false, count: 0, text: "" } },
  );
  return toolCallId;
}

function toolFinish(sessionId: string, toolCallId: string): void {
  update(
    sessionId,
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: invocationOutput,
      _meta: { fixture: { result: "complete", count: 0 } },
    },
    { fixtureNotice: { terminal: false, count: 0, text: "" } },
  );
}

async function prompt(
  id: string | number,
  params: Record<string, unknown>,
): Promise<void> {
  const sessionId = z.string().parse(params.sessionId);
  if (!sessions.has(sessionId)) throw new Error("Unknown fixture session");
  const toolCallId = toolStart(sessionId);

  if (environment.mode === "hold") {
    await new Promise<void>((resolve) => promptWaiters.set(sessionId, resolve));
    respond(id, { stopReason: "cancelled" });
    return;
  }

  if (environment.mode === "permission") {
    await requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId,
        title: "Fixture permission",
        name: "fixture.write",
        status: "in_progress",
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      ],
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      _meta: { permission: "cancelled" },
    });
    respond(id, { stopReason: "cancelled" });
    return;
  }

  toolFinish(sessionId, toolCallId);
  update(
    sessionId,
    {
      sessionUpdate: "usage_update",
      used: 0,
      size: 0,
      cost: {
        amount: 0,
        currency: "USD",
        _meta: { fixture: { billed: false, count: 0, text: "" } },
      },
      _meta: { fixture: { occupancy: 0, cumulative: true } },
    },
    { fixtureNotice: { usage: false, count: 0, text: "" } },
  );
  const output = {
    done: false,
    count: 0,
    text: "",
    items: [""],
  };
  const text =
    environment.mode === "invalid-first" && nextMessage++ === 0
      ? "not-json"
      : JSON.stringify(output);
  if (environment.mode !== "invalid-first") nextMessage += 1;
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: `fixture-message-${nextMessage}`,
    content: { type: "text", text },
    _meta: { fixture: { message: false, count: 0 } },
  });
  respond(id, { stopReason: "end_turn" });
}

async function handle(message: z.output<typeof jsonRpcMessageSchema>) {
  if (message.method === undefined) {
    if (message.id === undefined) return;
    const pending = pendingClientRequests.get(message.id);
    if (pending === undefined) return;
    pendingClientRequests.delete(message.id);
    record("client.response", { result: message.result });
    pending(message);
    return;
  }
  const { method, id, params = {} } = message;
  if (method === "session/cancel") {
    const sessionId = z.string().parse(params.sessionId);
    promptWaiters.get(sessionId)?.();
    promptWaiters.delete(sessionId);
    record(method, { params });
    return;
  }
  if (id === undefined) {
    record(method, { params });
    return;
  }
  record(method, { params });
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        authMethods: [],
        agentInfo: { name: "seqlane-acp-fixture", version: "1.0.0" },
      });
      return;
    case "session/new": {
      const sessionId = `fixture-session-${++nextSession}`;
      sessions.add(sessionId);
      const selectedModel = currentModel;
      const availableModels = environment.mode !== "missing-model";
      record("session.created", { sessionId, cwd: params.cwd });
      respond(id, {
        sessionId,
        configOptions: configOptions(selectedModel, availableModels),
      });
      return;
    }
    case "session/set_config_option":
      currentModel = z.string().parse(params.value);
      respond(id, {
        configOptions: configOptions(
          currentModel,
          environment.mode !== "missing-model",
        ),
      });
      return;
    case "session/prompt":
      await prompt(id, params);
      return;
    case "session/close":
      sessions.delete(z.string().parse(params.sessionId));
      respond(id, {});
      return;
    default:
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unsupported fixture method: ${method}`,
        },
      });
  }
}

record("process.started", {
  pid: process.pid,
  cwd: process.cwd(),
  persistSession: environment.persist,
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.length === 0) continue;
    const parsed = jsonRpcMessageSchema.parse(JSON.parse(line));
    void handle(parsed).catch((cause: unknown) => {
      record("fixture.error", {
        message:
          cause instanceof Error ? cause.message : "Unknown fixture error",
      });
      if (parsed.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: parsed.id,
          error: { code: -32603, message: "ACP fixture request failed" },
        });
      }
    });
  }
});
process.on("exit", () => record("process.closed", { pid: process.pid }));
