import type {
  ModelSelection,
  AgentTaskRequest,
  TaskNode,
  TaskDefinition,
  SeqlaneInvocationMetrics,
} from "@seqlane/core";
import type { AgentRuntimeModelCapabilities } from "@seqlane/agent-adapter";
import type { SeqlaneObservation } from "@seqlane/protocol";

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

  /** Preserve an executor failure learned after this error quarantines owners. */
  attachCause(cause: unknown): void {
    if (cause !== this && this.cause === undefined) this.cause = cause;
  }
}

export function findUnconfirmedInvocationTermination(
  cause: unknown,
  seen = new Set<unknown>(),
): UnconfirmedInvocationTerminationError | undefined {
  if (cause instanceof UnconfirmedInvocationTerminationError) return cause;
  if (!(cause instanceof Error) || seen.has(cause)) return undefined;
  seen.add(cause);
  return findUnconfirmedInvocationTermination(cause.cause, seen);
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

/** Normalized model capabilities exposed by a private executor adapter. */
export type ExecutorModelCapabilities = AgentRuntimeModelCapabilities;

export class UntrackedMutatingBackgroundProcessError extends Error {
  constructor() {
    super("Mutating background processes must report their termination");
    this.name = "UntrackedMutatingBackgroundProcessError";
  }
}

export interface ExecutorRequest {
  readonly taskDefinition?: TaskDefinition;
  readonly modelSelection?: ModelSelection;
  readonly invocationId: string;
  readonly taskId: string;
  readonly executor: string;
  readonly input: unknown;
  readonly agent?: AgentTaskRequest;
  readonly signal: AbortSignal;
  readonly onMetrics?: (metrics: SeqlaneInvocationMetrics) => void;
  /** Report bounded executor diagnostics for the invocation output. */
  readonly onDiagnostic?: (message: string) => void;
  readonly onActivity?: (activity: SeqlaneExecutorActivity) => void;
  /** Forwards one adapter observation to the protocol event bridge. */
  readonly onObservation?: (observation: SeqlaneObservation) => void;
  /** Register a managed effect before `execute` resolves. */
  readonly onEffect?: (effect: SeqlaneManagedEffect) => void;
  /** Report a timeout or disconnect whose task termination is not yet known. */
  readonly onUncertainActivity?: (activity: SeqlaneUncertainActivity) => void;
  readonly onChildSession?: (child: SeqlaneChildSession) => void;
  /** Rejects a mutating background process unless it has a tracked lifetime. */
  readonly onBackgroundProcess?: (
    process: SeqlaneBackgroundProcessRequest,
  ) => void;
  readonly onOwnedProcessAcquired?: (pid: number) => Promise<void>;
}

export interface SeqlaneExecutor {
  readonly modelCapabilities?: ExecutorModelCapabilities;
  execute(request: ExecutorRequest): Promise<unknown>;
}

export interface ExecutorResolvers {
  /** Standalone execution checks authored models at agent demand. */
  readonly modelPolicy?: "authored";
  readonly agent: <Input, Output>(
    task: TaskDefinition<Input, Output>,
  ) => SeqlaneExecutor;
  readonly modelCapabilities?: ExecutorModelCapabilities;
}

/** Private callers can resolve task executors from a factory or registry. */
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

  const executor =
    registry.get(node.taskId) ??
    (registry.size === 1 ? registry.values().next().value : undefined);
  if (!executor) {
    throw new Error(`No executor registered for "${node.taskId}"`);
  }
  return executor;
}

export interface ResolvedExecutorModelCapabilities {
  readonly executor: string;
  readonly capabilities: ExecutorModelCapabilities;
}

/** Resolves model capabilities without creating a session. */
export function getExecutorModelCapabilities(
  registry: ExecutorRegistry,
  node: Pick<TaskNode, "taskId">,
): ResolvedExecutorModelCapabilities | undefined {
  if (isExecutorResolvers(registry)) {
    if (registry.modelCapabilities !== undefined) {
      return {
        executor: registry.modelCapabilities.executor,
        capabilities: registry.modelCapabilities,
      };
    }
    return undefined;
  }

  const executor =
    registry.get(node.taskId) ??
    (registry.size === 1 ? registry.values().next().value : undefined);
  if (executor === undefined) return undefined;
  if (executor.modelCapabilities === undefined) return undefined;
  return {
    executor: executor.modelCapabilities.executor,
    capabilities: executor.modelCapabilities,
  };
}

export function describeModelSelection(selection: ModelSelection): string {
  const reasoning = selection.reasoning
    ? ` (reasoning: ${selection.reasoning})`
    : "";
  return `${selection.model.provider}/${selection.model.model}${reasoning}`;
}
