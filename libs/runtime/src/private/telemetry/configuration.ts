import { z } from "zod";

export const telemetryConfigurationEnvironment = "SEQLANE_TELEMETRY";
const MAX_CONFIGURATION_BYTES = 64 * 1024;

const endpointSchema = z
  .string()
  .max(8_192)
  .transform((value, context) => {
    try {
      const endpoint = new URL(value);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username !== "" ||
        endpoint.password !== "" ||
        endpoint.hash !== ""
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Use an HTTP(S) endpoint without URL credentials or a fragment",
        });
        return z.NEVER;
      }
      return endpoint.href;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Use a valid HTTP(S) endpoint",
      });
      return z.NEVER;
    }
  });

const headersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(256)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    z
      .string()
      .max(8_192)
      .regex(/^[\t\x20-\x7e\x80-\xff]*$/),
  )
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 64) {
      context.addIssue({
        code: "custom",
        message: "Use at most 64 telemetry headers",
      });
    }
  })
  .readonly();

/** Private operator configuration. Export and payload policy require explicit choices. */
export const telemetryConfigurationSchema = z
  .strictObject({
    endpoint: endpointSchema,
    payloadPolicy: z.enum(["metadata", "full"]),
    headers: headersSchema.default({}),
    maxPendingBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    shutdownTimeoutMs: z.number().int().min(1).max(30_000).default(5_000),
  })
  .readonly();

export type TelemetryConfiguration = z.output<
  typeof telemetryConfigurationSchema
>;

export class TelemetryConfigurationError extends Error {
  readonly code = "telemetry-configuration";

  constructor() {
    // Configuration may contain credentials. Never include its text or parser diagnostics.
    super("Invalid telemetry configuration");
    this.name = "TelemetryConfigurationError";
  }
}

function parseConfiguration(value: unknown): TelemetryConfiguration {
  const parsed = telemetryConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new TelemetryConfigurationError();
  return parsed.data;
}

export function decodeTelemetryConfiguration(
  encoded: string,
): TelemetryConfiguration {
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new TelemetryConfigurationError();
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new TelemetryConfigurationError();
  }
  return parseConfiguration(value);
}

export function encodeTelemetryConfiguration(
  configuration: TelemetryConfiguration,
): string {
  const encoded = JSON.stringify(parseConfiguration(configuration));
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new TelemetryConfigurationError();
  }
  return encoded;
}

/** Removes credentials before workflow imports, including when validation fails. */
export function captureTelemetryConfigurationEnvironment(
  environment: NodeJS.ProcessEnv,
): TelemetryConfiguration | undefined {
  const encoded = environment[telemetryConfigurationEnvironment];
  delete environment[telemetryConfigurationEnvironment];
  return encoded === undefined
    ? undefined
    : decodeTelemetryConfiguration(encoded);
}
