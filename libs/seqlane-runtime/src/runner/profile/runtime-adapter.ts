import type { AgentAdapter } from "@seqlane/agent-adapter";
import { acpLaunchConfigurationSchema, createAcpAdapter } from "@seqlane/acp";
import {
  createOpenCodeAdapter,
  createOpenCodeModelCapabilities,
} from "@seqlane/opencode";
import type { ModelSelection } from "@seqlane/core";
import type { ExecutorModelCapabilities } from "../../runtime/execution/executor.js";
import { z } from "zod";

const httpUrlSchema = z.url().pipe(
  z.custom<string>(
    (value) => {
      try {
        if (typeof value !== "string") return false;
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.username.length === 0 &&
          url.password.length === 0
        );
      } catch {
        return false;
      }
    },
    { message: "must be an HTTP(S) URL without embedded credentials" },
  ),
);

const openCodeRuntimeConfigurationSchema = z.strictObject({
  adapter: z.literal("opencode"),
  url: httpUrlSchema,
  workspace: z.string().min(1).optional(),
});

const acpRuntimeConfigurationSchema = z.strictObject({
  adapter: z.literal("acp"),
  configuration: acpLaunchConfigurationSchema.strict(),
});

/** The sole private runtime configuration contract for agent adapter selection. */
export const runtimeAdapterConfigurationSchema = z.discriminatedUnion(
  "adapter",
  [openCodeRuntimeConfigurationSchema, acpRuntimeConfigurationSchema],
);

export type RuntimeAdapterConfiguration = z.output<
  typeof runtimeAdapterConfigurationSchema
>;
export type RuntimeAdapterIdentity = RuntimeAdapterConfiguration["adapter"];

export const runtimeAdapterConfigurationEnvironment =
  "SEQLANE_RUNTIME_ADAPTER_CONFIG" as const;

const encodedConfigurationSchema = z.string().transform((value, context) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch (cause) {
    context.addIssue({
      code: "custom",
      message: "runtime adapter configuration is not valid JSON",
      params: { cause },
    });
    return z.NEVER;
  }
});

export class RuntimeAdapterConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Runtime adapter configuration: ${message}`, { cause });
    this.name = "RuntimeAdapterConfigurationError";
  }
}

export class RuntimeAdapterSelectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Runtime adapter selection: ${message}`, { cause });
    this.name = "RuntimeAdapterSelectionError";
  }
}

function configurationError(cause?: unknown): never {
  const issueCount =
    cause instanceof z.ZodError ? cause.issues.length : undefined;
  throw new RuntimeAdapterConfigurationError(
    issueCount === undefined
      ? "configuration is invalid"
      : `configuration is invalid (${issueCount} issue${issueCount === 1 ? "" : "s"})`,
    cause,
  );
}

/** Parses untrusted private configuration without including values in errors. */
export function parseRuntimeAdapterConfiguration(
  value: unknown,
): RuntimeAdapterConfiguration {
  const result = runtimeAdapterConfigurationSchema.safeParse(value);
  if (!result.success) configurationError(result.error);
  return result.data;
}

/** Loads the private JSON configuration from the runner's process environment. */
export function loadRuntimeAdapterConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeAdapterConfiguration {
  const encoded = environment[runtimeAdapterConfigurationEnvironment];
  if (encoded === undefined || encoded.length === 0) {
    throw new RuntimeAdapterConfigurationError("configuration is missing");
  }
  const decoded = encodedConfigurationSchema.safeParse(encoded);
  if (!decoded.success) configurationError(decoded.error);
  return parseRuntimeAdapterConfiguration(decoded.data);
}

export interface RuntimeAdapterFactoryContext {
  readonly signal: AbortSignal;
  readonly modelSelection?: ModelSelection;
  readonly browserUiUrl?: string;
}

export interface RuntimeAdapterFactoryResult {
  readonly createAdapter: () => AgentAdapter;
  readonly modelCapabilities?: ExecutorModelCapabilities;
}

export interface RuntimeAdapterFactory {
  readonly identity: RuntimeAdapterIdentity;
  create(
    configuration: RuntimeAdapterConfiguration,
    context: RuntimeAdapterFactoryContext,
  ): RuntimeAdapterFactoryResult;
}

export interface ResolvedRuntimeAdapter {
  readonly identity: RuntimeAdapterIdentity;
  readonly configuration: RuntimeAdapterConfiguration;
  create(context: RuntimeAdapterFactoryContext): RuntimeAdapterFactoryResult;
}

export interface RuntimeAdapterRegistry {
  resolve(configuration: unknown): ResolvedRuntimeAdapter;
}

function createDefaultFactories(): readonly RuntimeAdapterFactory[] {
  return [
    {
      identity: "acp",
      create(configuration) {
        if (configuration.adapter !== "acp") {
          throw new RuntimeAdapterSelectionError(
            'factory "acp" received a different adapter configuration',
          );
        }
        return {
          createAdapter: () => createAcpAdapter(configuration.configuration),
        };
      },
    },
    {
      identity: "opencode",
      create(configuration, context) {
        if (configuration.adapter !== "opencode") {
          throw new RuntimeAdapterSelectionError(
            'factory "opencode" received a different adapter configuration',
          );
        }
        const connection = {
          url: configuration.url,
          ...(configuration.workspace === undefined
            ? {}
            : { workspace: configuration.workspace }),
          ...(context.browserUiUrl === undefined
            ? {}
            : { browserUiUrl: context.browserUiUrl }),
        };
        return {
          createAdapter: () =>
            createOpenCodeAdapter(connection, {
              signal: context.signal,
              ...(context.modelSelection === undefined
                ? {}
                : { modelSelection: context.modelSelection }),
            }),
          modelCapabilities: createOpenCodeModelCapabilities(
            configuration.url,
            configuration.workspace,
          ),
        };
      },
    },
  ];
}

export function createRuntimeAdapterRegistry(
  factories: readonly RuntimeAdapterFactory[] = createDefaultFactories(),
): RuntimeAdapterRegistry {
  const byIdentity = new Map<RuntimeAdapterIdentity, RuntimeAdapterFactory>();
  for (const factory of factories) {
    if (byIdentity.has(factory.identity)) {
      throw new RuntimeAdapterSelectionError(
        `adapter factory "${factory.identity}" is registered more than once`,
      );
    }
    byIdentity.set(factory.identity, factory);
  }

  return {
    resolve(value) {
      const configuration = parseRuntimeAdapterConfiguration(value);
      const factory = byIdentity.get(configuration.adapter);
      if (factory === undefined) {
        throw new RuntimeAdapterSelectionError(
          `no factory is registered for adapter "${configuration.adapter}"`,
        );
      }
      return {
        identity: configuration.adapter,
        configuration,
        create(context) {
          try {
            return factory.create(configuration, context);
          } catch (cause) {
            if (cause instanceof RuntimeAdapterSelectionError) throw cause;
            throw new RuntimeAdapterSelectionError(
              `factory "${configuration.adapter}" could not create the selected adapter`,
              cause,
            );
          }
        },
      };
    },
  };
}

export function configurationWithWorkspace(
  value: unknown,
  workspace: string | undefined,
): unknown {
  if (workspace === undefined || typeof value !== "object" || value === null) {
    return value;
  }
  if (!("adapter" in value) || value.adapter !== "opencode") return value;
  return { ...value, workspace };
}

export function redactRuntimeAdapterText(
  value: string,
  configuration: RuntimeAdapterConfiguration,
): string {
  const secrets =
    configuration.adapter === "acp"
      ? Object.values(configuration.configuration.env ?? {})
      : (() => {
          try {
            const url = new URL(configuration.url);
            return [
              ...url.searchParams.values(),
              ...(url.hash.length === 0 ? [] : [url.hash.slice(1)]),
            ];
          } catch {
            return [];
          }
        })();
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
}
