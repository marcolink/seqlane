import { PreparedInvocationInput } from "./prepared-input.js";
import { Context, Effect } from "effect";
import type {
  AgentTaskRequest,
  SeqlaneInvocationMetrics,
  ModelSelection,
  TaskNode,
  ValidationCheckNode,
  ValidationGateNode,
  SeqlaneSchema,
} from "@seqlane/core";
import {
  planNodeResult,
  resolveBinding,
  unwrapPlanNodeResult,
} from "../plan/binding-resolution.js";
import {
  invocationCreationOrdinal,
  type ExecutionContext,
} from "../execution/context.js";
import {
  getExecutor,
  type SeqlaneExecutorActivity,
  type SeqlaneBackgroundProcessRequest,
  type SeqlaneChildSession,
  type SeqlaneUncertainActivity,
  UnconfirmedInvocationTerminationError,
  UntrackedMutatingBackgroundProcessError,
} from "../execution/executor.js";
import {
  InvocationEffects,
  InvocationTerminationTimeoutError,
} from "./invocation-effects.js";
import {
  publishSessionCheckpoint,
  sessionForInvocation,
} from "../session/session-resolution.js";
import type { SessionLockLease } from "../session/session-lock.js";
import { summarizeSeqlaneOutput } from "../execution/output-summary.js";
import { getTaskSchema } from "../plan/task-schema.js";
import { toSeqlaneDisplayValue } from "../execution/display-value.js";
import type { WorkspaceLockLease } from "../workspace/workspace-lock.js";
import {
  parseValidationResult,
  validationFailure,
  type RuntimeValidationResult,
} from "../validation/validation-results.js";
import {
  consumeBindingReferences,
  consumeNodeReference,
  optionalIteration,
  releaseIfUnused,
  taskIdCompatibility,
  throwInvocationFailure,
  throwTaskPhaseError,
  type TaskExecutionOptions,
  type ValidationEnvelope,
  type ValidationExecutionOptions,
} from "./invocation-support.js";
import { executeTask } from "../local/task-execution.js";

function runNativeClientCall<A>(
  options: TaskExecutionOptions,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean>>,
  call: (nativeContext: Context.Context<never>) => Effect.Effect<A, unknown>,
): Promise<A> {
  const effect = Effect.gen(function* () {
    return yield* call(yield* Effect.context<never>());
  });
  return Effect.runPromiseWith(options.nativeContext ?? Context.empty())(
    options.nativeContext === undefined
      ? effect
      : Effect.withSpan(effect, name, { kind: "client", attributes }),
  );
}

function effectiveModelSelection(
  context: ExecutionContext,
  invocationId: string,
  session: ReturnType<typeof sessionForInvocation> | undefined,
): ModelSelection | undefined {
  return (
    context.effectiveModelSelections.get(invocationId) ??
    session?.effectiveSelection
  );
}

function metricsWithModelSelection(
  metrics: SeqlaneInvocationMetrics | undefined,
  selection: ModelSelection | undefined,
): SeqlaneInvocationMetrics | undefined {
  if (metrics === undefined && selection === undefined) return undefined;
  return {
    ...(metrics ?? {}),
    ...(selection === undefined ? {} : { modelSelection: selection }),
  };
}

async function publishTaskCompletion(
  context: ExecutionContext,
  node: TaskNode,
  output: unknown,
  options: Pick<
    TaskExecutionOptions,
    "invocationId" | "results" | "remainingConsumers" | "iteration"
  >,
  metrics: SeqlaneInvocationMetrics | undefined,
  session: ReturnType<typeof sessionForInvocation> | undefined,
): Promise<void> {
  const { invocationId, results, remainingConsumers } = options;
  context.events.emit({
    type: "invocation.result",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    result: toSeqlaneDisplayValue(output),
    ...optionalIteration(options.iteration),
  });
  results.set(node.nodeId, planNodeResult(output));
  if (session !== undefined) {
    await publishSessionCheckpoint({
      sourceNodeId: node.nodeId,
      sourceSession: session,
      consumers: context.sessionConsumers.get(node.nodeId),
      resolvedSessions: context.resolvedSessions,
      deferredSources: context.deferredSessionSources,
    });
  }
  context.events.emit({
    type: "invocation.succeeded",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    ...optionalIteration(options.iteration),
  });
  context.events.emit({
    type: "invocation.output",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    policy: "persistent",
    channel: "task",
    content: "Task completed",
    ...(metrics === undefined ? {} : { metrics }),
    summary: summarizeSeqlaneOutput(output),
    ...optionalIteration(options.iteration),
  });
  releaseIfUnused(results, remainingConsumers, node.nodeId);
}

export async function executeTaskNode(
  context: ExecutionContext,
  node: TaskNode,
  abortSignal: AbortSignal,
  options: TaskExecutionOptions,
): Promise<unknown> {
  const { invocationId, results, remainingConsumers } = options;
  const creationOrdinal = invocationCreationOrdinal(context, invocationId);
  let sessionLease: SessionLockLease | undefined;
  let workspaceLease: WorkspaceLockLease | undefined;
  let unconfirmedActivity: SeqlaneUncertainActivity | undefined;
  let unconfirmedTermination: UnconfirmedInvocationTerminationError | undefined;
  let workspaceAdmitted = false;
  let workspaceWaitingReported = false;
  let sessionWaitingReported = false;
  const releaseWorkspace = (): void => {
    workspaceLease?.release();
    workspaceLease = undefined;
    if (!workspaceAdmitted) return;
    workspaceAdmitted = false;
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "active",
      phase: "workspace_released",
      workspace: node.workspace,
      ...optionalIteration(options.iteration),
    });
  };
  const reportWorkspaceWaiting = (
    blockingInvocationId: string | undefined,
  ): void => {
    if (workspaceWaitingReported) return;
    workspaceWaitingReported = true;
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "waiting",
      phase: "admission",
      waitingReason: "workspace_unavailable",
      workspace: node.workspace,
      ...(blockingInvocationId === undefined ? {} : { blockingInvocationId }),
      ...optionalIteration(options.iteration),
    });
  };
  const reportSessionWaiting = (): void => {
    if (sessionWaitingReported) return;
    sessionWaitingReported = true;
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "waiting",
      phase: "admission",
      waitingReason: "session_unavailable",
      ...optionalIteration(options.iteration),
    });
  };

  try {
    const taskSchema = getTaskSchema(
      context.taskSchemas,
      node.taskId,
      context.taskDefinitions,
    );
    const preparedInput = prepareTaskInput(
      context,
      node,
      options,
      abortSignal,
      taskSchema.input,
    );

    const resource = context.workspaceResources.get(node.taskId) ?? {
      key: "seqlane:runtime-workspace",
    };
    const session = context.resolvedSessions.get(invocationId);
    if (options.admission !== undefined) {
      workspaceLease = options.admission.workspaceLease;
      sessionLease = options.admission.sessionLease;
    } else if (options.workspaceAdmission === "graph") {
      if (abortSignal.aborted) {
        throw abortSignal.aborted
          ? abortSignal.reason
          : new Error("Task execution cancelled");
      }
      sessionLease =
        session === undefined
          ? undefined
          : await context.sessionLocks.acquire(
              session,
              reportSessionWaiting,
              creationOrdinal,
              abortSignal,
            );
    } else {
      const admission = await context.jointAdmissions.acquire({
        signal: abortSignal,
        session,
        workspace: resource,
        workspacePolicy: node.workspace,
        invocationId,
        ownerId: context.workspaceOwnerId ?? invocationId,
        creationOrdinal,
        onWorkspaceWaiting: reportWorkspaceWaiting,
        onSessionWaiting: reportSessionWaiting,
      });
      workspaceLease = admission.workspaceLease;
      sessionLease = admission.sessionLease;
    }
    workspaceAdmitted = true;
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "active",
      phase: "workspace_admitted",
      workspace: node.workspace,
      ...optionalIteration(options.iteration),
    });
    const startedEvent = {
      type: "invocation.started",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      subject: options.subject,
      ...taskIdCompatibility(options.subject),
      ...optionalIteration(options.iteration),
    } as const;
    if (context.events.emitAsync === undefined)
      context.events.emit(startedEvent);
    else await context.events.emitAsync(startedEvent);
    context.events.emit({
      type: "invocation.progress",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      state: "active",
      phase: "execute",
      message: "Executing task",
      ...optionalIteration(options.iteration),
    });
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      policy: "transient",
      channel: "task",
      content: "Executing task",
      ...optionalIteration(options.iteration),
    });

    try {
      consumeBindingReferences(results, remainingConsumers, node.input);
      const input: unknown = preparedInput.value;
      context.events.emit({
        type: "invocation.input",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        input: toSeqlaneDisplayValue(input),
        ...optionalIteration(options.iteration),
      });

      let rawOutput: unknown;
      let metrics: SeqlaneInvocationMetrics | undefined;
      const effects = new InvocationEffects(options.terminationTimeoutMs);
      const reportUncertainActivity = (
        activity: SeqlaneUncertainActivity,
      ): void => {
        if (activity.termination === undefined) {
          unconfirmedActivity ??= activity;
          unconfirmedTermination ??= new UnconfirmedInvocationTerminationError(
            activity.reason,
          );
          if (options.admissionOwnership !== undefined)
            options.admissionOwnership.uncertainty ??= unconfirmedTermination;
          if (session !== undefined) {
            context.sessionLocks.quarantine(session, unconfirmedTermination);
          }
          context.workspaceLocks.quarantine(resource, unconfirmedTermination);
          if (options.admissionOwnership !== undefined)
            options.admissionOwnership.retain = true;
          return;
        }
        effects.trackTermination(activity.termination);
      };
      const reportBackgroundProcess = (
        process: SeqlaneBackgroundProcessRequest,
      ): void => {
        if (!process.mutatesWorkspace) return;
        if (process.termination === undefined) {
          throw new UntrackedMutatingBackgroundProcessError();
        }
        effects.track({ type: "process", termination: process.termination });
      };
      const reportChildSession = (child: SeqlaneChildSession): void => {
        const registeredChild = context.childSessions.register(
          invocationId,
          child.termination,
        );
        effects.track({
          type: "child",
          termination: registeredChild.termination,
        });
      };
      const emitActivity = (activity: SeqlaneExecutorActivity): void => {
        effects.observeActivity(activity);
        context.events.emit({
          type: "invocation.activity",
          workId: context.workId,
          runId: context.runId,
          invocationId,
          activityId: activity.activityId,
          kind: activity.kind,
          name: activity.name,
          state: activity.state,
          ...(activity.input === undefined
            ? {}
            : {
                input: toSeqlaneDisplayValue(activity.input),
              }),
          ...(activity.output === undefined
            ? {}
            : {
                output: toSeqlaneDisplayValue(activity.output),
              }),
          ...(activity.metadata === undefined
            ? {}
            : {
                activityMetadata: toSeqlaneDisplayValue(activity.metadata),
              }),
          ...(activity.startedAt === undefined
            ? {}
            : { startedAt: activity.startedAt }),
          ...(activity.endedAt === undefined
            ? {}
            : { endedAt: activity.endedAt }),
          ...(activity.message === undefined
            ? {}
            : { message: activity.message }),
          ...optionalIteration(options.iteration),
        });
      };
      let executorFailure: { readonly cause: unknown } | undefined;
      try {
        const definition = context.taskDefinitions?.get(node.taskId);
        if (definition === undefined) {
          throw new Error(`No task definition registered for "${node.taskId}"`);
        }
        const classifier = context.classifier;
        const runAgent = async (
          agentRequest: AgentTaskRequest,
        ): Promise<unknown> => {
          // A task without an invocation session uses the registered executor as
          // an isolated one-shot adapter execution. Session resolution is an
          // admission concern and must never happen from inside execute.
          const executor =
            session?.executor ??
            getExecutor(context.executors, node, definition);
          return runNativeClientCall(
            options,
            "seqlane.adapter.execute",
            {
              "seqlane.invocation.id": invocationId,
              "seqlane.adapter.kind": "agent",
            },
            (nativeContext) =>
              Effect.tryPromise({
                try: () =>
                  executor.execute({
                    nativeContext,
                    taskDefinition: definition,
                    modelSelection:
                      effectiveModelSelection(context, invocationId, session) ??
                      context.workflowModel,
                    invocationId,
                    taskId: node.taskId,
                    executor: node.taskId,
                    input,
                    agent: agentRequest,
                    signal: abortSignal,
                    onMetrics: (value) => {
                      metrics = value;
                    },
                    onDiagnostic: (message) => {
                      context.events.emit({
                        type: "invocation.output",
                        workId: context.workId,
                        runId: context.runId,
                        invocationId,
                        policy: "persistent",
                        channel: "task",
                        content: message,
                        ...optionalIteration(options.iteration),
                      });
                    },
                    onActivity: emitActivity,
                    onObservation: (observation) =>
                      context.onObservation?.(
                        invocationId,
                        observation,
                        options.iteration,
                      ),
                    onEffect: (termination) => effects.track(termination),
                    onUncertainActivity: reportUncertainActivity,
                    onChildSession: reportChildSession,
                    onBackgroundProcess: reportBackgroundProcess,
                  }),
                catch: (cause) => cause,
              }),
          );
        };
        rawOutput = await executeTask({
          nativeContext: options.nativeContext,
          definition,
          input,
          taskId: node.taskId,
          invocationId,
          cwd:
            resource.key === "seqlane:runtime-workspace"
              ? process.cwd()
              : resource.key,
          signal: abortSignal,
          runAgent,
          onOwnedProcessAcquired: context.onOwnedProcessAcquired,
          ...(classifier === undefined
            ? {}
            : {
                classify: (request) =>
                  runNativeClientCall(
                    options,
                    "seqlane.classifier.execute",
                    {
                      "seqlane.invocation.id": invocationId,
                    },
                    () =>
                      classifier(request, abortSignal, (observation) =>
                        context.onObservation?.(
                          invocationId,
                          observation,
                          options.iteration,
                        ),
                      ),
                  ),
              }),
          onUncertainActivity: reportUncertainActivity,
        });
        if (options.admissionOwnership?.retain === true) {
          throw options.admissionOwnership.uncertainty;
        }
      } catch (cause) {
        executorFailure = { cause };
      }
      try {
        await effects.waitForTermination();
      } catch (cause) {
        executorFailure ??= { cause };
        if (cause instanceof InvocationTerminationTimeoutError) {
          reportUncertainActivity({ reason: "timeout" });
        }
      }
      if (unconfirmedActivity !== undefined) {
        if (executorFailure !== undefined)
          unconfirmedTermination?.attachCause(executorFailure.cause);
        executorFailure = {
          cause:
            unconfirmedTermination ??
            new UnconfirmedInvocationTerminationError(
              unconfirmedActivity.reason,
            ),
        };
      }
      if (executorFailure !== undefined) {
        throwTaskPhaseError(
          executorFailure.cause,
          "executor",
          node.taskId,
          abortSignal,
        );
      }

      let output: unknown;
      try {
        output = taskSchema.output.parse(rawOutput);
        if (options.validateOutput) {
          // Evaluators acquire their own workspace admission. Keep the session
          // lock until checkpoint capture, but release execution workspace locks.
          releaseWorkspace();
          output = await options.validateOutput(output);
        }
      } catch (cause) {
        throwTaskPhaseError(cause, "output", node.taskId, abortSignal);
      }

      const observableMetrics = metricsWithModelSelection(
        metrics,
        effectiveModelSelection(context, invocationId, session),
      );
      if (options.deferCompletion) {
        context.deferredTaskMetrics.set(invocationId, observableMetrics);
        results.set(node.nodeId, planNodeResult(output));
        return output;
      }

      await publishTaskCompletion(
        context,
        node,
        output,
        options,
        observableMetrics,
        session,
      );

      return output;
    } catch (cause) {
      if (options.admissionOwnership?.retain === true) throw cause;
      return throwInvocationFailure(cause, {
        context,
        abortSignal,
        invocationId,
        taskId: node.taskId,
        iteration: options.iteration,
      });
    }
  } finally {
    if (
      unconfirmedActivity === undefined &&
      options.admissionOwnership?.retain !== true
    ) {
      if (!options.deferCompletion) sessionLease?.release();
      releaseWorkspace();
    }
  }
}

/** Publish a native choice/repeat task only after its output validation passes. */
export async function completeDeferredTaskNode(
  context: ExecutionContext,
  node: TaskNode,
  output: unknown,
  options: Pick<
    TaskExecutionOptions,
    "invocationId" | "results" | "remainingConsumers" | "iteration"
  >,
): Promise<void> {
  const { invocationId } = options;
  const session = context.resolvedSessions.get(invocationId);
  const metrics = context.deferredTaskMetrics.get(invocationId);
  context.deferredTaskMetrics.delete(invocationId);
  await publishTaskCompletion(context, node, output, options, metrics, session);
}

export function failDeferredTaskNode(
  cause: unknown,
  context: ExecutionContext,
  node: TaskNode,
  abortSignal: AbortSignal,
  output: unknown,
  options: Pick<TaskExecutionOptions, "invocationId" | "iteration">,
): never {
  const metrics = context.deferredTaskMetrics.get(options.invocationId);
  context.deferredTaskMetrics.delete(options.invocationId);
  if (metrics !== undefined) {
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId: options.invocationId,
      policy: "persistent",
      channel: "task",
      content: "Task completed",
      metrics,
      summary: summarizeSeqlaneOutput(output),
      ...optionalIteration(options.iteration),
    });
  }
  return throwInvocationFailure(cause, {
    context,
    abortSignal,
    invocationId: options.invocationId,
    taskId: node.taskId,
    iteration: options.iteration,
  });
}

export function prepareTaskInput(
  context: ExecutionContext,
  node: TaskNode,
  options: TaskExecutionOptions,
  abortSignal: AbortSignal,
  inputSchema: SeqlaneSchema,
): PreparedInvocationInput {
  try {
    return (
      options.preparedInput ??
      PreparedInvocationInput.parse(
        inputSchema,
        resolveBinding(node.input, context.workflowInput, options.results),
      )
    );
  } catch (cause) {
    return throwTaskPhaseError(cause, "input", node.taskId, abortSignal);
  }
}

export async function executeValidationCheckNode(
  context: ExecutionContext,
  node: ValidationCheckNode,
  abortSignal: AbortSignal,
  options: ValidationExecutionOptions,
): Promise<RuntimeValidationResult> {
  if (node.source.type === "task") {
    const taskNode = {
      type: "task",
      taskId: node.source.taskId,
      nodeId: node.nodeId,
      workspace: node.source.workspace,
      input: node.input,
      dependsOn: node.dependsOn,
    } as TaskNode;
    return (await executeTaskNode(context, taskNode, abortSignal, {
      ...options,
      subject: { type: "task", taskId: node.source.taskId },
      validateOutput: parseValidationResult,
    })) as RuntimeValidationResult;
  }

  const { invocationId, results, remainingConsumers } = options;
  const sourceId = node.source.validatorId;
  context.events.emit({
    type: "invocation.started",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    subject: { type: "validator", validatorId: sourceId },
    ...optionalIteration(options.iteration),
  });
  context.events.emit({
    type: "invocation.progress",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    state: "active",
    phase: "execute",
    message: "Executing validation",
    ...optionalIteration(options.iteration),
  });
  context.events.emit({
    type: "invocation.output",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    policy: "transient",
    channel: "task",
    content: "Executing validation",
    ...optionalIteration(options.iteration),
  });

  try {
    if (abortSignal.aborted) throw new Error("Validation execution cancelled");
    const definition = context.validatorDefinitions?.get(sourceId);
    if (!definition) {
      throw new Error(`No validator "${sourceId}" is registered`);
    }
    let input: unknown;
    try {
      const preparedInput =
        options.preparedInput ??
        PreparedInvocationInput.parse(
          definition.input,
          resolveBinding(node.input, context.workflowInput, results),
        );
      consumeBindingReferences(results, remainingConsumers, node.input);
      input = preparedInput.value;
    } catch (cause) {
      throw new Error(`Validation input parsing failed: ${String(cause)}`, {
        cause,
      });
    }
    context.events.emit({
      type: "invocation.input",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      input: toSeqlaneDisplayValue(input),
      ...optionalIteration(options.iteration),
    });

    const result = parseValidationResult(definition.validate(input));
    context.events.emit({
      type: "invocation.result",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      result: toSeqlaneDisplayValue(result),
      ...optionalIteration(options.iteration),
    });
    results.set(node.nodeId, result);
    context.events.emit({
      type: "invocation.succeeded",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      ...optionalIteration(options.iteration),
    });
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      policy: "persistent",
      channel: "task",
      content: "Validation completed",
      summary: summarizeSeqlaneOutput(result),
      ...optionalIteration(options.iteration),
    });
    releaseIfUnused(results, remainingConsumers, node.nodeId);
    return result;
  } catch (cause) {
    throwInvocationFailure(cause, {
      context,
      abortSignal,
      invocationId,
      taskId: sourceId,
      iteration: options.iteration,
    });
  }
}

export async function executeValidationGateNode(
  context: ExecutionContext,
  node: ValidationGateNode,
  checkNode: ValidationCheckNode,
  abortSignal: AbortSignal,
  options: ValidationExecutionOptions,
): Promise<ValidationEnvelope> {
  const { invocationId, results, remainingConsumers } = options;
  context.events.emit({
    type: "invocation.started",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    subject: { type: "validation-gate", planNodeId: node.nodeId },
    ...optionalIteration(options.iteration),
  });
  context.events.emit({
    type: "invocation.progress",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    state: "active",
    phase: "validate",
    message: "Applying validation gate",
    ...optionalIteration(options.iteration),
  });
  context.events.emit({
    type: "invocation.output",
    workId: context.workId,
    runId: context.runId,
    invocationId,
    policy: "transient",
    channel: "task",
    content: "Applying validation gate",
    ...optionalIteration(options.iteration),
  });

  try {
    if (abortSignal.aborted) throw new Error("Validation gate cancelled");
    const validation = unwrapPlanNodeResult(results.get(node.checkNodeId));
    const parsedValidation = parseValidationResult(validation);
    const value = resolveBinding(node.input, context.workflowInput, results);
    consumeBindingReferences(results, remainingConsumers, node.input);
    consumeNodeReference(results, remainingConsumers, node.checkNodeId);
    const envelope: ValidationEnvelope = {
      value,
      validation: parsedValidation,
    };

    if (!parsedValidation.success && node.policy === "fail") {
      throw validationFailure(node, checkNode, parsedValidation);
    }

    results.set(node.nodeId, envelope);
    context.events.emit({
      type: "invocation.result",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      result: toSeqlaneDisplayValue(parsedValidation),
      ...optionalIteration(options.iteration),
    });
    context.events.emit({
      type: "invocation.succeeded",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      ...optionalIteration(options.iteration),
    });
    context.events.emit({
      type: "invocation.output",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      policy: "persistent",
      channel: "task",
      content: "Validation gate completed",
      summary: summarizeSeqlaneOutput(parsedValidation),
      ...optionalIteration(options.iteration),
    });
    releaseIfUnused(results, remainingConsumers, node.nodeId);
    return envelope;
  } catch (cause) {
    throwInvocationFailure(cause, {
      context,
      abortSignal,
      invocationId,
      taskId: node.nodeId,
      iteration: options.iteration,
    });
  }
}
