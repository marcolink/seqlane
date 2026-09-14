import { createStep, createWorkflow } from "@mastra/core/workflows";
import type { AnyWorkflow, Step } from "@mastra/core/workflows";
import {
  LoopLimitExceededError,
  MAX_REPEAT_BODY_EXECUTIONS,
  RunRepeatLimitExceededError,
} from "@seqlane/core";
import type {
  InvocationId,
  PlanNode,
  SeqlaneSchema,
  TaskNode,
  WorkflowNode,
} from "@seqlane/core";
import { z } from "zod";
import {
  resolveBinding,
  referencedNodeIds,
  WORKFLOW_INPUT_NODE_ID,
} from "../plan/binding-resolution.js";
import { summarizeSeqlaneOutput } from "../execution/output-summary.js";
import {
  invocationKind as planInvocationKind,
  invocationSubject as planInvocationSubject,
  invocationTaskId as planInvocationTaskId,
} from "../execution/workflow-run.js";
import { taskIdCompatibility } from "../invocation/invocation-support.js";
import type { SeqlaneFailurePhase } from "../execution/errors.js";
import type { MastraPlanCompilerOptions } from "./mastra-plan-compiler.js";

export interface RepeatExecutionBudget {
  executed: number;
}

const repeatEnvelopeSchema = z.strictObject({
  __seqlaneRepeatEnvelope: z.literal(true),
  initialInput: z.unknown(),
  currentInput: z.unknown(),
  workflowInput: z.unknown(),
  dependencyResults: z.custom<ReadonlyMap<string, unknown>>(
    (value) => value instanceof Map,
  ),
  attemptNumber: z.number().int().positive(),
  result: z.unknown().optional(),
  until: z.boolean().optional(),
});

type RepeatEnvelope = z.infer<typeof repeatEnvelopeSchema>;

function repeatInputStepId(
  node: Extract<PlanNode, { type: "repeat" }>,
): string {
  return `${node.nodeId}:input`;
}

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
  ) => Error;
  readonly invocationIdForNode: (nodeId: string) => InvocationId | undefined;
}

function repeatScopedResults(
  node: Extract<PlanNode, { type: "repeat" }>,
  input: unknown,
  result: unknown,
  dependencyResults: ReadonlyMap<string, unknown>,
): Map<string, unknown> {
  return new Map([
    ...dependencyResults,
    [`${node.nodeId}:input`, input],
    [node.attempt.nodeId, { output: result }],
  ]);
}

function repeatEnvelopeFromInput(
  input: unknown,
  inputStepId: string,
): RepeatEnvelope {
  const direct = repeatEnvelopeSchema.safeParse(input);
  if (direct.success) return direct.data;
  const wrapped = z.record(z.string(), z.unknown()).safeParse(input);
  if (wrapped.success) {
    const candidate = repeatEnvelopeSchema.safeParse(wrapped.data[inputStepId]);
    if (candidate.success) return candidate.data;
  }
  throw new Error(
    `Repeat input step "${inputStepId}" did not produce an envelope`,
  );
}

function buildInitialRepeatEnvelope(
  node: Extract<PlanNode, { type: "repeat" }>,
  workflowInput: unknown,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
  dependencies: RepeatCompilerDependencies,
): RepeatEnvelope {
  const initialInput = dependencies.resolveStepInput(
    node,
    workflowInput,
    getStepResult,
  );
  const dependencyResults = new Map<string, unknown>();
  for (const dependency of new Set([
    ...referencedNodeIds(node.input),
    ...referencedNodeIds(node.until),
    ...(node.nextInput === undefined ? [] : referencedNodeIds(node.nextInput)),
    ...node.attempt.dependsOn,
  ])) {
    if (
      dependency !== WORKFLOW_INPUT_NODE_ID &&
      dependency !== `${node.nodeId}:input` &&
      dependency !== node.attempt.nodeId
    ) {
      dependencyResults.set(dependency, getStepResult(dependency));
    }
  }
  return {
    __seqlaneRepeatEnvelope: true,
    initialInput,
    currentInput: initialInput,
    workflowInput,
    dependencyResults,
    attemptNumber: 1,
  };
}

function buildRepeatAttemptStep(
  node: Extract<PlanNode, { type: "repeat" }>,
  options: MastraPlanCompilerOptions,
  invocationId: InvocationId,
  dependencies: RepeatCompilerDependencies,
): Step {
  const inputStepId = repeatInputStepId(node);
  const attemptStepId = `${node.nodeId}:attempt:mastra`;
  const baseInvocationId = invocationId;
  const inputSchema = dependencies.schemaForNodeInput(node.attempt, options);
  const outputSchema = dependencies.schemaForNodeOutput(node.attempt, options);
  const budget = options.repeatBudget ?? { executed: 0 };
  return createStep({
    id: attemptStepId,
    description: `Execute Seqlane repeat attempt ${node.nodeId}`,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    execute: async ({
      inputData,
      abortSignal,
      tracing,
      tracingContext,
      loggerVNext,
      metrics,
      requestContext,
    }) => {
      const envelope = repeatEnvelopeFromInput(inputData, inputStepId);
      const iteration = envelope.attemptNumber;
      budget.executed += 1;
      if (budget.executed > MAX_REPEAT_BODY_EXECUTIONS) {
        const error = new RunRepeatLimitExceededError(
          MAX_REPEAT_BODY_EXECUTIONS,
          budget.executed,
        );
        options.onFailure?.(error);
        throw error;
      }
      const attemptInvocationId = `${baseInvocationId}:attempt:${iteration}`;
      const attemptNode: TaskNode | WorkflowNode = {
        ...node.attempt,
        input: {
          type: "ref",
          nodeId: `${node.nodeId}:attempt-input`,
          path: [],
        },
        dependsOn: [...node.attempt.dependsOn],
      };
      const getAttemptStepResult = <Output = unknown>(
        nodeId: string,
      ): Output => {
        if (nodeId === `${node.nodeId}:attempt-input`) {
          return envelope.currentInput as Output;
        }
        return envelope.dependencyResults.get(nodeId) as Output;
      };
      const invoke =
        attemptNode.type === "workflow"
          ? options.executeWorkflowInvocation
          : options.executeInvocation;
      if (invoke === undefined) {
        throw new Error(
          `No Mastra invocation handler is configured for repeat "${node.nodeId}"`,
        );
      }
      const subject = planInvocationSubject(attemptNode);
      const dependencyIds = node.attempt.dependsOn.flatMap((dependency) => {
        const dependencyId = dependencies.invocationIdForNode(dependency);
        return dependencyId === undefined ? [] : [dependencyId];
      });
      if (iteration > 1)
        dependencyIds.push(`${baseInvocationId}:attempt:${iteration - 1}`);
      options.events?.emit({
        type: "invocation.created",
        workId: options.workId ?? "unknown-work",
        runId: options.runId ?? "unknown-run",
        invocationId: attemptInvocationId,
        planNodeId: attemptNode.nodeId,
        subject,
        ...taskIdCompatibility(subject),
        kind: planInvocationKind(attemptNode),
        label: planInvocationTaskId(attemptNode),
        parentInvocationId: baseInvocationId,
        siblingOrder: iteration - 1,
        dependencyIds,
        iteration,
      });
      const result = await invoke({
        node: attemptNode,
        input: envelope.currentInput,
        workflowInput: envelope.workflowInput,
        workId: options.workId ?? "unknown-work",
        runId: options.runId ?? "unknown-run",
        invocationId: attemptInvocationId,
        workflowId: options.workflowId ?? node.nodeId,
        abortSignal,
        requestContext,
        observability: { tracing, tracingContext, loggerVNext, metrics },
        getStepResult: getAttemptStepResult,
      });
      const scoped = repeatScopedResults(
        node,
        envelope.currentInput,
        result,
        envelope.dependencyResults,
      );
      const until = resolveBinding(node.until, envelope.workflowInput, scoped);
      if (typeof until !== "boolean") {
        throw new Error(
          `Repeat "${node.nodeId}" condition did not resolve to a boolean`,
        );
      }
      let nextInput = envelope.initialInput;
      if (!until && node.nextInput !== undefined) {
        nextInput = resolveBinding(
          node.nextInput,
          envelope.workflowInput,
          scoped,
        );
        if (inputSchema !== undefined) {
          try {
            inputSchema.parse(nextInput);
          } catch (cause) {
            throw dependencies.reportFailure(
              node.attempt,
              cause,
              "input",
              options,
            );
          }
        }
      }
      if (outputSchema !== undefined) {
        try {
          outputSchema.parse(result);
        } catch (cause) {
          throw dependencies.reportFailure(
            node.attempt,
            cause,
            "output",
            options,
          );
        }
      }
      return {
        __seqlaneRepeatEnvelope: true,
        initialInput: envelope.initialInput,
        currentInput: nextInput,
        workflowInput: envelope.workflowInput,
        dependencyResults: envelope.dependencyResults,
        attemptNumber: iteration + 1,
        result,
        until,
      };
    },
  });
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
        { ...summarizeSeqlaneOutput(envelope.result) },
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
    execute: async ({ inputData }) => {
      const envelope = repeatEnvelopeSchema.safeParse(inputData);
      if (!envelope.success) {
        throw new Error(`Repeat "${node.nodeId}" produced an invalid envelope`);
      }
      return envelope.data.result;
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
  const outputSchema = dependencies.schemaForNodeOutput(node.attempt, options);
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
  }) as AnyWorkflow;
  const boundedCondition = buildRepeatCondition(node, options, attemptStepId);
  const extract = buildRepeatResultStep(node, outputSchema, dependencies);
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
      const workflowInput = getInitData<unknown>();
      const envelope = buildInitialRepeatEnvelope(
        node,
        workflowInput,
        getStepResult,
        dependencies,
      );
      const run = await loop.createRun({
        runId: `${runId}:${node.nodeId}`,
        resourceId,
      });
      const cancel = (): void => {
        void run.cancel().catch(() => undefined);
      };
      if (abortSignal.aborted) cancel();
      else abortSignal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await run.start({
          inputData: envelope,
          requestContext,
          ...(tracing === undefined ? {} : { tracing }),
          ...(tracingContext === undefined ? {} : { tracingContext }),
          ...(loggerVNext === undefined ? {} : { loggerVNext }),
          ...(metrics === undefined ? {} : { metrics }),
        });
        if (result.status !== "success") {
          if ("error" in result && result.error !== undefined) {
            throw result.error;
          }
          throw new Error(`Repeat "${node.nodeId}" failed`);
        }
        return result.result;
      } finally {
        abortSignal.removeEventListener("abort", cancel);
      }
    },
  });
}
