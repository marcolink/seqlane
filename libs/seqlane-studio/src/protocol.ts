import { isJsonValue, isPlainRecord } from "@seqlane/core";
import type {
  InvocationId,
  PlanNodeId,
  SeqlaneDisplayValue,
  SeqlaneInvocationKind,
  SeqlaneInvocationMetrics,
  SeqlaneOutputSummary,
  ValidationIssue,
  WorkId,
  RunId,
  WorkflowIdentity,
} from "@seqlane/core";
import type {
  SerializedSeqlaneError,
  SeqlaneExecutionEvent,
  SeqlanePlanNodeSnapshot,
  SeqlanePlanSnapshot,
} from "@seqlane/events";
import { isValidationIssue } from "@seqlane/events";

export { seqlaneExecutionEventSchema } from "@seqlane/events";

export const studioProtocolVersion = 1 as const;

export interface StudioSessionDescriptor {
  readonly version: typeof studioProtocolVersion;
  readonly address: string;
  readonly capability: string;
}

export interface StudioApiError {
  readonly error: {
    readonly code: "UNAUTHORIZED" | "INVALID_REQUEST" | "NOT_FOUND";
    readonly message: string;
  };
}

export interface StudioIngestEvent {
  readonly workflowId: string;
  readonly event: SeqlaneExecutionEvent;
}

export type StudioExecutionEvent = SeqlaneExecutionEvent;

export type StudioRunState = "active" | "succeeded" | "failed" | "cancelled";

export type StudioInvocationState =
  | "queued"
  | "waiting"
  | "active"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface StudioRunSummary {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly workflowId: string;
  readonly state: StudioRunState;
  readonly isIncomplete: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly activeInvocationCount: number;
  readonly lastEventSequence: number;
}

export interface StudioInvocationOutput {
  readonly transient?: string;
  readonly persistent: readonly string[];
  readonly metrics?: SeqlaneInvocationMetrics;
  readonly summary?: SeqlaneOutputSummary;
}

export interface StudioInvocationActivity {
  readonly activityId: string;
  readonly kind: "tool" | "skill";
  readonly name: string;
  readonly state: "started" | "progress" | "succeeded" | "failed";
  readonly input?: SeqlaneDisplayValue;
  readonly output?: SeqlaneDisplayValue;
  readonly activityMetadata?: SeqlaneDisplayValue;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly message?: string;
  readonly iteration?: number;
  readonly occurredAt: string;
}

export type StudioValidationVerdict = "passed" | "failed" | "unknown";

export interface StudioValidationSnapshot {
  readonly validationNodeId: PlanNodeId;
  readonly sourceId: string;
  readonly sourceType: "validator" | "evaluator" | "validation-gate";
  readonly verdict: StudioValidationVerdict;
  readonly issues: readonly ValidationIssue[];
  readonly evidence?: SeqlaneDisplayValue;
  readonly continued: boolean;
}

export function initialValidationSnapshot(
  event: Extract<SeqlaneExecutionEvent, { type: "invocation.created" }>,
): StudioValidationSnapshot | undefined {
  if (event.kind !== "validation") return undefined;
  return {
    validationNodeId: event.planNodeId,
    sourceId:
      event.subject.type === "validator"
        ? event.subject.validatorId
        : event.subject.type === "task"
          ? event.subject.taskId
          : event.planNodeId,
    sourceType:
      event.subject.type === "validator"
        ? "validator"
        : event.subject.type === "task"
          ? "evaluator"
          : "validation-gate",
    verdict: "unknown",
    issues: [],
    continued: false,
  };
}

export function validationFromDisplayResult(
  current: StudioValidationSnapshot | undefined,
  display: SeqlaneDisplayValue,
): StudioValidationSnapshot | undefined {
  if (current === undefined) return undefined;
  if (display.state !== "present" || !isPlainRecord(display.value)) {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const success = display.value.success;
  const rawIssues = display.value.issues;
  if (
    typeof success !== "boolean" ||
    (success === false &&
      (!Array.isArray(rawIssues) || !rawIssues.every(isValidationIssue)))
  ) {
    return { ...current, verdict: "unknown", issues: [], evidence: undefined };
  }
  const evidence = display.value.evidence;
  const issues = success ? [] : (rawIssues as readonly ValidationIssue[]);
  return {
    ...current,
    verdict: success ? "passed" : "failed",
    issues,
    ...(evidence === undefined
      ? { evidence: undefined }
      : isJsonValue(evidence)
        ? { evidence: { state: "present", value: evidence } }
        : { evidence: undefined }),
    continued: !success && current.sourceType === "validation-gate",
  };
}

export function validationFromFailure(
  current: StudioValidationSnapshot | undefined,
  validation: NonNullable<SerializedSeqlaneError["validation"]>,
): StudioValidationSnapshot {
  return {
    validationNodeId: validation.validationNodeId,
    sourceId: validation.sourceId,
    sourceType: current?.sourceType ?? "validation-gate",
    verdict: "failed",
    issues: validation.issues,
    ...(validation.evidence === undefined
      ? {}
      : { evidence: validation.evidence }),
    continued: false,
  };
}

export interface StudioInvocationSnapshot {
  readonly invocationId: InvocationId;
  readonly planNodeId: PlanNodeId;
  readonly taskId: string;
  readonly kind: SeqlaneInvocationKind;
  readonly label: string;
  readonly parentInvocationId?: InvocationId;
  readonly iteration?: number;
  readonly siblingOrder: number;
  readonly dependencyIds: readonly InvocationId[];
  readonly state: StudioInvocationState;
  readonly input?: SeqlaneDisplayValue;
  readonly result?: SeqlaneDisplayValue;
  readonly activities?: readonly StudioInvocationActivity[];
  readonly output: StudioInvocationOutput;
  readonly validation?: StudioValidationSnapshot;
  readonly error?: SerializedSeqlaneError;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface StudioToolUsage {
  readonly name: string;
  readonly count: number;
}

export interface StudioPlanSnapshot {
  readonly workflow: WorkflowIdentity;
  readonly nodes: readonly StudioPlanNodeSnapshot[];
}

export interface StudioPlanNodeSnapshot {
  readonly planNodeId: PlanNodeId;
  readonly type: SeqlanePlanNodeSnapshot["type"];
  readonly label: string;
  readonly taskId?: string;
  readonly session?: SeqlanePlanNodeSnapshot["session"];
  readonly dependsOn: readonly PlanNodeId[];
  readonly parentPlanNodeId?: PlanNodeId;
  readonly siblingOrder: number;
  readonly maximumIterations?: number;
}

export function studioPlanSnapshot(
  plan: SeqlanePlanSnapshot,
): StudioPlanSnapshot {
  return {
    workflow: {
      id: plan.workflow.id,
      ...(plan.workflow.version === undefined
        ? {}
        : { version: plan.workflow.version }),
    },
    nodes: plan.nodes.map((node) => ({
      planNodeId: node.planNodeId,
      type: node.type,
      label: node.label,
      ...(node.taskId === undefined ? {} : { taskId: node.taskId }),
      ...(node.session === undefined ? {} : { session: node.session }),
      dependsOn: [...node.dependsOn],
      ...(node.parentPlanNodeId === undefined
        ? {}
        : { parentPlanNodeId: node.parentPlanNodeId }),
      siblingOrder: node.siblingOrder,
      ...(node.maximumIterations === undefined
        ? {}
        : { maximumIterations: node.maximumIterations }),
    })),
  };
}

export interface StudioRunSnapshot {
  readonly summary: StudioRunSummary;
  readonly cursor: number;
  readonly plan?: StudioPlanSnapshot;
  readonly invocations: readonly StudioInvocationSnapshot[];
  readonly toolUsage?: readonly StudioToolUsage[];
  readonly skillUsage?: readonly StudioToolUsage[];
}

export interface StudioRunsSnapshot {
  readonly runs: readonly StudioRunSummary[];
  readonly cursor: number;
}

export interface StudioStreamEvent {
  readonly cursor: number;
  readonly workflowId: string;
  readonly event: SeqlaneExecutionEvent;
}

export interface StudioReplayRecording {
  readonly workflowId: string;
  readonly events: readonly StudioStreamEvent[];
}

export interface StudioReplayPayload extends StudioReplayRecording {
  readonly replayId: string;
  readonly fileName: string;
}

export interface StudioStreamReset {
  readonly type: "stream.reset";
  readonly cursor: number;
}
