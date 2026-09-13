#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 256;
const MAX_TRANSCRIPT_BYTES = 1 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 1_000;
const SHUTDOWN_FORCE_SETTLEMENT_MS = 1_000;
const MAX_STRUCTURED_OUTPUT_BYTES = 16 * 1024;
// Keep this list aligned with TESTED_CODEX_VERSIONS in libs/codex/src/version.ts.
const TESTED_CODEX_VERSIONS = ["0.147.0"];
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
  validateJsonRpcEnvelope(value);
  return value;
}

function isRequestId(value) {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 0) ||
    (typeof value === "string" && value.length > 0 && value.length <= 128)
  );
}

function validateJsonRpcEnvelope(message) {
  if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
    throw new Error("Codex app-server message has an invalid JSON-RPC marker");
  if (Object.hasOwn(message, "id") && !isRequestId(message.id))
    throw new Error("Codex app-server message has an invalid request id");
  if (typeof message.method === "string") {
    if (message.method.length === 0 || message.method.length > 256)
      throw new Error("Codex app-server message has an invalid method");
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
      throw new Error(
        "Codex app-server message mixes method and response fields",
      );
    if (Object.hasOwn(message, "id") && !isRequestId(message.id))
      throw new Error("Codex app-server request has an invalid id");
    return;
  }
  if (Object.hasOwn(message, "method"))
    throw new Error("Codex app-server message has an invalid method");
  if (!Object.hasOwn(message, "id"))
    throw new Error("Codex app-server message has neither method nor id");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasResult === hasError)
    throw new Error("Codex app-server response must contain result or error");
  if (
    hasError &&
    (!isRecord(message.error) ||
      typeof message.error.code !== "number" ||
      !Number.isFinite(message.error.code) ||
      typeof message.error.message !== "string" ||
      message.error.message.length > 4_096)
  )
    throw new Error("Codex app-server response has an invalid error");
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

function approvalRequestFor(message, threadId, turnId) {
  return (
    serverRequestFor(message) &&
    message.method.includes("Approval") &&
    isRecord(message.params) &&
    message.params.threadId === threadId &&
    message.params.turnId === turnId
  );
}

function responseResult(message, operation) {
  if (Object.hasOwn(message, "error")) {
    throw new Error(`${operation} failed: ${JSON.stringify(message.error)}`);
  }
  return message.result;
}

function nonEmptyString(value, description) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${description} must be a non-empty string`);
  return value;
}

function parseInitializeResult(result) {
  if (!isRecord(result)) throw new Error("initialize response was malformed");
  return {
    userAgent: nonEmptyString(result.userAgent, "initialize.userAgent"),
    codexHome: nonEmptyString(result.codexHome, "initialize.codexHome"),
    platformFamily: nonEmptyString(
      result.platformFamily,
      "initialize.platformFamily",
    ),
    platformOs: nonEmptyString(result.platformOs, "initialize.platformOs"),
  };
}

function parseModelListResult(result) {
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("model/list response was malformed");
  return result.data
    .map((value, index) => {
      if (!isRecord(value))
        throw new Error(`model/list data[${index}] was malformed`);
      const efforts = value.supportedReasoningEfforts ?? [];
      if (!Array.isArray(efforts))
        throw new Error(`model/list data[${index}] efforts were malformed`);
      const supportedReasoningEfforts = efforts.map((effort, effortIndex) => {
        if (!isRecord(effort))
          throw new Error(
            `model/list data[${index}] effort[${effortIndex}] was malformed`,
          );
        return nonEmptyString(
          effort.reasoningEffort,
          `model/list data[${index}] reasoningEffort`,
        );
      });
      return {
        id: nonEmptyString(value.id, `model/list data[${index}].id`),
        model: nonEmptyString(value.model, `model/list data[${index}].model`),
        isDefault: value.isDefault ?? false,
        supportedReasoningEfforts,
      };
    })
    .map((model, index) => {
      if (typeof model.isDefault !== "boolean")
        throw new Error(`model/list data[${index}].isDefault was malformed`);
      return model;
    });
}

const TURN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

function parseTurnResult(result, operation) {
  if (!isRecord(result) || !isRecord(result.turn))
    throw new Error(`${operation} response did not contain a turn`);
  const turn = result.turn;
  const id = nonEmptyString(turn.id, `${operation}.turn.id`);
  if (typeof turn.status !== "string" || !TURN_STATUSES.has(turn.status))
    throw new Error(`${operation}.turn.status was malformed`);
  if (
    turn.items !== undefined &&
    (!Array.isArray(turn.items) || turn.items.some((item) => !isRecord(item)))
  )
    throw new Error(`${operation}.turn.items was malformed`);
  return { ...result, turn: { ...turn, id, items: turn.items ?? [] } };
}

function parseThreadResult(result, operation = "thread") {
  if (!isRecord(result) || !isRecord(result.thread))
    throw new Error(`${operation} response did not contain a thread`);
  return {
    ...result,
    thread: {
      ...result.thread,
      id: nonEmptyString(result.thread.id, `${operation}.thread.id`),
    },
  };
}

function completedTurnStatus(
  message,
  threadId,
  turnId,
  description,
  expectedStatus = "interrupted",
) {
  if (!completedTurn(message, threadId, turnId))
    throw new Error(`${description} did not contain a matching completed turn`);
  const parsed = parseTurnResult(message.params, description);
  if (parsed.turn.status !== expectedStatus)
    throw new Error(
      `${description} did not produce ${expectedStatus} status: ${JSON.stringify(parsed.turn)}`,
    );
  return parsed;
}

function killChild(child, signal) {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may not own a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort process cleanup.
  }
}

function recordTranscript(transcript, bytes, direction, message) {
  const entry = { direction, message };
  const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  if (entryBytes > MAX_TRANSCRIPT_BYTES)
    throw new Error("Codex app-server transcript entry exceeded its limit");
  let nextBytes = bytes;
  while (
    transcript.length >= MAX_TRANSCRIPT_ENTRIES ||
    nextBytes + entryBytes > MAX_TRANSCRIPT_BYTES
  ) {
    const removed = transcript.shift();
    if (removed === undefined) break;
    nextBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
  }
  transcript.push(entry);
  return nextBytes + entryBytes;
}

function waitForShutdown(ms) {
  return new Promise((resolveShutdown) => {
    const timer = setTimeout(resolveShutdown, ms);
    timer.unref?.();
  });
}

async function closeChild(child, closed) {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    killChild(child, "SIGTERM");
  }
  await Promise.race([closed, waitForShutdown(SHUTDOWN_GRACE_MS)]);
  if (child.exitCode === null && child.signalCode === null)
    killChild(child, "SIGKILL");
  await Promise.race([closed, waitForShutdown(SHUTDOWN_FORCE_SETTLEMENT_MS)]);
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
  #transcriptBytes = 0;

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
        this.#record("server", message);
        if (this.#messages.length >= MAX_TRANSCRIPT_ENTRIES)
          throw new Error("Codex app-server pending message limit exceeded");
        this.#messages.push(message);
        this.#flushWaiters();
      } catch (cause) {
        this.#fail(cause);
        return;
      }
    }
  }

  #record(direction, message) {
    this.#transcriptBytes = recordTranscript(
      this.transcript,
      this.#transcriptBytes,
      direction,
      message,
    );
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
    this.#record("client", message);
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return id;
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    this.#record("client", message);
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
    await closeChild(this.#child, this.#closed);
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
  return version;
}

function defaultModel(result) {
  const models = parseModelListResult(result);
  const model = models.find((value) => value.isDefault === true);
  if (model === undefined)
    throw new Error("model/list response did not contain a default model");
  return model.model;
}

function turnIdFrom(result) {
  return parseTurnResult(result, "turn/start").turn.id;
}

function threadIdFrom(result) {
  return parseThreadResult(result, "thread").thread.id;
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

function agentMessageText(item) {
  if (!isRecord(item) || item.type !== "agentMessage") return undefined;
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .filter(
      (part) =>
        isRecord(part) &&
        (part.type === "text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
  return text.length === 0 ? undefined : text;
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
    .map((message) => agentMessageText(message.params.item))
    .find((text) => text !== undefined);
  if (completed === undefined)
    throw new Error("completed turn did not contain an agent message item");
  if (Buffer.byteLength(completed, "utf8") > MAX_STRUCTURED_OUTPUT_BYTES)
    throw new Error("agent message exceeded the structured output limit");
  return completed;
}

function assertProbeOutput(value) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.version !== "probe" ||
    Object.keys(value).length !== 2
  ) {
    throw new Error(
      `structured output was not locally validatable: ${JSON.stringify(value)}`,
    );
  }
}

function compactModelList(result) {
  return parseModelListResult(result);
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

function observedRequestShape(transcript, method) {
  const entry = transcript.find(
    (value) =>
      value.direction === "client" &&
      isRecord(value.message) &&
      value.message.method === method,
  );
  if (entry === undefined || !isRecord(entry.message.params))
    throw new Error(`client did not send ${method}`);
  const params = Object.fromEntries(
    Object.keys(entry.message.params)
      .sort()
      .map((key) => [
        key,
        key === "threadId"
          ? "<thread-id>"
          : key === "lastTurnId"
            ? "<completed-turn-id>"
            : key === "turnId"
              ? "<active-turn-id>"
              : "<redacted>",
      ]),
  );
  return { method, params };
}

async function runProbe(options) {
  const detectedVersion =
    options.readVersion === undefined
      ? codexVersion(options.executable, options.workspace)
      : options.readVersion(options.executable, options.workspace);
  const version = detectedVersion ?? "unknown";
  const diagnostic =
    detectedVersion !== undefined &&
    TESTED_CODEX_VERSIONS.includes(detectedVersion)
      ? undefined
      : {
          code: "codex-version-unconfirmed",
          message: `Codex CLI version ${detectedVersion ?? "unknown"} is not in the tested version list; continuing with advisory compatibility only`,
          ...(detectedVersion === undefined
            ? {}
            : { version: detectedVersion }),
          testedVersions: TESTED_CODEX_VERSIONS,
        };
  if (diagnostic !== undefined) console.error(`warning: ${diagnostic.message}`);
  const child = (options.spawnProcess ?? spawn)(
    options.executable,
    ["app-server", "--stdio"],
    {
      cwd: options.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  const client = new AppServerClient(child);
  try {
    const initializeResponse = await client.request(
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
    const initialize = parseInitializeResult(initializeResponse);
    client.notify("initialized", {});

    const models = await client.request("model/list", {}, options.timeoutMs);
    parseModelListResult(models);
    const model = defaultModel(models);
    const threadId = threadIdFrom(
      await client.request(
        "thread/start",
        {
          cwd: options.workspace,
          model,
          approvalPolicy: "never",
          sandbox: "read-only",
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
        sandboxPolicy: { type: "read-only" },
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
    const completedTurnResult = completedTurnStatus(
      completed,
      threadId,
      turnId,
      "structured turn completion",
      "completed",
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
          approvalPolicy: "on-request",
          sandbox: "read-only",
        },
        options.timeoutMs,
      ),
    );
    const interruptStart = await client.request(
      "turn/start",
      {
        threadId: interruptThreadId,
        input: [
          {
            type: "text",
            text: "Create a file named protocol-probe-must-not-exist.txt in the workspace.",
          },
        ],
        cwd: options.workspace,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "read-only" },
        outputSchema: { type: "string" },
        model,
      },
      options.timeoutMs,
    );
    const interruptTurnId = turnIdFrom(interruptStart);
    const approvalRequest = await client.waitFor(
      (message) =>
        approvalRequestFor(message, interruptThreadId, interruptTurnId),
      options.timeoutMs,
      "approval request",
    );
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
    const interruptedTurn = completedTurnStatus(
      interrupted,
      interruptThreadId,
      interruptTurnId,
      "interrupt completion",
    );

    const fixture = {
      protocol: "codex-app-server",
      version,
      generatedBy: "seqlane-protocol-probe",
      ...(diagnostic === undefined ? {} : { diagnostic }),
      initialize: {
        responseKeys: Object.keys(initializeResponse).sort(),
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
        terminalStatus: completedTurnResult.turn.status,
        output,
      },
      fork: {
        request: {
          ...observedRequestShape(client.transcript, "thread/fork"),
        },
        responseKeys: Object.keys(forkResult).sort(),
        returnedThread:
          forkedThreadId === threadId ? "<thread-id>" : "<forked-thread-id>",
      },
      interrupt: {
        request: {
          ...observedRequestShape(client.transcript, "turn/interrupt"),
        },
        terminalStatus: interruptedTurn.turn.status,
      },
      approval: {
        requestMethod: approvalRequest.method,
        decisionResponseSent: false,
        interruptedWithoutDecision:
          interruptedTurn.turn.status === "interrupted",
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

export {
  AppServerClient,
  PROBE_OUTPUT_SCHEMA,
  parseInitializeResult,
  parseJsonLine,
  parseModelListResult,
  parseThreadResult,
  parseTurnResult,
  runProbe,
};
