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
} from "@seqlane/core";
import {
  compilePlanToMastra,
  type CompiledMastraPlan,
} from "../compile/mastra-plan-compiler.js";
import {
  EffectCompiler,
  type CompiledWorkflow,
} from "../compile/compile-plan.js";
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
import { createMastraRuntime, type MastraRuntime } from "./mastra-runtime.js";
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
  readonly events: SeqlaneEventSink;
}

export interface MastraPlanExecution {
  readonly legacy: CompiledWorkflow;
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

export function emitMastraInvocationTopology(
  compiled: CompiledMastraPlan,
  legacy: CompiledWorkflow,
  events: SeqlaneEventSink,
): void {
  const { context } = legacy;
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
      dependencyIds: node.dependsOn.flatMap((dependency) => {
        const dependencyNode = compiled.orderedNodes.find(
          ({ nodeId }) => nodeId === dependency,
        );
        return dependencyNode === undefined
          ? []
          : [invocationIdForNode(context, dependencyNode)];
      }),
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
        dependencyIds: node.dependsOn.flatMap((dependency) => {
          const dependencyNode = compiled.orderedNodes.find(
            ({ nodeId }) => nodeId === dependency,
          );
          return dependencyNode === undefined
            ? []
            : [invocationIdForNode(context, dependencyNode)];
        }),
      });
    }
  }
}

export function createMastraPlanExecution(
  options: MastraPlanExecutionOptions,
): MastraPlanExecution {
  const legacy = new EffectCompiler().compileWorkflow(options.plan, {
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
      const invocationId = legacy.context.invocationIds.get(nodeId);
      if (invocationId === undefined) {
        throw new Error(`No Invocation ID allocated for Plan node "${nodeId}"`);
      }
      return invocationId;
    },
    taskDefinitions: options.taskDefinitions,
    validatorDefinitions: options.validatorDefinitions,
    workspaceResources: options.workspaceResources,
    executeInvocation: async ({
      node,
      getStepResult,
      abortSignal,
      invocationId,
    }) => {
      const results = dependencyResults(node, getStepResult);
      const context = {
        ...legacy.context,
        results,
        remainingConsumers: new Map(legacy.context.remainingConsumers),
        failure: undefined,
      };
      if (node.type === "task") {
        return executeTaskNode(context, node, abortSignal, {
          invocationId,
          results,
          remainingConsumers: context.remainingConsumers,
          subject: { type: "task", taskId: node.taskId },
        });
      }
      if (node.type === "validation.check") {
        return executeValidationCheckNode(context, node, abortSignal, {
          invocationId,
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
          results,
          remainingConsumers: context.remainingConsumers,
        });
      }
      return executeRepeatNode(context, node, abortSignal);
    },
  });

  return {
    legacy,
    compiled,
    runtime: createMastraRuntime([
      { key: compiled.key, workflow: compiled.workflow },
    ]),
  };
}
