import type {
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
import { SeqlaneError } from "@seqlane/core";
import {
  compilePlanToMastra,
  type CompiledMastraPlan,
  type MastraPlanInvocation,
  type MastraPlanInvocationContext,
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
import { executeRepeatNode } from "../invocation/repeat-execution.js";
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
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import { preflightCompiledWorkflowModels } from "../execution/model-preflight.js";
import {
  preflightCompiledWorkflowSessionCapabilities,
  resolveCompiledWorkflowSessions,
} from "../session/session-preflight.js";

export interface MastraPlanExecutionOptions {
  readonly plan: Plan;
  readonly workflowInput: unknown;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly createInvocationId: (nodeId?: string) => InvocationId;
  readonly executors: ExecutorResolvers;
  readonly sessionResolver: SessionResolver;
  readonly workspaceResources: WorkspaceResourceRegistry;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly workflowDefinitions?: WorkflowDefinitionRegistry;
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly events: SeqlaneEventSink;
}

export interface MastraPlanExecution {
  readonly prepared: PreparedPlanExecution;
  readonly compiled: CompiledMastraPlan;
  readonly runtime: MastraRuntime;
}

function workspaceResourcesForExecution(
  resources: WorkspaceResourceRegistry,
  workflows: WorkflowDefinitionRegistry | undefined,
): WorkspaceResourceRegistry {
  if (workflows === undefined || workflows.size === 0) return resources;
  const extended = new Map(resources);
  for (const [workflowId, workflow] of workflows) {
    if (extended.has(workflowId)) continue;
    for (const taskId of workflow.taskDefinitions.keys()) {
      const resource = extended.get(taskId);
      if (resource !== undefined) {
        extended.set(workflowId, resource);
        break;
      }
    }
  }
  return extended;
}

function checkNodes(plan: Plan): Map<string, ValidationCheckNode> {
  return new Map(
    plan.nodes
      .flatMap((node) => (node.type === "repeat" ? node.body.nodes : [node]))
      .filter(
        (node): node is ValidationCheckNode => node.type === "validation.check",
      )
      .map((node) => [node.nodeId, node]),
  );
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
): MastraPlanInvocation {
  const checks = checkNodes(plan);
  return async ({
    node,
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
        execute: async () => {
          throw new Error(
            `Nested workflow "${node.workflowId}" requires a Mastra workflow handler`,
          );
        },
      });
    }
    return executeRepeatNode(context, node, abortSignal, observability);
  };
}

export function createMastraPlanExecution(
  options: MastraPlanExecutionOptions,
): MastraPlanExecution {
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
              taskDefinitions: child.taskDefinitions,
              validatorDefinitions: child.validatorDefinitions,
              workflowDefinitions: child.workflowDefinitions,
              workflow: child.workflow,
              events: options.events,
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
            const childRun = childExecution.runtime.start({
              workflowKey: childExecution.compiled.key,
              input: invocation.input,
              workId: invocation.workId,
              runId: invocation.runId,
            });
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
              if (result.status === "failed") throw result.error;
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
