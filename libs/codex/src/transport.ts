import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAdapterError, CodexProtocolError } from "./errors.js";
import {
  MAX_JSONL_BUFFER_BYTES,
  MAX_JSONL_LINE_BYTES,
  type CodexInboundMessage,
  type CodexLaunchConfiguration,
  type CodexRequestId,
  parseCodexMessage,
  parseInitializeResult,
} from "./protocol.js";
import { readCodexVersion, versionDiagnostic } from "./version.js";

export interface CodexTransport {
  readonly termination: Promise<void>;
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  subscribe(listener: (message: CodexInboundMessage) => void): () => void;
  close(): Promise<void>;
}

export interface CodexTransportOptions {
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
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

export async function createCodexStdioTransport(
  configuration: CodexLaunchConfiguration,
  options: CodexTransportOptions = {},
): Promise<CodexTransport> {
  const version = await readCodexVersion(
    configuration.executable,
    configuration.workspace,
  );
  const diagnostic = versionDiagnostic(version);
  if (diagnostic !== undefined) {
    options.onDiagnostic?.(diagnostic);
  }

  const child = (options.spawnProcess ?? defaultSpawn)(
    configuration.executable,
    ["app-server", "--stdio"],
    configuration.workspace,
  );
  return createCodexTransportForProcess(child);
}

export async function createCodexTransportForProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<CodexTransport> {
  let nextId = 1;
  let state: "open" | "closing" | "closed" = "open";
  let buffer = "";
  const pending = new Map<CodexRequestId, PendingRequest>();
  const ignoredResponses = new Set<CodexRequestId>();
  const listeners = new Set<(message: CodexInboundMessage) => void>();
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });

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
    try {
      child.stdin.destroy();
      if (!child.killed) child.kill();
    } catch {
      // Best-effort process cleanup.
    }
  };

  const fail = (cause: unknown): void => {
    if (state !== "open") return;
    state = "closing";
    rejectPending(cause);
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
        if (ignoredResponses.delete(message.id)) return;
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
    for (const listener of listeners) listener(message);
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (state !== "open") return;
    buffer += chunk.toString();
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
    listeners.clear();
    resolveTermination();
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
          ignoredResponses.add(id);
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
      await transport.request("initialize", {
        clientInfo: {
          name: "seqlane",
          title: "Seqlane Codex adapter",
          version: "0.0.0",
        },
      }),
    );
    writeMessage(child, { jsonrpc: "2.0", method: "initialized", params: {} });
    return transport;
  } catch (cause) {
    await transport.close();
    throw cause;
  }
}
