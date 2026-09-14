import type {
  TaskDefinition,
  AgentTaskRequest,
  ModelSelection,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import type { ObservabilityContext } from "@mastra/core/observability";

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

export interface AgentAdapterRequest {
  readonly invocationId: string;
  readonly observability: Partial<ObservabilityContext>;
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
