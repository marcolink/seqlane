import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CodexAdapterError, CodexProtocolError } from "./errors.js";
import {
  MAX_JSONL_OUTBOUND_MESSAGE_BYTES,
  MAX_JSONL_OUTBOUND_PARAMS_BYTES,
  MAX_JSONL_BUFFER_BYTES,
  MAX_JSONL_LINE_BYTES,
  type CodexInboundMessage,
  type CodexLaunchConfiguration,
  type CodexRequestId,
  type CodexServerRequestResponse,
  parseCodexMessage,
  parseInitializeResult,
} from "./protocol.js";
import { withDeadline } from "./deadline.js";
import { readCodexVersion, versionDiagnostic } from "./version.js";

const MAX_IGNORED_RESPONSE_IDS = 1_024;
const IGNORED_RESPONSE_TTL_MS = 60_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 1_000;
const SHUTDOWN_FORCE_SETTLEMENT_MS = 1_000;

export interface CodexTransport {
  readonly termination: Promise<void>;
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  respond(
    requestId: CodexRequestId,
    response: CodexServerRequestResponse,
  ): void;
  subscribe(listener: (message: CodexInboundMessage) => void): () => void;
  close(): Promise<void>;
}

export interface CodexTransportOptions {
  readonly signal?: AbortSignal;
  readonly initializeTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: {
    readonly code: string;
    readonly message: string;
  }) => void;
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

function writeMessage(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  if (!child.stdin.writable) {
    throw new CodexProtocolError("Codex app-server stdin is not writable");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch (cause) {
    throw new CodexAdapterError(
      "limit",
      "Codex outbound JSONL message could not be serialized",
      cause,
    );
  }
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_JSONL_OUTBOUND_MESSAGE_BYTES
  ) {
    throw new CodexAdapterError(
      "limit",
      `Codex outbound JSONL message exceeded ${MAX_JSONL_OUTBOUND_MESSAGE_BYTES} bytes`,
    );
  }
  if (message.params !== undefined) {
    let serializedParams: string;
    try {
      serializedParams = JSON.stringify(message.params);
    } catch (cause) {
      throw new CodexAdapterError(
        "limit",
        "Codex outbound JSONL params could not be serialized",
        cause,
      );
    }
    if (
      Buffer.byteLength(serializedParams, "utf8") >
      MAX_JSONL_OUTBOUND_PARAMS_BYTES
    ) {
      throw new CodexAdapterError(
        "limit",
        `Codex outbound JSONL params exceeded ${MAX_JSONL_OUTBOUND_PARAMS_BYTES} bytes`,
      );
    }
  }
  child.stdin.write(`${serialized}\n`);
}

export async function createCodexStdioTransport(
  configuration: CodexLaunchConfiguration,
  options: CodexTransportOptions = {},
): Promise<CodexTransport> {
  const version = await readCodexVersion(
    configuration.executable,
    configuration.workspace,
    options.signal,
  );
  if (options.signal?.aborted) {
    throw (
      options.signal.reason ??
      new CodexAdapterError(
        "cancellation",
        "Codex transport creation was cancelled",
      )
    );
  }
  const diagnostic = versionDiagnostic(version);
  if (diagnostic !== undefined) {
    options.onDiagnostic?.(diagnostic);
  }

  const child = (options.spawnProcess ?? defaultSpawn)(
    configuration.executable,
    ["app-server", "--stdio"],
    configuration.workspace,
  );
  return createCodexTransportForProcess(child, options);
}

export async function withCodexTransportDeadline(
  transportPromise: Promise<CodexTransport>,
  milliseconds: number,
  signal?: AbortSignal,
  closeLateTransport = true,
): Promise<CodexTransport> {
  let creationSettled = false;
  void transportPromise.then(
    () => {
      creationSettled = true;
    },
    () => {
      creationSettled = true;
    },
  );
  try {
    return await withDeadline(
      transportPromise,
      milliseconds,
      "transport initialization",
      signal,
    );
  } catch (cause) {
    if (closeLateTransport && !creationSettled) {
      void transportPromise.then(
        (lateTransport) =>
          Promise.resolve()
            .then(() => lateTransport.close())
            .catch(() => undefined),
        () => undefined,
      );
    }
    throw cause;
  }
}

export async function createCodexTransportForProcess(
  child: ChildProcessWithoutNullStreams,
  options: Pick<CodexTransportOptions, "signal" | "initializeTimeoutMs"> = {},
): Promise<CodexTransport> {
  let nextId = 1;
  let state: "open" | "closing" | "closed" = "open";
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  const pending = new Map<CodexRequestId, PendingRequest>();
  const ignoredResponses = new Map<CodexRequestId, number>();
  const listeners = new Set<(message: CodexInboundMessage) => void>();
  let terminationSettled = false;
  let terminationRequested = false;
  let shutdownGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownForceTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });

  const settleTermination = (): void => {
    if (terminationSettled) return;
    terminationSettled = true;
    if (shutdownGraceTimer !== undefined) clearTimeout(shutdownGraceTimer);
    if (shutdownForceTimer !== undefined) clearTimeout(shutdownForceTimer);
    resolveTermination();
  };

  const pruneIgnoredResponses = (): void => {
    const now = Date.now();
    for (const [id, expiresAt] of ignoredResponses) {
      if (expiresAt <= now) ignoredResponses.delete(id);
    }
    while (ignoredResponses.size >= MAX_IGNORED_RESPONSE_IDS) {
      const oldest = ignoredResponses.keys().next().value;
      if (oldest === undefined) break;
      ignoredResponses.delete(oldest);
    }
  };

  const ignoreResponse = (id: CodexRequestId): void => {
    pruneIgnoredResponses();
    ignoredResponses.set(id, Date.now() + IGNORED_RESPONSE_TTL_MS);
  };

  const wasIgnoredResponse = (id: CodexRequestId): boolean => {
    pruneIgnoredResponses();
    return ignoredResponses.delete(id);
  };

  const rejectPending = (cause: unknown): void => {
    const error = toError(cause);
    for (const [id, request] of pending) {
      if (request.onAbort !== undefined && request.signal !== undefined) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      pending.delete(id);
      request.reject(error);
    }
  };

  const requestChildTermination = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.stdin.destroy();
    } catch {
      // Best-effort process cleanup.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort process cleanup.
    }
    shutdownGraceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort process cleanup.
      }
      shutdownForceTimer = setTimeout(
        settleTermination,
        SHUTDOWN_FORCE_SETTLEMENT_MS,
      );
      shutdownForceTimer.unref?.();
    }, SHUTDOWN_GRACE_MS);
    shutdownGraceTimer.unref?.();
  };

  const fail = (cause: unknown): void => {
    if (state !== "open") return;
    state = "closing";
    rejectPending(cause);
    ignoredResponses.clear();
    requestChildTermination();
  };

  const consumeLine = (line: string): void => {
    if (line.length === 0) return;
    if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) {
      fail(
        new CodexProtocolError("JSONL message exceeded the maximum line size"),
      );
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      fail(
        new CodexProtocolError("Codex app-server emitted invalid JSON", cause),
      );
      return;
    }
    let message: CodexInboundMessage;
    try {
      message = parseCodexMessage(value);
    } catch (cause) {
      fail(cause);
      return;
    }
    if (message.kind === "response") {
      const request = pending.get(message.id);
      if (request === undefined) {
        if (wasIgnoredResponse(message.id)) return;
        fail(
          new CodexProtocolError(
            "Codex app-server returned an unknown request ID",
          ),
        );
        return;
      }
      pending.delete(message.id);
      if (request.onAbort !== undefined && request.signal !== undefined) {
        request.signal.removeEventListener("abort", request.onAbort);
      }
      if (message.error !== undefined) {
        request.reject(
          new CodexAdapterError(
            "execution",
            "Codex app-server rejected a request",
            message.error,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    try {
      for (const listener of listeners) listener(message);
    } catch (cause) {
      fail(
        new CodexAdapterError(
          "execution",
          "Codex app-server message delivery failed",
          cause,
        ),
      );
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (state !== "open") return;
    buffer += decoder.write(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
    if (Buffer.byteLength(buffer) > MAX_JSONL_BUFFER_BYTES) {
      fail(
        new CodexProtocolError(
          "Codex app-server JSONL buffer exceeded its limit",
        ),
      );
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
      if (state !== "open") break;
    }
  });
  child.stdout.on("end", () => {
    if (state !== "open") return;
    buffer += decoder.end();
    if (buffer.length > 0) {
      fail(
        new CodexProtocolError(
          "Codex app-server stdout ended with an incomplete JSONL message",
        ),
      );
    }
  });
  child.on("error", (cause) =>
    fail(
      new CodexAdapterError(
        "execution",
        "Codex app-server process failed",
        cause,
      ),
    ),
  );
  child.on("close", (code, signal) => {
    if (state === "open") {
      rejectPending(
        new CodexAdapterError(
          "execution",
          `Codex app-server disconnected (${code ?? signal ?? "unknown"})`,
        ),
      );
    }
    state = "closed";
    ignoredResponses.clear();
    listeners.clear();
    settleTermination();
  });

  // Stderr is intentionally ignored, but must be drained so diagnostics from
  // the child cannot fill the pipe and stall stdout or process shutdown.
  child.stderr.resume();

  const transport: CodexTransport = {
    termination,
    request(method, params, signal) {
      if (state !== "open")
        return Promise.reject(
          new CodexAdapterError(
            "execution",
            "Codex app-server transport is closed",
          ),
        );
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id);
          ignoreResponse(id);
          reject(
            signal?.reason ??
              new CodexAdapterError(
                "cancellation",
                "Codex request was cancelled",
              ),
          );
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        pending.set(id, { resolve, reject, signal, onAbort });
        try {
          writeMessage(child, { jsonrpc: "2.0", id, method, params });
        } catch (cause) {
          pending.delete(id);
          reject(cause);
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    respond(requestId, response) {
      if (state !== "open") {
        throw new CodexAdapterError(
          "execution",
          "Codex app-server transport is closed",
        );
      }
      try {
        writeMessage(child, { jsonrpc: "2.0", id: requestId, ...response });
      } catch (cause) {
        fail(cause);
        throw cause;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (state === "closed") return termination;
      if (state === "open") {
        state = "closing";
        rejectPending(
          new CodexAdapterError(
            "execution",
            "Codex app-server transport closed",
          ),
        );
      }
      try {
        child.stdin.end();
      } catch {
        // Best-effort process cleanup.
      }
      requestChildTermination();
      await termination;
    },
  };

  // The handshake is part of transport creation. Nothing else can use this
  // connection until the server has accepted the integration identity.
  try {
    parseInitializeResult(
      await withDeadline(
        transport.request(
          "initialize",
          {
            clientInfo: {
              name: "seqlane",
              title: "Seqlane Codex adapter",
              version: "0.0.0",
            },
          },
          options.signal,
        ),
        options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
        "initialize",
        options.signal,
      ),
    );
    writeMessage(child, { jsonrpc: "2.0", method: "initialized", params: {} });
    return transport;
  } catch (cause) {
    await transport.close();
    throw cause;
  }
}
