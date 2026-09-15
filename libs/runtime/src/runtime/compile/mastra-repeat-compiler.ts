import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { AnyWorkflow, Step } from "@mastra/core/workflows";
import { LoopLimitExceededError } from "@seqlane/core";
import type {
  InvocationId,
  PlanNode,
  SeqlaneError,
  SeqlaneSchema,
} from "@seqlane/core";
import { z } from "zod";
import type { SeqlaneFailurePhase } from "../execution/errors.js";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";
import {
  buildInitialRepeatEnvelope,
  repeatEnvelopeSchema,
  repeatWorkflowStateSchema,
} from "./mastra-repeat-envelope.js";
import { buildRepeatAttemptStep } from "./mastra-repeat-attempt.js";
import { runRepeatWorkflow } from "./mastra-repeat-lifecycle.js";
import { resolveMastraPlanRunContext } from "./mastra-run-context.js";

export type {
  MastraPlanRunContext,
  RepeatExecutionBudget,
} from "./mastra-run-context.js";

export interface RepeatCompilerDependencies {
  readonly schemaForMastra: (schema: SeqlaneSchema | undefined) => z.ZodType;
  readonly schemaForNodeInput: (
    node: PlanNode,
    options: MastraPlanCompilerOptions,
  ) => SeqlaneSchema | undefined;
  readonly schemaForNodeOutput: (
    node: PlanNode,
    options: MastraPlanCompilerOptions,
  ) => SeqlaneSchema | undefined;
  readonly resolveStepInput: (
    node: PlanNode,
    workflowInput: unknown,
    getStepResult: <Output = unknown>(nodeId: string) => Output,
  ) => unknown;
  readonly reportFailure: (
    node: PlanNode,
    cause: unknown,
    phase: SeqlaneFailurePhase,
    options: MastraPlanCompilerOptions,
  ) => SeqlaneError;
  readonly invocationIdForNode: (nodeId: string) => InvocationId | undefined;
  readonly siblingOrderForNode?: (nodeId: string) => number | undefined;
}

type RepeatLoopCondition = (params: {
  getStepResult: <Output = unknown>(step: string) => Output;
  iterationCount: number;
}) => Promise<boolean>;

function buildRepeatCondition(
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  attemptStepId: string,
): RepeatLoopCondition {
  return async ({ getStepResult, iterationCount }) => {
    const envelopeResult = repeatEnvelopeSchema.safeParse(
      getStepResult(attemptStepId),
    );
    if (!envelopeResult.success) {
      throw new Error(`Repeat "${node.nodeId}" produced an invalid envelope`);
    }
    const envelope = envelopeResult.data;
    if (envelope.until === true) return true;
    if (iterationCount >= node.maximumIterations) {
      const error = new LoopLimitExceededError(
        node.nodeId,
        node.maximumIterations,
        undefined,
        { kind: "object" },
      );
      options.onFailure?.(error);
      throw error;
    }
    return false;
  };
}

function buildRepeatResultStep(
  node: Extract<PlanNode, { type: "repeat" }>,
  outputSchema: SeqlaneSchema | undefined,
  dependencies: RepeatCompilerDependencies,
): Step {
  return createStep({
    id: `${node.nodeId}:result`,
    description: `Resolve result for Seqlane repeat ${node.nodeId}`,
    inputSchema: z.unknown(),
    outputSchema: dependencies.schemaForMastra(outputSchema),
    execute: async ({ inputData, state }) => {
      const envelope = repeatEnvelopeSchema.safeParse(inputData);
      if (!envelope.success) {
        throw new Error(`Repeat "${node.nodeId}" produced an invalid envelope`);
      }
      const repeatState = repeatWorkflowStateSchema.safeParse(state);
      if (!repeatState.success) {
        throw new Error(`Repeat "${node.nodeId}" has invalid durable state`);
      }
      return repeatState.data.result;
    },
  });
}

function buildRepeatWorkflow(
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  invocationId: InvocationId,
  dependencies: RepeatCompilerDependencies,
): AnyWorkflow {
  const attemptStepId = `${node.nodeId}:attempt:mastra`;
  const attemptStep = buildRepeatAttemptStep(
    node,
    options,
    invocationId,
    dependencies,
  );
  const loop = createWorkflow({
    id: `${node.nodeId}:loop`,
    description: `Runs Seqlane repeat ${node.nodeId}.`,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    stateSchema: repeatWorkflowStateSchema,
  }) as AnyWorkflow;
  const boundedCondition = buildRepeatCondition(node, options, attemptStepId);
  const extract = buildRepeatResultStep(
    node,
    dependencies.schemaForNodeOutput(node.attempt, options),
    dependencies,
  );
  return loop
    .dountil(attemptStep, boundedCondition)
    .then(extract)
    .commit() as AnyWorkflow;
}

export function buildRepeatStep(
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  invocationId: InvocationId,
  dependencies: RepeatCompilerDependencies,
): Step {
  const loop = buildRepeatWorkflow(node, options, invocationId, dependencies);
  return createStep({
    id: node.nodeId,
    description: `Execute Seqlane repeat ${node.nodeId}`,
    inputSchema: z.unknown(),
    outputSchema: dependencies.schemaForMastra(
      dependencies.schemaForNodeOutput(node, options),
    ),
    execute: async ({
      getInitData,
      getStepResult,
      runId,
      resourceId,
      requestContext,
      abortSignal,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
    }) => {
      const runContext = resolveMastraPlanRunContext({
        runId,
        resourceId,
        requestContext,
        workId: options.workId,
        events: options.events,
        repeatBudget: options.repeatBudget,
      });
      const envelope = buildInitialRepeatEnvelope(
        node,
        getInitData<unknown>(),
        getStepResult,
        dependencies,
        runContext,
      );
      return runRepeatWorkflow({
        node,
        loop,
        envelope: envelope.envelope,
        initialState: envelope.state,
        runContext,
        compilerOptions: options,
        dependencies,
        invocationId,
        abortSignal,
        observability: { tracing, tracingContext, loggerVNext, metrics },
        emitCreated:
          options.workId === undefined && options.runId === undefined,
      });
    },
  });
}
