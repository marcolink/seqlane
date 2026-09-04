import { randomUUID } from "node:crypto";
import type {
  InvocationId,
  Plan,
  PlanNodeId,
  PlanNode,
  RunId,
  TaskDefinitionRegistry,
  SeqlaneEventSink,
  ValidationCheckNode,
  ValidatorDefinitionRegistry,
  WorkId,
} from "@seqlane/core";
import {
  createExecutionContext,
  invocationIdForNode,
  invocationCreationOrdinal,
  type ExecutionContext,
} from "../execution/context.js";
import { type ExecutorRegistry } from "../execution/executor.js";
import { resolveBinding } from "../plan/binding-resolution.js";
import { orderPlanNodes } from "../plan/plan-ordering.js";
import { type TaskSchemaRegistry } from "../plan/task-schema.js";
import { toSeqlaneInvocationError } from "../execution/errors.js";
import {
  createSequentialProgram,
  type SequentialProgram,
  type SequentialProgramStep,
} from "../execution/program.js";
import {
  executeTaskNode,
  executeValidationCheckNode,
  executeValidationGateNode,
} from "../invocation/invocation-execution.js";
import {
  addBindingConsumers,
  consumeBindingReferences,
} from "../invocation/invocation-support.js";
import { executeRepeatNode } from "../invocation/repeat-execution.js";
import type { SessionResolver } from "../session/session-resolution.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import { validatePlan } from "../validation/plan-validation.js";
import {
  lowerReuseSessionOrdering,
  withLoweredPlanNodes,
} from "../session/session-ordering.js";
import { lowerWorkspaceOrdering } from "../workspace/workspace-ordering.js";

export interface PreparedPlan {
  readonly plan: Plan;
  readonly orderedNodes: readonly PlanNode[];
}

export interface CompiledWorkflow {
  readonly plan: Plan;
  readonly orderedNodes: readonly PlanNode[];
  readonly context: ExecutionContext;
  readonly program: SequentialProgram;
}

export interface CompileWorkflowOptions {
  readonly workId?: WorkId;
  readonly runId?: RunId;
  readonly createInvocationId?: (nodeId: PlanNodeId) => InvocationId;
  readonly workflowInput?: unknown;
  readonly executors: ExecutorRegistry;
  readonly sessionResolver?: SessionResolver;
  readonly workspaceResources?: WorkspaceResourceRegistry;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  readonly events?: SeqlaneEventSink;
}

function assertValidationRegistries(
  plan: Plan,
  taskDefinitions: TaskDefinitionRegistry | undefined,
  validatorDefinitions: ValidatorDefinitionRegistry | undefined,
): void {
  const checkNodes = plan.nodes.flatMap((node) => {
    if (node.type === "repeat") return node.body.nodes;
    return [node];
  });
  for (const node of checkNodes) {
    if (node.type !== "validation.check") continue;
    if (node.source.type === "mechanical") {
      if (!validatorDefinitions?.has(node.source.validatorId)) {
        throw new Error(
          `No validator "${node.source.validatorId}" is registered`,
        );
      }
    } else if (!taskDefinitions?.has(node.source.taskId)) {
      throw new Error(
        `No evaluator task definition registered for "${node.source.taskId}"`,
      );
    }
  }
}

function computeRemainingConsumers(plan: Plan): Map<string, number> {
  const remainingConsumers = new Map<string, number>();
  for (const node of plan.nodes) {
    addBindingConsumers(remainingConsumers, node.input);
    if (node.type === "validation.gate") {
      remainingConsumers.set(
        node.checkNodeId,
        (remainingConsumers.get(node.checkNodeId) ?? 0) + 1,
      );
    }
  }
  addBindingConsumers(remainingConsumers, plan.output);
  return remainingConsumers;
}

export class EffectCompiler {
  /** Prepare a Plan without constructing a workflow. */
  compile(plan: Plan, taskDefinitions?: TaskDefinitionRegistry): PreparedPlan {
    return {
      plan,
      orderedNodes: orderPlanNodes(plan, true, taskDefinitions),
    };
  }

  prepare(plan: Plan): PreparedPlan {
    return this.compile(plan);
  }

  compileWorkflow(
    plan: Plan,
    options: CompileWorkflowOptions,
  ): CompiledWorkflow {
    validatePlan(plan, options.taskDefinitions);
    const prepared = this.compile(plan, options.taskDefinitions);
    const orderedNodes = lowerWorkspaceOrdering(
      lowerReuseSessionOrdering(prepared.orderedNodes),
      options.workspaceResources,
    );
    const loweredPlan = withLoweredPlanNodes(plan, orderedNodes);
    assertValidationRegistries(
      plan,
      options.taskDefinitions,
      options.validatorDefinitions,
    );
    const context = createExecutionContext({
      workId: options.workId ?? `${plan.workflow.id}:work`,
      runId: options.runId ?? `${plan.workflow.id}:run`,
      createInvocationId: options.createInvocationId ?? (() => randomUUID()),
      workflowInput: options.workflowInput,
      executors: options.executors,
      sessionResolver: options.sessionResolver,
      workspaceResources: options.workspaceResources,
      remainingConsumers: computeRemainingConsumers(plan),
      taskDefinitions: options.taskDefinitions,
      validatorDefinitions: options.validatorDefinitions,
      taskSchemas: options.taskSchemas,
      events: options.events,
    });

    for (const node of orderedNodes) {
      const invocationId = context.createInvocationId(node.nodeId);
      context.invocationIds.set(node.nodeId, invocationId);
      invocationCreationOrdinal(context, invocationId);
    }
    const checkNodes = new Map(
      plan.nodes
        .flatMap((node) => {
          if (node.type === "repeat") return node.body.nodes;
          return [node];
        })
        .filter(
          (node): node is ValidationCheckNode =>
            node.type === "validation.check",
        )
        .map((node) => [node.nodeId, node]),
    );
    const steps: SequentialProgramStep[] = [];

    for (const node of orderedNodes) {
      steps.push({
        id: node.nodeId,
        dependsOn: node.dependsOn,
        execute: async ({ abortSignal }) => {
          if (node.type === "repeat") {
            await executeRepeatNode(context, node, abortSignal);
            return { nodeId: node.nodeId };
          }
          if (node.type === "task") {
            await executeTaskNode(context, node, abortSignal, {
              invocationId: invocationIdForNode(context, node),
              results: context.results,
              remainingConsumers: context.remainingConsumers,
              subject: { type: "task", taskId: node.taskId },
              workspaceAdmission: "graph",
            });
          } else if (node.type === "validation.check") {
            await executeValidationCheckNode(context, node, abortSignal, {
              invocationId: invocationIdForNode(context, node),
              results: context.results,
              remainingConsumers: context.remainingConsumers,
              workspaceAdmission: "graph",
            });
          } else {
            const checkNode = checkNodes.get(node.checkNodeId);
            if (!checkNode) {
              throw new Error(
                `Validation gate "${node.nodeId}" has no check node`,
              );
            }
            await executeValidationGateNode(
              context,
              node,
              checkNode,
              abortSignal,
              {
                invocationId: invocationIdForNode(context, node),
                results: context.results,
                remainingConsumers: context.remainingConsumers,
              },
            );
          }
          return { nodeId: node.nodeId };
        },
      });
    }

    steps.push({
      id: "__seqlane_result",
      dependsOn: orderedNodes.map((node) => node.nodeId),
      execute: async () => {
        try {
          context.workflowResult = resolveBinding(
            plan.output,
            context.workflowInput,
            context.results,
          );
          consumeBindingReferences(
            context.results,
            context.remainingConsumers,
            plan.output,
          );
          return { nodeId: "__seqlane_result" };
        } catch (cause) {
          const error = toSeqlaneInvocationError(
            cause,
            "output",
            plan.workflow.id,
          );
          context.failure = error;
          throw error;
        }
      },
    });

    return {
      plan: loweredPlan,
      orderedNodes,
      context,
      program: createSequentialProgram({ steps }),
    };
  }
}

export function compilePlan(plan: Plan): PreparedPlan {
  return new EffectCompiler().compile(plan);
}
