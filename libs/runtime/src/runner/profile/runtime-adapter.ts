import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentAdapterRequest,
} from "@seqlane/agent-adapter";
import {
  acpLaunchConfigurationSchema,
  createAcpAdapter,
} from "@seqlane/acp-adapter";
import {
  createOpenCodeAdapter,
  createOpenCodeModelCapabilities,
  resolveOpenCodeBrowserUiUrl,
} from "@seqlane/opencode-adapter";
import {
  CODEX_AGENT_CAPABILITIES,
  createCodexRun,
  type CodexRun,
} from "@seqlane/codex-adapter";
import type { RequestContext } from "@mastra/core/request-context";
import type { ModelSelection } from "@seqlane/core";
import type { ExecutorModelCapabilities } from "../../runtime/execution/executor.js";
import { z } from "zod";
import { isAbsolute } from "node:path";

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

const codexRuntimeConfigurationSchema = z.strictObject({
  adapter: z.literal("codex"),
  workspace: z.string().min(1).optional(),
  executable: z
    .string()
    .min(1)
    .pipe(
      z.custom<string>(
        (value) => typeof value === "string" && isAbsolute(value),
        { message: "must be an absolute executable path" },
      ),
    ),
  networkAccess: z.boolean().default(false),
});

/** The sole private runtime configuration contract for agent adapter selection. */
export const runtimeAdapterConfigurationSchema = z.discriminatedUnion(
  "adapter",
  [
    openCodeRuntimeConfigurationSchema,
    acpRuntimeConfigurationSchema,
    codexRuntimeConfigurationSchema,
  ],
);

export type RuntimeAdapterConfiguration = z.output<
  typeof runtimeAdapterConfigurationSchema
> & { readonly workspace?: string };
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

export class RuntimeAdapterUnavailableError extends Error {
  readonly adapter: RuntimeAdapterIdentity;

  constructor(adapter: RuntimeAdapterIdentity, cause?: unknown) {
    super(`adapter "${adapter}" unavailable`, { cause });
    this.name = "RuntimeAdapterUnavailableError";
    this.adapter = adapter;
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
  readonly codexRun?: CodexRun;
  readonly modelSelection?: ModelSelection;
  readonly browserUiUrl?: string;
  /** Existing Mastra invocation context, preserved for adapter integrations. */
  readonly requestContext?: RequestContext;
}

export interface RuntimeAdapterPreparation {
  readonly browserUiUrl?: string;
  readonly codexRun?: CodexRun;
  readonly close?: () => Promise<void>;
}

export interface RuntimeAdapterFactoryResult {
  readonly createAdapter: () => AgentAdapter;
  readonly modelCapabilities?: ExecutorModelCapabilities;
}

export interface RuntimeAdapterFactory {
  readonly identity: RuntimeAdapterIdentity;
  resolveCapabilities(
    configuration: RuntimeAdapterConfiguration,
    preparation?: RuntimeAdapterPreparation,
  ): AgentAdapterCapabilities;
  prepare(
    configuration: RuntimeAdapterConfiguration,
    signal: AbortSignal,
  ): Promise<RuntimeAdapterPreparation>;
  create(
    configuration: RuntimeAdapterConfiguration,
    context: RuntimeAdapterFactoryContext,
  ): RuntimeAdapterFactoryResult;
}

export interface ResolvedRuntimeAdapter {
  readonly identity: RuntimeAdapterIdentity;
  readonly configuration: RuntimeAdapterConfiguration;
  /** Opaque binding for this validated adapter configuration resolution. */
  readonly configurationBinding: string;
  readonly capabilities: AgentAdapterCapabilities;
  resolveCapabilities(
    preparation?: RuntimeAdapterPreparation,
  ): AgentAdapterCapabilities;
  prepare(signal: AbortSignal): Promise<RuntimeAdapterPreparation>;
  create(context: RuntimeAdapterFactoryContext): RuntimeAdapterFactoryResult;
}

export interface RuntimeAdapterRegistry {
  resolve(configuration: unknown): ResolvedRuntimeAdapter;
}

const adapterCapabilityKeys = [
  "execute",
  "modelSelection",
  "structuredOutput",
  "sessionReuse",
  "checkpoint",
  "fork",
  "activity",
  "sessionUi",
] as const;

/** Validates declared capabilities against an instantiated adapter. */
export function assertRuntimeAdapterCapabilities(
  adapter: AgentAdapter,
  expected: AgentAdapterCapabilities,
): void {
  for (const key of adapterCapabilityKeys) {
    if (adapter.capabilities[key] !== expected[key]) {
      throw new RuntimeAdapterSelectionError(
        `adapter capability "${key}" changed after preparation`,
      );
    }
  }

  const optionalOperations = [
    ["checkpoint", adapter.captureCheckpoint],
    ["fork", adapter.fork],
    ["sessionUi", adapter.sessionUi],
  ] as const;
  for (const [capability, operation] of optionalOperations) {
    if (expected[capability] !== (operation !== undefined)) {
      throw new RuntimeAdapterSelectionError(
        `adapter capability "${capability}" does not match its optional operation`,
      );
    }
  }
}

function createDefaultFactories(): readonly RuntimeAdapterFactory[] {
  return [
    {
      identity: "codex",
      resolveCapabilities(configuration) {
        if (configuration.adapter !== "codex") {
          throw new RuntimeAdapterSelectionError(
            'factory "codex" received a different adapter configuration',
          );
        }
        return CODEX_AGENT_CAPABILITIES;
      },
      async prepare(configuration, signal) {
        if (configuration.adapter !== "codex") {
          throw new RuntimeAdapterSelectionError(
            'factory "codex" received a different adapter configuration',
          );
        }
        if (configuration.workspace === undefined) {
          throw new RuntimeAdapterSelectionError(
            "Codex requires a runtime workspace",
          );
        }
        const codexRun = createCodexRun(
          {
            executable: configuration.executable,
            workspace: configuration.workspace,
            networkAccess: configuration.networkAccess,
          },
          { signal },
        );
        return { codexRun, close: () => codexRun.close() };
      },
      create(configuration, context) {
        if (configuration.adapter !== "codex") {
          throw new RuntimeAdapterSelectionError(
            'factory "codex" received a different adapter configuration',
          );
        }
        const codexRun = context.codexRun;
        if (codexRun === undefined) {
          throw new RuntimeAdapterSelectionError(
            "Codex run preparation is missing",
          );
        }
        return {
          createAdapter: () =>
            codexRun.createAdapter(context.signal, context.modelSelection),
          modelCapabilities: codexRun.modelCapabilities,
        };
      },
    },
    {
      identity: "acp",
      resolveCapabilities(configuration) {
        if (configuration.adapter !== "acp") {
          throw new RuntimeAdapterSelectionError(
            'factory "acp" received a different adapter configuration',
          );
        }
        return {
          execute: true,
          modelSelection: false,
          structuredOutput: true,
          sessionReuse: configuration.configuration.persistSession,
          checkpoint: false,
          fork: false,
          activity: true,
          sessionUi: false,
        };
      },
      async prepare(configuration) {
        if (configuration.adapter !== "acp") {
          throw new RuntimeAdapterSelectionError(
            'factory "acp" received a different adapter configuration',
          );
        }
        return {};
      },
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
      resolveCapabilities(configuration, preparation) {
        if (configuration.adapter !== "opencode") {
          throw new RuntimeAdapterSelectionError(
            'factory "opencode" received a different adapter configuration',
          );
        }
        return {
          execute: true,
          modelSelection: true,
          structuredOutput: true,
          sessionReuse: true,
          checkpoint: true,
          fork: true,
          activity: true,
          sessionUi: preparation?.browserUiUrl !== undefined,
        };
      },
      async prepare(configuration, signal) {
        if (configuration.adapter !== "opencode") {
          throw new RuntimeAdapterSelectionError(
            'factory "opencode" received a different adapter configuration',
          );
        }
        const browserUiUrl = await resolveOpenCodeBrowserUiUrl(
          configuration.url,
          signal,
        );
        return {
          ...(browserUiUrl === undefined ? {} : { browserUiUrl }),
        };
      },
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

function redactRuntimeModelCapabilities(
  capabilities: ExecutorModelCapabilities | undefined,
  configuration: RuntimeAdapterConfiguration,
): ExecutorModelCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  return {
    ...capabilities,
    listModels: async () => {
      try {
        return await capabilities.listModels();
      } catch (cause) {
        throw unavailableAdapterError(configuration, cause);
      }
    },
    resolveDefaultModel: async () => {
      try {
        return await capabilities.resolveDefaultModel();
      } catch (cause) {
        throw unavailableAdapterError(configuration, cause);
      }
    },
    ...(capabilities.validateModelSelection === undefined
      ? {}
      : {
          validateModelSelection: async (selection: ModelSelection) => {
            try {
              await capabilities.validateModelSelection?.(selection);
            } catch (cause) {
              throw redactRuntimeAdapterError(cause, configuration);
            }
          },
        }),
  };
}

function unavailableAdapterError(
  configuration: RuntimeAdapterConfiguration,
  cause: unknown,
): RuntimeAdapterUnavailableError {
  if (cause instanceof RuntimeAdapterUnavailableError) return cause;
  return new RuntimeAdapterUnavailableError(
    configuration.adapter,
    redactRuntimeAdapterError(cause, configuration),
  );
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
      let capabilities: AgentAdapterCapabilities;
      try {
        capabilities = factory.resolveCapabilities(configuration);
      } catch (cause) {
        if (cause instanceof RuntimeAdapterSelectionError) throw cause;
        throw new RuntimeAdapterSelectionError(
          `factory "${configuration.adapter}" could not resolve capabilities`,
          redactRuntimeAdapterError(cause, configuration),
        );
      }
      const resolveCapabilities = (
        preparation?: RuntimeAdapterPreparation,
      ): AgentAdapterCapabilities => {
        try {
          return factory.resolveCapabilities(configuration, preparation);
        } catch (cause) {
          if (cause instanceof RuntimeAdapterSelectionError) throw cause;
          throw new RuntimeAdapterSelectionError(
            `factory "${configuration.adapter}" could not resolve capabilities`,
            redactRuntimeAdapterError(cause, configuration),
          );
        }
      };
      return {
        identity: configuration.adapter,
        configuration,
        configurationBinding: randomUUID(),
        capabilities,
        resolveCapabilities,
        async prepare(signal) {
          try {
            return await factory.prepare(configuration, signal);
          } catch (cause) {
            if (cause instanceof RuntimeAdapterSelectionError) throw cause;
            throw unavailableAdapterError(configuration, cause);
          }
        },
        create(context) {
          try {
            const result = factory.create(configuration, context);
            return {
              ...result,
              modelCapabilities: redactRuntimeModelCapabilities(
                result.modelCapabilities,
                configuration,
              ),
            };
          } catch (cause) {
            if (cause instanceof RuntimeAdapterSelectionError) throw cause;
            throw new RuntimeAdapterSelectionError(
              `factory "${configuration.adapter}" could not create the selected adapter`,
              redactRuntimeAdapterError(cause, configuration),
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
): RuntimeAdapterConfiguration {
  const configuration = parseRuntimeAdapterConfiguration(value);
  if (
    workspace === undefined ||
    (configuration.adapter !== "opencode" && configuration.adapter !== "codex")
  ) {
    return configuration;
  }
  return { ...configuration, workspace };
}

export function redactRuntimeAdapterText(
  value: string,
  configuration: RuntimeAdapterConfiguration,
): string {
  const secrets = new Set<string>();
  const addSecret = (secret: string | undefined): void => {
    if (secret !== undefined && secret.length > 0) secrets.add(secret);
  };

  if (configuration.adapter === "acp") {
    for (const value of configuration.configuration.args ?? []) {
      addSecret(value);
    }
    for (const value of Object.values(configuration.configuration.env ?? {})) {
      addSecret(value);
    }
  } else if (configuration.adapter === "opencode") {
    try {
      const url = new URL(configuration.url);
      const addEncodedComponent = (component: string): void => {
        addSecret(component);
        try {
          addSecret(decodeURIComponent(component));
        } catch {
          // Keep the raw component when it is not valid percent encoding.
        }
      };
      for (const segment of url.pathname.split("/")) {
        addEncodedComponent(segment);
      }
      for (const parameter of url.search.slice(1).split("&")) {
        const separator = parameter.indexOf("=");
        addEncodedComponent(
          separator === -1 ? parameter : parameter.slice(separator + 1),
        );
      }
      for (const value of url.searchParams.values()) addSecret(value);
      const fragment = url.hash.slice(1);
      addEncodedComponent(fragment);
      for (const parameter of fragment.split("&")) {
        const separator = parameter.indexOf("=");
        addEncodedComponent(
          separator === -1 ? parameter : parameter.slice(separator + 1),
        );
      }
      for (const value of new URLSearchParams(fragment).values()) {
        addSecret(value);
      }
    } catch {
      // The configuration schema already rejects malformed URLs.
    }
  }

  return [...secrets]
    .sort((first, second) => second.length - first.length)
    .reduce(
      (message, secret) => message.split(secret).join("[REDACTED]"),
      value,
    );
}

function redactRuntimeAdapterValue(
  value: unknown,
  configuration: RuntimeAdapterConfiguration,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") {
    return redactRuntimeAdapterText(value, configuration);
  }
  if (typeof value !== "object" || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  const copy = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    Object.defineProperty(copy, key, {
      ...descriptor,
      value: redactRuntimeAdapterValue(descriptor.value, configuration, seen),
    });
  }
  return copy;
}

export function redactRuntimeAdapterError(
  value: unknown,
  configuration: RuntimeAdapterConfiguration,
): unknown {
  return redactRuntimeAdapterValue(value, configuration, new WeakMap());
}

function redactAdapterRequest(
  request: AgentAdapterRequest,
  configuration: RuntimeAdapterConfiguration,
): AgentAdapterRequest {
  const seen = new WeakMap<object, unknown>();
  return {
    ...request,
    onDiagnostic: (diagnostic) =>
      request.onDiagnostic?.({
        ...diagnostic,
        message: redactRuntimeAdapterText(diagnostic.message, configuration),
      }),
    onActivity: (activity) =>
      request.onActivity?.(
        redactRuntimeAdapterValue(
          activity,
          configuration,
          seen,
        ) as typeof activity,
      ),
  };
}

export function redactRuntimeAdapter(
  adapter: AgentAdapter,
  configuration: RuntimeAdapterConfiguration,
): AgentAdapter {
  const execute = async (request: AgentAdapterRequest): Promise<unknown> => {
    try {
      return await adapter.execute(
        redactAdapterRequest(request, configuration),
      );
    } catch (cause) {
      throw redactRuntimeAdapterError(cause, configuration);
    }
  };

  return {
    capabilities: adapter.capabilities,
    execute,
    ...(adapter.close === undefined
      ? {}
      : {
          close: async () => {
            try {
              await adapter.close?.();
            } catch (cause) {
              throw redactRuntimeAdapterError(cause, configuration);
            }
          },
        }),
    ...(adapter.captureCheckpoint === undefined
      ? {}
      : {
          captureCheckpoint: async () => {
            try {
              return await adapter.captureCheckpoint?.();
            } catch (cause) {
              throw redactRuntimeAdapterError(cause, configuration);
            }
          },
        }),
    ...(adapter.fork === undefined
      ? {}
      : {
          fork: async (request) => {
            try {
              const forked = await adapter.fork?.(request);
              if (forked === undefined) {
                throw new Error("Adapter fork unexpectedly returned undefined");
              }
              return redactRuntimeAdapter(forked, configuration);
            } catch (cause) {
              throw redactRuntimeAdapterError(cause, configuration);
            }
          },
        }),
    ...(adapter.sessionUi === undefined
      ? {}
      : {
          sessionUi: async () => {
            try {
              return await adapter.sessionUi?.();
            } catch (cause) {
              throw redactRuntimeAdapterError(cause, configuration);
            }
          },
        }),
  };
}
