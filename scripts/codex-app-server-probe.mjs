#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const VERSION_PATTERN = /codex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s]+)?)/i;
const PROBE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    version: { type: "string" },
  },
  required: ["ok", "version"],
  additionalProperties: false,
};

function parseArgs(argv) {
  const options = {
    executable: "codex",
    workspace: process.cwd(),
    output: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/codex-app-server-probe.mjs [options]

Options:
  --executable PATH  Codex executable (default: codex)
  --workspace PATH   Absolute workspace (default: current directory)
  --output PATH      Write the sanitized fixture to PATH
  --timeout MS       Per-operation timeout (default: ${DEFAULT_TIMEOUT_MS})`);
      process.exit(0);
    }
    if (argument === "--executable")
      options.executable = requireValue(argument, value, index);
    else if (argument === "--workspace")
      options.workspace = requireValue(argument, value, index);
    else if (argument === "--output")
      options.output = requireValue(argument, value, index);
    else if (argument === "--timeout")
      options.timeoutMs = Number(requireValue(argument, value, index));
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(
      "--timeout must be an integer of at least 1000 milliseconds",
    );
  }
  if (!options.workspace.startsWith("/")) {
    throw new Error("--workspace must be an absolute path");
  }
  return options;
}

function requireValue(argument, value, index) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value (argument ${index + 1})`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("Codex app-server emitted an oversized JSONL line");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new Error("Codex app-server emitted invalid JSON", { cause });
  }
  if (!isRecord(value))
    throw new Error("Codex app-server message is not an object");
  return value;
}

function responseFor(message, id) {
  return (
    isRecord(message) &&
    message.id === id &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

function notificationFor(message, method) {
  return (
    isRecord(message) &&
    message.method === method &&
    !Object.hasOwn(message, "id")
  );
}

function serverRequestFor(message) {
  return (
    isRecord(message) &&
    typeof message.method === "string" &&
    Object.hasOwn(message, "id") &&
    !Object.hasOwn(message, "result") &&
    !Object.hasOwn(message, "error")
  );
}

function responseResult(message, operation) {
  if (Object.hasOwn(message, "error")) {
    throw new Error(`${operation} failed: ${JSON.stringify(message.error)}`);
  }
  return message.result;
}

class AppServerClient {
  #child;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #messages = [];
  #waiters = [];
  #nextId = 1;
  #closed;
  #resolveClosed;

  constructor(child) {
    this.#child = child;
    this.transcript = [];
    this.#closed = new Promise((resolveClosed) => {
      this.#resolveClosed = resolveClosed;
    });
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.stdout.on("end", () => {
      this.#buffer += this.#decoder.end();
      if (this.#buffer.trim() !== "")
        this.#fail(new Error("incomplete JSONL message"));
    });
    child.on("error", (cause) =>
      this.#fail(new Error("Codex app-server process failed", { cause })),
    );
    child.on("close", (code, signal) => {
      this.#resolveClosed({ code, signal });
      this.#fail(
        new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`),
      );
    });
    child.stderr.resume();
  }

  #consume(chunk) {
    this.#buffer += this.#decoder.write(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_BUFFER_BYTES) {
      this.#fail(new Error("Codex app-server JSONL buffer exceeded its limit"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message = parseJsonLine(line);
        this.transcript.push({ direction: "server", message });
        this.#messages.push(message);
        this.#flushWaiters();
      } catch (cause) {
        this.#fail(cause);
        return;
      }
    }
  }

  #fail(cause) {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(cause);
  }

  #flushWaiters() {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      const messageIndex = this.#messages.findIndex(waiter.predicate);
      if (messageIndex < 0) continue;
      const message = this.#messages.splice(messageIndex, 1)[0];
      this.#waiters.splice(index, 1);
      waiter.resolve(message);
    }
  }

  #take(predicate) {
    const messageIndex = this.#messages.findIndex(predicate);
    if (messageIndex >= 0)
      return Promise.resolve(this.#messages.splice(messageIndex, 1)[0]);
    return new Promise((resolveMessage, reject) => {
      const waiter = { predicate, resolve: resolveMessage, reject };
      this.#waiters.push(waiter);
    });
  }

  send(method, params, id = this.#nextId++) {
    const message = { jsonrpc: "2.0", id, method, params };
    this.transcript.push({ direction: "client", message });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return id;
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    this.transcript.push({ direction: "client", message });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params, timeoutMs) {
    const id = this.send(method, params);
    const message = await this.withTimeout(
      this.#take((value) => responseFor(value, id)),
      timeoutMs,
      method,
    );
    return responseResult(message, method);
  }

  async waitFor(predicate, timeoutMs, description) {
    return this.withTimeout(this.#take(predicate), timeoutMs, description);
  }

  withTimeout(promise, timeoutMs, description) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout.addEventListener(
          "abort",
          () =>
            reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
          { once: true },
        );
      }),
    ]);
  }

  async close() {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.stdin.end();
      this.#child.kill("SIGTERM");
    }
    await this.#closed;
  }
}

function codexVersion(executable, workspace) {
  const output = execFileSync(executable, ["--version"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  const version = VERSION_PATTERN.exec(output)?.[1];
  if (version === undefined)
    throw new Error(
      "Codex --version output did not contain a semantic version",
    );
  return version;
}

function defaultModel(result) {
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("model/list response did not contain data");
  const model = result.data.find(
    (value) => isRecord(value) && value.isDefault === true,
  );
  if (!isRecord(model) || typeof model.model !== "string")
    throw new Error("model/list response did not contain a default model");
  return model.model;
}

function turnIdFrom(result) {
  if (
    !isRecord(result) ||
    !isRecord(result.turn) ||
    typeof result.turn.id !== "string"
  ) {
    throw new Error("turn/start response did not contain a turn id");
  }
  return result.turn.id;
}

function threadIdFrom(result) {
  if (
    !isRecord(result) ||
    !isRecord(result.thread) ||
    typeof result.thread.id !== "string"
  ) {
    throw new Error("thread response did not contain a thread id");
  }
  return result.thread.id;
}

function completedTurn(message, threadId, turnId) {
  return (
    notificationFor(message, "turn/completed") &&
    isRecord(message.params) &&
    message.params.threadId === threadId &&
    isRecord(message.params.turn) &&
    message.params.turn.id === turnId
  );
}

function findAgentMessage(messages, turnId) {
  const completed = messages
    .filter((entry) => entry.direction === "server")
    .map((entry) => entry.message)
    .filter(
      (message) =>
        notificationFor(message, "item/completed") &&
        isRecord(message.params) &&
        message.params.turnId === turnId,
    )
    .map((message) => message.params.item)
    .find(
      (item) =>
        isRecord(item) &&
        item.type === "agentMessage" &&
        typeof item.text === "string",
    );
  if (completed === undefined)
    throw new Error("completed turn did not contain an agent message item");
  return completed.text;
}

function assertProbeOutput(value) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.version !== "string" ||
    Object.keys(value).length !== 2
  ) {
    throw new Error(
      `structured output was not locally validatable: ${JSON.stringify(value)}`,
    );
  }
}

function compactModelList(result) {
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("model/list response did not contain data");
  return result.data
    .map((model) => ({
      id: isRecord(model) ? model.id : undefined,
      model: isRecord(model) ? model.model : undefined,
      isDefault: isRecord(model) ? model.isDefault : undefined,
      supportedReasoningEfforts:
        isRecord(model) && Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map((effort) =>
                isRecord(effort) ? effort.reasoningEffort : undefined,
              )
              .filter(Boolean)
          : [],
    }))
    .filter(
      (model) =>
        typeof model.id === "string" && typeof model.model === "string",
    );
}

function compactEvents(transcript, threadId, turnId) {
  return transcript
    .filter((entry) => entry.direction === "server")
    .map((entry) => entry.message)
    .filter(
      (message) => isRecord(message) && typeof message.method === "string",
    )
    .filter(
      (message) =>
        !isRecord(message.params) ||
        message.params.threadId === threadId ||
        message.params.turnId === turnId,
    )
    .map((message) => message.method);
}

async function runProbe(options) {
  const version =
    options.readVersion === undefined
      ? codexVersion(options.executable, options.workspace)
      : options.readVersion(options.executable, options.workspace);
  const child = (options.spawnProcess ?? spawn)(
    options.executable,
    ["app-server", "--stdio"],
    {
      cwd: options.workspace,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = new AppServerClient(child);
  try {
    const initialize = await client.request(
      "initialize",
      {
        clientInfo: {
          name: "seqlane-protocol-probe",
          title: "Seqlane protocol probe",
          version: "0.0.0",
        },
      },
      options.timeoutMs,
    );
    client.notify("initialized", {});

    const models = await client.request("model/list", {}, options.timeoutMs);
    const model = defaultModel(models);
    const threadId = threadIdFrom(
      await client.request(
        "thread/start",
        {
          cwd: options.workspace,
          model,
          approvalPolicy: "never",
          sandbox: "workspace-write",
        },
        options.timeoutMs,
      ),
    );

    const turnStart = await client.request(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: 'Return exactly {"ok":true,"version":"probe"}. Do not call tools.',
          },
        ],
        cwd: options.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [options.workspace],
          networkAccess: false,
        },
        outputSchema: PROBE_OUTPUT_SCHEMA,
        model,
      },
      options.timeoutMs,
    );
    const turnId = turnIdFrom(turnStart);
    const completed = await client.waitFor(
      (message) => completedTurn(message, threadId, turnId),
      options.timeoutMs,
      "structured turn completion",
    );
    const outputText = findAgentMessage(client.transcript, turnId);
    let output;
    try {
      output = JSON.parse(outputText);
    } catch (cause) {
      throw new Error("structured turn output was not JSON", { cause });
    }
    assertProbeOutput(output);

    const forkResult = await client.request(
      "thread/fork",
      { threadId, lastTurnId: turnId },
      options.timeoutMs,
    );
    const forkedThreadId = threadIdFrom(forkResult);

    const interruptThreadId = threadIdFrom(
      await client.request(
        "thread/start",
        {
          cwd: options.workspace,
          model,
          approvalPolicy: "never",
          sandbox: "workspace-write",
        },
        options.timeoutMs,
      ),
    );
    const interruptStart = await client.request(
      "turn/start",
      {
        threadId: interruptThreadId,
        input: [
          { type: "text", text: "Run `sleep 20`, then return the word done." },
        ],
        cwd: options.workspace,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [options.workspace],
          networkAccess: false,
        },
        outputSchema: { type: "string" },
        model,
      },
      options.timeoutMs,
    );
    const interruptTurnId = turnIdFrom(interruptStart);
    await client.request(
      "turn/interrupt",
      { threadId: interruptThreadId, turnId: interruptTurnId },
      options.timeoutMs,
    );
    const interrupted = await client.waitFor(
      (message) => completedTurn(message, interruptThreadId, interruptTurnId),
      options.timeoutMs,
      "interrupt completion",
    );
    if (
      !isRecord(interrupted.params.turn) ||
      interrupted.params.turn.status !== "interrupted"
    ) {
      throw new Error(
        `turn/interrupt did not produce interrupted status: ${JSON.stringify(interrupted.params.turn)}`,
      );
    }

    const approvalThreadId = threadIdFrom(
      await client.request(
        "thread/start",
        {
          cwd: options.workspace,
          model,
          approvalPolicy: "on-request",
          sandbox: "read-only",
        },
        options.timeoutMs,
      ),
    );
    const approvalStart = await client.request(
      "turn/start",
      {
        threadId: approvalThreadId,
        input: [
          {
            type: "text",
            text: "Create a file named protocol-probe-must-not-exist.txt in the workspace.",
          },
        ],
        cwd: options.workspace,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" },
        outputSchema: { type: "string" },
        model,
      },
      options.timeoutMs,
    );
    const approvalTurnId = turnIdFrom(approvalStart);
    let approvalRequest;
    try {
      approvalRequest = await client.waitFor(
        (message) =>
          serverRequestFor(message) && message.method.includes("Approval"),
        options.timeoutMs,
        "approval request",
      );
    } finally {
      await client
        .request(
          "turn/interrupt",
          { threadId: approvalThreadId, turnId: approvalTurnId },
          options.timeoutMs,
        )
        .catch(() => undefined);
    }
    if (approvalRequest === undefined)
      throw new Error("approval request was not observed");

    const fixture = {
      protocol: "codex-app-server",
      version,
      generatedBy: "seqlane-protocol-probe",
      initialize: {
        responseKeys: Object.keys(initialize).sort(),
        userAgent:
          typeof initialize.userAgent === "string"
            ? initialize.userAgent
            : undefined,
        platformFamily: initialize.platformFamily,
        platformOs: initialize.platformOs,
      },
      modelList: {
        responseKeys: Object.keys(models).sort(),
        defaultModel: model,
        models: compactModelList(models),
      },
      structuredOutput: {
        request: { method: "turn/start", outputSchema: PROBE_OUTPUT_SCHEMA },
        eventMethods: compactEvents(client.transcript, threadId, turnId),
        terminalStatus: completed.params.turn.status,
        output,
      },
      fork: {
        request: {
          method: "thread/fork",
          params: {
            threadId: "<thread-id>",
            lastTurnId: "<completed-turn-id>",
          },
        },
        responseKeys: Object.keys(forkResult).sort(),
        returnedThread:
          forkedThreadId === threadId ? "<thread-id>" : "<forked-thread-id>",
      },
      interrupt: {
        request: {
          method: "turn/interrupt",
          params: { threadId: "<thread-id>", turnId: "<active-turn-id>" },
        },
        terminalStatus: interrupted.params.turn.status,
      },
      approval: {
        requestMethod: approvalRequest.method,
        decisionResponseSent: false,
        interruptedWithoutDecision: true,
      },
    };
    return fixture;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await runProbe(options);
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  if (options.output === undefined) process.stdout.write(serialized);
  else {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serialized, "utf8");
    console.log(`Wrote sanitized Codex protocol fixture to ${output}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}

export { AppServerClient, PROBE_OUTPUT_SCHEMA, parseJsonLine, runProbe };
