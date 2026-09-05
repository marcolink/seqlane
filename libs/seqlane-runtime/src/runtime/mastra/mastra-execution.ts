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
} from "@seqlane/core";
import { SeqlaneError } from "@seqlane/core";
import {
  compilePlanToMastra,
  type CompiledMastraPlan,
} from "../compile/mastra-plan-compiler.js";
import { PlanCompiler, type CompiledPlan } from "../compile/compile-plan.js";
import {
  executeTaskNode,
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
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly events: SeqlaneEventSink;
}

export interface MastraPlanExecution {
  readonly prepared: CompiledPlan;
  readonly compiled: CompiledMastraPlan;
  readonly runtime: MastraRuntime;
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
  context: CompiledPlan["context"],
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
  prepared: CompiledPlan,
  events: SeqlaneEventSink,
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
  prepared: CompiledPlan,
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

export function createMastraPlanExecution(
  options: MastraPlanExecutionOptions,
): MastraPlanExecution {
  let typedFailure: SeqlaneError | undefined;
  const captureFailure = (failure: SeqlaneError): void => {
    typedFailure ??= failure;
  };
  const prepared = new PlanCompiler().compileWorkflow(options.plan, {
    workId: options.workId,
    runId: options.runId,
    createInvocationId: (nodeId) => options.createInvocationId(nodeId),
    workflowInput: options.workflowInput,
    executors: options.executors,
    sessionResolver: options.sessionResolver,
    workspaceResources: options.workspaceResources,
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    events: options.events,
  });
  const checks = checkNodes(options.plan);
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
    workspaceResources: options.workspaceResources,
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
    executeInvocation: async ({
      node,
      getStepResult,
      abortSignal,
      invocationId,
    }) => {
      try {
        const results = dependencyResults(node, getStepResult);
        const context = {
          ...prepared.context,
          results,
          remainingConsumers: new Map(prepared.context.remainingConsumers),
          failure: undefined,
        };
        if (node.type === "task") {
          return await executeTaskNode(context, node, abortSignal, {
            invocationId,
            results,
            remainingConsumers: context.remainingConsumers,
            subject: { type: "task", taskId: node.taskId },
          });
        }
        if (node.type === "validation.check") {
          return await executeValidationCheckNode(context, node, abortSignal, {
            invocationId,
            results,
            remainingConsumers: context.remainingConsumers,
          });
        }
        if (node.type === "validation.gate") {
          const check = checks.get(node.checkNodeId);
          if (check === undefined) {
            throw new Error(
              `Validation gate "${node.nodeId}" has no check node`,
            );
          }
          return await executeValidationGateNode(
            context,
            node,
            check,
            abortSignal,
            {
              invocationId,
              results,
              remainingConsumers: context.remainingConsumers,
            },
          );
        }
        return await executeRepeatNode(context, node, abortSignal);
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
