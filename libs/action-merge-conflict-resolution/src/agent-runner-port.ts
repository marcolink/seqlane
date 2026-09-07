import { z } from "zod";

import {
  conflictResolutionOutputSchema,
  type ResolveMergeConflictsWorkflowOutput,
} from "@seqlane/runtime/workflows/resolve-merge-conflicts";

import {
  agentResolutionRequestSchema,
  type AgentResolutionRequest,
} from "./contracts.js";

export const seqlaneAgentExecutionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("succeeded"),
      output: z.unknown().optional(),
    }),
    z.strictObject({
      status: z.literal("failed"),
      message: z.string().min(1).max(512),
    }),
    z.strictObject({ status: z.literal("cancelled") }),
  ],
);
export type SeqlaneAgentExecutionResult = z.infer<
  typeof seqlaneAgentExecutionResultSchema
>;

export function validateSeqlaneAgentWorkflowOutput(
  value: unknown,
  requestedPaths: readonly string[],
): ResolveMergeConflictsWorkflowOutput {
  const parsed = conflictResolutionOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("The Seqlane workflow output is malformed.");
  }
  const requested = new Set(requestedPaths);
  const resolved = new Set(parsed.data.resolvedFiles);
  const decisions = new Set(parsed.data.decisions.map(({ file }) => file));
  if (
    requested.size !== requestedPaths.length ||
    resolved.size !== parsed.data.resolvedFiles.length ||
    decisions.size !== parsed.data.decisions.length ||
    requested.size !== resolved.size ||
    requested.size !== decisions.size ||
    [...requested].some((path) => !resolved.has(path) || !decisions.has(path))
  ) {
    throw new TypeError("The Seqlane workflow output is malformed.");
  }
  return parsed.data;
}

export interface SeqlaneAgentExecutionRequest extends AgentResolutionRequest {
  readonly workspace: string;
}

export interface SeqlaneAgentExecutionPort {
  readonly execute: (request: SeqlaneAgentExecutionRequest) => Promise<unknown>;
}

export function validateAgentResolutionRequest(
  request: AgentResolutionRequest,
): AgentResolutionRequest {
  const parsed = agentResolutionRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new TypeError("The agent resolution request is malformed.");
  }
  return parsed.data;
}
