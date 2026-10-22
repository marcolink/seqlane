import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import {
  captureOwnedProcessIdentity,
  confirmOwnedProcessGroupStopped,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "@seqlane/agent-adapter/private/owned-process";

import { ActionResolutionError } from "./errors.js";
import type { GitCommandResult } from "./git-port.js";

const maximumGitOutputBytes = 8 * 1024 * 1024;
const posix = process.platform !== "win32";

interface GitCommandOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly onUncertain?: (cause: unknown) => void;
}

class GitProcessOwnership {
  private readonly identityReady: Promise<OwnedProcessIdentity>;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly onStopFailure: (cause: unknown) => void,
  ) {
    this.identityReady = new Promise((resolve, reject) => {
      child.once("spawn", () => {
        if (posix && child.pid !== undefined) {
          captureOwnedProcessIdentity(child.pid).then(resolve, reject);
        }
      });
      child.once("error", reject);
    });
    void this.identityReady.catch(() => undefined);
  }

  // Keep the original observed promise: an async wrapper would create an
  // unobserved rejection when an abort or output handler requests shutdown.
  readonly stop = (): Promise<void> => {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = this.terminate();
    void this.stopping.catch(this.onStopFailure);
    return this.stopping;
  };

  private async terminate(): Promise<void> {
    if (!posix) {
      this.child.kill("SIGTERM");
      return;
    }
    const identity = await this.identityReady;
    const graceful = await terminateOwnedProcess(identity, "SIGTERM");
    if (graceful.confirmed) return;
    const forced = await terminateOwnedProcess(identity, "SIGKILL");
    if (!forced.confirmed) {
      throw new Error("Could not confirm that the Git process tree stopped.");
    }
  }

  async confirmStopped(): Promise<void> {
    if (posix && this.child.pid !== undefined) {
      let identity: OwnedProcessIdentity | undefined;
      try {
        identity = await this.identityReady;
      } catch {
        // A short command may exit before identity capture. Group absence
        // proves cleanup; it never authorizes signaling an unknown process.
      }
      if (!(await confirmOwnedProcessGroupStopped(this.child.pid))) {
        if (identity === undefined) {
          throw new Error(
            "Git exited with an active process group and no verified identity.",
          );
        }
        await this.stop();
      }
      if (!(await confirmOwnedProcessGroupStopped(this.child.pid))) {
        throw new Error("Git exited while its process group remained active.");
      }
    }
    await this.stopping;
  }
}

function captureGitOutput(stream: Readable, stop: () => Promise<void>) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumGitOutputBytes) {
      void stop();
      return;
    }
    chunks.push(buffer);
  });
  return {
    overflowed: () => bytes > maximumGitOutputBytes,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

export function runGitCommand(
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  const { executable, args, cwd, env, signal, onUncertain } = options;
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: { ...process.env, ...env },
      detached: posix,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rejectUncertain = (cause: unknown, rejection = cause) => {
      try {
        onUncertain?.(cause);
      } catch {
        // A notification failure cannot hide uncertain process ownership.
      }
      rejectResult(rejection);
    };
    const ownership = new GitProcessOwnership(child, (cause) =>
      rejectUncertain(
        cause,
        new ActionResolutionError(
          "git",
          "GIT_OPERATION_FAILED",
          "Could not confirm that the Git process tree stopped.",
          cause,
        ),
      ),
    );
    const stdout = captureGitOutput(child.stdout, ownership.stop);
    const stderr = captureGitOutput(child.stderr, ownership.stop);
    const onAbort = () => {
      void ownership.stop();
    };
    let spawnFailed = false;
    child.once("error", () => {
      signal?.removeEventListener("abort", onAbort);
      spawnFailed = true;
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("close", (code, terminationSignal) => {
      signal?.removeEventListener("abort", onAbort);
      void ownership.confirmStopped().then(
        () =>
          resolveResult({
            executable,
            args: [...args],
            cwd,
            exitCode:
              spawnFailed ||
              stdout.overflowed() ||
              stderr.overflowed() ||
              signal?.aborted
                ? 1
                : (code ?? (terminationSignal ? 1 : 0)),
            stdout: stdout.text(),
            stderr: stderr.text(),
          }),
        (cause: unknown) => rejectUncertain(cause),
      );
    });
  });
}
