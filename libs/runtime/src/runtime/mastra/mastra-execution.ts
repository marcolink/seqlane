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
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
} from "@seqlane/core";
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
import { invocationIdForNode } from "../execution/context.js";
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
import type { ExecutorResolvers } from "../execution/executor.js";
import type { SessionResolver } from "../session/session-resolution.js";
import type {
  WorkspaceResource,
  WorkspaceResourceRegistry,
} from "../workspace/workspace-resource.js";
import type { WorkspaceLockRegistry } from "../workspace/workspace-lock.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";
import { resolveTaskSession } from "../session/session-resolution.js";

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
  readonly repeatBudget?: RepeatExecutionBudget;
}

export interface MastraPlanExecution {
  readonly prepared: PreparedPlanExecution;
  readonly compiled: CompiledMastraPlan;
  readonly runtime: MastraRuntime;
}

export function workspaceResourcesForExecution(
  resources: WorkspaceResourceRegistry,
  workflows: WorkflowDefinitionRegistry | undefined,
): WorkspaceResourceRegistry {
  if (workflows === undefined || workflows.size === 0) return resources;
  const extended = new Map(resources);
  const aggregate = (
    workflowId: string,
    workflow: BuiltWorkflow<unknown, unknown>,
    visiting: ReadonlySet<string>,
  ): readonly WorkspaceResource[] => {
    if (visiting.has(workflowId)) return [];
    const nextVisiting = new Set(visiting).add(workflowId);
    const found = new Map<string, WorkspaceResource>();
    for (const node of workflow.plan.nodes) {
      const id =
        node.type === "task"
          ? node.taskId
          : node.type === "workflow"
            ? node.workflowId
            : node.type === "validation.check" && node.source.type === "task"
              ? node.source.taskId
              : undefined;
      if (id === undefined) continue;
      const nested = node.type === "workflow" ? workflows.get(id) : undefined;
      const resource =
        nested === undefined
          ? [extended.get(id)]
          : aggregate(id, nested, nextVisiting);
      for (const candidate of resource) {
        if (candidate !== undefined) found.set(candidate.key, candidate);
      }
    }
    return [...found.values()];
  };
  for (const [workflowId, workflow] of workflows) {
    const childResources = aggregate(workflowId, workflow, new Set());
    if (childResources.length > 0) {
      extended.set(workflowId, {
        key: childResources.map(({ key }) => key).join("|") || workflowId,
        resources: childResources,
      });
    }
  }
  return extended;
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
  node: PlanNode,
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
  context: PreparedPlanExecution["context"],
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

export function emitMastraInvocationTopology(
  compiled: CompiledMastraPlan,
  prepared: PreparedPlanExecution,
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

export function createMastraPlanInvocationHandler(
  prepared: PreparedPlanExecution,
  plan: Plan,
  executeWorkflowInvocation?: MastraPlanInvocation,
): MastraPlanInvocation {
  const checks = checkNodes(plan);
  const repeatAttemptNodeIds = new Set(
    plan.nodes.flatMap((entry) =>
      entry.type === "repeat" ? [entry.attempt.nodeId] : [],
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
  }) => {
    const results = dependencyResults(node, getStepResult);
    const context = {
      ...prepared.context,
      results,
      remainingConsumers: new Map(prepared.context.remainingConsumers),
      failure: undefined,
    };
    if (node.type === "task") {
      if (node.session !== undefined && repeatAttemptNodeIds.has(node.nodeId)) {
        await resolveTaskSession(
          prepared.context.resolvedSessions,
          prepared.context.sessionResolver,
          prepared.context.taskDefinitions,
          invocationId,
          node.taskId,
          prepared.context.effectiveModelSelectionsByNode.get(node.nodeId),
        );
      }
      return executeTaskNode(context, node, abortSignal, {
        invocationId,
        observability,
        results,
        remainingConsumers: context.remainingConsumers,
        subject: { type: "task", taskId: node.taskId },
      });
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
      return executeWorkflowNode(context, node, abortSignal, {
        invocationId,
        observability,
        results,
        remainingConsumers: prepared.context.remainingConsumers,
        workspaceAdmission: "graph",
        execute: async () =>
          executeWorkflowInvocation?.({
            node,
            input,
            workflowInput,
            workId,
            runId,
            invocationId,
            ...(resourceId === undefined ? {} : { resourceId }),
            workflowId: node.workflowId,
            abortSignal,
            requestContext,
            observability,
            getStepResult,
          }) ??
          Promise.reject(
            new Error(
              `Nested workflow "${node.workflowId}" requires a Mastra workflow handler`,
            ),
          ),
      });
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
    repeatBudget: options.repeatBudget,
  });
  preflightCompiledWorkflowSessionCapabilities(childExecution.prepared);
  await preflightCompiledWorkflowModels(childExecution.prepared);
  await resolveCompiledWorkflowSessions(childExecution.prepared);
  emitMastraInvocationTopology(
    childExecution.compiled,
    childExecution.prepared,
    options.events,
    invocation.invocationId,
  );
  const childRun = childExecution.runtime.start(
    {
      workflowKey: childExecution.compiled.key,
      input: invocation.input,
      workId: invocation.workId,
      runId: invocation.runId,
    },
    nestedRunContext(invocation.requestContext, invocation.abortSignal),
  );
  const cancelChild = (): void => {
    void childRun.cancel().catch(() => undefined);
  };
  if (invocation.abortSignal.aborted) cancelChild();
  else
    invocation.abortSignal.addEventListener("abort", cancelChild, {
      once: true,
    });
  try {
    const result = await childRun.outcome;
    if (result.status === "succeeded") return result.result;
    if (result.status === "failed") {
      if (result.error instanceof SeqlaneError)
        options.onFailure?.(result.error);
      throw result.error;
    }
    throw (
      invocation.abortSignal.reason ?? new Error("Nested workflow cancelled")
    );
  } finally {
    invocation.abortSignal.removeEventListener("abort", cancelChild);
  }
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
          workspaceAdmission: "graph",
          execute: async () => {
            const childExecution = createMastraPlanExecution({
              plan: child.plan,
              workflowInput: invocation.input,
              workId: invocation.workId,
              runId: invocation.runId,
              createInvocationId: (nodeId) =>
                `${invocation.invocationId}:${nodeId}`,
              executors: options.executors,
              sessionResolver: options.sessionResolver,
              workspaceResources,
              workspaceLocks: prepared.context.workspaceLocks,
              workspaceOwnerId: invocation.invocationId,
              taskDefinitions: child.taskDefinitions,
              validatorDefinitions: child.validatorDefinitions,
              workflowDefinitions: child.workflowDefinitions,
              workflow: child.workflow,
              events: options.events,
              repeatBudget,
            });
            preflightCompiledWorkflowSessionCapabilities(
              childExecution.prepared,
            );
            await preflightCompiledWorkflowModels(childExecution.prepared);
            await resolveCompiledWorkflowSessions(childExecution.prepared);
            emitMastraInvocationTopology(
              childExecution.compiled,
              childExecution.prepared,
              options.events,
              invocation.invocationId,
            );
            const childRun = childExecution.runtime.start(
              {
                workflowKey: childExecution.compiled.key,
                input: invocation.input,
                workId: invocation.workId,
                runId: invocation.runId,
              },
              nestedRunContext(
                invocation.requestContext,
                invocation.abortSignal,
              ),
            );
            const cancelChild = (): void => {
              void childRun.cancel().catch(() => undefined);
            };
            if (invocation.abortSignal.aborted) cancelChild();
            else
              invocation.abortSignal.addEventListener("abort", cancelChild, {
                once: true,
              });
            try {
              const result = await childRun.outcome;
              if (result.status === "succeeded") return result.result;
              if (result.status === "failed") {
                if (result.error instanceof SeqlaneError) {
                  captureFailure(result.error);
                }
                throw result.error;
              }
              throw (
                invocation.abortSignal.reason ??
                new Error("Nested workflow cancelled")
              );
            } finally {
              invocation.abortSignal.removeEventListener("abort", cancelChild);
            }
          },
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
