import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { AnyWorkflow, Step } from "@mastra/core/workflows";
import type {
  InvocationId,
  Plan,
  PlanNode,
  PlanNodeId,
  RunId,
  SeqlaneSchema,
  TaskDefinitionRegistry,
  ValidatorDefinitionRegistry,
  WorkId,
  WorkflowDefinition,
} from "@seqlane/core";
import { z } from "zod";
import {
  resolveBinding,
  referencedNodeIds,
  WORKFLOW_INPUT_NODE_ID,
} from "../plan/binding-resolution.js";
import { getTaskSchema, type TaskSchemaRegistry } from "../plan/task-schema.js";
import { orderPlanNodes } from "../plan/plan-ordering.js";
import { validatePlan } from "../validation/plan-validation.js";
import {
  lowerReuseSessionOrdering,
  withLoweredPlanNodes,
} from "../session/session-ordering.js";
import {
  lowerWorkspaceOrdering,
  workspaceAccessForPlanNode,
} from "../workspace/workspace-ordering.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";

const RESULT_STEP_ID = "__seqlane_result";
const RESERVED_NODE_IDS = new Set([WORKFLOW_INPUT_NODE_ID, RESULT_STEP_ID]);

export interface MastraPlanInvocationContext {
  readonly node: PlanNode;
  readonly input: unknown;
  readonly workflowInput: unknown;
  readonly workId: WorkId;
  readonly runId: string;
  readonly invocationId: InvocationId;
  readonly resourceId?: string;
  readonly workflowId: string;
  readonly abortSignal: AbortSignal;
  readonly getStepResult: <Output = unknown>(nodeId: string) => Output;
}

export type MastraPlanInvocation = (
  context: MastraPlanInvocationContext,
) => Promise<unknown>;

export interface MastraPlanCompilerOptions {
  /** The Seqlane schemas used to validate workflow input and output. */
  readonly workflow?: Pick<WorkflowDefinition, "input" | "output">;
  readonly workflowInputSchema?: SeqlaneSchema;
  readonly workflowOutputSchema?: SeqlaneSchema;
  readonly taskDefinitions?: TaskDefinitionRegistry;
  readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  readonly taskSchemas?: TaskSchemaRegistry;
  /** Resolved runtime workspace identities used for static conflict lowering. */
  readonly workspaceResources?: WorkspaceResourceRegistry;
  /** Correlation identities allocated for this workflow run. */
  readonly workId?: WorkId;
  readonly runId?: RunId;
  readonly createInvocationId?: (nodeId: PlanNodeId) => InvocationId;
  /**
   * Executes one already-bound Seqlane invocation. Agent, shell, session, and
   * workspace behavior stays in later private runtime slices.
   */
  readonly executeInvocation?: MastraPlanInvocation;
}

export interface MastraPlanStep {
  readonly nodeId: string;
  readonly step: Step;
}

export interface CompiledMastraPlan {
  readonly key: string;
  readonly plan: Plan;
  readonly orderedNodes: readonly PlanNode[];
  readonly invocationSteps: readonly MastraPlanStep[];
  readonly resultStep: Step;
  readonly workflow: AnyWorkflow;
  readonly invocationIds: ReadonlyMap<PlanNodeId, InvocationId>;
}

function schemaForMastra(schema: SeqlaneSchema | undefined): z.ZodType {
  if (schema !== undefined) {
    // Zod 4 and other Standard Schema implementations already satisfy the
    // Mastra schema contract. Preserve those schemas instead of reducing them
    // to an opaque predicate. The cast is isolated at this integration edge.
    if (
      typeof schema === "object" &&
      schema !== null &&
      "~standard" in schema
    ) {
      return schema as unknown as z.ZodType;
    }
  }

  return z.custom((value) => {
    try {
      schema?.parse(value);
      return true;
    } catch {
      return false;
    }
  });
}

function schemaForNodeInput(
  node: PlanNode,
  options: MastraPlanCompilerOptions,
): SeqlaneSchema | undefined {
  if (node.type === "task") {
    return getTaskSchema(
      options.taskSchemas,
      node.taskId,
      options.taskDefinitions,
    ).input;
  }

  if (node.type === "validation.check") {
    if (node.source.type === "mechanical") {
      return options.validatorDefinitions?.get(node.source.validatorId)?.input;
    }
    return getTaskSchema(
      options.taskSchemas,
      node.source.taskId,
      options.taskDefinitions,
    ).input;
  }

  return undefined;
}

function schemaForNodeOutput(
  node: PlanNode,
  options: MastraPlanCompilerOptions,
): SeqlaneSchema | undefined {
  if (node.type === "task") {
    return getTaskSchema(
      options.taskSchemas,
      node.taskId,
      options.taskDefinitions,
    ).output;
  }

  if (node.type === "validation.check" && node.source.type === "task") {
    return getTaskSchema(
      options.taskSchemas,
      node.source.taskId,
      options.taskDefinitions,
    ).output;
  }

  return undefined;
}

function invocationKind(node: PlanNode): "task" | "validation" | "loop" {
  if (node.type === "repeat") return "loop";
  if (node.type === "task") return "task";
  return "validation";
}

function nodeLayers(orderedNodes: readonly PlanNode[]): readonly PlanNode[][] {
  const layers: PlanNode[][] = [];
  const layerByNodeId = new Map<string, number>();

  for (const node of orderedNodes) {
    const layer = node.dependsOn.reduce(
      (highest, dependency) =>
        Math.max(highest, (layerByNodeId.get(dependency) ?? 0) + 1),
      0,
    );
    layerByNodeId.set(node.nodeId, layer);
    (layers[layer] ??= []).push(node);
  }

  return layers;
}

function resolveStepInput(
  node: PlanNode,
  workflowInput: unknown,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
): unknown {
  const results = new Map<string, unknown>();
  for (const nodeId of referencedNodeIds(node.input)) {
    if (nodeId === "__seqlane_input") continue;
    results.set(nodeId, getStepResult(nodeId));
  }
  return resolveBinding(node.input, workflowInput, results);
}

function buildInvocationStep(
  node: PlanNode,
  invocationId: InvocationId,
  options: MastraPlanCompilerOptions,
): Step {
  const inputSchema = schemaForNodeInput(node, options);
  const outputSchema = schemaForNodeOutput(node, options);
  const step = createStep({
    id: node.nodeId,
    description: `Seqlane ${invocationKind(node)} invocation ${node.nodeId}`,
    // The graph transports the preceding layer as input. The typed Seqlane
    // binding is resolved and parsed below, before the invocation callback.
    inputSchema: z.unknown(),
    outputSchema: schemaForMastra(outputSchema),
    metadata: {
      seqlane: {
        planNodeId: node.nodeId,
        invocationId,
        invocationKind: invocationKind(node),
        ...(node.type === "task" ? { taskId: node.taskId } : {}),
        dependsOn: [...node.dependsOn],
        ...(inputSchema === undefined ? {} : { typedInput: true }),
        ...(outputSchema === undefined ? {} : { typedOutput: true }),
        ...(workspaceAccessForPlanNode(node, options.workspaceResources) ===
        undefined
          ? {}
          : {
              workspace: workspaceAccessForPlanNode(
                node,
                options.workspaceResources,
              ),
            }),
      },
    },
    execute: async ({
      getInitData,
      getStepResult,
      runId,
      resourceId,
      workflowId,
      abortSignal,
    }) => {
      const workflowInput = getInitData<unknown>();
      const resolvedInput = resolveStepInput(
        node,
        workflowInput,
        getStepResult,
      );
      const parsedInput = inputSchema?.parse(resolvedInput) ?? resolvedInput;
      if (options.executeInvocation === undefined) {
        throw new Error(
          `No Mastra invocation handler is configured for Plan node "${node.nodeId}"`,
        );
      }

      const rawOutput = await options.executeInvocation({
        node,
        input: parsedInput,
        workflowInput,
        workId: resourceId ?? options.workId ?? "unknown-work",
        runId,
        invocationId,
        ...(resourceId === undefined ? {} : { resourceId }),
        workflowId,
        abortSignal,
        getStepResult,
      });
      return outputSchema?.parse(rawOutput) ?? rawOutput;
    },
  });

  return step;
}

function assertMastraSupportedPlan(plan: Plan): void {
  for (const node of plan.nodes) {
    if (RESERVED_NODE_IDS.has(node.nodeId)) {
      throw new Error(
        `Mastra Plan compiler does not support reserved node ID "${node.nodeId}"`,
      );
    }
  }

  const repeat = plan.nodes.find((node) => node.type === "repeat");
  if (repeat?.type === "repeat") {
    throw new Error(
      `Mastra Plan compiler does not support repeat node "${repeat.nodeId}"`,
    );
  }
}

function assertValidationRegistries(
  plan: Plan,
  options: MastraPlanCompilerOptions,
): void {
  for (const node of plan.nodes) {
    if (node.type !== "validation.check") continue;

    if (node.source.type === "mechanical") {
      if (!options.validatorDefinitions?.has(node.source.validatorId)) {
        throw new Error(
          `No validator "${node.source.validatorId}" is registered`,
        );
      }
    } else if (!options.taskDefinitions?.has(node.source.taskId)) {
      throw new Error(
        `No evaluator task definition registered for "${node.source.taskId}"`,
      );
    }
  }
}

export function compilePlanToMastra(
  plan: Plan,
  options: MastraPlanCompilerOptions = {},
): CompiledMastraPlan {
  assertMastraSupportedPlan(plan);
  validatePlan(plan, options.taskDefinitions);
  assertValidationRegistries(plan, options);
  const orderedNodes = lowerWorkspaceOrdering(
    lowerReuseSessionOrdering(
      orderPlanNodes(plan, true, options.taskDefinitions),
    ),
    options.workspaceResources,
  );
  const loweredPlan = withLoweredPlanNodes(plan, orderedNodes);
  const invocationIds = new Map<PlanNodeId, InvocationId>();
  for (const node of orderedNodes) {
    invocationIds.set(
      node.nodeId,
      options.createInvocationId?.(node.nodeId) ??
        `${plan.workflow.id}:${node.nodeId}`,
    );
  }
  const invocationSteps = orderedNodes.map((node) => {
    const invocationId = invocationIds.get(node.nodeId);
    if (invocationId === undefined) {
      throw new Error(
        `No Invocation ID allocated for Plan node "${node.nodeId}"`,
      );
    }
    return {
      nodeId: node.nodeId,
      step: buildInvocationStep(node, invocationId, options),
    };
  });
  const stepsByNodeId = new Map(
    invocationSteps.map(({ nodeId, step }) => [nodeId, step]),
  );

  const workflowInputSchema = schemaForMastra(
    options.workflowInputSchema ?? options.workflow?.input,
  );
  const workflowOutputSchema = schemaForMastra(
    options.workflowOutputSchema ?? options.workflow?.output,
  );
  const resultStep = createStep({
    id: RESULT_STEP_ID,
    description: "Resolve the Seqlane workflow output binding",
    inputSchema: z.unknown(),
    outputSchema: workflowOutputSchema,
    metadata: {
      seqlane: {
        kind: "workflow-output",
        binding: plan.output,
        dependsOn: [...orderedNodes.map(({ nodeId }) => nodeId)],
      },
    },
    execute: async ({ getInitData, getStepResult }) => {
      const workflowInput = getInitData<unknown>();
      const results = new Map<string, unknown>();
      for (const node of orderedNodes) {
        results.set(node.nodeId, getStepResult(node.nodeId));
      }
      const output = resolveBinding(plan.output, workflowInput, results);
      return (
        options.workflow?.output?.parse(output) ??
        options.workflowOutputSchema?.parse(output) ??
        output
      );
    },
  });

  let workflow: AnyWorkflow = createWorkflow({
    id: plan.workflow.id,
    inputSchema: workflowInputSchema,
    outputSchema: workflowOutputSchema,
  }) as AnyWorkflow;

  for (const layer of nodeLayers(orderedNodes)) {
    const layerSteps = layer.flatMap((node) => {
      const step = stepsByNodeId.get(node.nodeId);
      return step === undefined ? [] : [step];
    });
    if (layerSteps.length === 1) {
      const [step] = layerSteps;
      if (step !== undefined) workflow = workflow.then(step);
    } else if (layerSteps.length > 1) {
      workflow = workflow.parallel(layerSteps);
    }
  }

  workflow = workflow.then(resultStep);

  return {
    key: plan.workflow.id,
    plan: loweredPlan,
    orderedNodes,
    invocationSteps,
    resultStep,
    workflow: workflow.commit(),
    invocationIds,
  };
}

export function compileBuiltWorkflowToMastra(
  built: {
    readonly plan: Plan;
    readonly workflow: Pick<WorkflowDefinition, "input" | "output">;
    readonly taskDefinitions?: TaskDefinitionRegistry;
    readonly validatorDefinitions?: ValidatorDefinitionRegistry;
  },
  options: Omit<
    MastraPlanCompilerOptions,
    "workflow" | "taskDefinitions" | "validatorDefinitions"
  > = {},
): CompiledMastraPlan {
  return compilePlanToMastra(built.plan, {
    ...options,
    workflow: built.workflow,
    taskDefinitions: built.taskDefinitions,
    validatorDefinitions: built.validatorDefinitions,
  });
}
