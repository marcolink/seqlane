import type { Command as PlatformCommand } from "@effect/platform";
import * as Command from "@effect/platform/Command";
import type { Process } from "@effect/platform/CommandExecutor";
import type { NodeContext as PlatformNodeContext } from "@effect/platform-node";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { Effect, Stream } from "effect";

export interface EffectSubprocessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly outputLimitBytes: number;
  readonly signal?: AbortSignal;
  readonly onStarted?: (pid: number) => void;
}

export interface EffectSubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class EffectSubprocessSpawnError extends Error {
  constructor(override readonly cause: unknown) {
    super("Effect subprocess could not start", { cause });
    this.name = "EffectSubprocessSpawnError";
  }
}

export class EffectSubprocessStreamError extends Error {
  constructor(override readonly cause: unknown) {
    super("Effect subprocess stream failed", { cause });
    this.name = "EffectSubprocessStreamError";
  }
}

export class EffectSubprocessExitError extends Error {
  constructor(override readonly cause: unknown) {
    super("Effect subprocess exit wait failed", { cause });
    this.name = "EffectSubprocessExitError";
  }
}

export class EffectSubprocessInterruptedError extends Error {
  constructor() {
    super("Effect subprocess was interrupted");
    this.name = "EffectSubprocessInterruptedError";
  }
}

export class EffectSubprocessOutputLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Effect subprocess output exceeded ${limitBytes} bytes`);
    this.name = "EffectSubprocessOutputLimitError";
  }
}

function collectBoundedOutput(
  stream: Stream.Stream<Uint8Array, unknown>,
  limitBytes: number,
) {
  return Stream.runFoldEffect(stream, new Uint8Array(), (output, chunk) => {
    if (output.byteLength + chunk.byteLength > limitBytes) {
      return Effect.fail(new EffectSubprocessOutputLimitError(limitBytes));
    }

    const next = new Uint8Array(output.byteLength + chunk.byteLength);
    next.set(output);
    next.set(chunk, output.byteLength);
    return Effect.succeed(next);
  }).pipe(
    Effect.map((output) => new TextDecoder().decode(output)),
    Effect.mapError((cause) =>
      cause instanceof EffectSubprocessOutputLimitError
        ? cause
        : new EffectSubprocessStreamError(cause),
    ),
  );
}

const nodeContextLayer: typeof PlatformNodeContext.layer = NodeContext.layer;

function stopAndWait(process: Process) {
  return Effect.uninterruptible(
    process.kill("SIGTERM").pipe(
      Effect.catchAll(() => Effect.void),
      Effect.andThen(process.exitCode),
      Effect.catchAll(() => Effect.void),
    ),
  );
}

function interruption(signal: AbortSignal | undefined) {
  if (signal === undefined) return Effect.never;

  return Effect.async<never, EffectSubprocessInterruptedError>((resume) => {
    const abort = () =>
      resume(Effect.fail(new EffectSubprocessInterruptedError()));
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

export function effectSubprocessPrototype(request: EffectSubprocessRequest) {
  const command: PlatformCommand.Command = Command.workingDirectory(
    Command.make(request.command, ...request.args),
    request.cwd,
  );
  const program = Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(command).pipe(
        Effect.mapError((cause) => new EffectSubprocessSpawnError(cause)),
      );
      request.onStarted?.(process.pid);
      yield* Effect.addFinalizer(() => stopAndWait(process));

      return yield* Effect.all(
        {
          stdout: collectBoundedOutput(
            process.stdout,
            request.outputLimitBytes,
          ),
          stderr: collectBoundedOutput(
            process.stderr,
            request.outputLimitBytes,
          ),
          exitCode: process.exitCode.pipe(
            Effect.mapError((cause) => new EffectSubprocessExitError(cause)),
          ),
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(Effect.raceFirst(interruption(request.signal)));

  return program;
}

export function runEffectSubprocessPrototype(
  request: EffectSubprocessRequest,
): Promise<EffectSubprocessResult> {
  return Effect.runPromise(
    Effect.provide(effectSubprocessPrototype(request), nodeContextLayer),
  );
}
