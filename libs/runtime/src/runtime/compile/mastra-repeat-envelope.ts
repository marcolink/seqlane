import { z } from "zod";
import type { PlanNode } from "@seqlane/core";
import {
  referencedNodeIds,
  WORKFLOW_INPUT_NODE_ID,
} from "../plan/binding-resolution.js";
import type {
  MastraPlanRunContext,
  MastraPlanRunIdentity,
} from "./mastra-run-context.js";
import type { RepeatCompilerDependencies } from "./mastra-repeat-compiler.js";

export const repeatEnvelopeSchema = z.strictObject({
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
  runContext: z.strictObject({
    workId: z.string(),
    runId: z.string(),
    resourceId: z.string().optional(),
  }),
  repeatExecutions: z.number().int().nonnegative(),
});

export type RepeatEnvelope = z.infer<typeof repeatEnvelopeSchema>;

export function repeatInputStepId(
  node: Extract<PlanNode, { type: "repeat" }>,
): string {
  return `${node.nodeId}:input`;
}

export function repeatEnvelopeFromInput(
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

export function repeatScopedResults(
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

export function buildInitialRepeatEnvelope(
  node: Extract<PlanNode, { type: "repeat" }>,
  workflowInput: unknown,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
  dependencies: RepeatCompilerDependencies,
  runContext: MastraPlanRunContext,
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
    runContext: {
      workId: runContext.workId,
      runId: runContext.runId,
      ...(runContext.resourceId === undefined
        ? {}
        : { resourceId: runContext.resourceId }),
    } satisfies MastraPlanRunIdentity,
    repeatExecutions: runContext.repeatBudget.executed,
  };
}
