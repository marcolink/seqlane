import { acquireOpenCodeServiceProcess } from "./service-process.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { randomBytes } from "node:crypto";
import { Effect, Exit, Option, Scope } from "effect";
import { OpenCodeServiceStartupError } from "./errors.js";

const OPENCODE_HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const OPENCODE_SERVER_USERNAME = "seqlane";

export interface OpenCodeService {
  readonly url: string;
  /** Private HTTP Basic credential for this owned service process. */
  readonly authorization: string;
  readonly diagnostics: () => string;
  close(): Promise<void>;
}

export interface StartOpenCodeServiceOptions {
  readonly workspace: string;
  readonly signal: AbortSignal;
  /** Loopback address for the owned service. */
  readonly host?: string;
  /** TCP port for the owned service; zero asks OpenCode to select one. */
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly fetch?: typeof fetch;
  /** Registers the spawned service before startup polling or HTTP begins. */
  readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
}

function startupError(
  cause: unknown,
  cleanupFailure?: { readonly cause: unknown },
): OpenCodeServiceStartupError {
  const primary =
    cause instanceof OpenCodeServiceStartupError
      ? cause
      : new OpenCodeServiceStartupError(
          typeof cause === "object" &&
            cause !== null &&
            Reflect.get(cause, "code") === "ENOENT"
            ? "OpenCode executable is unavailable; install OpenCode and authenticate with its native setup"
            : "OpenCode could not be started",
          cause,
        );
  return cleanupFailure === undefined
    ? primary
    : new OpenCodeServiceStartupError(primary.message, primary, cleanupFailure);
}

function appendBounded(current: string, chunk: Buffer): string {
  const bytes = Buffer.from(current + chunk.toString("utf8"));
  if (bytes.byteLength <= OUTPUT_LIMIT_BYTES) return bytes.toString("utf8");
  const tail = bytes.subarray(-OUTPUT_LIMIT_BYTES);
  // The re-encoded string is valid UTF-8. Drop a partial leading code point.
  let offset = 0;
  while (((tail[offset] ?? 0) & 0xc0) === 0x80) offset += 1;
  return tail.subarray(offset).toString("utf8");
}

function parseOpenCodeUrl(
  output: string,
  host: string,
  port: number,
): string | undefined {
  const match = /opencode server listening on\s+(https?:\/\/[^\s]+)/.exec(
    output,
  );
  if (match?.[1] === undefined) return undefined;
  try {
    const url = new URL(match[1]);
    const actualPort =
      url.port === "" && url.protocol === "http:" ? 80 : Number(url.port);
    return url.protocol === "http:" &&
      url.hostname.replace(/^\[|\]$/g, "") === host &&
      Number.isInteger(actualPort) &&
      actualPort > 0 &&
      (port === 0 || actualPort === port)
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function waitForOpenCodeReady(options: {
  readonly child: ChildProcess;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly url: () => string | undefined;
  readonly startupFailure: () => { readonly cause: unknown } | undefined;
  readonly fetch: typeof fetch;
  readonly authorization: string;
}): Promise<string> {
  let readyUrl: string | undefined;
  const check = Effect.gen(function* () {
    if (options.signal.aborted) {
      return yield* Effect.fail(
        new OpenCodeServiceStartupError("OpenCode startup was cancelled"),
      );
    }
    const startupFailure = options.startupFailure();
    if (startupFailure !== undefined)
      return yield* Effect.fail(startupFailure.cause);
    if (options.child.exitCode !== null || options.child.signalCode !== null) {
      return yield* Effect.fail(
        new OpenCodeServiceStartupError(
          "OpenCode exited before becoming ready",
        ),
      );
    }
    const url = options.url();
    if (url !== undefined) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.fetch(`${url}/global/health`, {
            headers: { authorization: options.authorization },
            signal: AbortSignal.any([options.signal, signal]),
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.timeoutOption(2_000),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      if (Option.isSome(response)) {
        yield* Effect.tryPromise({
          try: () =>
            Promise.resolve(response.value.body?.cancel()).then(
              () => undefined,
            ),
          catch: (cause: unknown) => cause,
        }).pipe(Effect.catch(() => Effect.void));
        if (response.value.ok) readyUrl = url;
      }
    }
    if (readyUrl === undefined) yield* Effect.sleep("50 millis");
  });
  const poll = Effect.whileLoop({
    while: () => readyUrl === undefined && !options.signal.aborted,
    body: () => check,
    step: () => undefined,
  }).pipe(Effect.timeoutOption(options.timeoutMs));
  return Effect.runPromise(poll).then((result) => {
    if (readyUrl !== undefined) return readyUrl;
    if (options.signal.aborted) {
      throw new OpenCodeServiceStartupError("OpenCode startup was cancelled");
    }
    if (Option.isNone(result)) {
      throw new OpenCodeServiceStartupError(
        "OpenCode did not become ready before the startup timeout",
      );
    }
    throw new OpenCodeServiceStartupError("OpenCode did not become ready");
  });
}

/** Starts one private OpenCode service without changing its native configuration. */
export async function startOpenCodeService(
  options: StartOpenCodeServiceOptions,
): Promise<OpenCodeService> {
  if (options.signal.aborted) {
    throw new OpenCodeServiceStartupError("OpenCode startup was cancelled");
  }
  const host = options.host ?? OPENCODE_HOST;
  const port = options.port ?? 0;
  // OpenCode supports Basic auth through these native environment variables.
  // A distinct secret prevents other local processes from using this run's API.
  const password = randomBytes(32).toString("base64url");
  const authorization = `Basic ${Buffer.from(
    `${OPENCODE_SERVER_USERNAME}:${password}`,
  ).toString("base64")}`;
  const serviceScope = Effect.runSync(Scope.make("sequential"));
  let output = "";
  let endpoint: string | undefined;
  let startupFailure: { readonly cause: unknown } | undefined;
  let cleanupFailure: { readonly cause: unknown } | undefined;
  const onOutput = (chunk: Buffer): void => {
    output = appendBounded(output, chunk);
    endpoint ??= parseOpenCodeUrl(output, host, port);
  };
  const onError = (cause: unknown): void => {
    startupFailure = { cause };
  };
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const acquire = acquireOpenCodeServiceProcess(options, {
    host,
    port,
    password,
    shutdownTimeoutMs,
    onOutput,
    onError,
    onCleanupFailure: (cause) => {
      cleanupFailure = { cause };
    },
  }).pipe(Effect.provideService(Scope.Scope, serviceScope));
  let child: ChildProcess;
  try {
    child = await Effect.runPromise(acquire);
  } catch (cause) {
    await Effect.runPromise(Scope.close(serviceScope, Exit.void));
    throw startupError(cause, cleanupFailure);
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await Effect.runPromise(Scope.close(serviceScope, Exit.void));
      if (cleanupFailure !== undefined) throw cleanupFailure.cause;
    })();
    return closePromise;
  };

  try {
    if (options.onOwnedProcessAcquired !== undefined) {
      if (child.pid === undefined) {
        throw new OpenCodeServiceStartupError(
          "OpenCode process ownership could not be identified",
        );
      }
      await options.onOwnedProcessAcquired(child.pid);
    }
    const url = await waitForOpenCodeReady({
      child,
      signal: options.signal,
      timeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      url: () => endpoint,
      startupFailure: () => startupFailure,
      fetch: options.fetch ?? fetch,
      authorization,
    });
    return { url, authorization, diagnostics: () => output, close };
  } catch (cause) {
    let startupCleanupFailure: { readonly cause: unknown } | undefined;
    try {
      await close();
    } catch (cleanupCause) {
      startupCleanupFailure = { cause: cleanupCause };
    }
    const primaryCause =
      startupFailure === undefined ? cause : startupFailure.cause;
    throw startupError(primaryCause, startupCleanupFailure);
  }
}
