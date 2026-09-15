import { z } from "zod";
import type { Mastra } from "@mastra/core/mastra";
import { isJsonValue, type PlanNode } from "@seqlane/core";
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
export const MAX_REPEAT_WORKFLOW_STATE_BYTES = 256 * 1024;

function assertSerializedSize(
  value: unknown,
  maximumBytes: number,
  label: string,
): void {
  const serialized = JSON.stringify(value);
  const bytes =
    serialized === undefined
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  if (serialized === undefined || bytes > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
}

export function assertRepeatEnvelopeSize(
  envelope: RepeatEnvelope,
): RepeatEnvelope {
  assertSerializedSize(
    envelope,
    MAX_REPEAT_ENVELOPE_BYTES,
    "Repeat persistence envelope",
  );
  return envelope;
}

const repeatStateReferenceSchema = z.union([
  z.strictObject({
    kind: z.literal("mastra-snapshot"),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    path: z.tuple([z.literal("input")]),
  }),
  z.strictObject({
    kind: z.literal("mastra-snapshot"),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    path: z.tuple([z.literal("step"), z.string().min(1)]),
  }),
]);

const inlineRepeatStateValueSchema = z.strictObject({
  kind: z.literal("inline"),
  value: z.unknown(),
});
const repeatStateValueSchema = z.union([
  inlineRepeatStateValueSchema,
  repeatStateReferenceSchema,
]);

export type RepeatStateValue = z.infer<typeof repeatStateValueSchema>;
type InlineRepeatStateValue = z.infer<typeof inlineRepeatStateValueSchema>;

export function inlineRepeatStateValue(value: unknown): InlineRepeatStateValue {
  return { kind: "inline", value };
}

export function initialRepeatStateValue(): { readonly kind: "initial" } {
  return { kind: "initial" };
}

function repeatSnapshotReference(
  workflowId: string,
  runId: string,
  path: ["input"] | ["step", string],
): RepeatStateValue {
  return path[0] === "input"
    ? { kind: "mastra-snapshot", workflowId, runId, path: ["input"] }
    : {
        kind: "mastra-snapshot",
        workflowId,
        runId,
        path: ["step", path[1]],
      };
}

export function assertRepeatWorkflowStateSize(
  state: RepeatWorkflowState,
): RepeatWorkflowState {
  if (!isJsonValue(state)) {
    throw new Error("Repeat workflow state must be JSON-safe");
  }
  assertSerializedSize(
    state,
    MAX_REPEAT_WORKFLOW_STATE_BYTES,
    "Repeat workflow state",
  );
  return state;
}

/**
 * Values needed by every repeat iteration live in Mastra workflow state.
 * Keeping them out of the loop step output prevents the same dependency and
 * input payloads from being copied into every persisted envelope.
 */
export const repeatWorkflowStateSchema = z.strictObject({
  currentInput: z.union([
    z.strictObject({ kind: z.literal("initial") }),
    inlineRepeatStateValueSchema,
  ]),
  workflowInput: repeatStateValueSchema,
  dependencyResults: z.array(z.tuple([z.string(), repeatStateValueSchema])),
  result: inlineRepeatStateValueSchema.optional(),
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

function repeatDependencyResults(
  node: Extract<PlanNode, { type: "repeat" }>,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
  snapshot: { readonly workflowId: string; readonly runId: string } | undefined,
): Array<[string, RepeatStateValue]> {
  const results: Array<[string, RepeatStateValue]> = [];
  const references = new Set([
    ...referencedNodeIds(node.input),
    ...referencedNodeIds(node.until),
    ...(node.nextInput === undefined ? [] : referencedNodeIds(node.nextInput)),
    ...node.attempt.dependsOn,
  ]);
  for (const dependency of references) {
    if (
      dependency === WORKFLOW_INPUT_NODE_ID ||
      dependency === `${node.nodeId}:input` ||
      dependency === node.attempt.nodeId
    ) {
      continue;
    }
    const value =
      snapshot === undefined
        ? inlineRepeatStateValue(getStepResult(dependency))
        : repeatSnapshotReference(snapshot.workflowId, snapshot.runId, [
            "step",
            dependency,
          ]);
    results.push([dependency, value]);
  }
  return results;
}

export function buildInitialRepeatEnvelope(
  node: Extract<PlanNode, { type: "repeat" }>,
  workflowInput: unknown,
  getStepResult: <Output = unknown>(nodeId: string) => Output,
  dependencies: RepeatCompilerDependencies,
  options: {
    readonly runContext: MastraPlanRunContext;
    readonly workflowId: string;
    readonly mastra?: Mastra;
  },
): { envelope: RepeatEnvelope; state: RepeatWorkflowState } {
  const { runContext } = options;
  const snapshot =
    options.mastra?.getStorage() === undefined
      ? undefined
      : { workflowId: options.workflowId, runId: runContext.runId };
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
  const state: RepeatWorkflowState = {
    currentInput: initialRepeatStateValue(),
    workflowInput:
      snapshot === undefined
        ? inlineRepeatStateValue(workflowInput)
        : repeatSnapshotReference(snapshot.workflowId, snapshot.runId, [
            "input",
          ]),
    dependencyResults: repeatDependencyResults(node, getStepResult, snapshot),
  };
  return {
    envelope: assertRepeatEnvelopeSize(envelope),
    state: assertRepeatWorkflowStateSize(state),
  };
}
