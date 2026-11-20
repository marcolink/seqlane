import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { z } from "zod";
import { createServerEnvironment } from "./v2/environment.js";
import { OPENCODE_V2_VERSION } from "./v2/client.js";
import { serverInfoSchema } from "./v2/schemas.js";

export class OpenCodeVersionDetectionError extends Error {
  readonly code = "OPENCODE_VERSION_DETECTION_FAILED";

  constructor(message: string, cause?: unknown) {
    super(`OpenCode version detection: ${message}`, { cause });
    this.name = "OpenCodeVersionDetectionError";
  }
}

const versionSchema = z
  .string()
  .max(512)
  .regex(/^[1-9]\d*\.\d+\.\d+$/);
const healthSchema = z.object({
  healthy: z.literal(true),
  version: versionSchema,
});

function implementation(version: string): "v1" | "v2" {
  const parsed = versionSchema.safeParse(version);
  if (!parsed.success)
    throw new OpenCodeVersionDetectionError(
      "native version is malformed or a prerelease",
      parsed.error,
    );
  // Preserve V1's existing version-aware output compatibility policy.
  if (parsed.data.startsWith("1.")) return "v1";
  if (parsed.data === OPENCODE_V2_VERSION) return "v2";
  throw new OpenCodeVersionDetectionError(
    `version ${parsed.data} is unsupported; use OpenCode 1 or ${OPENCODE_V2_VERSION}`,
  );
}

/** Probe the selected executable before any server or session is created. */
export function detectOpenCodeExecutableVersion(options: {
  executable?: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}): Promise<"v1" | "v2"> {
  const environment = createServerEnvironment({ ...options.environment });
  return Effect.runPromise(
    Effect.tryPromise({
      try: async (signal) => {
        const result = await promisify(execFile)(
          options.executable ?? "opencode",
          ["--version"],
          {
            env: environment,
            signal,
            maxBuffer: 16_384,
          },
        );
        return implementation(result.stdout.trim().replace(/^opencode v/, ""));
      },
      catch: (cause) =>
        cause instanceof OpenCodeVersionDetectionError
          ? cause
          : new OpenCodeVersionDetectionError(
              "cannot read the selected executable version",
              cause,
            ),
    }).pipe(Effect.timeout("10 seconds")),
    { signal: options.signal },
  );
}

async function readVersionResponse(
  url: URL,
  authorization: string | undefined,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    signal,
    redirect: "error",
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OpenCodeVersionDetectionError(
      `server information returned HTTP ${response.status}`,
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new OpenCodeVersionDetectionError("server information has no body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16_384)
        throw new OpenCodeVersionDetectionError(
          "server information exceeded 16 KiB",
        );
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(
      Buffer.concat(chunks, length).toString("utf8"),
    );
    return value;
  } finally {
    await reader.cancel();
  }
}

/** Read-only protocol discovery. Authentication and transport errors are terminal. */
export function detectOpenCodeServerVersion(options: {
  url: string;
  authorization?: string;
  signal: AbortSignal;
}): Promise<"v1" | "v2"> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async (signal) => {
        const info = await readVersionResponse(
          new URL("/api/info", options.url),
          options.authorization,
          signal,
        );
        if (info !== undefined) {
          const version = implementation(serverInfoSchema.parse(info).version);
          if (version !== "v2")
            throw new OpenCodeVersionDetectionError(
              "V2 information reported a different protocol version",
            );
          return version;
        }
        const health = healthSchema.parse(
          await readVersionResponse(
            new URL("/global/health", options.url),
            options.authorization,
            signal,
          ),
        );
        const version = implementation(health.version);
        if (version !== "v1")
          throw new OpenCodeVersionDetectionError(
            "V1 health reported a different protocol version",
          );
        return version;
      },
      catch: (cause) =>
        cause instanceof OpenCodeVersionDetectionError
          ? cause
          : new OpenCodeVersionDetectionError(
              "cannot read validated server information",
              cause,
            ),
    }).pipe(Effect.timeout("10 seconds")),
    { signal: options.signal },
  );
}
