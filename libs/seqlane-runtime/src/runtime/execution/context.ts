import type {
  InvocationId,
  PlanNode,
  PlanNodeId,
  RunId,
  TaskDefinitionRegistry,
  SeqlaneError,
  SeqlaneEventSink,
  ValidatorDefinitionRegistry,
  WorkId,
  ModelSelection,
} from "@seqlane/core";
import type { ExecutorRegistry } from "./executor.js";
import { ChildSessionRegistry } from "../session/child-session.js";
import type {
  ResolvedExecutorSession,
  SessionConsumer,
  SessionResolver,
} from "../session/session-resolution.js";
import { SessionLockRegistry } from "../session/session-lock.js";
import type { SharedSessionTaskPair } from "../session/shared-session-order.js";
import type { TaskSchemaRegistry } from "../plan/task-schema.js";
import { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import { JointAdmissionRegistry } from "../invocation/joint-admission.js";

export type ExecutionEventSink = SeqlaneEventSink;

export interface ExecutionContext {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationIds: Map<PlanNodeId, InvocationId>;
  readonly invocationCreationOrdinals: Map<InvocationId, number>;
  nextInvocationCreationOrdinal: number;
  readonly createInvocationId: (nodeId: PlanNodeId) => InvocationId;
  readonly workflowInput: unknown;
  readonly results: Map<string, unknown>;
  readonly remainingConsumers: Map<string, number>;
  readonly executors: ExecutorRegistry;
  readonly resolvedSessions: Map<InvocationId, ResolvedExecutorSession>;
  readonly effectiveModelSelections: Map<InvocationId, ModelSelection>;
  readonly effectiveModelSelectionsByNode: Map<PlanNodeId, ModelSelection>;
  readonly sessionConsumers: Map<string, readonly SessionConsumer[]>;
  readonly sessionLocks: SessionLockRegistry;
  readonly childSessions: ChildSessionRegistry;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly workspaceLocks: WorkspaceLockRegistry;
  readonly jointAdmissions: JointAdmissionRegistry;
  sharedSessionPairs: readonly SharedSessionTaskPair[];
  readonly sessionResolver?: SessionResolver;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  readonly events: ExecutionEventSink;
  workflowResult?: unknown;
  failure?: SeqlaneError;
}

export interface ExecutionContextOptions {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly createInvocationId: (nodeId: PlanNodeId) => InvocationId;
  readonly workflowInput: unknown;
  readonly remainingConsumers?: ReadonlyMap<string, number>;
  readonly executors: ExecutorRegistry;
  readonly sessionResolver?: SessionResolver;
  readonly workspaceResources?: WorkspaceResourceRegistry;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  readonly events?: SeqlaneEventSink;
}

export function createExecutionContext(
  options: ExecutionContextOptions,
): ExecutionContext {
  const workspaceLocks = new WorkspaceLockRegistry();
  const sessionLocks = new SessionLockRegistry();
  return {
    workId: options.workId,
    runId: options.runId,
    invocationIds: new Map(),
    invocationCreationOrdinals: new Map(),
    nextInvocationCreationOrdinal: 0,
    createInvocationId: options.createInvocationId,
    workflowInput: options.workflowInput,
    results: new Map(),
    remainingConsumers: new Map(options.remainingConsumers),
    executors: options.executors,
    resolvedSessions: new Map(),
    effectiveModelSelections: new Map(),
    effectiveModelSelectionsByNode: new Map(),
    sessionConsumers: new Map(),
    sessionLocks,
    childSessions: new ChildSessionRegistry(),
    workspaceResources: options.workspaceResources ?? new Map(),
    workspaceLocks,
    jointAdmissions: new JointAdmissionRegistry(workspaceLocks, sessionLocks),
    sharedSessionPairs: [],
    sessionResolver: options.sessionResolver,
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    taskSchemas: options.taskSchemas,
    events: options.events ?? { emit: () => undefined },
  };
}

/** Returns the stable ordinal assigned when an invocation is created. */
export function invocationCreationOrdinal(
  context: ExecutionContext,
  invocationId: InvocationId,
): number {
  const existing = context.invocationCreationOrdinals.get(invocationId);
  if (existing !== undefined) return existing;

  const ordinal = context.nextInvocationCreationOrdinal;
  context.nextInvocationCreationOrdinal += 1;
  context.invocationCreationOrdinals.set(invocationId, ordinal);
  return ordinal;
}

export function invocationIdForNode(
  context: ExecutionContext,
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
