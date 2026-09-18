import type {
  TaskDefinition,
  AgentTaskRequest,
  ModelSelection,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import { z } from "zod";

export {
  createBoundedNormalizedNameAllocator,
  type BoundedNormalizedNameAllocator,
} from "./observability.js";

const agentActivityStateSchema = z.enum([
  "started",
  "progress",
  "succeeded",
  "failed",
]);

export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;

const agentActivitySchema = z.strictObject({
  activityId: z.string(),
  kind: z.enum(["tool", "skill"]),
  name: z.string(),
  state: agentActivityStateSchema,
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.unknown().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  message: z.string().optional(),
});

export type AgentActivity = z.infer<typeof agentActivitySchema>;

export interface AgentDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface AgentUncertainActivity {
  readonly reason: "timeout" | "disconnect";
  readonly termination?: Promise<unknown>;
}

export type AgentBackgroundProcess =
  | {
      readonly mutatesWorkspace: false;
      readonly termination?: Promise<unknown>;
    }
  | {
      readonly mutatesWorkspace: true;
      readonly termination: Promise<unknown>;
    };

export interface AgentAdapterCapabilities {
  readonly execute: true;
  readonly modelSelection: boolean;
  readonly structuredOutput: boolean;
  readonly sessionReuse: boolean;
  readonly checkpoint: boolean;
  readonly fork: boolean;
  readonly activity: boolean;
  readonly sessionUi: boolean;
}

export interface AgentAdapterRequest {
  readonly invocationId: string;
  /**
   * Opaque runtime-owned observability state. Concrete adapter integrations
   * must validate it before use.
   */
  readonly observability: unknown;
  readonly task: TaskDefinition;
  readonly input: unknown;
  readonly agent?: AgentTaskRequest;
  readonly modelSelection?: ModelSelection;
  readonly signal: AbortSignal;
  readonly onMetrics?: (metrics: SeqlaneInvocationMetrics) => void;
  readonly onDiagnostic?: (diagnostic: AgentDiagnostic) => void;
  readonly onActivity?: (activity: AgentActivity) => void;
  /** Reports an external request whose termination cannot be confirmed. */
  readonly onUncertainActivity?: (activity: AgentUncertainActivity) => void;
  /** Reports a background process started by the adapter. */
  readonly onBackgroundProcess?: (process: AgentBackgroundProcess) => void;
}

export interface AgentAdapter {
  readonly capabilities: AgentAdapterCapabilities;
  execute(request: AgentAdapterRequest): Promise<unknown>;
  /** Closes adapter-owned resources at the end of the owning run. */
  readonly close?: () => Promise<void>;
  readonly captureCheckpoint?: () => Promise<unknown>;
  readonly fork?: (request: {
    readonly checkpoint: unknown;
    readonly modelSelection?: ModelSelection;
  }) => Promise<AgentAdapter>;
  readonly sessionUi?: () => Promise<string | undefined>;
}

export interface AgentRuntimeModelCapabilities {
  readonly executor: string;
  readonly listModels: () => Promise<
    readonly { readonly provider: string; readonly model: string }[]
  >;
  readonly resolveDefaultModel: () => Promise<ModelSelection>;
  readonly validateModelSelection?: (
    selection: ModelSelection,
  ) => Promise<void>;
}

export interface AgentRuntimeContext {
  readonly signal: AbortSignal;
  readonly modelSelection?: ModelSelection;
  /**
   * Opaque execution context supplied by the runtime integration. Concrete
   * adapters must validate it before use; this contract exposes no engine type.
   */
  readonly requestContext: unknown;
}

/** A run-scoped, composition-owned runtime for one selected agent adapter. */
export interface AgentRuntime {
  readonly identity: string;
  readonly capabilities: AgentAdapterCapabilities;
  readonly modelCapabilities?: AgentRuntimeModelCapabilities;
  createAdapter(context: AgentRuntimeContext): AgentAdapter;
  redactAdapter(adapter: AgentAdapter): AgentAdapter;
  readonly close?: () => Promise<void>;
}

/** Supplies one composition-owned runtime for a single workflow run. */
export type AgentRuntimeFactory = (
  signal: AbortSignal,
  workspace: string | undefined,
) => Promise<AgentRuntime>;

/** Validates declared capabilities against an instantiated adapter. */
export function assertAgentRuntimeCapabilities(
  adapter: AgentAdapter,
  expected: AgentAdapterCapabilities,
): void {
  const capabilityKeys = [
    "execute",
    "modelSelection",
    "structuredOutput",
    "sessionReuse",
    "checkpoint",
    "fork",
    "activity",
    "sessionUi",
  ] as const;
  for (const key of capabilityKeys) {
    if (adapter.capabilities[key] !== expected[key]) {
      throw new Error(`Agent runtime capability "${key}" changed after setup`);
    }
  }

  const optionalOperations = [
    ["checkpoint", adapter.captureCheckpoint],
    ["fork", adapter.fork],
    ["sessionUi", adapter.sessionUi],
  ] as const;
  for (const [capability, operation] of optionalOperations) {
    if (expected[capability] !== (operation !== undefined)) {
      throw new Error(
        `Agent runtime capability "${capability}" does not match its optional operation`,
      );
    }
  }
}

/** Redacts strings in an opaque value without invoking getters. */
export function redactOpaqueValue(
  value: unknown,
  redactText: (value: string) => string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") return redactText(value);
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
      value: redactOpaqueValue(descriptor.value, redactText, seen),
    });
  }
  return copy;
}

/** Redacts failures from runtime-owned model discovery and validation. */
export function redactAgentRuntimeModelCapabilities(
  capabilities: AgentRuntimeModelCapabilities,
  redactText: (value: string) => string,
): AgentRuntimeModelCapabilities {
  return {
    ...capabilities,
    listModels: async () => {
      try {
        return await capabilities.listModels();
      } catch (cause) {
        throw redactOpaqueValue(cause, redactText);
      }
    },
    resolveDefaultModel: async () => {
      try {
        return await capabilities.resolveDefaultModel();
      } catch (cause) {
        throw redactOpaqueValue(cause, redactText);
      }
    },
    ...(capabilities.validateModelSelection === undefined
      ? {}
      : {
          validateModelSelection: async (selection) => {
            try {
              await capabilities.validateModelSelection?.(selection);
            } catch (cause) {
              throw redactOpaqueValue(cause, redactText);
            }
          },
        }),
  };
}

/** Wraps one adapter with concrete-runtime-owned diagnostic redaction. */
export function redactAgentAdapter(
  adapter: AgentAdapter,
  redactText: (value: string) => string,
): AgentAdapter {
  const execute = async (request: AgentAdapterRequest): Promise<unknown> => {
    try {
      return await adapter.execute({
        ...request,
        onDiagnostic: (diagnostic) =>
          request.onDiagnostic?.({
            ...diagnostic,
            message: redactText(diagnostic.message),
          }),
        onActivity: (activity) => {
          // Activity payloads originate in the concrete runtime and can contain
          // connection details in arbitrary nested fields.
          request.onActivity?.(
            agentActivitySchema.parse(redactOpaqueValue(activity, redactText)),
          );
        },
      });
    } catch (cause) {
      throw redactOpaqueValue(cause, redactText);
    }
  };
  return {
    ...adapter,
    execute,
    ...(adapter.close === undefined
      ? {}
      : {
          close: async () => {
            try {
              await adapter.close?.();
            } catch (cause) {
              throw redactOpaqueValue(cause, redactText);
            }
          },
        }),
    ...(adapter.captureCheckpoint === undefined
      ? {}
      : {
          captureCheckpoint: async () => {
            try {
              const checkpoint = await adapter.captureCheckpoint?.();
              if (checkpoint === undefined) {
                throw new Error("Adapter checkpoint unexpectedly missing");
              }
              return checkpoint;
            } catch (cause) {
              throw redactOpaqueValue(cause, redactText);
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
                throw new Error("Adapter fork unexpectedly missing");
              }
              return redactAgentAdapter(forked, redactText);
            } catch (cause) {
              throw redactOpaqueValue(cause, redactText);
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
              throw redactOpaqueValue(cause, redactText);
            }
          },
        }),
  };
}
