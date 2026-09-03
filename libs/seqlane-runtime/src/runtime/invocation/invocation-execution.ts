import type {
  SeqlaneInvocationMetrics,
  ModelSelection,
  TaskNode,
  ValidationCheckNode,
  ValidationGateNode,
} from "@seqlane/core";
import { resolveBinding } from "../plan/binding-resolution.js";
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
import { InvocationEffects } from "./invocation-effects.js";
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
  type LegacyTaskNode,
  type TaskExecutionOptions,
  type ValidationEnvelope,
  type ValidationExecutionOptions,
} from "./invocation-support.js";

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
  let workspaceWaitingReported = false;
  let sessionWaitingReported = false;
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
    const resource = context.workspaceResources.get(node.taskId) ?? {
      key: "seqlane:runtime-workspace",
    };
    const session =
      context.sessionResolver === undefined
        ? undefined
        : sessionForInvocation(context.resolvedSessions, invocationId);
    const admission = await context.jointAdmissions.acquire({
      session,
      workspace: resource,
      workspacePolicy: node.workspace,
      invocationId,
      creationOrdinal,
      onWorkspaceWaiting: reportWorkspaceWaiting,
      onSessionWaiting: reportSessionWaiting,
    });
    workspaceLease = admission.workspaceLease;
    sessionLease = admission.sessionLease;
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
    context.events.emit({
      type: "invocation.started",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      subject: options.subject,
      ...taskIdCompatibility(options.subject),
      ...optionalIteration(options.iteration),
    });
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
      const taskSchema = getTaskSchema(
        context.taskSchemas,
        node.taskId,
        context.taskDefinitions,
      );
      let input: unknown;
      try {
        const resolvedInput = resolveBinding(
          node.input,
          context.workflowInput,
          results,
        );
        consumeBindingReferences(results, remainingConsumers, node.input);
        input = taskSchema.input.parse(resolvedInput);
      } catch (cause) {
        throwTaskPhaseError(cause, "input", node.taskId, abortSignal);
      }
      context.events.emit({
        type: "invocation.input",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        input: toSeqlaneDisplayValue(
          input,
          context.taskDefinitions?.get(node.taskId)?.observability?.studio
            ?.input,
        ),
        ...optionalIteration(options.iteration),
      });

      let rawOutput: unknown;
      let metrics: SeqlaneInvocationMetrics | undefined;
      const effects = new InvocationEffects();
      const reportUncertainActivity = (
        activity: SeqlaneUncertainActivity,
      ): void => {
        if (activity.termination === undefined) {
          unconfirmedActivity ??= activity;
          unconfirmedTermination ??= new UnconfirmedInvocationTerminationError(
            activity.reason,
          );
          if (session !== undefined) {
            context.sessionLocks.quarantine(session, unconfirmedTermination);
          }
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
      const activitySelection = context.taskDefinitions?.get(node.taskId)
        ?.observability?.studio?.activity;
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
                input: toSeqlaneDisplayValue(
                  activity.input,
                  activitySelection?.input,
                ),
              }),
          ...(activity.output === undefined
            ? {}
            : {
                output: toSeqlaneDisplayValue(
                  activity.output,
                  activitySelection?.output,
                ),
              }),
          ...(activity.metadata === undefined
            ? {}
            : {
                activityMetadata: toSeqlaneDisplayValue(
                  activity.metadata,
                  activitySelection?.metadata,
                ),
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
        const executor =
          session === undefined
            ? getExecutor(
                context.executors,
                node,
                context.taskDefinitions?.get(node.taskId),
              )
            : session.executor;
        rawOutput = await executor.execute({
          invocationId,
          taskId: node.taskId,
          executor: (node as LegacyTaskNode).executor ?? node.taskId,
          input,
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
          onEffect: (termination) => effects.track(termination),
          onUncertainActivity: reportUncertainActivity,
          onChildSession: reportChildSession,
          onBackgroundProcess: reportBackgroundProcess,
        });
      } catch (cause) {
        executorFailure = { cause };
      }
      try {
        await effects.waitForTermination();
      } catch (cause) {
        executorFailure ??= { cause };
      }
      if (unconfirmedActivity !== undefined) {
        executorFailure ??= {
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
        if (options.validateOutput) output = options.validateOutput(output);
      } catch (cause) {
        throwTaskPhaseError(cause, "output", node.taskId, abortSignal);
      }

      const observableMetrics = metricsWithModelSelection(
        metrics,
        effectiveModelSelection(context, invocationId, session),
      );

      context.events.emit({
        type: "invocation.result",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        result: toSeqlaneDisplayValue(
          output,
          context.taskDefinitions?.get(node.taskId)?.observability?.studio
            ?.result,
        ),
        ...optionalIteration(options.iteration),
      });
      results.set(node.nodeId, output);
      if (session !== undefined) {
        await publishSessionCheckpoint({
          sourceNodeId: node.nodeId,
          sourceSession: session,
          consumers: context.sessionConsumers.get(node.nodeId),
          resolvedSessions: context.resolvedSessions,
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
        ...(observableMetrics === undefined
          ? {}
          : { metrics: observableMetrics }),
        summary: summarizeSeqlaneOutput(output),
        ...optionalIteration(options.iteration),
      });
      releaseIfUnused(results, remainingConsumers, node.nodeId);

      return output;
    } catch (cause) {
      return throwInvocationFailure(cause, {
        context,
        abortSignal,
        invocationId,
        taskId: node.taskId,
        iteration: options.iteration,
      });
    }
  } finally {
    if (unconfirmedActivity === undefined) {
      sessionLease?.release();
      workspaceLease?.release();
      if (workspaceLease !== undefined) {
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
      }
    }
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
      const resolvedInput = resolveBinding(
        node.input,
        context.workflowInput,
        results,
      );
      consumeBindingReferences(results, remainingConsumers, node.input);
      input = definition.input.parse(resolvedInput);
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
      input: toSeqlaneDisplayValue(input, undefined),
      ...optionalIteration(options.iteration),
    });

    const result = parseValidationResult(definition.validate(input));
    context.events.emit({
      type: "invocation.result",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      result: toSeqlaneDisplayValue(result, undefined),
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
    const validation = results.get(node.checkNodeId);
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
      result: toSeqlaneDisplayValue(parsedValidation, undefined),
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
