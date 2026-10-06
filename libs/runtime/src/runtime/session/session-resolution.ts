import type {
  InvocationId,
  ModelSelection,
  TaskDefinition,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import type { AgentAdapterCapabilities } from "@seqlane/agent-adapter";
import type { SeqlaneExecutor } from "../execution/executor.js";
import type { ExecutorModelCapabilities } from "../execution/executor.js";

export interface ResolvedExecutorSession {
  readonly key: symbol;
  readonly executor: SeqlaneExecutor;
  /** The immutable Seqlane model selection pinned to this logical session. */
  readonly effectiveSelection?: ModelSelection;
  /** Captures an executor-private stable checkpoint after all activity ends. */
  readonly checkpoint?: () => Promise<unknown>;
  /** Creates a distinct executor session from an exact private checkpoint. */
  readonly fork?: (request: {
    readonly checkpoint: unknown;
    readonly invocationId: InvocationId;
    readonly task: TaskDefinition;
    readonly effectiveSelection?: ModelSelection;
  }) => Promise<ResolvedExecutorSession>;
}

export interface SessionConsumer {
  readonly invocationId: InvocationId;
  readonly task: TaskDefinition;
  readonly type: "reuse" | "branch";
  readonly effectiveSelection?: ModelSelection;
  /** Choice arms materialize only after the condition selects them. */
  readonly deferred?: boolean;
}

export interface DeferredSessionSource {
  readonly session: ResolvedExecutorSession;
  readonly checkpoint?: unknown;
  readonly checkpointCaptured?: boolean;
  readonly failure?: unknown;
}

export class UnsupportedSessionBranchError extends Error {
  constructor(readonly sourceNodeId: string) {
    super(
      `Session checkpoint "${sourceNodeId}" cannot branch because this executor has no native checkpoint fork capability`,
    );
    this.name = "UnsupportedSessionBranchError";
  }
}

export class SessionModelSelectionMismatchError extends Error {
  constructor(
    readonly requested: ModelSelection,
    readonly resolved: ModelSelection,
  ) {
    super(
      "Resolved session effective model selection differs from requested selection",
    );
    this.name = "SessionModelSelectionMismatchError";
  }
}

export interface SessionResolver {
  /** Capabilities resolved from the selected private adapter configuration. */
  readonly adapterCapabilities?: AgentAdapterCapabilities;
  readonly modelCapabilities?: ExecutorModelCapabilities;
  resolve(request: {
    readonly invocationId: InvocationId;
    readonly task: TaskDefinition;
    readonly effectiveSelection?: ModelSelection;
  }): Promise<ResolvedExecutorSession>;
}

function pinSession(
  session: ResolvedExecutorSession,
  effectiveSelection: ModelSelection | undefined,
): ResolvedExecutorSession {
  if (effectiveSelection === undefined) return session;
  const existing = session.effectiveSelection;
  if (existing === undefined) {
    return { ...session, effectiveSelection };
  }
  if (
    existing.model.provider === effectiveSelection.model.provider &&
    existing.model.model === effectiveSelection.model.model &&
    existing.reasoning === effectiveSelection.reasoning
  ) {
    return session;
  }
  throw new SessionModelSelectionMismatchError(effectiveSelection, existing);
}

export async function resolveTaskSession(
  resolvedSessions: Map<InvocationId, ResolvedExecutorSession>,
  resolver: SessionResolver | undefined,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  invocationId: InvocationId,
  taskId: string,
  effectiveSelection?: ModelSelection,
): Promise<void> {
  if (resolver === undefined) return;
  if (resolvedSessions.has(invocationId)) {
    throw new Error(`Invocation "${invocationId}" already has a session`);
  }

  const task = taskDefinitions?.get(taskId);
  if (task === undefined) {
    throw new Error(`No task definition registered for "${taskId}"`);
  }

  const session = await resolver.resolve({
    invocationId,
    task,
    ...(effectiveSelection === undefined ? {} : { effectiveSelection }),
  });
  resolvedSessions.set(invocationId, pinSession(session, effectiveSelection));
}

export function sessionForInvocation(
  resolvedSessions: ReadonlyMap<InvocationId, ResolvedExecutorSession>,
  invocationId: InvocationId,
): ResolvedExecutorSession {
  const session = resolvedSessions.get(invocationId);
  if (session === undefined) {
    throw new Error(`No session resolved for invocation "${invocationId}"`);
  }
  return session;
}

/** Publishes a successful source session and eagerly materializes its branches. */
export async function publishSessionCheckpoint(options: {
  readonly sourceNodeId: string;
  readonly sourceSession: ResolvedExecutorSession;
  readonly consumers: readonly SessionConsumer[] | undefined;
  readonly resolvedSessions: Map<InvocationId, ResolvedExecutorSession>;
  readonly deferredSources?: Map<string, DeferredSessionSource>;
}): Promise<void> {
  const consumers = options.consumers ?? [];
  if (consumers.length === 0) return;
  const eager = consumers.filter(({ deferred }) => deferred !== true);
  const deferred = consumers.filter(({ deferred }) => deferred === true);
  const branches = consumers.filter(({ type }) => type === "branch");
  if (branches.length === 0) {
    if (deferred.length > 0) {
      options.deferredSources?.set(options.sourceNodeId, {
        session: options.sourceSession,
      });
    }
    for (const consumer of eager) {
      options.resolvedSessions.set(
        consumer.invocationId,
        options.sourceSession,
      );
    }
    return;
  }
  const { checkpoint: captureCheckpoint, fork } = options.sourceSession;
  if (captureCheckpoint === undefined || fork === undefined) {
    const failure = new UnsupportedSessionBranchError(options.sourceNodeId);
    if (eager.some(({ type }) => type === "branch")) throw failure;
    options.deferredSources?.set(options.sourceNodeId, {
      session: options.sourceSession,
      failure,
    });
    for (const consumer of eager) {
      options.resolvedSessions.set(
        consumer.invocationId,
        options.sourceSession,
      );
    }
    return;
  }

  let checkpoint: unknown;
  try {
    checkpoint = await captureCheckpoint();
  } catch (failure) {
    if (eager.some(({ type }) => type === "branch")) throw failure;
    options.deferredSources?.set(options.sourceNodeId, {
      session: options.sourceSession,
      failure,
    });
    for (const consumer of eager) {
      options.resolvedSessions.set(
        consumer.invocationId,
        options.sourceSession,
      );
    }
    return;
  }
  if (deferred.length > 0) {
    options.deferredSources?.set(options.sourceNodeId, {
      session: options.sourceSession,
      checkpoint,
      checkpointCaptured: true,
    });
  }
  const materialized: Array<{
    readonly consumer: SessionConsumer;
    readonly session: ResolvedExecutorSession;
  }> = [];
  for (const consumer of eager) {
    const session =
      consumer.type === "reuse"
        ? options.sourceSession
        : pinSession(
            await fork({
              checkpoint,
              invocationId: consumer.invocationId,
              task: consumer.task,
              effectiveSelection:
                consumer.effectiveSelection ??
                options.sourceSession.effectiveSelection,
            }),
            consumer.effectiveSelection ??
              options.sourceSession.effectiveSelection,
          );
    materialized.push({ consumer, session });
  }
  for (const { consumer, session } of materialized) {
    options.resolvedSessions.set(consumer.invocationId, session);
  }
}

/** Materialize one selected choice arm from its source's captured state. */
export async function materializeDeferredSessionConsumer(options: {
  readonly sourceNodeId: string;
  readonly source: DeferredSessionSource | undefined;
  readonly consumer: SessionConsumer;
  readonly resolvedSessions: Map<InvocationId, ResolvedExecutorSession>;
}): Promise<void> {
  const source = options.source;
  if (source === undefined) {
    throw new Error(
      `No session source for choice arm "${options.consumer.invocationId}"`,
    );
  }
  if (options.consumer.type === "reuse") {
    options.resolvedSessions.set(options.consumer.invocationId, source.session);
    return;
  }
  if (source.failure !== undefined) throw source.failure;
  if (!source.checkpointCaptured || source.session.fork === undefined) {
    throw new UnsupportedSessionBranchError(options.sourceNodeId);
  }
  const selection =
    options.consumer.effectiveSelection ?? source.session.effectiveSelection;
  const session = await source.session.fork({
    checkpoint: source.checkpoint,
    invocationId: options.consumer.invocationId,
    task: options.consumer.task,
    effectiveSelection: selection,
  });
  options.resolvedSessions.set(
    options.consumer.invocationId,
    pinSession(session, selection),
  );
}
