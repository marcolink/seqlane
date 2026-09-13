import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_BUFFER_BYTES,
  MAX_OUTBOUND_MESSAGE_BYTES,
  MAX_OUTBOUND_PARAMS_BYTES,
  MAX_PENDING_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
  MAX_REQUIRED_OUTPUT_BYTES,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_ENTRIES,
  SHUTDOWN_FORCE_SETTLEMENT_MS,
  SHUTDOWN_GRACE_MS,
} from "./codex-app-server-probe-constants.mjs";
import {
  parseJsonLine,
  responseFor,
  responseResult,
} from "./codex-app-server-probe-protocol.mjs";

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

function recordRequiredOutput(entries, bytes, message) {
  if (
    !["item/agentMessage/delta", "item/completed", "turn/completed"].includes(
      message.method,
    )
  )
    return bytes;
  const entry = { direction: "server", message };
  const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
  if (entryBytes > MAX_REQUIRED_OUTPUT_BYTES)
    throw new Error("Codex app-server required output exceeded its limit");
  let nextBytes = bytes;
  while (nextBytes + entryBytes > MAX_REQUIRED_OUTPUT_BYTES) {
    const removed = entries.shift();
    if (removed === undefined) break;
    nextBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
  }
  entries.push(entry);
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

function serializeMessage(message) {
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch (cause) {
    throw new Error("Codex outbound JSONL message could not be serialized", {
      cause,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTBOUND_MESSAGE_BYTES)
    throw new Error("Codex outbound JSONL message exceeded its limit");
  if (message.params !== undefined) {
    const params = JSON.stringify(message.params);
    if (Buffer.byteLength(params, "utf8") > MAX_OUTBOUND_PARAMS_BYTES)
      throw new Error("Codex outbound JSONL params exceeded its limit");
  }
  return `${serialized}\n`;
}

export class AppServerClient {
  #child;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #messages = [];
  #pendingBytes = 0;
  #waiters = [];
  #nextId = 1;
  #closed;
  #resolveClosed;
  #requiredOutputBytes = 0;
  #transcriptBytes = 0;

  constructor(child) {
    this.#child = child;
    this.transcript = [];
    this.requiredOutput = [];
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
        const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        if (
          this.#messages.length >= MAX_PENDING_MESSAGES ||
          this.#pendingBytes + messageBytes > MAX_PENDING_MESSAGE_BYTES
        ) {
          throw new Error("Codex app-server pending message budget exceeded");
        }
        this.#record("server", message);
        this.#requiredOutputBytes = recordRequiredOutput(
          this.requiredOutput,
          this.#requiredOutputBytes,
          message,
        );
        this.#messages.push(message);
        this.#pendingBytes += messageBytes;
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

  #takeMessage(index) {
    const message = this.#messages.splice(index, 1)[0];
    if (message !== undefined)
      this.#pendingBytes -= Buffer.byteLength(JSON.stringify(message), "utf8");
    return message;
  }

  #fail(cause) {
    for (const waiter of this.#waiters.splice(0)) waiter.reject(cause);
  }

  #flushWaiters() {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      const messageIndex = this.#messages.findIndex(waiter.predicate);
      if (messageIndex < 0) continue;
      const message = this.#takeMessage(messageIndex);
      this.#waiters.splice(index, 1);
      waiter.resolve(message);
    }
  }

  #take(predicate) {
    const messageIndex = this.#messages.findIndex(predicate);
    if (messageIndex >= 0)
      return Promise.resolve(this.#takeMessage(messageIndex));
    return new Promise((resolveMessage, reject) => {
      this.#waiters.push({ predicate, resolve: resolveMessage, reject });
    });
  }

  send(method, params, id = this.#nextId++) {
    const message = { jsonrpc: "2.0", id, method, params };
    const serialized = serializeMessage(message);
    this.#record("client", message);
    this.#child.stdin.write(serialized);
    return id;
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method, params };
    const serialized = serializeMessage(message);
    this.#record("client", message);
    this.#child.stdin.write(serialized);
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

export function spawnCodexAppServer(executable, workspace, spawnProcess) {
  const child = (spawnProcess ?? spawn)(executable, ["app-server", "--stdio"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  return new AppServerClient(child);
}
