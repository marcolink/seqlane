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
  stateRef: z.strictObject({
    workflowId: z.string(),
    runId: z.string(),
  }),
  attemptNumber: z.number().int().positive(),
  until: z.boolean().optional(),
  runContext: z.strictObject({
    workId: z.string(),
    runId: z.string(),
    resourceId: z.string().optional(),
  }),
  repeatExecutions: z.number().int().nonnegative(),
});

export type RepeatEnvelope = z.infer<typeof repeatEnvelopeSchema>;

/** Control envelopes stay bounded because Mastra persists one per attempt. */
export const MAX_REPEAT_ENVELOPE_BYTES = 16 * 1024;

export function assertRepeatEnvelopeSize(
  envelope: RepeatEnvelope,
): RepeatEnvelope {
  const serialized = JSON.stringify(envelope);
  const bytes =
    serialized === undefined
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  if (serialized === undefined || bytes > MAX_REPEAT_ENVELOPE_BYTES) {
    throw new Error(
      `Repeat persistence envelope exceeds ${MAX_REPEAT_ENVELOPE_BYTES} bytes`,
    );
  }
  return envelope;
}

/**
 * Values needed by every repeat iteration live in Mastra workflow state.
 * Keeping them out of the loop step output prevents the same dependency and
 * input payloads from being copied into every persisted envelope.
 */
export const repeatWorkflowStateSchema = z.strictObject({
  initialInput: z.unknown(),
  currentInput: z.unknown(),
  workflowInput: z.unknown(),
  dependencyResults: z.array(z.tuple([z.string(), z.unknown()])),
  result: z.unknown().optional(),
});

export type RepeatWorkflowState = z.infer<typeof repeatWorkflowStateSchema>;

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
  if (direct.success) return assertRepeatEnvelopeSize(direct.data);
  const wrapped = z.record(z.string(), z.unknown()).safeParse(input);
  if (wrapped.success) {
    const candidate = repeatEnvelopeSchema.safeParse(wrapped.data[inputStepId]);
    if (candidate.success) return assertRepeatEnvelopeSize(candidate.data);
  }
  throw new Error(
    `Repeat input step "${inputStepId}" did not produce an envelope`,
  );
}

export function repeatScopedResults(
  node: Extract<PlanNode, { type: "repeat" }>,
  input: unknown,
  result: unknown,
  dependencyResults: ReadonlyArray<readonly [string, unknown]>,
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
): { envelope: RepeatEnvelope; state: RepeatWorkflowState } {
  const initialInput = dependencies.resolveStepInput(
    node,
    workflowInput,
    getStepResult,
  );
  const dependencyResults: Array<[string, unknown]> = [];
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
      dependencyResults.push([dependency, getStepResult(dependency)]);
    }
  }
  const envelope: RepeatEnvelope = {
    __seqlaneRepeatEnvelope: true,
    stateRef: {
      workflowId: `${node.nodeId}:loop`,
      runId: `${runContext.runId}:${node.nodeId}`,
    },
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
  return {
    envelope: assertRepeatEnvelopeSize(envelope),
    state: {
      initialInput,
      currentInput: initialInput,
      workflowInput,
      dependencyResults,
    },
  };
}
