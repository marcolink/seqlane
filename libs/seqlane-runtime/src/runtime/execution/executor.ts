import type {
  TaskNode,
  TaskDefinition,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";

type LegacyTaskNode = TaskNode & { readonly executor?: string };

export interface SeqlaneExecutorActivity {
  readonly activityId: string;
  readonly kind: "tool" | "skill";
  readonly name: string;
  readonly state: "started" | "progress" | "succeeded" | "failed";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: unknown;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly message?: string;
}

/** Work started by an executor that must finish before its invocation does. */
export interface SeqlaneManagedEffect {
  readonly type: "child" | "process";
  readonly termination: Promise<unknown>;
}

/** An executor cannot prove whether a submitted request has stopped. */
export interface SeqlaneUncertainActivity {
  readonly reason: "timeout" | "disconnect";
  readonly termination?: Promise<unknown>;
}

export class UnconfirmedInvocationTerminationError extends Error {
  constructor(readonly reason: SeqlaneUncertainActivity["reason"]) {
    super(`Executor ${reason} has no termination confirmation`);
    this.name = "UnconfirmedInvocationTerminationError";
  }
}

/** An executor-private child session owned by its parent invocation. */
export interface SeqlaneChildSession {
  readonly termination: Promise<unknown>;
}

/** A process request reported by an executor before it starts in the background. */
export interface SeqlaneBackgroundProcessRequest {
  readonly mutatesWorkspace: boolean;
  readonly termination?: Promise<unknown>;
}

export class UntrackedMutatingBackgroundProcessError extends Error {
  constructor() {
    super("Mutating background processes must report their termination");
    this.name = "UntrackedMutatingBackgroundProcessError";
  }
}

export interface ExecutorRequest {
  readonly invocationId: string;
  readonly taskId: string;
  readonly executor: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly onMetrics?: (metrics: SeqlaneInvocationMetrics) => void;
  readonly onActivity?: (activity: SeqlaneExecutorActivity) => void;
  /** Register a managed effect before `execute` resolves. */
  readonly onEffect?: (effect: SeqlaneManagedEffect) => void;
  /** Report a timeout or disconnect whose task termination is not yet known. */
  readonly onUncertainActivity?: (activity: SeqlaneUncertainActivity) => void;
  readonly onChildSession?: (child: SeqlaneChildSession) => void;
  /** Rejects a mutating background process unless it has a tracked lifetime. */
  readonly onBackgroundProcess?: (
    process: SeqlaneBackgroundProcessRequest,
  ) => void;
}

export interface SeqlaneExecutor {
  execute(request: ExecutorRequest): Promise<unknown>;
}

export interface ExecutorResolvers {
  readonly agent: <Input, Output>(
    task: TaskDefinition<Input, Output>,
  ) => SeqlaneExecutor;
}

/** Temporary internal union while callers migrate from executor-name maps. */
export type ExecutorRegistry =
  ExecutorResolvers | ReadonlyMap<string, SeqlaneExecutor>;

function isExecutorResolvers(
  value: ExecutorRegistry,
): value is ExecutorResolvers {
  return typeof value === "object" && "agent" in value;
}

export function getExecutor<Input, Output>(
  registry: ExecutorRegistry,
  node: TaskNode,
  task: TaskDefinition<Input, Output> | undefined,
): SeqlaneExecutor {
  if (isExecutorResolvers(registry)) {
    if (!task) {
      throw new Error(`No task definition registered for "${node.taskId}"`);
    }
    return registry.agent(task);
  }

  const legacyExecutor = (node as LegacyTaskNode).executor;
  const executor =
    (legacyExecutor && registry.get(legacyExecutor)) ??
    registry.get(node.taskId) ??
    (registry.size === 1 ? registry.values().next().value : undefined);
  if (!executor) {
    throw new Error(
      `No executor registered for "${legacyExecutor ?? node.taskId}"`,
    );
  }
  return executor;
}
