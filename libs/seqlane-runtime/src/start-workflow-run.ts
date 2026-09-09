import { randomUUID } from "node:crypto";
import type {
  BuiltWorkflow,
  JsonValue,
  PlanNode,
  RuntimeProfileReference,
  SeqlaneEventSink,
  SeqlaneRunOutcome,
  TaskDefinitionRegistry,
  WorkId,
  RunId,
} from "@seqlane/core";
import { RuntimeError } from "@seqlane/core";
import { EffectCompiler } from "./runtime/compile/compile-plan.js";
import { preflightCompiledWorkflowModels } from "./runtime/execution/model-preflight.js";
import {
  startCompiledWorkflow,
  type ActiveWorkflowRun,
} from "./runtime/execution/workflow-run.js";
import { resolveCompiledWorkflowSessions } from "./runtime/session/session-preflight.js";
import {
  resolveRuntimeProfile,
  type RuntimeExecution,
  type RuntimeSessionUiNotifier,
} from "./runner/profile/runtime-profile.js";
import type { RuntimeSessionUiAvailable } from "./runner/runtime-session-ui.js";

export interface StartWorkflowRunRequest<Input = unknown, Output = unknown> {
  readonly workflow: BuiltWorkflow<Input, Output>;
  readonly input: JsonValue;
  readonly runtime: RuntimeProfileReference;
  readonly events: SeqlaneEventSink;
  readonly signal?: AbortSignal;
  readonly identity?: {
    readonly workId: WorkId;
    readonly runId: RunId;
  };
  readonly onRuntimeSessionUi?: (
    notification: RuntimeSessionUiAvailable,
  ) => void | Promise<void>;
}

export interface WorkflowRunHandle {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly outcome: Promise<SeqlaneRunOutcome>;
  cancel(): Promise<void>;
}

type RuntimeExecutionResolver = (
  profile: RuntimeProfileReference,
  taskDefinitions: TaskDefinitionRegistry,
  signal: AbortSignal,
  input: JsonValue,
  onSessionUiAvailable?: RuntimeSessionUiNotifier,
) => RuntimeExecution | Promise<RuntimeExecution>;

interface InternalOptions {
  readonly resolveExecution?: RuntimeExecutionResolver;
  readonly createInvocationId?: (nodeId: string) => string;
  readonly emitRunStarted?: boolean;
  readonly emitPlan?: (plan: BuiltWorkflow["plan"]) => void;
}

function containsAgentWork(node: PlanNode): boolean {
  if (node.type === "task") return node.execution !== "local";
  if (node.type === "validation.check") return node.source.type === "task";
  if (node.type === "validation.gate") return false;
  return node.body.nodes.some(containsAgentWork);
}

function planContainsAgentWork(plan: BuiltWorkflow["plan"]): boolean {
  return plan.nodes.some(containsAgentWork);
}

function freshIdentity<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
): {
  readonly workId: WorkId;
  readonly runId: RunId;
} {
  if (request.identity === undefined) {
    return { workId: randomUUID(), runId: randomUUID() };
  }
  if (
    request.identity.workId.length === 0 ||
    request.identity.runId.length === 0
  ) {
    throw new TypeError("Work and Run identities must be non-empty");
  }
  return request.identity;
}

/** Runs a trusted built workflow without runner IPC, CLI state, or process exit. */
export function startWorkflowRun<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
): WorkflowRunHandle {
  return startWorkflowRunInternal(request, {});
}

/** Internal runner adapter hook; intentionally omitted from the package index. */
export function startWorkflowRunInternal<Input, Output>(
  request: StartWorkflowRunRequest<Input, Output>,
  options: InternalOptions,
): WorkflowRunHandle {
  const { workId, runId } = freshIdentity(request);
  const abortController = new AbortController();
  let activeRun: ActiveWorkflowRun | undefined;
  let cancellationRequested = false;
  let cancellationPromise: Promise<void> | undefined;

  const cancel = (): Promise<void> => {
    if (cancellationRequested) return cancellationPromise ?? Promise.resolve();
    cancellationRequested = true;
    abortController.abort();
    cancellationPromise = activeRun?.cancel() ?? Promise.resolve();
    return cancellationPromise;
  };
  const onAbort = (): void => {
    void cancel().catch(() => undefined);
  };
  if (request.signal?.aborted) onAbort();
  else request.signal?.addEventListener("abort", onAbort, { once: true });

  const outcome = (async (): Promise<SeqlaneRunOutcome> => {
    const emitCancelled = (): SeqlaneRunOutcome => {
      request.events.emit({ type: "run.cancelled", workId, runId });
      return { status: "cancelled" };
    };
    try {
      if (options.emitRunStarted ?? true) {
        request.events.emit({ type: "run.started", workId, runId });
      }
      if (cancellationRequested) return emitCancelled();
      // Parsing is deliberately the first workflow operation. In particular,
      // malformed input cannot resolve a runtime profile or execute a task.
      const workflowInput = request.workflow.workflow.input.parse(request.input);
      if (cancellationRequested) return emitCancelled();
      if (
        request.runtime.id === "local" &&
        planContainsAgentWork(request.workflow.plan)
      ) {
        throw new Error(
          'Runtime profile "local" is not configured for agent workflows',
        );
      }
      const execution = await (options.resolveExecution ?? resolveRuntimeProfile)(
        request.runtime,
        request.workflow.taskDefinitions,
        abortController.signal,
        request.input,
        request.onRuntimeSessionUi,
      );
      if (cancellationRequested) return emitCancelled();
      const compiled = new EffectCompiler().compileWorkflow(request.workflow.plan, {
        workId,
        runId,
        createInvocationId: options.createInvocationId,
        workflowInput,
        executors: execution.executors,
        sessionResolver: execution.sessionResolver,
        workspaceResources: execution.workspaceResources,
        taskDefinitions: execution.taskDefinitions,
        validatorDefinitions: request.workflow.validatorDefinitions,
        events: request.events,
      });
      await preflightCompiledWorkflowModels(compiled);
      await resolveCompiledWorkflowSessions(compiled);
      options.emitPlan?.(compiled.plan);
      if (cancellationRequested) return emitCancelled();
      activeRun = startCompiledWorkflow(compiled, {
        emitRunStarted: false,
        signal: abortController.signal,
      });
      if (cancellationRequested) await activeRun.cancel();
      return await activeRun.outcome;
    } catch (cause) {
      if (cancellationRequested) return emitCancelled();
      const error = new RuntimeError(cause);
      request.events.emit({ type: "run.failed", workId, runId, error });
      return { status: "failed", error };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  })();

  return { workId, runId, outcome, cancel };
}

export type { RuntimeSessionUiAvailable };
