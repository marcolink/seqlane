import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { RequestContext } from "@mastra/core/request-context";
import type { ObservabilityContext } from "@mastra/core/observability";
import type { AnyWorkflow, Step } from "@mastra/core/workflows";
import { SeqlaneError } from "@seqlane/core";
import type {
  InvocationId,
  Plan,
  PlanNode,
  PlanNodeId,
  RunId,
  SeqlaneSchema,
  TaskId,
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
import { orderParsedPlanNodes } from "../plan/plan-ordering.js";
import { validatePlan } from "../validation/plan-validation.js";
import { assertDefinitionRegistries } from "./compile-plan.js";
import {
  lowerReuseSessionOrdering,
  withLoweredPlanNodes,
} from "../session/session-ordering.js";
import {
  lowerWorkspaceOrdering,
  workspaceAccessForPlanNode,
} from "../workspace/workspace-ordering.js";
import type { WorkspaceResourceRegistry } from "../workspace/workspace-resource.js";
import {
  toSeqlaneInvocationError,
  type SeqlaneFailurePhase,
} from "../execution/errors.js";

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
  readonly requestContext?: RequestContext;
  readonly observability: Partial<ObservabilityContext>;
  readonly getStepResult: <Output = unknown>(nodeId: string) => Output;
}

export type MastraPlanInvocation = (
  context: MastraPlanInvocationContext,
) => Promise<unknown>;

export interface MastraPlanInputValidationFailureContext {
  readonly node: PlanNode;
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly invocationId: InvocationId;
  readonly error: SeqlaneError;
}

export interface MastraWorkflowCompletionContext {
  readonly workId: WorkId;
  readonly runId: RunId;
  readonly status: "success" | "failed" | "cancelled";
}

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
  /** Captures typed Seqlane failures before Mastra serializes them. */
  readonly onFailure?: (failure: SeqlaneError) => void;
  /** Reports compiler-level input failures that occur before invocation execution. */
  readonly onInputValidationFailure?: (
    context: MastraPlanInputValidationFailureContext,
  ) => void;
  /** Runs after the compiled workflow reaches a terminal result. */
  readonly onWorkflowComplete?: (
    context: MastraWorkflowCompletionContext,
  ) => void;
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
    // Zod 4 schemas are accepted directly by Mastra. Keep this cast at the
    // private integration edge in case Mastra widens its schema type.
    return schema as unknown as z.ZodType;
  }

  return z.unknown();
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

function taskIdForNode(node: PlanNode): TaskId {
  if (node.type === "task") return node.taskId;
  if (node.type === "validation.check" && node.source.type === "task") {
    return node.source.taskId;
  }
  return node.nodeId;
}

function reportFailure(
  node: PlanNode,
  cause: unknown,
  phase: SeqlaneFailurePhase,
  options: MastraPlanCompilerOptions,
): SeqlaneError {
  const failure = toSeqlaneInvocationError(cause, phase, taskIdForNode(node));
  options.onFailure?.(failure);
  return failure;
}

function reportWorkflowFailure(
  cause: unknown,
  phase: SeqlaneFailurePhase,
  workflowId: string,
  options: MastraPlanCompilerOptions,
): SeqlaneError {
  const failure = toSeqlaneInvocationError(cause, phase, workflowId);
  options.onFailure?.(failure);
  return failure;
}

function schemaForWorkflowMastra(
  schema: SeqlaneSchema | undefined,
  phase: Extract<SeqlaneFailurePhase, "input" | "output">,
  workflowId: string,
  options: MastraPlanCompilerOptions,
): z.ZodType {
  if (schema === undefined) return schemaForMastra(undefined);

  const invalid = Symbol("invalid workflow schema value");
  return z.preprocess(
    (value) => {
      try {
        return schema.parse(value);
      } catch (cause) {
        reportWorkflowFailure(cause, phase, workflowId, options);
        return invalid;
      }
    },
    z.custom((value) => value !== invalid),
  );
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
      requestContext,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
    }) => {
      const workflowInput = getInitData<unknown>();
      const resolvedInput = resolveStepInput(
        node,
        workflowInput,
        getStepResult,
      );
      let parsedInput: unknown;
      try {
        parsedInput = inputSchema?.parse(resolvedInput) ?? resolvedInput;
      } catch (cause) {
        const error = reportFailure(node, cause, "input", options);
        options.onInputValidationFailure?.({
          node,
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          invocationId,
          error,
        });
        options.onWorkflowComplete?.({
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          status: "failed",
        });
        throw error;
      }
      if (options.executeInvocation === undefined) {
        throw new Error(
          `No Mastra invocation handler is configured for Plan node "${node.nodeId}"`,
        );
      }

      let rawOutput: unknown;
      try {
        rawOutput = await options.executeInvocation({
          node,
          input: parsedInput,
          workflowInput,
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          invocationId,
          ...(resourceId === undefined ? {} : { resourceId }),
          workflowId,
          abortSignal,
          requestContext,
          observability: { tracing, tracingContext, loggerVNext, metrics },
          getStepResult,
        });
      } catch (cause) {
        options.onWorkflowComplete?.({
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          status: abortSignal.aborted ? "cancelled" : "failed",
        });
        throw cause;
      }
      try {
        return outputSchema?.parse(rawOutput) ?? rawOutput;
      } catch (cause) {
        const error = reportFailure(node, cause, "output", options);
        options.onWorkflowComplete?.({
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          status: "failed",
        });
        throw error;
      }
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
  assertDefinitionRegistries(
    options.taskDefinitions,
    options.validatorDefinitions,
  );
  const parsedPlan = validatePlan(plan, options.taskDefinitions);
  assertMastraSupportedPlan(parsedPlan);
  assertValidationRegistries(parsedPlan, options);
  const orderedNodes = lowerWorkspaceOrdering(
    lowerReuseSessionOrdering(orderParsedPlanNodes(parsedPlan)),
    options.workspaceResources,
  );
  const loweredPlan = withLoweredPlanNodes(parsedPlan, orderedNodes);
  const invocationIds = new Map<PlanNodeId, InvocationId>();
  for (const node of orderedNodes) {
    invocationIds.set(
      node.nodeId,
      options.createInvocationId?.(node.nodeId) ??
        `${parsedPlan.workflow.id}:${node.nodeId}`,
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

  const workflowInputSchema = schemaForWorkflowMastra(
    options.workflowInputSchema ?? options.workflow?.input,
    "input",
    parsedPlan.workflow.id,
    options,
  );
  const workflowOutputSchema = schemaForWorkflowMastra(
    options.workflowOutputSchema ?? options.workflow?.output,
    "output",
    parsedPlan.workflow.id,
    options,
  );
  const resultStep = createStep({
    id: RESULT_STEP_ID,
    description: "Resolve the Seqlane workflow output binding",
    inputSchema: z.unknown(),
    outputSchema: workflowOutputSchema,
    metadata: {
      seqlane: {
        kind: "workflow-output",
        binding: parsedPlan.output,
        dependsOn: [...orderedNodes.map(({ nodeId }) => nodeId)],
      },
    },
    execute: async ({ getInitData, getStepResult, runId, resourceId }) => {
      try {
        const workflowInput = getInitData<unknown>();
        const results = new Map<string, unknown>();
        for (const node of orderedNodes) {
          results.set(node.nodeId, getStepResult(node.nodeId));
        }
        const output = resolveBinding(
          parsedPlan.output,
          workflowInput,
          results,
        );
        const parsedOutput =
          options.workflow?.output?.parse(output) ??
          options.workflowOutputSchema?.parse(output) ??
          output;
        options.onWorkflowComplete?.({
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          status: "success",
        });
        return parsedOutput;
      } catch (cause) {
        const error =
          cause instanceof SeqlaneError
            ? cause
            : reportWorkflowFailure(
                cause,
                "output",
                parsedPlan.workflow.id,
                options,
              );
        options.onWorkflowComplete?.({
          workId: resourceId ?? options.workId ?? "unknown-work",
          runId,
          status: "failed",
        });
        throw error;
      }
    },
  });

  let workflow: AnyWorkflow = createWorkflow({
    id: parsedPlan.workflow.id,
    description: `Runs Seqlane workflow ${parsedPlan.workflow.id}.`,
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
    key: parsedPlan.workflow.id,
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
