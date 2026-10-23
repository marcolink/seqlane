import { Effect } from "effect";
import type { GitCommandResult } from "./git-port.js";
import {
  ownedCommandEffect,
  type CommandOwnershipState,
} from "./command-process.js";

interface GitCommandOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly onUncertain?: (cause: unknown) => void;
}

export async function runGitCommand(
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  if (options.signal?.aborted)
    return {
      executable: options.executable,
      args: [...options.args],
      cwd: options.cwd,
      exitCode: 1,
      stdout: "",
      stderr: "",
    };
  const state: CommandOwnershipState = {};
  const value = await Effect.runPromise(
    ownedCommandEffect(
      { ...options, env: { ...process.env, ...options.env } },
      state,
    ).pipe(
      Effect.catch(() =>
        Effect.succeed({
          exitCode: 1,
          stdout: state.output?.stdout() ?? "",
          stderr: state.output?.stderr() ?? "",
        }),
      ),
    ),
    options.signal === undefined ? {} : { signal: options.signal },
  ).catch((cause: unknown) => {
    if (options.signal?.aborted)
      return {
        exitCode: 1,
        stdout: state.output?.stdout() ?? "",
        stderr: state.output?.stderr() ?? "",
      };
    throw cause;
  });
  if (state.uncertainty !== undefined) {
    try {
      options.onUncertain?.(state.uncertainty.cause);
    } catch {
      /* Keep cleanup failure. */
    }
    throw state.uncertainty.cause;
  }
  return {
    executable: options.executable,
    args: [...options.args],
    cwd: options.cwd,
    ...value,
  };
}
