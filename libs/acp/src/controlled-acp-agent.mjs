import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const sessions = new Map();
let nextSession = 0;
let promptCount = 0;
let cancelPrompt;
let cancelRequested = false;
const mode = process.env.CONTROLLED_ACP_MODE ?? "success";
function mark(name) {
  if (process.env.CONTROLLED_ACP_EVENT_FILE) {
    appendFileSync(process.env.CONTROLLED_ACP_EVENT_FILE, `${name}\n`);
  }
}
function waitForever() {
  return new Promise((resolve) => setTimeout(resolve, 60_000));
}
const modelValues = [
  { value: "default-model", name: "Default" },
  { value: "controlled-model", name: "Controlled" },
];

function configOptions(currentValue = "default-model") {
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue,
      options: modelValues,
    },
  ];
}

function sendToolUpdates(clientContext, sessionId) {
  const first = {
    sessionUpdate: "tool_call",
    toolCallId: "controlled-tool",
    title: "Read file",
    kind: "read",
    status: "in_progress",
    rawInput: { path: "AGENTS.md" },
    content: [{ type: "content", content: { type: "text", text: "partial" } }],
    locations: [{ path: "/workspace/AGENTS.md" }],
    _meta: { nested: { sequence: 1 } },
  };
  return clientContext
    .notify(methods.client.session.update, {
      sessionId,
      update: first,
      _meta: { traceId: "session-update-1" },
    })
    .then(() =>
      clientContext.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "controlled-tool",
          status: "completed",
          rawOutput: { ok: true },
          _meta: null,
        },
        _meta: { traceId: "session-update-2" },
      }),
    );
}

const app = agent({ name: "Controlled ACP test peer" })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    mark("initialize");
    if (mode === "hang-initialize") await waitForever();
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: mode === "no-session-close" ? {} : { close: {} },
      },
    };
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    mark("session-new");
    if (mode === "hang-session-new") await waitForever();
    nextSession += 1;
    const sessionId = `session-${nextSession}`;
    const session = {
      cwd: params.cwd,
      model: "default-model",
      count: 0,
    };
    sessions.set(sessionId, session);
    return {
      sessionId,
      configOptions: mode === "model-missing" ? [] : configOptions(),
    };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    mark("model-selection");
    if (mode === "hang-model-selection") return waitForever();
    const session = sessions.get(params.sessionId);
    if (session === undefined) throw new Error("unknown session");
    const selected = mode === "model-mismatch" ? "default-model" : params.value;
    session.model = selected;
    return { configOptions: configOptions(selected) };
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(methods.agent.session.cancel, () => {
    mark("cancel");
    cancelRequested = true;
    cancelPrompt?.();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (session === undefined) throw new Error("unknown session");
    session.count += 1;
    promptCount += 1;
    if (process.env.CONTROLLED_ACP_PROMPT_FILE) {
      appendFileSync(process.env.CONTROLLED_ACP_PROMPT_FILE, "prompt\n");
    }

    if (mode === "permission") {
      await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "permission-tool",
          title: "Read file",
          kind: "read",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      return { stopReason: "cancelled" };
    }
    if (mode === "permission-hang") {
      await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "permission-tool",
          title: "Read file",
          kind: "read",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await waitForever();
    }
    if (mode === "cancel") {
      cancelRequested = false;
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "cancelled-tool",
          title: "Long action",
          kind: "other",
          status: "in_progress",
        },
      });
      await new Promise((resolve) => {
        cancelPrompt = resolve;
        if (cancelRequested) resolve();
      });
      cancelPrompt = undefined;
      cancelRequested = false;
      return { stopReason: "cancelled" };
    }
    if (mode === "cancel-reject") {
      mark(`peer-pid:${process.pid}`);
      cancelRequested = false;
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "cancelled-tool",
          title: "Long action",
          kind: "other",
          status: "in_progress",
        },
      });
      await new Promise((resolve, reject) => {
        cancelPrompt = () => reject(new Error("late ACP prompt RPC failure"));
        if (cancelRequested) cancelPrompt();
      });
    }
    if (mode === "malformed-notification") {
      // Exercise the SDK-owned inbound stream boundary with an invalid native
      // notification before the SDK router can silently discard it.
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: methods.client.session.update,
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: "tool_call", toolCallId: 7 },
          },
        }) + "\n",
      );
      return { stopReason: "end_turn" };
    }

    await sendToolUpdates(client, params.sessionId);
    const text =
      mode === "repair" && session.count === 1
        ? "not-json"
        : JSON.stringify({
            value: "done",
            cwd: session.cwd,
            model: session.model,
            argument: process.argv[2],
            promptCount: session.count,
            processPromptCount: promptCount,
            processId: process.pid,
          });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 42,
        size: 4096,
        cost: { amount: 0.25, currency: "USD", _meta: { source: "fixture" } },
        _meta: { usage: "native" },
      },
      _meta: { traceId: "usage-notification" },
    });
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
    return { stopReason: "end_turn" };
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
connection.closed.then(
  () => {
    if (process.env.CONTROLLED_ACP_EXIT_FILE) {
      appendFileSync(process.env.CONTROLLED_ACP_EXIT_FILE, `${process.pid}\n`);
    }
    process.exit(0);
  },
  (cause) => {
    process.stderr.write(`controlled ACP failure: ${String(cause)}\n`);
    process.exit(1);
  },
);
