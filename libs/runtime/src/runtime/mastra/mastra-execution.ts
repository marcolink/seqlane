import type {
  BuiltWorkflow,
  Plan,
  PlanNode,
  ValidationCheckNode,
  SeqlaneEventSink,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkId,
  RunId,
  InvocationId,
  RepeatNode,
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
} from "@seqlane/core";
import type {
  InvocationObservationEvent,
  SeqlaneObservation,
} from "@seqlane/protocol";
import { RequestContext } from "@mastra/core/request-context";
import { SeqlaneError } from "@seqlane/core";
import {
  compilePlanToMastra,
  type CompiledMastraPlan,
  type MastraPlanInvocation,
  type MastraPlanInvocationContext,
  type RepeatExecutionBudget,
} from "../compile/mastra-plan-compiler.js";
import {
  PlanCompiler,
  type PreparedPlanExecution,
} from "../compile/compile-plan.js";
import {
  executeTaskNode,
  executeWorkflowNode,
  executeValidationCheckNode,
  executeValidationGateNode,
} from "../invocation/invocation-execution.js";
import {
  invocationKind,
  invocationSubject,
  invocationTaskId,
} from "../execution/workflow-run.js";
import {
  invocationIdForNode,
  type ExecutionContext,
} from "../execution/context.js";
import {
  referencedNodeIds,
  WORKFLOW_INPUT_NODE_ID,
} from "../plan/binding-resolution.js";
import {
  createMastraRuntime,
  type MastraRuntime,
  type MastraWorkflowResult,
} from "./mastra-runtime.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";
import { toSeqlaneInvocationError } from "../execution/errors.js";
import type { ExecutorResolvers } from "../execution/executor.js";
import type { SessionResolver } from "../session/session-resolution.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import type { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
import {
  preflightCompiledWorkflowModels,
  preflightSelectedChoiceModel,
} from "../execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  preflightSelectedChoiceSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";
import {
  materializeDeferredSessionConsumer,
  resolveTaskSession,
} from "../session/session-resolution.js";
import { validateRepeatOutput } from "./repeat-validation.js";
import { workspaceResourcesForExecution } from "./workspace-resources.js";
import type { ClassifierTaskRunner } from "../../classifier/types.js";

export interface MastraPlanExecutionOptions {
  readonly plan: Plan;
  readonly workflowInput: unknown;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly createInvocationId: (nodeId?: string) => InvocationId;
  readonly executors: ExecutorResolvers;
  readonly sessionResolver: SessionResolver;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly workspaceLocks?: WorkspaceLockRegistry;
  readonly workspaceOwnerId?: string;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly workflowDefinitions?: WorkflowDefinitionRegistry;
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly events: SeqlaneEventSink;
  readonly onObservation?: (
    event: Omit<InvocationObservationEvent, "metadata">,
  ) => void;
  readonly classifier?: ClassifierTaskRunner;
  readonly repeatBudget?: RepeatExecutionBudget;
}

export interface MastraPlanExecution {
  readonly prepared: PreparedPlanExecution;
  readonly compiled: CompiledMastraPlan;
  readonly runtime: MastraRuntime;
}

function checkNodes(plan: Plan): Map<string, ValidationCheckNode> {
  return new Map(
    plan.nodes
      .filter(
        (node): node is ValidationCheckNode => node.type === "validation.check",
      )
      .map((node) => [node.nodeId, node]),
  );
}

function nestedRunContext(
  requestContext: MastraPlanInvocationContext["requestContext"],
  abortSignal: AbortSignal,
): {
  readonly requestContext: RequestContext;
  readonly abortSignal: AbortSignal;
} {
  return {
    requestContext: requestContext ?? new RequestContext(),
    abortSignal,
  };
}

function dependencyResults(
  node: Exclude<PlanNode, { type: "choice" }>,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
): Map<string, unknown> {
  const results = new Map<string, unknown>();
  const referenced = new Set([
    ...node.dependsOn,
    ...referencedNodeIds(node.input),
    ...(node.type === "validation.gate" ? [node.checkNodeId] : []),
  ]);
  for (const nodeId of referenced) {
    if (nodeId === WORKFLOW_INPUT_NODE_ID) continue;
    results.set(nodeId, getStepResult(nodeId));
  }
  return results;
}

function dependencyInvocationIds(
  context: InvocationTopologyContext,
  compiled: CompiledMastraPlan,
  node: PlanNode,
): readonly InvocationId[] {
  return node.dependsOn.flatMap((dependency) => {
    const dependencyNode = compiled.orderedNodes.find(
      ({ nodeId }) => nodeId === dependency,
    );
    return dependencyNode === undefined
      ? []
      : [invocationIdForNode(context, dependencyNode)];
  });
}

interface InvocationTopologyContext {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationIds: ReadonlyMap<PlanNode["nodeId"], InvocationId>;
}

function forwardObservation(
  onObservation: MastraPlanExecutionOptions["onObservation"],
  workId: WorkId,
  runId: RunId,
  invocationId: InvocationId,
  observation: SeqlaneObservation,
  iteration?: number,
): void {
  onObservation?.({
    type: "invocation.observation",
    workId,
    runId,
    invocationId,
    ...observation,
    ...(iteration === undefined ? {} : { iteration }),
  });
}

export function emitMastraInvocationTopology(
  compiled: CompiledMastraPlan,
  prepared: {
    readonly context: InvocationTopologyContext;
  },
  events: SeqlaneEventSink,
  parentInvocationId?: InvocationId,
): void {
  const { context } = prepared;
  for (const [siblingOrder, node] of compiled.orderedNodes.entries()) {
    const subject = invocationSubject(node);
    const invocationId = invocationIdForNode(context, node);
    events.emit({
      type: "invocation.created",
      workId: context.workId,
      runId: context.runId,
      invocationId,
      planNodeId: node.nodeId,
      subject,
      ...taskIdCompatibility(subject),
      kind: invocationKind(node),
      label: invocationTaskId(node),
      ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
      siblingOrder,
      dependencyIds: dependencyInvocationIds(context, compiled, node),
    });
    if (node.dependsOn.length > 0) {
      events.emit({
        type: "invocation.progress",
        workId: context.workId,
        runId: context.runId,
        invocationId,
        state: "waiting",
        phase: "dependencies",
        waitingReason: "Waiting for dependencies",
        dependencyIds: dependencyInvocationIds(context, compiled, node),
      });
    }
    if (node.type === "choice") {
      for (const [armOrder, arm] of [node.then, node.else].entries()) {
        const armSubject = invocationSubject(arm);
        events.emit({
          type: "invocation.created",
          workId: context.workId,
          runId: context.runId,
          invocationId: invocationIdForNode(context, arm),
          planNodeId: arm.nodeId,
          subject: armSubject,
          ...taskIdCompatibility(armSubject),
          kind: invocationKind(arm),
          label: invocationTaskId(arm),
          parentInvocationId: invocationId,
          siblingOrder: armOrder,
          dependencyIds: dependencyInvocationIds(context, compiled, arm),
        });
      }
    }
  }
}

function emitMastraNonTerminalInvocations(
  compiled: CompiledMastraPlan,
  prepared: PreparedPlanExecution,
  result: MastraWorkflowResult,
  events: SeqlaneEventSink,
): void {
  const workflowCancelled =
    result.status === "canceled" || result.status === "cancelled";
  for (const node of compiled.orderedNodes) {
    const status = result.steps?.[node.nodeId]?.status;
    const skippedAfterFailure =
      result.status === "failed" && status === undefined;
    const cancelledBeforeTerminal =
      workflowCancelled &&
      (status === undefined ||
        status === "skipped" ||
        status === "canceled" ||
        status === "cancelled");
    if (
      !skippedAfterFailure &&
      !cancelledBeforeTerminal &&
      status !== "skipped" &&
      status !== "canceled" &&
      status !== "cancelled"
    ) {
      continue;
    }

    const invocationId = invocationIdForNode(prepared.context, node);
    if (cancelledBeforeTerminal) {
      events.emit({
        type: "invocation.cancelled",
        workId: prepared.context.workId,
        runId: prepared.context.runId,
        invocationId,
        reason: "Mastra cancelled invocation before execution completed",
      });
    } else if (status === "skipped" || skippedAfterFailure) {
      events.emit({
        type: "invocation.skipped",
        workId: prepared.context.workId,
        runId: prepared.context.runId,
        invocationId,
        reason: skippedAfterFailure
          ? "Mastra did not execute invocation after an upstream failure"
          : "Mastra skipped invocation after an upstream failure",
        dependencyIds: dependencyInvocationIds(
          prepared.context,
          compiled,
          node,
        ),
      });
    } else {
      events.emit({
        type: "invocation.cancelled",
        workId: prepared.context.workId,
        runId: prepared.context.runId,
        invocationId,
        reason: "Mastra cancelled invocation",
      });
    }
  }
}

interface InvocationDispatchOptions {
  readonly context: ExecutionContext;
  readonly node: PlanNode;
  readonly input: unknown;
  readonly workflowInput: unknown;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly resourceId?: string;
  readonly requestContext: RequestContext | undefined;
  readonly getStepResult: (nodeId: string) => unknown;
  readonly abortSignal: AbortSignal;
  readonly invocationId: InvocationId;
  readonly observability: MastraPlanInvocationContext["observability"];
  readonly iteration?: number;
  readonly repeatValidation?: RepeatNode["validation"];
  readonly choiceValidation?: MastraPlanInvocationContext["choiceValidation"];
  readonly dynamicWorkspaceAdmission?: boolean;
}

async function validateInvocationOutput(
  options: InvocationDispatchOptions,
  output: unknown,
): Promise<void> {
  const validation = options.choiceValidation ?? options.repeatValidation;
  if (validation === undefined) return;
  await validateRepeatOutput(
    options.context,
    options.node,
    output,
    validation,
    options.abortSignal,
    {
      invocationId: options.invocationId,
      observability: options.observability,
      ...(options.iteration === undefined
        ? {}
        : { iteration: options.iteration }),
    },
  );
}

async function executeTaskInvocation(
  options: InvocationDispatchOptions,
  repeatAttemptNodeIds: ReadonlySet<string>,
): Promise<unknown> {
  if (options.node.type !== "task") {
    throw new Error("Task handler received a non-task Plan node");
  }
  if (
    options.node.session !== undefined &&
    repeatAttemptNodeIds.has(options.node.nodeId)
  ) {
    await resolveTaskSession(
      options.context.resolvedSessions,
      options.context.sessionResolver,
      options.context.taskDefinitions,
      options.invocationId,
      options.node.taskId,
      options.context.effectiveModelSelectionsByNode.get(options.node.nodeId),
    );
  }
  const output = await executeTaskNode(
    options.context,
    options.node,
    options.abortSignal,
    {
      invocationId: options.invocationId,
      observability: options.observability,
      results: options.context.results,
      remainingConsumers: options.context.remainingConsumers,
      subject: { type: "task", taskId: options.node.taskId },
      iteration: options.iteration,
    },
  );
  await validateInvocationOutput(options, output);
  return output;
}

async function executeWorkflowInvocationNode(
  options: InvocationDispatchOptions,
  executeWorkflowInvocation: MastraPlanInvocation | undefined,
): Promise<unknown> {
  if (options.node.type !== "workflow") {
    throw new Error("Workflow handler received a non-workflow Plan node");
  }
  const workflowId = options.node.workflowId;
  const getStepResult = options.getStepResult as <Output = unknown>(
    nodeId: string,
  ) => Output;
  const output = await executeWorkflowNode(
    options.context,
    options.node,
    options.abortSignal,
    {
      invocationId: options.invocationId,
      observability: options.observability,
      results: options.context.results,
      remainingConsumers: options.context.remainingConsumers,
      workspaceAdmission:
        options.dynamicWorkspaceAdmission || options.iteration !== undefined
          ? "dynamic"
          : "graph",
      execute: async () =>
        executeWorkflowInvocation?.({
          node: options.node,
          input: options.input,
          workflowInput: options.workflowInput,
          workId: options.workId,
          runId: options.runId,
          invocationId: options.invocationId,
          ...(options.resourceId === undefined
            ? {}
            : { resourceId: options.resourceId }),
          workflowId,
          abortSignal: options.abortSignal,
          requestContext: options.requestContext,
          observability: options.observability,
          iteration: options.iteration,
          repeatValidation: options.repeatValidation,
          choiceValidation: options.choiceValidation,
          dynamicWorkspaceAdmission: options.dynamicWorkspaceAdmission,
          getStepResult,
        }) ??
        Promise.reject(
          new Error(
            `Nested workflow "${workflowId}" requires a Mastra workflow handler`,
          ),
        ),
    },
  );
  await validateInvocationOutput(options, output);
  return output;
}

export function createMastraPlanInvocationHandler(
  prepared: PreparedPlanExecution,
  plan: Plan,
  executeWorkflowInvocation?: MastraPlanInvocation,
): MastraPlanInvocation {
  const checks = checkNodes(plan);
  const dynamicSessionNodeIds = new Set(
    plan.nodes.flatMap((entry) =>
      entry.type === "repeat"
        ? [entry.attempt.nodeId]
        : entry.type === "choice"
          ? [entry.then.nodeId, entry.else.nodeId]
          : [],
    ),
  );
  const choiceTaskNodeIds = new Set(
    plan.nodes.flatMap((entry) =>
      entry.type === "choice"
        ? [entry.then, entry.else]
            .filter((arm) => arm.type === "task")
            .map((arm) => arm.nodeId)
        : [],
    ),
  );
  return async ({
    node,
    input,
    workflowInput,
    workId,
    runId,
    resourceId,
    requestContext,
    getStepResult,
    abortSignal,
    invocationId,
    observability,
    iteration,
    repeatValidation,
    choiceValidation,
    dynamicWorkspaceAdmission,
  }) => {
    if (node.type === "choice") {
      throw new Error("Choice node must be lowered through Mastra branch");
    }
    const results = dependencyResults(node, getStepResult);
    const context = {
      ...prepared.context,
      workflowInput,
      results,
      remainingConsumers: new Map(prepared.context.remainingConsumers),
      failure: undefined,
    };
    if (node.type === "task") {
      if (choiceTaskNodeIds.has(node.nodeId)) {
        try {
          await preflightSelectedChoiceModel(prepared, node);
          preflightSelectedChoiceSessionCapabilities(context, node);
          const policy = node.session;
          if (policy?.type === "reuse" || policy?.type === "branch") {
            const consumer = context.sessionConsumers
              .get(policy.from)
              ?.find((entry) => entry.invocationId === invocationId);
            if (consumer === undefined) {
              throw new Error(
                `No session consumer for choice arm "${node.nodeId}"`,
              );
            }
            await materializeDeferredSessionConsumer({
              sourceNodeId: policy.from,
              source: context.deferredSessionSources.get(policy.from),
              consumer: {
                ...consumer,
                effectiveSelection: context.effectiveModelSelectionsByNode.get(
                  node.nodeId,
                ),
              },
              resolvedSessions: context.resolvedSessions,
            });
          }
        } catch (cause) {
          const error = toSeqlaneInvocationError(
            cause,
            "executor",
            node.taskId,
          );
          const subject = invocationSubject(node);
          context.events.emit({
            type: "invocation.started",
            workId,
            runId,
            invocationId,
            subject,
            ...taskIdCompatibility(subject),
          });
          context.events.emit({
            type: "invocation.failed",
            workId,
            runId,
            invocationId,
            error,
            disposition: "fail_run",
          });
          throw error;
        }
      }
      return executeTaskInvocation(
        {
          context,
          node,
          input,
          workflowInput,
          workId,
          runId,
          requestContext,
          getStepResult,
          abortSignal,
          invocationId,
          observability,
          iteration,
          repeatValidation,
          choiceValidation,
          dynamicWorkspaceAdmission,
        },
        dynamicSessionNodeIds,
      );
    }
    if (node.type === "validation.check") {
      return executeValidationCheckNode(context, node, abortSignal, {
        invocationId,
        observability,
        results,
        remainingConsumers: context.remainingConsumers,
      });
    }
    if (node.type === "validation.gate") {
      const check = checks.get(node.checkNodeId);
      if (check === undefined) {
        throw new Error(`Validation gate "${node.nodeId}" has no check node`);
      }
      return executeValidationGateNode(context, node, check, abortSignal, {
        invocationId,
        observability,
        results,
        remainingConsumers: context.remainingConsumers,
      });
    }
    if (node.type === "workflow") {
      return executeWorkflowInvocationNode(
        {
          context,
          node,
          input,
          workflowInput,
          workId,
          runId,
          resourceId,
          requestContext,
          getStepResult,
          abortSignal,
          invocationId,
          observability,
          iteration,
          repeatValidation,
          choiceValidation,
          dynamicWorkspaceAdmission,
        },
        executeWorkflowInvocation,
      );
    }
    throw new Error(
      `Repeat node "${node.nodeId}" must be lowered through Mastra dountil`,
    );
  };
}

export async function executeNestedMastraWorkflow(options: {
  readonly parent: PreparedPlanExecution;
  readonly invocation: MastraPlanInvocationContext;
  readonly child: BuiltWorkflow<unknown, unknown>;
  readonly executors: ExecutorResolvers;
  readonly sessionResolver: SessionResolver;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly events: SeqlaneEventSink;
  readonly onObservation?: MastraPlanExecutionOptions["onObservation"];
  readonly onFailure?: (failure: SeqlaneError) => void;
  readonly repeatBudget?: RepeatExecutionBudget;
}): Promise<unknown> {
  const { invocation, child } = options;
  const childExecution = createMastraPlanExecution({
    plan: child.plan,
    workflowInput: invocation.input,
    workId: invocation.workId,
    runId: invocation.runId,
    createInvocationId: (nodeId) => `${invocation.invocationId}:${nodeId}`,
    executors: options.executors,
    sessionResolver: options.sessionResolver,
    workspaceResources: options.workspaceResources,
    workspaceLocks: options.parent.context.workspaceLocks,
    workspaceOwnerId: invocation.invocationId,
    taskDefinitions: child.taskDefinitions,
    validatorDefinitions: child.validatorDefinitions,
    workflowDefinitions: child.workflowDefinitions,
    workflow: child.workflow,
    events: options.events,
    onObservation: options.onObservation,
    repeatBudget: options.repeatBudget,
  });
  let childRun: ReturnType<typeof childExecution.runtime.start> | undefined;
  let succeeded = false;
  let result: unknown;
  let failed = false;
  let failure: unknown;
  const cancelChild = (): void => {
    void childRun?.cancel().catch(() => undefined);
  };
  try {
    preflightCompiledWorkflowSessionCapabilities(childExecution.prepared);
    await preflightCompiledWorkflowModels(childExecution.prepared);
    await resolveCompiledWorkflowSessions(childExecution.prepared);
    emitMastraInvocationTopology(
      childExecution.compiled,
      childExecution.prepared,
      options.events,
      invocation.invocationId,
    );
    childRun = childExecution.runtime.start(
      {
        workflowKey: childExecution.compiled.key,
        input: invocation.input,
        workId: invocation.workId,
        runId: invocation.runId,
      },
      nestedRunContext(invocation.requestContext, invocation.abortSignal),
    );
    if (invocation.abortSignal.aborted) cancelChild();
    else
      invocation.abortSignal.addEventListener("abort", cancelChild, {
        once: true,
      });
    const childOutcome = await childRun.outcome;
    if (childOutcome.status === "succeeded") {
      succeeded = true;
      result = childOutcome.result;
    } else if (childOutcome.status === "failed") {
      if (childOutcome.error instanceof SeqlaneError)
        options.onFailure?.(childOutcome.error);
      throw childOutcome.error;
    } else {
      throw (
        invocation.abortSignal.reason ?? new Error("Nested workflow cancelled")
      );
    }
  } catch (cause) {
    failed = true;
    failure = cause;
  }
  invocation.abortSignal.removeEventListener("abort", cancelChild);
  try {
    await childExecution.runtime.shutdown();
  } catch (cause) {
    if (succeeded) throw cause;
  }
  if (failed) throw failure;
  return result;
}

export function createMastraPlanExecution(
  options: MastraPlanExecutionOptions,
): MastraPlanExecution {
  const repeatBudget = options.repeatBudget ?? { executed: 0 };
  let typedFailure: SeqlaneError | undefined;
  const captureFailure = (failure: SeqlaneError): void => {
    typedFailure ??= failure;
  };
  const workspaceResources = workspaceResourcesForExecution(
    options.workspaceResources,
    options.workflowDefinitions,
  );
  const prepared = new PlanCompiler().prepareWorkflow(options.plan, {
    workId: options.workId,
    runId: options.runId,
    createInvocationId: (nodeId) => options.createInvocationId(nodeId),
    workflowInput: options.workflowInput,
    executors: options.executors,
    sessionResolver: options.sessionResolver,
    workspaceResources,
    workspaceLocks: options.workspaceLocks,
    workspaceOwnerId: options.workspaceOwnerId,
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    workflowDefinitions: options.workflowDefinitions,
    events: options.events,
    onObservation: (invocationId, observation, iteration) =>
      forwardObservation(
        options.onObservation,
        options.workId,
        options.runId,
        invocationId,
        observation,
        iteration,
      ),
    classifier: options.classifier,
  });
  const executeInvocation = createMastraPlanInvocationHandler(
    prepared,
    options.plan,
  );
  const compiled = compilePlanToMastra(options.plan, {
    workId: options.workId,
    runId: options.runId,
    createInvocationId: (nodeId) => {
      const invocationId = prepared.context.invocationIds.get(nodeId);
      if (invocationId === undefined) {
        throw new Error(`No Invocation ID allocated for Plan node "${nodeId}"`);
      }
      return invocationId;
    },
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    workflowDefinitions: options.workflowDefinitions,
    workspaceResources,
    workflow: options.workflow,
    repeatBudget,
    events: options.events,
    onFailure: captureFailure,
    onInputValidationFailure: ({
      node,
      workId,
      runId,
      invocationId,
      error,
    }) => {
      const subject = invocationSubject(node);
      options.events.emit({
        type: "invocation.started",
        workId,
        runId,
        invocationId,
        subject,
        ...taskIdCompatibility(subject),
      });
      options.events.emit({
        type: "invocation.failed",
        workId,
        runId,
        invocationId,
        error,
        disposition: "fail_run",
      });
    },
    executeWorkflowInvocation: async (
      invocation: MastraPlanInvocationContext,
    ): Promise<unknown> => {
      if (invocation.node.type !== "workflow") {
        throw new Error("Workflow handler received a non-workflow Plan node");
      }
      const child = options.workflowDefinitions?.get(
        invocation.node.workflowId,
      );
      if (child === undefined) {
        throw new Error(
          `No nested workflow definition registered for "${invocation.node.workflowId}"`,
        );
      }
      return executeWorkflowNode(
        prepared.context,
        invocation.node,
        invocation.abortSignal,
        {
          invocationId: invocation.invocationId,
          observability: invocation.observability,
          results: prepared.context.results,
          remainingConsumers: prepared.context.remainingConsumers,
          // Repeat attempts are admitted at runtime. Their child workflow can
          // have several resources, and the set is not represented by the
          // parent graph's static edge for each new attempt.
          workspaceAdmission:
            invocation.dynamicWorkspaceAdmission ||
            invocation.iteration !== undefined
              ? "dynamic"
              : "graph",
          execute: () =>
            executeNestedMastraWorkflow({
              parent: prepared,
              invocation,
              child,
              executors: options.executors,
              sessionResolver: options.sessionResolver,
              workspaceResources,
              events: options.events,
              onObservation: options.onObservation,
              onFailure: captureFailure,
              repeatBudget,
            }),
        },
      );
    },
    executeInvocation: async (invocation) => {
      try {
        return await executeInvocation(invocation);
      } catch (cause) {
        if (cause instanceof SeqlaneError) captureFailure(cause);
        throw cause;
      }
    },
  });

  return {
    prepared,
    compiled,
    runtime: createMastraRuntime(
      [{ key: compiled.key, workflow: compiled.workflow }],
      {
        exposeServer: false,
        failureForRun: () => typedFailure,
        onWorkflowResult: (_request, result) => {
          emitMastraNonTerminalInvocations(
            compiled,
            prepared,
            result,
            options.events,
          );
        },
      },
    ),
  };
}
