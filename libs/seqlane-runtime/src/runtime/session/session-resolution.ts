import type {
  InvocationId,
  TaskDefinition,
  TaskDefinitionRegistry,
} from "@seqlane/core";
import type { SeqlaneExecutor } from "../execution/executor.js";
import type { ExecutorModelCapabilities } from "../execution/executor.js";

export interface ResolvedExecutorSession {
  readonly key: symbol;
  readonly executor: SeqlaneExecutor;
  /** Captures an executor-private stable checkpoint after all activity ends. */
  readonly checkpoint?: () => Promise<unknown>;
  /** Creates a distinct executor session from an exact private checkpoint. */
  readonly fork?: (request: {
    readonly checkpoint: unknown;
    readonly invocationId: InvocationId;
    readonly task: TaskDefinition;
  }) => Promise<ResolvedExecutorSession>;
}

export interface SessionConsumer {
  readonly invocationId: InvocationId;
  readonly task: TaskDefinition;
  readonly type: "reuse" | "branch";
}

export class UnsupportedSessionBranchError extends Error {
  constructor(readonly sourceNodeId: string) {
    super(
      `Session checkpoint "${sourceNodeId}" cannot branch because this executor has no native checkpoint fork capability`,
    );
    this.name = "UnsupportedSessionBranchError";
  }
}

export interface SessionResolver {
  readonly modelCapabilities?: ExecutorModelCapabilities;
  resolve(request: {
    readonly invocationId: InvocationId;
    readonly task: TaskDefinition;
  }): Promise<ResolvedExecutorSession>;
}

export async function resolveTaskSession(
  resolvedSessions: Map<InvocationId, ResolvedExecutorSession>,
  resolver: SessionResolver | undefined,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  invocationId: InvocationId,
  taskId: string,
): Promise<void> {
  if (resolver === undefined) return;
  if (resolvedSessions.has(invocationId)) {
    throw new Error(`Invocation "${invocationId}" already has a session`);
  }

  const task = taskDefinitions?.get(taskId);
  if (task === undefined) {
    throw new Error(`No task definition registered for "${taskId}"`);
  }

  resolvedSessions.set(
    invocationId,
    await resolver.resolve({ invocationId, task }),
  );
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
}): Promise<void> {
  const consumers = options.consumers ?? [];
  if (consumers.length === 0) return;
  const branches = consumers.filter(({ type }) => type === "branch");
  if (branches.length === 0) {
    for (const consumer of consumers) {
      options.resolvedSessions.set(
        consumer.invocationId,
        options.sourceSession,
      );
    }
    return;
  }
  const { checkpoint: captureCheckpoint, fork } = options.sourceSession;
  if (captureCheckpoint === undefined || fork === undefined) {
    throw new UnsupportedSessionBranchError(options.sourceNodeId);
  }

  const checkpoint = await captureCheckpoint();
  const materialized: Array<{
    readonly consumer: SessionConsumer;
    readonly session: ResolvedExecutorSession;
  }> = [];
  for (const consumer of consumers) {
    const session =
      consumer.type === "reuse"
        ? options.sourceSession
        : await fork({
            checkpoint,
            invocationId: consumer.invocationId,
            task: consumer.task,
          });
    materialized.push({ consumer, session });
  }
  for (const { consumer, session } of materialized) {
    options.resolvedSessions.set(consumer.invocationId, session);
  }
}
