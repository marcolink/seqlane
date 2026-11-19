import type {
  BuiltWorkflow,
  Plan,
  SeqlaneEventSink,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkflowDefinition,
} from "@seqlane/core";
import type {
  OperationalTraceInspection,
  SeqlanePlanSnapshot,
} from "@seqlane/protocol";
import type { AgentRuntimeFactory } from "@seqlane/agent-adapter";
import type { RuntimeSessionUiAvailable } from "../../runner/runtime-session-ui.js";
import type { PrivateClassifierConnection } from "../../classifier/types.js";
import type { TelemetryConfiguration } from "../../private/telemetry/configuration.js";

export interface OperationalWorkflowSource {
  readonly key: string;
  readonly plan: Plan;
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly workflowDefinitions?: ReadonlyMap<
    string,
    BuiltWorkflow<unknown, unknown>
  >;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly eventSink?: (context: {
    readonly workId: string;
    readonly runId: string;
  }) => SeqlaneEventSink & {
    emitPlan(plan: SeqlanePlanSnapshot, workId: string, runId: string): void;
  };
  readonly onSessionUiAvailable?: (
    notification: RuntimeSessionUiAvailable,
  ) => void | Promise<void>;
  readonly agentRuntime?: AgentRuntimeFactory;
}

export interface OperationalWorkflowRegistration {
  readonly key: string;
  readonly defaultRuntimeId: "local";
  readonly source: OperationalWorkflowSource;
  readonly workflow: BuiltWorkflow;
  readonly planSnapshot: SeqlanePlanSnapshot;
}

export interface OperationalEventSink extends SeqlaneEventSink {
  emitPlan(plan: SeqlanePlanSnapshot, workId: string, runId: string): void;
}

export type OperationalSessionUiNotifier = (
  notification: RuntimeSessionUiAvailable,
) => void | Promise<void>;

export interface OperationalHostOptions {
  readonly workflows: readonly OperationalWorkflowRegistration[];
  readonly storageUrl?: string;
  readonly host?: string;
  readonly port?: number;
  readonly classifierConnection?: PrivateClassifierConnection;
  readonly telemetryConfiguration?: TelemetryConfiguration;
}

export interface OperationalHost {
  readonly host: string;
  readonly port: number;
  readonly address: string;
  readonly ready: boolean;
  fetch(request: Request): Promise<Response>;
  inspectTrace(runId: string): Promise<OperationalTraceInspection>;
  listen(): Promise<string>;
  close(): Promise<void>;
}
