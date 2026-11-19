import { acquireAcpProcess } from "./process.js";
import { Writable } from "node:stream";
import * as NodeStream from "@effect/platform-node/NodeStream";

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
import { Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import type { JSONSchema as ZodJsonSchema } from "zod/v4/core";
import { awaitSdkWithin } from "./bounded-sdk-wait.js";
import type { AcpLaunchConfiguration } from "./contracts.js";
import { AcpAdapterError } from "./errors.js";

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
  const acquired = await Effect.runPromise(
    acquireAcpProcess(configuration, scope),
  ).catch(async (cause: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  });

  const child = acquired.handle;
  const lifecycle = acquired.lifecycle;
  if (onOwnedProcessAcquired !== undefined) {
    try {
      if (child.pid === undefined) throw new Error("ACP process has no PID");
      await onOwnedProcessAcquired(child.pid);
      if (!(await Effect.runPromise(lifecycle.isRunning)))
        throw new AcpAdapterError(
          "execution",
          "ACP process exited during ownership registration",
        );
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
    }
  }

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
      Stream.toReadableStream(
        NodeStream.fromReadable({
          evaluate: () => child.stdout,
          onError: (cause) => cause,
        }),
      ),
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
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "ACP transport shutdown was not confirmed",
        );
      }
    })();
    return closingPromise;
  };

  await Effect.runPromise(
    Effect.forkIn(
      lifecycle.exit.pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(
          Effect.sync(() => {
            if (!closing) void close().catch(() => undefined);
          }),
        ),
      ),
      scope,
    ),
  );
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
