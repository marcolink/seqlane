import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { z } from "zod";

const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
const rpcResponseSchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const paramsRecordSchema = z.record(z.string(), z.unknown());

const mode = process.env.CONTROLLED_ACP_MODE ?? "success";
const exitFile = process.env.CONTROLLED_ACP_EXIT_FILE;
const exitLogFile = process.env.CONTROLLED_ACP_EXIT_LOG_FILE;
const stateFile = process.env.CONTROLLED_ACP_STATE_FILE;
const argument = process.argv[2] ?? "missing-argument";
const sessionId = "controlled-session";
let sessionCwd = "";
let selectedModel = "";
let promptCount = 0;
let pendingPromptId;
let exitRecorded = false;

function recordExit() {
  if (exitRecorded) return;
  exitRecorded = true;
  if (exitFile !== undefined) writeFileSync(exitFile, "exit");
  if (exitLogFile !== undefined)
    appendFileSync(exitLogFile, `${process.pid}\n`);
}

process.on("exit", recordExit);
process.on("SIGTERM", () => {
  recordExit();
  process.exit(0);
});
process.on("SIGINT", () => {
  recordExit();
  process.exit(0);
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendUpdate(update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function output() {
  return {
    value: "done",
    cwd: sessionCwd,
    model: selectedModel,
    argument,
    promptCount,
  };
}

function completePrompt(stopReason = "end_turn") {
  if (pendingPromptId === undefined) return;
  const id = pendingPromptId;
  pendingPromptId = undefined;
  sendResult(id, { stopReason });
}

function exitAfterResponse() {
  setImmediate(() => process.exit(0));
}

function handleRequest(request) {
  if (request.method === "initialize") {
    sendResult(request.id, {
      protocolVersion: 1,
      agentInfo: { name: "controlled-acp", version: "1.0.0" },
      agentCapabilities: { sessionCapabilities: {} },
    });
    return;
  }

  if (request.method === "session/new") {
    const parsed = paramsRecordSchema.safeParse(request.params);
    if (!parsed.success || typeof parsed.data.cwd !== "string") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "invalid session" },
      });
      return;
    }
    if (mode === "setup-failure") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "controlled setup failure" },
      });
      return;
    }
    sessionCwd = parsed.data.cwd;
    sendResult(request.id, {
      sessionId,
      models: {
        availableModels: [
          { modelId: "controlled-model", name: "Controlled model" },
        ],
        currentModelId: "controlled-model",
      },
    });
    return;
  }

  if (request.method === "session/set_model") {
    const parsed = paramsRecordSchema.safeParse(request.params);
    if (parsed.success && typeof parsed.data.modelId === "string") {
      selectedModel = parsed.data.modelId;
    }
    sendResult(request.id, {});
    return;
  }

  if (request.method === "session/cancel") {
    completePrompt("cancelled");
    sendResult(request.id, {});
    if (mode === "cancel") exitAfterResponse();
    return;
  }

  if (request.method === "session/prompt") {
    pendingPromptId = request.id;
    promptCount += 1;
    if (
      mode === "permission" ||
      (mode === "permission-then-success" &&
        (stateFile === undefined || !existsSync(stateFile)))
    ) {
      if (mode === "permission-then-success" && stateFile !== undefined) {
        writeFileSync(stateFile, "permission-failed");
      }
      send({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "controlled-tool",
            title: "Run controlled command",
            status: "pending",
          },
          options: [
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
        },
      });
      return;
    }
    if (mode === "cancel") {
      sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "controlled-tool",
        title: "wait",
        rawInput: { argument },
        status: "in_progress",
      });
      return;
    }
    sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "controlled-tool",
      title: "read_file",
      rawInput: { path: "AGENTS.md" },
      status: "in_progress",
    });
    sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "controlled-tool",
      title: "read_file",
      status: "completed",
      rawOutput: "ok",
    });
    sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify(output()) },
    });
    completePrompt();
    if (mode === "reuse" && promptCount >= 2) {
      setTimeout(() => process.exit(0), 25);
    }
    return;
  }

  const response = rpcResponseSchema.safeParse(request);
  if (response.success && response.data.id === "permission-1") {
    completePrompt("cancelled");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const request = rpcRequestSchema.safeParse(value);
    if (request.success) handleRequest(request.data);
    else {
      const response = rpcResponseSchema.safeParse(value);
      if (response.success && response.data.id === "permission-1") {
        completePrompt("cancelled");
        if (mode === "permission" || mode === "permission-then-success") {
          exitAfterResponse();
        }
      }
    }
  }
});
