import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { OpenCodeV2Error } from "./errors.js";
import type { ServerEnvironment } from "./environment.js";

/** Own exactly one foreground process group and its bounded startup output. */
export function spawnOwnedServer(
  executable: string,
  configuration: {
    workspace: string;
    host: string;
    port: number;
    password: string;
    environment: ServerEnvironment;
  },
) {
  const child = spawn(
    executable,
    [
      "serve",
      "--stdio",
      "--hostname",
      configuration.host,
      "--port",
      String(configuration.port),
    ],
    {
      cwd: configuration.workspace,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...configuration.environment,
        OPENCODE_SERVER_PASSWORD: configuration.password,
        OPENCODE_SERVER_USERNAME: "opencode",
      },
    },
  );
  let stdout = "";
  let startupError: unknown;
  let closing: Promise<void> | undefined;
  const collect = (chunk: Buffer): void => {
    stdout = (stdout + chunk.toString("utf8")).slice(-16_384);
  };
  child.stdout.on("data", collect);
  // Readiness frames use stdout. Drain stderr without mixing logs into frames.
  child.stderr.resume();
  child.on("error", (cause) => {
    startupError = cause;
  });
  function alive(): boolean {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (cause) {
      return z.object({ code: z.literal("EPERM") }).safeParse(cause).success;
    }
  }
  async function stop(): Promise<void> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!alive() || child.pid === undefined) break;
      try {
        process.kill(-child.pid, signal);
      } catch (cause) {
        if (!z.object({ code: z.literal("ESRCH") }).safeParse(cause).success)
          throw cause;
      }
      const deadline = Date.now() + (signal === "SIGTERM" ? 5_000 : 1_000);
      while (alive() && Date.now() < deadline) await setTimeout(25);
    }
    if (alive())
      throw new OpenCodeV2Error(
        "termination",
        "owned server process tree did not stop",
      );
    child.stdin.destroy();
    child.stdout.off("data", collect);
  }
  const close = (): Promise<void> => (closing ??= stop());
  return {
    get pid() {
      return child.pid;
    },
    get stdout() {
      return stdout;
    },
    get startupError() {
      return startupError;
    },
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    close,
  };
}
