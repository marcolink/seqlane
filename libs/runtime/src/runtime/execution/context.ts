import type {
  InvocationId,
  PlanNode,
  PlanNodeId,
  RunId,
  TaskDefinitionRegistry,
  WorkflowDefinitionRegistry,
  SeqlaneError,
  SeqlaneEventSink,
  SeqlaneEvent,
  ValidatorDefinitionRegistry,
  WorkId,
  ModelSelection,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import type { SeqlaneObservation } from "@seqlane/protocol";
import type { ExecutorRegistry } from "./executor.js";
import { ChildSessionRegistry } from "../session/child-session.js";
import { ChoiceSourceGate } from "../session/choice-source-gate.js";
import type {
  ResolvedExecutorSession,
  SessionConsumer,
  SessionResolver,
  DeferredSessionSource,
} from "../session/session-resolution.js";
import { SessionLockRegistry } from "../session/session-lock.js";
import type { SharedSessionTaskPair } from "../session/shared-session-order.js";
import type { TaskSchemaRegistry } from "../plan/task-schema.js";
import { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import { JointAdmissionRegistry } from "../invocation/joint-admission.js";
import type { ClassifierTaskRunner } from "../../classifier/types.js";

export interface ExecutionEventSink extends SeqlaneEventSink {
  /** Async producers can wait for the private worker's byte-bounded ACK queue. */
  readonly emitAsync?: (event: SeqlaneEvent) => Promise<void>;
}
export type ExecutionObservationSink = (
  invocationId: InvocationId,
  observation: SeqlaneObservation,
  iteration?: number,
) => void;

export interface ExecutionRunState {
  readonly invocationCreationOrdinals: Map<InvocationId, number>;
  readonly invocationOrdinalCounter: { next: number };
  readonly sessionLocks: SessionLockRegistry;
  readonly childSessions: ChildSessionRegistry;
  readonly workspaceLocks: WorkspaceLockRegistry;
  readonly jointAdmissions: JointAdmissionRegistry;
  readonly repeatBudget: { executed: number };
}

export interface ExecutionContext {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationIds: Map<PlanNodeId, InvocationId>;
  readonly terminalInvocationIds: Set<InvocationId>;
  readonly deferredTaskMetrics: Map<
    InvocationId,
    SeqlaneInvocationMetrics | undefined
  >;
  readonly invocationCreationOrdinals: Map<InvocationId, number>;
  readonly invocationOrdinalCounter: { next: number };
  readonly createInvocationId: (nodeId: PlanNodeId) => InvocationId;
  readonly workflowInput: unknown;
  /** Adapter-neutral default for new agent sessions in this compiled workflow. */
  readonly workflowModel?: ModelSelection;
  readonly results: Map<string, unknown>;
  readonly remainingConsumers: Map<string, number>;
  readonly executors: ExecutorRegistry;
  readonly resolvedSessions: Map<InvocationId, ResolvedExecutorSession>;
  readonly effectiveModelSelections: Map<InvocationId, ModelSelection>;
  readonly effectiveModelSelectionsByNode: Map<PlanNodeId, ModelSelection>;
  readonly sessionConsumers: Map<string, readonly SessionConsumer[]>;
  readonly deferredSessionSources: Map<string, DeferredSessionSource>;
  readonly choiceSourceGate: ChoiceSourceGate;
  readonly sessionLocks: SessionLockRegistry;
  readonly childSessions: ChildSessionRegistry;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly workspaceLocks: WorkspaceLockRegistry;
  readonly workspaceOwnerId?: string;
  readonly workspaceOwnerAncestors: readonly string[];
  readonly parentInvocationId?: string;
  readonly jointAdmissions: JointAdmissionRegistry;
  sharedSessionPairs: readonly SharedSessionTaskPair[];
  readonly sessionResolver?: SessionResolver;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly workflowDefinitions?: WorkflowDefinitionRegistry;
  readonly runState: ExecutionRunState;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  readonly events: ExecutionEventSink;
  readonly onObservation?: ExecutionObservationSink;
  readonly classifier?: ClassifierTaskRunner;
  workflowResult?: unknown;
  failure?: SeqlaneError;
}

export interface ExecutionContextOptions {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly createInvocationId: (nodeId: PlanNodeId) => InvocationId;
  readonly workflowInput: unknown;
  readonly workflowModel?: ModelSelection;
  readonly remainingConsumers?: ReadonlyMap<string, number>;
  readonly executors: ExecutorRegistry;
  readonly sessionResolver?: SessionResolver;
  readonly workspaceResources?: WorkspaceResourceRegistry;
  readonly workspaceLocks?: WorkspaceLockRegistry;
  readonly runState?: ExecutionRunState;
  readonly workspaceOwnerId?: string;
  readonly workspaceOwnerAncestors?: readonly string[];
  readonly parentInvocationId?: string;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly workflowDefinitions?: WorkflowDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  readonly events?: ExecutionEventSink;
  readonly onObservation?: ExecutionObservationSink;
  readonly classifier?: ClassifierTaskRunner;
}

export function createExecutionContext(
  options: ExecutionContextOptions,
): ExecutionContext {
  const workspaceLocks =
    options.runState?.workspaceLocks ??
    options.workspaceLocks ??
    new WorkspaceLockRegistry();
  const sessionLocks =
    options.runState?.sessionLocks ?? new SessionLockRegistry();
  const choiceSourceGate = new ChoiceSourceGate();
  const runState: ExecutionRunState = options.runState ?? {
    invocationCreationOrdinals: new Map(),
    invocationOrdinalCounter: { next: 0 },
    sessionLocks,
    childSessions: new ChildSessionRegistry(),
    workspaceLocks,
    jointAdmissions: new JointAdmissionRegistry(workspaceLocks, sessionLocks),
    repeatBudget: { executed: 0 },
  };
  const terminalInvocationIds = new Set<string>();
  const deferredTaskMetrics = new Map<
    string,
    SeqlaneInvocationMetrics | undefined
  >();
  return {
    workId: options.workId,
    runId: options.runId,
    invocationIds: new Map(),
    terminalInvocationIds,
    deferredTaskMetrics,
    invocationCreationOrdinals: runState.invocationCreationOrdinals,
    invocationOrdinalCounter: runState.invocationOrdinalCounter,
    createInvocationId: options.createInvocationId,
    workflowInput: options.workflowInput,
    workflowModel: options.workflowModel,
    results: new Map(),
    remainingConsumers: new Map(options.remainingConsumers),
    executors: options.executors,
    resolvedSessions: new Map(),
    effectiveModelSelections: new Map(),
    effectiveModelSelectionsByNode: new Map(),
    sessionConsumers: new Map(),
    deferredSessionSources: new Map(),
    choiceSourceGate,
    sessionLocks,
    childSessions: runState.childSessions,
    workspaceResources: options.workspaceResources ?? new Map(),
    workspaceLocks,
    workspaceOwnerId: options.workspaceOwnerId,
    workspaceOwnerAncestors: options.workspaceOwnerAncestors ?? [],
    parentInvocationId: options.parentInvocationId,
    jointAdmissions: runState.jointAdmissions,
    runState,
    sharedSessionPairs: [],
    sessionResolver: options.sessionResolver,
    taskDefinitions: options.taskDefinitions,
    workflowDefinitions: options.workflowDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    taskSchemas: options.taskSchemas,
    events: {
      emit: (event) => {
        options.events?.emit(event);
        observeEvent(event);
      },
      ...(options.events?.emitAsync === undefined
        ? {}
        : {
            emitAsync: async (event: SeqlaneEvent) => {
              await options.events!.emitAsync!(event);
              observeEvent(event);
            },
          }),
    },
    onObservation: options.onObservation,
    classifier: options.classifier,
  };

  function observeEvent(event: SeqlaneEvent): void {
    if (
      event.type === "invocation.succeeded" ||
      (event.type === "invocation.failed" &&
        event.disposition !== "retry_scheduled") ||
      event.type === "invocation.cancelled" ||
      event.type === "invocation.skipped"
    ) {
      terminalInvocationIds.add(event.invocationId);
    }
    choiceSourceGate.observe(event);
  }
}

/** Returns the stable ordinal assigned when an invocation is created. */
export function invocationCreationOrdinal(
  context: ExecutionContext,
  invocationId: InvocationId,
): number {
  const existing = context.invocationCreationOrdinals.get(invocationId);
  if (existing !== undefined) return existing;

  const ordinal = context.invocationOrdinalCounter.next;
  context.invocationOrdinalCounter.next += 1;
  context.invocationCreationOrdinals.set(invocationId, ordinal);
  return ordinal;
}

export function invocationIdForNode(
  context: {
    readonly invocationIds: ReadonlyMap<PlanNodeId, InvocationId>;
  },
  node: PlanNode,
): InvocationId {
  const invocationId = context.invocationIds.get(node.nodeId);
  if (!invocationId) {
    throw new Error(
      `No Invocation ID allocated for Plan node "${node.nodeId}"`,
    );
  }
  return invocationId;
}
