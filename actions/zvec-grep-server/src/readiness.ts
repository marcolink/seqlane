import { Cause, Effect, Schedule } from "effect";
import { spawn, type ChildProcess } from "node:child_process";

export { buildReadinessArguments } from "./commands.js";

const COMMAND_DEADLINE_MILLISECONDS = 10 * 60 * 1_000;

export interface ParsedListenAddress {
  readonly listen: string;
  readonly mcpUrl: string;
}

export function parseListenAddress(listen: string): ParsedListenAddress {
  if (listen.trim() !== listen || listen.length === 0) {
    throw new Error("listen must contain a hostname and non-default port");
  }

  let parsed: URL;
  try {
    parsed = new URL(`http://${listen}`);
  } catch {
    throw new Error("listen must contain a hostname and non-default port");
  }

  if (
    !parsed.hostname ||
    !parsed.port ||
    Number(parsed.port) <= 0 ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("listen must contain a hostname and non-default port");
  }

  return {
    listen: parsed.host,
    mcpUrl: `${parsed.origin}/mcp`,
  };
}

export function mcpUrl(listen: string): string {
  return parseListenAddress(listen).mcpUrl;
}

export function waitForCommandHealth(
  check: () => Effect.Effect<void, Error>,
  timeoutMilliseconds: number,
  name: string,
): Effect.Effect<void, Error | Cause.TimeoutError> {
  const polling = Effect.retry(check(), Schedule.spaced("1 second"));

  return Effect.timeout(polling, timeoutMilliseconds).pipe(
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new Error(`${name} did not become ready before the startup timeout`),
      ),
    ),
  );
}

export function runReadinessCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Effect.Effect<void, Error | Cause.TimeoutError> {
  return runCommand({ ...input, timeoutMilliseconds: 3_000 });
}

export function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
}): Effect.Effect<void, Error | Cause.TimeoutError> {
  const child = Effect.acquireUseRelease(
    Effect.sync(() =>
      spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    ),
    runChild,
    stopChild,
  );

  return Effect.timeout(
    child,
    input.timeoutMilliseconds ?? COMMAND_DEADLINE_MILLISECONDS,
  );
}

function hasExited(child: ChildProcess): boolean {
  return (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
}

function waitForClose(child: ChildProcess): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume, signal) => {
    if (hasExited(child)) {
      resume(Effect.void);
      return;
    }
    const cleanup = () => {
      child.off("close", onClose);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onClose = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (error: Error) => {
      cleanup();
      resume(Effect.fail(error));
    };
    const onAbort = () => cleanup();
    child.once("close", onClose);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function runChild(child: ChildProcess): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume, signal) => {
    let bytes = 0;
    let spawnError: Error | undefined;
    let outputLimitExceeded = false;
    const cleanup = () => {
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => {
      spawnError = error;
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1_024 * 1_024 && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
      }
    };
    const onClose = (
      code: number | null,
      signalValue: NodeJS.Signals | null,
    ) => {
      cleanup();
      if (outputLimitExceeded) {
        resume(
          Effect.fail(new Error("Command output exceeded its 1 MiB limit")),
        );
      } else if (spawnError) {
        resume(
          Effect.fail(
            new Error(`Could not run command`, { cause: spawnError }),
          ),
        );
      } else if (code !== 0) {
        resume(
          Effect.fail(
            new Error(
              `Command exited with code ${String(code)} and signal ${String(signalValue)}`,
            ),
          ),
        );
      } else {
        resume(Effect.void);
      }
    };
    const onAbort = () => cleanup();
    child.on("error", onError);
    child.once("close", onClose);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stopChild(child: ChildProcess): Effect.Effect<void, Error> {
  if (hasExited(child)) return Effect.void;

  return Effect.gen(function* () {
    child.kill("SIGTERM");
    const exitedGracefully = yield* Effect.timeoutOption(
      waitForClose(child),
      "1 second",
    );
    if (exitedGracefully._tag === "Some") return;

    child.kill("SIGKILL");
    yield* Effect.timeout(waitForClose(child), "3 seconds").pipe(
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new Error("Command did not exit after SIGKILL")),
      ),
    );
  });
}
