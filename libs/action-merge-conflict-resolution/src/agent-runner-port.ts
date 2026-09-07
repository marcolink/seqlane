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
): ResolveMergeConflictsWorkflowOutput {
  const parsed = conflictResolutionOutputSchema.safeParse(value);
  if (!parsed.success) {
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
