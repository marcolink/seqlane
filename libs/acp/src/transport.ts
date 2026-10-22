import { execFileSync } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  DEFAULT_MAX_MESSAGE_BYTES,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
} from "@agentclientprotocol/sdk";
import protocolSchema from "@agentclientprotocol/sdk/schema/v1/schema.json" with { type: "json" };
import { Effect, Exit, Option, Scope } from "effect";
import { z } from "zod";
import type { JSONSchema as ZodJsonSchema } from "zod/v4/core";
import { awaitSdkWithin } from "./bounded-sdk-wait.js";
import type { AcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError } from "./errors.js";

const PROCESS_SHUTDOWN_GRACE_MS = 1_000;
const PROCESS_SHUTDOWN_CONFIRM_MS = 5_000;
const CONNECTION_CLOSE_CONFIRM_MS = 2_000;
// The SDK ships generated JSON Schema; this cast bridges its loose JSON import
// to Zod's official JSON Schema parameter type.
const sdkDefinitions = z
  .record(z.string(), z.json())
  .parse(protocolSchema.$defs);
const sessionNotificationJsonSchema = {
  $defs: sdkDefinitions,
  $ref: "#/$defs/SessionNotification",
} as ZodJsonSchema.JSONSchema;
const sessionNotificationSchema = z.fromJSONSchema(
  sessionNotificationJsonSchema,
);

export interface AcpTransport {
  readonly context: ClientContext;
  readonly signal: AbortSignal;
  readonly failure: () =>
    | { readonly failed: false }
    | { readonly failed: true; readonly cause: unknown };
  readonly interactionSignal: () => AbortSignal;
  readonly supportsSessionClose: boolean;
  readonly interactionRequested: () => boolean;
  readonly clearInteraction: () => void;
  readonly close: () => Promise<void>;
}

function processGroupHasLiveProcesses(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const rows = execFileSync("ps", ["-eo", "pgid=,stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    });
    return rows.split("\n").some((row) => {
      const match = /^\s*(\d+)\s+(\S+)/.exec(row);
      return match?.[1] === String(pid) && !match[2]?.startsWith("Z");
    });
  } catch {
    return true;
  }
}

function windowsTreeHasLiveProcesses(rootPid: number): boolean {
  const script = [
    "$root = [int]$args[0]",
    "$all = @(Get-CimInstance Win32_Process)",
    "$ids = [System.Collections.Generic.HashSet[int]]::new()",
    "$null = $ids.Add($root)",
    "do { $before = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { $null = $ids.Add([int]$p.ProcessId) } } } while ($ids.Count -gt $before)",
    "$ids | ForEach-Object { if ($all.ProcessId -contains $_) { $_ } }",
  ].join("; ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script, String(rootPid)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
  );
  return output.trim().length > 0;
}

function processTreeHasLiveProcesses(
  child: ChildProcessWithoutNullStreams,
): boolean {
  if (child.pid === undefined) return false;
  return process.platform === "win32"
    ? windowsTreeHasLiveProcesses(child.pid)
    : processGroupHasLiveProcesses(child.pid);
}

function signalOwnedProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): unknown | undefined {
  if (child.pid === undefined || !processTreeHasLiveProcesses(child))
    return undefined;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
    return undefined;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    )
      return undefined;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "EPERM"
    ) {
      // Some sandbox profiles deny signaling a process group while still
      // allowing the directly owned child. The group-exit poll below remains
      // authoritative and will report uncertainty if descendants survive.
      try {
        child.kill(signal);
        return cause;
      } catch (childCause) {
        return new AggregateError(
          [cause, childCause],
          "ACP process-group and leader signals failed",
        );
      }
    }
    return cause;
  }
}

async function waitForProcessTreeExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  const wait = Effect.whileLoop({
    while: () => processTreeHasLiveProcesses(child),
    body: () => Effect.sleep(25),
    step: () => undefined,
  }).pipe(Effect.as(true), Effect.timeoutOption(timeoutMs));
  const result = await Effect.runPromise(wait);
  return Option.isSome(result) || !processTreeHasLiveProcesses(child);
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let onExit = (): void => undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = () => resolve();
    child.once("exit", onExit);
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    child.off("exit", onExit);
    return true;
  }
  const result = await Effect.runPromise(
    Effect.promise(() => exited).pipe(Effect.timeoutOption(timeoutMs)),
  );
  child.off("exit", onExit);
  return (
    Option.isSome(result) ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

async function confirmChildAndTreeExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await waitForProcessTreeExit(child, timeoutMs))) return false;
  return waitForChildExit(child, timeoutMs);
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.pid === undefined) return;
  child.stdin.destroy();
  const signalFailures: unknown[] = [];
  if (process.platform === "win32") {
    const leaderExited = child.exitCode !== null || child.signalCode !== null;
    if (!leaderExited) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: PROCESS_SHUTDOWN_CONFIRM_MS,
        });
      } catch (cause) {
        signalFailures.push(cause);
      }
    }
    if (await confirmChildAndTreeExit(child, PROCESS_SHUTDOWN_CONFIRM_MS))
      return;
    throw new AcpAdapterError(
      "cancellation",
      "Windows ACP process-tree termination was not confirmed",
      signalFailures.length === 0
        ? undefined
        : new AggregateError(signalFailures),
    );
  }
  if (!processTreeHasLiveProcesses(child)) {
    if (await waitForChildExit(child, PROCESS_SHUTDOWN_CONFIRM_MS)) return;
    throw new AcpAdapterError(
      "cancellation",
      "ACP child process exit was not confirmed",
    );
  }
  const termFailure = signalOwnedProcessTree(child, "SIGTERM");
  if (termFailure !== undefined) signalFailures.push(termFailure);
  if (await confirmChildAndTreeExit(child, PROCESS_SHUTDOWN_GRACE_MS)) return;
  const killFailure = signalOwnedProcessTree(child, "SIGKILL");
  if (killFailure !== undefined) signalFailures.push(killFailure);
  if (await confirmChildAndTreeExit(child, PROCESS_SHUTDOWN_CONFIRM_MS)) return;
  throw new AcpAdapterError(
    "cancellation",
    "ACP process-tree termination was not confirmed",
    signalFailures.length === 0
      ? undefined
      : new AggregateError(signalFailures),
  );
}

function makeClientApp(onPermissionRequest: () => void) {
  return client({ name: "Seqlane" })
    .onRequest(methods.client.session.requestPermission, () => {
      onPermissionRequest();
      return { outcome: { outcome: "cancelled" } };
    })
    .onRequest(methods.client.fs.readTextFile, () => {
      throw new AcpAdapterError(
        "execution",
        "ACP agent requested a file read that Seqlane does not provide",
      );
    })
    .onRequest(methods.client.fs.writeTextFile, () => {
      throw new AcpAdapterError(
        "execution",
        "ACP agent requested a file write that Seqlane does not provide",
      );
    })
    .onRequest(methods.client.terminal.create, () => {
      throw new AcpAdapterError(
        "execution",
        "ACP agent requested a terminal that Seqlane does not provide",
      );
    });
}

function validateNotificationFrame(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP peer sent invalid JSON",
      cause,
    );
  }
  const json = z.json().safeParse(parsed);
  if (!json.success) {
    throw new AcpAdapterError(
      "malformed-stream",
      "ACP peer sent a non-JSON value",
      json.error,
    );
  }
  const envelope = z
    .object({ method: z.string(), params: z.unknown().optional() })
    .passthrough()
    .safeParse(parsed);
  if (
    envelope.success &&
    envelope.data.method === methods.client.session.update
  ) {
    const notification = sessionNotificationSchema.safeParse(
      envelope.data.params,
    );
    if (!notification.success) {
      throw new AcpAdapterError(
        "malformed-stream",
        "ACP peer sent an invalid session update",
        notification.error,
      );
    }
  }
}

function validateInboundStream(
  input: ReadableStream<Uint8Array>,
  onFailure: (cause: unknown) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        try {
          if (chunk.byteLength > DEFAULT_MAX_MESSAGE_BYTES) {
            throw new AcpAdapterError(
              "limit",
              "ACP frame exceeded the SDK message limit",
            );
          }
          pending += decoder.decode(chunk, { stream: true });
          if (encoder.encode(pending).byteLength > DEFAULT_MAX_MESSAGE_BYTES) {
            throw new AcpAdapterError(
              "limit",
              "ACP frame exceeded the SDK message limit",
            );
          }
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const frame = pending.slice(0, newline);
            if (frame.trim().length > 0) validateNotificationFrame(frame);
            controller.enqueue(encoder.encode(`${frame}\n`));
            pending = pending.slice(newline + 1);
            if (
              encoder.encode(pending).byteLength > DEFAULT_MAX_MESSAGE_BYTES
            ) {
              throw new AcpAdapterError(
                "limit",
                "ACP frame exceeded the SDK message limit",
              );
            }
            newline = pending.indexOf("\n");
          }
        } catch (cause) {
          onFailure(cause);
          throw cause;
        }
      },
      flush(controller) {
        try {
          pending += decoder.decode();
          if (pending.length === 0) return;
          if (encoder.encode(pending).byteLength > DEFAULT_MAX_MESSAGE_BYTES) {
            throw new AcpAdapterError(
              "limit",
              "ACP frame exceeded the SDK message limit",
            );
          }
          if (pending.trim().length === 0) {
            controller.enqueue(encoder.encode(pending));
            return;
          }
          validateNotificationFrame(pending);
          controller.enqueue(encoder.encode(pending));
        } catch (cause) {
          onFailure(cause);
          throw cause;
        }
      },
    }),
  );
}

/** Own one stable ACP v1 SDK connection and its child process tree. */
export async function createAcpTransport(
  configuration: AcpLaunchConfiguration,
  shutdownSignal?: AbortSignal,
  onOwnedProcessAcquired?: (pid: number) => Promise<void>,
): Promise<AcpTransport> {
  const scope = Effect.runSync(Scope.make());
  const child = await Effect.runPromise(
    Effect.provideService(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            spawn(configuration.command, configuration.args ?? [], {
              cwd: configuration.cwd,
              env: { ...process.env, ...configuration.env },
              stdio: ["pipe", "pipe", "pipe"],
              detached: process.platform !== "win32",
            }) as ChildProcessWithoutNullStreams,
        ),
        (processHandle) => Effect.promise(() => terminateChild(processHandle)),
      ),
      Scope.Scope,
      scope,
    ),
  );

  if (onOwnedProcessAcquired !== undefined) {
    let processFailureCause: AcpAdapterError | undefined;
    const onProcessError = (cause: Error): void => {
      processFailureCause = new AcpAdapterError(
        "execution",
        "ACP process failed during ownership registration",
        cause,
      );
    };
    const onProcessClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      processFailureCause = new AcpAdapterError(
        "execution",
        `ACP process exited during ownership registration (${code ?? signal ?? "unknown"})`,
      );
    };
    child.once("error", onProcessError);
    child.once("close", onProcessClose);
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("ACP process has no PID");
      await onOwnedProcessAcquired(pid);
      if (processFailureCause !== undefined) throw processFailureCause;
    } catch (cause) {
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "ACP registration and process cleanup failed",
        );
      }
      throw cause;
    } finally {
      child.off("error", onProcessError);
      child.off("close", onProcessClose);
    }
  }

  child.stderr.resume();
  let permissionRequested = false;
  let permissionController = new AbortController();
  let closing = false;
  const app = makeClientApp(() => {
    permissionRequested = true;
    permissionController.abort(
      new Error("ACP agent requested user interaction"),
    );
  });
  let streamFailure:
    { readonly failed: true; readonly cause: unknown } | undefined;
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    validateInboundStream(
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      (cause) => {
        streamFailure = { failed: true, cause };
      },
    ),
  );
  const connection: ClientConnection = app.connect(stream);
  const context = connection.agent;
  let closingPromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closingPromise !== undefined) return closingPromise;
    closing = true;
    closingPromise = (async () => {
      const failures: unknown[] = [];
      try {
        // SDK close is synchronous and may throw. It must not skip the Scope
        // finalizer which owns the child process tree.
        connection.close();
      } catch (cause) {
        failures.push(cause);
      }
      try {
        const connectionClosed = await awaitSdkWithin(
          connection.closed.then(
            () => true,
            (cause: unknown) => {
              failures.push(cause);
              return true;
            },
          ),
          CONNECTION_CLOSE_CONFIRM_MS,
        );
        if (connectionClosed.timedOut) {
          failures.push(
            new AcpAdapterError(
              "cancellation",
              "ACP SDK connection close was not confirmed",
            ),
          );
        }
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } catch (cause) {
        failures.push(cause);
      }
      try {
        if (processTreeHasLiveProcesses(child)) {
          failures.push(
            new AcpAdapterError(
              "cancellation",
              "ACP process-tree exit was not confirmed",
            ),
          );
        }
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "ACP transport shutdown was not confirmed",
        );
      }
    })();
    return closingPromise;
  };

  child.on("error", () => {
    if (!closing) void close().catch(() => undefined);
  });
  child.on("exit", () => {
    if (!closing) void close().catch(() => undefined);
  });
  const onShutdown = (): void => {
    void close().catch(() => undefined);
  };
  shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  try {
    const initialized = await Effect.runPromise(
      Effect.raceFirst(
        Effect.promise(() =>
          context.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "Seqlane", version: "0.0.0" },
          }),
        ),
        Effect.raceFirst(
          shutdownSignal === undefined
            ? Effect.never
            : Effect.callback<never, unknown>((resume) => {
                const onAbort = (): void =>
                  resume(Effect.fail(shutdownSignal.reason));
                if (shutdownSignal.aborted) onAbort();
                else
                  shutdownSignal.addEventListener("abort", onAbort, {
                    once: true,
                  });
                return Effect.sync(() =>
                  shutdownSignal.removeEventListener("abort", onAbort),
                );
              }),
          Effect.promise(() => connection.closed).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new AcpAdapterError(
                  "execution",
                  "ACP connection closed during initialization",
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return {
      context,
      signal: connection.signal,
      failure: () => streamFailure ?? { failed: false },
      interactionSignal: () => permissionController.signal,
      supportsSessionClose:
        initialized.agentCapabilities?.sessionCapabilities?.close != null,
      interactionRequested: () => permissionRequested,
      clearInteraction: () => {
        permissionRequested = false;
        permissionController = new AbortController();
      },
      close,
    };
  } catch (cause) {
    shutdownSignal?.removeEventListener("abort", onShutdown);
    try {
      await close();
    } catch (cleanupCause) {
      throw new AcpAdapterError(
        "execution",
        "ACP initialization failed and cleanup was not confirmed",
        new AggregateError([cause, cleanupCause]),
      );
    }
    throw new AcpAdapterError("execution", "ACP initialization failed", cause);
  }
}
