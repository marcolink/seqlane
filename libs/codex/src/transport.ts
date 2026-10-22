import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Clock, Deferred, Effect, Exit, Scope } from "effect";
import { codexEffect } from "./effect-boundary.js";
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
import { CODEX_PREFLIGHT_TIMEOUT_MS, withDeadline } from "./deadline.js";
import { readCodexVersion, versionDiagnostic } from "./version.js";
import {
  captureOwnedProcessIdentity,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";

const MAX_IGNORED_RESPONSE_IDS = 1_024;
const IGNORED_RESPONSE_TTL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 1_000;
const SHUTDOWN_CONFIRM_TIMEOUT_MS = 5_000;

const currentTimeMillis = (): number => Effect.runSync(Clock.currentTimeMillis);

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
  readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
  /** Set only when the transport itself created a detached POSIX group. */
  readonly terminateOwnedProcessGroup?: boolean;
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    cwd: string,
  ) => ChildProcessWithoutNullStreams;
}

interface PendingRequest {
  readonly method: string;
  readonly result: Deferred.Deferred<unknown, unknown>;
}

function rejectedRequestMessage(method: string, code: number): string {
  const safeMethod = /^[A-Za-z][A-Za-z0-9/]{0,63}$/.test(method)
    ? method
    : "request";
  const reason =
    code === -32600
      ? "invalid request"
      : code === -32601
        ? "unknown method"
        : code === -32602
          ? "invalid parameters"
          : "request failed";
  return `Codex app-server rejected ${safeMethod} (code ${code}): ${reason}`;
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    // The CLI owns adapter processes by verifying and terminating their
    // process group. Give the app-server its own group on POSIX. Windows
    // ownership is tracked by PID and creation time instead.
    detached: process.platform !== "win32",
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
  return createCodexTransportForProcess(child, {
    ...options,
    terminateOwnedProcessGroup:
      options.spawnProcess === undefined && process.platform !== "win32",
  });
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
  options: Pick<
    CodexTransportOptions,
    | "signal"
    | "initializeTimeoutMs"
    | "onOwnedProcessAcquired"
    | "terminateOwnedProcessGroup"
  > = {},
): Promise<CodexTransport> {
  let nextId = 1;
  let state: "open" | "closing" | "closed" = "open";
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  const pending = new Map<CodexRequestId, PendingRequest>();
  const ignoredResponses = new Map<CodexRequestId, number>();
  const listeners = new Set<(message: CodexInboundMessage) => void>();
  const terminated = Deferred.makeUnsafe<void, unknown>();
  let terminationFailure: { readonly cause: unknown } | undefined;
  let cleanupFailure: { readonly cause: unknown } | undefined;
  let shutdown: Promise<void> | undefined;
  const identityCapture: Promise<
    { readonly identity: OwnedProcessIdentity } | { readonly error: unknown }
  > =
    options.terminateOwnedProcessGroup && child.pid !== undefined
      ? captureOwnedProcessIdentity(child.pid).then(
          (identity) => ({ identity }),
          (error: unknown) => ({ error }),
        )
      : Promise.resolve({
          error: new Error("Process group ownership is unavailable"),
        });
  const processScope = Effect.runSync(Scope.make());
  const termination = Effect.runPromise(Deferred.await(terminated));
  void termination.catch(() => undefined);

  const settleTermination = (): void => {
    Deferred.doneUnsafe(
      terminated,
      terminationFailure === undefined
        ? Effect.void
        : Effect.fail(terminationFailure.cause),
    );
  };

  const recordCleanupFailure = (cause: unknown): void => {
    cleanupFailure = { cause };
    terminationFailure ??= { cause };
  };

  const pruneIgnoredResponses = (): void => {
    const now = currentTimeMillis();
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
    ignoredResponses.set(id, currentTimeMillis() + IGNORED_RESPONSE_TTL_MS);
  };

  const wasIgnoredResponse = (id: CodexRequestId): boolean => {
    pruneIgnoredResponses();
    return ignoredResponses.delete(id);
  };

  const rejectPending = (cause: unknown): void => {
    for (const [id, request] of pending) {
      pending.delete(id);
      Deferred.doneUnsafe(request.result, Effect.fail(cause));
    }
  };

  const awaitGracefulClose = (): Promise<boolean> =>
    Effect.runPromise(
      Deferred.await(terminated).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: SHUTDOWN_GRACE_MS,
          orElse: () => Effect.succeed(false),
        }),
      ),
    );

  const requestChildTermination = (): Promise<void> => {
    if (shutdown !== undefined) return shutdown;
    try {
      child.stdin.destroy();
    } catch {
      // Best-effort process cleanup.
    }
    shutdown = (async () => {
      if (options.terminateOwnedProcessGroup) {
        const captured = await identityCapture;
        if ("error" in captured) {
          // The child handle is safe for its own leader. Without a validated
          // identity, retain uncertainty and never signal a process group.
          try {
            child.kill("SIGTERM");
          } catch {
            // Best-effort leader cleanup after identity capture failed.
          }
          const exited = await awaitGracefulClose();
          if (!exited) child.kill("SIGKILL");
          await withDeadline(
            termination,
            SHUTDOWN_CONFIRM_TIMEOUT_MS,
            "process termination",
          );
          throw captured.error;
        }
        const graceful = await terminateOwnedProcess(
          captured.identity,
          "SIGTERM",
        );
        if (graceful.confirmed) return;
        const forced = await terminateOwnedProcess(
          captured.identity,
          "SIGKILL",
        );
        if (!forced.confirmed) {
          throw new Error(
            "Could not confirm Codex app-server process group stopped",
          );
        }
        return;
      }

      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort process cleanup for an injected child process.
      }
      const exited = await awaitGracefulClose();
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best-effort process cleanup for an injected child process.
        }
      }
      await withDeadline(
        termination,
        SHUTDOWN_CONFIRM_TIMEOUT_MS,
        "process termination",
      );
    })().catch((cause: unknown) => {
      recordCleanupFailure(cause);
      throw cause;
    });
    void shutdown.catch(() => undefined);
    return shutdown;
  };

  const fail = (cause: unknown): void => {
    if (state !== "open") return;
    terminationFailure = { cause };
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
      if (message.error !== undefined) {
        Deferred.doneUnsafe(
          request.result,
          Effect.fail(
            new CodexAdapterError(
              "execution",
              rejectedRequestMessage(request.method, message.error.code),
              message.error,
            ),
          ),
        );
      } else {
        Deferred.doneUnsafe(request.result, Effect.succeed(message.result));
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
      const cause = new CodexAdapterError(
        "execution",
        `Codex app-server disconnected (${code ?? signal ?? "unknown"})`,
      );
      terminationFailure = { cause };
      rejectPending(cause);
    }
    state = "closed";
    ignoredResponses.clear();
    listeners.clear();
    settleTermination();
  });

  // Stderr is intentionally ignored, but must be drained so diagnostics from
  // the child cannot fill the pipe and stall stdout or process shutdown.
  child.stderr.resume();

  const closeProcess = async (): Promise<void> => {
    try {
      if (state === "open") {
        state = "closing";
        rejectPending(
          new CodexAdapterError(
            "execution",
            "Codex app-server transport closed",
          ),
        );
      }
      if (shutdown === undefined) {
        try {
          child.stdin.end();
        } catch {
          // Best-effort process cleanup.
        }
      }
      const stopped = requestChildTermination();
      await withDeadline(
        stopped,
        SHUTDOWN_CONFIRM_TIMEOUT_MS,
        "process group shutdown",
      );
      await withDeadline(
        termination,
        SHUTDOWN_CONFIRM_TIMEOUT_MS,
        "process termination",
      );
    } catch (cause) {
      recordCleanupFailure(cause);
      throw cause;
    }
  };
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
      if (signal?.aborted) return Promise.reject(signal.reason);
      const result = Deferred.makeUnsafe<unknown, unknown>();
      const onAbort = (): void => {
        if (pending.delete(id)) ignoreResponse(id);
        Deferred.doneUnsafe(result, Effect.fail(signal?.reason));
      };
      return Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.sync(() =>
            signal?.addEventListener("abort", onAbort, { once: true }),
          ),
          () =>
            Effect.gen(function* () {
              if (signal?.aborted) return yield* Effect.fail(signal.reason);
              yield* Effect.try({
                try: () => {
                  pending.set(id, { method, result });
                  try {
                    writeMessage(child, { jsonrpc: "2.0", id, method, params });
                  } catch (cause) {
                    pending.delete(id);
                    throw cause;
                  }
                },
                catch: (cause) => cause,
              });
              return yield* Deferred.await(result);
            }),
          () =>
            Effect.sync(() => {
              signal?.removeEventListener("abort", onAbort);
              if (pending.delete(id)) ignoreResponse(id);
            }),
        ),
      );
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
    close: async () => {
      await Effect.runPromise(Scope.close(processScope, Exit.void));
      if (cleanupFailure !== undefined) {
        throw new CodexAdapterError(
          "cancellation",
          "Codex app-server process termination was not confirmed",
          cleanupFailure.cause,
        );
      }
      if (!Deferred.isDoneUnsafe(terminated)) {
        throw new CodexAdapterError(
          "cancellation",
          "Codex app-server process termination was not confirmed",
          terminationFailure?.cause,
        );
      }
    },
  };

  // Register process shutdown at acquisition, before the initialize request.
  // If initialization fails, closing this scope still owns partial startup.
  Effect.runSync(
    Scope.addFinalizer(
      processScope,
      codexEffect(closeProcess).pipe(Effect.catch(() => Effect.void)),
    ),
  );

  // Ownership must be acknowledged only after transport cleanup is installed,
  // and before any protocol message is written to the child.
  if (options.onOwnedProcessAcquired !== undefined) {
    try {
      if (child.pid === undefined) throw new Error("Codex process has no PID");
      await options.onOwnedProcessAcquired(child.pid);
    } catch (cause) {
      try {
        await transport.close();
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "Codex registration and process cleanup failed",
        );
      }
      throw cause;
    }
  }

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
        options.initializeTimeoutMs ?? CODEX_PREFLIGHT_TIMEOUT_MS,
        "initialize",
        options.signal,
      ),
    );
    writeMessage(child, { jsonrpc: "2.0", method: "initialized", params: {} });
    return transport;
  } catch (cause) {
    try {
      await transport.close();
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Codex initialization and process cleanup failed",
      );
    }
    throw cause;
  }
}
