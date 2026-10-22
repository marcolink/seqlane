import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: z
      .union([z.number().int().nonnegative(), z.string().min(1).max(128)])
      .optional(),
    method: z.string().min(1).max(256),
  })
  .passthrough();

const eventFile = process.env.CODEX_EVENT_FILE;
const record = (value) => {
  if (eventFile !== undefined) appendFileSync(eventFile, `${value}\n`);
};

const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
};

const respondError = (id, code, message) => {
  process.stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
};

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let decoded;
  try {
    decoded = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }
  const parsed = requestSchema.safeParse(decoded);
  if (
    !parsed.success ||
    (parsed.data.method !== "initialized" && parsed.data.id === undefined)
  ) {
    respondError(null, -32600, "Invalid Request");
    return;
  }
  const message = parsed.data;
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    respond(message.id, {
      userAgent: "codex-cli 0.0.0",
      codexHome: process.cwd(),
      platformFamily: process.platform,
      platformOs: process.platform,
    });
    return;
  }
  if (message.method === "model/list") {
    respond(message.id, {
      data: [
        {
          id: "openai/gpt-5.1-codex",
          model: "gpt-5.1-codex",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          isDefault: true,
        },
      ],
    });
    return;
  }
  if (message.method === "thread/start") {
    respond(message.id, { thread: { id: "fixture-thread" } });
    return;
  }
  if (message.method === "turn/start") {
    record("turn-start");
    respond(message.id, {
      turn: { id: "fixture-turn", status: "inProgress", items: [] },
    });
    process.stdout.write(
      `${JSON.stringify({
        method: "item/started",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          item: {
            id: "fixture-tool",
            type: "commandExecution",
            input: { command: "sleep 60" },
          },
          startedAtMs: 1,
        },
      })}\n`,
    );
    record("tool-started");
    return;
  }
  if (message.method === "turn/interrupt") {
    record("interrupt-request");
    respond(message.id, {});
    record("interrupt-ack");
    process.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "fixture-thread",
          turn: { id: "fixture-turn", status: "interrupted", items: [] },
        },
      })}\n`,
    );
    record("turn-interrupted");
    return;
  }
  respond(message.id, {});
});
