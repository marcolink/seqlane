import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import { createCodexAgentRuntimeFactory } from "@seqlane/codex-adapter";
import { createOpenCodeAgentRuntimeFactory } from "@seqlane/opencode-adapter";
import { startOpenCodeService } from "@seqlane/opencode-adapter";
import { isIP } from "node:net";
import { z } from "zod";

const adapterIdentitySchema = z.object({ adapter: z.string().min(1) });

export const agentRuntimeConfigurationEnvironment =
  "SEQLANE_RUNTIME_ADAPTER_CONFIG" as const;

/** Private parent-to-child configuration for `seqlane run --adapter`. */
export const directRunAdapterConfigurationEnvironment =
  "SEQLANE_CLI_DIRECT_ADAPTER_CONFIG" as const;

const loopbackHostSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    if (value === "localhost") return "127.0.0.1";
    if (isIP(value) === 4 && value.startsWith("127.")) return value;
    if (isIP(value) === 6) {
      const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
      if (normalized === "::1") return normalized;
    }
    context.addIssue({ code: "custom", message: "must be a loopback host" });
    return z.NEVER;
  });

const managedOpenCodeConfigurationSchema = z.strictObject({
  adapter: z.literal("opencode"),
  mode: z.literal("managed"),
  host: loopbackHostSchema.default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(0),
});

const externalOpenCodeConfigurationSchema = z.strictObject({
  adapter: z.literal("opencode"),
  mode: z.literal("external"),
  host: loopbackHostSchema,
  port: z.number().int().min(1).max(65_535),
});

const directRunAdapterConfigurationSchema = z.discriminatedUnion("adapter", [
  z.strictObject({ adapter: z.literal("codex") }),
  z.discriminatedUnion("mode", [
    managedOpenCodeConfigurationSchema,
    externalOpenCodeConfigurationSchema,
  ]),
]);

export type DirectRunAdapterConfiguration = z.output<
  typeof directRunAdapterConfigurationSchema
>;

export class AgentRuntimeConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Agent runtime configuration: ${message}`, { cause });
    this.name = "AgentRuntimeConfigurationError";
  }
}

/** Selects a concrete adapter factory without interpreting its configuration. */
export function createAgentRuntimeFactory(value: unknown): AgentRuntimeFactory {
  const identity = adapterIdentitySchema.safeParse(value);
  if (!identity.success) {
    throw new AgentRuntimeConfigurationError(
      "configuration is invalid",
      identity.error,
    );
  }
  try {
    switch (identity.data.adapter) {
      case "codex":
        return createCodexAgentRuntimeFactory(value);
      case "opencode":
        return createOpenCodeAgentRuntimeFactory(value);
      default:
        throw new AgentRuntimeConfigurationError("adapter is unavailable");
    }
  } catch (cause) {
    if (cause instanceof AgentRuntimeConfigurationError) throw cause;
    throw new AgentRuntimeConfigurationError("configuration is invalid", cause);
  }
}

/** Loads application-owned adapter selection without disclosing its values. */
export function loadAgentRuntimeFactory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeFactory {
  const encoded = environment[agentRuntimeConfigurationEnvironment];
  if (encoded === undefined || encoded.length === 0) {
    throw new AgentRuntimeConfigurationError("configuration is missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new AgentRuntimeConfigurationError(
      "configuration is not valid JSON",
      cause,
    );
  }
  return createAgentRuntimeFactory(value);
}

/** Validates CLI adapter flags before they cross the private child boundary. */
export function createDirectRunAdapterConfiguration(value: unknown): string {
  return JSON.stringify(directRunAdapterConfigurationSchema.parse(value));
}

function externalOpenCodeUrl(host: string, port: number): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${authority}:${port}`).origin;
}

/** Loads direct-run selection. This must never read the legacy hosted config. */
export function loadDirectRunAgentRuntimeFactory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentRuntimeFactory {
  const encoded = environment[directRunAdapterConfigurationEnvironment];
  if (encoded === undefined || encoded.length === 0) {
    throw new AgentRuntimeConfigurationError("configuration is missing");
  }
  let configuration: DirectRunAdapterConfiguration;
  try {
    configuration = directRunAdapterConfigurationSchema.parse(
      JSON.parse(encoded),
    );
  } catch (cause) {
    throw new AgentRuntimeConfigurationError("configuration is invalid", cause);
  }

  switch (configuration.adapter) {
    case "codex":
      return createCodexAgentRuntimeFactory({ adapter: "codex" });
    case "opencode":
      if (configuration.mode === "external") {
        return createOpenCodeAgentRuntimeFactory({
          adapter: "opencode",
          url: externalOpenCodeUrl(configuration.host, configuration.port),
        });
      }
      return async (signal, workspace) => {
        const service = await startOpenCodeService({
          workspace: workspace ?? process.cwd(),
          signal,
          host: configuration.host,
          port: configuration.port,
        });
        try {
          const runtime = await createOpenCodeAgentRuntimeFactory({
            adapter: "opencode",
            url: service.url,
            ...(workspace === undefined ? {} : { workspace }),
          })(signal, workspace);
          return {
            ...runtime,
            close: async () => {
              const results = await Promise.allSettled([
                runtime.close?.(),
                service.close(),
              ]);
              const failures = results
                .filter((result) => result.status === "rejected")
                .map((result) =>
                  result.status === "rejected" ? result.reason : undefined,
                );
              if (failures.length > 0) {
                throw new AggregateError(
                  failures,
                  "Direct OpenCode adapter cleanup failed",
                );
              }
            },
          };
        } catch (cause) {
          await service.close();
          throw cause;
        }
      };
  }
}
