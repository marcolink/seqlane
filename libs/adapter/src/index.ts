import type {
  TaskDefinition,
  AgentTaskRequest,
  ModelSelection,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";

export {
  createBoundedNormalizedNameAllocator,
  type BoundedNormalizedNameAllocator,
} from "./observability.js";

export type AgentActivityState =
  "started" | "progress" | "succeeded" | "failed";

export interface AgentActivity {
  readonly activityId: string;
  readonly kind: "tool" | "skill";
  readonly name: string;
  readonly state: AgentActivityState;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly message?: string;
}

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

export interface AgentAdapterRequest<TObservability extends object = object> {
  readonly invocationId: string;
  /**
   * Runtime-owned observability state. The generic adapter contract requires
   * an object but leaves its engine-specific shape to private integrations.
   */
  readonly observability: TObservability;
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

export interface AgentAdapter<TObservability extends object = object> {
  readonly capabilities: AgentAdapterCapabilities;
  execute(request: AgentAdapterRequest<TObservability>): Promise<unknown>;
  /** Closes adapter-owned resources at the end of the owning run. */
  readonly close?: () => Promise<void>;
  readonly captureCheckpoint?: () => Promise<unknown>;
  readonly fork?: (request: {
    readonly checkpoint: unknown;
    readonly modelSelection?: ModelSelection;
  }) => Promise<AgentAdapter<TObservability>>;
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
   * adapters may preserve it, but the generic contract exposes no engine type.
   */
  readonly requestContext?: object;
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

/** Wraps one adapter with concrete-runtime-owned diagnostic redaction. */
export function redactAgentAdapter<TObservability extends object>(
  adapter: AgentAdapter<TObservability>,
  redactText: (value: string) => string,
): AgentAdapter<TObservability> {
  const execute = async (
    request: AgentAdapterRequest<TObservability>,
  ): Promise<unknown> => {
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
            redactOpaqueValue(activity, redactText) as AgentActivity,
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
