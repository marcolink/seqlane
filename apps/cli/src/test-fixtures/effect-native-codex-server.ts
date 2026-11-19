import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
const threadParamsSchema = z.object({ threadId: z.string() });
const interruptParamsSchema = threadParamsSchema.extend({ turnId: z.string() });
const result = { done: false, count: 0, text: "", items: [""] };

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function record(method: string, params?: unknown): void {
  const path = process.env.SEQLANE_NATIVE_FIXTURE_TRACE;
  if (path !== undefined)
    appendFileSync(path, `${JSON.stringify({ method, params })}\n`);
}

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.147.0\n");
} else {
  record("process.started", { pid: process.pid });
  let threadNumber = 0;
  let turnNumber = 0;
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = messageSchema.parse(JSON.parse(line));
    const respond = (result: unknown): void =>
      write({ id: message.id, result });
    if (message.method === undefined) {
      if (message.id === "question") record("input.response");
      return;
    }
    record(message.method, message.params);
    if (message.method === "initialize") {
      respond({
        userAgent: "codex-cli/0.147.0",
        codexHome: "/fixture",
        platformFamily: "unix",
        platformOs: process.platform,
      });
    } else if (message.method === "model/list") {
      respond({
        data: [
          {
            id: "openai/fixture-model",
            model: "fixture-model",
            supportedReasoningEfforts: [],
            isDefault: true,
          },
        ],
      });
    } else if (
      message.method === "thread/start" ||
      message.method === "thread/fork"
    ) {
      respond({ thread: { id: `thread-${++threadNumber}` } });
    } else if (message.method === "turn/start") {
      const { threadId } = threadParamsSchema.parse(message.params);
      const turnId = `turn-${++turnNumber}`;
      respond({ turn: { id: turnId, status: "inProgress", items: [] } });
      const notify = (method: string, params: unknown): void =>
        write({ method, params });
      if (process.env.SEQLANE_NATIVE_FIXTURE_MODE === "unanswered") {
        write({
          id: "question",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "question",
            namespace: null,
            tool: "ask_user",
            arguments: {
              questions: [{ id: "note", prompt: "Note?", allowFreeText: true }],
            },
          },
        });
        notify("turn/completed", {
          threadId,
          turn: { id: turnId, status: "completed", items: [] },
        });
        return;
      }
      const item = {
        id: `tool-${turnId}`,
        type: "mcpToolCall",
        server: "fixture",
        tool: "fixture.read",
        status: "inProgress",
        arguments: {
          enabled: false,
          count: 0,
          text: "",
          nested: { items: [""] },
        },
        readOnlyHint: false,
        pluginId: "",
      };
      notify("item/started", {
        threadId,
        turnId,
        item,
        startedAtMs: 100,
      });
      if (process.env.SEQLANE_NATIVE_FIXTURE_MODE === "hold") return;
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          ...item,
          status: "completed",
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            _meta: {
              enabled: false,
              count: 0,
              text: "",
              nested: { items: [""] },
            },
          },
          durationMs: 0,
          error: null,
        },
        completedAtMs: 200,
      });
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          id: `message-${turnId}`,
          type: "agentMessage",
          text: JSON.stringify(result),
        },
        completedAtMs: 200,
      });
      const tokens = {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      };
      notify("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: { total: tokens, last: tokens, modelContextWindow: 0 },
      });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed", items: [] },
      });
    } else if (message.method === "turn/interrupt") {
      const { threadId, turnId } = interruptParamsSchema.parse(message.params);
      respond({});
      write({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "interrupted", items: [] },
        },
      });
    }
  });
  input.on("close", () => record("process.closed"));
}
