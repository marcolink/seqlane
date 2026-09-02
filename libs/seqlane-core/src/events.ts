import type {
  InvocationId,
  JsonValue,
  PlanNodeId,
  RunId,
  TaskId,
  WorkspacePolicy,
  WorkId,
} from "./contracts.js";
import type { SeqlaneError } from "./errors.js";
import type { ModelSelection } from "./models/model-ref.js";

export type SeqlaneInvocationKind = "workflow" | "loop" | "task" | "validation";

export type SeqlaneInvocationSubject =
  | { readonly type: "task"; readonly taskId: TaskId }
  | { readonly type: "validator"; readonly validatorId: string }
  | { readonly type: "validation-gate"; readonly planNodeId: PlanNodeId };

export type SeqlaneProgressState = "active" | "waiting";

export type SeqlaneActivityState =
  "started" | "progress" | "succeeded" | "failed";

export type SeqlaneActivityKind = "tool" | "skill";

export type SeqlaneFailureDisposition =
  | "retry_scheduled"
  | "fail_run"
  | "continue_siblings"
  | "skip_dependents"
  | "cancelled_by_policy";

export type SeqlaneOutputPolicy = "transient" | "persistent";

export type SeqlaneOutputChannel = "task" | "run";

export interface SeqlaneInvocationMetrics {
  readonly durationMs?: number;
  readonly model?: string;
  readonly provider?: string;
  readonly modelSelection?: ModelSelection;
  readonly cost?: number;
  readonly tokens?: {
    readonly total?: number;
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export type SeqlaneOutputSummaryKind =
  "null" | "boolean" | "number" | "string" | "array" | "object";

export interface SeqlaneOutputSummary {
  readonly kind: SeqlaneOutputSummaryKind;
  readonly size?: number;
  readonly fields?: readonly string[];
}

export type SeqlaneDisplayValue =
  | { readonly state: "present"; readonly value: JsonValue }
  | { readonly state: "redacted"; readonly summary?: SeqlaneOutputSummary }
  | { readonly state: "truncated"; readonly summary: SeqlaneOutputSummary }
  | {
      readonly state: "omitted";
      readonly reason: "policy" | "unavailable";
    };

export interface InvocationCreatedEvent {
  readonly type: "invocation.created";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly planNodeId: PlanNodeId;
  readonly subject: SeqlaneInvocationSubject;
  readonly taskId?: TaskId;
  readonly kind: SeqlaneInvocationKind;
  readonly label: string;
  readonly parentInvocationId?: InvocationId;
  readonly iteration?: number;
  readonly siblingOrder: number;
  readonly dependencyIds: readonly InvocationId[];
}

export interface InvocationProgressEvent {
  readonly type: "invocation.progress";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly state: SeqlaneProgressState;
  readonly phase: string;
  readonly message?: string;
  readonly label?: string;
  readonly waitingReason?: string;
  readonly workspace?: WorkspacePolicy;
  readonly blockingInvocationId?: InvocationId;
  readonly dependencyIds?: readonly InvocationId[];
  readonly iteration?: number;
}

export interface InvocationOutputEvent {
  readonly type: "invocation.output";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly policy: SeqlaneOutputPolicy;
  readonly channel: SeqlaneOutputChannel;
  readonly content: string;
  readonly metrics?: SeqlaneInvocationMetrics;
  readonly summary?: SeqlaneOutputSummary;
  readonly iteration?: number;
}

export interface InvocationActivityEvent {
  readonly type: "invocation.activity";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly activityId: string;
  readonly kind: SeqlaneActivityKind;
  readonly name: string;
  readonly state: SeqlaneActivityState;
  readonly input?: SeqlaneDisplayValue;
  readonly output?: SeqlaneDisplayValue;
  /** Bounded executor metadata; event envelope metadata remains top-level. */
  readonly activityMetadata?: SeqlaneDisplayValue;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly message?: string;
  readonly iteration?: number;
}

export interface InvocationInputEvent {
  readonly type: "invocation.input";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly input: SeqlaneDisplayValue;
  readonly iteration?: number;
}

export interface InvocationResultEvent {
  readonly type: "invocation.result";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly result: SeqlaneDisplayValue;
  readonly iteration?: number;
}

export interface InvocationRetryingEvent {
  readonly type: "invocation.retrying";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly attempt: number;
  readonly maximumAttempts?: number;
  readonly delayMs?: number;
  readonly nextAttemptAt?: string;
  readonly lastError: SeqlaneError;
  readonly iteration?: number;
}

export interface RunStartedEvent {
  readonly type: "run.started";
  readonly workId: WorkId;
  readonly runId: RunId;
}

export interface InvocationStartedEvent {
  readonly type: "invocation.started";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly subject: SeqlaneInvocationSubject;
  readonly taskId?: TaskId;
  readonly iteration?: number;
}

export interface InvocationSucceededEvent {
  readonly type: "invocation.succeeded";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly iteration?: number;
}

export interface InvocationFailedEvent {
  readonly type: "invocation.failed";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly error: SeqlaneError;
  readonly disposition: SeqlaneFailureDisposition;
  readonly iteration?: number;
}

export interface InvocationSkippedEvent {
  readonly type: "invocation.skipped";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly reason: string;
  readonly dependencyIds?: readonly InvocationId[];
  readonly iteration?: number;
}

export interface InvocationCancelledEvent {
  readonly type: "invocation.cancelled";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly reason?: string;
  readonly iteration?: number;
}

export interface RunHeartbeatEvent {
  readonly type: "run.heartbeat";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly activeInvocationIds: readonly InvocationId[];
  readonly elapsedMs: number;
}

export interface RunSucceededEvent {
  readonly type: "run.succeeded";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly output: unknown;
}

export interface RunFailedEvent {
  readonly type: "run.failed";
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly error: SeqlaneError;
}

export interface RunCancelledEvent {
  readonly type: "run.cancelled";
  readonly workId: WorkId;
  readonly runId: RunId;
}

export type SeqlaneEvent =
  | RunStartedEvent
  | InvocationCreatedEvent
  | InvocationProgressEvent
  | InvocationOutputEvent
  | InvocationActivityEvent
  | InvocationInputEvent
  | InvocationResultEvent
  | InvocationRetryingEvent
  | InvocationStartedEvent
  | InvocationSucceededEvent
  | InvocationFailedEvent
  | InvocationSkippedEvent
  | InvocationCancelledEvent
  | RunHeartbeatEvent
  | RunSucceededEvent
  | RunFailedEvent
  | RunCancelledEvent;

export interface SeqlaneEventSink {
  emit(event: SeqlaneEvent): void;
}

export type SeqlaneRunOutcome<T = unknown> =
  | { readonly status: "succeeded"; readonly result: T }
  | { readonly status: "failed"; readonly error: SeqlaneError }
  | { readonly status: "cancelled" };
