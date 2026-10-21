import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { createClient, OPENCODE_V2_VERSION, verifyServer } from "./client.js";
import { spawnOwnedServer } from "./process.js";
import { OpenCodeV2Error } from "./errors.js";

export const loopbackHostSchema = z.string().transform((host, context) => {
  if (host === "localhost") return "127.0.0.1";
  if (isIP(host) === 4 && host.startsWith("127.")) return host;
  if (isIP(host) === 6 && new URL(`http://[${host}]`).hostname === "[::1]")
    return "::1";
  context.addIssue({ code: "custom", message: "must be a loopback host" });
  return z.NEVER;
});
const startupSchema = z.strictObject({
  workspace: z.string().min(1),
  host: loopbackHostSchema.default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(0),
  executable: z
    .string()
    .min(1)
    .pipe(
      z.custom<string>(
        (value) => typeof value === "string" && isAbsolute(value),
        "must be an absolute executable path",
      ),
    )
    .optional(),
});

/** A foreground server owned by this run. No native shared-service discovery. */
export async function startOpenCodeV2Service(options: {
  workspace: string;
  signal: AbortSignal;
  host?: string;
  port?: number;
  executable?: string;
  onOwnedProcessAcquired?: (pid: number) => Promise<void>;
}) {
  const { signal, onOwnedProcessAcquired, ...input } = options;
  const configuration = startupSchema.parse(input);
  signal.throwIfAborted();
  if (!["darwin", "linux"].includes(process.platform))
    throw new OpenCodeV2Error(
      "compatibility",
      "managed V2 servers require macOS or Linux",
    );
  const executable = configuration.executable ?? "opencode";
  try {
    const version = await promisify(execFile)(executable, ["--version"], {
      signal,
      timeout: 10_000,
      maxBuffer: 16_384,
    });
    if (
      !z
        .enum([OPENCODE_V2_VERSION, `opencode v${OPENCODE_V2_VERSION}`])
        .safeParse(version.stdout.trim()).success
    )
      throw new OpenCodeV2Error(
        "compatibility",
        `executable must be OpenCode ${OPENCODE_V2_VERSION}`,
      );
  } catch (cause) {
    if (cause instanceof OpenCodeV2Error) throw cause;
    throw new OpenCodeV2Error(
      "configuration",
      "cannot validate the selected V2 executable",
      cause,
    );
  }
  const password = randomBytes(32).toString("base64url");
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const owned = spawnOwnedServer(executable, { ...configuration, password });
  const close = owned.close;
  try {
    if (owned.pid === undefined)
      throw new OpenCodeV2Error(
        "execution",
        "owned server has no process identity",
      );
    await onOwnedProcessAcquired?.(owned.pid);
    const startupSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(30_000),
    ]);
    while (true) {
      startupSignal.throwIfAborted();
      if (owned.startupError !== undefined) throw owned.startupError;
      if (owned.exited)
        throw new OpenCodeV2Error(
          "execution",
          "owned server exited during startup",
        );
      const match = /server listening on (https?:\/\/[^\s]+)/.exec(
        owned.output,
      );
      if (match?.[1] !== undefined) {
        const endpoint = new URL(match[1]);
        const requestedHost = configuration.host.includes(":")
          ? `[${configuration.host}]`
          : configuration.host;
        if (
          endpoint.username !== "" ||
          endpoint.password !== "" ||
          endpoint.pathname !== "/" ||
          endpoint.search !== "" ||
          endpoint.hash !== "" ||
          endpoint.hostname !== requestedHost ||
          endpoint.protocol !== "http:" ||
          !endpoint.port ||
          (configuration.port !== 0 &&
            Number(endpoint.port) !== configuration.port)
        )
          throw new OpenCodeV2Error(
            "protocol",
            "owned server reported an unexpected endpoint",
          );
        try {
          await verifyServer(
            createClient(endpoint.origin, authorization),
            startupSignal,
          );
          return { url: endpoint.origin, authorization, close };
        } catch (cause) {
          if (cause instanceof OpenCodeV2Error) throw cause;
        }
      }
      await setTimeout(50, undefined, { signal: startupSignal });
    }
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new OpenCodeV2Error(
        "termination",
        "startup failed and owned server cleanup failed",
        new AggregateError([cause, cleanup]),
      );
    }
    throw new OpenCodeV2Error(
      "execution",
      "owned server failed startup",
      cause,
    );
  }
}
